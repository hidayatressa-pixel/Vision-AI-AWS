import assert from 'node:assert/strict';
import { describePatch, compareDescriptors, rectifyPatch } from '../src/vision/roiFeatureCore.js';

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
assert.ok(compareDescriptors(ok, shifted) < compareDescriptors(ok, sameDifferentLight), 'position shift must reduce feature similarity');
assert.ok(compareDescriptors(ok, wrongSize) < compareDescriptors(ok, sameDifferentLight), 'size change must reduce feature similarity');
const contourScore = compareDescriptors(ok, wrongShape);
console.log('CONTOUR_DIAGNOSTIC', JSON.stringify({ score: contourScore, ok: { area: ok.areaRatio, aspect: ok.aspectRatio, circularity: ok.circularity, solidity: ok.solidity }, wrong: { area: wrongShape.areaRatio, aspect: wrongShape.aspectRatio, circularity: wrongShape.circularity, solidity: wrongShape.solidity } }));
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

console.log(JSON.stringify({
  passed: 12,
  scores: {
    brightnessInvariant: compareDescriptors(ok, sameDifferentLight),
    missingObject: compareDescriptors(ok, missing),
    shifted: compareDescriptors(ok, shifted),
    wrongSize: compareDescriptors(ok, wrongSize),
    wrongContour: contourScore,
    rectifiedTransform: rectifiedScore,
  },
}));
