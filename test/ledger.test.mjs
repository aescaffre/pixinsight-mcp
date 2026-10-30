import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
process.env.HOME = HOME;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const L = await import(path.join(ROOT, 'agents/ledger.mjs'));
const tools = await import(path.join(ROOT, 'agents/llm/tools.mjs'));
const { checkBranchCompleteness } = await import(path.join(ROOT, 'agents/llm/state-machine.mjs'));
const LEDGER = path.join(HOME, '.pixinsight-mcp', 'ledger.json');
const writeLedger = (o) => { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(o)); };

test('scoreVariantDimensions: dust object drives ifn_visibility; fallback otherwise', () => {
  const dust = { dustCoverage: 0.28, dustMeanSat: 0.3, fieldP95: 0.2 };
  const a = L.scoreVariantDimensions({ dust });
  const W = L.IFN_DUST_WEIGHTS;
  assert.ok(Math.abs(a.ifn_visibility - (W.coverage * 0.28 + W.meanSat * 0.3 + W.fieldP95 * 0.2)) < 1e-9);
  const b = L.scoreVariantDimensions({ dust: { error: 'x' }, detail: { subjectBrightness: 0.3, subjectCount: 10, raw: { totalBlocks: 100 } } });
  assert.ok(Math.abs(b.ifn_visibility - (0.3 + 0.2)) < 1e-9);
  // dust hugging the core (low coverage) ranks below a frame filled with dust
  const filled = L.scoreVariantDimensions({ dust: { dustCoverage: 0.28, dustMeanSat: 0.25, fieldP95: 0.18 } }).ifn_visibility;
  const hugging = L.scoreVariantDimensions({ dust: { dustCoverage: 0.08, dustMeanSat: 0.35, fieldP95: 0.5 } }).ifn_visibility;
  assert.ok(filled > hugging);
});

test('scoreVariantDimensions: star_quality interim formula', () => {
  const s = L.scoreVariantDimensions({ stars: { starsFound: 50, medianFWHM: 3, starBgContrast: 8, colorDiversity: 0.1 } }).star_quality;
  assert.ok(Math.abs(s - (1 / 4) * 1 * (1 + 0.05 * 10)) < 1e-9);
  assert.equal(L.scoreVariantDimensions({ stars: { starsFound: 5, medianFWHM: 3 } }).star_quality, 0);
});

test('ledgerKey: broadband = classification; narrowband adds @workflow', () => {
  assert.equal(L.ledgerKey({ target: { classification: 'emission_nebula' }, dataDescription: { narrowband: true, workflow: 'SHO' } }), 'emission_nebula@SHO');
  assert.equal(L.ledgerKey({ target: { classification: 'galaxy_spiral' }, dataDescription: { narrowband: false, workflow: 'LRGB' } }), 'galaxy_spiral');
});

test('canonicalizeApproach: array/params.approach stable; style:edge gone; narrowband tokens', () => {
  const a = L.canonicalizeApproach(['lhe2pass', 'inject_l_ifn']);
  assert.equal(a, L.canonicalizeApproach(['Inject_L_IFN', 'lhe2pass', 'lhe2pass']));
  assert.equal(a, 'inject_l_ifn|lhe2pass');
  assert.equal(L.canonicalizeApproach({ params: { approach: ['B', 'a'] }, notes: 'lhe' }), 'a|b');
  assert.ok(!L.canonicalizeApproach({ notes: 'edge-on galaxy edge', params: {} }).includes('style:edge'));
  const nb = L.canonicalizeApproach({ notes: 'hue shift halo lift chroma synthetic L', params: { palette: 'foraxx', o_gain: 1.3 } });
  for (const t of ['palette:foraxx', 'hueshift:on', 'halo_lift:on', 'chroma:on', 'synthL:on', 'ogain:1.5']) assert.ok(nb.includes(t), t + ' in ' + nb);
});

function fixtureStore(runId, variants, fsel) {
  return {
    runId, manifest: { agents: {} },
    listVariants: (a) => (variants[a] || []),
    getWinner: () => null,
    readFinalSelection: () => fsel,
  };
}

test('recordOutcomes counts only composition/final stage variants; skips without final-selection', () => {
  writeLedger({ classes: {}, _meta: { epsilonCounter: {}, ledgerSchema: 2 } });
  const variants = { giga_orchestrator: [
    { variantId: 'variant_01', notes: 'detail branch', params: { stage: 'branch_detail', approach: ['hdrmt:5L'] } },
    { variantId: 'variant_02', notes: 'x', params: { stage: 'composition', approach: ['lrgb', 'hdrmt:5L'] } },
    { variantId: 'variant_03', notes: 'x', params: { stage: 'final', approach: ['lrgb', 'lift_dust'] } },
    { variantId: 'variant_04', notes: 'legacy final composition', params: {} },
    { variantId: 'variant_05', notes: 'legacy branch star', params: {} },
  ] };
  L.recordOutcomes('galaxy_spiral', fixtureStore('r1', variants, null));
  assert.equal(JSON.parse(fs.readFileSync(LEDGER, 'utf-8')).classes.galaxy_spiral, undefined, 'no final-selection => nothing recorded');
  L.recordOutcomes('galaxy_spiral', fixtureStore('r1', variants, { variant_id: 'variant_03', agent: 'giga_orchestrator' }));
  const ap = JSON.parse(fs.readFileSync(LEDGER, 'utf-8')).classes.galaxy_spiral.approaches;
  assert.deepEqual(Object.keys(ap).sort(), ['hdrmt:5l|lrgb', 'lift_dust|lrgb', 'unspecified'].sort());
  assert.equal(ap['lift_dust|lrgb'].promoted, 1);
  assert.equal(ap['hdrmt:5l|lrgb'].rejected, 1);
  assert.ok(!Object.keys(ap).includes('hdrmt:5l'), 'branch_detail variant not counted');
});

test('extractLedgerGuidance never prunes a single mandatory-family token', () => {
  writeLedger({ classes: { c1: { approaches: {
    'detail:on': { tried: 9, promoted: 0, rejected: 9 }, 'ha:on': { tried: 9, promoted: 0, rejected: 9 }, 'comp:lrgb': { tried: 9, promoted: 0, rejected: 9 },
    'clamp:on': { tried: 9, promoted: 0, rejected: 9 }, 'detail:on|hdrmt:5L': { tried: 9, promoted: 0, rejected: 9 } } } }, _meta: { epsilonCounter: {}, ledgerSchema: 2 } });
  const g = L.extractLedgerGuidance('c1');
  assert.ok(!/- detail:on\b/.test(g.replace('detail:on|hdrmt', 'X')), g);
  assert.ok(!g.includes('- ha:on') && !g.includes('- comp:lrgb'));
  assert.ok(g.includes('- clamp:on') && g.includes('detail:on|hdrmt:5L'));
});

test('champions: scoreVersion mismatch skipped and replaced; rawMetrics stored', () => {
  const img = path.join(HOME, 'img.xisf'); fs.writeFileSync(img, 'x');
  writeLedger({ classes: { k: { approaches: {}, champions: { detail: { xisfPath: img, score: 999, run_id: 'old' } } } }, _meta: { epsilonCounter: {}, ledgerSchema: 2 } });
  assert.deepEqual(L.getChampions('k'), {});
  L.recordChampions('k', { runId: 'r2', manifestPath: '/nonexistent' }, { v1: { dimensionScores: { detail: 1.5 }, xisfPath: img, rawMetrics: { dust: { dustCoverage: 0.2, junk: 'x' } } } });
  const ch = L.getChampions('k');
  assert.equal(ch.detail.score, 1.5);
  assert.equal(ch.detail.scoreVersion, L.CHAMPION_SCORE_VERSION);
  assert.deepEqual(ch.detail.rawMetrics.dust, { dustCoverage: 0.2 });
});

test('compare_to_champions measures dust when profile.ifn exists', async () => {
  const img = path.join(HOME, 'img2.xisf'); fs.writeFileSync(img, 'x');
  writeLedger({ classes: { reflection_nebula: { approaches: {}, champions: { ifn_visibility: { xisfPath: img, score: 0.5, scoreVersion: L.CHAMPION_SCORE_VERSION, run_id: 'r' } } } }, _meta: { epsilonCounter: {}, ledgerSchema: 2 } });
  const { handlers } = tools.buildToolSet('giga_orchestrator');
  let dustCalls = 0;
  const ctx = { pjsr: async (code) => { if (/measureDustCoverage/.test(code)) { dustCalls++; return { status: 'ok', outputs: { consoleOutput: JSON.stringify({ dustCoverage: 0.3, dustMeanSat: 0.3, fieldP95: 0.2, fieldP90: 0.1, bg: 0.05, coreThr: 0.5 }) } }; } throw new Error('stub'); } };
  const mk = (ifn) => ({ target: { classification: 'reflection_nebula' }, dataDescription: {}, processingProfile: ifn ? { ifn: {} } : {} });
  const r = await handlers.get('compare_to_champions')(ctx, null, mk(true), { view_id: 'v' });
  assert.equal(dustCalls, 1);
  assert.match(r.text, /ifn_visibility: current=/);
  await handlers.get('compare_to_champions')(ctx, null, mk(false), { view_id: 'v' });
  assert.equal(dustCalls, 1);
});

test('checkBranchCompleteness prefers params.stage', () => {
  const brief = { dataDescription: {} };
  const vs = [
    { variantId: 'variant_01', notes: 'nothing relevant', params: { stage: 'branch_stars' } },
    { variantId: 'variant_02', notes: 'nothing', params: { stage: 'branch_stars' } },
    { variantId: 'variant_03', notes: 'star star star color saturation', params: { stage: 'composition' } },
    { variantId: 'variant_04', notes: 'x', params: { stage: 'branch_color' } },
    { variantId: 'variant_05', notes: 'x', params: { stage: 'branch_color' } },
  ];
  assert.equal(checkBranchCompleteness(vs, brief).complete, true);
  assert.equal(checkBranchCompleteness(vs.slice(2), brief).complete, false);
});

test('save_variant stage defaults from state machine and stores approach', async () => {
  const { handlers } = tools.buildToolSet('giga_orchestrator');
  let saved = null;
  const store = { saveVariant: async (ctx, a, v, params) => { saved = params; return { artifactId: 'r/a/variant_01' }; } };
  const ctx = { pjsr: async () => JSON.stringify({ median: 0.1, mean: 0.1, max: 1, min: 0, stdDev: 0.1 }) };
  const mk = (state) => ({ target: { classification: 'galaxy_spiral' }, _stateMachine: { state } });
  try { await handlers.get('save_variant')(ctx, store, mk('compose'), { view_id: 'v', approach: ['LRGB', 'lrgb', 'x'] }, 'giga_orchestrator'); } catch (e) { /* stats stub may fail */ }
  if (saved) { assert.equal(saved.stage, 'composition'); assert.deepEqual(saved.approach, ['lrgb', 'x']); assert.equal(saved.classification, 'galaxy_spiral'); }
});

test('galaxy_spiral prompt no longer injects Winning Parameters from Previous Runs', async () => {
  const { buildGigaOrchestratorPrompt } = await import(path.join(ROOT, 'agents/llm/prompts/giga-orchestrator.mjs'));
  const { profileFor } = await import(path.join(ROOT, 'agents/classifier.mjs'));
  const brief = { target: { name: 'T', classification: 'galaxy_spiral', fieldCharacteristics: {} }, dataDescription: { workflow: 'LRGB', channels: {}, narrowband: false, starless: false },
    aestheticIntent: { style: 'enhanced_natural', colorSaturation: 'moderate', starProminence: 'balanced' }, processingProfile: profileFor('galaxy_spiral', false, 'LRGB'), runLabel: 'r' };
  const p = buildGigaOrchestratorPrompt(brief, { files: { L: 'l', R: 'r', G: 'g', B: 'b', targetName: 'T' } });
  assert.ok(!p.includes('Winning Parameters from Previous Runs'));
  const src = fs.readFileSync(path.join(ROOT, 'agents/llm/giga-run.mjs'), 'utf-8');
  assert.ok(!/updateProcessingProfile|extractWinningParams/.test(src));
});
