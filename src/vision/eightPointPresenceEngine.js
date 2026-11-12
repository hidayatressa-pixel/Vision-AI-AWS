/**
 * Eight-point screw presence aggregation.
 *
 * The eight Master ROIs are ordered slots P1..P8. ROI localization remains
 * anchored to Master coordinates and is transformed by AlignmentEngine, so
 * whole-part translation/rotation does not change slot identity.
 *
 * This layer never upgrades UNCERTAIN evidence to OK or NG. It also detects
 * duplicate localization when two distant expected slots resolve to nearly
 * the same camera-frame centroid.
 */
const EXPECTED_POINT_COUNT = 8;

function distancePx(a, b, width, height) {
  return Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
}

function uncertainDuplicate(result, pointId, otherPointId) {
  return {
    ...result,
    inspectionPointId: pointId,
    isPresent: false,
    evidence: 'UNCERTAIN',
    status: 'WARNING',
    isWithinTolerance: false,
    failureReason: `${pointId}: localization overlaps ${otherPointId}; unique bolt-to-slot assignment is not proven`,
  };
}

/**
 * Apply the eight-point contract to already aligned per-ROI recognition.
 * Returns enabled=false for all legacy/non-eight-screw Master configurations.
 */
export function applyEightPointPresence(rois, roiResults, frameWidth, frameHeight) {
  const eligible = Array.isArray(rois) &&
    rois.length === EXPECTED_POINT_COUNT &&
    rois.every((roi) => roi.objectType === 'screw' && roi.expectedObjectPresence !== false && roi.isRequired !== false);

  if (!eligible) {
    return {
      enabled: false,
      configurationValid: true,
      expectedCount: rois?.length || 0,
      detectedCount: 0,
      missingCount: 0,
      uncertainCount: 0,
      roiResults,
      issues: [],
    };
  }

  const ids = rois.map((roi) => roi.id);
  if (ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== EXPECTED_POINT_COUNT) {
    return {
      enabled: true,
      configurationValid: false,
      expectedCount: EXPECTED_POINT_COUNT,
      detectedCount: 0,
      missingCount: 0,
      uncertainCount: EXPECTED_POINT_COUNT,
      roiResults,
      issues: ['Eight-point Master requires eight unique, non-empty ROI IDs'],
    };
  }

  const byId = new Map((roiResults || []).map((result) => [result.roiId, result]));
  const points = rois.map((roi, index) => {
    const pointId = `P${index + 1}`;
    const result = byId.get(roi.id);
    if (!result) {
      return {
        roiId: roi.id,
        roiName: roi.name,
        objectType: roi.objectType,
        masterPosition: { x: roi.x, y: roi.y },
        expectedTransformedPosition: { x: roi.x, y: roi.y },
        actualDetectedPosition: null,
        positionOffsetPx: null,
        positionOffsetMm: null,
        isWithinTolerance: false,
        confidence: 0,
        isPresent: false,
        evidence: 'UNCERTAIN',
        status: 'WARNING',
        failureReason: `${pointId}: ROI inspection result is missing`,
        inspectionPointId: pointId,
      };
    }
    return { ...result, inspectionPointId: pointId };
  });

  const duplicateIndexes = new Set();
  for (let i = 0; i < points.length; i++) {
    const first = points[i];
    if (first.evidence !== 'PRESENT' || !first.actualDetectedPosition) continue;
    for (let j = i + 1; j < points.length; j++) {
      const second = points[j];
      if (second.evidence !== 'PRESENT' || !second.actualDetectedPosition) continue;
      const expectedDistance = distancePx(
        first.expectedTransformedPosition,
        second.expectedTransformedPosition,
        frameWidth,
        frameHeight
      );
      const actualDistance = distancePx(
        first.actualDetectedPosition,
        second.actualDetectedPosition,
        frameWidth,
        frameHeight
      );
      const firstWidth = (rois[i].width ?? rois[i].radius * 2) * frameWidth;
      const firstHeight = (rois[i].height ?? rois[i].radius * 2) * frameHeight;
      const secondWidth = (rois[j].width ?? rois[j].radius * 2) * frameWidth;
      const secondHeight = (rois[j].height ?? rois[j].radius * 2) * frameHeight;
      const mergeRadiusPx = Math.max(4, Math.min(firstWidth, firstHeight, secondWidth, secondHeight) * 0.15);

      // Only flag a collision when expected slots are distinct but detections
      // collapse to the same local region. Nearby real slots remain valid.
      if (expectedDistance > mergeRadiusPx * 2 && actualDistance <= mergeRadiusPx) {
        duplicateIndexes.add(i);
        duplicateIndexes.add(j);
      }
    }
  }

  for (const index of duplicateIndexes) {
    const otherIndex = points.findIndex((point, candidate) =>
      candidate !== index && duplicateIndexes.has(candidate) &&
      distancePx(
        points[index].actualDetectedPosition,
        point.actualDetectedPosition,
        frameWidth,
        frameHeight
      ) <= Math.max(
        4,
        Math.min(
          (rois[index].width ?? rois[index].radius * 2) * frameWidth,
          (rois[index].height ?? rois[index].radius * 2) * frameHeight
        ) * 0.15
      )
    );
    points[index] = uncertainDuplicate(points[index], `P${index + 1}`, otherIndex >= 0 ? `P${otherIndex + 1}` : 'another slot');
  }

  const detectedCount = points.filter((point) => point.evidence === 'PRESENT').length;
  const missingCount = points.filter((point) => point.evidence === 'ABSENT').length;
  const uncertainCount = points.filter((point) => point.evidence === 'UNCERTAIN').length;

  return {
    enabled: true,
    configurationValid: true,
    expectedCount: EXPECTED_POINT_COUNT,
    detectedCount,
    missingCount,
    uncertainCount,
    roiResults: points,
    issues: [],
  };
}
