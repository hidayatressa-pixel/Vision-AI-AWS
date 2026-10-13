/**
 * Simple visual comparison rules for rectangular ROI inspection.
 * Product judgement is based on the similarity of each ROI to its approved OK reference.
 */
import {
  AlignmentResult,
  DefectItem,
  ExtraDetectedObject,
  JudgementResult,
  ROIInspectionResult,
} from '../types/inspection';
import { MasterRevision } from '../types/master';

export interface RuleEvaluationResult {
  judgement: JudgementResult;
  primaryReason: string;
  defects: DefectItem[];
  expectedCount: number;
  detectedCount: number;
}

export class RuleEngine {
  public evaluate(
    revision: MasterRevision,
    alignment: AlignmentResult,
    roiResults: ROIInspectionResult[],
    extraObjects: ExtraDetectedObject[]
  ): RuleEvaluationResult {
    void extraObjects;
    const expectedCount = revision.inspectionROIs.length;
    const defects: DefectItem[] = [];

    const references = (revision.referenceImages || []).filter((reference) => Boolean(reference.imageUrl));
    const okReferences = references.filter((reference) => (reference.kind || 'OK') === 'OK');
    const ngReferences = references.filter((reference) => reference.kind === 'NG');
    const anchors = revision.anchors || [];
    const anchorIdsUnique = new Set(anchors.map((anchor) => anchor.id)).size === anchors.length && anchors.every((anchor) => Boolean(anchor.id?.trim()));
    const anchorsValid = anchors.length >= 3 && anchorIdsUnique && anchors.every((anchor) =>
      Number.isFinite(anchor.x) && anchor.x >= 0 && anchor.x <= 1 &&
      Number.isFinite(anchor.y) && anchor.y >= 0 && anchor.y <= 1 &&
      Number.isFinite(anchor.searchRadius) && anchor.searchRadius > 0 &&
      Number.isFinite(anchor.patchRadius) && anchor.patchRadius >= 4
    );
    const invalidConfiguration =
      !anchorsValid ||
      !Number.isInteger(revision.masterWidth) || revision.masterWidth <= 0 ||
      !Number.isInteger(revision.masterHeight) || revision.masterHeight <= 0 ||
      !revision.masterImageUrl ||
      expectedCount === 0 ||
      okReferences.length < 1 ||
      ngReferences.length < 1;
    if (invalidConfiguration) {
      const details = [
        !revision.masterImageUrl ? 'master image missing' : '',
        !Number.isInteger(revision.masterWidth) || revision.masterWidth <= 0 || !Number.isInteger(revision.masterHeight) || revision.masterHeight <= 0 ? 'invalid master image dimensions' : '',
        !anchorsValid ? `anchor configuration invalid (${anchors.length} configured; need at least 3 valid unique anchors)` : '',
        expectedCount === 0 ? 'no rectangular ROI configured' : '',
        `reference set incomplete (OK ${okReferences.length}, NG ${ngReferences.length}; need at least one of each)`,
      ].filter(Boolean).join('; ');
      defects.push({
        code: 'MASTER_CONFIGURATION_INVALID',
        message: 'Multi-reference ROI configuration is incomplete: ' + details,
        expected: 'Valid master dimensions, at least 3 unique anchors, at least one ROI, and uploaded OK plus NG references',
        actual: 'Configuration incomplete',
      });
      return {
        judgement: 'INVALID',
        primaryReason: defects[0].message,
        defects,
        expectedCount,
        detectedCount: 0,
      };
    }

    if (!alignment.success) {
      defects.push({
        code: 'ALIGNMENT_FAILED',
        message: alignment.errorMessage || 'Camera frame could not be used for ROI inspection',
        expected: 'Valid camera frame',
        actual: 'Invalid frame',
      });
      return { judgement: 'INVALID', primaryReason: defects[0].message, defects, expectedCount, detectedCount: 0 };
    }

    const resultById = new Map(roiResults.map((result) => [result.roiId, result]));
    let passedCount = 0;
    let uncertainCount = 0;

    for (const roi of revision.inspectionROIs) {
      const result = resultById.get(roi.id);
      if (!result || result.evidence === 'UNCERTAIN') {
        uncertainCount++;
        defects.push({
          code: 'LOW_CONFIDENCE',
          roiId: roi.id,
          roiName: roi.name,
          message: result?.failureReason || `${roi.name}: comparison evidence unavailable`,
          expected: 'Readable ROI and complete OK/NG reference set',
          actual: 'Comparison could not be completed',
        });
        continue;
      }

      if (!result.isWithinTolerance || result.status === 'FAIL') {
        defects.push({
          code: 'VISUAL_MISMATCH',
          roiId: roi.id,
          roiName: roi.name,
          message: result.failureReason || `${roi.name}: visual mismatch`,
          expected: `Similarity ≥ ${Math.round((roi.minConfidence || 0.75) * 100)}%`,
          actual: `${Math.round(result.confidence * 100)}% similarity`,
        });
      } else {
        passedCount++;
      }
    }

    if (uncertainCount > 0) {
      return {
        judgement: 'INVALID',
        primaryReason: 'Inspection Invalid: one or more ROI comparisons lacked reliable image evidence',
        defects,
        expectedCount,
        detectedCount: passedCount,
      };
    }

    if (defects.length === 0 && passedCount === expectedCount) {
      return {
        judgement: 'OK',
        primaryReason: `All ${passedCount}/${expectedCount} rectangular ROI comparisons classified as OK using ${okReferences.length} OK / ${ngReferences.length} NG references`,
        defects: [],
        expectedCount,
        detectedCount: passedCount,
      };
    }

    return {
      judgement: 'NG',
      primaryReason: defects[0]?.message || 'Visual mismatch detected',
      defects,
      expectedCount,
      detectedCount: passedCount,
    };
  }
}

export const ruleEngine = new RuleEngine();
