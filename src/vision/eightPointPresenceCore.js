/**
 * Eight-point screw presence profile.
 *
 * The eight slots are fixed in Master coordinates. Alignment moves the
 * complete workpiece into camera coordinates; each slot is then evaluated
 * independently by ROIInspector. This module only maps and aggregates that
 * evidence and never performs image segmentation itself.
 */

export function isEightPointPresenceProfile(rois) {
  return Array.isArray(rois) &&
    rois.length === 8 &&
    rois.every((roi) =>
      roi &&
      roi.objectType === 'screw' &&
      roi.isRequired === true &&
      roi.expectedObjectPresence !== false &&
      typeof roi.id === 'string' &&
      roi.id.trim().length > 0
    ) &&
    new Set(rois.map((roi) => roi.id)).size === 8;
}

export function evaluateEightPointPresence(revision, alignment, roiResults) {
  const rois = revision?.inspectionROIs || [];
  if (!isEightPointPresenceProfile(rois)) return null;

  const expectedCount = 8;
  if (!alignment?.success) {
    return {
      applicable: true,
      judgement: 'INVALID',
      expectedCount,
      detectedCount: 0,
      missingCount: 0,
      uncertainCount: expectedCount,
      points: rois.map((roi, index) => ({
        pointNumber: index + 1,
        pointId: roi.id,
        pointName: roi.name,
        status: 'UNCERTAIN',
        evidence: 'UNCERTAIN',
        confidence: 0,
        reason: alignment?.errorMessage || 'Workpiece alignment was not verified',
      })),
      defects: [{
        code: 'ALIGNMENT_FAILED',
        message: alignment?.errorMessage || 'Workpiece alignment was not verified',
        expected: 'Verified whole-workpiece alignment',
        actual: 'Alignment unavailable',
      }],
      primaryReason: alignment?.errorMessage || 'Eight-point inspection blocked because alignment failed',
    };
  }

  const byId = new Map((Array.isArray(roiResults) ? roiResults : []).map((item) => [item.roiId, item]));
  const points = [];
  const defects = [];
  let detectedCount = 0;
  let missingCount = 0;
  let uncertainCount = 0;

  rois.forEach((roi, index) => {
    const result = byId.get(roi.id);
    let status = 'UNCERTAIN';
    let evidence = result?.evidence || 'UNCERTAIN';
    let reason = result?.failureReason;

    if (result?.evidence === 'PRESENT' && result.status === 'PASS' && result.isWithinTolerance) {
      status = 'OK';
      detectedCount += 1;
    } else if (result?.evidence === 'ABSENT') {
      status = 'NG';
      evidence = 'ABSENT';
      missingCount += 1;
      reason ||= `${roi.name}: required screw is missing`;
      defects.push({
        code: 'MISSING_PART',
        roiId: roi.id,
        roiName: roi.name,
        message: reason,
        expected: 'Screw present',
        actual: 'Screw absent',
      });
    } else if (result?.evidence === 'PRESENT' && result.status === 'FAIL') {
      status = 'NG';
      detectedCount += 1;
      reason ||= `${roi.name}: detected object did not satisfy the approved screw reference`;
      defects.push({
        code: 'VISUAL_MISMATCH',
        roiId: roi.id,
        roiName: roi.name,
        message: reason,
        expected: 'Approved screw reference',
        actual: 'Present object differs from approved reference',
      });
    } else {
      uncertainCount += 1;
      reason ||= `${roi.name}: screw presence could not be confirmed`;
      defects.push({
        code: 'LOW_CONFIDENCE',
        roiId: roi.id,
        roiName: roi.name,
        message: reason,
        expected: 'Clear screw presence or absence evidence',
        actual: 'Uncertain',
      });
    }

    points.push({
      pointNumber: index + 1,
      pointId: roi.id,
      pointName: roi.name,
      status,
      evidence,
      confidence: Number.isFinite(result?.confidence) ? result.confidence : 0,
      expectedPosition: result?.expectedTransformedPosition || { x: roi.x, y: roi.y },
      detectedPosition: result?.actualDetectedPosition || null,
      reason,
    });
  });

  // A confirmed missing screw takes precedence over uncertainty elsewhere:
  // the product is already NG. Without a confirmed defect, uncertainty blocks OK.
  const judgement = missingCount > 0 || points.some((point) => point.status === 'NG')
    ? 'NG'
    : uncertainCount > 0
      ? 'INVALID'
      : detectedCount === expectedCount
        ? 'OK'
        : 'INVALID';

  const primaryReason = judgement === 'OK'
    ? 'All 8 required screws are present and match their approved references'
    : judgement === 'NG'
      ? defects.find((defect) => defect.code === 'MISSING_PART')?.message ||
        defects[0]?.message || 'Eight-point screw inspection failed'
      : 'Eight-point inspection is inconclusive; reliable evidence is required before OK';

  return {
    applicable: true,
    judgement,
    expectedCount,
    detectedCount,
    missingCount,
    uncertainCount,
    points,
    defects,
    primaryReason,
  };
}
