import assert from 'node:assert/strict';
import { applyEightPointPresence } from '../src/vision/eightPointPresenceEngine.js';
import { describePatch, compareDescriptors, confirmsMissingObject, contourWithinTolerance, rectifyPatch } from '../src/vision/roiFeatureCore.js';

const SIZE = 64;
function makeBolt({ background = 150, object = 35, centerX = 32, centerY = 32, radius = 12, shaft = true } = {}) {
  const data = new Float32Array(SIZE * SIZE).fill(background);
  const points = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const dx = x - centerX, dy = y - centerY;
    // A simple six-sided bolt head with a short shank, representative synthetic silhouette.
    const insideHex = Math.abs(dx) <= radius &&
      Math.abs(dy) <= radius * 0.9 &&
      Math.abs(dx) * 0.45 + Math.abs(dy) * 0.65 <= radius * 0.95;
    const insideShaft = shaft && Math.abs(dx) <= radius * 0.24 &&
      dy > radius * 0.45 && dy <= radius * 1.45;
    if (insideHex || insideShaft) data[y * SIZE + x] = object;
  }
  return data;
}

const ok = describePatch(makeBolt(), SIZE, 'contrast');
const sameDifferentLight = describePatch(makeBolt({ background: 190, object: 75 }), SIZE, 'contrast');
const missing = describePatch(new Float32Array(SIZE * SIZE).fill(150), SIZE, 'contrast');
const shifted = describePatch(makeBolt({ centerX: 43, centerY: 32 }), SIZE, 'contrast');
const wrongSize = describePatch(makeBolt({ radius: 7 }), SIZE, 'contrast');
const roundObject = new Float32Array(SIZE * SIZE).fill(150);
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  if ((x - 32) ** 2 + (y - 32) ** 2 <= 13 ** 2) roundObject[y * SIZE + x] = 35;
}
const wrongShape = describePatch(roundObject, SIZE, 'contrast');

assert.equal(ok.present, true, 'bolt reference should be detected');
assert.equal(missing.present, false, 'uniform missing-object crop should be absent');
assert.ok(compareDescriptors(ok, sameDifferentLight) > 0.85, 'same bolt should remain similar under brightness shift');
assert.ok(compareDescriptors(ok, missing) < 0.2, 'missing bolt must not match the OK bolt');
assert.equal(confirmsMissingObject(false, 0.05, 0.98, 0.75, 0.06), true, 'missing bolt should be NG when a matching labelled missing-object reference exists');
assert.equal(confirmsMissingObject(false, 0.05, 0.20, 0.75, 0.06), false, 'weak absence evidence must remain uncertain');
assert.equal(confirmsMissingObject(true, 0.90, 0.98, 0.75, 0.06), false, 'a present object must never be labelled missing');
assert.ok(compareDescriptors(ok, shifted) < compareDescriptors(ok, sameDifferentLight), 'position shift must reduce feature similarity');
assert.ok(compareDescriptors(ok, wrongSize) < compareDescriptors(ok, sameDifferentLight), 'size change must reduce feature similarity');
const contourScore = compareDescriptors(ok, wrongShape);
assert.equal(contourWithinTolerance(ok, sameDifferentLight, 0.10), true, 'brightness variation should preserve contour geometry');
assert.equal(contourWithinTolerance(ok, wrongShape, 0.10), false, 'round object contour must fail the bolt contour tolerance');
assert.ok(Math.abs(wrongSize.areaRatio - ok.areaRatio) / ok.areaRatio > 0.35, 'size change must exceed the configured default size tolerance');

// Forward-warp a reference crop into a shifted and rotated camera frame,
// then verify that inverse rectification reconstructs the canonical ROI.
const angle = 17 * Math.PI / 180;
const cos = Math.cos(angle), sin = Math.sin(angle);
const frameWidth = 128, frameHeight = 128, centerX = 69, centerY = 61;
const transformedFrame = new Float32Array(frameWidth * frameHeight).fill(150);
const canonical = makeBolt();
for (let y = 0; y < frameHeight; y++) for (let x = 0; x < frameWidth; x++) {
  const dx = x - centerX, dy = y - centerY;
  const sourceX = cos * dx + sin * dy + SIZE / 2;
  const sourceY = -sin * dx + cos * dy + SIZE / 2;
  if (sourceX >= 0 && sourceY >= 0 && sourceX < SIZE && sourceY < SIZE) {
    const ix = Math.min(SIZE - 1, Math.max(0, Math.round(sourceX)));
    const iy = Math.min(SIZE - 1, Math.max(0, Math.round(sourceY)));
    transformedFrame[y * frameWidth + x] = canonical[iy * SIZE + ix];
  }
}
const rectified = rectifyPatch(transformedFrame, frameWidth, frameHeight, centerX, centerY, SIZE, SIZE, cos, sin, SIZE);
assert.ok(rectified, 'rotated ROI should remain inside the frame');
const rectifiedDescriptor = describePatch(rectified, SIZE, 'contrast');
const rectifiedScore = compareDescriptors(ok, rectifiedDescriptor);
assert.ok(rectifiedScore > 0.9, 'rotation and translation rectification should preserve object features');

const bright = describePatch(makeBolt({ background: 35, object: 190 }), SIZE, 'bright_on_dark');
assert.equal(bright.present, true, 'bright-on-dark polarity should detect a bright bolt');
const dark = describePatch(makeBolt(), SIZE, 'dark_on_bright');
assert.equal(dark.present, true, 'dark-on-bright polarity should detect a dark bolt');


const eightPointPositions = [
  [0.1, 0.2], [0.3, 0.2], [0.6, 0.2], [0.8, 0.2],
  [0.4, 0.45], [0.6, 0.45],
  [0.4, 0.7], [0.6, 0.7],
];
const eightRois = eightPointPositions.map(([x, y], index) => ({
  id: `slot-${index + 1}`,
  name: `Bolt ${index + 1}`,
  objectType: 'screw',
  x,
  y,
  radius: 0.04,
  width: 0.08,
  height: 0.08,
  toleranceRadius: 0.05,
  isRequired: true,
  expectedObjectPresence: true,
}));
const eightResults = eightRois.map((roi, index) => ({
  roiId: roi.id,
  roiName: roi.name,
  objectType: 'screw',
  masterPosition: { x: roi.x, y: roi.y },
  expectedTransformedPosition: { x: roi.x, y: roi.y },
  actualDetectedPosition: { x: roi.x, y: roi.y },
  positionOffsetPx: 0,
  positionOffsetMm: null,
  isWithinTolerance: true,
  confidence: 0.96,
  isPresent: true,
  evidence: 'PRESENT',
  status: 'PASS',
}));
const allEight = applyEightPointPresence(eightRois, eightResults, 800, 600);
assert.equal(allEight.enabled, true, 'eight required screw ROIs should activate the point engine');
assert.equal(allEight.detectedCount, 8, 'all eight slots should be counted independently');
const shuffledEight = applyEightPointPresence([...eightRois].reverse(), [...eightResults].reverse(), 800, 600);
assert.equal(shuffledEight.roiResults[0].roiId, 'slot-1', 'slot IDs must follow Master top-to-bottom, left-to-right layout rather than array order');
assert.deepEqual(allEight.roiResults.map((item) => item.inspectionPointId), ['P1','P2','P3','P4','P5','P6','P7','P8']);
const oneMissing = applyEightPointPresence(eightRois, eightResults.map((item, index) => index === 5
  ? { ...item, actualDetectedPosition: null, isPresent: false, evidence: 'ABSENT', status: 'FAIL', isWithinTolerance: false }
  : item), 800, 600);
assert.equal(oneMissing.missingCount, 1, 'one confirmed absent bolt should be assigned to its own slot');
assert.equal(oneMissing.roiResults[5].inspectionPointId, 'P6');
const oneUncertain = applyEightPointPresence(eightRois, eightResults.map((item, index) => index === 2
  ? { ...item, evidence: 'UNCERTAIN', status: 'WARNING', isWithinTolerance: false }
  : item), 800, 600);
assert.equal(oneUncertain.uncertainCount, 1, 'uncertain evidence must remain unresolved');
const duplicate = applyEightPointPresence(eightRois, eightResults.map((item, index) => index === 1
  ? { ...item, actualDetectedPosition: { ...eightResults[0].actualDetectedPosition } }
  : item), 800, 600);
assert.equal(duplicate.uncertainCount, 2, 'one detected centroid cannot satisfy two distant slots');
assert.equal(duplicate.roiResults[0].evidence, 'UNCERTAIN');
assert.equal(duplicate.roiResults[1].evidence, 'UNCERTAIN');
assert.equal(applyEightPointPresence(eightRois.slice(0, 7), eightResults.slice(0, 7), 800, 600).enabled, false,
  'legacy Masters with a non-eight-point ROI count must remain unchanged');

console.log(JSON.stringify({
  passed: 24,
  scores: {
    brightnessInvariant: compareDescriptors(ok, sameDifferentLight),
    missingObject: compareDescriptors(ok, missing),
    shifted: compareDescriptors(ok, shifted),
    wrongSize: compareDescriptors(ok, wrongSize),
    wrongContour: contourScore,
    rectifiedTransform: rectifiedScore,
  },
}));
