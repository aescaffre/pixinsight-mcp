import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildStarFieldPjsr, summarizeStarField } from '../agents/ops/quality-gates.mjs';

// Stub image: sample(x,y,c) from a function; evaluates the ES5 PJSR in a vm context.
function run(W, H, fn, opts = {}) {
  const img = {
    width: W, height: H, isColor: false,
    sample: (x, y) => fn(x, y),
    median: () => 0.05, MAD: () => 0.002
  };
  const ctx = { ImageWindow: { windowById: () => ({ isNull: false, mainView: { image: img } }) } };
  const out = vm.runInNewContext(buildStarFieldPjsr('v', opts), ctx);
  return JSON.parse(out);
}
const gauss = (cx, cy, fwhm, amp) => (x, y) => amp * Math.exp(-4 * Math.LN2 * ((x - cx) ** 2 + (y - cy) ** 2) / (fwhm * fwhm));

test('builder is ES5-parsable (no template literals/let/const/arrows in PJSR)', () => {
  const code = buildStarFieldPjsr('v', {});
  assert.doesNotMatch(code, /\blet\b|\bconst\b|=>|`/);
  new vm.Script(code);
});
test('bloated Gaussian star FWHM 24 is measured (not dropped)', () => {
  const g = gauss(500, 500, 24, 0.6);
  const d = run(1000, 1000, (x, y) => 0.05 + g(x, y));
  assert.equal(d.starsMeasured, 1);
  assert.ok(Math.abs(d.medianFWHM - 24) < 3, 'fwhm ' + d.medianFWHM);
  assert.ok(d.prominenceAbs > 0.5);
});
test('small star FWHM 6 on lifted background, ellipticity ~0', () => {
  const g = gauss(300, 300, 6, 0.4);
  const d = run(1000, 1000, (x, y) => 0.3 + g(x, y));
  assert.equal(d.starsMeasured, 1);
  assert.ok(Math.abs(d.medianFWHM - 6) < 1.5, 'fwhm ' + d.medianFWHM);
  assert.ok(d.medianEllipticity < 0.1);
});
test('elongated star has ellipticity', () => {
  const d = run(1000, 1000, (x, y) => 0.05 + 0.5 * Math.exp(-4 * Math.LN2 * (((x - 400) / 12) ** 2 + ((y - 400) / 5) ** 2)));
  assert.ok(d.ellipticityCount === 1 && d.medianEllipticity > 0.3, JSON.stringify(d.medianEllipticity));
});
test('broad nebula knot is rejected', () => {
  const g = gauss(400, 400, 200, 0.4);
  const d = run(1000, 1000, (x, y) => 0.05 + g(x, y) + 0.0);
  assert.equal(d.starsMeasured, 0);
});
test('known peaks are re-measured; centre/edge split', () => {
  const g1 = gauss(500, 500, 6, 0.4), g2 = gauss(30, 30, 6, 0.4);
  const d = run(1000, 1000, (x, y) => 0.05 + g1(x, y) + g2(x, y), { peaks: [{ x: 500, y: 500 }, { x: 31, y: 29 }] });
  assert.equal(d.centerCount, 1);
  assert.equal(d.edgeCount, 1);
  assert.equal(d.compactPeaks.length, 2);
});
test('summarize flags advisories only', () => {
  const s = summarizeStarField({ centerCount: 10, centerFWHM: 10, ellipticityCount: 10, centerEllipticity: 0.3, starsMeasured: 20, medianDarkRing: 0.08, rejected: {} });
  assert.equal(s.advisories.length, 3);
  assert.match(s.text, /ADVISORY/);
});
