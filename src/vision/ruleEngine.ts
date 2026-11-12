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
import { getMasterValidationChecks } from '../services/setupValidation';

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
    const failedMasterChecks = getMasterValidationChecks(revision).filter((check) => !check.valid);
    if (failedMasterChecks.length > 0) {
      const details = failedMasterChecks.map((check) => `${check.label}: ${check.error || check.detail}`).join('; ');
      defects.push({
        code: 'MASTER_CONFIGURATION_INVALID',
        message: 'Master configuration failed runtime validation: ' + details,
        expected: 'A complete, valid Master with usable OK/NG references, ROI layouts, and alignment settings',
        actual: `${failedMasterChecks.length} validation check(s) failed (OK refs ${okReferences.length}, NG refs ${ngReferences.length})`,
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
    let detectedCount = 0;
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

      if (result.isPresent) detectedCount++;

      if (!result.isWithinTolerance || result.status === 'FAIL') {
        defects.push({
          code: result.evidence === 'ABSENT' ? 'MISSING_PART' : 'VISUAL_MISMATCH',
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
        detectedCount,
      };
    }

    if (defects.length === 0 && passedCount === expectedCount) {
      return {
        judgement: 'OK',
        primaryReason: `All ${passedCount}/${expectedCount} rectangular ROI comparisons classified as OK using ${okReferences.length} OK / ${ngReferences.length} NG references`,
        defects: [],
        expectedCount,
        detectedCount,
      };
    }

    return {
      judgement: 'NG',
      primaryReason: defects[0]?.message || 'Visual mismatch detected',
      defects,
      expectedCount,
      detectedCount,
    };
  }
}

export const ruleEngine = new RuleEngine();
