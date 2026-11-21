import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as engine from '../src/vision/eightPointPresenceEngine.ts';
import { compareDescriptors, confirmsEightPointAbsence, describePatch } from '../src/vision/roiFeatureCore.js';

const slotCenters = [
  [0.18, 0.25], [0.39, 0.25], [0.61, 0.25], [0.82, 0.25],
  [0.39, 0.52], [0.61, 0.52],
  [0.39, 0.78], [0.61, 0.78],
];
const rois = slotCenters.map(([x, y], index) => ({
  id: `P${index + 1}`,
  name: `Screw ${index + 1}`,
  objectType: 'screw',
  x,
  y,
  radius: 0.035,
  width: 0.07,
  height: 0.07,
  isRequired: true,
  expectedObjectPresence: true,
}));

assert.equal(engine.isEightPointPresenceCandidate(rois, 'EIGHT_POINT_PRESENCE'), true,
  'explicit eight-point profile must activate the dedicated engine');
assert.equal(engine.isEightPointPresenceCandidate(rois.slice(1), 'EIGHT_POINT_PRESENCE'), true,
  'an incomplete explicit eight-point profile must remain in fail-safe mode');
assert.ok(engine.validateEightPointPresenceLayout(rois.slice(1), 'EIGHT_POINT_PRESENCE').length > 0,
  'a missing screw ROI must invalidate the explicit eight-point profile instead of falling back to standard ROI mode');
assert.equal(engine.isEightPointPresenceCandidate(rois, 'STANDARD'), false,
  'an explicitly standard profile must not be auto-promoted by having eight screw ROIs');

const roiInspectorSource = readFileSync(new URL('../src/vision/roiInspector.ts', import.meta.url), 'utf8');
const pipelineSource = readFileSync(new URL('../src/hooks/useInspectionPipeline.ts', import.meta.url), 'utf8');
assert.match(roiInspectorSource, /isEightPointPresenceCandidate\(rois,\s*inspectionProfile\)/,
  'ROI inspection must use the explicit Master profile instead of auto-detecting eight screw ROIs');
assert.match(pipelineSource, /candidateFrame,\s*revision\.inspectionProfile/,
  'the live pipeline must pass the selected Master inspection profile to ROI inspection');

function resultFor(roi, evidence) {
  return {
    roiId: roi.id,
    roiName: roi.name,
    objectType: 'screw',
    masterPosition: { x: roi.x, y: roi.y },
    expectedTransformedPosition: { x: roi.x, y: roi.y },
    actualDetectedPosition: evidence === 'PRESENT' ? { x: roi.x, y: roi.y } : null,
    positionOffsetPx: null,
    positionOffsetMm: null,
    isWithinTolerance: evidence === 'PRESENT',
    confidence: evidence === 'UNCERTAIN' ? 0.3 : 0.9,
    isPresent: evidence === 'PRESENT',
    evidence,
    status: evidence === 'PRESENT' ? 'PASS' : evidence === 'ABSENT' ? 'FAIL' : 'WARNING',
  };
}

assert.equal(engine.validateEightPointReferenceImages([
  { id: 'ok', label: 'OK', kind: 'OK', imageUrl: 'data:image/png;base64,ok' },
  { id: 'ng', label: 'NG empty slot', kind: 'NG', imageUrl: 'data:image/png;base64,ng' },
]), true, 'both positive screw and validated empty-slot references are required');
assert.equal(engine.validateEightPointReferenceImages([
  { id: 'ok', label: 'OK', kind: 'OK', imageUrl: 'data:image/png;base64,ok' },
  { id: 'ng', label: 'NG empty slot', kind: 'NG', imageUrl: '' },
]), false, 'a blank NG reference must block the Master');
assert.equal(engine.validateEightPointReferenceImages([
  { id: 'ng', label: 'NG', kind: 'NG', imageUrl: 'data:image/png;base64,ng' },
]), false, 'an NG-only reference set cannot replace the positive screw Master');
assert.equal(engine.validateEightPointReferenceImages([
  { id: 'ok', label: 'OK', kind: 'OK', imageUrl: '' },
  { id: 'ng', label: 'NG', kind: 'NG', imageUrl: 'data:image/png;base64,ng' },
]), false, 'an empty OK reference must block the Master');

const emptyPatch = new Float32Array(64 * 64).fill(80);
const screwPatch = new Float32Array(64 * 64).fill(80);
for (let y = 20; y < 44; y++) {
  for (let x = 27; x < 37; x++) screwPatch[y * 64 + x] = 225;
}
const emptyFeatures = describePatch(emptyPatch, 64, 'contrast');
const screwFeatures = describePatch(screwPatch, 64, 'contrast');
assert.equal(emptyFeatures.present, false, 'a flat empty slot must not create a foreground object');
assert.equal(screwFeatures.present, true, 'a clear screw-like foreground must be detected');
const emptyVsPositiveScrew = compareDescriptors(emptyFeatures, screwFeatures);
assert.equal(confirmsEightPointAbsence(
  emptyFeatures.present,
  emptyFeatures.presenceConfidence,
  screwFeatures.present,
  emptyVsPositiveScrew
), true, 'actual empty and positive screw patch descriptors must confirm a missing screw');

assert.equal(confirmsEightPointAbsence(false, 0.82, true, 0.05), true,
  'a clear empty slot that strongly differs from the positive screw shape must confirm absence');
assert.equal(confirmsEightPointAbsence(false, 0.35, true, 0.05), false,
  'weak/blurred empty-slot evidence must remain uncertain');
assert.equal(confirmsEightPointAbsence(false, 0.82, false, 0.05), false,
  'absence cannot be confirmed from an invalid positive reference');
assert.equal(confirmsEightPointAbsence(false, 0.82, true, 0.7), false,
  'a live patch still similar to the positive screw reference must not be called missing');

assert.equal(engine.isEightPointPresenceCandidate(rois), true);
assert.deepEqual(engine.validateEightPointPresenceLayout(rois), []);

const allPresent = engine.evaluateEightPointPresence(rois, rois.map((roi) => resultFor(roi, 'PRESENT')));
assert.equal(allPresent.judgement, 'OK');
assert.equal(allPresent.detectedCount, 8);
assert.equal(allPresent.missingCount, 0);
assert.deepEqual(allPresent.points.map((point) => point.pointId), ['P1','P2','P3','P4','P5','P6','P7','P8']);

const reversed = engine.evaluateEightPointPresence([...rois].reverse(), [...rois].reverse().map((roi) => resultFor(roi, 'PRESENT')));
assert.equal(reversed.points[0].roiId, 'P1', 'slot identity must follow Master geometry, not array order');
assert.equal(reversed.points[0].pointId, 'P1');

const invalidRowPattern = rois.map((roi, index) => ({
  ...roi,
  y: index < 4 ? 0.2 : 0.5,
  x: 0.1 + (index % 4) * 0.2,
}));
assert.ok(
  engine.validateEightPointPresenceLayout(invalidRowPattern).some((message) => message.includes('4-2-2')),
  'Master layout must preserve the specified 4-2-2 point arrangement'
);

const oneMissing = engine.evaluateEightPointPresence(rois, rois.map((roi, index) =>
  resultFor(roi, index === 0 ? 'ABSENT' : 'PRESENT')
));
assert.equal(oneMissing.judgement, 'NG');
assert.equal(oneMissing.detectedCount, 7);
assert.equal(oneMissing.missingCount, 1);
assert.equal(oneMissing.points[0].status, 'NG');

const unapprovedForeground = engine.evaluateEightPointPresence(rois, rois.map((roi, index) => {
  const result = resultFor(roi, 'PRESENT');
  return index === 3 ? { ...result, status: 'WARNING', isWithinTolerance: false } : result;
}));
assert.equal(unapprovedForeground.judgement, 'INVALID', 'foreground without a passing screw match must not count as OK');
assert.equal(unapprovedForeground.detectedCount, 7);
assert.equal(unapprovedForeground.uncertainCount, 1);

const uncertainOnly = engine.evaluateEightPointPresence(rois, rois.map((roi, index) =>
  resultFor(roi, index === 5 ? 'UNCERTAIN' : 'PRESENT')
));
assert.equal(uncertainOnly.judgement, 'INVALID');
assert.equal(uncertainOnly.uncertainCount, 1);

const missingAndUncertain = engine.evaluateEightPointPresence(rois, rois.map((roi, index) =>
  resultFor(roi, index === 0 ? 'ABSENT' : index === 1 ? 'UNCERTAIN' : 'PRESENT')
));
assert.equal(missingAndUncertain.judgement, 'NG', 'confirmed missing screw takes precedence over another uncertain slot');

const overlapping = rois.map((roi) => ({ ...roi }));
overlapping[1] = { ...overlapping[1], x: overlapping[0].x + 0.02 };
assert.ok(
  engine.validateEightPointPresenceLayout(overlapping).some((message) => message.includes('overlap')),
  'overlapping slots must be rejected so one screw cannot satisfy two points'
);

const duplicateIds = rois.map((roi) => ({ ...roi }));
duplicateIds[7] = { ...duplicateIds[7], id: duplicateIds[0].id };
assert.ok(engine.validateEightPointPresenceLayout(duplicateIds).some((message) => message.includes('unique')));

console.log('Eight-point presence audit passed: 8/8 OK, single missing NG, uncertainty INVALID, NG precedence, and slot integrity.');
