import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentModels, parseModelFlags, fallbackFired } from '../agents/llm/agent-models.mjs';
import { MaxAgent } from '../agents/llm/engine-max.mjs';

test('resolution order CLI > config > default', () => {
  const d = resolveAgentModels({}, {});
  assert.equal(d.gradient_agent.model, 'inherit');
  assert.equal(d.aesthetic_critic.model, 'opus');
  const c = resolveAgentModels({}, { models: { gradient_agent: { model: 'opus' } } });
  assert.equal(c.gradient_agent.model, 'opus');
  const cli = resolveAgentModels(parseModelFlags(['--model-gradient', 'sonnet', '--effort-giga', 'max']), { models: { gradient_agent: { model: 'opus' } } });
  assert.equal(cli.gradient_agent.model, 'sonnet');
  assert.equal(cli.giga_orchestrator.effort, 'max');
  assert.equal(cli.giga_orchestrator.model, 'inherit');
});

test('fallbackFired', () => {
  assert.equal(fallbackFired('opus', ['claude-opus-4']), false);
  assert.equal(fallbackFired('opus', ['claude-sonnet-5']), true);
  assert.equal(fallbackFired('inherit', ['x']), false);
});

test('engine-max builds args', async () => {
  const mk = (o) => new MaxAgent('giga_orchestrator', { systemPrompt: 'x', agentName: 'giga_orchestrator', brief: {}, ...o });
  const a = mk({ maxTurns: 250, model: 'inherit', effort: 'high', fallbackModel: 'sonnet' });
  // capture args by intercepting spawn via PATH shim
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "$ARGS_OUT"\necho \'{"result":"x","modelUsage":{"claude-opus":{}},"num_turns":2}\'\n', { mode: 0o755 });
  const out = path.join(dir, 'args.txt');
  process.env.ARGS_OUT = out; const oldPath = process.env.PATH; process.env.PATH = dir + ':' + oldPath;
  try {
    const r = await a.run('hi');
    const args = fs.readFileSync(out, 'utf-8').split('\n');
    assert.ok(!args.includes('--model'));
    assert.equal(args[args.indexOf('--effort') + 1], 'high');
    assert.equal(args[args.indexOf('--max-turns') + 1], '375');
    assert.equal(args[args.indexOf('--fallback-model') + 1], 'sonnet');
    assert.deepEqual(r.actualModels, ['claude-opus']);
    const b = mk({ maxTurns: 10, model: 'sonnet' });
    await b.run('hi');
    const args2 = fs.readFileSync(out, 'utf-8').split('\n');
    assert.equal(args2[args2.indexOf('--model') + 1], 'sonnet');
  } finally { process.env.PATH = oldPath; }
});
