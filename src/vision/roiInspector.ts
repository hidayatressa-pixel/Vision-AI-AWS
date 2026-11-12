/**
 * Multi-reference rectangular ROI inspector.
 * Uses master-to-frame alignment, reference-specific crops, and fail-safe
 * classification. A patch that matches neither approved class is UNCERTAIN,
 * never an automatic NG or OK.
 */
import { AlignmentResult, ExtraDetectedObject, ROIInspectionResult } from '../types/inspection';
import { InspectionROI, ReferenceImage, ReferenceRoiLayout, ToleranceConfig } from '../types/master';
import { GrayscaleImage } from './imageUtils';

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
    const canvas = document.createElement('canvas');
    canvas.width = PATCH_SIZE;
    canvas.height = PATCH_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    if (layout) {
      const left = Math.max(0, Math.min(1, layout.x)) * image.naturalWidth;
      const top = Math.max(0, Math.min(1, layout.y)) * image.naturalHeight;
      const width = Math.max(0.02, Math.min(1, layout.width)) * image.naturalWidth;
      const height = Math.max(0.02, Math.min(1, layout.height)) * image.naturalHeight;
      if (left + width > image.naturalWidth || top + height > image.naturalHeight) return null;
      ctx.drawImage(image, left, top, width, height, 0, 0, PATCH_SIZE, PATCH_SIZE);
    } else {
      ctx.drawImage(image, 0, 0, PATCH_SIZE, PATCH_SIZE);
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
  left: number;
  top: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

function mapRoiToFrame(
  frame: GrayscaleImage,
  roi: InspectionROI,
  alignment: AlignmentResult,
  masterWidth: number,
  masterHeight: number
): RoiFrameGeometry | null {
  if (!alignment.success || masterWidth <= 0 || masterHeight <= 0 ||
      !Number.isFinite(alignment.scale) || alignment.scale <= 0) return null;

  // Match the contain/letterbox coordinate mapping used by AlignmentEngine.
  const containScale = Math.min(frame.width / masterWidth, frame.height / masterHeight);
  const renderedWidth = masterWidth * containScale;
  const renderedHeight = masterHeight * containScale;
  const offsetX = (frame.width - renderedWidth) / 2;
  const offsetY = (frame.height - renderedHeight) / 2;
  const sourceX = offsetX + roi.x * renderedWidth;
  const sourceY = offsetY + roi.y * renderedHeight;
  const radians = (alignment.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = alignment.scale * (cos * sourceX - sin * sourceY) + alignment.translationX;
  const centerY = alignment.scale * (sin * sourceX + cos * sourceY) + alignment.translationY;

  const roiWidth = Math.max(0.02, Math.min(1, roi.width ?? roi.radius * 2)) * renderedWidth * alignment.scale;
  const roiHeight = Math.max(0.02, Math.min(1, roi.height ?? roi.radius * 2)) * renderedHeight * alignment.scale;
  // Enclose the rotated rectangle in a frame-aligned crop.
  const width = Math.abs(cos) * roiWidth + Math.abs(sin) * roiHeight;
  const height = Math.abs(sin) * roiWidth + Math.abs(cos) * roiHeight;
  const left = Math.round(centerX - width / 2);
  const top = Math.round(centerY - height / 2);
  const cropWidth = Math.round(width);
  const cropHeight = Math.round(height);
  if (cropWidth < 2 || cropHeight < 2 || left < 0 || top < 0 ||
      left + cropWidth > frame.width || top + cropHeight > frame.height) return null;
  return { left, top, width: cropWidth, height: cropHeight, centerX, centerY };
}

function currentRoiPatch(
  frame: GrayscaleImage,
  colorFrame: ImageData | null,
  geometry: RoiFrameGeometry
): Float32Array {
  const gray = new Float32Array(PATCH_SIZE * PATCH_SIZE);
  for (let py = 0; py < PATCH_SIZE; py++) {
    const sourceY = geometry.top + Math.min(geometry.height - 1, Math.floor((py / PATCH_SIZE) * geometry.height));
    for (let px = 0; px < PATCH_SIZE; px++) {
      const sourceX = geometry.left + Math.min(geometry.width - 1, Math.floor((px / PATCH_SIZE) * geometry.width));
      const index = py * PATCH_SIZE + px;
      if (colorFrame && colorFrame.width === frame.width && colorFrame.height === frame.height) {
        const i = (sourceY * colorFrame.width + sourceX) * 4;
        gray[index] = colorFrame.data[i] * 0.299 + colorFrame.data[i + 1] * 0.587 + colorFrame.data[i + 2] * 0.114;
      } else {
        gray[index] = frame.data[sourceY * frame.width + sourceX] || 0;
      }
    }
  }
  return gray;
}

function compareEdgeShape(reference: Float32Array, current: Float32Array): number {
  let magnitudeError = 0;
  let orientationError = 0;
  let orientationWeight = 0;
  let count = 0;

  // Compare local gradient magnitude and direction. This gives the reference
  // matcher a shape/edge signal instead of relying only on gray-level pixels.
  for (let y = 1; y < PATCH_SIZE - 1; y++) {
    for (let x = 1; x < PATCH_SIZE - 1; x++) {
      const i = y * PATCH_SIZE + x;
      const rgx = reference[i + 1] - reference[i - 1];
      const rgy = reference[i + PATCH_SIZE] - reference[i - PATCH_SIZE];
      const cgx = current[i + 1] - current[i - 1];
      const cgy = current[i + PATCH_SIZE] - current[i - PATCH_SIZE];
      const rm = Math.hypot(rgx, rgy);
      const cm = Math.hypot(cgx, cgy);
      magnitudeError += Math.abs(rm - cm) / 1020;
      const weight = Math.min(rm, cm);
      if (weight > 12) {
        const cosine = (rgx * cgx + rgy * cgy) / (rm * cm + 1e-6);
        orientationError += (1 - Math.max(-1, Math.min(1, cosine))) * 0.5 * weight;
        orientationWeight += weight;
      }
      count++;
    }
  }

  const magnitudeSimilarity = 1 - Math.min(1, magnitudeError / Math.max(1, count));
  const orientationSimilarity = orientationWeight > 0
    ? 1 - Math.min(1, orientationError / orientationWeight)
    : magnitudeSimilarity;
  return Math.max(0, Math.min(1, magnitudeSimilarity * 0.45 + orientationSimilarity * 0.55));
}

function comparePatches(reference: Float32Array, current: Float32Array, mode: InspectionROI['comparisonMode'] = 'BALANCED'): number {
  const referenceStructure = normalizePatch(reference);
  const currentStructure = normalizePatch(current);
  let structuralError = 0;
  let intensityError = 0;
  for (let i = 0; i < reference.length; i++) {
    structuralError += Math.abs(referenceStructure[i] - currentStructure[i]);
    intensityError += Math.abs(reference[i] - current[i]) / 255;
  }
  const count = Math.max(1, reference.length);
  const structureDifference = structuralError / count / 2;
  const brightnessDifference = intensityError / count;
  const combinedDifference = mode === 'STRUCTURE_FIRST'
    ? structureDifference * 0.92 + brightnessDifference * 0.08
    : mode === 'INTENSITY_FIRST'
      ? structureDifference * 0.25 + brightnessDifference * 0.75
      : structureDifference * 0.75 + brightnessDifference * 0.25;
  const pixelSimilarity = Math.max(0, Math.min(1, 1 - combinedDifference));
  const shapeSimilarity = compareEdgeShape(reference, current);
  // Retain the existing comparison modes while adding an explicit edge-shape
  // component so a missing/silhouette-changed object is not judged by brightness alone.
  const shapeWeight = mode === 'INTENSITY_FIRST' ? 0.25 : 0.4;
  return Math.max(0, Math.min(1, pixelSimilarity * (1 - shapeWeight) + shapeSimilarity * shapeWeight));
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
    const usableReferences = referenceImages.filter((reference) => Boolean(reference.imageUrl));
    const okReferences = usableReferences.filter((reference) => (reference.kind || 'OK') === 'OK');
    const ngReferences = usableReferences.filter((reference) => reference.kind === 'NG');
    const results: ROIInspectionResult[] = [];
    let matchedRoiCount = 0;

    for (const roi of rois) {
      const geometry = mapRoiToFrame(frame, roi, alignment, masterWidth, masterHeight);
      const current = geometry ? currentRoiPatch(frame, colorFrame, geometry) : null;
      if (!geometry || !current || okReferences.length === 0 || ngReferences.length === 0) {
        results.push({
          roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
          masterPosition: { x: roi.x, y: roi.y },
          expectedTransformedPosition: geometry
            ? { x: geometry.centerX / frame.width, y: geometry.centerY / frame.height }
            : { x: roi.x, y: roi.y },
          actualDetectedPosition: null, positionOffsetPx: 0, positionOffsetMm: 0,
          isWithinTolerance: false, confidence: 0, isPresent: false,
          evidence: 'UNCERTAIN', status: 'WARNING',
          failureReason: !alignment.success
            ? (alignment.errorMessage || 'Alignment was not verified')
            : !geometry
              ? `${roi.name}: transformed ROI crop is outside the camera frame`
              : !current
                ? `${roi.name}: live ROI crop is unavailable`
                : 'Both OK and NG reference images are required for classification',
        });
        continue;
      }

      const comparisons = await Promise.all(usableReferences.map(async (reference) => {
        const patch = await loadReference(reference, roi);
        return patch ? {
          reference,
          similarity: comparePatches(patch, current, roi.comparisonMode),
        } : null;
      }));
      const validComparisons = comparisons.filter((item): item is NonNullable<typeof item> => item !== null);
      const okMatches = validComparisons.filter((item) => (item.reference.kind || 'OK') === 'OK');
      const ngMatches = validComparisons.filter((item) => item.reference.kind === 'NG');
      if (okMatches.length === 0 || ngMatches.length === 0) {
        results.push({
          roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
          masterPosition: { x: roi.x, y: roi.y },
          expectedTransformedPosition: { x: geometry.centerX / frame.width, y: geometry.centerY / frame.height },
          actualDetectedPosition: null, positionOffsetPx: 0, positionOffsetMm: 0,
          isWithinTolerance: false, confidence: 0, isPresent: false,
          evidence: 'UNCERTAIN', status: 'WARNING',
          failureReason: `${roi.name}: one or more OK/NG reference crops could not be read`,
        });
        continue;
      }

      const bestOk = okMatches.reduce((best, item) => item.similarity > best.similarity ? item : best);
      const bestNg = ngMatches.reduce((best, item) => item.similarity > best.similarity ? item : best);
      const threshold = Math.max(0.5, Math.min(0.98, roi.minConfidence || 0.75));
      const okConfirmed = bestOk.similarity >= threshold && bestOk.similarity > bestNg.similarity;
      const ngConfirmed = bestNg.similarity >= threshold && bestNg.similarity > bestOk.similarity;
      const bestSimilarity = Math.max(bestOk.similarity, bestNg.similarity);

      if (okConfirmed) matchedRoiCount++;
      const uncertain = !okConfirmed && !ngConfirmed;
      const status = okConfirmed ? 'PASS' : ngConfirmed ? 'FAIL' : 'WARNING';
      const reason = okConfirmed
        ? undefined
        : ngConfirmed
          ? `${roi.name}: matched approved NG reference (${Math.round(bestNg.similarity * 100)}%; ${bestNg.reference.label})`
          : `${roi.name}: neither OK nor NG reference met the ${Math.round(threshold * 100)}% confidence threshold (OK ${Math.round(bestOk.similarity * 100)}%, NG ${Math.round(bestNg.similarity * 100)}%); result requires review`;

      results.push({
        roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
        masterPosition: { x: roi.x, y: roi.y },
        expectedTransformedPosition: { x: geometry.centerX / frame.width, y: geometry.centerY / frame.height },
        // Patch similarity classifies the crop but does not localize an object center.
        // Do not fabricate a detected coordinate or zero positional offset.
        actualDetectedPosition: null, positionOffsetPx: 0, positionOffsetMm: 0,
        isWithinTolerance: okConfirmed,
        confidence: Math.round(bestSimilarity * 100) / 100,
        // This field means the ROI produced classifiable reference evidence.
        // It does not claim independent physical object localization.
        isPresent: !uncertain,
        evidence: uncertain ? 'UNCERTAIN' : 'PRESENT',
        status,
        failureReason: reason,
      });
    }

    // Tolerances are enforced by the alignment transform before ROI inspection.
    // The current ROI matcher does not independently localize object centers.
    void tolerance;
    return { roiResults: results, extraObjects: [], matchedRoiCount };
  }
}

export const roiInspector = new ROIInspector();
