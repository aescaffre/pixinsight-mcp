import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeInventory, inventoryZones, zoneIndices } from '../agents/ops/subject-metrics.mjs';

const ann = (spreads) => spreads.map((s, k) => ({ r0: k * 25, r1: k * 25 + 25, n: 5000, p10: 0.2, p50: 0.2 + s / 2, p90: 0.2 + s }));

test('detection radius follows arm structure above the sky texture, not the annulus level', () => {
  // noise 0.002, sky texture 0.014: structure (spread-0.014)/0.002 >= 3 needs spread >= 0.020
  const a = ann([0.1, 0.08, 0.05, 0.03, 0.021, 0.015, 0.014, 0.025, 0.014, 0.014]);
  const r = summarizeInventory(a, 0.2, 0.002, { skySpread: 0.014 });
  assert.equal(r.rDet, 125);   // index 4 passes; 5,6 fail -> stop before the isolated bump at 7
});

test('one gap is bridged', () => {
  const a = ann([0.1, 0.05, 0.015, 0.03, 0.014, 0.014, 0.014]);
  assert.equal(summarizeInventory(a, 0.2, 0.002, { skySpread: 0.014 }).rDet, 100);
});

test('zones scale with the detection radius', () => {
  assert.deepEqual(inventoryZones(750), { core: [0, 60], disc: [263, 413], outer: [600, 750], sky: [900, 1000] });
});

test('zone indices: core/disc index and outer net contrast', () => {
  const z = zoneIndices([{ n: 9, p10: 0, p50: 0.5, p90: 0 }, { n: 9, p10: 0, p50: 0.2, p90: 0 }, { n: 9, p10: 0.09, p50: 0.1, p90: 0.15 }, { n: 9, p10: 0.095, p50: 0.1, p90: 0.105 }]);
  assert.equal(+z.coreIdx.toFixed(3), 4);
  assert.equal(+z.outerNet.toFixed(3), 0.05);
  assert.equal(zoneIndices([{ n: 0 }, { n: 1 }, { n: 1 }, { n: 0 }]).coreIdx, null);
});

import { compareEnvelopeSectors } from '../agents/ops/subject-metrics.mjs';
test('envelope: a sector the data fills but the final drops to sky is flagged (M74 v6)', () => {
  const prep = [9.3, 7.8, 12.6, 12.5, 7.3, 14.9, 11.4, 6.8].map(v => v / 1000);
  const v6 = [30.1, 19.9, 38.4, 28.7, 0.1, 38.2, 46.1, 15.7].map(v => v / 1000);
  const c = compareEnvelopeSectors(v6, prep);
  assert.equal(c.evaluated, true); assert.equal(c.worst.sector, 4); assert.ok(c.worst.ratio < 0.05);
});
test('envelope: not evaluated when the outer glow was not lifted (M74 v3)', () => {
  const prep = [9.3, 7.8, 12.6, 12.5, 7.3, 14.9, 11.4, 6.8].map(v => v / 1000);
  assert.equal(compareEnvelopeSectors([2.4, 1.1, 2.1, 2.6, 0.4, 1.4, 2, 1.1].map(v => v / 1000), prep).evaluated, false);
});
test('envelope: a uniformly lifted glow passes', () => {
  const prep = [9, 8, 12, 12, 7, 15, 11, 7].map(v => v / 1000);
  const c = compareEnvelopeSectors(prep.map(v => v * 3), prep);
  assert.ok(Math.abs(c.worst.ratio - 1) < 1e-9);
});

import { edgeSteepening } from '../agents/ops/subject-metrics.mjs';
test('edgeSteepening: a steady exponential fade is ~1, a plateau ending in a cliff is >> 2.5', () => {
  const rDet = 775, r0 = 310, bin = 15, nb = Math.ceil((rDet + 450 - r0) / bin);
  const mk = (f) => ({ r0, bin, profiles: Array.from({ length: 8 }, () => Array.from({ length: nb }, (_, k) => 0.08 + f((r0 + bin * (k + 0.5)) / rDet))) });
  const expo = edgeSteepening(mk(r => 0.3 * Math.exp(-6 * (r - 0.6))), rDet);
  assert.ok(expo.evaluated && Math.abs(expo.steepening - 1) < 0.15, JSON.stringify(expo));
  const cliff = edgeSteepening(mk(r => r < 0.95 ? 0.3 * Math.exp(-2.5 * (r - 0.6)) : 0.3 * Math.exp(-2.5 * 0.35) * Math.exp(-40 * (r - 0.95))), rDet);
  assert.ok(cliff.evaluated && cliff.steepening > 2.5, JSON.stringify(cliff));
});
