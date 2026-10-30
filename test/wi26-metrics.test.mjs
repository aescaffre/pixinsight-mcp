import test from 'node:test';
import assert from 'node:assert/strict';
import { bandFromMeans, bandFromCells, cornerStats, measureColorGradient } from '../agents/ops/stats.mjs';
import { madScaled, lapResiduals, summarizeChromaNoise, measureChromaNoise } from '../agents/ops/subject-metrics.mjs';
import { largestGoodRect, summarizePsfField, buildPsfFieldPjsr } from '../agents/ops/quality-gates.mjs';

test('ramp has amp ~0, step has amp ~ step/2-ish and large stepMax', () => {
  const ramp = [0, 1, 2, 3, 4, 5, 6, 7].map(v => v * 0.01);
  const r = bandFromMeans(ramp);
  assert.ok(r.amp < 1e-9, `ramp amp ${r.amp}`);
  const flat = [0, 0, 0, 0, 0, 0, 0, 0];
  flat[0] = 0.05; // band at left edge
  const s = bandFromMeans(flat);
  assert.ok(s.amp > 0.025, `step amp ${s.amp}`);
  const mid = bandFromMeans([0, 0, 0, 0.05, 0, 0, 0, 0]);
  assert.ok(mid.amp > 0.04 && mid.index === 3, `mid band amp ${mid.amp}`);
  assert.equal(s.index, 0);
  assert.ok(Math.abs(s.stepMax - 0.05) < 1e-12);
});

test('bandFromMeans skips null entries and tolerates short input', () => {
  assert.equal(bandFromMeans([null, 1]).index, -1);
  const r = bandFromMeans([0, null, 0, 0, 0.1, 0, 0]);
  assert.equal(r.index, 4);
});

test('bandFromCells finds a green column band and reports insufficientBg', () => {
  const cells = [];
  for (let gy = 0; gy < 6; gy++) for (let gx = 0; gx < 8; gx++) {
    const lum = 0.1; const g = gx === 0 ? 0.12 : 0.1;
    cells.push({ gx, gy, R: 0.1, G: g, B: 0.1, lum: (0.1 + g + 0.1) / 3 });
  }
  const b = bandFromCells(cells, 8, 6, 12);
  assert.equal(b.axis, 'column'); assert.equal(b.index, 0); assert.ok(b.amp > 0.005);
  assert.ok(bandFromCells(cells.slice(0, 5), 8, 6, 12).insufficientBg);
  // pure ramp across columns -> ~0
  const ramp = cells.map(c => ({ ...c, R: 0.1 + 0.002 * c.gx, G: 0.1, B: 0.1 - 0.002 * c.gx, lum: 0.1 }));
  assert.ok(bandFromCells(ramp, 8, 6, 12).amp < 1e-9);
});

test('cornerStats', () => {
  const c = cornerStats({ corners: [0.1, 0.12, 0.1, 0.1], perChannel: [[0.1, 0.1, 0.1], [0.12, 0.12, 0.12], [0.1, 0.1, 0.1], [0.1, 0.1, 0.1]] });
  assert.ok(Math.abs(c.cornerLumDelta - 0.02) < 1e-12);
  assert.ok(c.cornerChroma < 1e-12);
});

test('madScaled / lapResiduals: white noise vs smooth ramp', () => {
  let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const nx = 40, ny = 40, v = [];
  for (let i = 0; i < nx * ny; i++) v.push(rnd() * 0.02);
  assert.ok(madScaled(lapResiduals(v, nx, ny)) > 0.003);
  const ramp = []; for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) ramp.push(0.001 * x + 0.002 * y);
  assert.ok(madScaled(lapResiduals(ramp, nx, ny)) < 1e-12);
  assert.equal(madScaled([]), 0);
});

test('summarizeChromaNoise: grey (zero) is ~0 and ceilings are advisory', () => {
  const z = { n: 12, chromaNoise: 0, lumNoise: 0.01, mottle16: 0, mottle48: 0 };
  const r = summarizeChromaNoise({ clean: z, dust: z });
  assert.equal(r.chromaNoise, 0); assert.ok(r.pass);
  const hi = { n: 12, chromaNoise: 0.02, lumNoise: 0.01, mottle16: 0.01, mottle48: 0.02 };
  const r2 = summarizeChromaNoise({ clean: z, dust: hi }, { noise: { max_chroma_to_lum: 1.5, max_mottle48: 0.01 } });
  assert.ok(!r2.pass); assert.equal(r2.over.length, 2);
  assert.ok(summarizeChromaNoise({ clean: z, dust: hi }, { noise: { max_chroma_to_lum: null } }).pass);
});

test('largestGoodRect on synthetic 8x6 grid', () => {
  const good = Array.from({ length: 6 }, () => Array(8).fill(false));
  for (let r = 1; r <= 4; r++) for (let c = 0; c <= 5; c++) good[r][c] = true; // 6x4 = 24
  good[0][7] = true; good[5][7] = true;
  const b = largestGoodRect(good);
  assert.deepEqual([b.c0, b.r0, b.c1, b.r1, b.cells], [0, 1, 5, 4, 24]);
  assert.equal(largestGoodRect(Array.from({ length: 2 }, () => [false, false])), null);
});

function synthGrid(fn, cols = 8, rows = 6) {
  return { W: 8000, H: 6000, nStars: 999, grid: Array.from({ length: rows }, (_, j) => Array.from({ length: cols }, (_, i) => fn(i, j))) };
}

test('summarizePsfField: uniform, asymmetric (right edge 2x left) and crop box', () => {
  const uni = summarizePsfField(synthGrid(() => ({ n: 20, fwhm: 4, e: 0.1, rel: 45, skew: 0 })));
  assert.equal(uni.verdict, 'uniform');
  assert.equal(uni.crop_box.cells, 48);
  const asym = summarizePsfField(synthGrid((i) => ({ n: 20, fwhm: 4 + i * 0.5, e: 0.1, rel: 45, skew: 0 }))); // 4 .. 7.5
  assert.match(asym.verdict, /asymmetric/);
  assert.ok(asym.lr_ratio >= 1.5);
  // fwhm <= 6 only for i<=4 -> crop box covers columns 0..4 (5 cols x 6 rows)
  assert.equal(asym.crop_box.cells, 30);
  assert.equal(asym.crop_box.x0, 0); assert.equal(asym.crop_box.x1, 5000);
});

test('summarizePsfField: radial coma and insufficient stars', () => {
  const coma = summarizePsfField(synthGrid((i, j) => {
    const edge = i === 0 || j === 0 || i === 7 || j === 5;
    return { n: 20, fwhm: edge ? 6 : 4, e: edge ? 0.25 : 0.1, rel: edge ? 10 : 45, skew: 0 };
  }));
  assert.equal(coma.verdict, 'radial coma');
  assert.equal(summarizePsfField(synthGrid(() => ({ n: 0, fwhm: NaN, e: NaN, rel: NaN, skew: NaN }))).ok, false);
});

test('PJSR strings are ES5 (no let/const/arrow/template) and carry the pure helpers', () => {
  const src = buildPsfFieldPjsr('X', {});
  assert.ok(!/\b(let|const)\b|=>|`/.test(src), 'psf pjsr must be ES5');
  assert.ok(src.includes('forceClose') && src.includes('finally'));
  let captured = '';
  const ctx = { pjsr: async (c) => { captured = c; return { status: 'ok', outputs: { consoleOutput: '{"score":0.001,"bgCells":30,"totalCells":48}' } }; }, log() {} };
  return measureColorGradient(ctx, 'V', { corners: false }).then(() => {
    assert.ok(!/\bexport\b/.test(captured), 'no export keyword in PJSR');
    assert.ok(!/\b(let|const)\b|=>/.test(captured.replace(/\/\/.*$/gm, '')), 'ES5 only');
    assert.ok(captured.includes('bandFromCells(bg'));
    return measureChromaNoise({ pjsr: async (c) => { captured = c; return { status: 'ok', outputs: { consoleOutput: '{"error":"mono image - no chroma"}' } }; } }, 'V');
  }).then((r) => {
    assert.ok(r.error);
    assert.ok(!/\bexport\b/.test(captured));
    assert.ok(!/\b(let|const)\b|=>/.test(captured.replace(/\/\/.*$/gm, '')), 'chroma pjsr ES5');
  });
});
