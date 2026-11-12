import assert from 'node:assert/strict';
import { isEightPointPresenceProfile, evaluateEightPointPresence, confirmsEightPointAbsence } from '../src/vision/eightPointPresenceCore.js';
import { describePatch } from '../src/vision/roiFeatureCore.js';

const rois = Array.from({ length: 8 }, (_, index) => ({
  id: `bolt-${index + 1}`,
  name: `P${index + 1}`,
  objectType: 'screw',
  isRequired: true,
  expectedObjectPresence: true,
  x: 0.1 + index * 0.1,
  y: 0.5,
}));
const revision = { inspectionROIs: rois };
const alignment = { success: true };
const result = (roi, evidence = 'PRESENT', status = 'PASS') => ({
  roiId: roi.id,
  evidence,
  status,
  isWithinTolerance: status === 'PASS',
  confidence: 0.95,
  expectedTransformedPosition: { x: roi.x, y: roi.y },
  actualDetectedPosition: evidence === 'PRESENT' ? { x: roi.x, y: roi.y } : null,
});

const emptySlot = describePatch(new Float32Array(64 * 64).fill(150), 64, 'contrast');
assert.equal(confirmsEightPointAbsence(emptySlot), true, 'high-confidence empty slot should confirm a missing screw');
assert.equal(confirmsEightPointAbsence({ present: false, presenceConfidence: 0.35, areaRatio: 0.02 }), false, 'weak/blurred evidence must remain uncertain');
assert.equal(isEightPointPresenceProfile(rois), true);
assert.equal(isEightPointPresenceProfile(rois.slice(0, 7)), false);
assert.equal(isEightPointPresenceProfile(rois.map((roi, i) => i === 2 ? { ...roi, objectType: 'clip' } : roi)), false);
assert.equal(isEightPointPresenceProfile(rois.map((roi, i) => i === 2 ? { ...roi, isRequired: false } : roi)), false);

const allOk = evaluateEightPointPresence(revision, alignment, rois.map((roi) => result(roi)));
assert.equal(allOk.judgement, 'OK');
assert.equal(allOk.detectedCount, 8);

for (const missingIndex of [0, 5, 6, 7]) {
  const sample = rois.map((roi, index) => result(roi, index === missingIndex ? 'ABSENT' : 'PRESENT', index === missingIndex ? 'FAIL' : 'PASS'));
  const evaluated = evaluateEightPointPresence(revision, alignment, sample);
  assert.equal(evaluated.judgement, 'NG');
  assert.equal(evaluated.missingCount, 1);
  assert.equal(evaluated.points[missingIndex].status, 'NG');
}

const uncertain = evaluateEightPointPresence(revision, alignment, rois.map((roi, index) => index === 3
  ? { ...result(roi), evidence: 'UNCERTAIN', status: 'WARNING', isWithinTolerance: false }
  : result(roi)));
const unmatchedObject = evaluateEightPointPresence(revision, alignment, rois.map((roi, index) => index === 2
  ? result(roi, 'PRESENT', 'FAIL')
  : result(roi)));
assert.equal(unmatchedObject.judgement, 'NG', 'a foreground object that fails the approved screw reference must not count as a valid screw');
assert.equal(unmatchedObject.detectedCount, 7, 'only reference-confirmed screws count as detected');

assert.equal(uncertain.judgement, 'INVALID');
assert.equal(uncertain.uncertainCount, 1);

const ngPlusUncertain = evaluateEightPointPresence(revision, alignment, rois.map((roi, index) =>
  index === 1 ? result(roi, 'ABSENT', 'FAIL')
    : index === 4 ? { ...result(roi), evidence: 'UNCERTAIN', status: 'WARNING', isWithinTolerance: false }
      : result(roi)));
assert.equal(ngPlusUncertain.judgement, 'NG', 'confirmed missing screw takes precedence over uncertainty');

const failedAlignment = evaluateEightPointPresence(revision, { success: false, errorMessage: 'Anchor missing' }, []);
assert.equal(failedAlignment.judgement, 'INVALID');
assert.equal(failedAlignment.uncertainCount, 8);

console.log(JSON.stringify({ passed: 12, scenarios: ['all-ok', 'missing-P1', 'missing-P6', 'missing-P7', 'missing-P8', 'uncertain', 'NG-plus-uncertain', 'alignment-failed'] }));
