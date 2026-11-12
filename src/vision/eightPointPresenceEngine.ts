/**
 * Eight-point presence inspection for a rigid workpiece.
 *
 * The workpiece is globally aligned first. Each expected screw slot is then
 * inspected independently by ROIInspector; this module owns the eight-slot
 * contract and fail-safe aggregation, not image segmentation.
 */
import type { InspectionROI } from '../types/master';
import type { ROIInspectionResult, DefectItem, JudgementResult } from '../types/inspection';

export const EIGHT_POINT_COUNT = 8;

export interface EightPointResult {
  judgement: JudgementResult;
  expectedCount: number;
  detectedCount: number;
  missingCount: number;
  uncertainCount: number;
  defects: DefectItem[];
  points: Array<{
    roiId: string;
    roiName: string;
    status: 'OK' | 'NG' | 'UNCERTAIN';
    confidence: number;
    actualPosition: { x: number; y: number } | null;
  }>;
}

export function isEightPointPresenceCandidate(rois: InspectionROI[]): boolean {
  return rois.length === EIGHT_POINT_COUNT &&
    rois.every((roi) =>
      roi.objectType === 'screw' &&
      roi.expectedObjectPresence !== false
    );
}

/** Validate eight unique, required, non-overlapping screw slots in Master coordinates. */
export function validateEightPointPresenceLayout(rois: InspectionROI[]): string[] {
  if (!isEightPointPresenceCandidate(rois)) return [];
  const errors: string[] = [];
  const ids = new Set(rois.map((roi) => roi.id));
  if (ids.size !== EIGHT_POINT_COUNT || rois.some((roi) => !roi.id?.trim())) {
    errors.push('Eight screw slots must have unique, non-empty IDs.');
  }

  const bounds = rois.map((roi) => {
    const width = roi.width ?? roi.radius * 2;
    const height = roi.height ?? roi.radius * 2;
    return {
      id: roi.id,
      left: roi.x - width / 2,
      right: roi.x + width / 2,
      top: roi.y - height / 2,
      bottom: roi.y + height / 2,
      valid: [roi.x, roi.y, width, height].every(Number.isFinite) &&
        width > 0 && height > 0 &&
        roi.x >= 0 && roi.x <= 1 && roi.y >= 0 && roi.y <= 1 &&
        roi.x - width / 2 >= 0 && roi.y - height / 2 >= 0 &&
        roi.x + width / 2 <= 1 && roi.y + height / 2 <= 1,
    };
  });

  if (bounds.some((item) => !item.valid)) {
    errors.push('Every screw slot must have valid normalized bounds inside the Master image.');
  }

  for (let i = 0; i < bounds.length; i++) {
    for (let j = i + 1; j < bounds.length; j++) {
      const overlapWidth = Math.min(bounds[i].right, bounds[j].right) -
        Math.max(bounds[i].left, bounds[j].left);
      const overlapHeight = Math.min(bounds[i].bottom, bounds[j].bottom) -
        Math.max(bounds[i].top, bounds[j].top);
      if (overlapWidth > 0.001 && overlapHeight > 0.001) {
        errors.push(`Screw slots ${bounds[i].id} and ${bounds[j].id} overlap; one detected screw could be counted twice.`);
      }
    }
  }

  if (rois.some((roi) => !roi.isRequired)) {
    errors.push('All eight screw slots must be marked as required.');
  }
  return [...new Set(errors)];
}

export function evaluateEightPointPresence(
  rois: InspectionROI[],
  roiResults: ROIInspectionResult[]
): EightPointResult {
  const resultById = new Map(roiResults.map((result) => [result.roiId, result]));
  const points: EightPointResult['points'] = [];
  const defects: DefectItem[] = [];
  let detectedCount = 0;
  let missingCount = 0;
  let uncertainCount = 0;

  for (const roi of rois) {
    const result = resultById.get(roi.id);
    let status: EightPointResult['points'][number]['status'] = 'UNCERTAIN';

    if (!result || result.evidence === 'UNCERTAIN') {
      uncertainCount++;
      defects.push({
        code: 'LOW_CONFIDENCE',
        roiId: roi.id,
        roiName: roi.name,
        message: result?.failureReason || `${roi.name}: no reliable presence evidence was returned`,
        expected: 'One screw visibly present in this slot',
        actual: 'Presence could not be confirmed',
      });
    } else if (result.evidence === 'ABSENT') {
      missingCount++;
      status = 'NG';
      defects.push({
        code: 'MISSING_PART',
        roiId: roi.id,
        roiName: roi.name,
        message: result.failureReason || `${roi.name}: screw is missing`,
        expected: 'Screw present',
        actual: 'Screw absent',
      });
    } else {
      detectedCount++;
      status = 'OK';
    }

    points.push({
      roiId: roi.id,
      roiName: roi.name,
      status,
      confidence: result?.confidence ?? 0,
      actualPosition: result?.actualDetectedPosition ?? null,
    });
  }

  // A confirmed missing screw is a product NG even if another slot is uncertain.
  // If no absence is proven but any slot is unreadable, the cycle is INVALID.
  const judgement: JudgementResult = missingCount > 0
    ? 'NG'
    : uncertainCount > 0
      ? 'INVALID'
      : detectedCount === EIGHT_POINT_COUNT
        ? 'OK'
        : 'INVALID';

  return {
    judgement,
    expectedCount: EIGHT_POINT_COUNT,
    detectedCount,
    missingCount,
    uncertainCount,
    defects,
    points,
  };
}
