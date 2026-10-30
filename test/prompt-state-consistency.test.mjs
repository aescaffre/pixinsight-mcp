// WI-09: the prompt's tool names / parameters must agree with the live tool catalog and the runtime state machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-state-'));   // isolate from the real ledger (getChampions)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildGigaOrchestratorPrompt } = await import(path.join(ROOT, 'agents/llm/prompts/giga-orchestrator.mjs'));
const { generateBrief } = await import(path.join(ROOT, 'agents/classifier.mjs'));
const { buildToolSet } = await import(path.join(ROOT, 'agents/llm/tools.mjs'));
const { StateMachine, INTERNAL_TOOLS } = await import(path.join(ROOT, 'agents/llm/state-machine.mjs'));

const { definitions } = buildToolSet('giga_orchestrator');          // hidden tools are excluded for this agent
const SCHEMA = new Map(definitions.map((d) => [d.name, new Set(Object.keys(d.input_schema?.properties || {}))]));
const VISIBLE = new Set(SCHEMA.keys());

const CONFIGS = fs.readdirSync(ROOT).filter((f) => f.endsWith('_agentic.json')).sort();
const renders = CONFIGS.map((f) => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf-8'));
  const brief = generateBrief(cfg, {});
  return { f, cfg, brief, prompt: buildGigaOrchestratorPrompt(brief, cfg) };
});

const TOOLISH = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
function allowedIn(state, tool) {
  const sm = new StateMachine(250);
  sm.state = state;
  return sm.checkToolAccess(tool).allowed;
}
function section(prompt, startMarker, endMarker) {
  const i = prompt.indexOf(startMarker);
  if (i < 0) return '';
  const j = endMarker ? prompt.indexOf(endMarker, i + startMarker.length) : -1;
  return prompt.slice(i, j < 0 ? undefined : j);
}
function backticked(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
}
/** Tool names named by a backticked token ("run_hdrmt" or "run_hdrmt (inverted=true)" -> run_hdrmt). */
function toolTokens(text) {
  const out = [];
  for (const tok of backticked(text)) {
    const name = tok.split(/[\s(]/)[0];
    if (TOOLISH.test(name) && (VISIBLE.has(name) || INTERNAL_TOOLS.has(name))) out.push(name);
  }
  return out;
}
/** Items of 'Tools:' / 'Also available:' lists (continued lines end with a comma). */
function listedTools(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:Tools|Also available):\s*(.*)$/);
    if (!m) continue;
    let body = m[1];
    while (body.trim().endsWith(',') && i + 1 < lines.length) body += ' ' + lines[++i];
    for (let item of body.replace(/\([^)]*\)/g, '').split(',')) {
      item = item.trim().split(/\s+/)[0];
      if (item) out.push(item);
    }
  }
  return out;
}

for (const r of renders) {
  const { f, prompt } = r;

  test(`${f}: RUNTIME STATES tools exist, are not internal/hidden and are allowed in the state they are listed under`, () => {
    const rt = section(prompt, '# RUNTIME STATES', '# ======================================================================\n# STANDARD');
    assert.ok(rt.length > 200, 'RUNTIME STATES section missing');
    const stateLines = rt.split('\n').filter((l) => /^- \*\*(assess|generate_candidates|compose|repair|finalize)\*\*/.test(l));
    assert.equal(stateLines.length, 5);
    for (const line of stateLines) {
      const state = line.match(/^- \*\*(\w+)\*\*/)[1];
      for (const t of toolTokens(line)) {
        assert.ok(!INTERNAL_TOOLS.has(t), `${t} is internal`);
        assert.ok(VISIBLE.has(t), `${t} is not a visible tool`);
        if (state === 'repair') continue;   // repair tools are policy-driven
        assert.ok(allowedIn(state, t), `${t} listed under ${state} but not allowed there`);
      }
    }
    // finish is a probe: the section must say so, and a rejected finish stays in compose (state-machine contract)
    assert.match(rt, /finish\\?`? is a probe/);
    const sm = new StateMachine(250); sm.state = 'compose';
    sm.recordToolCall('finish', {}, 'FINISH REJECTED - Quality gates failed');
    assert.equal(sm.state, 'compose');
  });

  test(`${f}: branch + composition sections only name tools that exist and are allowed in their state`, () => {
    const branches = section(prompt, '## BRANCH A', '# ======================================================================\n# MISSION: BRANCH CRITIC PASS');
    const compose = section(prompt, '# MISSION: COMPOSITION', '# MISSION: GRADIENT + SCNR CHECK');
    assert.ok(branches.length > 500 && compose.length > 500);
    const check = (text, state, label) => {
      for (const t of new Set([...toolTokens(text), ...listedTools(text)])) {
        assert.ok(!INTERNAL_TOOLS.has(t), `${label}: ${t} is internal`);
        assert.ok(VISIBLE.has(t), `${label}: ${t} is not a visible catalog tool`);
        assert.ok(allowedIn(state, t), `${label}: ${t} not allowed in ${state}`);
      }
    };
    check(branches, 'generate_candidates', 'branches');
    check(compose, 'compose', 'composition');
  });

  test(`${f}: tool(name=value) pairs match the tool input_schema keys`, () => {
    const problems = [];
    for (const [tool, keys] of SCHEMA) {
      const re1 = new RegExp('(?:^|[^A-Za-z0-9_])' + tool + '`?\\s*\\(([^)]*)\\)', 'g');
      const re2 = new RegExp('(?:^|[^A-Za-z0-9_])' + tool + '`?\\s+((?:[A-Za-z_]+=[^\\s,;)]+[,\\s]*)+)', 'g');
      for (const re of [re1, re2]) {
        for (const m of prompt.matchAll(re)) {
          for (const k of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)) {
            if (!keys.has(k[1])) problems.push(`${tool}: "${k[1]}" is not an input_schema key (${[...keys].join(', ')})`);
          }
        }
      }
    }
    assert.deepEqual(problems, []);
  });
}

test('state machine: a REJECTED finish keeps compose, a PASSED finish moves to finalize (the contract RUNTIME STATES describes)', () => {
  const sm = new StateMachine(250); sm.state = 'compose';
  sm.recordToolCall('finish', {}, 'FINISH REJECTED - x');
  assert.equal(sm.state, 'compose');
  sm.recordToolCall('finish', {}, 'Finished (quality gates PASSED). Final artifact: v1');
  assert.equal(sm.state, 'finalize');
});
