import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCoreCandidate } from '../agents/llm/composer.mjs';
import { buildToolSet } from '../agents/llm/tools.mjs';
import { buildCoreSpecialistPrompt } from '../agents/llm/prompts/core-specialist.mjs';

const base = { coreStructFrac: 0.80, haloFrac: 0.02, coreRelContrast: 0.30 };
const mk = (label, s, h, r, pass = true) => ({ label, path: '/x/' + label, core: { coreStructFrac: s, haloFrac: h, coreRelContrast: r, pass } });

test('picks the judgeAB winner with the largest gain', () => {
  const sel = selectCoreCandidate(base, [
    mk('CORE_WORK', 0.805, 0.02, 0.31),          // not enough
    mk('variant 1', 0.85, 0.02, 0.30),           // wins
    mk('variant 2', 0.90, 0.02, 0.36),           // wins bigger
    mk('variant 3', 0.95, 0.04, 0.40),           // halo too high
  ]);
  assert.equal(sel.chosen.label, 'variant 2');
  assert.equal(sel.wins.length, 2);
});
test('failing core check disqualifies', () => {
  const sel = selectCoreCandidate(base, [mk('CORE_WORK', 0.9, 0.02, 0.4, false), mk('variant 1', 0.9, 0.02, 0.4, false)]);
  assert.equal(sel.wins.length, 0);
  assert.equal(sel.chosen.label, 'CORE_WORK');
});
test('falls back to CORE_WORK, then null on errors', () => {
  const errs = [{ label: 'CORE_WORK', path: '/x', core: null, error: 'boom' }];
  assert.equal(selectCoreCandidate(base, errs).chosen.label, 'CORE_WORK');
  assert.equal(selectCoreCandidate(base, []).chosen, null);
});
test('core_specialist toolset has ringing + burnt scan, no whole-image gates', () => {
  const names = buildToolSet('core_specialist').definitions.map(d => d.name);
  for (const n of ['check_ringing', 'scan_burnt_regions', 'check_highlight_texture']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('run_quality_gates'));
  assert.ok(!names.includes('check_star_quality'));
});
test('prompt has end-state contract and relative criteria', () => {
  const p = buildCoreSpecialistPrompt({ target: { classification: 'reflection_nebula' } });
  assert.match(p, /END-STATE CONTRACT/);
  assert.match(p, /baseline\+0\.01/);
  assert.match(p, /check_ringing/);
  assert.doesNotMatch(p, />0\.80\)/);
});
