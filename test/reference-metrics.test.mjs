import test from 'node:test';
import assert from 'node:assert/strict';
import { chromaHistAdd, slicedWasserstein, decileCdfDistance } from '../agents/ops/subject-metrics.mjs';

function cloud(shiftA, shiftB) {
  const h = new Array(576).fill(0);
  // bin centres: lo + (i+0.5)*5 ; use a blob of centres around (-2.5..12.5)
  for (let da = -2; da <= 2; da++) for (let db = -2; db <= 2; db++) {
    const w = 6 - Math.abs(da) - Math.abs(db);
    for (let k = 0; k < w; k++) chromaHistAdd(h, 2.5 + da * 5 + shiftA, 2.5 + db * 5 + shiftB, 24, -60, 60);
  }
  return h;
}

test('sliced Wasserstein: identical -> 0', () => {
  assert.equal(slicedWasserstein(cloud(0, 0), cloud(0, 0), 24, -60, 60, 8), 0);
});
test('sliced Wasserstein: shift 20 -> ~20 (x, y and diagonal 45deg)', () => {
  assert.ok(Math.abs(slicedWasserstein(cloud(0, 0), cloud(20, 0), 24, -60, 60, 8) - 20) < 0.5);
  assert.ok(Math.abs(slicedWasserstein(cloud(0, 0), cloud(0, 20), 24, -60, 60, 8) - 20) < 0.5);
  const d = slicedWasserstein(cloud(0, 0), cloud(20, 20), 24, -60, 60, 8);
  assert.ok(Math.abs(d - 20 * Math.SQRT2) < 1.0, String(d));
});
test('sliced Wasserstein: empty -> null', () => {
  assert.equal(slicedWasserstein(new Array(576).fill(0), cloud(0, 0), 24, -60, 60, 8), null);
});
test('decileCdfDistance', () => {
  const a = Array.from({ length: 100 }, (_, i) => i / 100);
  assert.equal(decileCdfDistance(a, a), 0);
  assert.ok(Math.abs(decileCdfDistance(a, a.map(v => v + 0.1)) - 0.1) < 1e-9);
  assert.equal(decileCdfDistance([], a), null);
});
