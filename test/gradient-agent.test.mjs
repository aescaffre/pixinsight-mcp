import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGradientAgentPrompt, GRADIENT_PROMPT_VERSION } from '../agents/llm/prompts/gradient-agent.mjs';
import { buildToolSet } from '../agents/llm/tools.mjs';
import { gradientHash } from '../agents/llm/warmstart.mjs';

const mk = (cls, fc = {}) => ({ target: { name: 'T', classification: cls, fieldCharacteristics: fc }, dataDescription: { workflow: 'LRGB' }, aestheticIntent: {} });

test('FAINT SIGNAL PROTECTION for reflection / dark / dust / galaxy', () => {
  assert.match(buildGradientAgentPrompt(mk('reflection_nebula', { hasDust: true })), /FAINT SIGNAL PROTECTION/);
  assert.match(buildGradientAgentPrompt(mk('dark_nebula', { hasDust: true })), /FAINT SIGNAL PROTECTION/);
  assert.match(buildGradientAgentPrompt(mk('galaxy_spiral')), /FAINT SIGNAL PROTECTION/);
  assert.doesNotMatch(buildGradientAgentPrompt(mk('emission_nebula')), /FAINT SIGNAL PROTECTION/);
  assert.match(buildGradientAgentPrompt(mk('emission_nebula', { hasIFN: true })), /FAINT SIGNAL PROTECTION/);
});

test('prompt has result contract and no SCNR', () => {
  const p = buildGradientAgentPrompt(mk('galaxy_spiral'));
  assert.match(p, /GRADIENT RESULT:/);
  assert.match(p, /SCNR is intentionally unavailable/);
});

test('gradient_agent tool set excludes run_scnr', () => {
  const names = buildToolSet('gradient_agent').definitions.map(d => d.name);
  assert.ok(!names.includes('run_scnr'));
  assert.ok(names.includes('run_abe') && names.includes('run_per_channel_abe'));
  assert.ok(buildToolSet('giga_orchestrator').definitions.map(d => d.name).includes('run_scnr'));
});

test('gradientHash is salted by prompt version', () => {
  assert.equal(GRADIENT_PROMPT_VERSION, 5);
  assert.match(gradientHash({ a: 1 }, { median: 1 }), /^[0-9a-f]{40}$/);
});
