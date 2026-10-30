import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gc = await import(path.join(ROOT, 'agents/llm/gate-contract.mjs'));
const { profileFor } = await import(path.join(ROOT, 'agents/classifier.mjs'));
const tools = await import(path.join(ROOT, 'agents/llm/tools.mjs'));
const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents/processing-profiles.json'), 'utf-8'));

function briefFor(cls, nb) {
  return {
    target: { classification: cls, fieldCharacteristics: { faintStructureGoal: cls === 'planetary_nebula' ? 'outer_halo' : 'none' } },
    dataDescription: { narrowband: nb, starless: nb, channels: { L: !nb } },
    processingProfile: profileFor(cls, nb, nb ? 'SHO' : 'LRGB'),
  };
}

test('contract constants have the documented values', () => {
  assert.equal(gc.BURN_CLIP, 0.95);
  assert.equal(gc.BRIGHT_BLOCK_LEVEL, 0.80);
  assert.equal(gc.NOISE_BG_HARD, 0.022);
  assert.equal(gc.NOISE_DUST_HARD, 0.040);
  assert.deepEqual(gc.STAR_CONTRAST, { prominent: 4.0, balanced: 3.0, subdued: 2.0 });
  assert.equal(gc.contrastGateFor('outer_halo'), 2.0);
  assert.equal(gc.contrastGateFor('none'), 3.0);
});

test('gateThreshold: override requires _calibration', () => {
  assert.equal(gc.gateThreshold({ stars: { fwhm_hard: 20 } }, 'stars.fwhm_hard', 12), 12);
  assert.equal(gc.gateThreshold({ stars: { fwhm_hard: 20, _calibration: 'x' } }, 'stars.fwhm_hard', 12), 20);
  assert.equal(gc.gateThreshold({}, 'stars.fwhm_hard', 12), 12);
});

test('every shipped profile: calibrated overrides only, buildGateTable resolves', () => {
  const names = [...Object.keys(profiles).filter(k => k !== 'narrowband_palette'), 'narrowband_palette'];
  for (const cls of names) {
    const nb = cls === 'narrowband_palette';
    const baseCls = nb ? 'emission_nebula' : cls;
    const brief = briefFor(baseCls, nb);
    assert.deepEqual(gc.validateProfileCalibration(brief.processingProfile), [], `${cls}: uncalibrated override`);
    const table = gc.buildGateTable(brief);
    assert.ok(table.length >= 15, `${cls}: table too short`);
    for (const row of table) {
      assert.ok(['BLOCKING', 'WARNING', 'SKIPPED'].includes(row.status), `${cls}/${row.gate}: bad status`);
      if (row.status === 'BLOCKING' && row.thresholdKey) {
        assert.equal(row.threshold, gc.gateThreshold(brief.processingProfile, row.thresholdKey, row.codeDefault), `${cls}/${row.gate}`);
      }
    }
  }
});

test('evaluateFinishGates is exported; finish handler has no inlined gate literals', () => {
  assert.equal(typeof tools.evaluateFinishGates, 'function');
  const src = fs.readFileSync(path.join(ROOT, 'agents/llm/tools.mjs'), 'utf-8');
  const start = src.indexOf('\n  finish: {\n');
  const end = src.indexOf('\n  // --- Star removal ---', start);
  assert.ok(start > 0 && end > start, 'finish handler not located');
  const finishSrc = src.slice(start, end);
  for (const lit of ['0.95', '0.80', '0.022']) {
    assert.ok(!finishSrc.includes(lit), `finish handler still contains literal ${lit}`);
  }
  const efStart = src.indexOf('export async function evaluateFinishGates');
  const efEnd = src.indexOf('// Tool definition catalog', efStart);
  const efSrc = src.slice(efStart, efEnd).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  for (const lit of ['0.022', '0.040', '12.0']) {
    assert.ok(!efSrc.includes(lit), `evaluateFinishGates still contains literal ${lit}`);
  }
});
