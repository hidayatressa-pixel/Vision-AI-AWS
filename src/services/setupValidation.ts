import { MasterRevision } from '../types/master';

export interface SetupValidationCheck {
  label: string;
  valid: boolean;
  detail: string;
  error: string;
}

export function getMasterValidationChecks(revision: MasterRevision): SetupValidationCheck[] {
  const references = revision.referenceImages || [];
  const rois = revision.inspectionROIs || [];
  const isNormalized = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
  const zone = revision.detectionZone;
  const detectionZoneValid = Boolean(zone) &&
    Number.isFinite(zone.x) && Number.isFinite(zone.y) &&
    Number.isFinite(zone.width) && Number.isFinite(zone.height) &&
    zone.x >= 0 && zone.y >= 0 && zone.width > 0 && zone.height > 0 &&
    zone.x + zone.width <= 1 && zone.y + zone.height <= 1;

  const roisHaveValidGeometry = rois.every((roi) => {
    const width = roi.width ?? roi.radius * 2;
    const height = roi.height ?? roi.radius * 2;
    return isNormalized(roi.x) && isNormalized(roi.y) &&
      Number.isFinite(width) && width > 0 && width <= 1 &&
      Number.isFinite(height) && height > 0 && height <= 1 &&
      roi.x - width / 2 >= 0 && roi.y - height / 2 >= 0 &&
      roi.x + width / 2 <= 1 && roi.y + height / 2 <= 1 &&
      Number.isFinite(roi.minConfidence) && roi.minConfidence >= 0.5 && roi.minConfidence <= 0.98;
  });
  const roiIdsAreUnique = new Set(rois.map((roi) => roi.id)).size === rois.length &&
    rois.every((roi) => Boolean(roi.id?.trim()));
  const roisWithinDetectionZone = detectionZoneValid && rois.every((roi) => {
    const width = roi.width ?? roi.radius * 2;
    const height = roi.height ?? roi.radius * 2;
    return roi.x - width / 2 >= zone.x &&
      roi.y - height / 2 >= zone.y &&
      roi.x + width / 2 <= zone.x + zone.width &&
      roi.y + height / 2 <= zone.y + zone.height;
  });
  const referencesMapOneToOne = references.length === rois.length &&
    new Set(references.map((reference) => reference.roiId)).size === rois.length &&
    rois.every((roi) => references.some((reference) =>
      reference.roiId === roi.id && Boolean(reference.imageUrl?.trim())
    ));

  return [
    {
      label: 'Alignment',
      valid: true,
      detail: 'Not required in Simple ROI mode',
      error: '',
    },
    {
      label: 'Rectangular ROIs',
      valid: rois.length >= 1 && roisHaveValidGeometry && roiIdsAreUnique && roisWithinDetectionZone,
      detail: `${rois.length} ROI(s) configured${!roisHaveValidGeometry ? ' · invalid rectangle geometry' : ''}${!roiIdsAreUnique ? ' · duplicate IDs' : ''}${!roisWithinDetectionZone ? ' · outside detection zone' : ''}`,
      error: 'Configure at least one rectangular ROI with valid normalized position and size inside the detection zone.',
    },
    {
      label: 'Master image',
      valid: Boolean(revision.masterImageUrl?.trim()),
      detail: revision.masterImageUrl?.trim() ? 'Ready' : 'Missing',
      error: 'Upload a master image for ROI setup.',
    },
    {
      label: 'Master resolution',
      valid: revision.masterWidth > 0 && revision.masterHeight > 0,
      detail: revision.masterWidth > 0 && revision.masterHeight > 0 ? `${revision.masterWidth}×${revision.masterHeight}` : 'Invalid',
      error: 'Master image dimensions are invalid.',
    },
    {
      label: 'Approved OK references',
      valid: referencesMapOneToOne,
      detail: `${references.filter((reference) => Boolean(reference.imageUrl?.trim() && rois.some((roi) => roi.id === reference.roiId))).length}/${rois.length} mapped`,
      error: 'Upload one approved OK reference image for every rectangular ROI.',
    },
    {
      label: 'Detection zone',
      valid: detectionZoneValid,
      detail: detectionZoneValid ? 'Valid normalized bounds' : 'Invalid bounds',
      error: 'The detection zone must be a valid rectangle within the master image.',
    },
    {
      label: 'Reference IDs',
      valid: new Set(references.map((reference) => reference.id)).size === references.length &&
        references.every((reference) => Boolean(reference.id?.trim())),
      detail: new Set(references.map((reference) => reference.id)).size === references.length ? 'Unique' : 'Duplicate IDs',
      error: 'Reference image IDs must be unique.',
    },
    {
      label: 'Expected ROI count',
      valid: revision.expectedObjectCount === rois.length,
      detail: `${revision.expectedObjectCount} expected / ${rois.length} configured`,
      error: 'Expected ROI count must match the number of rectangular ROIs.',
    },
    {
      label: 'ROI similarity threshold',
      valid: rois.every((roi) => Number.isFinite(roi.minConfidence) && roi.minConfidence >= 0.5 && roi.minConfidence <= 0.98),
      detail: 'Configured per ROI',
      error: 'ROI similarity threshold must be between 50% and 98%.',
    },
  ];
}
