// ============================================================================
// Promotion Ledger — cross-run learning: record which approaches get PROMOTED
// (win) vs never win, so the pipeline stops re-trying things known not to work
// and fast-tracks reliable winners. Persistent across runs.
//
// The flow runs COMPETITIVE ATTEMPTS (the giga agent saves many variants; one is
// promoted at finish). Today every run restarts the branch search from zero.
// This ledger is the first LOSS-AWARE memory: it aggregates, per classification,
// each coarse approach-signature's tried/promoted/rejected counts, and feeds a
// PRUNE list (tried>=N, never promoted) + FAST-TRACK list back into the agent
// prompt. Epsilon-greedy re-admission prevents permanent lock-out.
//
// All functions are defensive: a ledger error must NEVER break a processing run.
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';

const LEDGER_PATH = path.join(os.homedir(), '.pixinsight-mcp', 'ledger.json');

// Pruning policy
const PRUNE_MIN_TRIED = 4;        // tried at least this many times...
const PRUNE_MAX_PROMOTED = 0;     // ...and never promoted -> prune
const FASTTRACK_MIN_TRIED = 3;
const FASTTRACK_MIN_RATE = 0.6;   // promoted/tried >= this -> fast-track
const EPSILON_EVERY = 10;         // every Nth run for a class, re-admit one pruned approach

function loadLedger() {
  let l;
  try { l = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8')); }
  catch { l = {}; }
  if (!l || typeof l !== 'object') l = {};
  if (!l.classes || typeof l.classes !== 'object') l.classes = {};
  if (!l._meta || typeof l._meta !== 'object') l._meta = { epsilonCounter: {} };
  if (!l._meta.epsilonCounter) l._meta.epsilonCounter = {};
  // WI-19 migration (idempotent): approach stats recorded before stage/approach metadata counted every
  // saved variant as 'tried' (churn runs recorded every signature as rejected) — reset them and the epsilon
  // counter, keep champions (stale-version champions are skipped by getChampions until re-recorded).
  if (l._meta.ledgerSchema !== 2) {
    for (const c of Object.values(l.classes)) { if (c && typeof c === 'object') c.approaches = {}; }
    l._meta.epsilonCounter = {};
    l._meta.ledgerSchema = 2;
  }
  return l;
}
function saveLedger(l) {
  try { fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true }); fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2) + '\n'); }
  catch (e) { /* non-fatal */ }
}

/** WI-19: ledger key. Broadband = classification; narrowband = `${classification}@${workflow}`. */
export function ledgerKey(brief) {
  const cls = brief?.target?.classification || '';
  if (!cls) return '';
  const dd = brief?.dataDescription || {};
  if (dd.narrowband) {
    const wf = dd.workflow || dd.palette || 'NB';
    return `${cls}@${wf}`;
  }
  return cls;
}

/** Normalise explicit approach tokens: lowercase, trimmed, deduped, sorted. */
function normalizeApproachTokens(arr) {
  const t = (arr || []).map(x => String(x).trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
  return Array.from(new Set(t)).sort();
}

/**
 * Coarse, stable signature for an approach from a variant's params + notes.
 * WI-19: an explicit `params.approach` (array of short tokens, set by save_variant) wins;
 * an array argument is treated as such a token list. Otherwise a token set is extracted
 * from a small known vocabulary — signatures must AGGREGATE across runs, not be unique.
 */
export function canonicalizeApproach(v) {
  if (!v) return 'unspecified';
  if (Array.isArray(v)) { const t = normalizeApproachTokens(v); return t.length ? t.join('|') : 'unspecified'; }
  const p = v.params || {};
  if (Array.isArray(p.approach) && p.approach.length) {
    const t = normalizeApproachTokens(p.approach);
    if (t.length) return t.join('|');
  }
  const notes = ((v.notes || '') + ' ' + (() => { try { return JSON.stringify(p); } catch { return ''; } })()).toLowerCase();
  const toks = [];
  // composition method
  if (p.composition_method) toks.push('comp:' + String(p.composition_method).toLowerCase().replace(/\s+/g, '_'));
  else if (/lrgb/.test(notes)) toks.push('comp:lrgb');
  else if (/rgb[_ ]?only|rgb-?direct/.test(notes)) toks.push('comp:rgbonly');
  // HDRMT
  if (p.hdrmt_layers !== undefined) toks.push('hdrmt:' + p.hdrmt_layers + 'L');
  else if (/hdrmt/.test(notes)) toks.push('hdrmt:on');
  // clamp / core compression
  if (/continuous_clamp|pedestal|clamp/.test(notes)) toks.push('clamp:on');
  // Ha
  if (p.ha_strength !== undefined || /ha[_ ]?inject|ha[_ ]?strength/.test(notes)) toks.push('ha:on');
  // SCNR / color work
  if (/scnr/.test(notes)) toks.push('scnr:on');
  // detail
  if (/lhe|multi[_ ]?scale|detail/.test(notes)) toks.push('detail:on');
  // style keywords (word-boundary match so 'edge' does not fire inside 'wedge'); style:edge removed (WI-19: matched "edge-on")
  ['bold', 'balanced', 'conservative', 'assertive', 'natural', 'vivid', 'synthetic'].forEach(k => {
    if (new RegExp('\\b' + k + '\\b').test(notes)) toks.push('style:' + k);
  });
  // narrowband tokens (WI-19)
  if (p.palette) toks.push('palette:' + String(p.palette).toLowerCase().replace(/\s+/g, '_'));
  if (p.hue_shift || p.hueshift || /hue[_ ]?shift/.test(notes)) toks.push('hueshift:on');
  if (p.halo_lift || /halo[_ ]?lift|lift[_ ]?faint[_ ]?halo/.test(notes)) toks.push('halo_lift:on');
  if (/chroma/.test(notes)) toks.push('chroma:on');
  if (p.synth_l || /synth(etic)?[_ ]?l\b|synthl/.test(notes)) toks.push('synthL:on');
  if (typeof p.o_gain === 'number' && isFinite(p.o_gain)) toks.push('ogain:' + (Math.round(p.o_gain * 2) / 2));
  toks.sort();
  return toks.length ? Array.from(new Set(toks)).join('|') : 'unspecified';
}

const APPROVED_REGISTRY = path.join(path.dirname(new URL(import.meta.url).pathname), 'calibration', 'approved-images.json');

/**
 * If xisfPath was copied to a durable approved location (giga-run --approve),
 * return that copy; otherwise return xisfPath unchanged. Run pruning deletes
 * ~/.pixinsight-mcp/runs/*, so champions should point at the durable copy.
 */
export function durableCopyFor(xisfPath) {
  try {
    const reg = JSON.parse(fs.readFileSync(APPROVED_REGISTRY, 'utf-8'));
    const hit = (reg.entries || []).find(e => e.sourceVariantPath === xisfPath && e.path && fs.existsSync(e.path.replace(/^~(?=\/|$)/, os.homedir())));
    if (hit) return hit.path.replace(/^~(?=\/|$)/, os.homedir());
  } catch (e) { /* registry missing/corrupt: keep original */ }
  return xisfPath;
}

/** Repoint already-recorded champions of a run from its variant XISF to the durable copy. */
export function repointChampions(classification, runId, fromPath, toPath) {
  try {
    const ledger = loadLedger();
    const champs = ledger.classes?.[classification]?.champions;
    if (!champs) return 0;
    let n = 0;
    for (const dim of Object.keys(champs)) {
      if (champs[dim].run_id === runId && champs[dim].xisfPath === fromPath) { champs[dim].xisfPath = toPath; n++; }
    }
    if (n) saveLedger(ledger);
    return n;
  } catch (e) { return 0; }
}

const FINAL_STAGES = new Set(['composition', 'final']);
const LEGACY_FINAL_RE = /final|composition|comp_/i;
/** WI-19: does this variant count as a "tried" end-to-end approach? Stage metadata wins; legacy falls back to notes. */
export function isFinalStageVariant(v) {
  const st = v?.params?.stage;
  if (typeof st === 'string' && st) return FINAL_STAGES.has(st);
  return LEGACY_FINAL_RE.test(String(v?.notes || v?.params?.notes || ''));
}

/**
 * Record the outcomes of a completed run: the promoted winner(s) + all rejected
 * composition/final variants, aggregated per coarse approach-signature, per ledger key
 * (see ledgerKey). Skipped entirely when the run has no final-selection (churn/aborted runs).
 */
export function recordOutcomes(classification, store) {
  if (!classification || !store) return;
  try {
    const ledger = loadLedger();

    const manifest = store.manifest || {};
    let agentNames = Object.keys(manifest.agents || {});
    // WI-08: manifest.agents also holds model-run records (no `winner`) — only count promoted winners.
    agentNames = agentNames.filter(n => manifest.agents[n] && manifest.agents[n].winner);
    for (const n of ['giga_orchestrator', 'composer', 'core_specialist']) if (!agentNames.includes(n)) agentNames.push(n);

    // Winner variant id from the final-selection record (giga flow). No record => nothing is learned.
    let fsel = null;
    try { fsel = store.readFinalSelection && store.readFinalSelection(); } catch (e) { /* */ }
    const winnerVariantId = fsel && fsel.variant_id;
    if (!winnerVariantId) { console.log(`  Ledger: no final-selection this run — nothing recorded for "${classification}".`); return; }
    const winnerAgent = fsel.agent || 'giga_orchestrator';

    const winnerSigs = new Set();
    const triedSigs = new Set();
    for (const agentName of agentNames) {
      // Legacy promoteWinner path (manifest.agents) — still supported.
      try { const w = store.getWinner && store.getWinner(agentName); if (w) winnerSigs.add(canonicalizeApproach(w)); } catch (e) { /* */ }
      let variants = [];
      try { variants = store.listVariants(agentName) || []; } catch (e) { /* */ }
      for (const v of variants) {
        const isWinner = v.variantId === winnerVariantId && agentName === winnerAgent;
        if (!isWinner && !isFinalStageVariant(v)) continue;
        const sig = canonicalizeApproach(v);
        triedSigs.add(sig);
        if (isWinner) winnerSigs.add(sig);
      }
    }
    for (const s of winnerSigs) triedSigs.add(s);
    if (triedSigs.size === 0) { console.log(`  Ledger: no composition/final variants found this run — nothing recorded for "${classification}".`); return; }

    ledger.classes[classification] = ledger.classes[classification] || { approaches: {} };
    const cls = ledger.classes[classification];
    cls.approaches = cls.approaches || {};
    let promotedN = 0;
    for (const sig of triedSigs) {
      const a = cls.approaches[sig] || { tried: 0, promoted: 0, rejected: 0, last_run: null };
      a.tried += 1;
      if (winnerSigs.has(sig)) { a.promoted += 1; promotedN++; } else { a.rejected += 1; }
      a.last_run = store.runId || a.last_run;
      cls.approaches[sig] = a;
    }
    // Advance epsilon counter on the WRITE path (once per run), so the read-only
    // guidance never mutates persistent state.
    ledger._meta = ledger._meta || { epsilonCounter: {} };
    ledger._meta.epsilonCounter[classification] = (ledger._meta.epsilonCounter[classification] || 0) + 1;
    saveLedger(ledger);
    console.log(`  Ledger: recorded ${triedSigs.size} approach(es) for "${classification}" (${promotedN} promoted, winner=${winnerVariantId}).`);
  } catch (e) {
    console.log(`  Ledger: record failed (non-fatal): ${e.message}`);
  }
}

/** WI-19: a single-token signature naming a mandatory family (detail:on, ha:on, comp:*) must never be pruned. */
export function isMandatoryFamilySignature(sig) {
  const toks = String(sig).split('|');
  if (toks.length !== 1) return false;
  return /^(detail:on|ha:on|comp:.+)$/.test(toks[0]);
}

/** Approaches that have been tried enough and never promoted (the prune set). */
export function getPrunedApproaches(classification) {
  try {
    const cls = loadLedger().classes[classification];
    if (!cls) return [];
    return Object.keys(cls.approaches).filter(k => {
      const a = cls.approaches[k];
      return a.tried >= PRUNE_MIN_TRIED && a.promoted <= PRUNE_MAX_PROMOTED && !isMandatoryFamilySignature(k);
    });
  } catch { return []; }
}

/**
 * Prompt guidance: PRUNE list (don't waste attempts) + FAST-TRACK list (reliable
 * winners), with epsilon-greedy re-admission so a pruned approach gets one probe
 * every EPSILON_EVERY runs (prevents permanent lock-out from a noisy early loss).
 */
export function extractLedgerGuidance(classification) {
  try {
    const ledger = loadLedger();
    const cls = ledger.classes[classification];
    if (!cls || Object.keys(cls.approaches).length === 0) {
      return 'LEDGER: no cross-run history for this classification yet — explore freely.';
    }
    // epsilon-greedy READ-ONLY: the counter is advanced once per run in
    // recordOutcomes (write path). Here we only read it to decide re-admission.
    const counter = (ledger._meta && ledger._meta.epsilonCounter && ledger._meta.epsilonCounter[classification]) || 0;
    const reAdmit = counter > 0 && (counter % EPSILON_EVERY === 0);

    let prune = Object.keys(cls.approaches).filter(k => {
      const a = cls.approaches[k];
      return a.tried >= PRUNE_MIN_TRIED && a.promoted <= PRUNE_MAX_PROMOTED && !isMandatoryFamilySignature(k);
    });
    let readmitted = null;
    if (reAdmit && prune.length > 0) { readmitted = prune[0]; prune = prune.slice(1); }

    const fastTrack = Object.keys(cls.approaches).filter(k => {
      const a = cls.approaches[k];
      return a.tried >= FASTTRACK_MIN_TRIED && (a.promoted / a.tried) >= FASTTRACK_MIN_RATE;
    });

    const lines = ['LEDGER GUIDANCE (cross-run learning for this target class):'];
    if (fastTrack.length) {
      lines.push('  FAST-TRACK (reliable winners — start here, spend fewer competing variants elsewhere):');
      for (const k of fastTrack) { const a = cls.approaches[k]; lines.push(`    + ${k}  (${a.promoted}/${a.tried} promoted)`); }
    }
    if (prune.length) {
      lines.push(`  PRUNE (tried >= ${PRUNE_MIN_TRIED}, NEVER promoted — do NOT generate these; they waste the budget):`);
      for (const k of prune) { const a = cls.approaches[k]; lines.push(`    - ${k}  (0/${a.tried} promoted)`); }
    }
    if (readmitted) lines.push(`  (epsilon probe this run: re-admitting one pruned approach for a single test — "${readmitted}")`);
    if (fastTrack.length === 0 && prune.length === 0) lines.push('  No strong signal yet — keep exploring.');
    return lines.join('\n');
  } catch (e) {
    return 'LEDGER: guidance unavailable (non-fatal).';
  }
}

// ============================================================================
// Per-dimension CHAMPIONS — cross-run "best of breed" memory. For each class,
// remember the single best variant's durable image.xisf path + score per quality
// dimension, so a later run can recall_champion() to open a known-good image and
// graft strong regions from it. Defensive: a champion error must NEVER break a run.
// ============================================================================
/** WI-19: bump when scoreVariantDimensions semantics change; champions with another version are ignored and replaced. */
export const CHAMPION_SCORE_VERSION = 2;
/**
 * ifn_visibility weights (dust-based). PROVISIONAL: chosen per the plan's alternative
 * (dustCoverage*2 + dustMeanSat + 0.25*min(fieldP95,0.5)) because the first weights ranked the
 * regressed 4bbeec17 (dust hugging the core) above iter03. NOT yet validated on the approved images
 * (needs PixInsight: scripts/backtest-gates.mjs) — see processing-profiles reflection_nebula.ifn._calibration.
 */
export const IFN_DUST_WEIGHTS = { coverage: 2, meanSat: 1, fieldP95: 0.25, fieldP95Cap: 0.5 };
export const CHAMPION_DIMENSIONS = ['ifn_visibility', 'core_integrity', 'color_richness', 'star_quality', 'detail'];

/** Turn raw finish-gate metric objects into 5 scalar dimension scores (higher=better). Sparse. */
export function scoreVariantDimensions(m) {
  const out = {};
  if (!m) return out;
  try {
    const d = m.detail;
    const du = m.dust;
    if (du && !du.error && typeof du.dustCoverage === 'number') {
      const W = IFN_DUST_WEIGHTS;
      out.ifn_visibility = W.coverage * du.dustCoverage + W.meanSat * (du.dustMeanSat || 0) + W.fieldP95 * Math.min(du.fieldP95 || 0, W.fieldP95Cap);
    } else if (d && typeof d.subjectBrightness === 'number') {
      const total = (d.raw && d.raw.totalBlocks) || 1;
      const coverage = (d.subjectCount || 0) / total;
      out.ifn_visibility = d.subjectBrightness + 2 * coverage;
    }
    // detailCredible (noise-floor corrected) when measured; detailScore only for pre-WI-18 metrics.
    if (d && typeof d.detailCredible === 'number') out.detail = d.detailCredible * 100 + (d.contrastRatio || 0) * 0.1;
    else if (d && typeof d.detailScore === 'number') out.detail = d.detailScore * 100 + (d.contrastRatio || 0) * 0.1;
    const c = m.core;
    if (c && typeof c.coreRelContrast === 'number' && !isNaN(c.coreRelContrast)) out.core_integrity = c.coreRelContrast;
    const s = m.saturation;
    if (s && typeof s.p90S === 'number') {
      if (typeof m.classification === 'string' && m.classification.startsWith('galaxy') && typeof m.targetP90 === 'number' && m.targetP90 > 0) {
        // Natural-look classes: richness is closeness to the profile target, not "more is better".
        out.color_richness = Math.max(0, 1 - Math.abs(s.p90S - m.targetP90) / m.targetP90);
      } else {
        const cap = typeof m.maxP90 === 'number' ? m.maxP90 : 0.65;
        out.color_richness = Math.min(s.p90S, cap) - Math.max(0, s.p90S - cap);
      }
    }
    const st = m.stars;
    if (st && typeof st.medianFWHM === 'number') out.star_quality = (st.starsFound || 0) >= 20
      ? (1 / (1 + st.medianFWHM)) * Math.min(1, (st.starBgContrast || 0) / 4) * (1 + Math.min(st.colorDiversity || 0, 0.05) * 10)
      : 0;
  } catch (e) { /* non-fatal */ }
  return out;
}

/** WI-19: keep only small scalar raw metrics next to a champion (for later re-scoring / debugging). */
function trimMetrics(m) {
  if (!m || typeof m !== 'object') return null;
  const pick = (o, keys) => { if (!o || typeof o !== 'object') return null; const r = {}; for (const k of keys) if (typeof o[k] === 'number' && isFinite(o[k])) r[k] = o[k]; return r; };
  return {
    dust: pick(m.dust, ['dustCoverage', 'dustMeanSat', 'fieldP95', 'warmDustFraction']),
    stars: (() => {
      const base = pick(m.stars, ['starsFound', 'medianFWHM', 'starBgContrast', 'colorDiversity']);
      // WI-16: measured star field (advisory metrics) stored for cross-run threshold calibration
      const sf = pick(m.stars && m.stars.starField, ['starsMeasured', 'medianFWHM', 'centerFWHM', 'edgeFWHM', 'centerEllipticity', 'edgeEllipticity', 'medianDarkRing', 'prominenceAbs', 'localRatio', 'cappedFraction']);
      if (base && sf && Object.keys(sf).length) base.starField = sf;
      return base;
    })(),
    core: pick(m.core, ['coreRelContrast']),
    saturation: pick(m.saturation, ['p90S']),
    detail: pick(m.detail, ['subjectBrightness', 'detailCredible', 'detailScore', 'contrastRatio'])
  };
}

/**
 * Record per-dimension champions. metricsPerVariant = { <variantId>: { dimensionScores:{dim->num}, xisfPath } }.
 * A champion updates only when its score STRICTLY beats the stored one and the XISF exists.
 */
export function recordChampions(classification, store, metricsPerVariant) {
  if (!classification || !metricsPerVariant) return;
  try {
    const ledger = loadLedger();
    ledger.classes[classification] = ledger.classes[classification] || { approaches: {} };
    const cls = ledger.classes[classification];
    cls.champions = cls.champions || {};
    const updated = [];
    // WI-08: record which model/effort produced the champion (re-read manifest; subprocess copy may be stale)
    let modelInfo = null;
    try {
      const m = JSON.parse(fs.readFileSync(store.manifestPath, 'utf-8'));
      const a = m.agents && m.agents.giga_orchestrator;
      if (a && (a.requestedModel || a.actualModels)) modelInfo = { requestedModel: a.requestedModel, effort: a.effort, actualModels: a.actualModels };
    } catch (e) { /* */ }
    for (const dim of CHAMPION_DIMENSIONS) {
      let bestVar = null, bestScore = -Infinity, bestPath = null;
      for (const variantId of Object.keys(metricsPerVariant)) {
        const entry = metricsPerVariant[variantId] || {};
        const ds = entry.dimensionScores || {};
        if (typeof ds[dim] !== 'number' || isNaN(ds[dim])) continue;
        if (ds[dim] > bestScore) { bestScore = ds[dim]; bestVar = variantId; bestPath = entry.xisfPath; }
      }
      if (!bestVar || !bestPath) continue;
      bestPath = durableCopyFor(bestPath);
      if (!fs.existsSync(bestPath)) continue;
      const prev = cls.champions[dim];
      if (!prev || prev.scoreVersion !== CHAMPION_SCORE_VERSION || bestScore > prev.score) {
        cls.champions[dim] = { xisfPath: bestPath, variant_id: bestVar, run_id: (store && store.runId) || null, score: bestScore, scoreVersion: CHAMPION_SCORE_VERSION, rawMetrics: trimMetrics(metricsPerVariant[bestVar] && metricsPerVariant[bestVar].rawMetrics), recorded: new Date().toISOString(), models: modelInfo };
        updated.push(dim + '=' + bestScore.toFixed(4));
      }
    }
    if (updated.length) { saveLedger(ledger); console.log('  Champions: updated for "' + classification + '": ' + updated.join(', ')); }
  } catch (e) { console.log('  Champions: record failed (non-fatal): ' + e.message); }
}

const _warnedDangling = new Set();
/** Read recorded champions for a classification. {} on miss/error. */
export function getChampions(classification) {
  try {
    const cls = loadLedger().classes[classification];
    const ch = (cls && cls.champions) || {};
    const out = {};
    for (const [k, v] of Object.entries(ch)) {
      // WI-24: skip champions whose image file no longer exists (run pruned)
      if (v && v.xisfPath && !fs.existsSync(v.xisfPath)) {
        if (!_warnedDangling.has(v.xisfPath)) { _warnedDangling.add(v.xisfPath); console.log(`  Champions: skipping '${k}' — file missing: ${v.xisfPath}`); }
        continue;
      }
      if (v && v.scoreVersion !== CHAMPION_SCORE_VERSION) continue; // WI-19: stale scoring semantics
      out[k] = v;
    }
    return out;
  }
  catch (e) { return {}; }
}
