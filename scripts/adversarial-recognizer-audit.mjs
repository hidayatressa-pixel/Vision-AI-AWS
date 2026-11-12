import assert from 'node:assert/strict';
import { describePatch, compareDescriptors } from '../src/vision/roiFeatureCore.mjs';

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
const wrongShape = describePatch(makeBolt({ shaft: false }), SIZE, 'contrast');

assert.equal(ok.present, true, 'bolt reference should be detected');
assert.equal(missing.present, false, 'uniform missing-object crop should be absent');
assert.ok(compareDescriptors(ok, sameDifferentLight) > 0.85, 'same bolt should remain similar under brightness shift');
assert.ok(compareDescriptors(ok, missing) < 0.2, 'missing bolt must not match the OK bolt');
assert.ok(compareDescriptors(ok, shifted) < compareDescriptors(ok, sameDifferentLight), 'position shift must reduce feature similarity');
assert.ok(compareDescriptors(ok, wrongSize) < compareDescriptors(ok, sameDifferentLight), 'size change must reduce feature similarity');
assert.ok(compareDescriptors(ok, wrongShape) < compareDescriptors(ok, sameDifferentLight), 'contour change must reduce feature similarity');

const bright = describePatch(makeBolt({ background: 35, object: 190 }), SIZE, 'bright_on_dark');
assert.equal(bright.present, true, 'bright-on-dark polarity should detect a bright bolt');
const dark = describePatch(makeBolt(), SIZE, 'dark_on_bright');
assert.equal(dark.present, true, 'dark-on-bright polarity should detect a dark bolt');

console.log(JSON.stringify({
  passed: 8,
  scores: {
    brightnessInvariant: compareDescriptors(ok, sameDifferentLight),
    missingObject: compareDescriptors(ok, missing),
    shifted: compareDescriptors(ok, shifted),
    wrongSize: compareDescriptors(ok, wrongSize),
    wrongContour: compareDescriptors(ok, wrongShape),
  },
}));
