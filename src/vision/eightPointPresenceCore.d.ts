import type { AlignmentResult, ROIInspectionResult, DefectItem, JudgementResult } from '../types/inspection';
import type { InspectionROI, MasterRevision } from '../types/master';

export interface EightPointResult {
  applicable: true;
  judgement: JudgementResult;
  expectedCount: 8;
  detectedCount: number;
  missingCount: number;
  uncertainCount: number;
  points: Array<{
    pointNumber: number;
    pointId: string;
    pointName: string;
    status: 'OK' | 'NG' | 'UNCERTAIN';
    evidence: 'PRESENT' | 'ABSENT' | 'UNCERTAIN';
    confidence: number;
    expectedPosition?: { x: number; y: number };
    detectedPosition: { x: number; y: number } | null;
    reason?: string;
  }>;
  defects: DefectItem[];
  primaryReason: string;
}
export function isEightPointPresenceProfile(rois: InspectionROI[]): boolean;
export function evaluateEightPointPresence(
  revision: MasterRevision,
  alignment: AlignmentResult,
  roiResults: ROIInspectionResult[]
): EightPointResult | null;
