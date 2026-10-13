/**
 * Multi-reference rectangular ROI inspector.
 * Compares each live ROI against multiple approved OK and NG reference images.
 * Every reference image carries its own editable normalized ROI layout.
 * No screw/circle detection or PLC communication is used in this MVP path.
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
  const cacheKey = [
    reference.id, reference.imageUrl, roi.id,
    layout.x, layout.y, layout.width, layout.height,
  ].join(':');
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

function currentRoiPatch(frame: GrayscaleImage, colorFrame: ImageData | null, roi: InspectionROI): Float32Array | null {
  const width = Math.max(0.02, Math.min(1, roi.width ?? roi.radius * 2));
  const height = Math.max(0.02, Math.min(1, roi.height ?? roi.radius * 2));
  const left = Math.round((roi.x - width / 2) * frame.width);
  const top = Math.round((roi.y - height / 2) * frame.height);
  const cropWidth = Math.round(width * frame.width);
  const cropHeight = Math.round(height * frame.height);
  if (cropWidth < 2 || cropHeight < 2 || left < 0 || top < 0 ||
      left + cropWidth > frame.width || top + cropHeight > frame.height) return null;

  const gray = new Float32Array(PATCH_SIZE * PATCH_SIZE);
  for (let py = 0; py < PATCH_SIZE; py++) {
    const sourceY = top + Math.min(cropHeight - 1, Math.floor((py / PATCH_SIZE) * cropHeight));
    for (let px = 0; px < PATCH_SIZE; px++) {
      const sourceX = left + Math.min(cropWidth - 1, Math.floor((px / PATCH_SIZE) * cropWidth));
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

function comparePatches(reference: Float32Array, current: Float32Array): number {
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
  const combinedDifference = structureDifference * 0.75 + brightnessDifference * 0.25;
  return Math.max(0, Math.min(1, 1 - combinedDifference));
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
    void alignment;
    void tolerance;
    void masterWidth;
    void masterHeight;

    const usableReferences = referenceImages.filter((reference) => Boolean(reference.imageUrl));
    const okReferences = usableReferences.filter((reference) => (reference.kind || 'OK') === 'OK');
    const ngReferences = usableReferences.filter((reference) => reference.kind === 'NG');
    const results: ROIInspectionResult[] = [];
    let matchedRoiCount = 0;

    for (const roi of rois) {
      const current = currentRoiPatch(frame, colorFrame, roi);
      if (!current || okReferences.length === 0 || ngReferences.length === 0) {
        results.push({
          roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
          masterPosition: { x: roi.x, y: roi.y },
          expectedTransformedPosition: { x: roi.x, y: roi.y },
          actualDetectedPosition: null, positionOffsetPx: 0, positionOffsetMm: 0,
          isWithinTolerance: false, confidence: 0, isPresent: false,
          evidence: 'UNCERTAIN', status: 'WARNING',
          failureReason: !current
            ? `${roi.name}: live ROI crop is outside the camera frame`
            : 'Both OK and NG reference images are required for classification',
        });
        continue;
      }

      const comparisons = await Promise.all(usableReferences.map(async (reference) => {
        const patch = await loadReference(reference, roi);
        return patch ? {
          reference,
          similarity: comparePatches(patch, current),
        } : null;
      }));
      const validComparisons = comparisons.filter((item): item is NonNullable<typeof item> => item !== null);
      const okMatches = validComparisons.filter((item) => (item.reference.kind || 'OK') === 'OK');
      const ngMatches = validComparisons.filter((item) => item.reference.kind === 'NG');
      if (okMatches.length === 0 || ngMatches.length === 0) {
        results.push({
          roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
          masterPosition: { x: roi.x, y: roi.y },
          expectedTransformedPosition: { x: roi.x, y: roi.y },
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
      const passed = bestOk.similarity >= threshold && bestOk.similarity > bestNg.similarity;
      const bestSimilarity = Math.max(bestOk.similarity, bestNg.similarity);
      if (passed) matchedRoiCount++;

      results.push({
        roiId: roi.id, roiName: roi.name, objectType: roi.objectType,
        masterPosition: { x: roi.x, y: roi.y },
        expectedTransformedPosition: { x: roi.x, y: roi.y },
        actualDetectedPosition: { x: roi.x, y: roi.y },
        positionOffsetPx: 0, positionOffsetMm: 0,
        isWithinTolerance: passed,
        confidence: Math.round(bestSimilarity * 100) / 100,
        isPresent: true,
        evidence: 'PRESENT',
        status: passed ? 'PASS' : 'FAIL',
        failureReason: passed ? undefined :
          `${roi.name}: classified NG; best OK ${Math.round(bestOk.similarity * 100)}% (${bestOk.reference.label}) vs best NG ${Math.round(bestNg.similarity * 100)}% (${bestNg.reference.label})`,
      });
    }

    return { roiResults: results, extraObjects: [], matchedRoiCount };
  }
}

export const roiInspector = new ROIInspector();
