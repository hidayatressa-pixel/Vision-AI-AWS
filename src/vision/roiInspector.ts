/**
 * Reference-based ROI inspector with explicit physical presence, contour,
 * spatial feature, relative size, and position checks.
 *
 * The matcher is intentionally fail-safe: insufficient evidence is WARNING,
 * never an automatic OK. It is a deterministic classical-CV recognizer, not
 * a trained detector and not a substitute for real-camera validation.
 */
import { AlignmentResult, ExtraDetectedObject, ROIInspectionResult } from '../types/inspection';
import { InspectionROI, ReferenceImage, ReferenceRoiLayout, ToleranceConfig } from '../types/master';
import { GrayscaleImage } from './imageUtils';
import { compareDescriptors, describePatch, RoiShapeDescriptor } from './roiFeatureCore.js';

const PATCH_SIZE = 64;
const referenceCache = new Map<string, Promise<Float32Array | null>>();

function normalizePatch(values: Float32Array): Float32Array {
  let mean = 0;
  for (const value of values) mean += value;
  mean /= Math.max(1, values.length);
  let variance = 0;
  for (const value of values) variance += (value - mean) ** 2;
  const std = Math.sqrt(variance / Math.max(1, values.length));
  const scale = Math.max(std, 8);
  return Float32Array.from(values, (value) => Math.max(-2.5, Math.min(2.5, (value - mean) / scale)) / 2.5);
}

function imageToPatch(image: HTMLImageElement, layout?: ReferenceRoiLayout): Float32Array | null {
  try {
    if (!image.naturalWidth || !image.naturalHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = PATCH_SIZE;
    canvas.height = PATCH_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    if (layout) {
      const left = layout.x * image.naturalWidth;
      const top = layout.y * image.naturalHeight;
      const width = layout.width * image.naturalWidth;
      const height = layout.height * image.naturalHeight;
      if (left < 0 || top < 0 || width < 2 || height < 2 ||
          left + width > image.naturalWidth || top + height > image.naturalHeight) return null;
      ctx.drawImage(image, left, top, width, height, 0, 0, PATCH_SIZE, PATCH_SIZE);
    } else {
      ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0, PATCH_SIZE, PATCH_SIZE);
    }
    const pixels = ctx.getImageData(0, 0, PATCH_SIZE, PATCH_SIZE).data;
    const gray = new Float32Array(PATCH_SIZE * PATCH_SIZE);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = pixels[i * 4] * 0.299 + pixels[i * 4 + 1] * 0.587 + pixels[i * 4 + 2] * 0.114;
    }
    return gray;
  } catch {
    return null;
  }
}

function fallbackLayout(roi: InspectionROI): ReferenceRoiLayout {
  const width = Math.max(0.02, Math.min(1, roi.width ?? roi.radius * 2));
  const height = Math.max(0.02, Math.min(1, roi.height ?? roi.radius * 2));
  return {
    x: Math.max(0, Math.min(1 - width, roi.x - width / 2)),
    y: Math.max(0, Math.min(1 - height, roi.y - height / 2)),
    width,
    height,
  };
}

function loadReference(reference: ReferenceImage, roi: InspectionROI): Promise<Float32Array | null> {
  const layout = reference.roiLayouts?.[roi.id] || fallbackLayout(roi);
  const cacheKey = [reference.id, reference.imageUrl, roi.id, layout.x, layout.y, layout.width, layout.height].join(':');
  const cached = referenceCache.get(cacheKey);
  if (cached) return cached;
  const promise = new Promise<Float32Array | null>((resolve) => {
    if (!reference.imageUrl) return resolve(null);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(imageToPatch(image, layout));
    image.onerror = () => resolve(null);
    image.src = reference.imageUrl;
  });
  referenceCache.set(cacheKey, promise);
  return promise;
}

interface RoiFrameGeometry {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationRad: number;
  cos: number;
  sin: number;
  bounds: { left: number; top: number; right: number; bottom: number };
}

function mapRoiToFrame(
  frame: GrayscaleImage,
  roi: InspectionROI,
  alignment: AlignmentResult,
  masterWidth: number,
  masterHeight: number
): RoiFrameGeometry | null {
  if (!alignment.success || frame.width < 2 || frame.height < 2 ||
      !Number.isFinite(masterWidth) || !Number.isFinite(masterHeight) ||
      masterWidth <= 0 || masterHeight <= 0 ||
      !Number.isFinite(alignment.scale) || alignment.scale <= 0 ||
      !Number.isFinite(alignment.rotationDeg) ||
      !Number.isFinite(alignment.translationX) || !Number.isFinite(alignment.translationY)) return null;

  const roiWidthNorm = roi.width ?? roi.radius * 2;
  const roiHeightNorm = roi.height ?? roi.radius * 2;
  if (![roi.x, roi.y, roiWidthNorm, roiHeightNorm].every(Number.isFinite) ||
      roiWidthNorm <= 0 || roiHeightNorm <= 0) return null;

  // The master is contained (not stretched) in the camera frame. The same
  // coordinate convention is used by AlignmentEngine.mapMasterPointToFrame.
  const containScale = Math.min(frame.width / masterWidth, frame.height / masterHeight);
  const renderedWidth = masterWidth * containScale;
  const renderedHeight = masterHeight * containScale;
  const offsetX = (frame.width - renderedWidth) / 2;
  const offsetY = (frame.height - renderedHeight) / 2;
  const sourceX = offsetX + roi.x * renderedWidth;
  const sourceY = offsetY + roi.y * renderedHeight;

  const rotationRad = alignment.rotationDeg * Math.PI / 180;
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);
  const centerX = alignment.scale * (cos * sourceX - sin * sourceY) + alignment.translationX;
  const centerY = alignment.scale * (sin * sourceX + cos * sourceY) + alignment.translationY;
  const width = roiWidthNorm * renderedWidth * alignment.scale;
  const height = roiHeightNorm * renderedHeight * alignment.scale;
  const halfW = width / 2;
  const halfH = height / 2;
  const corners = [
    [-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH],
  ].map(([x, y]) => ({
    x: centerX + cos * x - sin * y,
    y: centerY + sin * x + cos * y,
  }));
  const bounds = {
    left: Math.min(...corners.map((p) => p.x)),
    top: Math.min(...corners.map((p) => p.y)),
    right: Math.max(...corners.map((p) => p.x)),
    bottom: Math.max(...corners.map((p) => p.y)),
  };
  if (bounds.left < 0 || bounds.top < 0 || bounds.right >= frame.width ||
      bounds.bottom >= frame.height || width < 2 || height < 2) return null;
  return { centerX, centerY, width, height, rotationRad, cos, sin, bounds };
}

function sampleGray(frame: GrayscaleImage, colorFrame: ImageData | null, x: number, y: number): number {
  const sx = Math.max(0, Math.min(frame.width - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(frame.height - 1, Math.round(y)));
  if (colorFrame && colorFrame.width === frame.width && colorFrame.height === frame.height) {
    const i = (sy * colorFrame.width + sx) * 4;
    return colorFrame.data[i] * 0.299 + colorFrame.data[i + 1] * 0.587 + colorFrame.data[i + 2] * 0.114;
  }
  return frame.data[sy * frame.width + sx];
}

/**
 * Rectifies the rotated/scaled camera crop back into master ROI coordinates.
 * This avoids comparing a rotated camera crop against an unrotated reference.
 */
function currentRoiPatch(
  frame: GrayscaleImage,
  colorFrame: ImageData | null,
  geometry: RoiFrameGeometry
): Float32Array {
  const patch = new Float32Array(PATCH_SIZE * PATCH_SIZE);
  for (let py = 0; py < PATCH_SIZE; py++) {
    const localY = ((py + 0.5) / PATCH_SIZE - 0.5) * geometry.height;
    for (let px = 0; px < PATCH_SIZE; px++) {
      const localX = ((px + 0.5) / PATCH_SIZE - 0.5) * geometry.width;
      const frameX = geometry.centerX + geometry.cos * localX - geometry.sin * localY;
      const frameY = geometry.centerY + geometry.sin * localX + geometry.cos * localY;
      patch[py * PATCH_SIZE + px] = sampleGray(frame, colorFrame, frameX, frameY);
    }
  }
  return patch;
}

function comparePatches(
  reference: Float32Array,
  current: Float32Array,
  roi: InspectionROI
): { score: number; shapeScore: number; referenceShape: RoiShapeDescriptor; currentShape: RoiShapeDescriptor } {
  const referenceShape = describePatch(reference, PATCH_SIZE, roi.expectedPolarity || 'contrast');
  const currentShape = describePatch(current, PATCH_SIZE, roi.expectedPolarity || 'contrast');
  const refStructure = normalizePatch(reference);
  const curStructure = normalizePatch(current);
  let structureError = 0;
  let intensityError = 0;
  for (let i = 0; i < reference.length; i++) {
    structureError += Math.abs(refStructure[i] - curStructure[i]);
    intensityError += Math.abs(reference[i] - current[i]) / 255;
  }
  const count = Math.max(1, reference.length);
  const structureDifference = structureError / count / 2;
  const brightnessDifference = intensityError / count;
  const mode = roi.comparisonMode || 'BALANCED';
  const pixelDifference = mode === 'STRUCTURE_FIRST'
    ? structureDifference * 0.92 + brightnessDifference * 0.08
    : mode === 'INTENSITY_FIRST'
      ? structureDifference * 0.25 + brightnessDifference * 0.75
      : structureDifference * 0.75 + brightnessDifference * 0.25;
  const pixelSimilarity = Math.max(0, Math.min(1, 1 - pixelDifference));
  const shapeScore = compareDescriptors(referenceShape, currentShape);
  // Spatial shape features receive greater weight than raw pixel brightness.
  const score = Math.max(0, Math.min(1, pixelSimilarity * 0.35 + shapeScore * 0.65));
  return { score, shapeScore, referenceShape, currentShape };
}

function uncertainResult(
  roi: InspectionROI,
  geometry: RoiFrameGeometry | null,
  reason: string
): ROIInspectionResult {
  return {
    roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
    masterPosition: { x: roi.x, y: roi.y },
    expectedTransformedPosition: geometry
      ? { x: geometry.centerX, y: geometry.centerY }
      : { x: roi.x, y: roi.y },
    actualDetectedPosition: null,
    positionOffsetPx: null,
    positionOffsetMm: null,
    isWithinTolerance: false,
    confidence: 0,
    isPresent: false,
    evidence: 'UNCERTAIN',
    status: 'WARNING',
    failureReason: reason,
  };
}

export class ROIInspector {
  public async inspectROIs(
    frame: GrayscaleImage,
    rois: InspectionROI[],
    alignment: AlignmentResult,
    tolerance: ToleranceConfig,
    masterWidth: number,
    masterHeight: number,
    referenceImages: ReferenceImage[] = [],
    colorFrame: ImageData | null = null
  ): Promise<{ roiResults: ROIInspectionResult[]; extraObjects: ExtraDetectedObject[]; matchedRoiCount: number }> {
    const usableReferences = referenceImages.filter((reference) => Boolean(reference.imageUrl?.trim()));
    const okReferences = usableReferences.filter((reference) => (reference.kind || 'OK') === 'OK');
    const ngReferences = usableReferences.filter((reference) => reference.kind === 'NG');
    const results: ROIInspectionResult[] = [];
    let matchedRoiCount = 0;

    for (const roi of rois) {
      const geometry = mapRoiToFrame(frame, roi, alignment, masterWidth, masterHeight);
      if (!geometry) {
        results.push(uncertainResult(roi, null, !alignment.success
          ? (alignment.errorMessage || 'Alignment was not verified')
          : `${roi.name}: transformed ROI is outside the camera frame or has invalid geometry`));
        continue;
      }
      if (okReferences.length === 0 || ngReferences.length === 0) {
        results.push(uncertainResult(roi, geometry, 'Both OK and NG reference images are required for classification'));
        continue;
      }

      const current = currentRoiPatch(frame, colorFrame, geometry);
      const currentShape = describePatch(current, PATCH_SIZE, roi.expectedPolarity || 'contrast');
      const expectedPresence = roi.expectedObjectPresence !== false;
      const hasPresenceEvidence = currentShape.presenceConfidence >= 0.5;

      const expectedFramePosition = { x: geometry.centerX / frame.width, y: geometry.centerY / frame.height };
      const detectedLocalX = currentShape.centroidX - 0.5;
      const detectedLocalY = currentShape.centroidY - 0.5;
      const detectedFrameX = geometry.centerX + geometry.cos * detectedLocalX * geometry.width - geometry.sin * detectedLocalY * geometry.height;
      const detectedFrameY = geometry.centerY + geometry.sin * detectedLocalX * geometry.width + geometry.cos * detectedLocalY * geometry.height;
      const actualDetectedPosition = currentShape.present
        ? { x: detectedFrameX / frame.width, y: detectedFrameY / frame.height }
        : null;

      if (!hasPresenceEvidence) {
        results.push({
          roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
          masterPosition: { x: roi.x, y: roi.y },
          expectedTransformedPosition: expectedFramePosition,
          actualDetectedPosition,
          positionOffsetPx: null, positionOffsetMm: null,
          isWithinTolerance: false, confidence: currentShape.presenceConfidence,
          isPresent: currentShape.present, evidence: 'UNCERTAIN', status: 'WARNING',
          failureReason: `${roi.name}: foreground evidence is too weak to confirm object presence or absence`,
        });
        continue;
      }

      if (expectedPresence && !currentShape.present) {
        results.push({
          roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
          masterPosition: { x: roi.x, y: roi.y },
          expectedTransformedPosition: expectedFramePosition,
          actualDetectedPosition: null,
          positionOffsetPx: null, positionOffsetMm: null,
          isWithinTolerance: false, confidence: currentShape.presenceConfidence,
          isPresent: false, evidence: 'ABSENT', status: 'FAIL',
          failureReason: `${roi.name}: expected ${roi.objectType} is missing from its configured ROI`,
        });
        continue;
      }

      if (!expectedPresence && currentShape.present) {
        results.push({
          roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
          masterPosition: { x: roi.x, y: roi.y },
          expectedTransformedPosition: expectedFramePosition,
          actualDetectedPosition,
          positionOffsetPx: null, positionOffsetMm: null,
          isWithinTolerance: false, confidence: currentShape.presenceConfidence,
          isPresent: true, evidence: 'PRESENT', status: 'FAIL',
          failureReason: `${roi.name}: unexpected ${roi.objectType} detected in an ROI configured to be empty`,
        });
        continue;
      }

      if (!expectedPresence && !currentShape.present) {
        matchedRoiCount++;
        results.push({
          roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
          masterPosition: { x: roi.x, y: roi.y },
          expectedTransformedPosition: expectedFramePosition,
          actualDetectedPosition: null,
          positionOffsetPx: null, positionOffsetMm: null,
          isWithinTolerance: true, confidence: currentShape.presenceConfidence,
          isPresent: false, evidence: 'ABSENT', status: 'PASS',
        });
        continue;
      }

      const comparisons = await Promise.all(usableReferences.map(async (reference) => {
        const patch = await loadReference(reference, roi);
        if (!patch) return null;
        const compared = comparePatches(patch, current, roi);
        return { reference, ...compared };
      }));
      const valid = comparisons.filter((item): item is NonNullable<typeof item> => item !== null);
      const okMatches = valid.filter((item) => (item.reference.kind || 'OK') === 'OK');
      const ngMatches = valid.filter((item) => item.reference.kind === 'NG');
      if (okMatches.length === 0 || ngMatches.length === 0) {
        results.push(uncertainResult(roi, geometry, `${roi.name}: one or more OK/NG reference crops could not be decoded`));
        continue;
      }

      const bestOk = okMatches.reduce((best, item) => item.score > best.score ? item : best);
      const bestNg = ngMatches.reduce((best, item) => item.score > best.score ? item : best);
      const threshold = Math.max(0.5, Math.min(0.98, roi.minConfidence || 0.75));
      const classMargin = Math.max(0.02, Math.min(0.3, roi.minClassMargin ?? 0.06));
      const margin = bestOk.score - bestNg.score;
      const okConfirmed = bestOk.score >= threshold && margin >= classMargin;
      const ngConfirmed = bestNg.score >= threshold && margin <= -classMargin;
      const bestSimilarity = Math.max(bestOk.score, bestNg.score);

      // Position is measured against the best OK object centroid in rectified ROI space.
      const referenceCentroid = bestOk.referenceShape;
      const normalizedPositionOffset = Math.hypot(
        currentShape.centroidX - referenceCentroid.centroidX,
        currentShape.centroidY - referenceCentroid.centroidY
      );
      const positionTolerance = Math.max(0.005, Math.min(0.5, roi.toleranceRadius || 0.05));
      const positionOffsetPx = Math.hypot(
        (currentShape.centroidX - referenceCentroid.centroidX) * geometry.width,
        (currentShape.centroidY - referenceCentroid.centroidY) * geometry.height
      );
      const sizeTolerance = Math.max(0.05, Math.min(1, roi.sizeToleranceRatio ?? 0.35));
      const relativeSizeChange = Math.abs(currentShape.areaRatio - referenceCentroid.areaRatio) /
        Math.max(referenceCentroid.areaRatio, 0.001);
      const positionOk = normalizedPositionOffset <= positionTolerance;
      const sizeOk = relativeSizeChange <= sizeTolerance;

      let status: ROIInspectionResult['status'] = 'WARNING';
      let reason: string | undefined;
      if (!positionOk) {
        status = 'FAIL';
        reason = `${roi.name}: object position shifted ${(normalizedPositionOffset * 100).toFixed(1)}% of ROI (limit ${(positionTolerance * 100).toFixed(1)}%)`;
      } else if (!sizeOk) {
        status = 'FAIL';
        reason = `${roi.name}: object foreground size changed ${(relativeSizeChange * 100).toFixed(1)}% (limit ${(sizeTolerance * 100).toFixed(1)}%)`;
      } else if (ngConfirmed) {
        status = 'FAIL';
        reason = `${roi.name}: matched approved NG reference (${Math.round(bestNg.score * 100)}%; ${bestNg.reference.label})`;
      } else if (okConfirmed) {
        status = 'PASS';
      } else {
        reason = `${roi.name}: OK/NG references are not sufficiently separated (OK ${Math.round(bestOk.score * 100)}%, NG ${Math.round(bestNg.score * 100)}%, required margin ${Math.round(classMargin * 100)}%)`;
      }

      if (status === 'PASS') matchedRoiCount++;
      results.push({
        roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
        masterPosition: { x: roi.x, y: roi.y },
        expectedTransformedPosition: expectedFramePosition,
        actualDetectedPosition,
        positionOffsetPx,
        // Physical millimetres cannot be claimed without a calibrated pixel-to-mm scale.
        positionOffsetMm: null,
        isWithinTolerance: status === 'PASS',
        confidence: Math.round(bestSimilarity * 100) / 100,
        isPresent: true,
        evidence: 'PRESENT',
        status,
        failureReason: reason,
      });
    }

    // Alignment tolerances are checked by AlignmentEngine. Object position and
    // relative size tolerances are checked here in the rectified ROI coordinate space.
    void tolerance;
    return { roiResults: results, extraObjects: [], matchedRoiCount };
  }
}

export const roiInspector = new ROIInspector();
