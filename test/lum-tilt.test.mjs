import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitSkyPlane, lumTiltVerdict, mtf, autoStretchParams } from '../agents/ops/stats.mjs';

const grid = (f) => { const c = []; for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 12; gx++) { const u = (gx + 0.5) / 12 - 0.5, w = (gy + 0.5) / 8 - 0.5; c.push({ u, w, v: f(u, w) }); } return c; };

test('fitSkyPlane recovers a tilt and rejects a bright subject', () => {
  const sky = 0.0025, b = -2e-5, c = -2.4e-5;
  const cells = grid((u, w) => sky + b * u + c * w + ((Math.hypot(u, w) < 0.12) ? 0.002 : 0));
  const f = fitSkyPlane(cells);
  assert.ok(Math.abs(f.b - b) < 1e-6 && Math.abs(f.c - c) < 1e-6, JSON.stringify(f));
  assert.ok(f.rejected >= 2);
});

test('M74 L: 1.8 % of sky linear tilt is VISIBLE once stretched; the old corner stddev called it flat', () => {
  const f = fitSkyPlane(grid((u, w) => 0.00248 - 2e-5 * u - 2.4e-5 * w));
  const v = lumTiltVerdict(f, 0.002484, 3.27e-5);
  assert.equal(v.verdict, 'VISIBLE TILT');
  assert.ok(v.ppStretched > 0.03 && v.ppStretched < 0.06, String(v.ppStretched));
});

test('a flat sky is FLAT and the stretch maps the sky to ~0.10', () => {
  const f = fitSkyPlane(grid(() => 0.0025));
  assert.equal(lumTiltVerdict(f, 0.0025, 3e-5).verdict, 'FLAT');
  const { c0, m } = autoStretchParams(0.0025, 3e-5);
  assert.ok(Math.abs(mtf(m, (0.0025 - c0) / (1 - c0)) - 0.10) < 1e-6);
});
