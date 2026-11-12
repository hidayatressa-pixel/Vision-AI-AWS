import type { InspectionROI } from '../types/master';
import type { ROIInspectionResult } from '../types/inspection';

export interface EightPointPresenceEvaluation {
  enabled: boolean;
  configurationValid: boolean;
  expectedCount: number;
  detectedCount: number;
  missingCount: number;
  uncertainCount: number;
  roiResults: ROIInspectionResult[];
  issues: string[];
}

export function applyEightPointPresence(
  rois: InspectionROI[],
  roiResults: ROIInspectionResult[],
  frameWidth: number,
  frameHeight: number
): EightPointPresenceEvaluation;
