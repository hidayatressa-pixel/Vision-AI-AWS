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
import { compareDescriptors, confirmsEightPointAbsence, confirmsMissingObject, contourWithinTolerance, describePatch, rectifyPatch } from './roiFeatureCore.js';
import type { RoiShapeDescriptor } from './roiFeatureCore.js';
import { getEightPointSlotIds, isEightPointPresenceCandidate } from './eightPointPresenceEngine';

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
  if (referenceCache.size >= 256) {
    const oldestKey = referenceCache.keys().next().value;
    if (oldestKey) referenceCache.delete(oldestKey);
  }
  referenceCache.set(cacheKey, promise);
  return promise;
}

type ColorSignature = { red: number; green: number; blue: number; saturation: number };
const referenceColorCache = new Map<string, Promise<ColorSignature | null>>();

function colorSignatureFromPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  stride: number,
  offset = 0
): ColorSignature | null {
  let red = 0, green = 0, blue = 0, count = 0;
  // The central region emphasizes the inspected component and reduces the
  // influence of the surrounding fixture/background.
  const left = Math.floor(width * 0.3), right = Math.ceil(width * 0.7);
  const top = Math.floor(height * 0.3), bottom = Math.ceil(height * 0.7);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const index = offset + (y * width + x) * stride;
      red += pixels[index];
      green += pixels[index + 1];
      blue += pixels[index + 2];
      count++;
    }
  }
  if (!count) return null;
  red /= count; green /= count; blue /= count;
  const total = red + green + blue;
  if (!Number.isFinite(total) || total < 12) return null;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  return {
    red: red / total,
    green: green / total,
    blue: blue / total,
    saturation: maximum > 0 ? (maximum - minimum) / maximum : 0,
  };
}

function imageToColorSignature(image: HTMLImageElement, layout: ReferenceRoiLayout): ColorSignature | null {
  try {
    if (!image.naturalWidth || !image.naturalHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    const left = layout.x * image.naturalWidth;
    const top = layout.y * image.naturalHeight;
    const width = layout.width * image.naturalWidth;
    const height = layout.height * image.naturalHeight;
    if (left < 0 || top < 0 || width < 2 || height < 2 ||
        left + width > image.naturalWidth || top + height > image.naturalHeight) return null;
    context.drawImage(image, left, top, width, height, 0, 0, 32, 32);
    return colorSignatureFromPixels(context.getImageData(0, 0, 32, 32).data, 32, 32, 4);
  } catch {
    return null;
  }
}

function loadReferenceColorSignature(reference: ReferenceImage, roi: InspectionROI): Promise<ColorSignature | null> {
  const layout = reference.roiLayouts?.[roi.id] || fallbackLayout(roi);
  const cacheKey = [reference.id, reference.imageUrl, roi.id, layout.x, layout.y, layout.width, layout.height].join(':');
  const cached = referenceColorCache.get(cacheKey);
  if (cached) return cached;
  const promise = new Promise<ColorSignature | null>((resolve) => {
    if (!reference.imageUrl) return resolve(null);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(imageToColorSignature(image, layout));
    image.onerror = () => resolve(null);
    image.src = reference.imageUrl;
  });
  if (referenceColorCache.size >= 256) {
    const oldestKey = referenceColorCache.keys().next().value;
    if (oldestKey) referenceColorCache.delete(oldestKey);
  }
  referenceColorCache.set(cacheKey, promise);
  return promise;
}

function currentColorSignature(frame: ImageData, geometry: RoiFrameGeometry): ColorSignature | null {
  const size = 32;
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const localY = ((y + 0.5) / size - 0.5) * geometry.height;
    for (let x = 0; x < size; x++) {
      const localX = ((x + 0.5) / size - 0.5) * geometry.width;
      const sourceX = Math.round(geometry.centerX + geometry.cos * localX - geometry.sin * localY);
      const sourceY = Math.round(geometry.centerY + geometry.sin * localX + geometry.cos * localY);
      if (sourceX < 0 || sourceY < 0 || sourceX >= frame.width || sourceY >= frame.height) return null;
      const sourceIndex = (sourceY * frame.width + sourceX) * 4;
      const targetIndex = (y * size + x) * 4;
      pixels[targetIndex] = frame.data[sourceIndex];
      pixels[targetIndex + 1] = frame.data[sourceIndex + 1];
      pixels[targetIndex + 2] = frame.data[sourceIndex + 2];
      pixels[targetIndex + 3] = 255;
    }
  }
  return colorSignatureFromPixels(pixels, size, size, 4);
}

function compareColorSignatures(reference: ColorSignature, current: ColorSignature): number {
  // Neutral metallic/greyscale objects carry little reliable hue information.
  // Do not invent a color mismatch when both samples are effectively neutral.
  if (reference.saturation < 0.08 && current.saturation < 0.08) return 1;
  const chromaDistance = Math.sqrt(
    (reference.red - current.red) ** 2 +
    (reference.green - current.green) ** 2 +
    (reference.blue - current.blue) ** 2
  );
  const saturationDistance = Math.abs(reference.saturation - current.saturation);
  return Math.max(0, Math.min(1, Math.exp(-chromaDistance * 5 - saturationDistance * 1.5)));
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

/**
 * Rectifies the live camera ROI back into master coordinates using the
 * inverse of the measured scale/rotation transform.
 */
function currentRoiPatch(frame: GrayscaleImage, geometry: RoiFrameGeometry): Float32Array | null {
  return rectifyPatch(
    frame.data, frame.width, frame.height,
    geometry.centerX, geometry.centerY,
    geometry.width, geometry.height,
    geometry.cos, geometry.sin,
    PATCH_SIZE
  );
}

function comparePatches(
  reference: Float32Array,
  current: Float32Array,
  roi: InspectionROI,
  colorScore = 1
): { score: number; shapeScore: number; colorScore: number; referenceShape: RoiShapeDescriptor; currentShape: RoiShapeDescriptor } {
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
  // Shape remains dominant; color is an independent recognition signal.
  // A color mismatch lowers similarity but cannot by itself prove absence.
  const score = Math.max(0, Math.min(1, pixelSimilarity * 0.30 + shapeScore * 0.55 + colorScore * 0.15));
  return { score, shapeScore, colorScore, referenceShape, currentShape };
}

function uncertainResult(
  roi: InspectionROI,
  geometry: RoiFrameGeometry | null,
  reason: string,
  frameWidth: number,
  frameHeight: number,
  shape?: RoiShapeDescriptor
): ROIInspectionResult {
  // A diagnostic fallback is not proof of presence or absence. Only the main
  // recognition path may emit PRESENT/ABSENT after matching approved references.
  const evidence = 'UNCERTAIN';
  let actualDetectedPosition: { x: number; y: number } | null = null;
  if (geometry && shape?.present) {
    const localX = (shape.centroidX - 0.5) * geometry.width;
    const localY = (shape.centroidY - 0.5) * geometry.height;
    actualDetectedPosition = {
      x: (geometry.centerX + geometry.cos * localX - geometry.sin * localY) / frameWidth,
      y: (geometry.centerY + geometry.sin * localX + geometry.cos * localY) / frameHeight,
    };
  }
  return {
    roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
    masterPosition: { x: roi.x, y: roi.y },
    expectedTransformedPosition: geometry
      ? { x: geometry.centerX / frameWidth, y: geometry.centerY / frameHeight }
      : { x: roi.x, y: roi.y },
    actualDetectedPosition,
    positionOffsetPx: null,
    positionOffsetMm: null,
    isWithinTolerance: false,
    confidence: shape?.presenceConfidence ?? 0,
    isPresent: shape?.present ?? false,
    evidence,
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
    const results: ROIInspectionResult[] = [];
    let matchedRoiCount = 0;
    const eightPointPresenceMode = isEightPointPresenceCandidate(rois);
    // Live recognition requires both grayscale structure and readable RGB
    // evidence. Without RGB, the system cannot claim that Master color checks ran.

    for (const roi of rois) {
      const geometry = mapRoiToFrame(frame, roi, alignment, masterWidth, masterHeight);
      if (!geometry) {
        results.push(uncertainResult(roi, null, !alignment.success
          ? (alignment.errorMessage || 'Alignment was not verified')
          : `${roi.name}: transformed ROI is outside the camera frame or has invalid geometry`, frame.width, frame.height));
        continue;
      }
      const current = currentRoiPatch(frame, geometry);
      if (!current) {
        results.push(uncertainResult(roi, geometry, `${roi.name}: rectified ROI samples fall outside the camera frame`, frame.width, frame.height));
        continue;
      }
      const currentShape = describePatch(current, PATCH_SIZE, roi.expectedPolarity || 'contrast');
      const liveColor = colorFrame ? currentColorSignature(colorFrame, geometry) : null;
      if (!liveColor) {
        results.push(uncertainResult(
          roi, geometry, `${roi.name}: live RGB color evidence is unavailable; Master recognition cannot be completed`,
          frame.width, frame.height, currentShape
        ));
        continue;
      }
      const expectedPresence = roi.expectedObjectPresence !== false;
      const presenceThreshold = currentShape.present && roi.objectType === 'screw'
        ? Math.max(0.5, Math.min(0.98, tolerance.minScrewConfidence))
        : 0.5;
      const hasPresenceEvidence = currentShape.presenceConfidence >= presenceThreshold;
      const expectedFramePosition = { x: geometry.centerX / frame.width, y: geometry.centerY / frame.height };
      const detectedLocalX = currentShape.centroidX - 0.5;
      const detectedLocalY = currentShape.centroidY - 0.5;
      const detectedFrameX = geometry.centerX + geometry.cos * detectedLocalX * geometry.width - geometry.sin * detectedLocalY * geometry.height;
      const detectedFrameY = geometry.centerY + geometry.sin * detectedLocalX * geometry.width + geometry.cos * detectedLocalY * geometry.height;
      const actualDetectedPosition = currentShape.present
        ? { x: detectedFrameX / frame.width, y: detectedFrameY / frame.height }
        : null;

      // Validate reference evidence before using live absence/presence to make a
      // product judgement. A broken Master OK crop must produce WARNING/INVALID,
      // not a false product NG or an accidental OK.
      const comparisons = await Promise.all(usableReferences.map(async (reference) => {
        const [patch, referenceColor] = await Promise.all([
          loadReference(reference, roi),
          loadReferenceColorSignature(reference, roi),
        ]);
        if (!patch || !referenceColor) return null;
        const colorScore = compareColorSignatures(referenceColor, liveColor);
        const compared = comparePatches(patch, current, roi, colorScore);
        return { reference, colorScore, ...compared };
      }));
      const valid = comparisons.filter((item): item is NonNullable<typeof item> => item !== null);
      const allOkMatches = valid.filter((item) => (item.reference.kind || 'OK') === 'OK');
      const ngMatches = valid.filter((item) => item.reference.kind === 'NG');
      if (allOkMatches.length === 0 || ngMatches.length === 0) {
        results.push(uncertainResult(roi, geometry, `${roi.name}: usable OK and NG reference crops could not both be decoded`, frame.width, frame.height, currentShape));
        continue;
      }
      // Positive Master references must represent the configured expected state.
      const okMatches = expectedPresence
        ? allOkMatches.filter((item) => item.referenceShape.present)
        : allOkMatches.filter((item) => !item.referenceShape.present);
      if (okMatches.length === 0) {
        results.push(uncertainResult(
          roi, geometry, `${roi.name}: Master OK reference does not show the configured expected object state`,
          frame.width, frame.height, currentShape
        ));
        continue;
      }

      const bestOk = okMatches.reduce((best, item) => item.score > best.score ? item : best);
      const bestNg = ngMatches.length > 0
        ? ngMatches.reduce((best, item) => item.score > best.score ? item : best)
        : null;
      const threshold = Math.max(0.5, Math.min(0.98, roi.minConfidence || 0.75));
      const classMargin = Math.max(0.02, Math.min(0.3, roi.minClassMargin ?? 0.06));

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
        // Do not call a low-contrast/blurred object "missing" from presence
        // segmentation alone. Require the live crop to match a labelled NG
        // reference whose ROI explicitly shows the object absent.
        const absentNgMatches = ngMatches.filter((item) => !item.referenceShape.present);
        const bestAbsentNg = absentNgMatches.length > 0
          ? absentNgMatches.reduce((best, item) => item.score > best.score ? item : best)
          : null;
        const missingConfirmed = Boolean(bestAbsentNg &&
          confirmsMissingObject(currentShape.present, bestOk.score, bestAbsentNg.score, threshold, classMargin) &&
          (!eightPointPresenceMode || confirmsEightPointAbsence(
            currentShape.present,
            currentShape.presenceConfidence,
            bestOk.referenceShape.present,
            bestOk.shapeScore,
            Math.max(0.65, Math.min(0.9, tolerance.minScrewConfidence || 0.75)),
            0.35
          ))
        );
        results.push({
          roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
          masterPosition: { x: roi.x, y: roi.y },
          expectedTransformedPosition: expectedFramePosition,
          actualDetectedPosition: null,
          positionOffsetPx: null, positionOffsetMm: null,
          isWithinTolerance: false,
          confidence: missingConfirmed && bestAbsentNg ? Math.round(bestAbsentNg.score * 100) / 100 : currentShape.presenceConfidence,
          isPresent: false,
          evidence: missingConfirmed ? 'ABSENT' : 'UNCERTAIN',
          status: missingConfirmed ? 'FAIL' : 'WARNING',
          failureReason: missingConfirmed
            ? eightPointPresenceMode
              ? `${roi.name}: screw absence confirmed by clear background evidence against the positive Master`
              : `${roi.name}: missing ${roi.objectType} confirmed by NG reference ${bestAbsentNg?.reference.label}`
            : eightPointPresenceMode
              ? `${roi.name}: absence evidence is not strong enough to confirm a missing screw`
              : `${roi.name}: object presence could not be confirmed and no matching missing-object NG reference proved absence`,
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
        // An empty-looking crop is not enough to pass. The surrounding target
        // area/background must match the approved empty-state Master, and the
        // labelled NG reference must prove what an unwanted object looks like.
        const negativeReferenceValid = Boolean(bestNg?.referenceShape.present);
        const ngConfirmed = negativeReferenceValid &&
          bestNg!.score >= threshold &&
          bestNg!.score - bestOk.score >= classMargin;
        const okConfirmed = negativeReferenceValid &&
          bestOk.score >= threshold &&
          bestOk.score - bestNg!.score >= classMargin;

        if (ngConfirmed) {
          results.push({
            roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
            masterPosition: { x: roi.x, y: roi.y },
            expectedTransformedPosition: expectedFramePosition,
            actualDetectedPosition: null,
            positionOffsetPx: null, positionOffsetMm: null,
            isWithinTolerance: false, confidence: Math.round(bestNg!.score * 100) / 100,
            isPresent: false, evidence: 'ABSENT', status: 'FAIL',
            failureReason: `${roi.name}: empty-area state matches the approved NG reference containing an unwanted object`,
          });
        } else if (okConfirmed) {
          matchedRoiCount++;
          results.push({
            roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
            masterPosition: { x: roi.x, y: roi.y },
            expectedTransformedPosition: expectedFramePosition,
            actualDetectedPosition: null,
            positionOffsetPx: null, positionOffsetMm: null,
            isWithinTolerance: true, confidence: Math.round(bestOk.score * 100) / 100,
            isPresent: false, evidence: 'ABSENT', status: 'PASS',
          });
        } else {
          results.push(uncertainResult(
            roi, geometry,
            `${roi.name}: no foreground was detected, but the empty-area background did not match the approved OK Master with sufficient separation from the NG reference`,
            frame.width, frame.height, currentShape
          ));
        }
        continue;
      }

      // In the eight-screw profile the requested judgement is physical presence,
      // not full OK/NG quality classification. A present patch must still match
      // the positive screw Master strongly enough to reject unrelated texture.
      if (eightPointPresenceMode) {
        const positiveMargin = bestOk.score - (bestNg?.score ?? 0);
        if (bestOk.score < threshold || positiveMargin < classMargin) {
          results.push(uncertainResult(
            roi, geometry, `${roi.name}: screw-like foreground was detected but did not match the positive screw Master`,
            frame.width, frame.height, currentShape
          ));
        } else {
          matchedRoiCount++;
          results.push({
            roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
            masterPosition: { x: roi.x, y: roi.y },
            expectedTransformedPosition: expectedFramePosition,
            actualDetectedPosition,
            positionOffsetPx: null, positionOffsetMm: null,
            isWithinTolerance: true, confidence: Math.round(bestOk.score * 100) / 100,
            isPresent: true, evidence: 'PRESENT', status: 'PASS',
          });
        }
        continue;
      }

      if (!bestNg) {
        results.push(uncertainResult(
          roi, geometry, `${roi.name}: no usable NG reference is available for generic ROI classification`,
          frame.width, frame.height, currentShape
        ));
        continue;
      }

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
      const shapeTolerance = Math.max(0.05, Math.min(0.4, roi.shapeToleranceRatio ?? 0.10));
      const shapeOk = contourWithinTolerance(currentShape, referenceCentroid, shapeTolerance);
      const relativeSizeChange = Math.abs(currentShape.areaRatio - referenceCentroid.areaRatio) /
        Math.max(referenceCentroid.areaRatio, 0.001);
      const globalPixelTolerance = Number.isFinite(tolerance.maxPositionOffsetPx)
        ? Math.max(0, tolerance.maxPositionOffsetPx)
        : 0;
      const positionOk = normalizedPositionOffset <= positionTolerance && positionOffsetPx <= globalPixelTolerance;
      const sizeOk = relativeSizeChange <= sizeTolerance;

      let status: ROIInspectionResult['status'] = 'WARNING';
      let reason: string | undefined;
      if (!positionOk) {
        status = 'FAIL';
        reason = `${roi.name}: object position shifted ${(normalizedPositionOffset * 100).toFixed(1)}% of ROI (limit ${(positionTolerance * 100).toFixed(1)}%)`;
      } else if (!sizeOk) {
        status = 'FAIL';
        reason = `${roi.name}: object foreground size changed ${(relativeSizeChange * 100).toFixed(1)}% (limit ${(sizeTolerance * 100).toFixed(1)}%)`;
      } else if (!shapeOk) {
        status = 'FAIL';
        reason = `${roi.name}: object contour/shape geometry differs from the OK Master beyond the configured tolerance (${(shapeTolerance * 100).toFixed(0)}%)`;
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

    // Preserve the Master ROI order as stable P1-P8 identifiers for the operator
    // overlay and inspection history. The slot order is configured once in Master.
    const slotIds = eightPointPresenceMode ? getEightPointSlotIds(rois) : null;
    const finalResults = slotIds
      ? results.map((result) => ({
          ...result,
          inspectionPointId: slotIds.get(result.roiId),
        }))
      : results;
    const finalMatchedRoiCount = finalResults.filter((result) =>
      result.evidence === 'PRESENT' && result.status === 'PASS' && result.isWithinTolerance
    ).length;

    // Alignment tolerances are checked by AlignmentEngine. Object position and
    // relative size tolerances are checked here in the rectified ROI coordinate space.
    return { roiResults: finalResults, extraObjects: [], matchedRoiCount: finalMatchedRoiCount };
  }
}

export const roiInspector = new ROIInspector();
