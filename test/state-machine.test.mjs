import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sm = await import(path.join(ROOT, 'agents/llm/state-machine.mjs'));
const { buildToolSet } = await import(path.join(ROOT, 'agents/llm/tools.mjs'));
const { createStateMachine, STATE_TOOLS, checkBranchCompleteness } = sm;

const REQUIRED = ['inject_l_ifn', 'lift_dust', 'measure_dust_coverage', 'check_noise', 'measure_color_gradient',
  'get_image_dimensions', 'multi_scale_enhance', 'shell_detail_enhance', 'star_protected_blend', 'run_nxt', 'run_scnr',
  'run_hdrmt', 'apply_mask', 'create_luminance_mask', 'lrgb_combine'];

function inState(state) {
  const m = createStateMachine(250);
  m.state = state;
  return m;
}

test('(1) required tools allowed in generate_candidates and compose; every giga tool name resolves; finalize ⊇ compose', () => {
  const { definitions } = buildToolSet('giga_orchestrator');
  const names = new Set(definitions.map(d => d.name));
  for (const t of REQUIRED) {
    // tools that exist in the giga tool set must be allowed; all must be allowed regardless
    for (const st of ['generate_candidates', 'compose']) {
      assert.ok(inState(st).checkToolAccess(t).allowed, `${t} must be allowed in ${st}`);
    }
  }
  for (const n of names) {
    if (REQUIRED.includes(n)) {
      assert.ok(inState('generate_candidates').checkToolAccess(n).allowed, n);
      assert.ok(inState('compose').checkToolAccess(n).allowed, n);
    }
  }
  for (const t of STATE_TOOLS.compose) assert.ok(STATE_TOOLS.finalize.has(t), `finalize missing ${t}`);
  for (const t of ['measure_dust_coverage', 'check_noise', 'measure_color_gradient', 'get_image_dimensions',
    'measure_uniformity', 'list_open_images', 'save_memory', 'recall_memory', 'run_quality_gates']) {
    for (const st of ['assess', 'generate_candidates', 'compose', 'finalize']) assert.ok(inState(st).checkToolAccess(t).allowed, `${t} public in ${st}`);
  }
  assert.ok(!STATE_TOOLS.generate_candidates.has('open_image') && !STATE_TOOLS.generate_candidates.has('combine_channels'));
});

test('(2) REJECTED finish stays in compose; PASSED finish -> finalize', () => {
  let m = inState('compose');
  m.recordToolCall('finish', {}, 'FINISH REJECTED — Quality gates failed: x');
  assert.equal(m.state, 'compose');
  m.recordToolCall('finish', {}, 'Finished (quality gates PASSED). Final artifact: v1');
  assert.equal(m.state, 'finalize');
});

test('(3) generate_candidates + begin_composition -> compose (refused call does not transition)', () => {
  let m = inState('generate_candidates');
  m.recordToolCall('begin_composition', {}, 'Save at least 2 candidates first (save_variant): 1 saved.');
  assert.equal(m.state, 'generate_candidates');
  m.recordToolCall('begin_composition', {}, 'Entered compose with 3 saved variants.');
  assert.equal(m.state, 'compose');
});

test('(4) 300 blocked calls on a 250-turn machine -> turnsRemaining 0 and finalize', () => {
  const m = createStateMachine(250);
  for (let i = 0; i < 300; i++) m.recordBlockedCall();
  assert.equal(m.state, 'finalize');
  assert.ok(m.getBudgetStatus().turnsRemaining <= 0);
});

test('(5) warm start begins in compose and allows finish on turn 1', () => {
  const m = createStateMachine(250, { warmStart: true });
  assert.equal(m.state, 'compose');
  assert.ok(m.checkToolAccess('finish').allowed);
});

test('(6) replay run_2026-06-23_efe2138e trace: seq 67,72,106,145 no longer blocked', (t) => {
  const f = path.join(os.homedir(), '.pixinsight-mcp/runs/run_2026-06-23_efe2138e/trace.jsonl');
  if (!fs.existsSync(f)) return t.skip('trace not present');
  const entries = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const m = createStateMachine(250);
  const verdict = {};
  for (const e of entries) {
    const acc = m.checkToolAccess(e.tool);
    verdict[e.seq] = acc.allowed;
    if (acc.allowed) m.recordToolCall(e.tool, e.args || {}, e.resultSummary || '');
    else m.recordBlockedCall();
  }
  for (const s of [67, 72, 106, 145]) assert.equal(verdict[s], true, `seq ${s} must be allowed`);
});

test('(7) narrowband starless: sho_combine x3, save_variant x2, begin_composition -> compose -> finish allowed', () => {
  const brief = { dataDescription: { narrowband: true, starless: true } };
  const m = createStateMachine(250);
  m.recordToolCall('clone_image', {}, 'Cloned');
  assert.equal(m.state, 'generate_candidates');
  for (let i = 0; i < 3; i++) { assert.ok(m.checkToolAccess('sho_combine').allowed); m.recordToolCall('sho_combine', {}, 'ok'); }
  for (let i = 0; i < 2; i++) m.recordToolCall('save_variant', {}, 'saved');
  const bc = checkBranchCompleteness([
    { notes: 'sho palette A', variantId: 'v1', viewId: 'a' }, { notes: 'hoo palette B hue', variantId: 'v2', viewId: 'b' }], brief);
  assert.ok(bc.complete, bc.warnings.join('|'));
  m.recordToolCall('begin_composition', {}, 'Entered compose with 2 saved variants.');
  assert.equal(m.state, 'compose');
  assert.ok(m.checkToolAccess('finish').allowed);
});

test('(8) every backticked tool on PRIMARY/MANDATORY prompt lines is allowed in generate_candidates', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'agents/llm/prompts/giga-orchestrator.mjs'), 'utf8');
  const { definitions } = buildToolSet('giga_orchestrator');
  const names = new Set(definitions.map(d => d.name));
  const m = inState('generate_candidates');
  const bad = [];
  for (const line of src.split('\n')) {
    if (!/PRIMARY|MANDATORY/.test(line)) continue;
    for (const mm of line.matchAll(/`([a-z][a-z0-9_]+)`/g)) {
      const n = mm[1];
      if (!names.has(n)) continue; // not a tool
      if (!m.checkToolAccess(n).allowed) bad.push(n);
    }
  }
  assert.deepEqual(bad, []);
});

test('toJSON/restore round-trip and repair returns to finalize when entered from finalize', () => {
  const m = inState('finalize');
  m.turnsUsed = 10;
  m.enterRepair({ name: 'p', allowedTools: new Set(['run_curves']) });
  assert.equal(m.state, 'repair');
  m.exitRepair();
  assert.equal(m.state, 'finalize');
  const snap = m.toJSON();
  const m2 = createStateMachine(250).restore(snap);
  assert.equal(m2.state, 'finalize');
  assert.equal(m2.turnsUsed, 10);
});
