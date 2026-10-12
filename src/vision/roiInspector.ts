/**
 * Simple rectangular ROI inspector.
 * Compares each configured camera crop against its approved OK reference image.
 * No screw/circle detection is used in this MVP path.
 */
import { AlignmentResult, ExtraDetectedObject, ROIInspectionResult } from '../types/inspection';
import { InspectionROI, ReferenceImage, ToleranceConfig } from '../types/master';
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

function imageToPatch(image: HTMLImageElement): Float32Array | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = PATCH_SIZE;
    canvas.height = PATCH_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, PATCH_SIZE, PATCH_SIZE);
    const pixels = ctx.getImageData(0, 0, PATCH_SIZE, PATCH_SIZE).data;
    const gray = new Float32Array(PATCH_SIZE * PATCH_SIZE);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = pixels[i * 4] * 0.299 + pixels[i * 4 + 1] * 0.587 + pixels[i * 4 + 2] * 0.114;
    }
    return normalizePatch(gray);
  } catch {
    return null;
  }
}

function loadReference(reference: ReferenceImage): Promise<Float32Array | null> {
  const cacheKey = reference.id + ':' + reference.imageUrl;
  const cached = referenceCache.get(cacheKey);
  if (cached) return cached;

  const promise = new Promise<Float32Array | null>((resolve) => {
    if (!reference.imageUrl) return resolve(null);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(imageToPatch(image));
    image.onerror = () => resolve(null);
    image.src = reference.imageUrl;
  });
  referenceCache.set(cacheKey, promise);
  return promise;
}

function currentRoiPatch(
  frame: GrayscaleImage,
  colorFrame: ImageData | null,
  roi: InspectionROI
): Float32Array | null {
  const width = Math.max(0.02, Math.min(1, roi.width ?? (roi.radius * 2)));
  const height = Math.max(0.02, Math.min(1, roi.height ?? (roi.radius * 2)));
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
  return normalizePatch(gray);
}

function comparePatches(reference: Float32Array, current: Float32Array): number {
  let error = 0;
  for (let i = 0; i < reference.length; i++) error += Math.abs(reference[i] - current[i]);
  return Math.max(0, Math.min(1, 1 - error / Math.max(1, reference.length) / 2));
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
  ): Promise<{
    roiResults: ROIInspectionResult[];
    extraObjects: ExtraDetectedObject[];
    detectedScrewCount: number;
  }> {
    // Simple ROI mode uses normalized camera coordinates directly. Alignment
    // and screw-count parameters remain in the signature for compatibility.
    void alignment;
    void tolerance;
    void masterWidth;
    void masterHeight;

    const referenceByRoi = new Map(referenceImages.map((reference) => [reference.roiId || reference.id, reference]));
    const results: ROIInspectionResult[] = [];
    let matchedCount = 0;

    for (const roi of rois) {
      const reference = referenceByRoi.get(roi.id);
      const current = currentRoiPatch(frame, colorFrame, roi);
      const referencePatch = reference ? await loadReference(reference) : null;
      const hasEvidence = Boolean(current && referencePatch);
      const similarity = hasEvidence ? comparePatches(referencePatch!, current!) : 0;
      const threshold = Math.max(0.5, Math.min(0.98, roi.minConfidence || 0.75));
      const passed = hasEvidence && similarity >= threshold;
      if (passed) matchedCount++;

      const roiWidth = roi.width ?? roi.radius * 2;
      const roiHeight = roi.height ?? roi.radius * 2;
      results.push({
        roiId: roi.id,
        roiName: roi.name,
        objectType: roi.objectType,
        masterPosition: { x: roi.x, y: roi.y },
        expectedTransformedPosition: { x: roi.x, y: roi.y },
        actualDetectedPosition: { x: roi.x, y: roi.y },
        positionOffsetPx: 0,
        positionOffsetMm: 0,
        isWithinTolerance: passed,
        confidence: Math.round(similarity * 100) / 100,
        isPresent: hasEvidence,
        evidence: hasEvidence ? 'PRESENT' : 'UNCERTAIN',
        status: !hasEvidence ? 'WARNING' : passed ? 'PASS' : 'FAIL',
        failureReason: !hasEvidence
          ? `${roi.name}: ROI image or approved OK reference is unavailable`
          : passed
            ? undefined
            : `${roi.name}: visual mismatch against approved OK reference (${Math.round(similarity * 100)}% similarity)`,
      });
      void roiWidth;
      void roiHeight;
    }

    return { roiResults: results, extraObjects: [], detectedScrewCount: matchedCount };
  }
}

export const roiInspector = new ROIInspector();
