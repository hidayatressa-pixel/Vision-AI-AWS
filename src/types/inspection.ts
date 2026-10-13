/**
 * Realtime Inspection State Machine and Result Types
 */

import { Box2D, Position2D } from './master';

export type InspectionMachineState =
  | 'CAMERA_INITIALIZING'
  | 'CAMERA_ERROR'
  | 'WAITING_FOR_PART'
  | 'PART_DETECTED'
  | 'STABILIZING'
  | 'CAPTURING'
  | 'ALIGNING'
  | 'INSPECTING'
  | 'JUDGEMENT_OK'
  | 'JUDGEMENT_NG'
  | 'INSPECTION_INVALID'
  | 'ALIGNMENT_ERROR'
  | 'INSPECTION_ERROR'
  | 'SYSTEM_ERROR'
  | 'WAITING_PART_REMOVAL';

export type JudgementResult = 'OK' | 'NG' | 'INVALID' | 'ERROR';

export type DefectCode =
  | 'MISSING_PART'
  | 'POSITION_OUT_OF_TOLERANCE'
  | 'EXTRA_OBJECT_DETECTED'
  | 'LOW_CONFIDENCE'
  | 'ALIGNMENT_FAILED'
  | 'UNSTABLE_MOTION'
  | 'PRODUCT_NOT_DETECTED'
  | 'INCORRECT_COUNT'
  | 'MASTER_CONFIGURATION_INVALID'
  | 'VISUAL_MISMATCH';

export interface DefectItem {
  code: DefectCode;
  roiId?: string;
  roiName?: string;
  message: string;
  expected?: string | number;
  actual?: string | number;
}

export interface AlignmentResult {
  success: boolean;
  translationX: number; // Pixels
  translationY: number; // Pixels
  rotationDeg: number; // Degrees
  scale: number; // Scaling factor (1.0 = exact)
  confidence: number; // 0.0 - 1.0
  matchedAnchorCount: number;
  totalAnchorCount: number;
  anchorPositions: Array<{
    id: string;
    expected: Position2D;
    found: Position2D;
    confidence: number;
  }>;
  errorMessage?: string;
}

export interface ROIInspectionResult {
  roiId: string;
  roiName: string;
  objectType: string;
  masterPosition: Position2D; // Master normalized position
  expectedTransformedPosition: Position2D; // In current frame coordinates (normalized)
  actualDetectedPosition: Position2D | null; // Detected center
  positionOffsetPx: number;
  positionOffsetMm: number;
  isWithinTolerance: boolean;
  confidence: number;
  isPresent: boolean;
  /** Evidence classification prevents low-confidence absence from becoming automatic NG. */
  evidence: 'PRESENT' | 'ABSENT' | 'UNCERTAIN';
  status: 'PASS' | 'FAIL' | 'WARNING';
  failureReason?: string;
}

export interface ExtraDetectedObject {
  id: string;
  position: Position2D;
  confidence: number;
  distanceToNearestExpected: number;
}

export interface SystemMetrics {
  cameraFps: number;
  partDetectionMs: number;
  stabilizationMs: number;
  alignmentMs: number;
  roiDetectionMs: number;
  ruleValidationMs: number;
  dbSaveMs: number;
  plcHandshakeMs?: number;
  totalCycleMs: number;
  frameResolution: {
    width: number;
    height: number;
  };
}

export interface InspectionRecord {
  id: string;
  timestamp: string; // ISO timestamp
  productId: string;
  productCode: string;
  productName: string;
  masterId: string;
  masterRevisionId: string;
  masterRevisionCode: string;
  judgement: JudgementResult;
  expectedCount: number;
  detectedCount: number;
  defects: DefectItem[];
  primaryReason: string;
  metrics: SystemMetrics;
  alignment: AlignmentResult;
  roiResults: ROIInspectionResult[];
  extraObjects: ExtraDetectedObject[];
  thumbnailBase64?: string;
  deviceId: string;
  operatorId?: string;
  syncedToCloud: boolean;
  sequenceNumber?: number;
  plcInterlockState?: string;
  plcCommLatencyMs?: number;
  plcTimeline?: Array<{
    timestamp: string;
    elapsedMs: number;
    eventName: string;
    source: 'PLC' | 'VISION' | 'INTERLOCK';
    description: string;
  }>;
}

export interface InspectionStats {
  totalInspected: number;
  totalOk: number;
  totalNg: number;
  totalInvalid: number;
  totalErrors: number;
  yieldRate: number; // 0 - 100%
  lastCycleTimeMs: number;
  averageCycleTimeMs: number;
}
