import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShapeMaskPjsr, rangeExpr, maskFlag, shapeMask } from '../agents/ops/masks.mjs';
import { buildZoneMasksPjsr } from '../agents/ops/narrowband-enhance.mjs';

const FULL = { maskId: 'M', outputId: 'O', invert: true, dilatePx: 8, blurSigma: 20, clipLow: 0.1, clipHigh: 0.9, gamma: 0.7, multiplyWith: 'X' };

test('shapeMask PJSR applies ops in order invert > dilate > blur > range > gamma > multiply', () => {
  const s = buildShapeMaskPjsr(FULL);
  const idx = ['1-$T', 'Dilation', 'Convolution', 'max(0,min(1,($T-0.1)/(0.9-0.1)))', 'exp(0.7*ln(max($T,1e-6)))', '$T*X[0]'].map(k => s.indexOf(k));
  assert.ok(idx.every(i => i >= 0), 'all ops present: ' + idx);
  assert.deepEqual([...idx].sort((a, b) => a - b), idx);
});

test('shapeMask PJSR never sets structureWayTable, uses structureSize 3 and iterations=px', () => {
  const s = buildShapeMaskPjsr({ maskId: 'M', dilatePx: 8, erodePx: 2 });
  assert.ok(!/structureWayTable/.test(s));
  assert.match(s, /structureSize = 3/);
  assert.match(s, /Dilation; MT\.structureSize = 3; MT\.numberOfIterations = 8/);
  assert.match(s, /Erosion; MT\.structureSize = 3; MT\.numberOfIterations = 2/);
});

test('shapeMask PJSR is ES5-parseable, closes on error, and has no template literals', () => {
  const s = buildShapeMaskPjsr(FULL);
  new Function(s);
  assert.ok(!s.includes('`'));
  assert.match(s, /catch \(e\)/);
  assert.match(s, /geometry mismatch/);
});

test('zone mask PJSR parses and uses PixelMath, not a per-pixel setSample loop', () => {
  const z = buildZoneMasksPjsr('V', { coreClip: 0.4, shellClip: 0.15, haloClip: 0.04, sigma: { core: 8, shell: 12, halo: 20 } });
  new Function(z);
  assert.ok(!/setSample/.test(z));
  assert.match(z, /PixelMath/);
});

test('helpers', async () => {
  assert.equal(rangeExpr(0.1, 0.9), 'max(0,min(1,($T-0.1)/(0.9-0.1)))');
  assert.equal(maskFlag(0.005), 'EMPTY');
  assert.equal(maskFlag(0.97), 'FULL');
  assert.equal(maskFlag(0.3), '');
  await assert.rejects(() => shapeMask({ pjsr: async () => ({}) }, { maskId: 'M', clipLow: 0.5, clipHigh: 0.2 }), /clip_high/);
});
