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
  return l;
}
function saveLedger(l) {
  try { fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true }); fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2) + '\n'); }
  catch (e) { /* non-fatal */ }
}

/**
 * Coarse, stable signature for an approach from a variant's params + notes.
 * Free-text/agent-supplied data, so we extract a sorted token set from a small
 * known vocabulary — signatures must AGGREGATE across runs, not be unique.
 */
export function canonicalizeApproach(v) {
  if (!v) return 'unspecified';
  const p = v.params || {};
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
  // style keywords (word-boundary match so 'edge' does not fire inside 'wedge')
  ['bold', 'balanced', 'edge', 'conservative', 'assertive', 'natural', 'vivid', 'synthetic'].forEach(k => {
    if (new RegExp('\\b' + k + '\\b').test(notes)) toks.push('style:' + k);
  });
  toks.sort();
  return toks.length ? Array.from(new Set(toks)).join('|') : 'unspecified';
}

/**
 * Record the outcomes of a completed run: the promoted winner(s) + all rejected
 * variants, aggregated per coarse approach-signature, per classification.
 * Reads from the artifact store the same way updateProcessingProfile does.
 */
export function recordOutcomes(classification, store) {
  if (!classification || !store) return;
  try {
    const ledger = loadLedger();
    ledger.classes[classification] = ledger.classes[classification] || { approaches: {} };
    const cls = ledger.classes[classification];

    const manifest = store.manifest || {};
    // The giga flow runs a single 'giga_orchestrator' and records its winner via
    // final-selection.json (NOT manifest.agents/promoteWinner, which only the
    // legacy doers use). Default to giga_orchestrator when manifest.agents is empty.
    let agentNames = Object.keys(manifest.agents || {});
    if (agentNames.length === 0) agentNames = ['giga_orchestrator'];

    // Winner variant id from the final-selection record (giga flow).
    let winnerVariantId = null;
    try { const fsel = store.readFinalSelection && store.readFinalSelection(); winnerVariantId = fsel && fsel.variant_id; } catch (e) { /* */ }

    const winnerSigs = new Set();
    const triedSigs = new Set();
    for (const agentName of agentNames) {
      // Legacy promoteWinner path (manifest.agents) — still supported.
      try { const w = store.getWinner(agentName); if (w) winnerSigs.add(canonicalizeApproach(w)); } catch (e) { /* */ }
      let variants = [];
      try { variants = store.listVariants(agentName) || []; } catch (e) { /* */ }
      for (const v of variants) {
        const sig = canonicalizeApproach(v);
        triedSigs.add(sig);
        if (winnerVariantId && v.variantId === winnerVariantId) winnerSigs.add(sig);
      }
    }
    for (const s of winnerSigs) triedSigs.add(s);
    if (triedSigs.size === 0) { console.log(`  Ledger: no variants found this run — nothing recorded for "${classification}".`); return; }

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
    console.log(`  Ledger: recorded ${triedSigs.size} approach(es) for "${classification}" (${promotedN} promoted, winner=${winnerVariantId || 'n/a'}).`);
  } catch (e) {
    console.log(`  Ledger: record failed (non-fatal): ${e.message}`);
  }
}

/** Approaches that have been tried enough and never promoted (the prune set). */
export function getPrunedApproaches(classification) {
  try {
    const cls = loadLedger().classes[classification];
    if (!cls) return [];
    return Object.keys(cls.approaches).filter(k => {
      const a = cls.approaches[k];
      return a.tried >= PRUNE_MIN_TRIED && a.promoted <= PRUNE_MAX_PROMOTED;
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
      return a.tried >= PRUNE_MIN_TRIED && a.promoted <= PRUNE_MAX_PROMOTED;
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
export const CHAMPION_DIMENSIONS = ['ifn_visibility', 'core_integrity', 'color_richness', 'star_quality', 'detail'];

/** Turn raw finish-gate metric objects into 5 scalar dimension scores (higher=better). Sparse. */
export function scoreVariantDimensions(m) {
  const out = {};
  if (!m) return out;
  try {
    const d = m.detail;
    if (d && typeof d.subjectBrightness === 'number') {
      const total = (d.raw && d.raw.totalBlocks) || 1;
      const coverage = (d.subjectCount || 0) / total;
      out.ifn_visibility = d.subjectBrightness + 2 * coverage;
    }
    if (d && typeof d.detailScore === 'number') out.detail = d.detailScore * 100 + (d.contrastRatio || 0) * 0.1;
    const c = m.core;
    if (c && typeof c.coreRelContrast === 'number' && !isNaN(c.coreRelContrast)) out.core_integrity = c.coreRelContrast;
    const s = m.saturation;
    if (s && typeof s.p90S === 'number') {
      const cap = typeof m.maxP90 === 'number' ? m.maxP90 : 0.65;
      out.color_richness = Math.min(s.p90S, cap) - Math.max(0, s.p90S - cap);
    }
    const st = m.stars;
    if (st && typeof st.medianFWHM === 'number') out.star_quality = (st.starsFound || 0) >= 20 ? 1 / (1 + st.medianFWHM) : 0;
  } catch (e) { /* non-fatal */ }
  return out;
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
    for (const dim of CHAMPION_DIMENSIONS) {
      let bestVar = null, bestScore = -Infinity, bestPath = null;
      for (const variantId of Object.keys(metricsPerVariant)) {
        const entry = metricsPerVariant[variantId] || {};
        const ds = entry.dimensionScores || {};
        if (typeof ds[dim] !== 'number' || isNaN(ds[dim])) continue;
        if (ds[dim] > bestScore) { bestScore = ds[dim]; bestVar = variantId; bestPath = entry.xisfPath; }
      }
      if (!bestVar || !bestPath) continue;
      if (!fs.existsSync(bestPath)) continue;
      const prev = cls.champions[dim];
      if (!prev || bestScore > prev.score) {
        cls.champions[dim] = { xisfPath: bestPath, variant_id: bestVar, run_id: (store && store.runId) || null, score: bestScore, recorded: new Date().toISOString() };
        updated.push(dim + '=' + bestScore.toFixed(4));
      }
    }
    if (updated.length) { saveLedger(ledger); console.log('  Champions: updated for "' + classification + '": ' + updated.join(', ')); }
  } catch (e) { console.log('  Champions: record failed (non-fatal): ' + e.message); }
}

/** Read recorded champions for a classification. {} on miss/error. */
export function getChampions(classification) {
  try { const cls = loadLedger().classes[classification]; return (cls && cls.champions) || {}; }
  catch (e) { return {}; }
}
