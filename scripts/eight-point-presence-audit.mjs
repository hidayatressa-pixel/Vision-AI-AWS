import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Load the actual TypeScript engine in Node 22 without adding a test-runner dependency.
const source = await readFile(new URL('../src/vision/eightPointPresenceEngine.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const engine = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const slotCenters = [
  [0.15, 0.18], [0.38, 0.18], [0.62, 0.18], [0.85, 0.18],
  [0.42, 0.49], [0.62, 0.49],
  [0.42, 0.80], [0.62, 0.80],
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

assert.equal(engine.isEightPointPresenceCandidate(rois), true);
assert.deepEqual(engine.validateEightPointPresenceLayout(rois), []);

const allPresent = engine.evaluateEightPointPresence(rois, rois.map((roi) => resultFor(roi, 'PRESENT')));
assert.equal(allPresent.judgement, 'OK');
assert.equal(allPresent.detectedCount, 8);
assert.equal(allPresent.missingCount, 0);

const oneMissing = engine.evaluateEightPointPresence(rois, rois.map((roi, index) =>
  resultFor(roi, index === 0 ? 'ABSENT' : 'PRESENT')
));
assert.equal(oneMissing.judgement, 'NG');
assert.equal(oneMissing.detectedCount, 7);
assert.equal(oneMissing.missingCount, 1);
assert.equal(oneMissing.points[0].status, 'NG');

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
