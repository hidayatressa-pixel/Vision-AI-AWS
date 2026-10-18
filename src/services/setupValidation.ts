import { MasterRevision, ReferenceImage, ReferenceRoiLayout } from '../types/master';

export interface SetupValidationCheck {
  label: string;
  valid: boolean;
  detail: string;
  error: string;
}

function defaultLayout(roi: MasterRevision['inspectionROIs'][number]): ReferenceRoiLayout {
  const width = roi.width ?? roi.radius * 2;
  const height = roi.height ?? roi.radius * 2;
  return {
    x: Math.max(0, Math.min(1 - width, roi.x - width / 2)),
    y: Math.max(0, Math.min(1 - height, roi.y - height / 2)),
    width,
    height,
  };
}

export function getMasterValidationChecks(revision: MasterRevision): SetupValidationCheck[] {
  const references = revision.referenceImages || [];
  const rois = revision.inspectionROIs || [];
  const anchors = revision.anchors || [];
  const okReferences = references.filter((reference) => (reference.kind || 'OK') === 'OK');
  const ngReferences = references.filter((reference) => reference.kind === 'NG');
  const isNormalized = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
  const zone = revision.detectionZone;
  // Backward compatibility: legacy profiles allow out-of-zone ROIs with a warning.
  const roiBoundaryPolicy = revision.roiBoundaryPolicy || 'WARNING';
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
  const anchorIdsAreUnique = new Set(anchors.map((anchor) => anchor.id)).size === anchors.length &&
    anchors.every((anchor) => Boolean(anchor.id?.trim()));
  const anchorsHaveValidGeometry = anchors.every((anchor) =>
    isNormalized(anchor.x) && isNormalized(anchor.y) &&
    Number.isFinite(anchor.searchRadius) && anchor.searchRadius > 0 && anchor.searchRadius <= 0.5 &&
    Number.isFinite(anchor.patchRadius) && anchor.patchRadius >= 4 && anchor.patchRadius <= 20
  );
  const anchorsValid = anchors.length >= 3 && anchorIdsAreUnique && anchorsHaveValidGeometry;
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
  const roiContainmentRequired = roiBoundaryPolicy === 'STRICT';
  const roiContainmentAccepted = !roiContainmentRequired || roisWithinDetectionZone;
  const referenceIdsUnique = new Set(references.map((reference) => reference.id)).size === references.length &&
    references.every((reference) => Boolean(reference.id?.trim()));
  const referenceLayoutsValid = references.every((reference) => rois.every((roi) => {
    const layout = reference.roiLayouts?.[roi.id] || defaultLayout(roi);
    return isNormalized(layout.x) && isNormalized(layout.y) &&
      Number.isFinite(layout.width) && layout.width > 0 && layout.width <= 1 &&
      Number.isFinite(layout.height) && layout.height > 0 && layout.height <= 1 &&
      layout.x + layout.width <= 1 && layout.y + layout.height <= 1;
  }));
  const uploadedReferences = references.filter((reference) => Boolean(reference.imageUrl?.trim()));
  const allReferencesUploaded = uploadedReferences.some((reference) => (reference.kind || 'OK') === 'OK') &&
    uploadedReferences.some((reference) => reference.kind === 'NG');
  const layoutCoverage = references.length > 0 &&
    references.every((reference) => rois.every((roi) => Boolean(reference.roiLayouts?.[roi.id])));

  return [
    {
      label: 'Reference anchors',
      valid: anchorsValid,
      detail: `${anchors.length} configured · ${anchors.length >= 3 ? 'minimum met' : 'at least 3 required'}${!anchorIdsAreUnique ? ' · duplicate IDs' : ''}${!anchorsHaveValidGeometry ? ' · invalid coordinates or search settings' : ''}`,
      error: 'Configure at least 3 valid, uniquely identified anchors. Every configured anchor must be detectable before inspection can pass.',
    },
    {
      label: 'Rectangular ROIs',
      valid: rois.length >= 1 && roisHaveValidGeometry && roiIdsAreUnique && roiContainmentAccepted,
      detail: `${rois.length} ROI(s) configured${!roisHaveValidGeometry ? ' · invalid rectangle geometry' : ''}${!roiIdsAreUnique ? ' · duplicate IDs' : ''}${!roisWithinDetectionZone ? (roiBoundaryPolicy === 'STRICT' ? ' · outside detection zone (blocked)' : roiBoundaryPolicy === 'WARNING' ? ' · outside detection zone (allowed with warning)' : ' · containment check disabled') : ''}`,
      error: roiBoundaryPolicy === 'STRICT'
        ? 'Configure at least one valid rectangular ROI inside the detection zone, or change the boundary policy.'
        : 'Configure at least one valid rectangular ROI with valid geometry and unique IDs.',
    },
    {
      label: 'ROI boundary policy',
      valid: true,
      detail: roiBoundaryPolicy === 'STRICT'
        ? 'Strict · all ROIs must be inside Detection Zone'
        : roiBoundaryPolicy === 'WARNING'
          ? 'Flexible · outside ROIs allowed with warning'
          : 'Disabled · containment is not checked',
      error: '',
    },
    {
      label: 'Master image',
      valid: Boolean(revision.masterImageUrl?.trim()),
      detail: revision.masterImageUrl?.trim() ? 'Ready' : 'Missing',
      error: 'Upload a master image to initialize the inspection layout.',
    },
    {
      label: 'Master resolution',
      valid: Number.isInteger(revision.masterWidth) && revision.masterWidth > 0 && Number.isInteger(revision.masterHeight) && revision.masterHeight > 0,
      detail: Number.isInteger(revision.masterWidth) && revision.masterWidth > 0 && Number.isInteger(revision.masterHeight) && revision.masterHeight > 0 ? `${revision.masterWidth}×${revision.masterHeight}` : 'Invalid',
      error: 'Master image dimensions are invalid.',
    },
    {
      label: 'OK/NG reference images',
      valid: allReferencesUploaded,
      detail: `${okReferences.filter((item) => Boolean(item.imageUrl?.trim())).length} OK · ${ngReferences.filter((item) => Boolean(item.imageUrl?.trim())).length} NG`,
      error: 'Add at least one uploaded OK reference and one uploaded NG reference. Add more examples when needed.',
    },
    {
      label: 'Per-reference ROI layout',
      valid: referenceLayoutsValid && layoutCoverage,
      detail: layoutCoverage ? `ROI layouts saved for ${references.length} references` : 'Some reference layouts need initialization',
      error: 'Configure a valid rectangle layout for every ROI on each reference image.',
    },
    {
      label: 'Detection zone',
      valid: detectionZoneValid,
      detail: detectionZoneValid ? 'Valid normalized bounds' : 'Invalid bounds',
      error: 'The detection zone must be a valid rectangle within the master image.',
    },
    {
      label: 'Reference IDs',
      valid: referenceIdsUnique,
      detail: referenceIdsUnique ? 'Unique' : 'Duplicate or empty IDs',
      error: 'Reference image IDs must be unique.',
    },
    {
      label: 'Inspection point count',
      // Simple ROI mode derives its expected count from the configured ROI list.
      // expectedObjectCount is retained for legacy data and normalized on save.
      valid: rois.length >= 1,
      detail: `${rois.length} configured · derived from inspection areas`,
      error: 'Configure at least one inspection area.',
    },
    {
      label: 'ROI similarity threshold',
      valid: rois.every((roi) => Number.isFinite(roi.minConfidence) && roi.minConfidence >= 0.5 && roi.minConfidence <= 0.98),
      detail: 'Configured per ROI',
      error: 'ROI similarity threshold must be between 50% and 98%.',
    },
  ];
}
