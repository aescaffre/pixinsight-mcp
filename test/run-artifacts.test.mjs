import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { writeRunArtifacts, makeAgentRunRecord, formatAgentTable } = await import(path.join(ROOT, 'agents/llm/run-artifacts.mjs'));
const { ArtifactStore } = await import(path.join(ROOT, 'agents/artifact-store.mjs'));
const { analyzeTrace } = await import(path.join(ROOT, 'agents/llm/trace-analyzer.mjs'));

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi25-'));
  return new ArtifactStore('run_test_wi25', { runsDir: dir });
}

test('writeRunArtifacts(crashed) writes run-summary.json and sets manifest.status', async () => {
  const store = tmpStore();
  fs.writeFileSync(path.join(store.baseDir, 'trace.jsonl'), [
    JSON.stringify({ seq: 0, ts: 1000, tool: 'clone_image', args: { source_id: 'A', clone_id: 'B' }, durationMs: 5, agent: 'giga_orchestrator', pid: 1 }),
    JSON.stringify({ seq: 1, ts: 2000, tool: 'run_abe', args: {}, durationMs: 7, agent: 'gradient_agent', error: 'BLOCKED (state)' }),
  ].join('\n') + '\n');
  const agentRuns = [makeAgentRunRecord('giga_orchestrator', 'inherit', { turnCount: 3, elapsedMs: 9, usage: { input_tokens: 5, output_tokens: 2 } })];
  await writeRunArtifacts(store, 'crashed', { agentRuns, elapsedMs: 9, failReason: 'boom', log: () => {} });
  const sum = JSON.parse(fs.readFileSync(path.join(store.baseDir, 'run-summary.json'), 'utf-8'));
  assert.equal(sum.status, 'crashed');
  assert.equal(sum.agentRuns.length, 1);
  assert.ok('critic' in sum);
  assert.equal(JSON.parse(fs.readFileSync(store.manifestPath, 'utf-8')).status, 'crashed');
  assert.ok(fs.existsSync(path.join(store.baseDir, 'trace-summary.md')));
  assert.match(formatAgentTable(agentRuns, { calls: 0, usage: {} }), /giga_orchestrator/);
});

test('writeRunArtifacts(finished) finalizes the manifest', async () => {
  const store = tmpStore();
  await writeRunArtifacts(store, 'finished', { finalSelection: { variant_id: 'variant_01' }, log: () => {} });
  const m = JSON.parse(fs.readFileSync(store.manifestPath, 'utf-8'));
  assert.equal(m.status, 'completed');
  assert.equal(m.finalArtifact, 'variant_01');
});

test('analyzeTrace defaults to giga agent and reports perAgent', () => {
  const store = tmpStore();
  const tp = path.join(store.baseDir, 'trace.jsonl');
  fs.writeFileSync(tp, [
    JSON.stringify({ seq: 0, ts: 1, tool: 'clone_image', args: { source_id: 'A', clone_id: 'B' }, durationMs: 5 }),
    JSON.stringify({ seq: 1, ts: 2, tool: 'clone_image', args: { source_id: 'X', clone_id: 'Y' }, durationMs: 7, agent: 'gradient_agent', error: 'BLOCKED (x)' }),
  ].join('\n') + '\n');
  const a = analyzeTrace(tp);
  assert.deepEqual(Object.keys(a.branches), ['B']);
  assert.equal(a.perAgent.giga_orchestrator.calls, 1);
  assert.equal(a.perAgent.gradient_agent.blocked, 1);
  assert.equal(Object.keys(analyzeTrace(tp, { agent: null }).branches).length, 2);
});
