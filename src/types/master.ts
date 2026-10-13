/**
 * Master Product and Inspection Configuration Data Models
 */

export interface Position2D {
  x: number; // Normalized (0 - 1) or Master pixel coordinates
  y: number;
}

export interface Box2D {
  x: number; // Normalized (0 to 1) relative to frame
  y: number;
  width: number;
  height: number;
}

export interface ReferenceAnchor {
  id: string;
  name: string;
  x: number;
  y: number;
  searchRadius: number;
  patchRadius: number;
  featurePattern?: number[][];
  description?: string;
}

export type ReferenceClass = 'OK' | 'NG';

/** A normalized rectangle stored in top-left coordinates relative to one reference image. */
export interface ReferenceRoiLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ReferenceImage {
  id: string;
  label: string;
  imageUrl: string;
  /** Class label used by multi-reference visual classification. Legacy references default to OK. */
  kind?: ReferenceClass;
  /** Each reference image can have its own independently editable ROI layout, keyed by InspectionROI.id. */
  roiLayouts?: Record<string, ReferenceRoiLayout>;
  /** Legacy one-reference-per-ROI mapping, retained only for data migration. */
  roiId?: string;
  description?: string;
}

export type InspectionObjectType = 'screw' | 'connector' | 'clip' | 'label' | 'component';

export interface InspectionROI {
  id: string;
  name: string;
  objectType: InspectionObjectType;
  x: number;
  y: number;
  radius: number;
  /** Normalized rectangle size (0-1). When omitted, legacy radius defines a square ROI. */
  width?: number;
  height?: number;
  toleranceRadius: number;
  minConfidence: number;
  isRequired: boolean;
  expectedPolarity?: 'bright_on_dark' | 'dark_on_bright' | 'contrast';
}

export interface ToleranceConfig {
  maxPositionOffsetMm: number;
  maxPositionOffsetPx: number;
  maxRotationToleranceDeg: number;
  minAlignmentConfidence: number;
  minScale?: number;
  maxScale?: number;
  maxAlignmentResidualPx?: number;
  minScrewConfidence: number;
  stabilizationDelayMs: number;
  stabilizationMotionThreshold: number;
  partRemovalThreshold: number;
  detectionZonePresenceThreshold: number;
}

export interface MasterRevision {
  id: string;
  masterId: string;
  revisionCode: string;
  revisionNote: string;
  expectedObjectCount: number;
  anchors: ReferenceAnchor[];
  inspectionROIs: InspectionROI[];
  referenceImages: ReferenceImage[];
  tolerance: ToleranceConfig;
  masterImageUrl: string;
  masterWidth: number;
  masterHeight: number;
  detectionZone: Box2D;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface MasterProduct {
  id: string;
  productCode: string;
  productName: string;
  description: string;
  activeRevisionId: string;
  revisions: MasterRevision[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}
