import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createBridgeContext } from '../agents/ops/bridge.mjs';
import { ArtifactStore } from '../agents/artifact-store.mjs';
import { createStateMachine } from '../agents/llm/state-machine.mjs';
import { createRepairTracker } from '../agents/llm/repair-policies.mjs';
import { FATAL_TEXT, writeCrashFile, isCrashed, saveAgentState, restoreAgentState, countTraceLines } from '../agents/llm/agent-state.mjs';
import { summarizeWindows } from '../agents/llm/tools.mjs';
import { buildResumePrompt } from '../agents/llm/resume-agent.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wi07b-'));

test('bridge ctx exposes isAlive and crashed flag', () => {
  const ctx = createBridgeContext({ cmdDir: tmp(), resDir: tmp() });
  assert.equal(typeof ctx.isAlive, 'function');
  assert.equal(ctx.crashed, false);
});

test('crash sentinel: ctx.crashed or CRASH.json => FATAL', () => {
  const d = tmp();
  assert.equal(isCrashed({ crashed: false }, d), false);
  assert.equal(isCrashed({ crashed: true }, d), true);
  writeCrashFile(d, { agent: 'a', tool: 't', seq: 3, message: 'm' });
  const j = JSON.parse(fs.readFileSync(path.join(d, 'CRASH.json'), 'utf-8'));
  assert.equal(j.tool, 't'); assert.equal(j.seq, 3);
  assert.equal(isCrashed({ crashed: false }, d), true);
  assert.match(FATAL_TEXT, /STOP calling tools/);
});

test('agent-state round-trip', () => {
  const d = tmp();
  const sm = createStateMachine(250); sm.state = 'compose'; sm.turnsUsed = 40; sm.stateTurns.compose = 7;
  const prov = createRepairTracker().prov; prov.set('V', { tool: 'run_curves', params: {}, seq: 5, history: [] });
  saveAgentState(d, 'giga_orchestrator', { stateMachine: sm, provenance: prov, starIntegrity: { S: { ok: 1 } }, traceSeq: 12, variantCounters: { giga_orchestrator: 4 } });
  const sm2 = createStateMachine(250); const prov2 = new Map(); const brief = {};
  const r = restoreAgentState(d, 'giga_orchestrator', { stateMachine: sm2, provenance: prov2, brief });
  assert.equal(r.restored, true);
  assert.equal(sm2.state, 'compose'); assert.equal(sm2.turnsUsed, 0);
  assert.deepEqual(prov2.get('V'), prov.get('V'));
  assert.deepEqual(brief._starIntegrity, { S: { ok: 1 } });
  assert.equal(r.traceSeq, 12);
});

test('agent-state parse failure => permissive compose', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'agent-state-giga_orchestrator.json'), '{bad');
  const sm = createStateMachine(250);
  const r = restoreAgentState(d, 'giga_orchestrator', { stateMachine: sm, provenance: new Map(), brief: {} });
  assert.equal(r.restored, false); assert.equal(sm.state, 'compose');
});

test('trace line count', () => {
  const d = tmp(); const f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"a":2}\n');
  assert.equal(countTraceLines(f), 2);
  assert.equal(countTraceLines(path.join(d, 'none')), 0);
});

test('variant counter from disk, short-id load, REFUSED on open view, fail()', async () => {
  const runsDir = tmp();
  const store = new ArtifactStore('run_t', { runsDir });
  const dir = store.agentDir('giga_orchestrator');
  for (let i = 1; i <= 4; i++) {
    const vd = path.join(dir, `variant_0${i}`); fs.mkdirSync(vd, { recursive: true });
    fs.writeFileSync(path.join(vd, 'metadata.json'), JSON.stringify({ variantId: `variant_0${i}`, viewId: 'V', xisfPath: path.join(vd, 'image.xisf') }));
  }
  assert.equal(store.maxVariantOnDisk('giga_orchestrator'), 4);
  const pj = [];
  const ctx = { pjsr: async (c) => { pj.push(c); return { result: '' }; }, send: async () => ({ outputs: { id: 'image' } }), listImages: async () => [] };
  const saved = await store.saveVariant(ctx, 'giga_orchestrator', 'V', {}, {}, { savePreview: false });
  assert.equal(saved.metadata.variantId, 'variant_05');
  assert.equal(JSON.parse(fs.readFileSync(store.manifestPath, 'utf-8')).variantCounters.giga_orchestrator, 5);
  // a fresh store instance on the same run also continues at 06
  const store2 = new ArtifactStore('run_t', { runsDir });
  const s2 = await store2.saveVariant(ctx, 'giga_orchestrator', 'V', {}, {}, { savePreview: false });
  assert.equal(s2.metadata.variantId, 'variant_06');
  // short id resolves
  const meta = await store.loadVariant(ctx, 'variant_02', { agentName: 'giga_orchestrator' });
  assert.equal(meta.variantId, 'variant_02');
  // refuse when target open
  const ctxOpen = { ...ctx, listImages: async () => [{ id: 'V' }] };
  await assert.rejects(store.loadVariant(ctxOpen, 'variant_02', { agentName: 'giga_orchestrator' }), /REFUSED: view V already open/);
  await store.loadVariant(ctxOpen, 'variant_02', { agentName: 'giga_orchestrator', replaceExisting: true });
  await store.loadVariant(ctxOpen, 'variant_02', { agentName: 'giga_orchestrator', viewId: 'W' });
  store.fail('boom');
  assert.equal(JSON.parse(fs.readFileSync(store.manifestPath, 'utf-8')).status, 'crashed');
});

test('window summary excludes masks from count and estimates MB', () => {
  const s = summarizeWindows([{ id: 'A', width: 1000, height: 1000, isColor: true }, { id: 'crop_mask1', width: 10, height: 10 }, { id: 'm_mask', width: 1000, height: 1000 }]);
  assert.equal(s.count, 1);
  assert.equal(s.rows[0].estMB, 12);
});

test('resume prompt', () => {
  assert.match(buildResumePrompt('compose'), /state compose/);
});
