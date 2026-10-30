import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStateMachine, createCounterBudget, checkBudgetExhausted } from '../agents/llm/state-machine.mjs';
import { ArtifactStore, getBestVariant } from '../agents/artifact-store.mjs';

test('StateMachine(250): mixed tool/blocked calls exhaust budget; non-whitelisted tool refused', () => {
  const sm = createStateMachine(250);
  for (let i = 0; i < 250; i++) (i % 3 === 0 ? sm.recordBlockedCall() : sm.recordToolCall('get_image_stats', {}, ''));
  assert.equal(sm.getBudgetStatus().turnsRemaining, 0);
  const txt = checkBudgetExhausted('giga_orchestrator', 'run_curves', sm.getBudgetStatus());
  assert.match(txt, /^BUDGET EXHAUSTED: only finish, /);
  assert.match(txt, /EMERGENCY/);
  assert.equal(checkBudgetExhausted('giga_orchestrator', 'finish', sm.getBudgetStatus()), null);
});

test('recordBlockedCall never trips tool-name sentinels', () => {
  const sm = createStateMachine(250);
  sm.recordBlockedCall();
  assert.equal(sm.state, 'assess');
});

test('counter budget status thresholds', () => {
  const b = createCounterBudget(50);
  assert.equal(b.getBudgetStatus().status, 'ok');
  for (let i = 0; i < 20; i++) b.recordToolCall();
  assert.equal(b.getBudgetStatus().status, 'converge');
  for (let i = 0; i < 15; i++) b.recordBlockedCall();
  assert.equal(b.getBudgetStatus().status, 'critical');
  for (let i = 0; i < 15; i++) b.recordToolCall();
  assert.equal(b.getBudgetStatus().turnsRemaining, 0);
  assert.match(checkBudgetExhausted('gradient_agent', 'run_abe', b.getBudgetStatus()), /stop now/);
  assert.equal(checkBudgetExhausted('gradient_agent', 'save_memory', b.getBudgetStatus()), null);
  assert.match(checkBudgetExhausted('core_specialist', 'run_curves', b.getBudgetStatus()), /restore_from_clone/);
});

async function runStub(script, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubclaude-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  process.env.PIX_CLAUDE_BIN = bin;
  const { MaxAgent } = await import('../agents/llm/engine-max.mjs?stub=' + Math.random());
  const a = new MaxAgent('stub', { systemPrompt: 'x', agentName: 'gradient_agent', maxTurns: 5, timeoutMs, brief: null });
  return a.run('hi');
}

test('engine-max: timeout -> timedOut:true, no crashError', async () => {
  const r = await runStub('#!/bin/sh\n[ "$1" = "--help" ] && exit 0\nexec sleep 20\n', 2000);
  assert.equal(r.timedOut, true);
  assert.equal(r.crashError, null);
});

test('engine-max: error_max_turns -> maxTurnsHit:true', async () => {
  const r = await runStub('#!/bin/sh\n[ "$1" = "--help" ] && exit 0\necho \'{"subtype":"error_max_turns","result":"","num_turns":9}\'\n', 20000);
  assert.equal(r.maxTurnsHit, true);
  assert.equal(r.timedOut, false);
});

test('getBestVariant prefers gate-PASS, falls back to latest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-'));
  const mk = (id, extra) => { const x = path.join(dir, id + '.xisf'); fs.writeFileSync(x, 'x'); return { variantId: id, xisfPath: x, ...extra }; };
  const vs = [mk('variant_1', { gates: { pass: true, warnings: 2 } }), mk('variant_2', {}), mk('variant_3', { gates: { pass: true, warnings: 0 } })];
  const store = { listVariants: () => vs };
  assert.equal(getBestVariant(store).variantId, 'variant_3');
  assert.equal(getBestVariant({ listVariants: () => [vs[1], mk('variant_9', {})] }).variantId, 'variant_9');
  assert.equal(getBestVariant({ listVariants: () => [] }), null);
});
