import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rp = await import(path.join(ROOT, 'agents/llm/repair-policies.mjs'));
const { parseGateFailure, findRepairPolicy, checkRepairForbids, createRepairTracker, parseFinishResult, isPassResult } = rp;

// Real strings from run_2026-06-23_efe2138e/trace.jsonl (resultSummary, truncated by the tracer).
const REAL = {
  star_color_fwhm: '[STAR QUALITY GATE: FAIL] Stars bloated: median FWHM=11.00px (limit: 8.0px); Stars colorless: diversity=0.004 (limit: 0.05)\n  Median FWHM: 11.00px (limit: 6.0)\n  Color diversity: 0.004 (limit: 0.05)',
  star_fwhm_only: '[STAR QUALITY GATE: FAIL] Stars bloated: median FWHM=13.00px (limit: 8.0px)\n  Median FWHM: 13.00px (limit: 6.0)\n  Color diversity: 0.051 (limit: 0.05)',
  tonal_subdued: '[TONAL PRESENCE: FAIL — SUBDUED] SUBDUED: subject/background separation=2.47× (need >3×). Subject median=0.2496, background median=0.1012.',
  sat_over: 'Saturation: median=0.500, P90=0.791, P99=0.925, max=0.995 (12879 subject pixels)\n\nWARNING: P90=0.791 exceeds hard limit 0.65. Reduce saturation at the source — curves, LRGB params, or Ha injection strength.',
  finish_core: 'FINISH REJECTED — Quality gates failed:\n  - CORE PERCEPTUALLY BURNT: *** FAILS CORE GATE (WHITE BURN) *** 10.4% of the bright core is white-clipped + desaturated (limit 10%). The center reads as a blown white patch even if gradient energy passes. Compress the core pedestal (continuous_clamp) and recover color/structure so the center is not white.',
  burn: '[BURN SCAN: FAIL] BURNT REGIONS: 5 block(s) of 50×50px have >3% pixels above 0.95. ZERO burnt blocks allowed.\n  Burnt blocks: 5/9044',
};

test('parseGateFailure on 6 real strings', () => {
  assert.deepEqual(parseGateFailure('check_star_quality', REAL.star_color_fwhm).failedMetrics.sort(), ['color', 'fwhm']);
  assert.deepEqual(parseGateFailure('check_star_quality', REAL.star_fwhm_only).failedMetrics, ['fwhm']);
  const t = parseGateFailure('check_tonal_presence', REAL.tonal_subdued);
  assert.equal(t.tonal_verdict, 'subdued');
  assert.ok(t.failedMetrics.includes('tonal'));
  const s = parseGateFailure('check_saturation', REAL.sat_over);
  assert.equal(s.p90S, 0.791);
  assert.ok(s.failedMetrics.includes('saturation'));
  assert.ok(parseGateFailure('finish', REAL.finish_core).failedMetrics.includes('core'));
  assert.ok(parseGateFailure('scan_burnt_regions', REAL.burn).failedMetrics.includes('burn'));
  const p = parseGateFailure('check_saturation', OVER_SAT_FINISH);
  assert.equal(p.p90S, 0.791);
});
const OVER_SAT_FINISH = 'OVER-SATURATED: P90=0.791 (limit: 0.65, profile max_p90=0.65). Reduce saturation at the source.';

test('findRepairPolicy: synthetic finish keys and star color policy', () => {
  for (const k of ['finish:core_contrast', 'finish:noise', 'finish:dust', 'finish:palette', 'finish:exposure', 'finish:l_missing']) {
    const p = findRepairPolicy(k, {}, null, 'galaxy_spiral');
    assert.ok(p, k);
    assert.ok(p.verifyTools.includes('finish'), `${k} verifyTools includes finish`);
  }
  assert.equal(findRepairPolicy('check_core_contrast', {}, null, 'x').id, 'finish_core_contrast');
  const star = findRepairPolicy('check_star_quality', parseGateFailure('check_star_quality', REAL.star_color_fwhm), { tool: 'run_curves', params: { channel: 'S' } }, 'x');
  assert.equal(star.id, 'star_color_after_desat');
});

test('checkRepairForbids: policy 9 lower min_clamp; star color S-desat via PixelMath; global darkening', () => {
  const p9 = findRepairPolicy('check_highlight_texture', { resultText: 'COLLAPSED' }, { tool: 'continuous_clamp', params: { min_clamp: 0.75 } }, 'x');
  assert.equal(p9.id, 'highlight_collapsed_after_compression');
  const prov = { tool: 'continuous_clamp', params: { min_clamp: 0.75 } };
  assert.equal(checkRepairForbids('continuous_clamp', { min_clamp: 0.6 }, p9, prov).allowed, false);
  assert.equal(checkRepairForbids('continuous_clamp', { min_clamp: 0.83 }, p9, prov).allowed, true);

  const star = findRepairPolicy('check_star_quality', { failedMetrics: ['color'] }, { tool: 'run_curves', params: { channel: 'S' } }, 'x');
  assert.equal(checkRepairForbids('run_pixelmath', { view_id: 'v', expression: '$T*0.6' }, star, null).allowed, false);
  assert.equal(checkRepairForbids('run_pixelmath', { view_id: 'v', expression: 'CIEL($T)*0.9' }, star, null).allowed, false);
  assert.equal(checkRepairForbids('run_pixelmath', { view_id: 'v', expression: '$T + 0.01' }, star, null).allowed, true);

  const burn = findRepairPolicy('scan_burnt_regions', {}, { tool: 'multi_scale_enhance', params: {} }, 'x');
  const dark = { channel: 'RGB', points: [[0, 0], [0.5, 0.4], [1, 1]] };
  assert.equal(checkRepairForbids('run_curves', dark, burn, null, { maskActive: false }).allowed, false);
  assert.equal(checkRepairForbids('run_curves', dark, burn, null, { maskActive: true }).allowed, true);
  assert.equal(checkRepairForbids('run_curves', { channel: 'RGB', points: [[0, 0], [0.5, 0.6], [1, 1]] }, burn, null, {}).allowed, true);
});

test('tracker: provenance history, engage, verify PASS clears, finish accepted clears, maxTurns expiry', () => {
  const t = createRepairTracker();
  for (let i = 0; i < 7; i++) t.recordModifier('run_curves', { channel: 'S', n: i }, i, 'v');
  t.recordModifier('lrgb_combine', { saturation: 0.8 }, 7, 'v');
  t.recordModifier('run_curves', { channel: 'S' }, 8, 'v');
  const pv = t.prov.get('v');
  assert.equal(pv.history.length, 5);
  assert.equal(pv.lastComposition.tool, 'lrgb_combine');
  assert.equal(pv.tool, 'run_curves');

  let r = t.onResult({ name: 'check_saturation', args: { view_id: 'v' }, resultText: REAL.sat_over, seq: 9, viewId: 'v', category: 'galaxy_spiral' });
  assert.equal(r.engaged.policy, 'saturation_after_lrgb');   // falls back to lastComposition
  assert.ok(t.policyIdFor('v'));
  assert.equal(t.checkForbids('run_curves', { channel: 'S', points: [[0, 0], [1, 1]] }, 'v').allowed, false);
  r = t.onResult({ name: 'check_saturation', args: { view_id: 'v' }, resultText: 'Saturation: median=0.4, P90=0.553, P99=0.667, max=0.808 (12756 subject pixels)', seq: 12, viewId: 'v' });
  assert.equal(t.policyIdFor('v'), null);
  assert.equal(r.events[0].reason, 'verify_pass');

  t.onResult({ name: 'check_saturation', args: {}, resultText: REAL.sat_over, seq: 20, viewId: 'v', category: 'x' });
  assert.ok(t.policyIdFor('v'));
  assert.equal(t.expire(20 + 13).length, 1);   // 12 turns by seq, blocked calls included
  assert.equal(t.policyIdFor('v'), null);

  t.onResult({ name: 'check_saturation', args: {}, resultText: REAL.sat_over, seq: 40, viewId: 'v', category: 'x' });
  t.onResult({ name: 'finish', args: {}, resultText: 'Finished (quality gates PASSED). Final artifact: variant_1', seq: 41, viewId: 'v' });
  assert.equal(t.policyIdFor('v'), null);
});

test('GATES_JSON trailer drives engagement on the trailer viewId; non-repairable gates are skipped', () => {
  const t = createRepairTracker();
  t.recordModifier('inject_l_ifn', { view_id: 'w' }, 1, 'w');
  const text = 'FINISH REJECTED — Quality gates failed:\n  - x\n\nGATES_JSON: ' + JSON.stringify({
    viewId: 'w',
    failedGates: [
      { gate: 'aesthetic', tool: 'aesthetic_critic', repairable: false },
      { gate: 'core_contrast', tool: 'finish:core_contrast', repairable: true, failedMetrics: ['core'], reason: 'r', resultText: 'r' },
    ],
  });
  assert.equal(parseFinishResult(text).viewId, 'w');
  const r = t.onResult({ name: 'finish', args: { view_id: 'other' }, resultText: text, seq: 2, viewId: 'other', category: 'x' });
  assert.equal(r.engaged.policy, 'finish_core_contrast');
  assert.equal(r.engaged.viewId, 'w');
  assert.ok(r.guidance.includes('REPAIR POLICY: finish_core_contrast'));
  assert.equal(isPassResult('finish', text), false);
});

test('replay efe2138e: after seq 74 repair_engaged; continuous_clamp 75/78 are violations', (t) => {
  const tracePath = path.join(os.homedir(), '.pixinsight-mcp/runs/run_2026-06-23_efe2138e/trace.jsonl');
  if (!fs.existsSync(tracePath)) return t.skip('trace not on disk');
  const entries = fs.readFileSync(tracePath, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => !e.type);
  const tr = createRepairTracker();
  const events = [], violations = [];
  for (const e of entries) {
    if (e.error && /^BLOCKED/.test(e.error)) { continue; }
    const a = e.args || {};
    const vid = a.view_id || a.rgb_id || a.target_id || null;
    tr.expire(e.seq);
    const f = tr.checkForbids(e.tool, a, vid);
    if (!f.allowed) { violations.push(e.seq); continue; }
    tr.recordModifier(e.tool, a, e.seq, vid);
    const r = tr.onResult({ name: e.tool, args: a, resultText: e.resultSummary || '', seq: e.seq, viewId: vid, category: 'reflection_nebula' });
    for (const ev of r.events) events.push(ev);
  }
  const eng = events.find(ev => ev.event === 'repair_engaged' && ev.seq === 74);
  assert.ok(eng, 'repair_engaged at seq 74');
  assert.equal(eng.policy, 'finish_core_contrast');
  assert.ok(violations.includes(75) && violations.includes(78), `violations: ${violations}`);
  assert.ok(!violations.includes(76));
});
