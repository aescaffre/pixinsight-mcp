import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolate from the user's real ledger (champions change the prompt).
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-render-'));
process.env.PIXINSIGHT_MCP_NO_AUTO_REFERENCE = '1';   // goldens must not depend on the registry / mounted volumes

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildGigaOrchestratorPrompt } = await import(path.join(ROOT, 'agents/llm/prompts/giga-orchestrator.mjs'));
const { profileFor, generateBrief } = await import(path.join(ROOT, 'agents/classifier.mjs'));
const tools = await import(path.join(ROOT, 'agents/llm/tools.mjs'));

const GOLDEN = path.join(ROOT, 'test/golden/prompt-emission-vivid.txt');

function fixture(cls, sat, workflow = 'HaLRGB') {
  return {
    target: { name: 'T', classification: cls, fieldCharacteristics: {} },
    dataDescription: { workflow, channels: {}, narrowband: false, starless: false },
    aestheticIntent: { style: 'enhanced_natural', colorSaturation: sat, starProminence: 'balanced' },
    processingProfile: profileFor(cls, false, workflow),
    runLabel: 'r',
  };
}
const cfg = { files: { L: 'l.xisf', R: 'r.xisf', G: 'g.xisf', B: 'b.xisf', Ha: 'h.xisf', targetName: 'T' } };
const render = (cls, sat) => buildGigaOrchestratorPrompt(fixture(cls, sat), cfg);

test('galaxy_spiral moderate: natural broadband branch C, no vivid bracket', () => {
  const p = render('galaxy_spiral', 'moderate');
  assert.ok(p.includes('NATURAL BROADBAND'));
  assert.ok(!p.includes('0.65 → 0.75 → 0.85'));
  assert.ok(p.includes('P90 target 0.4'));
  assert.ok(p.includes('0.58 (target)') && p.includes('(push)'));   // 2026-10-31: two-candidate brackets
  assert.ok(p.includes('equally disqualifying'));
});

test('galaxy_cluster vivid keeps the classic text', () => {
  const p = render('galaxy_cluster', 'vivid');
  assert.ok(!p.includes('NATURAL BROADBAND'));
  assert.ok(p.includes('0.65 → 0.75 → 0.85'));
});

test('planetary nebula never gets the natural block', () => {
  const p = render('planetary_nebula', 'vivid');
  assert.ok(!p.includes('NATURAL BROADBAND'));
  assert.ok(p.includes('NARROWBAND-STYLE COLOR PROCESSING'));
});

test('emission vivid render equals golden snapshot', () => {
  const p = render('emission_nebula', 'vivid');
  if (process.env.UPDATE_GOLDEN || !fs.existsSync(GOLDEN)) { fs.mkdirSync(path.dirname(GOLDEN), { recursive: true }); fs.writeFileSync(GOLDEN, p); }
  assert.equal(p, fs.readFileSync(GOLDEN, 'utf-8'));
});

test('classifier: galaxies moderate, cluster and nebulae vivid, config override wins', () => {
  const mk = (name, extra = {}) => generateBrief({ files: { targetName: name, L: 'l' }, ...extra }, {});
  assert.equal(mk('NGC 3628').aestheticIntent.colorSaturation, 'moderate');
  assert.equal(mk('M27').aestheticIntent.colorSaturation, 'vivid');
  assert.equal(generateBrief({ files: { targetName: 'M81' }, aesthetic: { colorSaturation: 'muted' } }, {}).aestheticIntent.colorSaturation, 'muted');
  assert.equal(generateBrief({ files: { targetName: 'M81' } }, { colorSaturation: 'vivid' }).aestheticIntent.colorSaturation, 'vivid');
});

test('Gate 7 thresholds: galaxy_spiral 0.45 warns (look.target), blocks only above max_p90+margin; emission 0.80 passes', () => {
  const g = { processingProfile: profileFor('galaxy_spiral', false, 'LRGB') };
  const e = { processingProfile: profileFor('emission_nebula', false, 'LRGB') };
  assert.equal(tools.evaluateSaturationGate(0.45, g), 'warning');
  // look.* is PROVISIONAL (no back-test): it only moves the warning tier, never the blocking level
  assert.equal(tools.evaluateSaturationGate(0.55, g), 'warning');
  const gFail = tools.saturationThresholds(g).failAt;
  assert.equal(tools.evaluateSaturationGate(gFail + 0.01, g), 'failure');
  assert.equal(tools.evaluateSaturationGate(0.30, g), 'pass');
  assert.notEqual(tools.evaluateSaturationGate(0.80, e), 'failure'); // warns above target 0.75, fails only above 0.85
  assert.equal(tools.evaluateSaturationGate(0.70, e), 'pass');
  // class without look keeps max_p90 warn / +0.10 fail
  const r = { processingProfile: profileFor('reflection_nebula', false, 'LRGB') };
  const mx = r.processingProfile.saturation.max_p90;
  assert.equal(tools.evaluateSaturationGate(mx + 0.05, r), 'warning');
  assert.equal(tools.evaluateSaturationGate(mx + 0.12, r), 'failure');
});

test('ledger color_richness: galaxy uses closeness to target; others keep cap formula', async () => {
  const { scoreVariantDimensions } = await import(path.join(ROOT, 'agents/ledger.mjs'));
  const sat = { p90S: 0.40 };
  assert.ok(Math.abs(scoreVariantDimensions({ saturation: sat, classification: 'galaxy_spiral', targetP90: 0.40, maxP90: 0.5 }).color_richness - 1) < 1e-9);
  const lo = scoreVariantDimensions({ saturation: { p90S: 0.20 }, classification: 'galaxy_spiral', targetP90: 0.40 }).color_richness;
  assert.ok(Math.abs(lo - 0.5) < 1e-9);
  assert.equal(scoreVariantDimensions({ saturation: sat, classification: 'emission_nebula', maxP90: 0.85 }).color_richness, 0.40);
});

test('profiles: look blocks present and flagged provisional; dead keys gone', () => {
  const prof = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents/processing-profiles.json'), 'utf-8'));
  for (const k of ['galaxy_spiral', 'galaxy_elliptical', 'galaxy_edge_on', 'galaxy_cluster', 'emission_nebula', 'planetary_nebula', 'supernova_remnant', 'narrowband_palette']) {
    assert.match(prof[k].look._calibration, /PROVISIONAL/, k);
  }
  const txt = JSON.stringify(prof);
  for (const dead of ['rgb_initial', 'composition_target', 'blue_boost', 'pink_boost']) assert.ok(!txt.includes(dead), dead);
  assert.equal(prof.galaxy_spiral.tools.LRGB.saturation, 0.50);
});

// ---- WI-04 star contract ----
function starBrief(cls, wf = 'LRGB') {
  const b = fixture(cls, 'moderate', wf);
  b.target.name = 'T';
  b.aestheticIntent.starProminence = b.processingProfile.stars?.prominence;
  return b;
}

for (const cls of ['galaxy_edge_on', 'reflection_nebula', 'planetary_nebula']) {
  test(`star contract renders once and matches profile: ${cls}`, () => {
    const b = starBrief(cls);
    const p = buildGigaOrchestratorPrompt(b, cfg);
    const S = b.processingProfile.stars;
    assert.equal(p.split('Star prominence:').length - 1, 1);
    assert.ok(!p.includes('0.85 max'));
    assert.ok(!p.includes('do NOT go below 0.90'));
    assert.ok(p.includes(`stretch_stars midtone=${S.stretch_midtone ?? (cls.startsWith('galaxy') ? 0.25 : 0.20)}, iterations=${S.stretch_iterations ?? (cls.startsWith('galaxy') ? 4 : 5)}`));
    assert.ok(p.includes(`blend strength default ${S.screen_blend_strength ?? 0.95}`));
    assert.ok(p.includes(`**${S.prominence}**`));
  });
}

test('starless brief skips the star contract', () => {
  const b = starBrief('emission_nebula'); b.dataDescription.starless = true;
  assert.ok(!buildGigaOrchestratorPrompt(b, cfg).includes('STAR CONTRACT'));
});

test('classifier: starProminence comes from the profile', () => {
  const b = generateBrief({ files: { targetName: 'NGC 3628', L: 'l' } }, {});
  assert.equal(b.aestheticIntent.starProminence, b.processingProfile.stars.prominence);
  assert.equal(b.aestheticPreferences.starPresence, b.processingProfile.stars.prominence);
  assert.equal(profileFor('galaxy_spiral', false).stars.screen_blend_strength, 0.95);
});

// ---- WI-09: prompt consistency pass ----
const CONFIG_FILES = fs.readdirSync(ROOT).filter((f) => f.endsWith('_agentic.json')).sort();
const renderConfig = (f) => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf-8'));
  const brief = generateBrief(c, {});
  return { brief, cfg: c, prompt: buildGigaOrchestratorPrompt(brief, c) };
};
// Ratchet: the measured maximum after WI-09 (M27_HaLRGB 41507 chars). Lower it when the prompt shrinks; never raise it silently.
const PROMPT_CHAR_RATCHET = 42250; // 2026-10-29: +~190 chars for the two user-approved gate rows (background_floor, star_retention); // WI-22: +55 chars for the post-stretch scoping of the per-channel prohibition; WI-23: +~220 chars BXT double-sharpen warning (broadband)
const BANNED = [/metrics lie/i, /Trust your eyes/i, /FEEL something/i, /Would I be proud/i, /Visual assessment OVERRIDES/i, /KNOWN BUG/, /Previous failures/, /\bv\d+ (had|showed|failure)/, /\bPhase \d/i, /LRGB COMBINE IS NOT OPTIONAL/, /GLOBAL inverted HDRMT/];

for (const f of CONFIG_FILES) {
  test(`${f}: renders within the size ratchet, no duplicate numbered headings, no banned phrases, one gate table`, () => {
    const { prompt } = renderConfig(f);
    assert.ok(prompt.length <= PROMPT_CHAR_RATCHET, `${prompt.length} > ${PROMPT_CHAR_RATCHET}`);
    const heads = [...prompt.matchAll(/^### (\d+)\. /gm)].map((m) => m[1]);
    assert.equal(new Set(heads).size, heads.length, `duplicate ### N. headings: ${heads}`);
    for (const re of BANNED) assert.ok(!re.test(prompt), `banned phrase ${re}`);
    assert.equal(prompt.split('### GATE TABLE').length - 1, 1);
    assert.ok(prompt.includes('| noise_bg | check_noise |'));
    assert.ok(prompt.includes('RUNTIME STATES (enforced by the harness)'));
    assert.ok(prompt.includes('KNOWN FLAWS:'));
    assert.ok(prompt.includes('Prep is done by deterministic prep from the processing profile'));
  });
}

test('NGC7023 shows the dust block rendered from profile.ifn; LDN15 only if its profile has ifn', () => {
  const n = renderConfig('NGC7023_HaLRGB_agentic.json');
  assert.ok(n.brief.processingProfile.ifn);
  assert.ok(n.prompt.includes('BRANCH B — FAINT STRUCTURE REVEAL (IFN / dust / halo)'));
  const ifn = n.brief.processingProfile.ifn;
  assert.ok(n.prompt.includes(`dustMeanSat >= ${ifn.min_dust_mean_sat} AND fieldP95 >= ${ifn.min_field_p95}; GOAL dustCoverage >= ${ifn.min_dust_coverage}`));
  assert.ok(n.prompt.includes('FAILS only when the dust is greyed AND crushed AND warmDustFraction'));
  assert.ok(n.prompt.indexOf('`run_scnr`') < n.prompt.indexOf('`inject_l_ifn` (strength'));
  assert.ok(n.prompt.indexOf('`inject_l_ifn` (strength') < n.prompt.indexOf('`lift_dust` —'));
  assert.ok(!n.prompt.includes('v6 had dramatic IFN'));
  const l = renderConfig('LDN15_LRGB_agentic.json');
  assert.equal(l.prompt.includes("rendered from this class's profile.ifn"), !!l.brief.processingProfile.ifn);
});

test('hasDustField: galaxies with IFN get the reveal branch without a fabricated gate contract', () => {
  const m = renderConfig('M81_LRGB_agentic.json');
  assert.ok(m.brief.target.fieldCharacteristics.hasIFN);
  assert.ok(m.prompt.includes('FAINT STRUCTURE REVEAL'));
  assert.ok(m.prompt.includes('declares no profile.ifn block'));
});

test('taxonomy: reflection and dark nebulae carry hasDust without flipping hasIFN', () => {
  const tax = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents/target-taxonomy.json'), 'utf-8'));
  for (const k of ['reflection_nebula', 'dark_nebula']) {
    assert.equal(tax.categories[k].traits.hasDust, true);
    assert.equal(tax.categories[k].traits.hasIFN, false);
  }
});

test('LRGB decision block replaces the unconditional mandate (M97, NGC891) and respects profile avoid', () => {
  for (const f of ['M97_LRGB_agentic.json', 'NGC891_LRGB_agentic.json']) {
    const { prompt, brief } = renderConfig(f);
    assert.ok(!prompt.includes('LRGB COMBINE IS NOT OPTIONAL'));
    assert.ok(prompt.includes('L INCORPORATION DECISION'));
    assert.ok(prompt.includes('Incorporate L by the decision above'));
    if (brief.processingProfile.tools?.LRGB?.use === 'avoid') assert.ok(prompt.includes('CLOSED here'));
  }
  const n = renderConfig('NGC3628_LRGB_agentic.json').prompt;
  assert.ok(n.includes('ratio <= 2 AND the profile does not avoid LRGB'));
});

test('PNe: continuous clamp renamed, global HDRMT mandate gone, donut recipe offered as a TRY in the branch phase', () => {
  for (const f of ['M97_LRGB_agentic.json', 'M27_HaLRGB_agentic.json']) {
    const { prompt, brief } = renderConfig(f);
    assert.equal(brief.target.classification, 'planetary_nebula');
    assert.ok(prompt.includes('CONTINUOUS CLAMP (mandatory pre-star) + HDRMT (optional, branch phase only)'));
    assert.ok(!/GLOBAL inverted HDRMT|Why this works|Key principle/.test(prompt));
    assert.ok(!/\bv(7|8|10|11|12)\b/.test(prompt));
    assert.ok(prompt.includes('`$T*(1-$T)*4`'));
    assert.ok(prompt.includes('run_hdrmt` (inverted=true, layers=5, iterations=1)'));
    assert.ok(prompt.indexOf('PNe HDRMT OPTION') < prompt.indexOf('BRANCH B'));
    assert.ok(prompt.includes('HDRMT only through a donut mask'));
  }
});

test('ranking section: gates, then reference, then critic, then metrics; previews are a named-artifact veto only', () => {
  const { prompt } = renderConfig('NGC3628_LRGB_agentic.json');
  assert.ok(prompt.includes('ARTIFACT INSPECTION + RANKING'));
  assert.ok(prompt.includes('NAMED-ARTIFACT VETO ONLY'));
  assert.ok(prompt.includes("phase='composition_critic'"));
  assert.ok(/numeric score is NOT used for ranking/.test(prompt));
  const withRef = buildGigaOrchestratorPrompt({ ...fixture('galaxy_spiral', 'moderate', 'LRGB'), reference_path: '/tmp/ref.xisf' }, cfg);
  assert.ok(withRef.includes('Reference image registered: `/tmp/ref.xisf`'));
  assert.ok(withRef.includes('`compare_to_reference` on the top 3, SEQUENTIALLY'));
  assert.ok(!render('galaxy_spiral', 'moderate').includes('compare_to_reference` on the top 3'));
  // vivid intent keeps 'reject safe-but-dull'; natural intent does not
  assert.ok(render('galaxy_cluster', 'vivid').includes('REJECT safe but dull outcomes'));
  assert.ok(!render('galaxy_spiral', 'moderate').includes('REJECT safe but dull outcomes'));
});

test('prep-owned numbers come from the profile stretch block', () => {
  const b = fixture('galaxy_spiral', 'moderate', 'LRGB');
  b.processingProfile = { ...b.processingProfile, stretch: { target_median: 0.0777, headroom: 0.0333 } };
  const p = buildGigaOrchestratorPrompt(b, cfg);
  assert.ok(p.includes('median 0.0777 with headroom 0.0333'));
  assert.ok(!p.includes('Headroom 0.12 for galaxies'));
});

test('gate table: aesthetic row shows the real (advisory) status; outer_halo classes listed', async () => {
  const { renderGateTable } = await import(path.join(ROOT, 'agents/llm/prompts/giga-orchestrator.mjs'));
  const t = renderGateTable(fixture('galaxy_edge_on', 'moderate', 'LRGB'));
  assert.match(t, /\| aesthetic \| aesthetic_critic \|[^\n]*\| ADVISORY \|/);
  assert.match(t, /outer_halo \([^)]*galaxy_edge_on/);
});

test('finish: remaining_flaws in the schema, Critical summary lists flaws first', () => {
  const { definitions } = tools.buildToolSet('giga_orchestrator');
  const fin = definitions.find((d) => d.name === 'finish');
  assert.ok(fin.input_schema.properties.remaining_flaws);
  assert.ok(!fin.input_schema.required.includes('remaining_flaws'));
  const txt = tools.formatCriticalSummary({
    remaining_flaws: ['faint dark rim at the core'], critic: { score: 6.5, flaws: ['stars slightly bloated'], min: null },
    reference: null, gates: { nearest: ['noise_bg 0.02 (limit <= 0.022, margin 9%)'] }, warnings: ['Very few stars detected (12).'],
  });
  const lines = txt.split('\n');
  assert.equal(lines[0], 'CRITICAL SUMMARY (flaws first)');
  assert.ok(txt.indexOf('faint dark rim') < txt.indexOf('Independent critic'));
  assert.ok(txt.includes('Reference: no reference'));
  assert.ok(txt.includes('noise_bg 0.02'));
  assert.ok(txt.includes('Very few stars detected'));
  assert.ok(tools.formatCriticalSummary(null).includes('No final selection'));
  assert.ok(tools.formatCriticalSummary({}).includes('NOT REPORTED'));
  const near = tools.nearestGateMargins({ detail: { subjectBrightness: 0.30, contrastRatio: 9 }, noise: { bgNoise: 0.021, dustNoise: 0.01 } }, fixture('galaxy_spiral', 'moderate', 'LRGB'));
  assert.ok(near[0].startsWith('noise_bg') || near[0].startsWith('subject_brightness'));
});

test('giga-run wrap-up: critical summary first, no celebratory banner, diagnostics passed to the agent', () => {
  const src = fs.readFileSync(path.join(ROOT, 'agents/llm/giga-run.mjs'), 'utf-8');
  assert.ok(!src.includes('GIGA Processing complete!'));
  assert.ok(src.includes('Run finished — review the flaws above; final judgment is yours.'));
  assert.ok(src.indexOf('console.log(criticalBlock)') < src.indexOf('Run finished'));
  assert.ok(src.includes('agent.run(initialText, [...diagPaths, ...lDiagPaths])'));
  assert.ok(!/buildImageMessage/.test(src));
  assert.ok(src.includes('Read the overview and corner crop before branching'));
  assert.ok(src.includes('Finish Gate 3e will reject greyed/crushed dust'));
});

test('PACMAN SHO render equals its golden snapshot (written on first run; regenerate deliberately with UPDATE_GOLDEN=1)', () => {
  const g = path.join(ROOT, 'test/golden/prompt-pacman-sho.txt');
  const { prompt } = renderConfig('PACMAN_SHO_agentic.json');
  if (process.env.UPDATE_GOLDEN || !fs.existsSync(g)) fs.writeFileSync(g, prompt);
  assert.equal(prompt, fs.readFileSync(g, 'utf-8'));
});

// ---- WI-11: narrowband path ----
for (const f of ['NGC7023_HaLRGB', 'M97_LRGB', 'NGC891_LRGB']) {
  test(`broadband render byte-identical to golden: ${f}`, () => {
    const g = path.join(ROOT, `test/golden/prompt-${f}.txt`);
    const { prompt } = renderConfig(`${f}_agentic.json`);
    if (process.env.UPDATE_GOLDEN || !fs.existsSync(g)) fs.writeFileSync(g, prompt);
    assert.equal(prompt, fs.readFileSync(g, 'utf-8'));
  });
}

test('PACMAN_SHO render: no broadband sections, verbatim palette recipe', () => {
  const { prompt } = renderConfig('PACMAN_SHO_agentic.json');
  for (const bad of ['SPCC', 'ha_inject', 'BRANCH D', 'COMP_boldIFN', 'stretch_stars FIRST', 'extract_pseudo_oiii', 'run_abe', 'star_protected_blend for star reintegration']) {
    assert.ok(!prompt.includes(bad), `unexpected: ${bad}`);
  }
  assert.ok(prompt.includes('### Palette branch (replaces Branch C (colour)) — bracket, don\'t guess'));
  assert.ok(prompt.includes('1. suggest_narrowband_balance → starting s_gain / o_gain.'));
  assert.ok(prompt.includes('3. For classic sho: sho_hue_shift (strength 0.7 / 0.9) folds Ha-green to gold.'));
  assert.ok(prompt.includes('9. **USER-APPROVED FINAL TOUCH (PACMAN "really perfect"):**'));
  assert.ok(prompt.includes('10. Luminance option:'));
  assert.ok(prompt.includes('Stars: none (starless deliverable)'));
  assert.ok(prompt.includes('begin_composition'));
  assert.ok(prompt.includes('COMP_palette_foraxx') && prompt.includes('COMP_palette_sho') && prompt.includes('COMP_halo_lift'));
  const pal = prompt.slice(prompt.indexOf('### Palette branch'), prompt.indexOf('## STARS'));
  assert.equal((pal.match(/^9\. /gm) || []).length, 1);
});

test('HOO render: hoo_o_weight bracket, no sho_hue_shift, only delivered channels', () => {
  const { prompt, brief } = renderConfig('NGC6888_HOO_agentic.json');
  assert.equal(brief.dataDescription.workflow, 'HOO');
  assert.ok(prompt.includes('hoo_o_weight'));
  assert.ok(!prompt.includes('sho_hue_shift'));
  assert.ok(!prompt.includes('FILTER_S'));
  assert.ok(!prompt.includes('SPCC'));
  assert.ok(prompt.includes('COMP_palette_hoo'));
});

test('star_protected_blend refuses on a starless brief without touching ctx', async () => {
  const ctx = new Proxy({}, { get() { throw new Error('ctx must not be used'); } });
  const r = await tools.TOOL_CATALOG.star_protected_blend.handler(ctx, {}, { dataDescription: { starless: true } }, { target_id: 'A', stars_id: 'B' });
  assert.match(r.text, /^REFUSED: starless deliverable/);
  const r2 = await tools.TOOL_CATALOG.star_screen_blend.handler(ctx, {}, { dataDescription: { starless: true } }, { target_id: 'A', stars_id: 'B' });
  assert.match(r2.text, /^REFUSED: starless deliverable/);
});

test('sho_combine: HOO brief resolves palette hoo and a null S view; SHO default foraxx; non-hoo without SII is refused', async () => {
  const hoo = { dataDescription: { workflow: 'HOO', channels: { Ha: true, O: true, S: false } } };
  const sho = { dataDescription: { workflow: 'SHO', channels: { Ha: true, O: true, S: true } } };
  assert.deepEqual(tools.resolveShoInputs(hoo, {}), { palette: 'hoo', s_id: null });
  assert.deepEqual(tools.resolveShoInputs(sho, {}), { palette: 'foraxx', s_id: 'FILTER_S' });
  assert.match(tools.resolveShoInputs(hoo, { palette: 'sho' }).error, /needs SII; this is an HOO dataset/);
  const r = await tools.TOOL_CATALOG.sho_combine.handler({}, {}, hoo, { palette: 'foraxx' });
  assert.match(r.text, /needs SII/);
});

test('measurePaletteBalance hoo notes drop foraxx/sho_hue_shift advice (text rule)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'agents/ops/sho-palette.mjs'), 'utf-8');
  assert.ok(src.includes("opts.palette === 'hoo'"));
  assert.ok(src.includes('OIII not reading: raise o_gain or hoo_o_weight'));
});

test('channel_balanced is skipped when maxChannelImbalance is null (narrowband brief)', async () => {
  const { checkHardConstraints } = await import(path.join(ROOT, 'agents/scoring.mjs'));
  const stats = { median: 0.1, max: 0.9, perChannel: { R: { median: 0.30 }, G: { median: 0.05 }, B: { median: 0.20 } } };
  const nb = renderConfig('PACMAN_SHO_agentic.json').brief;
  assert.equal(nb.hardConstraints.maxChannelImbalance, null);
  assert.ok(!checkHardConstraints(stats, nb).violations.some(v => v.startsWith('channel_balanced')));
  const bb = { hardConstraints: { maxChannelImbalance: 0.05 } };
  assert.ok(checkHardConstraints(stats, bb).violations.some(v => v.startsWith('channel_balanced')));
});

test('memory: narrowband recall drops broadband-stamped universal entries and adds the starless header', async () => {
  const mem = await import(path.join(ROOT, 'agents/memory/hierarchical-memory.mjs'));
  const bbBrief = { target: { name: 'X', classification: 'emission_nebula', fieldCharacteristics: {} }, dataDescription: { workflow: 'HaLRGB', starless: false } };
  const nbBrief = { target: { name: 'X', classification: 'emission_nebula', fieldCharacteristics: {} }, dataDescription: { workflow: 'SHO', narrowband: true, starless: true } };
  const e = mem.saveEntry('universal', null, { title: 'BBRULE-star blend unlock', content: 'blend stars to unlock compose' }, bbBrief);
  assert.equal(e.workflow, 'HaLRGB');
  const n = mem.saveEntry('universal', null, { title: 'NBRULE', content: 'palette' }, nbBrief);
  assert.equal(n.starless, true);
  const rec = mem.recallForBrief(nbBrief);
  assert.ok(!rec.universal.some(x => x.title === 'BBRULE-star blend unlock'));
  assert.ok(rec.universal.some(x => x.title === 'NBRULE'));
  assert.ok(rec.summary.startsWith('NOTE: STARLESS NARROWBAND run'));
  assert.ok(mem.recallForBrief(bbBrief).universal.some(x => x.title === 'BBRULE-star blend unlock'));
});
