import test from 'node:test';
import assert from 'node:assert/strict';
import { stratifiedIndices, isStarWindow, blockSobelEnergy, evaluateDetailGain } from '../agents/ops/subject-metrics.mjs';

test('stratifiedIndices covers the whole block list and caps at max', () => {
  const idx = stratifiedIndices(1000, 50);
  assert.equal(idx.length, 50);
  assert.ok(idx[0] < 20 && idx[49] > 980, 'spans start to end');
  assert.equal(new Set(idx).size, 50);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1]);
  assert.deepEqual(stratifiedIndices(7, 50), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(stratifiedIndices(0, 50), []);
});

test('star windows are rejected', () => {
  assert.equal(isStarWindow(0.5, 0.1), true);   // > median + 0.25
  assert.equal(isStarWindow(0.9, 0.8), true);   // > 0.85
  assert.equal(isStarWindow(0.3, 0.2), false);
});

test('blockSobelEnergy skips a star and keeps clean texture', () => {
  const flat = () => 0.2;
  assert.ok(blockSobelEnergy(flat, 0, 0, 32, 4, 0.2).e < 1e-12);
  // star at centre of the block
  const star = (x, y) => (Math.abs(x - 16) <= 1 && Math.abs(y - 16) <= 1 ? 0.95 : 0.2);
  const r = blockSobelEnergy(star, 0, 0, 32, 4, 0.2);
  assert.ok(r.skipped > 0);
  assert.ok(r.e < 1e-12, 'star edge energy excluded');
  // gentle texture is retained
  const tex = (x, y) => 0.2 + 0.02 * Math.sin(x / 2);
  const t = blockSobelEnergy(tex, 0, 0, 32, 4, 0.2);
  assert.ok(t.e > 0 && t.skipped === 0 && !t.starDominated);
  // mostly-star block is flagged
  const allStar = () => 0.9;
  assert.equal(blockSobelEnergy(allStar, 0, 0, 32, 4, 0.2).starDominated, true);
});

test('evaluateDetailGain: ratio vs max baseline, advisory message', () => {
  const profile = { detail: { max_gain: 1.6, _calibration: 'PROVISIONAL' } };
  const base = { rgb: { weber: 1 }, l: { weber: 2 }, max: { weber: 2 } };
  const ok = evaluateDetailGain({ weber: 2.56 }, base, true, profile);
  assert.ok(Math.abs(ok.gain - 1.28) < 1e-9); assert.equal(ok.exceeded, false);
  const bad = evaluateDetailGain({ weber: 4 }, base, true, profile);
  assert.equal(bad.exceeded, true); assert.ok(bad.message.includes('max_gain'));
  const rgbOnly = evaluateDetailGain({ weber: 1.2 }, base, false, profile);
  assert.ok(Math.abs(rgbOnly.gain - 1.2) < 1e-9);
  assert.equal(evaluateDetailGain({ weber: 1, noiseDominated: true }, null, false, profile).noiseDominated, true);
});
