// ============================================================================
// Tool definitions and handlers: maps ops library to Claude API tool_use
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getStats, measureUniformity, measureColorGradient, measureLumTilt, subtractSkyPlane,
  savePreview, autoStretch,
  cloneImage, restoreFromClone, closeImage, purgeUndoHistory,
  runGC, runABE, runPerChannelABE, runSCNR,
  setiStretch,
  createLumMask, applyMask, removeMask, closeMask, shapeMask, measureMask, maskStatsText,
  checkStarQuality, measureStarField, checkRinging, checkSharpness, assessBurn, scanBurntRegions, checkSaturation, checkTonalPresence, checkStarLayerIntegrity, checkBrightChroma, checkHighlightTexture, measureShellTexture, measurePsfField,
  measureSubjectDetail, evaluateDetailGain, summarizeDetail, locateSubjectROI, measureCoreContrast, measureBackgroundNoise, measureChromaNoise, measureDustCoverage, compareToReference, measureBackgroundFloor, measureScaleBands, measureDiscMottle, measureOuterArms, measureInventoryZones, measureZoneStructure, measureEnvelopeSectors, compareEnvelopeSectors, measureSectorProfiles, measureCoreSpectrum, edgeSteepening, measureArmGapDepth, measureHaKnotColour,
  multiScaleEnhance, shellDetailEnhance,
  extractPseudoOIII, continuumSubtractHa, dynamicNarrowbandBlend, createSyntheticLuminance, createZoneMasks, createAdaptiveZoneMasks, continuousClamp,
} from '../ops/index.mjs';
import { shoCombine, shoHueShift, shoHueSaturation, measurePaletteBalance, computeNarrowbandBalance, repairStarResiduals, neutralizePaletteBackground, chromaSmooth, liftFaintHalo, bodyEdgeContrast, compressOuterHaze } from '../ops/sho-palette.mjs';
import { checkHardConstraints, statsToScores, computeAggregate } from '../scoring.mjs';
import { openXisfAs } from './prep-cache-util.mjs';
import { backgroundGrid } from './narrowband-prep.mjs';
import { jpegToContentBlock, renderCropJpeg } from './vision.mjs';
import { critiqueAesthetic } from './aesthetic-critic.mjs';
import { parseGateFailure, generateRepairGuidance, findRepairPolicy } from './repair-policies.mjs';
import { getChampions, recordChampions, scoreVariantDimensions, ledgerKey } from '../ledger.mjs';
import {
  BURN_CLIP, BRIGHT_BLOCK_LEVEL, NOISE_BG_HARD, NOISE_DUST_HARD, SUBJECT_MIN, DETAIL_MIN, SAT_HARD_MARGIN, TONAL, TONAL_SMALL, FWHM_HARD,
  saturationLimits, STAR_COUNT_WARN, REF_COLOR_EMD, REF_COVERAGE_DELTA, REF_PALETTE_L1, REF_LAB_EMD, gateThreshold, contrastGateFor, starMinContrast,
} from './gate-contract.mjs';

// ============================================================================
// Helpers
// ============================================================================

/**
 * WI-14: shared PJSR prelude. PixelMath/process parse failures return executeOn()===false
 * with an 'ok' bridge status, so process-running handlers call execOrThrow() in PJSR.
 * (Plain quotes only: this text is embedded in PJSR source.)
 */
const PJSR_PRELUDE =
  "function execOrThrow(P,v,label){if(!P.executeOn(v)){var hint='';" +
  "try{if(P instanceof PixelMath)hint=' (check for pow() (use exp(e*ln(b))), undeclared symbols (multi-statement expressions need symbols), and $T.R-style channel syntax (use $T[0]))';}catch(e){}" +
  "throw new Error(label+': executeOn returned false -- parameters/expression rejected by PixInsight'+hint);}}\n";

/**
 * Like ctx.pjsr but throws when the PJSR run errors (bridge.pjsr itself never throws;
 * ops modules rely on that). Prepends PJSR_PRELUDE so code can call execOrThrow().
 */
// WI-07b: window-pressure signal (no auto-close). Masks/crop masks do not count toward the limit.
const WINDOW_LIMIT = 12;
const WINDOW_WARN_MB = 6000;
function _isAuxWindow(id) { return /crop_mask/i.test(id) || /mask/i.test(id); }
export function summarizeWindows(imgs) {
  const rows = (imgs || []).map(i => {
    const ch = i.channels || i.numberOfChannels || (i.isColor ? 3 : 1);
    return { id: i.id, w: i.width, h: i.height, channels: ch, estMB: Math.round(((i.width || 0) * (i.height || 0) * ch * 4) / 1e6), aux: _isAuxWindow(String(i.id)) };
  });
  const main = rows.filter(r => !r.aux);
  return { rows, count: main.length, totalMB: rows.reduce((a, r) => a + r.estMB, 0) };
}
async function windowPressure(ctx, withRss) {
  const sum = summarizeWindows(await ctx.listImages());
  let rssMB = null;
  if (withRss && typeof ctx.checkMemory === 'function') { try { rssMB = await ctx.checkMemory('window_pressure'); } catch {} }
  return { ...sum, rssMB };
}
/** Refuse text when the open-window count is at/over the limit (agent chooses what to close); null when OK. */
async function windowRefusal(ctx, op) {
  try {
    const p = await windowPressure(ctx, false);
    if (p.count >= WINDOW_LIMIT) {
      return { type: 'text', text: `REFUSED (${op}): ${p.count} windows already open (limit ${WINDOW_LIMIT}, ~${p.totalMB} MB). Close some first (close_image) — for long-lived references save_variant then close_image, and load_variant on demand. Open views: ${p.rows.filter(r => !r.aux).map(r => r.id).join(', ')}` };
    }
  } catch {}
  return null;
}
async function windowNote(ctx) {
  try {
    const p = await windowPressure(ctx, false);
    return `\n[Windows open: ${p.count} (~${p.totalMB} MB est.)${p.count > 6 ? ' — keep <=6 full-res windows; close what you no longer need' : ''}]`;
  } catch { return ''; }
}

async function pjsrOrThrow(ctx, code, label) {
  const r = await ctx.pjsr(PJSR_PRELUDE + code);
  if (r && r.status === 'error') {
    throw new Error(`${label}: ${r.error?.message || r.error || 'PJSR error'}`);
  }
  return r;
}

/** Format stats with burn warning if max > 0.90 */
/**
 * Saturation thresholds for Gate 7 / check_saturation. The blocking level is always
 * profile.saturation.max_p90 + SAT_HARD_MARGIN; a profile `look` block (PROVISIONAL, not
 * back-tested) only moves the advisory warn level to look.target_p90.
 */
export function saturationThresholds(brief) {
  return saturationLimits(brief?.processingProfile);
}

/** Pure Gate 7 evaluation: returns 'pass' | 'warning' | 'failure' for a subject P90 saturation. */
export function evaluateSaturationGate(p90S, brief) {
  const t = saturationThresholds(brief);
  if (p90S > t.failAt) return 'failure';
  if (p90S > t.warnAt) return 'warning';
  return 'pass';
}

// ---- WI-13: L-usage provenance (Gate 10) + shared luminance-injection helper ----
const L_TOOLS = new Set(['lrgb_combine', 'inject_luminance', 'inject_l_ifn']);

/** True for FILTER_L or any view cloned (transitively) from it (brief._lRoots, recorded by mcp-agent-tools). */
export function isLDerived(id, brief) {
  if (!id) return false;
  if (id === 'FILTER_L') return true;
  return Array.isArray(brief?._lRoots) && brief._lRoots.indexOf(id) >= 0;
}

/** Record an L-usage event. No-op unless brief._lUsage is an array (set by the MCP process). */
export function recordLUsage(brief, tool, viewId) {
  if (!brief || !Array.isArray(brief._lUsage)) return;
  const rec = brief._provenance?.get ? brief._provenance.get(viewId) : null;
  brief._lUsage.push({ tool, viewId: viewId || null, seq: rec?.seq ?? null });
}

/** True when a PixelMath call references an L-derived view in expression/symbols. */
export function pixelmathReferencesL(input, brief) {
  const text = `${input?.expression || ''} ${input?.symbols || ''}`;
  if (/\bFILTER_L\b/.test(text)) return true;
  for (const id of (brief?._lRoots || [])) {
    if (id && new RegExp('\\b' + String(id).replace(/[^A-Za-z0-9_]/g, '\\$&') + '\\b').test(text)) return true;
  }
  return false;
}

/**
 * Gate 10 predicate. Provenance first (brief._lUsage); trace.jsonl only when _lUsage is undefined.
 * @param {string|null} traceText raw trace.jsonl content (only used for the fallback)
 */
export function evaluateLUsage(brief, traceText) {
  if (Array.isArray(brief?._lUsage)) return brief._lUsage.length > 0;
  if (!traceText) return false;
  for (const line of traceText.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || !e.tool) continue;
    if (L_TOOLS.has(e.tool)) return true;
    if (e.tool === 'run_pixelmath' && /FILTER_L/.test(String(e.args?.expression || ''))) return true;
  }
  return false;
}

/**
 * Shared CIE-Y luminance replacement (extracted from the lrgb_combine PixelMath fallback).
 * Yn = w*L + (1-w)*Y ; ratio = min(max(Yn,1e-5)/max(Y,1e-5), 3) ; $T * (1 + M*(ratio-1)).
 * M = mask[0] when maskId given (an unmasked-pixel multiply by mask would zero pixels), else 1.
 * Truncates to 0..1 only; no hard cap (soft compression belongs to continuous_clamp / rolloff).
 */
async function applyLuminanceInjection(ctx, viewId, lViewId, weight, maskId, label) {
  const mask = maskId ? `M = ${maskId}[0]; ` : '';
  const finalExpr = maskId ? '$T * (1 + M*(ratio-1))' : '$T * ratio';
  const symbols = maskId ? 'Y, Yn, ratio, M' : 'Y, Yn, ratio';
  const expr = `Y = 0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2]; Yn = ${weight}*${lViewId} + (1-${weight})*Y; ratio = min(max(Yn, 0.00001) / max(Y, 0.00001), 3.0); ${mask}${finalExpr}`;
  await pjsrOrThrow(ctx, `
    var PM = new PixelMath;
    PM.expression = "${expr}";
    PM.symbols = "${symbols}";
    PM.useSingleExpression = true;
    PM.use64BitWorkingImage = true;
    PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
    PM.createNewImage = false;
    execOrThrow(PM, ImageWindow.windowById('${viewId}').mainView, '${label}');
  `, label);
}

function statsLine(stats, label = 'Stats') {
  const med = stats.median?.toFixed(6) ?? '?';
  const max = (stats.max ?? 0).toFixed(4);
  let warn = '';
  if (stats.max > 0.95) warn = ' ⚠️ CLIPPING: max=' + max + ' — actual pixel clipping. Reduce stretch/curves or apply continuous_clamp.';
  else if (stats.max > 0.80) warn = ' ⚡ BRIGHT: max=' + max + ' — core may look bright. Check visually: if internal structure is visible, this is OK. If featureless, apply continuous_clamp.';
  return `${label}: median=${med}, max=${max}${warn}`;
}

/** One-line prep-baseline comparison for measure_subject_detail output ('' when no baseline). */
function detailBaselineLine(brief, result) {
  const b = brief?._baselineDetail;
  if (!b) return '';
  const hasL = !!brief?._hasL;
  const ev = evaluateDetailGain(summarizeDetail(result), b, hasL, brief?.processingProfile);
  const base = hasL ? (b.max || b.rgb) : b.rgb;
  if (ev.gain == null) return '';
  return `  Detail gain vs prep baseline (${hasL ? 'max(RGB,L)' : 'RGB'}, weber ${base.weber?.toExponential?.(3)}): x${ev.gain.toFixed(2)}${ev.maxGain != null ? ` (profile detail.max_gain ${ev.maxGain}, ADVISORY${ev.exceeded ? ' - EXCEEDED' : ''})` : ''}\n`;
}

/** Compact numeric summary of a finish-gate metrics object (for JSON persistence). */
export function summarizeGateMetrics(m) {
  const num = (v) => (typeof v === 'number' && isFinite(v) ? +v.toFixed(6) : null);
  return {
    stars: m.stars ? { starBgContrast: num(m.stars.starBgContrast), medianFWHM: num(m.stars.medianFWHM), starsFound: m.stars.starsFound ?? null, starsPerMpx: num(m.stars.starsPerMpx) } : null,
    backgroundFloor: m.backgroundFloor ? { bgLevel: num(m.backgroundFloor.bgLevel), p10: num(m.backgroundFloor.p10), blackBlockFraction: num(m.backgroundFloor.blackBlockFraction) } : null,
    core: m.core ? { coreRelContrast: num(m.core.coreRelContrast), ratio: num(m.core.ratio), coreFraction: num(m.core.coreFraction), pass: m.core.pass ?? null } : null,
    detail: m.detail ? { subjectBrightness: num(m.detail.subjectBrightness), contrastRatio: num(m.detail.contrastRatio), detailScore: num(m.detail.detailScore), detailCredible: num(m.detail.detailCredible), detailWeber: num(m.detail.detailWeber), noiseDominated: m.detail.noiseDominated ?? null } : null,
    saturation: m.saturation ? { p90S: num(m.saturation.p90S), subjectPixelCount: m.saturation.subjectPixelCount ?? null } : null,
    dust: m.dust ? { pass: m.dust.pass ?? null, dustMeanSat: num(m.dust.dustMeanSat), fieldP95: num(m.dust.fieldP95), dustCoverage: num(m.dust.dustCoverage ?? m.dust.coverage) } : null,
    noise: m.noise ? { bgNoise: num(m.noise.bgNoise), dustNoise: num(m.noise.dustNoise) } : null,
    tonal: m.tonal ? { separation: num(m.tonal.separation), roi_confidence: m.tonal.roi_confidence ?? null } : null,
    texture: m.texture ? { verdict: m.texture.verdict ?? null, pass: m.texture.pass ?? null } : null,
    palette: m.palette ? { summary: m.palette.summary ?? null, cool: num(m.palette.cool) } : null,
  };
}

/**
 * WI-09: the gate values closest to their limits, as ["name value (limit L, margin P%)", ...] sorted by relative margin.
 * Pure: reads the metrics bundle returned by evaluateFinishGates and the brief's profile.
 */
export function nearestGateMargins(m, brief, top = 4) {
  const profile = brief?.processingProfile || {};
  const out = [];
  const hi = (name, v, limit) => { if (Number.isFinite(v) && Number.isFinite(limit) && limit > 0) out.push({ name, v, limit, margin: (v - limit) / limit, dir: '>=' }); };
  const lo = (name, v, limit) => { if (Number.isFinite(v) && Number.isFinite(limit) && limit > 0) out.push({ name, v, limit, margin: (limit - v) / limit, dir: '<=' }); };
  hi('subject_brightness', m?.detail?.subjectBrightness, SUBJECT_MIN);
  hi('subject_contrast', m?.detail?.contrastRatio, contrastGateFor(brief?.target?.fieldCharacteristics?.faintStructureGoal));
  hi('stars_brightness', m?.stars?.starBgContrast, starMinContrast(profile));
  lo('noise_bg', m?.noise?.bgNoise, gateThreshold(profile, 'noise.bg_hard', NOISE_BG_HARD));
  lo('noise_dust', m?.noise?.dustNoise, gateThreshold(profile, 'noise.dust_hard', NOISE_DUST_HARD));
  lo('saturation_p90', m?.saturation?.p90S, saturationLimits(profile).failAt);
  hi('tonal_presence', m?.tonal?.separation, gateThreshold(profile, 'tonal.min_separation', TONAL));
  hi('background_floor', m?.backgroundFloor?.bgLevel, gateThreshold(profile, 'background.min_level', NaN));
  hi('star_retention', m?.stars?.starsPerMpx, gateThreshold(profile, 'stars.min_density_per_mpx', NaN));
  out.sort((a, b) => a.margin - b.margin);
  return out.slice(0, top).map((r) => `${r.name} ${+r.v.toFixed(4)} (limit ${r.dir} ${+r.limit.toFixed(4)}, margin ${(r.margin * 100).toFixed(0)}%)`);
}

/**
 * WI-09: the "Critical summary" block printed FIRST in the run wrap-up and appended to trace-summary.md.
 * Input: the final-selection.json record written by finish (may be null/partial for recovered runs).
 */
export function formatCriticalSummary(sel) {
  const L = ['CRITICAL SUMMARY (flaws first)'];
  if (!sel) { L.push('  No final selection was recorded; nothing to summarise.'); return L.join('\n'); }
  const flaws = Array.isArray(sel.remaining_flaws) ? sel.remaining_flaws : null;
  L.push('  Remaining flaws (reported by the agent at finish):');
  if (flaws && flaws.length) flaws.forEach((f) => L.push(`    - ${f}`));
  else L.push(flaws ? '    - none reported (the agent listed no remaining flaws)' : '    - NOT REPORTED (recovered run or finish without remaining_flaws)');
  const c = sel.critic;
  if (c) {
    L.push(`  Independent critic: ${Number.isFinite(c.score) ? c.score.toFixed(1) : 'n/a'}/10${c.min != null ? ` (min ${c.min}${c.blocking ? ', blocking' : ', advisory'})` : ' (advisory)'}`);
    (c.flaws || []).forEach((f) => L.push(`    - critic flaw: ${f}`));
  } else L.push('  Independent critic: no verdict recorded');
  const r = sel.reference;
  if (r) L.push(`  Reference: palette_l1=${Number.isFinite(r.palette_l1) ? r.palette_l1.toFixed(3) : 'n/a'} (advisory ${r.max_palette_l1}), lab_emd=${Number.isFinite(r.lab_emd) ? r.lab_emd.toFixed(1) : 'n/a'} (advisory ${r.max_lab_emd}), coverage_delta=${Number.isFinite(r.coverage_delta) ? r.coverage_delta.toFixed(3) : 'n/a'} (max ${r.max_coverage_delta})${r.ms_ssim != null ? `, ms_ssim=${(+r.ms_ssim).toFixed(3)}` : ''}`);
  else L.push('  Reference: no reference');
  const near = sel.gates?.nearest;
  if (near && near.length) { L.push('  Gate values nearest their limits:'); near.forEach((n) => L.push(`    - ${n}`)); }
  const w = Array.isArray(sel.warnings) ? sel.warnings : [];
  if (w.length) { L.push(`  Gate warnings (${w.length}):`); w.forEach((x) => L.push(`    - ${x}`)); }
  else L.push('  Gate warnings: none recorded');
  return L.join('\n');
}

/** Per-gate verification tools (WI-05): union for the FINISH REJECTED footer. */
/** WI-06: finish gate -> equivalent check tool / synthetic repair key, and whether a repair policy may act on it. */
/** WI-11: workflow-derived narrowband palette helpers (HOO datasets have no SII). */
export function nbWorkflow(brief) { return brief?.dataDescription?.workflow; }
export function nbPaletteOf(brief) { return nbWorkflow(brief) === 'HOO' ? 'hoo' : undefined; }
/** WI-11: resolve sho_combine inputs for a brief. Returns {palette, s_id, error?}. */
export function resolveShoInputs(brief, input) {
  const wf = nbWorkflow(brief);
  const hasS = brief?.dataDescription?.channels?.S !== undefined ? !!brief.dataDescription.channels.S : wf !== 'HOO';
  const palette = input.palette || (wf === 'HOO' ? 'hoo' : 'foraxx');
  if (palette !== 'hoo' && !hasS && !input.s_id) {
    return { palette, s_id: null, error: `palette ${palette} needs SII; this is an HOO dataset — use palette "hoo" (bracket hoo_o_weight 0.5/0.65/0.8)` };
  }
  return { palette, s_id: hasS ? (input.s_id || 'FILTER_S') : (input.s_id || null) };
}

/** WI-16: options for the advisory star-field metric: centre radius from profile/brief gates.stars.center_radius_px; known star coordinates captured at star_protected_blend. */
function starFieldOpts(brief) {
  const r = brief?.processingProfile?.gates?.stars?.center_radius_px ?? brief?.gates?.stars?.center_radius_px;
  const peaks = Array.isArray(brief?._starPeaks) && brief._starPeaks.length ? brief._starPeaks : undefined;
  return { centerRadiusPx: Number.isFinite(r) ? r : undefined, peaks };
}

const GATE_REPAIR_TOOL = {
  burn_clip: 'scan_burnt_regions',
  bright_blocks: 'scan_burnt_regions',
  core_contrast: 'finish:core_contrast',
  saturation: 'check_saturation',
  stars_brightness: 'check_star_quality',
  stars_fwhm: 'check_star_quality',
  noise: 'finish:noise',
  dust_ifn: 'finish:dust',
  palette: 'finish:palette',
  exposure: 'finish:exposure',
  l_usage: 'finish:l_missing',
  tonal_presence: 'check_tonal_presence',
  highlight_texture: 'check_highlight_texture',
  subject_brightness: 'measure_subject_detail',
  subject_contrast: 'measure_subject_detail',
  subject_detail: 'measure_subject_detail',
  aesthetic: 'aesthetic_critic',
  reference: 'reference_compare',
};
const GATE_NOT_REPAIRABLE = new Set(['aesthetic', 'reference']);   // Gates 11/12: judgement gates, no automatic repair policy

const GATE_VERIFY_TOOLS = {
  burn_clip: ['scan_burnt_regions'],
  bright_blocks: ['scan_burnt_regions'],
  core_contrast: ['measure_subject_detail'],
  saturation: ['check_saturation'],
  stars_brightness: ['check_star_quality'],
  stars_fwhm: ['check_star_quality', 'check_ringing'],
  noise: ['check_noise'],
  dust_ifn: ['measure_dust_coverage'],
  tonal_presence: ['check_tonal_presence'],
  highlight_texture: ['check_highlight_texture'],
  subject_brightness: ['get_image_stats', 'measure_subject_detail'],
  subject_contrast: ['measure_subject_detail'],
  subject_detail: ['measure_subject_detail'],
  exposure: ['get_image_stats'],
  palette: ['measure_color_gradient', 'check_saturation'],
};
/**
 * WI-06 finish hints: when the last composition on the view was a star blend or lrgb_combine, the generic
 * "compress the core pedestal / apply continuous_clamp" advice is replaced by the matched repair policy's
 * guidance (clamping downstream of a composition is the wrong fix: fix upstream).
 */
function upstreamHint(msg, gateKey, brief, viewId) {
  const prov = brief?._provenance?.get(viewId);
  const lc = prov?.lastComposition;
  if (!lc || !(lc.tool === 'lrgb_combine' || lc.tool === 'star_screen_blend' || lc.tool === 'star_protected_blend')) return msg;
  const category = brief?.target?.classification || 'unknown';
  const policy = findRepairPolicy(gateKey, {}, lc, category) || findRepairPolicy(gateKey, {}, prov, category);
  if (!policy) return msg;
  const stripped = msg
    .replace(/Compress the core pedestal \(continuous_clamp\) and recover/g, 'Recover')
    .replace(/ and\/or compress the (core|bright) pedestal( with continuous_clamp)?/gi, '')
    .replace(/; compress the bright pedestal\)?\.?/gi, '.')
    .replace(/Apply continuous_clamp \(min_clamp=0\.75, max_clamp=0\.90\) to recover detail in bright areas\./, 'Fix it upstream of the last composition (' + lc.tool + ').');
  return stripped + '\n' + generateRepairGuidance(policy, lc);
}

function verifyToolsForGates(failedGates) {
  const set = new Set();
  for (const g of failedGates || []) for (const t of (GATE_VERIFY_TOOLS[g.gate] || [])) set.add(t);
  if (set.size === 0) ['check_star_quality', 'check_ringing', 'check_saturation', 'scan_burnt_regions', 'measure_subject_detail'].forEach(t => set.add(t));
  return [...set].join(', ');
}

/**
 * Run the full finish-gate battery on an open view. Extracted from the finish
 * handler (WI-01) so finish, run_quality_gates and scripts/backtest-gates.mjs
 * share one implementation. Constants live in gate-contract.mjs.
 *
 * @param {object} opts { mode:'run'|'backtest', aesthetic, reference, variantId }
 *   backtest mode: skips Gate 10 (L-usage trace) and the variant-reference lookup
 *   in Gate 9; the aesthetic critic is opt-in (opts.aesthetic, default false).
 * @returns {{failures, warnings, metrics, stats, failedGates, isEmergency}}
 */

// ============================================================================
// Staged metric order (2026-11-07 perturbation study on M74, processing-knowledge.md "impact matrix"):
// operations ordered by how many metrics they move — tone (7-8) -> local contrast (5-6) -> detail+noise -> colour
// (moves only saturation/chroma noise) -> stars. stage_checkpoint measures ONE stage's metrics and records them;
// finish failures on a metric that passed at its checkpoint name the stage, so drift is attributed, not re-fought.
// ============================================================================
export const METRIC_STAGES = [
  { stage: 'tone', gates: ['core_preservation', 'outer_arms', 'envelope_clip', 'edge_softness', 'arm_gap_depth', 'sky_level', 'tonal_presence'], tools: 'stretch/global curves, black point, masked outer-zone lift' },
  { stage: 'local_contrast', gates: ['disc_mottle', 'core_structure', 'core_cooked'], tools: 'LHE, HDRMT (HDRMT: +57% mottle, -24% core on M74), MSE' },
  { stage: 'detail_noise', gates: ['fine_detail', 'noise_bg'], tools: 'BXT/MLT/USM sharpening and NXT together (USM: +50% grain)' },
  { stage: 'colour', gates: ['saturation_floor', 'saturation', 'ha_knots'], tools: 'chroma/S curves, chroma_smooth, SCNR (touch only saturation + chroma noise)' },
];
export const STAGE_OF_GATE = Object.fromEntries(METRIC_STAGES.flatMap(s => s.gates.map(g => [g, s.stage])));

export async function measureStage(ctx, brief, viewId, stage) {
  const profile = brief?.processingProfile || {}, inv = brief?._inventory, rows = [];
  const row = (gate, metric, value, limit, pass, note = '') => rows.push({ gate, metric, value: value == null ? null : +(+value).toFixed(4), limit, pass, note });
  if (stage === 'tone') {
    if (inv?.zones) {
      const z = await measureInventoryZones(ctx, viewId, inv);
      const cp = profile.core_preservation, oa = profile.outer_arms;
      if (Number.isFinite(cp?.min_ratio_vs_prep) && z.coreIdx != null) row('core_preservation', 'core/disc vs prep', z.coreIdx / inv.prepCoreIdx, `>= ${cp.min_ratio_vs_prep}`, z.coreIdx / inv.prepCoreIdx >= cp.min_ratio_vs_prep);
      if (Number.isFinite(oa?.min_net_contrast) && z.outerNet != null) row('outer_arms', `outer zone ${inv.zones.outer.join('-')}px net`, z.outerNet, `>= ${oa.min_net_contrast}`, z.outerNet >= oa.min_net_contrast);
      row('sky_level', 'sky (inventory sky zone)', z.sky, '0.08-0.10 (galaxy look)', z.sky >= 0.075 && z.sky <= 0.11);
      const envp = profile.envelope;
      if (Number.isFinite(envp?.min_sector_ratio) && inv.prepEnvelope) { const c = await envelopeClip(ctx, brief, viewId); if (c?.evaluated && c.worst) row('envelope_clip', `outer glow by direction (worst ${c.worst.name}) vs prep`, c.worst.ratio, `>= ${envp.min_sector_ratio}`, c.worst.ratio >= envp.min_sector_ratio); }
      if (Number.isFinite(envp?.max_edge_steepening)) { const es = edgeSteepening(await measureSectorProfiles(ctx, viewId, inv), inv.rDet); if (es.evaluated) row('edge_softness', 'outer-glow edge steepening (fade speed at the edge / inside)', es.steepening, `<= ${envp.max_edge_steepening}`, es.steepening <= envp.max_edge_steepening, 'a lifted plateau ending in a cliff reads as a mask'); }
      const agp = profile.arm_gaps; if (Number.isFinite(agp?.min_depth)) { const ag = await measureArmGapDepth(ctx, viewId, inv); if (ag.depth != null) row('arm_gap_depth', 'arm/gap depth (p80-p20)/(p80-sky) per annulus, median', ag.depth, `>= ${agp.min_depth}`, ag.depth >= agp.min_depth, 'filled gaps read as haze between the arms'); }
    }
    const t = await checkTonalPresence(ctx, viewId, brief?.target?.classification || 'unknown');
    row('tonal_presence', 'subject/background separation', t.separation, `>= ${gateThreshold(profile, 'tonal.min_separation', TONAL)}`, t.separation >= gateThreshold(profile, 'tonal.min_separation', TONAL), 'the sky black point alone moves this +21%: do not crush the sky to pass it');
  } else if (stage === 'local_contrast') {
    const ts = profile.texture_scale, cp = profile.core_preservation, rD = brief?._baselineDetail?.scale?.rDisc;
    if (Number.isFinite(ts?.max_mid_mottle)) { const m = await measureDiscMottle(ctx, viewId, { radius: rD }); row('disc_mottle', 'mid-disc mottle', m.mid, `<= ${ts.max_mid_mottle}`, m.mid != null && m.mid <= ts.max_mid_mottle); }
    if (Number.isFinite(cp?.min_core_structure) && inv?.zones) { const zs = await measureZoneStructure(ctx, viewId, inv); row('core_structure', 'core fine structure', zs.coreWeber, `>= ${cp.min_core_structure}`, zs.coreWeber >= cp.min_core_structure); }
    if (Number.isFinite(cp?.max_core_spectrum) && inv?.zones) { const sp = await measureCoreSpectrum(ctx, viewId, inv); if (sp.spectrum != null) row('core_cooked', 'core texture spectrum (fine/coarse)', sp.spectrum, `<= ${cp.max_core_spectrum}`, sp.spectrum <= cp.max_core_spectrum, 'natural cores carry more structure at large scales; > limit = small-radius local contrast made cells'); }
  } else if (stage === 'detail_noise') {
    const ts = profile.texture_scale, prep = brief?._baselineDetail?.scale;
    const sb = await measureScaleBands(ctx, viewId, { rDisc: prep?.rDisc });
    if (Number.isFinite(ts?.min_ratio_vs_prep) && Number.isFinite(prep?.ratio)) row('fine_detail', 'fine/blob vs prep', sb.ratio / prep.ratio, `>= ${ts.min_ratio_vs_prep}`, sb.ratio / prep.ratio >= ts.min_ratio_vs_prep);
    if (Number.isFinite(ts?.min_fine_blob)) row('fine_detail', 'fine/blob', sb.ratio, `>= ${ts.min_fine_blob}`, sb.ratio >= ts.min_fine_blob);
    const bn = await measureBackgroundNoise(ctx, viewId); const lim = gateThreshold(profile, 'noise.bg_hard', NOISE_BG_HARD);
    row('noise_bg', 'background grain', bn.bgNoise, `<= ${lim}`, bn.bgNoise <= lim);
  } else if (stage === 'colour') {
    const sp = profile.saturation || {};
    if (Number.isFinite(sp.min_arm_p50) && inv?.zones) { const zs = await measureZoneStructure(ctx, viewId, inv); row('saturation_floor', 'arm saturation (median)', zs.armSat, `>= ${sp.min_arm_p50}`, zs.armSat != null && zs.armSat >= sp.min_arm_p50, `gaps ${zs.gapSat?.toFixed(3)}`); }
    const sat = await checkSaturation(ctx, viewId); const { failAt } = saturationThresholds(brief);
    row('saturation', 'subject P90 saturation', sat.p90S, `<= ${failAt.toFixed(2)}`, sat.p90S <= failAt);
    if (Number.isFinite(sp.min_p50) && !(Number.isFinite(sp.min_arm_p50) && inv?.zones)) row('saturation_floor', 'subject median saturation', sat.medianS, `>= ${sp.min_p50}`, sat.medianS >= sp.min_p50);
    const hkp = profile.ha_knots; if (Number.isFinite(hkp?.min_pink_frac) && inv?.haKnots) { const hk = await measureHaKnotColour(ctx, viewId, inv.haKnots); if (hk.evaluated) row('ha_knots', 'Ha knots still pink-red (share of knot pixels)', hk.pinkFrac, `>= ${hkp.min_pink_frac}`, hk.pinkFrac >= hkp.min_pink_frac, `white-clipped ${(100 * hk.whiteFrac).toFixed(0)}%, median hue ${hk.medHue?.toFixed(0)}°`); }
  } else throw new Error(`unknown stage ${stage}`);
  return rows;
}


// Envelope clip check (2026-11-08): M74 v4-v6 ran GradientCorrection on the STRETCHED L with the galaxy in frame;
// the model absorbed the faint envelope on one side (right sector 0.004-0.11 of what the prep data holds) and the
// critic saw a "mask-like edge". Shared by the gradient tools (immediate feedback) and finish Gate 7c.
export async function envelopeClip(ctx, brief, viewId) {
  const inv = brief?._inventory; if (!inv?.prepEnvelope) return null;
  const e = await measureEnvelopeSectors(ctx, viewId, inv);
  const lvl = brief?.processingProfile?.envelope?.min_level ?? 0.005;
  return compareEnvelopeSectors(e.excess, inv.prepEnvelope, { minLevel: lvl });
}
async function envelopeNote(ctx, brief, viewId) {
  try {
    const st = await getStats(ctx, viewId); if (!(st.median > 0.02)) return '';   // linear data: the prep inventory is not comparable
    const c = await envelopeClip(ctx, brief, viewId); const lim = brief?.processingProfile?.envelope?.min_sector_ratio ?? 0.3;
    if (!c?.evaluated || !c.worst) return '';
    return c.worst.ratio < lim
      ? `\n⚠️ ENVELOPE CLIPPED (${c.worst.name}): that side's outer glow is x${c.worst.ratio.toFixed(2)} of what the prep data holds. A gradient model on STRETCHED data with the galaxy in frame eats the faint envelope — restore_from_clone and leave large-scale gradients to the linear gradient phase (or use an inverted galaxy mask / mask_view_id blend).`
      : `\nEnvelope by direction OK (worst ${c.worst.name} x${c.worst.ratio.toFixed(2)} of prep).`;
  } catch (e) { return ''; }
}

export async function evaluateFinishGates(ctx, store, brief, viewId, agentName, opts = {}) {
  const mode = opts.mode || 'run';
  const variantId = opts.variantId || null;
  const profile = brief?.processingProfile || {};
  const stats = await getStats(ctx, viewId);

  // === BUDGET-AWARE GATE RELAXATION ===
  // In emergency budget, relax non-safety gates to allow finish
  const budget = brief?._budget || {};
  const isEmergency = (budget.turnsRemaining ?? 999) <= 10;

  // === QUALITY GATE ENFORCEMENT ===
  // Run automated quality checks — agent cannot bypass these
  const failures = [];
  const warnings = [];
  const report = { critic: null, reference: null };   // WI-09: persisted into final-selection.json by finish
  const failedGates = [];   // structured failures consumed by the WI-06 repair engine (also serialised as GATES_JSON)
  const fail = (gate, msg, extra = {}) => {
    const st = STAGE_OF_GATE[gate], lock = st && brief?._stageLocks?.[st];
    const locked = lock?.rows?.find(r => r.gate === gate && r.pass);
    if (locked) msg += ` [DRIFT: this passed at your '${st}' checkpoint (${locked.metric} ${locked.value}); an operation after it broke it. Re-check that stage's work instead of compensating downstream.]`;
    failures.push(msg);
    const parsed = parseGateFailure(gate, msg);
    const tool = GATE_REPAIR_TOOL[gate] || gate;
    failedGates.push({
      gate, tool,
      metric: extra.metric ?? null, value: extra.value ?? null, limit: extra.limit ?? null,
      failedMetrics: parsed.failedMetrics, reason: msg, resultText: msg,
      verify: (GATE_VERIFY_TOOLS[gate] || []).slice(),
      repairable: !GATE_NOT_REPAIRABLE.has(gate),
      ...(parsed.p90S != null ? { p90S: parsed.p90S } : {}),
      ...(parsed.tonal_verdict ? { tonal_verdict: parsed.tonal_verdict } : {}),
      message: msg,
    });
  };
  let mNoise = null, mTonal = null, mTexture = null, mPalette = null;
  let mBgFloor = null;   // 2026-10-29 background-floor gate
  // B3a: collect the per-dimension metric objects from the gates below so the
  // promoted winner can be recorded as a cross-run champion at finish.
  let champStars = null, champCore = null, champDetail = null, champSat = null, champDust = null;
  if (isEmergency) {
    warnings.push(`EMERGENCY BUDGET: ${budget.turnsRemaining} turns remaining. Non-safety gates relaxed to allow finish.`);
  }

  // Starless deliverable (narrowband palette now, RGB stars added later):
  // star gates do not apply. A palette gate takes their place (Gate 10b).
  const isStarless = !!brief?.dataDescription?.starless;
  if (isStarless) warnings.push('STARLESS deliverable: star gates skipped (stars are added later).');

  // Gate 1: Star quality (FWHM + color + brightness)
  // FWHM and color are advisory (native PSF can exceed 6px).
  // Brightness is BLOCKING — dim stars are always a failure when the profile asks for prominent/balanced.
  if (!isStarless) try {
    const starResult = await checkStarQuality(ctx, viewId, { minContrast: starMinContrast(profile), fwhmHard: gateThreshold(profile, 'stars.fwhm_hard', FWHM_HARD), ...starFieldOpts(brief) });
    champStars = starResult;
    // WI-16: advisory star-field metrics (centre/edge FWHM, ellipticity, absolute prominence). Never blocking.
    if (starResult.starField && !starResult.starField.error && starResult.starField.text) {
      warnings.push(`STAR FIELD (advisory, provisional): ${starResult.starField.text}`);
    }
    const prominence = brief?.processingProfile?.stars?.prominence || 'balanced';
    const minContrast = starMinContrast(profile);
    const brightnessOk = (starResult.starBgContrast || 0) >= minContrast;

    if (!brightnessOk) {
      const msg = `STARS TOO DIM: contrast=${(starResult.starBgContrast || 0).toFixed(1)}× vs background (limit: ${minContrast}× for ${prominence} stars), ` +
        `median peak=${(starResult.medianPeak || 0).toFixed(3)}, bg=${(starResult.bgMedian || 0).toFixed(4)}. ` +
        `FIX: increase star_protected_blend strength, use brighter stretch_stars params (lower setiMidtone or more iterations), or boost star layer with curves before blending.`;
      if (isEmergency) {
        warnings.push(`[RELAXED] ${msg}`);
      } else {
        fail('stars_brightness', msg, { metric: 'starBgContrast', value: starResult.starBgContrast || 0, limit: minContrast });
      }
    }
    // FWHM > 12px is blocking — but NOT for galaxies (galaxy knots/HII regions
    // are detected as "stars" with inflated FWHM, causing false positives)
    const isGalaxyTarget = (brief?.target?.classification || '').startsWith('galaxy');
    const fwhmHard = gateThreshold(profile, 'stars.fwhm_hard', FWHM_HARD);
    if ((starResult.medianFWHM || 0) > fwhmHard && !isGalaxyTarget) {
      const fwhmMsg = `STARS SEVERELY BLOATED: FWHM=${(starResult.medianFWHM || 0).toFixed(1)}px (hard limit: ${fwhmHard}px). ` +
        `Stars are unacceptably large. Re-stretch stars with higher setiMidtone (0.25+) or fewer iterations, ` +
        `apply stronger rolloff, or reduce star_protected_blend strength.`;
      if (isEmergency) {
        warnings.push(`[RELAXED] ${fwhmMsg}`);
      } else {
        fail('stars_fwhm', fwhmMsg, { metric: 'medianFWHM', value: starResult.medianFWHM || 0, limit: fwhmHard });
      }
    }
    // Gate 1c (2026-10-29, user-approved): faint-star retention. A crushed background takes the
    // faint stars with it; the detector's star density (stars per megapixel, same detector on
    // every image) must stay above the per-profile floor calibrated on approved images.
    {
      const minDensity = gateThreshold(profile, 'stars.min_density_per_mpx', null);
      const dens = starResult.starsPerMpx;
      if (Number.isFinite(dens)) {
        if (minDensity != null && dens < minDensity) {
          const dMsg = `FAINT STARS LOST: star density ${dens.toFixed(1)}/Mpx is below the profile floor ${minDensity}/Mpx (approved images of this class keep more). The background or star layer was clipped: lift the shadows / black point upstream (curves near the sky level), use a gentler rolloff, or re-blend the star layer with higher strength.`;
          if (isEmergency) warnings.push(`[RELAXED] ${dMsg}`);
          else fail('star_retention', dMsg, { metric: 'starsPerMpx', value: dens, limit: minDensity });
        } else if (minDensity == null) {
          warnings.push(`(advisory) star density ${dens.toFixed(1)}/Mpx (star-retention floor not calibrated for this profile).`);
        }
      }
    }
    // For galaxies, FWHM is advisory (galaxy knots inflate the measurement)
    // For non-galaxies with moderate FWHM, also advisory
    if (!starResult.pass && brightnessOk) {
      const fwhmNote = isGalaxyTarget ? ' (advisory for galaxies — HII knots inflate FWHM)' : '';
      warnings.push(`STAR QUALITY WARNING: ${starResult.details}${fwhmNote}`);
    }
  } catch (e) {
    // If star check errors out (e.g. no stars in starless image), skip gracefully
    // This handles the case where finish is called on a starless view
  }

  // Gate 1b: False-color palette balance (SHO/HOO). Ha-green left in a Hubble
  // palette, or magenta from S+O overlap, is the classic SHO failure.
  if (brief?.dataDescription?.narrowband) {
    try {
      const pal = await measurePaletteBalance(ctx, viewId, { palette: nbPaletteOf(brief) });
      mPalette = pal;
      const lim = brief?.processingProfile?.palette || {};
      const F = pal.families || {};
      const maxGreen = lim.max_green_frac ?? 0.10, maxMag = lim.max_magenta_frac ?? 0.08, minCool = lim.min_cool_frac ?? 0.05;
      const msgs = [];
      if ((F.green?.frac || 0) > maxGreen) msgs.push(`green ${(F.green.frac * 100).toFixed(1)}% > ${(maxGreen * 100).toFixed(0)}% — sho_hue_shift (higher strength) or lower h_gain in sho_combine`);
      if ((F.magenta?.frac || 0) > maxMag) msgs.push(`magenta ${(F.magenta.frac * 100).toFixed(1)}% > ${(maxMag * 100).toFixed(0)}% — sho_hue_shift magenta fold or lower s_gain/o_gain`);
      if ((pal.cool || 0) < minCool) msgs.push(`cyan/blue ${(pal.cool * 100).toFixed(1)}% < ${(minCool * 100).toFixed(0)}% — OIII not reading; raise o_gain`);
      if (msgs.length) {
        const msg = `PALETTE IMBALANCED: ${msgs.join('; ')}. (${pal.summary})`;
        if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('palette', msg);
      } else {
        warnings.push(`Palette OK: ${pal.summary}`);
      }
    } catch (e) {
      warnings.push(`Palette check error: ${e.message}`);
    }
  }

  // Gate 2: Ringing detection — category-aware (non-blocking for galaxies with natural radial profiles)
  try {
    const ringingResult = await checkRinging(ctx, viewId);
    const category = brief?.target?.classification || 'unknown';
    const morphologyConflict = ['galaxy_edge_on', 'galaxy_spiral', 'galaxy_cluster'].includes(category);
    if (!ringingResult.pass && !morphologyConflict) {
      warnings.push(`RINGING WARNING: ${ringingResult.details}`);
    }
  } catch (e) {
    // If ringing check fails to execute, warn but don't block
    warnings.push(`RINGING CHECK ERROR: ${e.message} — inspect manually`);
  }

  // Gate 3: Burn scan — HARD FAIL at BURN_CLIP (actual clipping)
  // Gate 3b: Bright block fraction — HARD FAIL if too many blocks above BRIGHT_BLOCK_LEVEL
  // v13 showed aggressive clamping destroys core detail, so a FEW bright blocks are OK.
  // But when a large fraction of the image is above BRIGHT_BLOCK_LEVEL (e.g. entire nebula shell),
  // detail is being lost across extended structure. Per-profile limit controls this.
  try {
    // WI-10: ONE PJSR pass (assessBurn) feeds both the clip gate and the bright-block gate.
    const burn = await assessBurn(ctx, viewId, { clip: BURN_CLIP, bright: BRIGHT_BLOCK_LEVEL });
    if (burn.error) fail('burn_clip', 'BURN SCAN FAILED: Burn scan failed');
    // Per-profile tolerance for clipped blocks (burn.max_clip_blocks, default 0): the
    // user-approved NGC4490 RGB.xisf has 19 clipped 50x50 blocks, all saturated bright
    // stars (46/60 sampled stars saturated), and was accepted. Core burn stays caught
    // separately by the core_burn white clause.
    const maxClipBlocks = gateThreshold(brief?.processingProfile, 'burn.max_clip_blocks', 0);
    if (burn.clipBlocks > maxClipBlocks) {
      const pc = burn.perChannelExceedance;
      const tot = (pc.R + pc.G + pc.B) || 0;
      const rHot = tot > 0 && pc.R / tot > 0.5 && pc.R > 0.001;
      const where = burn.worstClipBlocks.length ? ` Locations: ${burn.worstClipBlocks.map(b => `[${b.x},${b.y}] ${b.pctBurnt}%`).join(', ')}.` : '';
      fail('burn_clip', `BURN SCAN FAILED: BURNT REGIONS: ${burn.clipBlocks} block(s) of ${burn.blockSize}x${burn.blockSize}px have >3% pixels above ${BURN_CLIP}. Limit for this profile: ${maxClipBlocks} block(s).${where} Apply min($T, 0.80) through core mask, or reduce stretch/LHE/curves strength.` +
        (rHot ? ' R channel hot — reduce ha_inject (strength or max_output).' : ''));
    }
    // Bright block fraction gate at BRIGHT_BLOCK_LEVEL
    const softBurn = { burntBlockCount: burn.brightBlocks, totalBlocks: burn.totalBlocks };
    if (burn.brightBlocks > 0) {
      const brightPct = burn.brightFraction * 100;
      const maxBrightPct = brief?.processingProfile?.burn?.max_bright_block_pct ?? 3.0;
      if (brightPct > maxBrightPct) {
        const msg = upstreamHint(`TOO MANY BRIGHT REGIONS: ${softBurn.burntBlockCount} blocks (${brightPct.toFixed(1)}%) above ${BRIGHT_BLOCK_LEVEL.toFixed(2)} (limit: ${maxBrightPct}%). ` +
          `Extended structure is losing detail. Apply continuous_clamp (min_clamp=0.75, max_clamp=0.90) to recover detail in bright areas.`, 'scan_burnt_regions', brief, viewId);
        if (isEmergency) {
          warnings.push(`[RELAXED] ${msg}`);
        } else {
          fail('bright_blocks', msg);
        }
      } else {
        warnings.push(`BRIGHT REGIONS: ${softBurn.burntBlockCount} block(s) (${brightPct.toFixed(1)}%) above ${BRIGHT_BLOCK_LEVEL.toFixed(2)}, within limit (${maxBrightPct}%). Core may look bright — verify internal structure is still visible.`);
      }
    }
  } catch (e) {
    // Non-blocking if check fails
  }

  // Gate 3c: Core relative contrast — catches a PERCEPTUAL burn that the
  // clipping gates (3/3b) miss: a bright core that is not clipped (peak < 0.85)
  // but reads as a flat washed-out white zone because its structure is tiny
  // relative to its brightness. Only applies when there is a real extended
  // bright core (skips starfields and all-bright frames).
  try {
    const coreC = await measureCoreContrast(ctx, viewId, brief?.target?.classification, brief?.processingProfile?.core_burn);
    champCore = coreC;
    const frac = coreC.coreFraction || 0;
    // Lower bound skips starfields (a star core is tiny). Profiles may lower it
    // (core_burn.min_core_fraction): back-test 2026-10-28 showed the rejected
    // NGC4490 white-blob core has coreFraction 0.0023 (small galaxy in a 60 MP
    // field) and was silently skipped at the 0.003 default, while the approved
    // NGC3628 measures 0.0082.
    const cbCfg = brief?.processingProfile?.core_burn || {};
    const minCoreFrac = (typeof cbCfg.min_core_fraction === 'number') ? cbCfg.min_core_fraction : 0.003;
    const isExtendedCore = frac >= minCoreFrac && frac <= 0.20;
    if (isExtendedCore && !coreC.pass) {
      const msg = upstreamHint(`CORE PERCEPTUALLY BURNT: ${coreC.details}`, 'finish:core_contrast', brief, viewId);
      if (isEmergency) {
        warnings.push(`[RELAXED] ${msg}`);
      } else {
        fail('core_contrast', msg, { metric: 'coreRelContrast', value: coreC.coreRelContrast ?? null, limit: null });
      }
    } else if (isExtendedCore && coreC.relAdvisory) {
      warnings.push(coreC.details);
    } else if (isExtendedCore && coreC.coreRelContrast < 0.30) {
      warnings.push(`Core contrast moderate (relContrast=${coreC.coreRelContrast.toFixed(3)}, ratio=${(coreC.ratio||0).toFixed(2)}); structure could be more visible in the bright center.`);
    }
  } catch (e) {
    // Non-blocking if check fails
  }

  // Gate 3e: IFN / brown-dust presence (dust-dominated fields, e.g. reflection
  // nebulae embedded in molecular cloud). The median floor (Gate 5) is BLIND to
  // dust distribution — the user-approved iter03 (dust fills the frame) and the
  // regressed giga run (empty black field) had IDENTICAL median 0.0784. This gate
  // keys on dust COLOR (dustMeanSat) + dust PEAKS (fieldP95) instead, validated
  // on those two images. Profile-driven: only runs when the profile declares `ifn`.
  if (brief?.processingProfile?.ifn) {
    try {
      const dust = await measureDustCoverage(ctx, viewId, brief.processingProfile.ifn);
      champDust = dust;
      if (!dust.pass) {
        const msg = `IFN/DUST GATE: ${dust.details}`;
        if (isEmergency) warnings.push(`[RELAXED] ${msg}`);
        else fail('dust_ifn', msg);
      } else if (dust.details && /advisory/.test(dust.details)) {
        warnings.push(`Dust: ${dust.details}`);
      }
    } catch (e) {
      // Non-blocking if check fails
    }
  }

  // Gate 3d: Background noise — final grain check. Aggressive LHE/stretch
  // amplifies pixel-scale noise; this requires a light denoise if too grainy.
  try {
    const noiseR = await measureBackgroundNoise(ctx, viewId, { profile });
      mNoise = noiseR;
    // measureBackgroundNoise now checks BOTH dark-sky (bgNoise) AND dust-band grain
    // (dustNoise) — the latter catches grain on lifted IFN that the dark-sky-only
    // metric was structurally blind to. noiseR.pass reflects both.
    if (!noiseR.pass) {
      const msg = `BACKGROUND TOO NOISY: ${noiseR.details}`;
      if (isEmergency) warnings.push(`[RELAXED] ${msg}`);
      else fail('noise', msg);
    } else if ((noiseR.bgNoise || 0) > 0.015 || (noiseR.dustNoise || 0) > 0.030) {
      warnings.push(`Slight grain (bgNoise=${(noiseR.bgNoise||0).toFixed(4)}, dustNoise=${(noiseR.dustNoise||0).toFixed(4)}). A light final NXT pass could help.`);
    }
  } catch (e) {
    // Non-blocking if check fails
  }

  // Gate 3e (WI-26 B): chroma noise / colour mottle — ADVISORY only (profile ceilings default null).
  try {
    const cnR = await measureChromaNoise(ctx, viewId, { profile });
    if (!cnR.error) {
      report.chromaNoise = { chromaNoise: cnR.chromaNoise, chromaToLumNoise: cnR.chromaToLumNoise, mottle16: cnR.mottle16, mottle48: cnR.mottle48 };
      if (!cnR.pass) warnings.push(`CHROMA NOISE (advisory): ${cnR.details}`);
    }
  } catch (e) { /* advisory */ }

  // Gate 13 (WI-26 A): background banding / corner colour — ADVISORY unless profile gradient.blocking=true.
  // A ramp is a gradient (fits a line); a band is a localized step (residual from the fit), which the
  // peak-to-peak colour-gradient score cannot see.
  try {
    const gcfg = Object.assign({ warn: 0.012, block: 0.020, band_block: null, min_bg_cells: 12, blocking: false }, (profile && profile.gradient) || {});
    const cg = await measureColorGradient(ctx, viewId, { minBgCells: gcfg.min_bg_cells });
    if (cg && typeof cg.score === 'number' && !cg.error && cg.score < 900) {
      const band = cg.band || {};
      report.gradient = { score: cg.score, band, cornerLumDelta: cg.cornerLumDelta ?? null, cornerChroma: cg.cornerChroma ?? null, cfg: gcfg };
      const msgs = [];
      if (band.insufficientBg) {
        msgs.push(`insufficient background cells (${band.bgCells} < ${gcfg.min_bg_cells}) — band check skipped`);
      } else {
        if (cg.score > gcfg.warn) msgs.push(`colour gradient score=${cg.score.toFixed(4)} > ${gcfg.warn}`);
        if (band.amp > gcfg.warn) msgs.push(`${band.axis} band at index ${band.index} (${band.channel}, amp=${band.amp.toFixed(4)}, step=${(band.stepMax || 0).toFixed(4)})`);
      }
      const hard = !band.insufficientBg && (cg.score > gcfg.block || (typeof gcfg.band_block === 'number' && band.amp > gcfg.band_block));
      const hint = band.axis ? `band at ${band.axis} ${band.index}: apply_mask with an inverted outer-field mask then a masked run_pixelmath/run_curves per channel (or run_gradient_correction on the final) to flatten the band, OR redo the last lift_dust/inject_l_ifn with a gentler taper; do NOT re-run the linear gradient stage.` : 'Redo the last lift with a gentler taper; do NOT re-run the linear gradient stage.';
      if (msgs.length) {
        const msg = `BACKGROUND GRADIENT/BANDING: ${msgs.join('; ')}. ${hint}`;
        if (gcfg.blocking === true && hard && !isEmergency) fail('gradient', msg);
        else warnings.push(`${gcfg.blocking === true ? '' : '(advisory) '}${msg}`);
      }
    }
  } catch (e) { /* advisory */ }

  // Gate 4: Subject detail — HARD GATE for brightness and contrast
  try {
    const detailResult = await measureSubjectDetail(ctx, viewId, { profile, faintStructureGoal: brief?.target?.fieldCharacteristics?.faintStructureGoal });
    champDetail = detailResult;
    if (detailResult.subjectBrightness < SUBJECT_MIN) {
      fail('subject_brightness', `SUBJECT TOO DIM: brightness=${detailResult.subjectBrightness.toFixed(3)} (minimum: ${SUBJECT_MIN}). Subjects must be clearly visible and impactful. Stretch harder, apply shadow-lifting curves, boost through masks. For PNe: outer halo must be visible.`);
    } else if (detailResult.subjectBrightness < 0.30) {
      warnings.push(`Subjects could be brighter (brightness=${detailResult.subjectBrightness.toFixed(3)}, goal: >0.35). Consider shadow-lift curves or masked brightness boost.`);
    }
    // Contrast gate: adaptive for targets with faint outer structure (PNe, IFN)
    // Halo visibility requires brighter background which inherently lowers contrast
    const contrastGate = contrastGateFor(brief?.target?.fieldCharacteristics?.faintStructureGoal);
    const contrastGoal = contrastGate * 1.5;
    if (detailResult.contrastRatio < contrastGate) {
      fail('subject_contrast', `CONTRAST TOO LOW: ratio=${detailResult.contrastRatio.toFixed(1)}× (minimum: ${contrastGate}×). Subjects don't separate from background. Use masked curves/LHE to boost subjects selectively.`);
    } else if (detailResult.contrastRatio < contrastGoal) {
      warnings.push(`Moderate contrast (ratio=${detailResult.contrastRatio.toFixed(1)}×, goal: >${contrastGoal}×). Could improve with masked luminance boost.`);
    }
    const detailMin = gateThreshold(profile, 'detail.min_detail', DETAIL_MIN);
      if (detailResult.detailScore < detailMin) {
      fail('subject_detail', `DETAIL TOO LOW: score=${detailResult.detailScore.toFixed(6)} (minimum: ${detailMin}). Subjects look like smooth blobs. ${(/emission/.test(brief?.target?.classification || '') || brief?.dataDescription?.narrowband) ? 'Use shell_detail_enhance (medium 0.6, large 0.4) through a body mask (multi_scale_enhance is blocked for emission).' : 'Apply LHE (r=32-128) through luminance masks to bring out internal structure.'}`);
    } else if (detailResult.detailScore < 0.003) {
      warnings.push(`Low detail score (${detailResult.detailScore.toFixed(6)}, goal: >0.005). Fine-scale LHE (r=32, r=64) through tight masks can help.`);
    }
    // Detail gain / noise dominance: ADVISORY only (profile detail.max_gain is PROVISIONAL).
    try {
      const sc = brief?._lastStarlessComposite;
      const measured = (sc && sc.detail) ? sc.detail : summarizeDetail(detailResult);
      const ev = evaluateDetailGain(measured, brief?._baselineDetail, !!brief?._hasL, profile);
      if (ev.message) warnings.push(`[ADVISORY detail] ${ev.message}${sc && sc.detail ? ' (measured on the pre-star-blend starless composite)' : ' (star-rejected sampling on the final)'}.`);
    } catch (e) { /* advisory only */ }
    // Check subject coverage — tiny subjects indicate under-stretched outer structure
    const totalBlocks = detailResult.raw?.totalBlocks || 1;
    const subjectCoverage = (detailResult.subjectCount || 0) / totalBlocks;
    if (subjectCoverage < 0.02) {
      warnings.push(`Subject covers only ${(subjectCoverage * 100).toFixed(1)}% of image — outer halo/faint structure may be invisible. Consider shadow-lifting curves through inverted mask.`);
    }
  } catch (e) {
    // Non-blocking
  }

  // Gate 5: Overall exposure — composite must not be absurdly dark
  // Uses the processing profile target if available
  const targetMedian = brief?.processingProfile?.stretch?.target_median || 0.15;
  const minMedian = targetMedian * 0.35; // e.g. 0.18 * 0.35 = 0.063
  if (stats.median < minMedian) {
    fail('exposure', `IMAGE TOO DARK: median=${stats.median.toFixed(4)} (minimum: ${minMedian.toFixed(4)}, based on target ${targetMedian}). The overall exposure is far below target. Stretch RGB harder before LRGB, apply brightness curves, or reduce background clipping.`);
  } else if (stats.median < targetMedian * 0.5) {
    warnings.push(`Image darker than target: median=${stats.median.toFixed(4)} vs target=${targetMedian}. May be OK for small subjects in large fields, but verify outer structure is visible.`);
  }

  // Gate 5b (2026-10-29, user-approved): background floor — a sky crushed to black.
  // Blocking only once the profile carries calibrated background.min_level /
  // background.max_black_fraction (floors from approved images); advisory otherwise.
  try {
    const bf = await measureBackgroundFloor(ctx, viewId);
    mBgFloor = bf;
    const minLevel = gateThreshold(profile, 'background.min_level', null);
    const maxBlack = gateThreshold(profile, 'background.max_black_fraction', null);
    const problems = [];
    if (minLevel != null && bf.bgLevel < minLevel) problems.push(`sky level ${bf.bgLevel.toFixed(4)} < floor ${minLevel}`);
    if (maxBlack != null && bf.blackBlockFraction > maxBlack) problems.push(`${(bf.blackBlockFraction * 100).toFixed(1)}% of background blocks are black (<0.015), limit ${(maxBlack * 100).toFixed(0)}%`);
    if (problems.length) {
      const msg = `BACKGROUND CRUSHED TO BLACK: ${problems.join('; ')} (${bf.details}). FIX UPSTREAM: lift the shadows with a curves point just above the sky level (e.g. [0.01->0.03]) or reduce black-point clipping in the last stretch/clamp/rolloff; do not brighten the subject.`;
      if (isEmergency) warnings.push(`[RELAXED] ${msg}`);
      else fail('background_floor', msg, { metric: 'bgLevel', value: bf.bgLevel, limit: minLevel ?? maxBlack });
    } else if (minLevel == null && maxBlack == null) {
      warnings.push(`(advisory) background floor: ${bf.details} (not calibrated for this profile).`);
    }
  } catch (e) {
    warnings.push(`Background floor check error: ${e.message}`);
  }

  // Gate 6 (per-channel img.maximum() peak check) deleted in WI-10: it fired on any single star pixel
  // above 0.92. Per-channel exceedance now comes from assessBurn (Gate 3 hint for a hot R channel).

  // Gate 7: Saturation naturalness — compare against per-category limit
  try {
    const satResult = await checkSaturation(ctx, viewId);
    champSat = satResult;
    if (satResult.subjectPixelCount > 100) {
      const { maxP90, warnAt, failAt } = saturationThresholds(brief);
      if (satResult.p90S > failAt) {
        const provRec = brief?._provenance?.get(viewId);
        const prov = provRec?.lastComposition || provRec;   // WI-06: composition provenance
        const repairHint = prov?.tool === 'lrgb_combine'
          ? ` REPAIR: restore_from_clone → lrgb_combine with saturation=${Math.max(0.20, (prov.params?.saturation ?? 0.80) - 0.20).toFixed(2)}. Do NOT desaturate the combined result.`
          : ' Reduce saturation at the source (curves, LRGB params, Ha injection).';
        const msg = `OVER-SATURATED: P90=${satResult.p90S.toFixed(3)} (limit: ${failAt.toFixed(2)}, profile max_p90=${maxP90.toFixed(2)}).${repairHint}`;
        if (isEmergency) {
          warnings.push(`[RELAXED] ${msg}`);
        } else {
          fail('saturation', msg, { metric: 'p90S', value: satResult.p90S, limit: failAt });
        }
      } else if (satResult.p90S > warnAt) {
        warnings.push(`Saturation high: P90=${satResult.p90S.toFixed(3)} (profile ${brief?.processingProfile?.look ? 'target' : 'limit'}: ${warnAt.toFixed(2)}, fails above ${failAt.toFixed(2)}). Consider reducing saturation slightly for more natural appearance.`);
      }
    }
  } catch (e) {
    warnings.push(`Saturation check error: ${e.message} — inspect manually`);
  }

  // Gate 7b (2026-11-07): saturation FLOOR + fine-detail balance + disc mottle, calibrated on the user's
  // galaxy references (M101 x2, M83; ~/Downloads, measured with these same functions) vs the rejected M74 v2
  // ("washed out", "watercolour"). Profile keys: saturation.min_p50, texture_scale.{min_fine_blob,max_mid_mottle}.
  try {
    const minArm = profile?.saturation?.min_arm_p50, invS = brief?._inventory;
    if (Number.isFinite(minArm) && invS?.zones) {
      const zs = await measureZoneStructure(ctx, viewId, invS);
      if (zs.armSat != null && zs.armSat < minArm) {
        const msg = `UNDER-SATURATED ARMS: median saturation of the ARM pixels ${zs.armSat.toFixed(3)} < floor ${minArm} (inter-arm gaps ${zs.gapSat?.toFixed(3)}; ${profile.saturation._arm_calibration || 'reference-calibrated'}). Colour the arms (chroma curve through an arm/galaxy mask, AFTER tonal and local-contrast work, which shift saturation by -17%..+20%); tinting the gaps does not count.`;
        if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('saturation_floor', msg, { metric: 'armSat', value: zs.armSat, limit: minArm });
      }
    }
    const minP50 = Number.isFinite(minArm) && invS?.zones ? null : profile?.saturation?.min_p50;
    if (Number.isFinite(minP50) && champSat && champSat.subjectPixelCount > 100 && champSat.medianS < minP50) {
      const msg = `UNDER-SATURATED: subject median saturation ${champSat.medianS.toFixed(3)} < floor ${minP50} (${profile.saturation._floor_calibration || 'reference-calibrated'}). Colour reads washed out. Raise colour at the source (LRGB saturation, colour-saturation curve through the galaxy mask, warmer HII); never a global boost that lifts sky chroma.`;
      if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('saturation_floor', msg, { metric: 'medianS', value: champSat.medianS, limit: minP50 });
    }
  } catch (e) { warnings.push(`Saturation floor check error: ${e.message}`); }
  const ts = profile?.texture_scale;
  if (ts && (Number.isFinite(ts.min_fine_blob) || Number.isFinite(ts.min_ratio_vs_prep) || Number.isFinite(ts.max_mid_mottle))) {
    try {
      if (Number.isFinite(ts.min_fine_blob) || Number.isFinite(ts.min_ratio_vs_prep)) {
        const sb = await measureScaleBands(ctx, viewId, { rDisc: brief?._baselineDetail?.scale?.rDisc });
        if (!sb.error && Number.isFinite(ts.max_fine_blob) && sb.ratio > ts.max_fine_blob) {
          const msg = `OVER-SHARPENED DISC: fine/blob detail ratio ${sb.ratio.toFixed(3)} > ${ts.max_fine_blob} (references top out near ${ts.max_fine_blob}) — crunchy 1-3 px knots and grain. Back off the last fine-scale sharpening (BXT nonstellar / MLT layers 1-2 / USM) or apply light NXT through the galaxy mask.`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('fine_detail', msg, { metric: 'fineBlob', value: sb.ratio, limit: ts.max_fine_blob });
        }
        const prepRatio = brief?._baselineDetail?.scale?.ratio;
        if (!sb.error && Number.isFinite(ts.min_ratio_vs_prep) && Number.isFinite(prepRatio) && sb.ratio < prepRatio * ts.min_ratio_vs_prep) {
          const msg = `DETAIL LOST VS PREP: fine/blob ${sb.ratio.toFixed(3)} < x${ts.min_ratio_vs_prep} of the prep ratio ${prepRatio.toFixed(3)} — the knots and fine structure the data had at prep were smoothed away (M74 v4/v5). Reveal the knots: fine-scale enhancement (BXT / MLT layers 1-2) on the galaxy, lighter noise reduction through the galaxy mask, no blob-scale smoothing.`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('fine_detail', msg, { metric: 'fineBlobVsPrep', value: sb.ratio / prepRatio, limit: ts.min_ratio_vs_prep });
        }
        if (!sb.error && Number.isFinite(ts.min_fine_blob) && sb.ratio < ts.min_fine_blob) {
          const msg = `WATERCOLOUR DISC: fine/blob detail ratio ${sb.ratio.toFixed(3)} < ${ts.min_fine_blob} — 0.7-3 px structure smeared while 3-6 px blobs remain. Use less noise reduction on the galaxy (NXT <= 0.25 through the galaxy mask), drop/soften LHE/HDRMT at radius < 32, and sharpen fine scales (BXT/ MLT layers 1-2) before any blob-scale contrast.`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('fine_detail', msg, { metric: 'fineBlob', value: sb.ratio, limit: ts.min_fine_blob });
        }
      }
      if (Number.isFinite(ts.max_mid_mottle)) {
        const mo = await measureDiscMottle(ctx, viewId, { radius: brief?._baselineDetail?.scale?.rDisc });
        if (!mo.error && mo.mid != null && mo.mid > ts.max_mid_mottle) {
          const msg = `disc mottle: ${mo.details} > ${ts.max_mid_mottle}. Blotchy mid disc — reduce blob-scale contrast (LHE r 64-128 / HDRMT) on the disc.`;
          if (ts.mottle_blocking === true && !isEmergency) fail('disc_mottle', `DISC MOTTLE: ${msg}`, { metric: 'midMottle', value: mo.mid, limit: ts.max_mid_mottle });
          else warnings.push(`${ts.mottle_blocking ? '[RELAXED]' : '(advisory)'} ${msg}`);
        }
      }
    } catch (e) { warnings.push(`Texture-scale check error: ${e.message}`); }
  }
  // Gate 7c (2026-11-07): data-anchored zones from the PREP signal inventory (brief._inventory: centre, detection
  // radius, core/disc/outer/sky zones on the deepest starless channel). (1) outer zone: what the data holds must
  // read above sky (net of sky spread) — M74 v3 0.018 "outer arms not visible", v4 0.082 visible; (2) core
  // preservation: final core/disc index vs the prep index must not collapse (M74 v4 lifted the whole disc).
  // Explicit profile outer_arms.r_min_px/r_max_px override the inventory annulus.
  const oa = profile?.outer_arms, cp = profile?.core_preservation, inv = brief?._inventory;
  if ((oa && Number.isFinite(oa.min_net_contrast)) || (cp && (Number.isFinite(cp.min_ratio_vs_prep) || Number.isFinite(cp.min_core_structure))) || Number.isFinite(profile?.envelope?.min_sector_ratio)) {
    try {
      let zi = null;
      if (inv?.zones && inv?.centre) zi = await measureInventoryZones(ctx, viewId, inv);
      if (oa && Number.isFinite(oa.min_net_contrast)) {
        let net = null, where = '';
        if (Number.isFinite(oa.r_min_px) && Number.isFinite(oa.r_max_px)) {
          const o = await measureOuterArms(ctx, viewId, oa.r_min_px, oa.r_max_px);
          if (!o.error) { net = o.net; where = `r ${oa.r_min_px}-${oa.r_max_px}px (profile)`; }
        } else if (zi?.outerNet != null) { net = zi.outerNet; where = `r ${inv.zones.outer[0]}-${inv.zones.outer[1]}px (prep inventory: data detected to ${inv.rDet}px)`; }
        if (net != null && net < oa.min_net_contrast) {
          const msg = `OUTER ZONE INVISIBLE: net contrast ${net.toFixed(4)} < ${oa.min_net_contrast} in ${where}. The linear data holds structure there but the stretch buries it. Lift ONLY the outer zone (mask: outside the inner disc, excluding sky) with a shadow/low-midtone curve; keep core and inner-disc contrast; sky stays at its level.`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('outer_arms', msg, { metric: 'outerNet', value: net, limit: oa.min_net_contrast });
        }
      }
      if (cp && Number.isFinite(cp.min_ratio_vs_prep) && zi?.coreIdx != null && Number.isFinite(inv?.prepCoreIdx) && inv.prepCoreIdx > 0) {
        const ratio = zi.coreIdx / inv.prepCoreIdx;
        if (ratio < cp.min_ratio_vs_prep) {
          const msg = `CORE FLATTENED: core/disc index ${zi.coreIdx.toFixed(2)} is x${ratio.toFixed(2)} of prep ${inv.prepCoreIdx.toFixed(2)} (< x${cp.min_ratio_vs_prep}). The disc was lifted toward the core: the galaxy reads flat and hazy. Undo global/whole-disc lifts; lift only the outer zone through a mask and keep the core brighter than the disc.`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('core_preservation', msg, { metric: 'coreIdxRatio', value: ratio, limit: cp.min_ratio_vs_prep });
        }
      }
      const envp = profile?.envelope;
      if (envp && Number.isFinite(envp.min_sector_ratio) && inv?.prepEnvelope) {
        const c = await envelopeClip(ctx, brief, viewId);
        if (c?.evaluated && c.worst && c.worst.ratio < envp.min_sector_ratio) {
          const msg = `ENVELOPE CLIPPED (${c.worst.name}): the outer glow on that side is x${c.worst.ratio.toFixed(2)} of what the prep data holds there (< x${envp.min_sector_ratio}) — a mask/threshold or gradient-model edge (critic: "mask-like edge"). Typical cause: GradientCorrection/ABE on stretched data with the galaxy in frame, or a luminance-threshold mask riding a residual sky tilt. Undo it; keep large-scale background work in the linear gradient phase.`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('envelope_clip', msg, { metric: 'envelopeSectorRatio', value: c.worst.ratio, limit: envp.min_sector_ratio });
        }
      }
      if (cp && Number.isFinite(cp.min_core_structure) && inv?.zones) {
        const zs = await measureZoneStructure(ctx, viewId, inv);
        if (zs.coreWeber < cp.min_core_structure) {
          const msg = `FEATURELESS CORE: core fine-structure ${zs.coreWeber.toFixed(4)} < ${cp.min_core_structure} (prep ${inv.prepCoreWeber?.toFixed(4) ?? 'n/a'}; ${cp._structure_calibration || ''}). The core is bright but smooth — the nuclear dust lanes are gone. Use the core specialist / a core-masked HDRMT or fine-scale sharpening on the core; do not flatten it with curves.`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('core_structure', msg, { metric: 'coreWeber', value: zs.coreWeber, limit: cp.min_core_structure });
        }
      }
      // Cooked core (2026-11-08, M74 v7; calibrated on 5 user reference galaxies + approved NGC4490).
      if (cp && Number.isFinite(cp.max_core_spectrum) && inv?.zones) {
        const sp = await measureCoreSpectrum(ctx, viewId, inv);
        if (sp.spectrum != null && sp.spectrum > cp.max_core_spectrum) {
          const msg = `COOKED CORE: core texture spectrum (fine/coarse) ${sp.spectrum.toFixed(2)} > ${cp.max_core_spectrum} (${cp._spectrum_calibration || ''}). Fine texture now dominates the core: small-radius local contrast (LHE/HDRMT/MLT on the core) turned the dust lanes into a cell/worm pattern with dark outlines. Back off small-radius local contrast on the core; let the large-scale lanes carry the structure.`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('core_cooked', msg, { metric: 'coreSpectrum', value: sp.spectrum, limit: cp.max_core_spectrum });
        }
      }
      // Filled inter-arm gaps (2026-11-08, M74 "haze between the arms"; user refs 0.38-0.88, M74 ref 0.63).
      const agp = profile?.arm_gaps;
      if (agp && Number.isFinite(agp.min_depth) && inv?.zones) {
        const ag = await measureArmGapDepth(ctx, viewId, inv);
        if (ag.depth != null && ag.depth < agp.min_depth) {
          const msg = `HAZY ARMS: arm/gap depth ${ag.depth.toFixed(3)} < ${agp.min_depth} (${agp._calibration || ''}). The gaps between the arms are filled: the arms do not separate. Typical causes: whole-disc lifts/midtone curves, large-radius LHE, chroma blurs spreading arm colour into the gaps. Lift only what the gaps do not hold (arms/outer zone through a mask) or deepen the gaps with a gap-selective curve.`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('arm_gap_depth', msg, { metric: 'armGapDepth', value: ag.depth, limit: agp.min_depth });
        }
      }
      // Ha knots lost (2026-11-08, M101 friend data): only armed when the prep found Ha knots (Ha data exists).
      const hkp = profile?.ha_knots;
      if (hkp && Number.isFinite(hkp.min_pink_frac) && inv?.haKnots) {
        const hk = await measureHaKnotColour(ctx, viewId, inv.haKnots);
        if (hk.evaluated && hk.pinkFrac < hkp.min_pink_frac) {
          const msg = `HA KNOTS LOST: only ${(100 * hk.pinkFrac).toFixed(0)}% of the HII-knot pixels found in the prep Ha are still pink-red (< ${(100 * hkp.min_pink_frac).toFixed(0)}%; ${(100 * hk.whiteFrac).toFixed(0)}% clipped to white, median hue ${hk.medHue?.toFixed(0)}°; ${hkp._calibration || ''}). A hue shift toward blue, a global chroma/brightness push or a blue-violet palette match washed the Ha out. Keep the Ha-injected knot colour: shift hue through an inverted Ha-knot mask, protect knots from brightness gain, and do not chase the reference palette with a global hue rotation.`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('ha_knots', msg, { metric: 'haKnotPinkFrac', value: hk.pinkFrac, limit: hkp.min_pink_frac });
        }
      }
      // Mask-shaped outer edge (2026-11-08, M74 v7 "lumpy polygonal boundary, dark moat"; user refs <= 1.48).
      if (envp && Number.isFinite(envp.max_edge_steepening) && inv?.zones) {
        const es = edgeSteepening(await measureSectorProfiles(ctx, viewId, inv), inv.rDet);
        if (es.evaluated && es.steepening > envp.max_edge_steepening) {
          const msg = `MASK-LIKE GLOW EDGE: the outer glow fades x${es.steepening.toFixed(2)} faster at its edge than inside (> x${envp.max_edge_steepening}; ${envp._steepening_calibration || ''}). A lifted plateau ending in a cliff (excess 0.2 -> 0.03 of its 0.6 rDet level over only ${(es.tail * inv.rDet).toFixed(0)} px). Feather the outer-zone lift: a mask whose falloff extends past the detected radius (large blur), or a lift that tapers with radius, so the glow keeps fading into the sky.`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`); else fail('edge_softness', msg, { metric: 'edgeSteepening', value: es.steepening, limit: envp.max_edge_steepening });
        }
      }
    } catch (e) { warnings.push(`Inventory-zone check error: ${e.message}`); }
  }

  // Gate 8: Tonal presence — subject must be impactful, not merely safe
  // Adaptive threshold: small subjects (< 3% coverage) get relaxed gate (2.5×)
  // because global tonal curves to force 3× on tiny subjects destroy the core
  try {
    const category = brief?.target?.classification || 'unknown';
    const tonalResult = await checkTonalPresence(ctx, viewId, category);
      mTonal = tonalResult;
    const subjectCoverage = (tonalResult.subjectPixelCount || 0) / ((tonalResult.subjectPixelCount || 1) + 1000);
    const isSmallSubject = category.startsWith('galaxy') && subjectCoverage < 0.03;
    const tonalThreshold = isSmallSubject ? TONAL_SMALL : gateThreshold(profile, 'tonal.min_separation', TONAL);
    const effectivelySubdued = tonalResult.separation < tonalThreshold;
    if (effectivelySubdued) {
      if (tonalResult.roi_confidence === 'low') {
        warnings.push(`TONAL PRESENCE advisory: subject appears subdued (separation=${tonalResult.separation.toFixed(2)}×) but ROI confidence is low — manual inspection recommended.`);
      } else {
        const msg = `TONAL PRESENCE SUBDUED: subject/background separation=${tonalResult.separation.toFixed(2)}× (need >${tonalThreshold}×${isSmallSubject ? ' — relaxed for small galaxy' : ''}). ` +
          (brief?.dataDescription?.narrowband ? `Subject is too dim to be impactful. Lift the body through a luminance mask (run_curves), then lift_faint_halo; no galaxy core mask.` : `Subject is too dim to be impactful. Apply subject-masked midtone lift through INVERTED core mask — protect the bright core, boost only the outer body and arms.`);
        if (isEmergency) {
          warnings.push(`[RELAXED] ${msg}`);
        } else {
          fail('tonal_presence', msg, { metric: 'separation', value: tonalResult.separation, limit: tonalThreshold });
        }
      }
    } else if (tonalResult.tonal_verdict === 'aggressive') {
      warnings.push(`Tonal presence aggressive (separation=${tonalResult.separation.toFixed(2)}×). Verify no burns in bright subject areas.`);
    }
  } catch (e) {
    // Non-blocking
  }

  // Gate 9: Highlight texture — any target with bright structure
  // Detects perceptual burn (bright zones with collapsed tonal variation)
  // Originally emission-only, extended to galaxies after NGC4490 core burn
  const category = brief?.target?.classification || 'unknown';
  const hasBrightCore = brief?.processingProfile?.characteristics?.has_bright_core;
  if (category.includes('emission') || category.startsWith('galaxy') || hasBrightCore ||
      brief?.target?.fieldCharacteristics?.structuralZones === 'multi_zone') {
    try {
      // Deterministic baseline (WI-26 C): prep stores brief._baselineTexture (RGB/L/Ha) and
      // brief._roi; the star blend stashes brief._preBlendTexture (starless input). Finish opens
      // NO window: when the finish view is the blend output it uses the pre-blend (starless)
      // measurement, otherwise it measures the finish view itself with the stored ROI.
      const htCfg = brief?.processingProfile?.highlight_texture || {};
      const base = brief?._baselineTexture || null;
      const refMetrics = base ? ((brief?.dataDescription?.narrowband && base.ha && !base.ha.error) ? base.ha : base.rgb) : null;
      const pre = brief?._preBlendTexture;
      const usePre = !!(pre && pre.metrics && !pre.metrics.error && pre.outputId === viewId);
      let htResult;
      htResult = await checkHighlightTexture(ctx, viewId, {
        referenceMetrics: refMetrics && !refMetrics.error ? refMetrics : undefined,
        currentMetrics: usePre ? pre.metrics : undefined,
        roi: brief?._roi || base?.roi || undefined,
        minRetention: typeof htCfg.min_retention === 'number' ? htCfg.min_retention : undefined,
        warnRetention: typeof htCfg.warn_retention === 'number' ? htCfg.warn_retention : undefined
      });
      mTexture = htResult;

      if (!htResult.pass && htCfg.blocking !== true) {
        // Warn-first: thresholds are uncalibrated against the deterministic prep baseline.
        warnings.push(`HIGHLIGHT TEXTURE (advisory, baseline-relative): ${htResult.details} Set profile highlight_texture.blocking=true after the harness calibrates it.`);
      } else if (!htResult.pass) {
        const msg = `HIGHLIGHT TEXTURE COLLAPSED: ${htResult.details}. ` +
          `Restore pre-operation checkpoint. If after clamp: raise knee, increase headroom, or skip clamp. ` +
          `If after detail tool: switch to shell_detail_enhance or reduce amounts. Do NOT clamp harder.`;
        if (isEmergency) {
          warnings.push(`[RELAXED] ${msg}`);
        } else {
          fail('highlight_texture', msg);
        }
      } else if (htResult.verdict === 'degraded') {
        warnings.push(`HIGHLIGHT TEXTURE WARNING: ${htResult.details}`);
      }
    } catch (e) {
      // Non-blocking on error
      warnings.push(`Highlight texture check error: ${e.message}`);
    }
  }

  // Gate 10: L data must be incorporated — via lrgb_combine OR PixelMath L injection
  const hasL = !!(brief?.dataDescription?.channels?.L);
  const lrgbAvoided = brief?.processingProfile?.tools?.LRGB?.use === 'avoid';
  if (hasL && !lrgbAvoided && mode !== 'backtest') {
    // Provenance-based (brief._lUsage); trace.jsonl is only a fallback when _lUsage is undefined.
    let lUsed = false;
    let traceContent = null;
    if (!Array.isArray(brief?._lUsage) && store) {
      try {
        const tracePath = path.join(store.baseDir, 'trace.jsonl');
        if (fs.existsSync(tracePath)) traceContent = fs.readFileSync(tracePath, 'utf-8');
      } catch {}
    }
    lUsed = evaluateLUsage(brief, traceContent);
    if (!lUsed) {
      const msg = `L DATA NOT USED: L channel is available but was never incorporated into the composition. ` +
        `The L channel represents the majority of integration time. Use lrgb_combine, inject_luminance (CIE-Y ratio blend) or inject_l_ifn.`;
      if (isEmergency) {
        warnings.push(`[RELAXED] ${msg}`);
      } else {
        fail('l_usage', msg);
      }
    }
  }

  // Gate 11: Vision aesthetic critic - a FRESH independent judge with a context-aware
  // rubric. ADVISORY (warning) unless the profile sets aesthetic_gate:{blocking:true,min_score}
  // (only after >=8 user-rated pairs for that class). Never blocks starless/narrowband.
  // Infra failures (no verdict/render error) are advisory only.
  if (opts.aesthetic ?? (mode === 'run')) try {
    const ag = brief?.processingProfile?.aesthetic_gate;
    const blocking = ag?.blocking === true && Number.isFinite(ag?.min_score) && !isStarless && !brief?.dataDescription?.narrowband;
    const crit = await critiqueAesthetic(ctx, viewId, { baseDir: store?.baseDir, label: `finish_${variantId || viewId}`, maxDim: 1500, model: brief?.models?.critic || 'opus', brief });
    if (crit.error) {
      warnings.push(`AESTHETIC CRITIC SKIPPED: ${crit.error} (advisory - inspect visually).`);
    } else {
      report.critic = { score: crit.aesthetic_score, flaws: Array.isArray(crit.flaws) ? crit.flaws.slice() : [], min: Number.isFinite(ag?.min_score) ? ag.min_score : null, blocking };
      const flawText = crit.flaws.length ? ` Flaws: ${crit.flaws.join('; ')}.` : '';
      const minTxt = Number.isFinite(ag?.min_score) ? ` (min ${ag.min_score.toFixed(1)}${blocking ? '' : ', advisory'})` : ' (advisory)';
      const msg = `Aesthetic critic: independent judge scored ${crit.aesthetic_score.toFixed(1)}/10${minTxt}.${flawText}`;
      if (blocking && crit.aesthetic_score < ag.min_score && !isEmergency) {
        fail('aesthetic', `AESTHETIC TOO LOW: ${msg} FIX the flaws (often over-cooked/saturated look, blown core, crushed faint structure, or bloated/erased stars), re-save the variant, and finish again.`);
      } else {
        warnings.push(msg);
      }
    }
  } catch (e) {
    warnings.push(`AESTHETIC CRITIC ERROR: ${e.message} - inspect visually.`);
  }

  // Gate 12: Reference similarity — ACTIVE ONLY when brief.reference_path is set.
  // BLOCKS on coverage_delta only. The old color_emd was ~0 by construction (residual-then-Lab)
  // and has never discriminated, so it no longer blocks (reported for reference only).
  // palette_l1 / lab_emd (WI-21) are ADVISORY warnings until the back-test harness promotes them.
  {
    const refPath = (brief?.reference_path || '').trim();
    if (opts.reference !== false && refPath && fs.existsSync(refPath)) {
      try {
        const refCmp = await compareToReference(ctx, viewId, refPath);
        if (refCmp.error) {
          warnings.push(`Reference comparison error: ${refCmp.error} — inspect manually.`);
        } else {
          const cEmd = refCmp.color_emd ?? 0;
          const covD = refCmp.coverage_delta ?? 0;
          const maxEmd = gateThreshold(profile, 'reference.max_color_emd', REF_COLOR_EMD);
          const maxCov = gateThreshold(profile, 'reference.max_coverage_delta', REF_COVERAGE_DELTA);
          const maxL1 = gateThreshold(profile, 'reference.max_palette_l1', REF_PALETTE_L1);
          const maxLab = gateThreshold(profile, 'reference.max_lab_emd', REF_LAB_EMD);
          report.reference = {
            path: refPath, color_emd: cEmd, bg_cast_delta: refCmp.bg_cast_delta ?? null, palette_l1: refCmp.palette_l1 ?? null,
            lab_emd: refCmp.lab_emd ?? null, lum_cdf_dist: refCmp.lum_cdf_dist ?? null, coverage_delta: covD,
            ms_ssim: refCmp.ms_ssim ?? null, geometry_ok: refCmp.geometry_ok ?? null,
            max_color_emd: maxEmd, max_coverage_delta: maxCov, max_palette_l1: maxL1, max_lab_emd: maxLab,
          };
          if (covD > maxCov) {
            const msg = `REFERENCE MISMATCH: coverage_delta=${covD.toFixed(3)} > ${maxCov.toFixed(2)} (reference shows substantially MORE faint nebulosity/IFN — stretch faint structure harder or reduce denoising). (${refCmp.details})`;
            if (isEmergency) warnings.push(`[RELAXED] ${msg}`);
            else fail('reference', msg);
          } else if (covD > 0.10) {
            warnings.push(`Reference has more faint signal (coverage_delta=${covD.toFixed(3)}, blocking at ${maxCov.toFixed(2)}). A bit more shadow-lift on faint structure would match it better.`);
          }
          // reference.blocking (set per run from config.files.referenceGates, 2026-10-30): the user
          // provides a target rendering and wants the run to REACH it, so palette/chroma become blocking.
          const refBlocking = profile?.reference?.blocking === true;
          const refMsg = (m) => { if (refBlocking && !isEmergency) fail('reference', m.replace(/^ADVISORY: /, 'REFERENCE MISMATCH: ')); else warnings.push(refBlocking ? `[RELAXED] ${m}` : m); };
          if (refCmp.palette_l1 != null && refCmp.palette_l1 > maxL1) refMsg(`ADVISORY: palette differs from reference (palette_l1=${refCmp.palette_l1.toFixed(3)} > ${maxL1}; hue-family mix of saturated subject pixels). Steer hue balance toward the reference.`);
          if (refCmp.lab_emd != null && refCmp.lab_emd > maxLab) refMsg(`ADVISORY: subject chroma differs from reference (lab_emd=${refCmp.lab_emd.toFixed(1)} > ${maxLab}; chroma-only a*b* distance). Adjust colour balance/saturation toward the reference.`);
          if (refBlocking && refCmp.dark_depth_delta != null && profile.reference.max_dark_depth_delta != null && Math.abs(refCmp.dark_depth_delta) > profile.reference.max_dark_depth_delta) refMsg(`ADVISORY: dark-structure depth differs from reference (target ${refCmp.dark_depth_target.toFixed(3)} vs ref ${refCmp.dark_depth_ref.toFixed(3)}; |delta| > ${profile.reference.max_dark_depth_delta}). ${refCmp.dark_depth_delta > 0 ? 'Darken the dark nebulae / deepen the shadows relative to the field' : 'Shadows are too deep relative to the field: lift them'}.`);
          if (refBlocking && refCmp.grain_halo_ratio != null && profile.reference.max_grain_ratio != null && refCmp.grain_halo_ratio > profile.reference.max_grain_ratio) refMsg(`ADVISORY: subject halos are ${refCmp.grain_halo_ratio.toFixed(2)}x as grainy as the reference (max ${profile.reference.max_grain_ratio}). Fix upstream: no LHE/MSE/sharpening after the last NoiseXTerminator, drop or reduce noisy L injection, denoise before local contrast.`);
          if (refBlocking && refCmp.lc_ratio != null && profile.reference.min_lc_ratio != null && refCmp.lc_ratio < profile.reference.min_lc_ratio) refMsg(`ADVISORY: local contrast is ${refCmp.lc_ratio.toFixed(2)}x the reference's (min ${profile.reference.min_lc_ratio}). The image reads flat: restore mid-scale contrast (local contrast / curves) rather than global colour.`);
          if (refBlocking && refCmp.bg_cast_delta != null && profile.reference.max_bg_cast_delta != null && refCmp.bg_cast_delta > profile.reference.max_bg_cast_delta) refMsg(`ADVISORY: background colour differs from reference (bg_cast_delta=${refCmp.bg_cast_delta.toFixed(1)} dE > ${profile.reference.max_bg_cast_delta}). Match the sky tint of the reference.`);
          if (refCmp.aspect_ok && refCmp.ms_ssim != null && refCmp.ms_ssim < 0.70) warnings.push(`Structural similarity to reference is low (ms_ssim=${refCmp.ms_ssim.toFixed(3)}, goal >0.70).`);
          if (!refCmp.aspect_ok) warnings.push(`Reference aspect ratio differs — SSIM skipped; compared palette, chroma, luminance CDF (lum_cdf_dist=${refCmp.lum_cdf_dist != null ? refCmp.lum_cdf_dist.toFixed(3) : 'n/a'}) and coverage_delta only.`);
        }
      } catch (e) {
        warnings.push(`Reference comparison failed: ${e.message} — inspect manually.`);
      }
    }
  }

  // Do NOT auto-blend stars here — the agent blends stars during composition.
  if (failures.length === 0) {
    try {
      const starCheck = isStarless ? null : (champStars || await checkStarQuality(ctx, viewId));
      if (starCheck && starCheck.starsFound < STAR_COUNT_WARN) {
        warnings.push(`Very few stars detected (${starCheck.starsFound}). If the image is starless, the agent may have forgotten to blend stars during composition.`);
      }
    } catch (e) {
      // Non-fatal
    }
  }

  return {
    failures, warnings, failedGates, stats, isEmergency, report,
    metrics: { stars: champStars, core: champCore, detail: champDetail, saturation: champSat, dust: champDust,
               noise: mNoise, tonal: mTonal, texture: mTexture, palette: mPalette, backgroundFloor: mBgFloor },
  };
}

// ============================================================================
// Tool definition catalog
// ============================================================================

/** WI-19: save_variant stage vocabulary. */
export const SAVE_VARIANT_STAGES = ['base', 'branch_detail', 'branch_ifn', 'branch_color', 'branch_stars', 'branch_palette', 'branch_core', 'composition', 'final'];

export const TOOL_CATALOG = {

  // --- Measurement ---
  get_image_stats: {
    category: 'measurement',
    definition: {
      name: 'get_image_stats',
      description: 'Get image statistics: median, MAD, min, max, per-channel medians. Use this to understand the current state of the image before and after operations.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: JSON.stringify(stats, null, 2) };
    }
  },

  compare_to_reference: {
    category: 'measurement',
    definition: {
      name: 'compare_to_reference',
      description: 'Compare a view against a user-supplied reference image (opened, measured, closed; the target is never modified). Returns: bg_cast_delta (dE on a*b* between the two dark-cell background colours; lower=closer cast), palette_l1 (0..2, L1 distance of hue-family fractions over saturated subject pixels; >0.35 = palette differs), lab_emd (chroma-only sliced-Wasserstein distance of subject a*b* distributions, a*b* units; >12 = chroma differs; L* ignored so a differently stretched reference does not dominate), lum_cdf_dist (geometry-free subject luminance decile distance), ms_ssim (multiscale luminance structure similarity 0..1 at ~1500 px; null when aspect ratios differ >1%), and coverage_delta (reference faint-signal fraction minus yours; >0.30 = reference shows substantially MORE faint nebulosity/IFN, i.e. you are under-stretched or over-denoised). palette_l1 and lab_emd are advisory; color_emd is a deprecated alias of bg_cast_delta/100. Use to steer toward the reference palette and faint-structure depth.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View to evaluate.' },
          reference_path: { type: 'string', description: 'Absolute path to reference image (XISF/TIFF/PNG). If omitted, uses brief.reference_path.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, store, brief, input) => {
      const refPath = (input.reference_path || brief?.reference_path || '').trim();
      if (!refPath) return { type: 'text', text: 'compare_to_reference: no reference_path provided and brief.reference_path is unset.' };
      if (!fs.existsSync(refPath)) return { type: 'text', text: `compare_to_reference: reference file not found: ${refPath}` };
      const res = await compareToReference(ctx, input.view_id, refPath);
      if (res.error) return { type: 'text', text: `compare_to_reference: ${res.error}` };
      return { type: 'text', text: `Reference comparison: ${res.details}` };
    }
  },

  measure_uniformity: {
    category: 'measurement',
    definition: {
      name: 'measure_uniformity',
      description: 'Measure background uniformity via 4-corner median stddev. Lower score = more uniform. Score < 0.002 is excellent, > 0.005 is problematic.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' },
          sample_size: { type: 'integer', description: 'Corner sample size in pixels (default 200)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const uni = await measureUniformity(ctx, input.view_id, input.sample_size || 200);
      return { type: 'text', text: JSON.stringify(uni, null, 2) };
    }
  },

  measure_color_gradient: {
    category: 'measurement',
    definition: {
      name: 'measure_color_gradient',
      description: 'Measure the residual COLOR gradient across the background — what measure_uniformity (a single luminance number over 4 corners) misses. Grids the whole frame, rejects subject cells (galaxies/bright stars), and reports the chrominance peak-to-peak across background cells plus the worst cell\'s location and dominant cast. Use this to drive gradient-correction scale: correct, re-measure, adjust scale until flat — but watch faint signal (measure_subject_detail) so you do not over-correct. On LINEAR data set linear=true so it measures on a temporary STF-stretched clone (chrominance is invisible on un-stretched linear data). Verdict thresholds (stretched units): score < 0.008 = FLAT (pass), 0.008-0.015 = MILD, > 0.015 = VISIBLE COLOR GRADIENT (keep correcting).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' },
          linear: { type: 'boolean', description: 'Set true if the image is still linear (un-stretched). Measures on a temporary auto-stretched clone so the metric is meaningful. Default false.' },
          cols: { type: 'integer', description: 'Grid columns (default 8)' },
          rows: { type: 'integer', description: 'Grid rows (default 6)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      let measureId = input.view_id;
      const tempId = '__cg_eval';
      let cg;
      try {
        if (input.linear) {
          // Chrominance is invisible on un-stretched linear data — measure on an STF-stretched clone.
          // Close any leftover temp from a prior call that errored before cleanup (avoids id collision).
          await closeImage(ctx, tempId).catch(() => {});
          await cloneImage(ctx, input.view_id, tempId);
          await autoStretch(ctx, tempId, 0.10);
          measureId = tempId;
        }
        cg = await measureColorGradient(ctx, measureId, { cols: input.cols, rows: input.rows });
      } finally {
        if (input.linear) await closeImage(ctx, tempId).catch(() => {});
      }
      if (!cg || typeof cg.score !== 'number') {
        return { type: 'text', text: `[COLOR GRADIENT: measurement failed] ${cg?.error || 'no result'} — retry, or check the view is open.` };
      }
      const s = cg.score ?? 999;
      const verdict = s < 0.008 ? 'FLAT (pass)' : s <= 0.015 ? 'MILD — optional further correction' : 'VISIBLE COLOR GRADIENT — keep correcting';
      const w = cg.worst ? ` Worst cell (grid ${cg.worst.gx},${cg.worst.gy}): ${cg.worst.dominant} cast, amp=${cg.worst.amp?.toFixed(4)}.` : '';
      const text = `[COLOR GRADIENT: ${verdict}] score=${s.toFixed(4)} (chroma peak-to-peak across ${cg.bgCells}/${cg.totalCells} background cells).${w}\n` +
        `  Per-channel chroma PP: R=${cg.chromaPP?.R?.toFixed(4)} G=${cg.chromaPP?.G?.toFixed(4)} B=${cg.chromaPP?.B?.toFixed(4)} | lum PP=${cg.lumPP?.toFixed(4)}\n` +
        (cg.band?.insufficientBg ? `  Banding: insufficient background cells (${cg.band.bgCells}) - skipped.\n`
          : cg.band?.axis ? `  Banding (localized step, not a ramp): strongest ${cg.band.axis} ${cg.band.index} channel ${cg.band.channel} amp=${cg.band.amp.toFixed(4)} stepMax=${(cg.band.stepMax || 0).toFixed(4)}. A ramp scores amp~0; amp well above the colour score = a band.\n` : '') +
        (cg.cornerLumDelta != null ? `  Corners: lumDelta=${cg.cornerLumDelta.toFixed(4)} chromaSpread=${(cg.cornerChroma ?? 0).toFixed(4)} (4-corner medians)\n` : '') +
        JSON.stringify(cg);
      return { type: 'text', text };
    }
  },

  list_open_images: {
    category: 'measurement',
    definition: {
      name: 'list_open_images',
      description: 'List all currently open images in PixInsight with their dimensions and color status.',
      input_schema: { type: 'object', properties: {} }
    },
    handler: async (ctx, _store, _brief, _input) => {
      const imgs = await ctx.listImages();
      const sum = summarizeWindows(imgs);
      const enriched = imgs.map(i => ({ ...i, estMB: sum.rows.find(r => r.id === i.id)?.estMB }));
      let rssMB = null;
      if (typeof ctx.checkMemory === 'function') { try { rssMB = await ctx.checkMemory('list_open_images'); } catch {} }
      const memWarn = ctx.memWarnMB || 4000;
      const warn = (sum.totalMB > WINDOW_WARN_MB || (rssMB && rssMB > memWarn))
        ? `\nWARNING: window pressure high (total ~${sum.totalMB} MB est.${rssMB ? `, PixInsight RSS ${rssMB} MB` : ''}). Close views you no longer need (save_variant then close_image).` : '';
      return { type: 'text', text: JSON.stringify(enriched, null, 2) + `\nTotal: ${sum.count} windows (excl. masks), ~${sum.totalMB} MB est.${rssMB ? `, PixInsight RSS ${rssMB} MB` : ''}` + warn };
    }
  },

  compute_scores: {
    category: 'measurement',
    hidden: true, visibleTo: ['aesthetic_critic','technical_critic'],
    definition: {
      name: 'compute_scores',
      description: 'Compute quality scores (0-100 per dimension) and weighted aggregate from current image stats. Also checks hard constraints.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const stats = await getStats(ctx, input.view_id);
      const uni = await measureUniformity(ctx, input.view_id);
      const constraints = checkHardConstraints(stats, brief);
      const scores = statsToScores(stats, uni, brief);
      const agg = computeAggregate(scores, brief?.target?.classification);
      return {
        type: 'text',
        text: JSON.stringify({ constraints, scores, aggregate: agg.aggregate, stats, uniformity: uni }, null, 2)
      };
    }
  },

  check_constraints: {
    category: 'measurement',
    hidden: true, visibleTo: ['aesthetic_critic','technical_critic'],
    definition: {
      name: 'check_constraints',
      description: 'Check hard constraints only (clipping, black crush, background range, channel balance). Returns pass/fail with violation details.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const stats = await getStats(ctx, input.view_id);
      const result = checkHardConstraints(stats, brief);
      return { type: 'text', text: JSON.stringify({ ...result, stats }, null, 2) };
    }
  },

  // --- Preview ---
  save_and_show_preview: {
    category: 'preview',
    definition: {
      name: 'save_and_show_preview',
      description: 'Save a JPEG preview and return it as an image so you can see the current state. Always use this after significant operations to visually assess the result. Full frame is ~0.2x on 60 MP \u2014 noise, star shape and mottle can only be judged with a 1:1 crop: pass region="subject" (centred on the detected subject), "center", "corner_tl|tr|bl|br" or {x,y,w,h}. Crops are native resolution (scale 1.0), crop_size default 1024, saved as <label>__<region>_1to1.jpg; the result reports the crop rect in full-image coordinates and the median/MAD measured INSIDE the crop.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' },
          label: { type: 'string', description: 'Short label for this preview (e.g. "after_stretch", "final")' },
          region: { description: '"full" (default, <=2048 px overview) | "center" | "subject" | "corner_tl" | "corner_tr" | "corner_bl" | "corner_br" | {x,y,w,h} in full-image pixels' },
          crop_size: { type: 'number', description: 'Square crop edge in px for named regions (default 1024)' },
          scale: { type: 'number', description: 'Crop output scale (default 1.0 = true 1:1). Ignored for region=full (capped at 2048 px).' }
        },
        required: ['view_id', 'label']
      }
    },
    handler: async (ctx, store, _brief, input) => {
      const previewDir = path.join(store.baseDir, 'previews');
      fs.mkdirSync(previewDir, { recursive: true });

      // WI-15: 1:1 crop previews with in-crop stats (full-frame preview file is never overwritten)
      const region = input.region ?? 'full';
      if (region !== 'full') {
        const dimR = await pjsrOrThrow(ctx, `
          var dw = ImageWindow.windowById('${input.view_id}');
          if (dw.isNull) throw new Error('View not found: ${input.view_id}');
          JSON.stringify({ w: dw.mainView.image.width, h: dw.mainView.image.height });
        `, 'save_and_show_preview');
        const dim = JSON.parse(dimR.outputs?.consoleOutput?.trim() || '{}');
        const cs = Math.max(64, Math.round(input.crop_size ?? 1024));
        let rx, ry, rw = cs, rh = cs, tag = typeof region === 'string' ? region : 'rect';
        if (region && typeof region === 'object') {
          rx = Math.round(region.x ?? 0); ry = Math.round(region.y ?? 0);
          rw = Math.round(region.w ?? cs); rh = Math.round(region.h ?? cs);
        } else if (region === 'center') {
          rx = Math.round((dim.w - cs) / 2); ry = Math.round((dim.h - cs) / 2);
        } else if (region === 'subject') {
          const roi = await locateSubjectROI(ctx, input.view_id);
          rx = Math.round((roi.cx ?? dim.w / 2) - cs / 2); ry = Math.round((roi.cy ?? dim.h / 2) - cs / 2);
        } else if (/^corner_(tl|tr|bl|br)$/.test(region)) {
          rx = region.endsWith('l') ? 0 : dim.w - cs;
          ry = region.startsWith('corner_t') ? 0 : dim.h - cs;
        } else {
          return { type: 'text', text: `save_and_show_preview: unknown region "${region}". Use full | center | subject | corner_tl|tr|bl|br | {x,y,w,h}.` };
        }
        const cropPath = path.join(previewDir, `${input.label}__${tag}_1to1.jpg`);
        const cr = await renderCropJpeg(ctx, input.view_id, cropPath, { x0: rx, y0: ry, w: rw, h: rh, scale: input.scale ?? 1.0 });
        const cropText = `Crop preview saved: ${input.label} [${tag}]\nFile: ${cropPath}\nCrop rect (full-image px): x=${cr.x0}, y=${cr.y0}, w=${cr.w}, h=${cr.h} of ${dim.w}x${dim.h}; output ${cr.outW}x${cr.outH} (scale ${cr.scale}).\nIn-crop stats: median=${(cr.median ?? 0).toFixed(6)}, MAD=${(cr.mad ?? 0).toFixed(6)}`;
        if (fs.existsSync(cropPath)) return [{ type: 'text', text: cropText }, jpegToContentBlock(cropPath)];
        return { type: 'text', text: cropText + '\n(Preview file not created)' };
      }

      const previewPath = path.join(previewDir, `${input.label}.jpg`);

      await pjsrOrThrow(ctx, `
        var srcW = ImageWindow.windowById('${input.view_id}');
        if (srcW.isNull) throw new Error('View not found: ${input.view_id}');
        var img = srcW.mainView.image;
        var w = img.width, h = img.height;
        var scale = Math.min(1, 2048 / Math.max(w, h));
        var nw = Math.round(w * scale), nh = Math.round(h * scale);
        var tmp = new ImageWindow(nw, nh, img.numberOfChannels, 32, false, img.isColor, 'preview_show_tmp');
        tmp.mainView.beginProcess();
        tmp.mainView.image.assign(img);
        tmp.mainView.endProcess();
        if (scale < 1) {
          var R = new Resample;
          R.mode = Resample.prototype.RelativeDimensions;
          R.xSize = scale; R.ySize = scale;
          R.absoluteMode = Resample.prototype.ForceWidthAndHeight;
          R.interpolation = Resample.prototype.MitchellNetravaliFilter;
          R.executeOn(tmp.mainView);
        }
        var p = '${previewPath.replace(/'/g, "\\'")}';
        if (File.exists(p)) File.remove(p);
        tmp.saveAs(p, false, false, false, false);
        tmp.forceClose();
        'OK';
      `, 'save_and_show_preview');

      // Get stats for the text portion
      const stats = await getStats(ctx, input.view_id);
      const textSummary = `Preview saved: ${input.label}\nFile: ${previewPath}\nStats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}`;

      // Return multi-content: text + image (in MCP mode, image block is converted to file path hint)
      if (fs.existsSync(previewPath)) {
        return [
          { type: 'text', text: textSummary },
          jpegToContentBlock(previewPath)
        ];
      }
      return { type: 'text', text: textSummary + '\n(Preview file not created)' };
    }
  },

  // --- Vision aesthetic critic (fresh independent judge) ---
  vision_aesthetic_critic: {
    category: 'measurement',
    definition: {
      name: 'vision_aesthetic_critic',
      description: 'Render the view to a JPEG and have a FRESH, independent Claude judge score it 0-10 on a competition rubric (natural-vs-cooked, core integrity, IFN/faint structure, stars, color) and list flaws. COST GUARD: only runs at the composition-critic stage or at finish — pass phase="composition_critic" (judging a candidate before finish) or phase="finish". Cached by rendered-image hash, so identical pixels never re-judge. Use on your best composition candidate to get an unbiased aesthetic read before committing.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to critique' },
          phase: { type: 'string', enum: ['composition_critic', 'finish'], description: 'Critic stage. Only these phases spawn the judge (cost guard).' },
          label: { type: 'string', description: 'Short label for the critique JPEG (e.g. "COMP_balanced")' }
        },
        required: ['view_id', 'phase']
      }
    },
    handler: async (ctx, store, brief, input) => {
      if (input.phase !== 'composition_critic' && input.phase !== 'finish') {
        return { type: 'text', text: `vision_aesthetic_critic SKIPPED: phase="${input.phase}" is not a critic phase (cost guard). Pass phase="composition_critic" or "finish".` };
      }
      const r = await critiqueAesthetic(ctx, input.view_id, { baseDir: store?.baseDir, label: input.label || input.view_id, maxDim: 1500, model: brief?.models?.critic || 'opus', brief });
      if (r.error) return { type: 'text', text: `vision_aesthetic_critic ERROR: ${r.error} (advisory — does not block).` };
      const flawText = r.flaws.length ? `\nFlaws: ${r.flaws.map(f => '• ' + f).join('  ')}` : '\nFlaws: none noted.';
      return { type: 'text', text: `AESTHETIC SCORE: ${r.aesthetic_score.toFixed(1)}/10${r.cached ? ' (cached)' : ''}${flawText}\n` + JSON.stringify({ aesthetic_score: r.aesthetic_score, flaws: r.flaws }) };
    }
  },

  // --- Image management ---
  clone_image: {
    category: 'image_mgmt',
    definition: {
      name: 'clone_image',
      description: 'Clone an image to a backup. ALWAYS clone before experimenting so you can restore if needed. Clones are for SHORT-LIVED rollback inside a step; for long-lived references save_variant then close_image (load_variant on demand). Refuses at 12+ open windows.',
      input_schema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Source view ID' },
          clone_id: { type: 'string', description: 'Name for the clone (e.g. "backup_pre_stretch")' }
        },
        required: ['source_id', 'clone_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const refused = await windowRefusal(ctx, 'clone_image');
      if (refused) return refused;
      await cloneImage(ctx, input.source_id, input.clone_id);
      return { type: 'text', text: `Cloned ${input.source_id} → ${input.clone_id}` + await windowNote(ctx) };
    }
  },

  restore_from_clone: {
    category: 'image_mgmt',
    definition: {
      name: 'restore_from_clone',
      description: 'Restore an image from a backup clone, undoing all changes since the clone was made.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target view ID to overwrite' },
          clone_id: { type: 'string', description: 'Clone view ID to restore from' }
        },
        required: ['target_id', 'clone_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await restoreFromClone(ctx, input.target_id, input.clone_id);
      return { type: 'text', text: `Restored ${input.target_id} from ${input.clone_id}` };
    }
  },

  close_image: {
    category: 'image_mgmt',
    definition: {
      name: 'close_image',
      description: 'Close an image window to free memory.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to close' },
          force: { type: 'boolean', description: 'Override the base-view protection (target, FILTER_L/Ha/S/O, <target>_stars). Default false.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      // Base views are the prep's hand-off; losing one (FILTER_L on NGC4490, 2026-10-29) kills the
      // run at prep-B ("BXT correct on L: View or Image object expected"). Refuse unless force.
      const target = brief?.target?.name || '';
      const protectedIds = new Set([target, `${target}_stars`, 'FILTER_L', 'FILTER_Ha', 'FILTER_S', 'FILTER_O']);
      if (protectedIds.has(input.view_id) && !input.force) {
        return { type: 'text', text: `REFUSED: ${input.view_id} is a base view the prep still needs (${[...protectedIds].filter(Boolean).join(', ')}). Close your clones instead; pass force=true only if you are certain the pipeline no longer needs it.` };
      }
      await closeImage(ctx, input.view_id);
      return { type: 'text', text: `Closed ${input.view_id}` };
    }
  },

  purge_undo: {
    category: 'image_mgmt',
    definition: {
      name: 'purge_undo',
      description: 'Purge undo history for a view to free memory. Do this after mask-heavy steps.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await purgeUndoHistory(ctx, input.view_id);
      return { type: 'text', text: `Purged undo history for ${input.view_id}` };
    }
  },

  // --- Gradient ---
  run_gradient_correction: {
    category: 'gradient',
    definition: {
      name: 'run_gradient_correction',
      description: 'Run GradientCorrection (GC) on an image. Good general-purpose gradient removal. Compare with ABE to see which gives better uniformity.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await runGC(ctx, input.view_id);
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `GC complete. Stats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}${await envelopeNote(ctx, _brief, input.view_id)}` };
    }
  },

  measure_lum_tilt: {
    category: 'measurement',
    definition: {
      name: 'measure_lum_tilt',
      description: 'Measure the large-scale LUMINANCE tilt of a view (mono L or colour): robust sky-plane fit over a 12x8 grid of cell medians (subject cells rejected), judged in AUTO-STRETCHED units (target 0.10) because the stretch amplifies a linear tilt ~10-20x. Verdict: ppStretched < 0.008 FLAT, 0.008-0.015 MILD, > 0.015 VISIBLE TILT. measure_uniformity (absolute corner stddev) calls a 2%-of-sky linear tilt "flat"; use this instead on L. Pass stretched=true on non-linear data.',
      input_schema: { type: 'object', properties: { view_id: { type: 'string' }, stretched: { type: 'boolean', description: 'View is already non-linear (default false)' } }, required: ['view_id'] }
    },
    handler: async (ctx, _store, _brief, input) => {
      const t = await measureLumTilt(ctx, input.view_id, { stretched: !!input.stretched });
      if (t.error) return { type: 'text', text: `[LUM TILT: measurement failed] ${t.error}` };
      return { type: 'text', text: `[LUM TILT: ${t.verdict}] ppStretched=${t.ppStretched.toFixed(4)} (linear pp=${t.ppLinear.toExponential(2)} = ${(100 * (t.relToSky ?? 0)).toFixed(2)}% of sky), ${t.direction}; ${t.skyCells} sky cells, ${t.rejectedCells} rejected.${t.verdict !== 'FLAT' && !input.stretched ? ' Fix on LINEAR data with subtract_sky_plane (3-parameter plane: cannot touch the subject or its envelope).' : ''}` };
    }
  },

  subtract_sky_plane: {
    category: 'gradient',
    hidden: true, visibleTo: ['gradient_agent'],
    definition: {
      name: 'subtract_sky_plane',
      description: 'LINEAR data only. Fit a plane (3 parameters) to the sky cells (subject rejected) and subtract its zero-mean TILT: sky level and subject unchanged. The safe fix for a pure luminance ramp on L (or RGB) where GC/ABE would also eat faint envelope. Reports tilt before/after.',
      input_schema: { type: 'object', properties: { view_id: { type: 'string' } }, required: ['view_id'] }
    },
    handler: async (ctx, _store, _brief, input) => {
      const st = await getStats(ctx, input.view_id);
      if (st.median > 0.02) return { type: 'text', text: `subtract_sky_plane REFUSED: ${input.view_id} looks stretched (median ${st.median.toFixed(4)}). It is a linear-only tool.` };
      const t0 = await measureLumTilt(ctx, input.view_id);
      if (t0.error) return { type: 'text', text: `subtract_sky_plane REFUSED: ${t0.error}` };
      if (t0.verdict === 'FLAT') return { type: 'text', text: `subtract_sky_plane skipped: ${input.view_id} is already FLAT (ppStretched ${t0.ppStretched.toFixed(4)}).` };
      await subtractSkyPlane(ctx, input.view_id, t0);
      const t1 = await measureLumTilt(ctx, input.view_id);
      return { type: 'text', text: `Sky plane subtracted from ${input.view_id}: ppStretched ${t0.ppStretched.toFixed(4)} (${t0.verdict}, ${t0.direction}) -> ${t1.ppStretched?.toFixed(4)} (${t1.verdict}). Median ${st.median.toFixed(6)} kept.` };
    }
  },

  run_abe: {
    category: 'gradient',
    hidden: true, visibleTo: ['gradient_agent'],
    definition: {
      name: 'run_abe',
      description: 'Run AutomaticBackgroundExtractor (ABE). poly_degree 1-2 gentle (linear data, galaxies, IFN/dust fields), 3-4 only on stretched nebula data with no faint extended signal.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          poly_degree: { type: 'integer', description: 'Polynomial degree (1-6, default 4, or 2 for the gradient agent). Lower = gentler.' },
          tolerance: { type: 'number', description: 'Sample rejection tolerance (default 1.0)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input, agentName) => {
      const abeDeg = input.poly_degree ?? (agentName === 'gradient_agent' ? 2 : 4);
      await runABE(ctx, input.view_id, {
        polyDegree: abeDeg,
        tolerance: input.tolerance
      });
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `ABE complete (degree=${abeDeg}). Stats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}${await envelopeNote(ctx, _brief, input.view_id)}` };
    }
  },

  run_per_channel_abe: {
    category: 'gradient',
    hidden: true, visibleTo: ['gradient_agent'],
    definition: {
      name: 'run_per_channel_abe',
      description: 'Run ABE independently on each R/G/B channel then recombine. Works on linear or non-linear RGB. The gradient agent uses it on LINEAR data pre-SPCC with poly_degree 1-2; on stretched data it fixes colour-specific gradients after curves. poly_degree 1 is safest.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'RGB view ID' },
          poly_degree: { type: 'integer', description: 'ABE polynomial degree per channel (1-3, default 1). Keep low!' },
          tolerance: { type: 'number', description: 'Sample rejection tolerance (default 1.2)' },
          mask_view_id: { type: 'string', description: 'Optional mono mask view (same size). The corrected result is blended back through it (orig + M*(corrected-orig)) — ABE does not honour an applied mask reliably, so use this for final-image banding repairs with an inverted outer-field mask.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const abeRes = await runPerChannelABE(ctx, input.view_id, {
        polyDegree: input.poly_degree ?? 1,
        tolerance: input.tolerance ?? 1.2,
        maskViewId: input.mask_view_id || null
      });
      if (abeRes && abeRes.status === 'error') {
        throw new Error(`run_per_channel_abe failed: ${abeRes.error?.message || abeRes.error || 'PJSR error'}`);
      }
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `Per-channel ABE complete (degree=${input.poly_degree || 1}). Stats: median=${stats.median.toFixed(6)}${await envelopeNote(ctx, _brief, input.view_id)}` };
    }
  },

  run_scnr: {
    category: 'gradient',
    definition: {
      name: 'run_scnr',
      description: 'Run SCNR (SubtractiveChromaticNoiseReduction) to remove green cast. preserveLightness keeps brightness so it does NOT grey out warm dust/IFN. Amount 0.30-0.50 moderate, 0.70+ aggressive. For reflection nebulae / dust-heavy fields the amount is auto-capped at 0.30 to protect brown IFN color.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          amount: { type: 'number', description: 'Green removal amount (0.0-1.0, default 0.50; auto-capped to 0.30 for dust/reflection targets)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      let amount = input.amount ?? 0.50;
      // Protect warm dust/IFN color: cap SCNR on reflection/dust-heavy targets.
      const cls = brief?.target?.classification || '';
      const dustHeavy = /reflection|ifn|dark_nebula|molecular/i.test(cls);
      let note = '';
      if (dustHeavy && amount > 0.30) { amount = 0.30; note = ' (capped 0.30 — dust/IFN color protection)'; }
      await runSCNR(ctx, input.view_id, { amount, preserveLightness: true });
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `SCNR green removal (amount=${amount}${note}, preserveLightness=on). Stats: median=${stats.median.toFixed(6)}` };
    }
  },

  // --- Denoise ---
  run_nxt: {
    category: 'denoise',
    definition: {
      name: 'run_nxt',
      description: 'Run NoiseXTerminator. Use multiple light passes (0.15-0.25) rather than one heavy pass. denoise=0.15 is very gentle, 0.35 is moderate.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          denoise: { type: 'number', description: 'Denoise strength (0.0-1.0, recommend 0.15-0.35)' },
          detail: { type: 'number', description: 'Detail preservation (0.0-1.0, default 0.15)' },
          frequency_separation: { type: 'boolean', description: 'NXT frequency separation: denoise is then the HIGH-frequency strength and denoise_lf the low-frequency one. RC-Astro starting point: HF 0.8-0.9, LF 0.5-0.7 (on linear data). Cleans the residual mottle that local contrast later turns into cells/worms.' },
          denoise_lf: { type: 'number', description: 'Low-frequency luminance denoise (with frequency_separation)' },
          frequency_scale: { type: 'number', description: 'Boundary between high and low frequencies in px (with frequency_separation; NXT default if omitted)' },
          color_separation: { type: 'boolean', description: 'NXT colour separation: denoise_color / denoise_lf_color set the chroma strengths independently. Use this instead of chroma blurs (they paint flat knots).' },
          denoise_color: { type: 'number', description: 'High-frequency colour denoise (with color_separation; 0.9-1.0 typical)' },
          denoise_lf_color: { type: 'number', description: 'Low-frequency colour denoise (with color_separation and frequency_separation; ~1.0 typical)' }
        },
        required: ['view_id', 'denoise']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      await pjsrOrThrow(ctx, `
        var P = new NoiseXTerminator;
        P.denoise = ${input.denoise};
        P.detail = ${input.detail ?? 0.15};
        ${input.frequency_separation ? `P.enableFrequencySeparation = true;${Number.isFinite(input.denoise_lf) ? ` P.denoiseLf = ${input.denoise_lf};` : ''}${Number.isFinite(input.frequency_scale) ? ` P.frequencyScale = ${input.frequency_scale};` : ''}` : ''}
        ${input.color_separation ? `P.enableColorSeparation = true;${Number.isFinite(input.denoise_color) ? ` P.denoiseColor = ${input.denoise_color};` : ''}${Number.isFinite(input.denoise_lf_color) ? ` P.denoiseLfColor = ${input.denoise_lf_color};` : ''}` : ''}
        execOrThrow(P, ImageWindow.windowById('${input.view_id}').mainView, 'run_nxt');
      `, 'run_nxt');
      const stats = await getStats(ctx, input.view_id);
      // WI-15: post-op noise measurement (this line IS the noise check; the finish gate uses the same metric)
      let noiseLine = '';
      if (stats.median < 0.02) {
        noiseLine = ' bgNoise: skipped (data looks linear, median<0.02 - noise gate is for stretched images).';
      } else {
        try {
          const nz = await measureBackgroundNoise(ctx, input.view_id, { profile: brief?.processingProfile });
          noiseLine = ` bgNoise=${(nz.bgNoise ?? 0).toFixed(4)} (HARD ${NOISE_BG_HARD}) dustNoise=${(nz.dustNoise ?? 0).toFixed(4)} (HARD ${NOISE_DUST_HARD}) ${nz.pass ? 'PASS' : 'FAIL'}`;
        } catch (e) { noiseLine = ` bgNoise: measurement failed (${e.message}).`; }
      }
      return { type: 'text', text: `NXT complete (denoise=${input.denoise}${input.frequency_separation ? `, freq-sep LF=${input.denoise_lf ?? 'default'}` : ''}${input.color_separation ? `, colour-sep C=${input.denoise_color ?? 'default'}` : ''}). Stats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}.${noiseLine}` };
    }
  },

  // --- Sharpen ---
  run_bxt: {
    category: 'sharpen',
    definition: {
      name: 'run_bxt',
      description: 'Run BlurXTerminator. For correction mode (linear data): use correct_only=true. For sharpening: set sharpen_nonstellar (0.25-1.0) and sharpen_stellar.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          correct_only: { type: 'boolean', description: 'Correct-only mode (no sharpening, good for linear data)' },
          sharpen_nonstellar: { type: 'number', description: 'Non-stellar sharpening (0.0-1.0, default 0.50)' },
          sharpen_stellar: { type: 'number', description: 'Stellar sharpening (0.0-1.0, default 0.50)' },
          adjust_star_halos: { type: 'number', description: 'Star halo adjustment (-1.0 to 1.0, use 0.0 to avoid ringing)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const correctOnly = input.correct_only ? 'true' : 'false';
      await pjsrOrThrow(ctx, `
        var P = new BlurXTerminator;
        P.AI = true;
        P.correct_only = ${correctOnly};
        ${!input.correct_only ? `P.nonstellar_then_stellar = true;
        P.sharpen_nonstellar = ${input.sharpen_nonstellar ?? 0.50};
        P.sharpen_stellar = ${input.sharpen_stellar ?? 0.50};` : ''}
        P.adjust_halos = ${input.adjust_star_halos ?? 0.0};
        execOrThrow(P, ImageWindow.windowById('${input.view_id}').mainView, 'run_bxt');
      `, 'run_bxt');
      const stats = await getStats(ctx, input.view_id);
      let starLine = '';
      if (!input.correct_only) {   // WI-15: post-sharpen star quality (FWHM / star count)
        try {
          const profile = brief?.processingProfile;
          const sq = await checkStarQuality(ctx, input.view_id, { minContrast: starMinContrast(profile), fwhmHard: gateThreshold(profile, 'stars.fwhm_hard', FWHM_HARD) });
          starLine = ` Stars: medianFWHM=${(sq.medianFWHM ?? NaN).toFixed(2)} px, starsFound=${sq.starsFound ?? 'n/a'}.`;
        } catch (e) { starLine = ` Stars: measurement failed (${e.message}).`; }
      }
      return { type: 'text', text: `BXT complete (${input.correct_only ? 'correct_only' : 'sharpen'}). Stats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}.${starLine}` };
    }
  },

  // --- Stretch ---
  seti_stretch: {
    category: 'stretch',
    definition: {
      name: 'seti_stretch',
      description: 'Seti Statistical Stretch — the preferred stretch method. Converts linear data to non-linear. The default target_median comes from the target profile (processing-profiles.json stretch.target_median: galaxy 0.08, PNe 0.11, emission 0.10, reflection 0.20); override only with a measured reason. headroom=0.05 prevents core clipping.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to stretch' },
          target_median: { type: 'number', description: 'Target median after stretch (0.05-0.30). Default: profile stretch.target_median, else 0.10.' },
          hdr_compress: { type: 'boolean', description: 'Enable HDR compression (default true)' },
          hdr_amount: { type: 'number', description: 'HDR compression amount (0.0-1.0, default 0.25)' },
          hdr_headroom: { type: 'number', description: 'HDR headroom to prevent clipping (0.0-0.15, default 0.05)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const stats = await setiStretch(ctx, input.view_id, {
        targetMedian: input.target_median ?? _brief?.processingProfile?.stretch?.target_median ?? 0.10,
        hdrCompress: input.hdr_compress ?? true,
        hdrAmount: input.hdr_amount ?? 0.25,
        hdrKnee: 0.35,
        hdrHeadroom: input.hdr_headroom ?? 0.05
      });
      return { type: 'text', text: `Seti stretch complete. Final: median=${stats.median.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}` };
    }
  },

  stretch_stars: {
    category: 'stretch',
    definition: {
      name: 'stretch_stars',
      description: 'Stretch a LINEAR star image using the Seti method: clip background pedestal, then iterative MTF. Produces tight, point-like stars on a black background. DO NOT use seti_stretch on already-stretched star images — they amplify background noise.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Star image view ID (must be linear)' },
          midtone: { type: 'number', description: 'MTF midtone (0.15-0.25, default 0.20). Lower = brighter faint stars but risk of bloat.' },
          iterations: { type: 'integer', description: 'Number of MTF iterations (3-7, default 5). More = brighter faint stars.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      // PROFILE ENFORCEMENT: galaxy targets get conservative star stretch params
      // to prevent bloated stars (NGC4490: agent used 0.15/6, producing 15-18px FWHM)
      const classification = brief?.target?.classification || '';
      const starProfile = brief?.processingProfile?.stars || {};
      const isGalaxy = classification.startsWith('galaxy');

      let midtone = input.midtone ?? 0.20;
      let iterations = input.iterations ?? 5;
      const profileCaps = [];

      if (isGalaxy) {
        const profileMidtone = starProfile.stretch_midtone ?? 0.25;
        const profileIter = starProfile.stretch_iterations ?? 4;
        if (midtone < profileMidtone) {
          const oldMid = midtone;
          midtone = profileMidtone;
          profileCaps.push({ param: 'midtone', requested: oldMid, applied: midtone, key: 'stars.stretch_midtone' });
          process.stderr.write(`[stretch_stars] GALAXY OVERRIDE: midtone ${oldMid} → ${midtone} (profile minimum for ${classification})\n`);
        }
        if (iterations > profileIter) {
          const oldIter = iterations;
          iterations = profileIter;
          profileCaps.push({ param: 'iterations', requested: oldIter, applied: iterations, key: 'stars.stretch_iterations' });
          process.stderr.write(`[stretch_stars] GALAXY OVERRIDE: iterations ${oldIter} → ${iterations} (profile maximum for ${classification})\n`);
        }
      }

      // Seti star stretch method (proven in scripted pipeline):
      // 1. Check linearity — refuse if already non-linear
      // 2. Clip background pedestal (subtract median, rescale)
      // 3. MTF iterations: progressively lift faint stars while constraining bright ones
      const r = await ctx.pjsr(`
        var w = ImageWindow.windowById('${input.view_id}');
        if (w.isNull) throw new Error('View not found: ${input.view_id}');
        var v = w.mainView;

        // Linearity guard: if max is very high but median is near zero,
        // data is likely already stretched (non-linear). Stars on black background
        // have median ~0 even when stretched, so check the 99th percentile of
        // non-zero pixels instead.
        var maxVal = v.image.maximum();
        var med = v.image.median();
        // Sample non-zero pixels to estimate stretch state
        var nonzeroAbove05 = 0;
        var nonzeroTotal = 0;
        var step = 16;
        for (var y = 0; y < v.image.height; y += step) {
          for (var x = 0; x < v.image.width; x += step) {
            var val = v.image.isColor ? Math.max(v.image.sample(x,y,0), v.image.sample(x,y,1), v.image.sample(x,y,2)) : v.image.sample(x,y);
            if (val > 0.005) {
              nonzeroTotal++;
              if (val > 0.5) nonzeroAbove05++;
            }
          }
        }
        var highFraction = nonzeroTotal > 0 ? nonzeroAbove05 / nonzeroTotal : 0;

        // If >30% of star pixels are already above 0.5, data is non-linear
        if (highFraction > 0.30) {
          JSON.stringify({ alreadyStretched: true, highFraction: highFraction, maxVal: maxVal, med: med });
        } else {

        // Step 1: Clip background pedestal
        if (med > 0.00001) {
          var P = new PixelMath;
          P.expression = 'max(0, ($T - ' + med + ') / (1 - ' + med + '))';
          P.useSingleExpression = true;
          P.createNewImage = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(v);
        }

        // Step 2: Seti MTF stretch — N iterations
        // MTF(m, x) = (1-m)*x / ((1-2*m)*x + m)
        var m = ${midtone};
        var a = (1 - m).toFixed(6);
        var b = (1 - 2*m).toFixed(6);
        var mtfExpr = '(' + a + '*$T)/((' + b + ')*$T+' + m.toFixed(6) + ')';
        for (var i = 0; i < ${iterations}; i++) {
          var P2 = new PixelMath;
          P2.expression = mtfExpr;
          P2.useSingleExpression = true;
          P2.createNewImage = false;
          P2.use64BitWorkingImage = true;
          P2.truncate = true; P2.truncateLower = 0; P2.truncateUpper = 1;
          P2.executeOn(v);
          processEvents();
        }

        var finalMed = v.image.median();
        var finalMax = v.image.maximum();
        JSON.stringify({ bgClip: med, midtone: m, iterations: ${iterations}, finalMedian: finalMed, finalMax: finalMax });

        } // end else (linearity guard)
      `);
      const result = JSON.parse(r.outputs?.consoleOutput || '{}');

      // Handle already-stretched guard
      if (result.alreadyStretched) {
        return { type: 'text', text: `REFUSED: Star layer appears already non-linear (${(result.highFraction * 100).toFixed(0)}% of star pixels > 0.5, max=${result.maxVal?.toFixed(4)}). stretch_stars is designed for LINEAR input only. Do not re-stretch it.` };
      }

      const capPrefix = profileCaps.length
        ? 'PROFILE CAP (' + classification + '): ' + profileCaps.map(c => `${c.param} requested ${c.requested} → applied ${c.applied}`).join('; ') + '\n'
        : '';
      return { type: 'text', profileCaps: profileCaps.length ? profileCaps : undefined, text: capPrefix + `Stars stretched (Seti method): bgClip=${result.bgClip?.toFixed(6)}, midtone=${midtone}, ${iterations} iterations. Final: median=${result.finalMedian?.toFixed(4)}, max=${result.finalMax?.toFixed(4)}` };
    }
  },

  auto_stretch: {
    category: 'stretch',
    hidden: true,
    definition: {
      name: 'auto_stretch',
      description: 'Quick auto-stretch using STF-based histogram transformation. Simpler than Seti but less control. Good for previewing linear data.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to stretch' },
          target_bg: { type: 'number', description: 'Target background level (default 0.25)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      // Import dynamically to avoid circular deps
      const { autoStretch } = await import('../ops/preview.mjs');
      const result = await autoStretch(ctx, input.view_id, input.target_bg || 0.25);
      return { type: 'text', text: `Auto-stretch complete. Shadows=${result.shadows.toFixed(6)}, midtone=${result.midtone.toFixed(6)}` };
    }
  },

  // --- Calibration ---
  run_spcc: {
    category: 'calibration',
    definition: {
      name: 'run_spcc',
      description: 'Run SpectrophotometricColorCalibration (SPCC) for accurate color calibration. CRITICAL for galaxy work — SCNR cannot replace proper spectrophotometric calibration. Requires the image to have an astrometric solution (plate solve first if needed). The image must be LINEAR (not stretched).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to calibrate (must be linear, must have WCS/astrometric solution)' },
          white_reference: { type: 'string', description: 'White reference type (default "Average Spiral Galaxy"). Other options: "G2V Star", "Average Star".' },
          narrowband_mode: { type: 'boolean', description: 'Enable narrowband mode (default false)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const narrowband = input.narrowband_mode ? 'true' : 'false';
      // IMPORTANT: Do NOT set whiteReferenceSpectrum, filter curves, or QE as string names.
      // SPCC expects raw spectral data (wavelength,value pairs). The defaults are correct for
      // broadband imaging. Setting string names like 'Average Spiral Galaxy' causes a parse error.
      const r = await ctx.pjsr(`
        var P = new SpectrophotometricColorCalibration;
        P.applyCalibration = true;
        P.narrowbandMode = ${narrowband};
        P.generateGraphs = false;
        P.generateStarMaps = false;
        P.generateTextFiles = false;
        P.backgroundNeutralizationEnabled = true;
        P.psfStructureLayers = 5;
        P.psfMinSNR = 10;
        P.psfAllowClusteredSources = true;
        P.psfType = 4;
        P.psfGrowth = 1.25;
        P.psfMaxStars = 4096;
        P.psfChannelSearchTolerance = 2;
        var logFile = '/tmp/spcc-tool-console.log';
        var ok = false, err = '';
        try { console.beginLog(logFile); } catch (e) {}
        try { ok = P.executeOn(ImageWindow.windowById('${input.view_id}').mainView); } catch (e) { err = String(e); }
        try { console.endLog(); } catch (e) {}
        var tail = '';
        try { var ls = File.readLines(logFile); tail = ls.slice(Math.max(0, ls.length - 20)).join('\\n'); } catch (e) {}
        'SPCC_result=' + ok + (err ? ' exception=' + err : '') + '\\n' + tail;
      `);
      const out = r.outputs?.consoleOutput || '';
      const ok = out.split('\n')[0].includes('SPCC_result=true');
      if (!ok) {
        const tail = out.split('\n').slice(1).filter(l => l.trim()).map(l => l.replace(/\x1b\[[0-9;]*m/g, '')).slice(-10).join('\n');
        return { type: 'text', text: `SPCC failed: ${out.split('\n')[0] || r.error?.message}.\nPixInsight console tail:\n${tail}\nCheck the console reason first; if it is a missing astrometric solution, use copy_astrometric_solution from an original master after BXT.` };
      }
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `SPCC complete. Channels now balanced: R=${stats.perChannel?.R?.median?.toFixed(6)}, G=${stats.perChannel?.G?.median?.toFixed(6)}, B=${stats.perChannel?.B?.median?.toFixed(6)} (median=${stats.median.toFixed(6)})` };
    }
  },

  run_plate_solve: {
    category: 'calibration',
    definition: {
      name: 'run_plate_solve',
      description: 'Run ImageSolver to add an astrometric solution (WCS) to an image. Required before SPCC. Uses online catalog (requires internet).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to plate solve' },
          center_ra: { type: 'number', description: 'Approximate RA in degrees (optional, helps solver converge faster)' },
          center_dec: { type: 'number', description: 'Approximate Dec in degrees (optional)' },
          pixel_scale: { type: 'number', description: 'Pixel scale in arcsec/pixel (optional, default auto-detect)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      // ImageSolver is a SCRIPT library (V8 edition, ImageSolver 6.5.0), not a process:
      // initialize(window) + solveImage(window). Compiled into the watcher only when
      // MCP_WITH_SOLVER is defined in pjsr/pixinsight-mcp-watcher.js.
      const ra = input.center_ra !== undefined ? `try { P.metadata.ra = ${input.center_ra}; } catch (e) {}` : '';
      const dec = input.center_dec !== undefined ? `try { P.metadata.dec = ${input.center_dec}; } catch (e) {}` : '';
      const res = input.pixel_scale !== undefined ? `try { P.metadata.resolution = ${input.pixel_scale} / 3600; P.metadata.useFocal = false; } catch (e) {}` : '';
      const r = await ctx.pjsr(`
        var w = ImageWindow.windowById('${input.view_id}');
        var out = 'SOLVE_FAILED';
        if (w.isNull) out = 'NO_VIEW';
        else if (typeof ImageSolver === 'undefined') out = 'SOLVER_UNAVAILABLE';
        else {
          var P = new ImageSolver; var err = '';
          try {
            P.initialize(w);
            ${ra} ${dec} ${res}
            try { P.solverCfg.catalogMode = 2; P.solverCfg.autoMagnitude = true; P.solverCfg.tryExhaustiveInitialAlignment = true; } catch (e) {}
            try { P.solverCfg.distortionCorrection = true; } catch (e) {}
            try { P.solverCfg.showStars = false; P.solverCfg.generateErrorImg = false; P.solverCfg.showDistortion = false; P.solverCfg.showSimplifiedSurfaces = false; } catch (e) {}
            P.solveImage(w);
          } catch (e) { err = String(e); }
          out = (w.hasAstrometricSolution ? 'SOLVED' : 'SOLVE_FAILED') + (err ? ' ' + err : '');
        }
        out;
      `);
      const out = (r.outputs?.consoleOutput || r.error?.message || '').split('\n')[0];
      if (!out.startsWith('SOLVED')) {
        const hint = out.includes('SOLVER_UNAVAILABLE')
          ? 'The ImageSolver library is not compiled into the watcher (MCP_WITH_SOLVER). Use copy_astrometric_solution from a plate-solved master instead.'
          : out.includes('NO_VIEW') ? 'View not found.' : 'The image may need better initial coordinates (center_ra/center_dec), a pixel_scale hint, or more stars.';
        return { type: 'text', text: `Plate solve failed: ${out}. ${hint}` };
      }
      return { type: 'text', text: 'Plate solve complete. Astrometric solution added to image.' };
    }
  },

  copy_astrometric_solution: {
    category: 'calibration',
    definition: {
      name: 'copy_astrometric_solution',
      description: 'Copy the astrometric solution (WCS) from a source image to a target image. Use this after BXT which is known to strip WCS data. The source should be an original master file that was plate-solved during stacking.',
      input_schema: {
        type: 'object',
        properties: {
          source_file: { type: 'string', description: 'Absolute path to the source XISF file with WCS (typically an original master)' },
          target_id: { type: 'string', description: 'Target view ID to receive the WCS' }
        },
        required: ['source_file', 'target_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      // Open source temporarily, use copyAstrometricSolution API, copy observation keywords, close
      const r = await ctx.pjsr(`
        var srcPath = '${input.source_file.replace(/'/g, "\\'")}';
        var tgtW = ImageWindow.windowById('${input.target_id}');
        if (tgtW.isNull) throw new Error('Target not found: ${input.target_id}');

        // Check file exists BEFORE opening (avoids modal popup on missing file)
        if (!File.exists(srcPath)) throw new Error('Source file not found: ' + srcPath);

        var wins = ImageWindow.open(srcPath);
        if (!wins || wins.length === 0) throw new Error('Cannot open source: ' + srcPath);
        var srcW = wins[0];

        // Close any crop masks that came with the source
        var allW = ImageWindow.windows;
        for (var i = 0; i < allW.length; i++) {
          if (allW[i].mainView.id.indexOf('crop_mask') >= 0) allW[i].forceClose();
        }

        var info = '';
        if (!srcW.hasAstrometricSolution) {
          info = 'WARNING: source has no astrometric solution';
        } else {
          // Check dimension match — WCS is dimension-specific
          var sw = srcW.mainView.image.width, sh = srcW.mainView.image.height;
          var tw = tgtW.mainView.image.width, th = tgtW.mainView.image.height;
          if (sw !== tw || sh !== th) {
            info = 'WARNING: dimension mismatch (source ' + sw + 'x' + sh + ' vs target ' + tw + 'x' + th + '). WCS not copied — SPCC may fail.';
          } else {
            tgtW.copyAstrometricSolution(srcW);
            info = 'Astrometric solution copied (hasAstro=' + tgtW.hasAstrometricSolution + ')';
          }
        }

        // Copy observation keywords (BXT may have cleared them)
        var rKW = srcW.keywords, tKW = tgtW.keywords;
        var copyNames = ['DATE-OBS','DATE-END','OBSGEO-L','OBSGEO-B','OBSGEO-H',
                         'LONG-OBS','LAT-OBS','ALT-OBS','EXPTIME','TELESCOP','INSTRUME','OBJECT',
                         'FOCALLEN','XPIXSZ','YPIXSZ','RA','DEC','OBJCTRA','OBJCTDEC'];
        var copied = [];
        for (var k = 0; k < copyNames.length; k++) {
          var name = copyNames[k], exists = false;
          for (var j = 0; j < tKW.length; j++) { if (tKW[j].name === name) { exists = true; break; } }
          if (!exists) {
            for (var m = 0; m < rKW.length; m++) {
              if (rKW[m].name === name) { tKW.push(new FITSKeyword(rKW[m].name, rKW[m].value, rKW[m].comment)); copied.push(name); break; }
            }
          }
        }
        tgtW.keywords = tKW;

        // Copy XISF observation properties
        var obsProps = ['Observation:Time:Start','Observation:Time:End',
          'Observation:Location:Longitude','Observation:Location:Latitude','Observation:Location:Elevation'];
        for (var p = 0; p < obsProps.length; p++) {
          try { var v = srcW.mainView.propertyValue(obsProps[p]); var t = srcW.mainView.propertyType(obsProps[p]);
            if (v !== undefined && v !== null) tgtW.mainView.setPropertyValue(obsProps[p], v, t); } catch(e) {}
        }

        info += '. Keywords copied: ' + copied.join(',');
        srcW.forceClose();
        info;
      `);
      return { type: 'text', text: r.outputs?.consoleOutput || r.error?.message || 'WCS copy attempted' };
    }
  },

  run_background_neutralization: {
    category: 'calibration',
    definition: {
      name: 'run_background_neutralization',
      description: 'Run BackgroundNeutralization to equalize background levels across channels. Useful after SPCC or as a standalone calibration step.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to neutralize' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await pjsrOrThrow(ctx, `
        var P = new BackgroundNeutralization;
        execOrThrow(P, ImageWindow.windowById('${input.view_id}').mainView, 'run_background_neutralization');
      `, 'run_background_neutralization');
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `Background neutralization complete. Per-channel: R=${stats.perChannel?.R?.median?.toFixed(6)}, G=${stats.perChannel?.G?.median?.toFixed(6)}, B=${stats.perChannel?.B?.median?.toFixed(6)}` };
    }
  },

  // NOTE: a duplicate `run_scnr` (category 'calibration', default 0.80, unmasked)
  // previously lived here and SHADOWED the masked 0.50 version above (JS keeps the
  // last key), so the agent always got the over-aggressive one that greyed out
  // warm dust/IFN. Removed 2026-06-22. The single run_scnr is the one above.

  // --- Detail ---
  run_lhe: {
    category: 'detail',
    hidden: true,
    definition: {
      name: 'run_lhe',
      description: 'DEPRECATED — use multi_scale_enhance instead. Direct LHE is disabled for normal processing.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          radius: { type: 'integer', description: 'Kernel radius in pixels (24-128)' },
          amount: { type: 'number', description: 'Effect strength (0.10-0.50)' },
          slope_limit: { type: 'number', description: 'Contrast slope limiter (1.1-2.5, default 1.5)' }
        },
        required: ['view_id', 'radius', 'amount']
      }
    },
    handler: async (_ctx, _store, _brief, _input) => {
      return {
        type: 'text',
        text: `TOOL POLICY VIOLATION: Direct run_lhe is disabled. Use multi_scale_enhance instead — it does 3-scale LHE + optional HDRMT + before/after metrics in ONE call. It is 5x faster and includes automatic masking. Call multi_scale_enhance with your desired amounts (lhe_fine_amount, lhe_mid_amount, lhe_large_amount) and mask settings.`
      };
    }
  },

  run_hdrmt: {
    category: 'detail',
    definition: {
      name: 'run_hdrmt',
      description: 'Run HDRMultiscaleTransform. Inverted mode enhances detail; normal mode compresses dynamic range. Use layers=5-7, iterations=1 for inverted. ALWAYS check for ringing on bright cores after.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          layers: { type: 'integer', description: 'Number of decomposition layers (4-8, default 6)' },
          iterations: { type: 'integer', description: 'Number of iterations (default 1)' },
          inverted: { type: 'boolean', description: 'Inverted mode (enhances detail instead of compressing). Preferred for luminance.' },
          to_lightness: { type: 'boolean', description: 'Apply to lightness only for color images (default true)' },
          preserve_hue: { type: 'boolean', description: 'Preserve hue for color images (default true)' }
        },
        required: ['view_id', 'layers']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const inverted = input.inverted ? 'true' : 'false';
      const toLightness = (input.to_lightness !== false) ? 'true' : 'false';
      const preserveHue = (input.preserve_hue !== false) ? 'true' : 'false';
      await pjsrOrThrow(ctx, `
        var P = new HDRMultiscaleTransform;
        P.numberOfLayers = ${input.layers};
        P.numberOfIterations = ${input.iterations ?? 1};
        P.invertedIterations = ${inverted};
        P.overdrive = 0;
        P.medianTransform = false;
        P.scalingFunctionData = [
          0.003906,0.015625,0.023438,0.015625,0.003906,
          0.015625,0.0625,0.09375,0.0625,0.015625,
          0.023438,0.09375,0.140625,0.09375,0.023438,
          0.015625,0.0625,0.09375,0.0625,0.015625,
          0.003906,0.015625,0.023438,0.015625,0.003906
        ];
        P.scalingFunctionRowFilter = [0.0625,0.25,0.375,0.25,0.0625];
        P.scalingFunctionColFilter = [0.0625,0.25,0.375,0.25,0.0625];
        P.scalingFunctionNoiseLayers = 1;
        P.scalingFunctionName = "B3 Spline (5)";
        P.deringing = true;
        P.smallScaleDeringing = 0.000;
        P.largeScaleDeringing = 0.500;
        P.outputDeringingMaps = false;
        P.toLightness = ${toLightness};
        P.preserveHue = ${preserveHue};
        execOrThrow(P, ImageWindow.windowById('${input.view_id}').mainView, 'run_hdrmt');
      `, 'run_hdrmt');
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `HDRMT complete (layers=${input.layers}, inverted=${inverted}). ${statsLine(stats)}` };
    }
  },

  // --- Masks ---
  create_luminance_mask: {
    category: 'masks',
    definition: {
      name: 'create_luminance_mask',
      description: 'Create a luminance mask from a color image. blur=3-6 for tight galaxy masks, 8-15 for nebulae. clipLow=0.10-0.15 for galaxies (must exclude background). gamma=2.0 expands midtones.',
      input_schema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Source color view ID' },
          mask_id: { type: 'string', description: 'Name for the mask' },
          blur: { type: 'number', description: 'Blur sigma (default 5)' },
          clip_low: { type: 'number', description: 'Shadow clip threshold (default 0.10)' },
          gamma: { type: 'number', description: 'Gamma curve for mask (default 1.0, use 2.0 for galaxy enhancement)' },
          range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'OPTIONAL [lo, hi]: after blur/clip/gamma, stretch the mask so lo->0 and hi->1 (select a luminance band). Applied before invert.' },
          invert: { type: 'boolean', description: 'OPTIONAL: output 1-mask (e.g. outer-field mask). For a dilated/softened outer-field mask follow with mask_ops(invert, dilate_px, blur_sigma) instead.' }
        },
        required: ['source_id', 'mask_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await createLumMask(
        ctx, input.source_id, input.mask_id,
        input.blur ?? 5, input.clip_low ?? 0.10, input.gamma ?? 1.0,
        { range: input.range, invert: input.invert }
      );
      if (!result) return { type: 'text', text: 'Failed to create mask' };
      const ms = await measureMask(ctx, result);
      return { type: 'text', text: `Luminance mask created: ${result}. ${maskStatsText(ms)}` };
    }
  },

  apply_mask: {
    category: 'masks',
    definition: {
      name: 'apply_mask',
      description: 'Apply a mask to a target view. The mask protects areas where it is black (0) and allows processing where it is white (1). Use inverted=true to flip this.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target view ID' },
          mask_id: { type: 'string', description: 'Mask view ID' },
          inverted: { type: 'boolean', description: 'Invert mask (default false)' }
        },
        required: ['target_id', 'mask_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await applyMask(ctx, input.target_id, input.mask_id, input.inverted || false);
      return { type: 'text', text: `Mask ${input.mask_id} applied to ${input.target_id}${input.inverted ? ' (inverted)' : ''}` };
    }
  },

  mask_ops: {
    category: 'masks',
    definition: {
      name: 'mask_ops',
      description: 'Shape an existing MONO mask with PixInsight processes (no pixel loops). Operations apply in this fixed order: invert -> dilate/erode -> blur -> range (clip_low/clip_high) -> gamma -> multiply_with. Typical outer-field mask: create_luminance_mask(...) of the nebula, then mask_ops(invert=true, dilate_px=8, blur_sigma=20, output_id="OUTER_FIELD") -> 1 in the dusty outskirts, 0 over the nebula, soft edge. dilate_px/erode_px = number of 3x3 morphological iterations (each grows/shrinks the mask edge by ~1 px; on 60 MP keep <= ~16 and use blur_sigma + clip_low/clip_high for larger soft growth). Without output_id the mask is modified IN PLACE. Returns mean, coverage (fraction > 0.5), min, max; mean<0.01 is flagged EMPTY and >0.95 FULL.',
      input_schema: {
        type: 'object',
        properties: {
          mask_id: { type: 'string', description: 'Source mono mask view ID' },
          output_id: { type: 'string', description: 'Optional new mask view ID (source untouched). Omit to modify mask_id in place.' },
          invert: { type: 'boolean', description: '1 - mask' },
          dilate_px: { type: 'number', description: 'Grow white regions (morphological dilation iterations, 0-32)' },
          erode_px: { type: 'number', description: 'Shrink white regions (morphological erosion iterations, 0-32)' },
          blur_sigma: { type: 'number', description: 'Gaussian blur sigma in px (soft edge)' },
          clip_low: { type: 'number', description: 'Range low point: values <= clip_low become 0' },
          clip_high: { type: 'number', description: 'Range high point: values >= clip_high become 1' },
          gamma: { type: 'number', description: 'Gamma applied last on the mask: out = mask^gamma (>1 tightens, <1 expands)' },
          multiply_with: { type: 'string', description: 'Optional second mono mask (same geometry) to multiply in last' }
        },
        required: ['mask_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const cap = (v) => Math.max(0, Math.min(32, Math.round(v || 0)));
      const r = await shapeMask(ctx, {
        maskId: input.mask_id, outputId: input.output_id, invert: input.invert,
        dilatePx: cap(input.dilate_px), erodePx: cap(input.erode_px), blurSigma: input.blur_sigma,
        clipLow: input.clip_low, clipHigh: input.clip_high, gamma: input.gamma, multiplyWith: input.multiply_with
      });
      return { type: 'text', text: `mask_ops complete: ${r.id} (${r.w}x${r.h}). ${maskStatsText(r)}` };
    }
  },

  remove_mask: {
    category: 'masks',
    definition: {
      name: 'remove_mask',
      description: 'Remove the current mask from a view.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target view ID' }
        },
        required: ['target_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await removeMask(ctx, input.target_id);
      return { type: 'text', text: `Mask removed from ${input.target_id}` };
    }
  },

  close_mask: {
    category: 'masks',
    definition: {
      name: 'close_mask',
      description: 'Close and delete a mask window to free memory.',
      input_schema: {
        type: 'object',
        properties: {
          mask_id: { type: 'string', description: 'Mask view ID to close' }
        },
        required: ['mask_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await closeMask(ctx, input.mask_id);
      return { type: 'text', text: `Mask ${input.mask_id} closed` };
    }
  },

  // --- Curves ---
  run_curves: {
    category: 'curves',
    definition: {
      name: 'run_curves',
      description: 'Apply a CurvesTransformation. Provide control points as [[x,y], ...] for the desired channel. Channel: "RGB" (all), "L" (lightness), "S" (saturation), "R", "G", "B".',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          channel: { type: 'string', enum: ['RGB', 'L', 'S', 'R', 'G', 'B'], description: 'Channel to apply curve to' },
          points: {
            type: 'array',
            items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
            description: 'Control points [[x,y], ...] from (0,0) to (1,1). Include endpoints.'
          }
        },
        required: ['view_id', 'channel', 'points']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      // CurvesTransformation PJSR properties: R, G, B, K (RGB/K combined), L, S
      // Each is an array of [x, y] control points. Kt, Lt, St etc. set interpolation type.
      const channelProp = { R: 'R', G: 'G', B: 'B', RGB: 'K', L: 'L', S: 'S' };
      const prop = channelProp[input.channel] || 'K';
      const pts = input.points.map(p => `[${p[0]},${p[1]}]`).join(',');
      await pjsrOrThrow(ctx, `
        var P = new CurvesTransformation;
        P.${prop} = [${pts}];
        execOrThrow(P, ImageWindow.windowById('${input.view_id}').mainView, 'run_curves');
      `, 'run_curves');
      const stats = await getStats(ctx, input.view_id);
      let satLine = '';
      if (input.channel === 'S' || input.channel === 'RGB') {   // WI-15: post-op saturation (same thresholds as finish Gate 7)
        try {
          const sat = await checkSaturation(ctx, input.view_id);
          if (sat && sat.subjectPixelCount > 100 && Number.isFinite(sat.p90S)) {
            const { warnAt, failAt } = saturationThresholds(brief);
            const verdict = sat.p90S > failAt ? `FAIL - above ${failAt.toFixed(2)}, finish would reject; back the curve off` : (sat.p90S > warnAt ? `WARN - above ${warnAt.toFixed(2)}` : 'OK');
            satLine = ` Saturation p90S=${sat.p90S.toFixed(3)} (warn >${warnAt.toFixed(2)}, fail >${failAt.toFixed(2)}) ${verdict}.`;
          }
        } catch (e) { satLine = ` Saturation: measurement failed (${e.message}).`; }
      }
      return { type: 'text', text: `Curves (${input.channel}) applied. ${statsLine(stats)}${satLine}` };
    }
  },

  run_pixelmath: {
    category: 'curves',
    definition: {
      name: 'run_pixelmath',
      description: 'Run an arbitrary PixelMath expression. RULES: (1) NO pow() — use exp(exponent*ln(base)). (2) Channel access is $T[0] for R, $T[1] for G, $T[2] for B — NOT $T.R or $T.B. (3) For other images use viewId[0], viewId[1], viewId[2].',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          expression: { type: 'string', description: 'PixelMath expression using $T for current pixel value' },
          single_expression: { type: 'boolean', description: 'Apply same expression to all channels (default true)' },
          symbols: { type: 'string', description: 'Symbol declarations (comma-separated)' }
        },
        required: ['view_id', 'expression']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      // WI-14 pre-validation (verified: PixelMath returns executeOn()===false for both).
      if (/\bpow\s*\(/.test(input.expression)) {
        throw new Error('run_pixelmath: pow() does not exist in PixelMath — use exp(exponent*ln(base)).');
      }
      if (input.expression.includes(';') && !(input.symbols && input.symbols.trim())) {
        return { type: 'text', text: 'REFUSED run_pixelmath: multi-statement expression (contains ";") requires the `symbols` parameter declaring every variable (e.g. expression "L=0.5*$T; L*2" with symbols "L"). PixelMath returns false without it.' };
      }
      const useSingle = (input.single_expression !== false) ? 'true' : 'false';
      await pjsrOrThrow(ctx, `
        var P = new PixelMath;
        P.expression = "${input.expression.replace(/"/g, '\\"')}";
        P.useSingleExpression = ${useSingle};
        ${input.symbols ? `P.symbols = "${input.symbols}";` : ''}
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        execOrThrow(P, ImageWindow.windowById('${input.view_id}').mainView, 'run_pixelmath');
      `, 'run_pixelmath');
      if (pixelmathReferencesL(input, brief)) recordLUsage(brief, 'run_pixelmath', input.view_id);
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `PixelMath applied. ${statsLine(stats)}` };
    }
  },

  // --- Stars ---
  star_protected_blend: {
    category: 'stars',
    definition: {
      name: 'star_protected_blend',
      description: 'HYBRID color-preserving star reintegration. In dark areas: normal RGB screen blend (gorgeous stars). In bright areas: luminance-only injection that preserves the target color ratios (prevents core washout). Smooth transition between modes. PRECONDITION: check_star_layer_integrity must have been called first.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Starless image view ID' },
          stars_id: { type: 'string', description: 'Stars-only image view ID' },
          strength: { type: 'number', description: 'Star blend strength (0.5-1.2; default: profile-driven per target class, else 0.95; capped by the screen_blend_strength profile key when defined)' },
          core_threshold_low: { type: 'number', description: 'Luminance below which pure screen blend applies (default: profile-driven per target class, else 0.60)' },
          core_threshold_high: { type: 'number', description: 'Luminance above which pure color-preserving mode applies (default: profile-driven per target class, else 0.82)' },
          min_strength_fraction: { type: 'number', description: 'Minimum star strength fraction in brightest cores (default: profile-driven per target class, else 0.10)' },
          pre_star_id: { type: 'string', description: 'Optional: pre-star view ID for post-blend color restoration. If provided, bright-area color ratios are restored from this reference after blending.' }
        },
        required: ['target_id', 'stars_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      if (brief?.dataDescription?.starless) {
        return { type: 'text', text: 'REFUSED: starless deliverable — stars are added later by the user. Do not blend stars; call begin_composition to enter composition.' };
      }
      const starsId = input.stars_id;
      const targetId = input.target_id;

      // Check precondition: star integrity must have been checked
      const integrityRecord = brief?._starIntegrity?.[starsId];
      if (!integrityRecord) {
        return {
          type: 'text',
          text: `REFUSED: No star layer integrity check found for "${starsId}". ` +
            `Call check_star_layer_integrity on the star layer FIRST, then retry star_protected_blend.`
        };
      }
      if (integrityRecord.unstretched) {
        return {
          type: 'text',
          text: `REFUSED: Star layer "${starsId}" appears UNSTRETCHED (median=${integrityRecord.median?.toFixed(6)}, ` +
            `nonzero=${integrityRecord.nonzero_pixel_count}). Stars will be invisible after blend. ` +
            `Call stretch_stars on the star layer FIRST, then re-run check_star_layer_integrity.`
        };
      }
      if (integrityRecord.verdict === 'FAIL') {
        return {
          type: 'text',
          text: `REFUSED: Star layer "${starsId}" FAILED integrity check (max=${integrityRecord.max_value?.toFixed(4)}). ` +
            `Fix the star layer first: apply soft rolloff (e.g. min($T, 0.95) or smooth compression above 0.65), ` +
            `then re-run check_star_layer_integrity before blending.`
        };
      }
      if (integrityRecord.turnsAgo > 15) {
        // Warn but don't refuse — stale check
      }

      // WI-16: remember compact star peaks (read-only measurement of the LINEAR star layer) so finish
      // can re-measure the same coordinates on the final view. Advisory; failure is non-fatal.
      try {
        const sfl = await measureStarField(ctx, starsId, { centerRadiusPx: starFieldOpts(brief).centerRadiusPx });
        if (Array.isArray(sfl.compactPeaks) && sfl.compactPeaks.length) brief._starPeaks = sfl.compactPeaks;
      } catch (e) { process.stderr.write(`[star_protected_blend] star peak capture skipped: ${e.message}\n`); }

      // PROFILE ENFORCEMENT: cap blend strength for galaxies
      const classif = brief?.target?.classification || '';
      const starProf = brief?.processingProfile?.stars || {};
      let str = input.strength ?? starProf.screen_blend_strength ?? 0.95;
      const profileCaps = [];
      if (starProf.screen_blend_strength != null) {
        const maxStr = starProf.screen_blend_strength;
        if (str > maxStr) {
          process.stderr.write(`[star_protected_blend] PROFILE CAP: strength ${str} → ${maxStr} (profile limit for ${classif})\n`);
          profileCaps.push({ param: 'strength', requested: str, applied: maxStr, key: 'stars.screen_blend_strength' });
          str = maxStr;
        }
      }
      const srcOf = (inp, prof) => inp != null ? 'agent' : (prof != null ? `profile:${classif}` : 'default');
      const low = input.core_threshold_low ?? starProf.core_threshold_low ?? 0.60;
      const high = input.core_threshold_high ?? starProf.core_threshold_high ?? 0.82;
      const minFrac = input.min_strength_fraction ?? starProf.min_strength_fraction ?? 0.10;
      const thresholdSources = `core_threshold_low=${low} (${srcOf(input.core_threshold_low, starProf.core_threshold_low)}), core_threshold_high=${high} (${srcOf(input.core_threshold_high, starProf.core_threshold_high)}), min_strength_fraction=${minFrac} (${srcOf(input.min_strength_fraction, starProf.min_strength_fraction)})`;
      const capPrefix = profileCaps.map(c => `PROFILE CAP (${classif}): blend requested ${c.requested} → applied ${c.applied}\n`).join('');

      // Get pre-blend stats for logging
      const preStat = await getStats(ctx, targetId);

      // Record the pre-blend STARLESS composition's detail for the finish detail-gain advisory
      // (the blend modifies targetId in place, so measure now). Best effort.
      try {
        const sd = await measureSubjectDetail(ctx, targetId);
        if (brief) brief._lastStarlessComposite = { starlessId: targetId, outputId: targetId, detail: summarizeDetail(sd) };
      } catch { /* advisory only */ }

      // WI-26 C: measure the STARLESS input's shell texture now (the blend modifies targetId in place)
      // so finish can use it without opening anything. Advisory; never throws.
      try {
        if (brief) {
          const tm = await measureShellTexture(ctx, targetId, { roi: brief._roi });
          brief._preBlendTexture = { outputId: targetId, metrics: tm };
        }
      } catch { /* advisory only */ }

      // ================================================================
      // HYBRID BLEND: screen in dark areas, color-preserving in bright
      // ================================================================
      // Per-channel PixelMath with symbols for intermediate values.
      // L = target luminance (average of 3 channels)
      // SL = star luminance
      // prot = protection ramp (1.0 in dark, minFrac in bright core)
      // k = strength * prot
      // rgb = normal screen blend result
      // Lrgb = luminance-only screen (preserves color ratios)
      // cp = color-preserving: target color scaled by Lrgb/L
      // w = blend weight (0 in dark = pure screen, 1 in bright = pure color-preserving)
      // final = rgb*(1-w) + cp*w

      const coreStart = low;    // where color-preserving mode begins
      const coreEnd = high;     // where it's fully active
      const invRange = (1 - minFrac).toFixed(6);
      const range = (coreEnd - coreStart).toFixed(6);

      // Build per-channel expressions (R=0, G=1, B=2)
      const channelExprs = [0, 1, 2].map(c => {
        // All expressions share the same symbols but produce channel-specific output
        return [
          // L = target luminance (simple average for robustness)
          `L = (${targetId}[0] + ${targetId}[1] + ${targetId}[2]) / 3`,
          // SL = star luminance
          `SL = (${starsId}[0] + ${starsId}[1] + ${starsId}[2]) / 3`,
          // protection ramp
          `prot = iif(L < ${coreStart}, 1.0, iif(L > ${coreEnd}, ${minFrac}, 1.0 - ${invRange} * (L - ${coreStart}) / ${range}))`,
          // effective star strength
          `k = ${str} * prot`,
          // normal RGB screen blend for this channel
          `rgb = 1 - (1 - $T) * (1 - ${starsId}[${c}] * k)`,
          // luminance-only screen (same brightness but preserves color ratios)
          `Lrgb = 1 - (1 - L) * (1 - SL * k)`,
          // color-preserving: scale original channel by lum ratio
          `cp = min(${targetId}[${c}] * Lrgb / max(L, 0.001), 0.98)`,
          // blend weight: 0 in dark (pure screen), 1 in bright (pure color-preserving)
          `w = iif(L < ${coreStart}, 0.0, iif(L > ${coreEnd}, 1.0, (L - ${coreStart}) / ${range}))`,
          // final output
          `rgb * (1 - w) + cp * w`,
        ].join('; ');
      });

      await pjsrOrThrow(ctx, `
        var P = new PixelMath;
        P.expression = "${channelExprs[0].replace(/"/g, '\\"')}";
        P.expression1 = "${channelExprs[1].replace(/"/g, '\\"')}";
        P.expression2 = "${channelExprs[2].replace(/"/g, '\\"')}";
        P.useSingleExpression = false;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.symbols = 'L, SL, prot, k, rgb, Lrgb, cp, w';
        execOrThrow(P, ImageWindow.windowById('${targetId}').mainView, 'star_protected_blend');
      `, 'star_protected_blend');

      // ================================================================
      // OPTIONAL: Post-blend color restoration from pre-star reference
      // ================================================================
      let restorationNote = '';
      if (input.pre_star_id) {
        const preId = input.pre_star_id;
        const restoreStart = coreStart;
        const restoreEnd = coreEnd;
        const restRange = (restoreEnd - restoreStart).toFixed(6);

        const restoreExprs = [0, 1, 2].map(c => {
          return [
            `Lp = (${preId}[0] + ${preId}[1] + ${preId}[2]) / 3`,
            `Lb = ($T[0] + $T[1] + $T[2]) / 3`,
            `restored = min(${preId}[${c}] * Lb / max(Lp, 0.001), 0.98)`,
            `wr = iif(Lp < ${restoreStart}, 0.0, iif(Lp > ${restoreEnd}, 1.0, (Lp - ${restoreStart}) / ${restRange}))`,
            `$T * (1 - wr) + restored * wr`,
          ].join('; ');
        });

        await pjsrOrThrow(ctx, `
          var P = new PixelMath;
          P.expression = "${restoreExprs[0].replace(/"/g, '\\"')}";
          P.expression1 = "${restoreExprs[1].replace(/"/g, '\\"')}";
          P.expression2 = "${restoreExprs[2].replace(/"/g, '\\"')}";
          P.useSingleExpression = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.createNewImage = false;
          P.symbols = 'Lp, Lb, restored, wr';
          execOrThrow(P, ImageWindow.windowById('${targetId}').mainView, 'star_protected_blend');
        `, 'star_protected_blend');
        restorationNote = ` + color restoration from ${preId}`;
      }

      const postStat = await getStats(ctx, targetId);
      const staleNote = integrityRecord.turnsAgo > 15
        ? ' (NOTE: star integrity check is stale — consider re-checking)'
        : '';
      return {
        type: 'text',
        profileCaps: profileCaps.length ? profileCaps : undefined,
        text: capPrefix + `Stars blended (HYBRID color-preserving, strength=${str}, core=[${low},${high}], min_frac=${minFrac}${restorationNote}). ` +
          `Pre: median=${preStat.median.toFixed(4)}, max=${(preStat.max ?? 0).toFixed(4)} → ` +
          `Post: ${statsLine(postStat)}${staleNote}\nThreshold sources: ${thresholdSources}`
      };
    }
  },

  // B3b: region-graft — blend a donor (e.g. a recalled champion) into base by a mask.
  blend_regions: {
    category: 'stars',
    definition: {
      name: 'blend_regions',
      description: 'Region-graft: blend donor_view into base_view weighted by a grayscale mask_view (mask 1 = full donor, 0 = keep base). Per-channel PixelMath; base_view is modified IN PLACE. Use to graft a recalled CHAMPION region (recall_champion donor) into your composition — e.g. donate strong IFN nebulosity or a clean core. base, donor and mask MUST be the same dimensions (champions are cross-run — this tool refuses on geometry mismatch; resample/align first).',
      input_schema: {
        type: 'object',
        properties: {
          base_view: { type: 'string', description: 'View modified in place (your composition).' },
          donor_view: { type: 'string', description: 'Source of the grafted region (e.g. a champion).' },
          mask_view: { type: 'string', description: 'Grayscale [0..1] weight: 1 = full donor, 0 = keep base.' },
          strength: { type: 'number', description: 'Global donor-weight multiplier 0..1.5 (default 1.0).' }
        },
        required: ['base_view', 'donor_view', 'mask_view']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const b = input.base_view, d = input.donor_view, m = input.mask_view;
      const s = Math.max(0, Math.min(1.5, input.strength == null ? 1.0 : input.strength)).toFixed(4);
      const geomR = await ctx.pjsr(`
        var wb = ImageWindow.windowById('${b}'); var wd = ImageWindow.windowById('${d}'); var wm = ImageWindow.windowById('${m}');
        var out;
        if (wb.isNull || wd.isNull || wm.isNull) { out = JSON.stringify({ ok:false, reason:'missing_view', base:null, donor:null, mask:null, mono:false }); }
        else {
          var ib = wb.mainView.image, id = wd.mainView.image, im = wm.mainView.image;
          var match = (ib.width===id.width && ib.height===id.height && ib.width===im.width && ib.height===im.height);
          out = JSON.stringify({ ok:match, reason: match?'ok':'geometry_mismatch', base:[ib.width,ib.height], donor:[id.width,id.height], mask:[im.width,im.height], mono: ib.numberOfChannels < 3 });
        }
        out;
      `);
      let geom = {};
      try { geom = JSON.parse(geomR.outputs && geomR.outputs.consoleOutput); } catch (e) { /* */ }
      if (!geom.ok) {
        const dims = geom.reason === 'missing_view' ? 'one or more views not found' : `base=${JSON.stringify(geom.base)} donor=${JSON.stringify(geom.donor)} mask=${JSON.stringify(geom.mask)}`;
        return { type: 'text', text: `REFUSED blend_regions: ${geom.reason || 'unknown'}. ${dims}. Resample/align donor and mask to base geometry before blending.` };
      }
      const preStat = await getStats(ctx, b);
      // Per-channel: w = clamp(mask*strength,0,1); out = base[c]*(1-w) + donor[c]*w.
      // Mono base → single expression on the lone channel (no [1]/[2]).
      const chExpr = (c) => `w = max(0, min(1, ${m} * ${s})); ${b}[${c}] * (1 - w) + ${d}[${c}] * w`.replace(/"/g, '\\"');
      if (geom.mono) {
        const monoExpr = `w = max(0, min(1, ${m} * ${s})); ${b} * (1 - w) + ${d} * w`.replace(/"/g, '\\"');
        await pjsrOrThrow(ctx, `
          var P = new PixelMath;
          P.expression = "${monoExpr}";
          P.useSingleExpression = true;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.createNewImage = false;
          P.symbols = 'w';
          execOrThrow(P, ImageWindow.windowById('${b}').mainView, 'blend_regions');
        `, 'blend_regions');
      } else {
        await pjsrOrThrow(ctx, `
          var P = new PixelMath;
          P.expression = "${chExpr(0)}";
          P.expression1 = "${chExpr(1)}";
          P.expression2 = "${chExpr(2)}";
          P.useSingleExpression = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.createNewImage = false;
          P.symbols = 'w';
          execOrThrow(P, ImageWindow.windowById('${b}').mainView, 'blend_regions');
        `, 'blend_regions');
      }
      const postStat = await getStats(ctx, b);
      return { type: 'text', text: `Region-grafted ${d} into ${b} via mask ${m} (strength ${s}). Pre: median=${preStat.median.toFixed(4)}, max=${(preStat.max ?? 0).toFixed(4)} → Post: ${statsLine(postStat)}` };
    }
  },

  // B3b: advisory Pareto signal vs recorded cross-run champions (never blocks).
  // Uses the SAME scoreVariantDimensions scoring the champions are keyed on.
  compare_to_champions: {
    category: 'measurement',
    definition: {
      name: 'compare_to_champions',
      description: 'PARETO SIGNAL (advisory): compares the current view against recorded cross-run CHAMPIONS for this target classification, per quality dimension (ifn_visibility, core_integrity, color_richness, detail, star_quality). Reports ahead/behind/tied per dimension and names the WEAKEST — use it to decide which recall_champion + blend_regions graft is worth attempting. Does not modify the image.',
      input_schema: {
        type: 'object',
        properties: { view_id: { type: 'string', description: 'View to evaluate (your current best composition).' } },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const classif = brief?.target?.classification || '';
      const champs = getChampions(ledgerKey(brief));
      if (!champs || Object.keys(champs).length === 0) {
        return { type: 'text', text: `No cross-run champions recorded for "${ledgerKey(brief) || classif}" yet — nothing to compare against.` };
      }
      const v = input.view_id;
      let detail = null, core = null, sat = null, stars = null, dust = null;
      try { detail = await measureSubjectDetail(ctx, v); } catch (e) { /* */ }
      try { core = await measureCoreContrast(ctx, v, classif, brief?.processingProfile?.core_burn); } catch (e) { /* */ }
      try { sat = await checkSaturation(ctx, v); } catch (e) { /* */ }
      try { stars = await checkStarQuality(ctx, v); } catch (e) { /* */ }
      // WI-19: without dust the ifn_visibility BEHIND/AHEAD comparison is meaningless for IFN profiles.
      if (brief?.processingProfile?.ifn) { try { dust = await measureDustCoverage(ctx, v, brief.processingProfile.ifn); } catch (e) { /* */ } }
      const maxP90 = brief?.processingProfile?.saturation?.max_p90 ?? 0.65;
      const cur = scoreVariantDimensions({ detail, core, saturation: sat, stars, dust, maxP90, classification: classif, targetP90: brief?.processingProfile?.look?.target_p90 });
      const rows = [];
      let weakest = null, weakestGap = -Infinity;
      for (const dim of Object.keys(champs)) {
        const champScore = champs[dim].score;
        const c = cur[dim];
        if (typeof c !== 'number' || typeof champScore !== 'number') { rows.push(`  ${dim}: champion=${(champScore ?? 0).toFixed ? champScore.toFixed(4) : champScore} (current not measured)`); continue; }
        const gap = champScore - c;
        const verdict = gap > 0.02 ? 'BEHIND' : (gap < -0.02 ? 'AHEAD' : 'tied');
        rows.push(`  ${dim}: current=${c.toFixed(4)} vs champion=${champScore.toFixed(4)} → ${verdict} (run ${champs[dim].run_id})`);
        if (gap > weakestGap) { weakestGap = gap; weakest = dim; }
      }
      const reco = (weakest && weakestGap > 0.02)
        ? `\nWEAKEST vs champion: ${weakest} (behind by ${weakestGap.toFixed(4)}). Consider: recall_champion("${weakest}") → build a region mask → blend_regions.`
        : `\nCurrent view matches or beats all champions — no graft needed.`;
      return { type: 'text', text: `Champion comparison for "${classif}":\n${rows.join('\n')}${reco}` };
    }
  },

  // Standalone color restoration tool (can be used independently after any star blend)
  restore_star_color: {
    category: 'stars',
    definition: {
      name: 'restore_star_color',
      description: 'Post-blend color restoration: restores pre-star color ratios in bright areas while keeping post-star luminance (and stars). Use when star blend washed out color in the bright core. Requires the pre-star image to still be open.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Post-star image to repair (modified in-place)' },
          pre_star_id: { type: 'string', description: 'Pre-star reference image (must still be open)' },
          restore_start: { type: 'number', description: 'Luminance below which no restoration applies (default 0.60)' },
          restore_end: { type: 'number', description: 'Luminance above which full restoration applies (default 0.82)' }
        },
        required: ['target_id', 'pre_star_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const targetId = input.target_id;
      const preId = input.pre_star_id;
      const restoreStart = input.restore_start ?? 0.60;
      const restoreEnd = input.restore_end ?? 0.82;
      const restRange = (restoreEnd - restoreStart).toFixed(6);

      const preStat = await getStats(ctx, targetId);

      const restoreExprs = [0, 1, 2].map(c => {
        return [
          `Lp = (${preId}[0] + ${preId}[1] + ${preId}[2]) / 3`,
          `Lb = ($T[0] + $T[1] + $T[2]) / 3`,
          `restored = min(${preId}[${c}] * Lb / max(Lp, 0.001), 0.98)`,
          `wr = iif(Lp < ${restoreStart}, 0.0, iif(Lp > ${restoreEnd}, 1.0, (Lp - ${restoreStart}) / ${restRange}))`,
          `$T * (1 - wr) + restored * wr`,
        ].join('; ');
      });

      await pjsrOrThrow(ctx, `
        var P = new PixelMath;
        P.expression = "${restoreExprs[0].replace(/"/g, '\\"')}";
        P.expression1 = "${restoreExprs[1].replace(/"/g, '\\"')}";
        P.expression2 = "${restoreExprs[2].replace(/"/g, '\\"')}";
        P.useSingleExpression = false;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.symbols = 'Lp, Lb, restored, wr';
        execOrThrow(P, ImageWindow.windowById('${targetId}').mainView, 'restore_star_color');
      `, 'restore_star_color');

      const postStat = await getStats(ctx, targetId);
      return {
        type: 'text',
        text: `Color restoration applied (ref=${preId}, range=[${restoreStart},${restoreEnd}]). ` +
          `Pre: median=${preStat.median.toFixed(4)}, max=${(preStat.max ?? 0).toFixed(4)} → ` +
          `Post: ${statsLine(postStat)}`
      };
    }
  },

  // Backward compatibility alias
  star_screen_blend: {
    category: 'stars',
    hidden: true,
    definition: {
      name: 'star_screen_blend',
      description: '[DEPRECATED — use star_protected_blend instead] Redirects to star_protected_blend with default core protection. Call check_star_layer_integrity on the star layer first.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Starless image view ID' },
          stars_id: { type: 'string', description: 'Stars-only image view ID' },
          strength: { type: 'number', description: 'Star blend strength (0.5-1.2, default 0.85)' }
        },
        required: ['target_id', 'stars_id']
      }
    },
    handler: async (ctx, store, brief, input, agentName) => {
      // Redirect to star_protected_blend
      return TOOL_CATALOG.star_protected_blend.handler(ctx, store, brief, input, agentName);
    }
  },

  // --- Artifacts ---
  save_variant: {
    category: 'artifacts',
    definition: {
      name: 'save_variant',
      description: 'Save the current image as a durable variant on disk. Returns a variant_id (e.g. "variant_21") that you MUST use when calling finish. The variant is the source of truth for export — not the live PixInsight view.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to save' },
          params: { type: 'object', description: 'Parameters used to produce this variant' },
          notes: { type: 'string', description: 'Human-readable notes about this variant' },
          stage: { type: 'string', enum: SAVE_VARIANT_STAGES, description: 'Pipeline stage of this variant. Optional; defaults from the current state (compose -> composition, finalize -> final, else branch_unspecified). Only composition/final variants count as tried approaches in the cross-run ledger.' },
          approach: { type: 'array', items: { type: 'string' }, description: 'Short tokens naming the techniques ACTUALLY stacked in this variant, e.g. ["lrgb","hdrmt:5L","inject_l_ifn","lift_dust"] or ["palette:foraxx","hueshift:on","halo_lift:on"]. The FINAL save must list the full stack used.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, store, brief, input, agentName) => {
      const stats = await getStats(ctx, input.view_id);
      const uni = await measureUniformity(ctx, input.view_id);
      const smState = brief?._stateMachine?.state;
      const stage = (input.stage && SAVE_VARIANT_STAGES.includes(input.stage)) ? input.stage
        : (smState === 'compose' ? 'composition' : smState === 'finalize' ? 'final' : 'branch_unspecified');
      const approach = Array.isArray(input.approach) ? input.approach.map(x => String(x).trim().toLowerCase()).filter(Boolean) : undefined;
      const result = await store.saveVariant(ctx, agentName, input.view_id, {
        ...input.params,
        notes: input.notes,
        stage,
        ...(approach && approach.length ? { approach: Array.from(new Set(approach)).sort() } : {}),
        state: smState || null,
        classification: brief?.target?.classification || null
      }, { ...stats, uniformity: uni.score });
      // Extract the short variant_id (e.g. "variant_21") from the full artifactId
      const variantId = result.artifactId.split('/').pop();
      return { type: 'text', text: `Variant saved: variant_id="${variantId}" (${result.artifactId})\nUse this variant_id when calling finish. To reload later: load_variant(artifact_id=\"${variantId}\").\nStats: median=${stats.median.toFixed(6)}, uniformity=${uni.score.toFixed(6)}` };
    }
  },

  load_variant: {
    category: 'artifacts',
    definition: {
      name: 'load_variant',
      description: 'Load a previously saved variant back into PixInsight. Accepts a short id ("variant_05") or the full artifact ID (runId/agent/variant_XX). REFUSES if the target view id is already open (never auto-suffixes): pass view_id to load under another name, or replace_existing=true to close the open one first.',
      input_schema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'Short id (variant_05) or full artifact ID (runId/agent/variant_XX)' },
          view_id: { type: 'string', description: 'Optional: view id to give the loaded image (default: the id it was saved under)' },
          replace_existing: { type: 'boolean', description: 'Close an already-open view with the target id first (default false)' }
        },
        required: ['artifact_id']
      }
    },
    handler: async (ctx, store, _brief, input, agentName) => {
      const refused = await windowRefusal(ctx, 'load_variant');
      if (refused) return refused;
      let meta;
      try {
        meta = await store.loadVariant(ctx, input.artifact_id, { agentName, viewId: input.view_id, replaceExisting: !!input.replace_existing });
      } catch (e) {
        if (/^REFUSED|^Variant not found/.test(e.message)) return { type: 'text', text: e.message };
        throw e;
      }
      return { type: 'text', text: `Loaded: ${input.artifact_id} (view: ${meta.loadedViewId || meta.viewId})` + await windowNote(ctx) };
    }
  },

  load_prior_winner: {
    category: 'artifacts',
    definition: {
      name: 'load_prior_winner',
      description: 'Open the FINAL winning composition of a PREVIOUS run into PixInsight (cross-run). Use to A/B against, or graft a region from, a prior result. Returns the loaded view ID.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run ID of the prior run (e.g. run_2026-06-20_ab12cd34)' },
          view_id: { type: 'string', description: 'Optional ID to rename the loaded view to (default: prior_winner)' }
        },
        required: ['run_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const { resolveBaseWinner } = await import('./warmstart.mjs');
      let xisfPath, selection;
      try { ({ xisfPath, selection } = resolveBaseWinner(input.run_id)); }
      catch (e) { return { type: 'text', text: `Cannot load prior winner: ${e.message}` }; }
      const r = await ctx.send('open_image', '__internal__', { filePath: xisfPath });
      if (r.status === 'error') return { type: 'text', text: `Failed to open ${xisfPath}: ${r.error?.message}` };
      const loadedId = r.outputs?.id;
      const targetId = input.view_id || 'prior_winner';
      const imgs = await ctx.listImages();
      for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
        await pjsrOrThrow(ctx, `var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`, 'load_prior_winner');
      }
      if (loadedId && loadedId !== targetId) {
        await pjsrOrThrow(ctx, `var w=ImageWindow.windowById('${loadedId}');if(!w.isNull)w.mainView.id='${targetId}';`, 'load_prior_winner');
      }
      return { type: 'text', text: `Prior winner loaded as view="${targetId}" (run ${input.run_id}, variant ${selection.variant_id}).` };
    }
  },

  recall_champion: {
    category: 'artifacts',
    definition: {
      name: 'recall_champion',
      description: 'Open the cross-run CHAMPION image for a quality dimension and the current target classification. Dimensions: ifn_visibility, core_integrity, color_richness, star_quality, detail. The champion is a finished image from a PRIOR run that scored best on that dimension for this target class. Returns the opened view ID so you can graft its strong region into your composition (via blend_regions / star_protected_blend). NOTE: a champion may have a different crop/geometry — align/resample before per-pixel blending. Returns a "no champion" message if none recorded yet.',
      input_schema: {
        type: 'object',
        properties: {
          dimension: { type: 'string', enum: ['ifn_visibility', 'core_integrity', 'color_richness', 'star_quality', 'detail'], description: 'Which quality dimension to recall the best prior image for.' }
        },
        required: ['dimension']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const classif = ledgerKey(brief) || brief?.target?.classification || '';
      const champs = getChampions(classif);
      const c = champs[input.dimension];
      if (!c) return { type: 'text', text: `No cross-run champion recorded for ${classif || 'unknown'}/${input.dimension} yet. Process this dimension from scratch.` };
      if (!fs.existsSync(c.xisfPath)) return { type: 'text', text: `Champion XISF missing on disk: ${c.xisfPath} (run ${c.run_id} likely pruned). Process from scratch.` };
      const refusedChamp = await windowRefusal(ctx, 'recall_champion');
      if (refusedChamp) return refusedChamp;
      const r = await ctx.send('open_image', '__internal__', { filePath: c.xisfPath });
      if (r.status === 'error') return { type: 'text', text: `Failed to open champion: ${r.error?.message}` };
      const imgs = await ctx.listImages();
      for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
        await pjsrOrThrow(ctx, `var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`, 'recall_champion');
      }
      const loadedId = r.outputs?.id;
      const champId = `champ_${input.dimension}`;
      if (loadedId && loadedId !== champId) {
        await pjsrOrThrow(ctx, `var w=ImageWindow.windowById('${loadedId}');if(!w.isNull)w.mainView.id='${champId}';`, 'recall_champion');
      }
      return { type: 'text', text: `Champion opened: view="${champId}" dimension=${input.dimension} score=${(c.score ?? 0).toFixed(4)} from run ${c.run_id} (${c.variant_id}). Graft its strong region into your composition; align/resample first if geometry differs.` + await windowNote(ctx) };
    }
  },

  list_variants: {
    category: 'artifacts',
    definition: {
      name: 'list_variants',
      description: 'List all saved variants for the current agent.',
      input_schema: { type: 'object', properties: {} }
    },
    handler: async (_ctx, store, _brief, _input, agentName) => {
      const variants = store.listVariants(agentName);
      const summary = variants.map(v =>
        `${v.variantId}: median=${v.metrics?.median?.toFixed(6) || '?'}, uniformity=${v.metrics?.uniformity?.toFixed(6) || '?'}` +
        (v.gates ? ` | gates=${v.gates.pass ? 'PASS' : 'FAIL'} (${v.gates.failures}f/${v.gates.warnings}w${v.gates.failedGates?.length ? ': ' + v.gates.failedGates.join(',') : ''})` : '')
      ).join('\n');
      return { type: 'text', text: summary || 'No variants saved yet.' };
    }
  },

  // --- LRGB combine ---
  lrgb_combine: {
    category: 'lrgb',
    definition: {
      name: 'lrgb_combine',
      description: 'Combine a processed luminance channel with the RGB image via luminance replacement. This dramatically improves detail and reveals faint structure (IFN). The L channel should be stretched and enhanced before combining. lightness=0.55 for spirals, 0.35 for edge-on. CRITICAL: L must be LinearFit to RGB luminance first to avoid veil effect.',
      input_schema: {
        type: 'object',
        properties: {
          rgb_id: { type: 'string', description: 'RGB color image view ID' },
          l_id: { type: 'string', description: 'Processed luminance view ID (must be grayscale, stretched)' },
          lightness: { type: 'number', description: 'Luminance weight (0.0-1.0, default 0.55 for spirals, 0.35 for edge-on)' },
          saturation: { type: 'number', description: 'Saturation preservation (0.0-1.0, default 0.80)' }
        },
        required: ['rgb_id', 'l_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      let lightness = input.lightness ?? 0.55;
      const saturation = input.saturation ?? 0.80;

      // PROFILE ENFORCEMENT: cap lightness for galaxies to prevent core burn
      const classifLrgb = brief?.target?.classification || '';
      let lrgbCapNote = ''; const lrgbCaps = [];
      if (classifLrgb.startsWith('galaxy')) {
        const profileLightness = brief?.processingProfile?.tools?.LRGB?.lightness ?? 0.55;
        const maxLightness = Math.min(profileLightness, brief?.processingProfile?.tools?.LRGB?.max_lightness ?? 0.50);
        if (lightness > maxLightness) {
          lrgbCapNote = `PROFILE CAP (${classifLrgb}): lightness requested ${lightness} → applied ${maxLightness}\n`;
          lrgbCaps.push({ param: 'lightness', requested: lightness, applied: maxLightness, key: 'tools.LRGB.max_lightness' });
          process.stderr.write(`[lrgb_combine] GALAXY CAP: lightness ${lightness} → ${maxLightness} (profile limit for ${classifLrgb})\n`);
          lightness = maxLightness;
        }
      }

      const tgt = input.rgb_id;

      // WI-13: advisory L/RGB median ratio (LinearFit crushes L DR when the ratio is large). Never refuses.
      let ratioAdvisory = '';
      try {
        const sL = await getStats(ctx, input.l_id);
        const sR = await getStats(ctx, input.rgb_id);
        if (sL?.median > 0 && sR?.median > 0) {
          const rr = sL.median / sR.median;
          if (rr > 2.0) {
            ratioAdvisory = `ADVISORY: L/RGB median ratio ${rr.toFixed(2)}x - LinearFit will crush L dynamic range; consider inject_luminance weight 0.20-0.30 (2-3x) / 0.15-0.20 (>3x); prep deliberately produces ~3x.\n`;
          }
        }
      } catch (_e) { /* advisory only */ }
      try {
        // Step 1: LinearFit L to RGB luminance (prevents veil effect)
        await pjsrOrThrow(ctx, `
          var rgbW = ImageWindow.windowById('${input.rgb_id}');
          var lW = ImageWindow.windowById('${input.l_id}');
          if (rgbW.isNull) throw new Error('RGB not found: ${input.rgb_id}');
          if (lW.isNull) throw new Error('L not found: ${input.l_id}');

          // Extract RGB luminance for LinearFit reference
          var img = rgbW.mainView.image;
          var w = img.width, h = img.height;
          var lumRef = new ImageWindow(w, h, 1, 32, true, false, 'lrgb_lum_ref');
          lumRef.show();
          var PM = new PixelMath;
          PM.expression = '0.2126*${input.rgb_id}[0] + 0.7152*${input.rgb_id}[1] + 0.0722*${input.rgb_id}[2]';
          PM.useSingleExpression = true;
          PM.createNewImage = false;
          execOrThrow(PM, lumRef.mainView, 'lrgb_combine');
          // LinearFit L to RGB luminance
          var LF = new LinearFit;
          LF.referenceViewId = 'lrgb_lum_ref';
          LF.rejectHigh = 0.92;
          execOrThrow(LF, lW.mainView, 'lrgb_combine');
          lumRef.forceClose();
          'LinearFit done';
        `, 'lrgb_combine');

        // Step 2: Native LRGBCombination
        // executeOn() requires channel views named {target}_L, {target}_R, etc.
        // So we extract RGB channels and clone L with the expected names.
        await pjsrOrThrow(ctx, `
          var CE = new ChannelExtraction;
          CE.channels = [[true, '${tgt}_R'], [true, '${tgt}_G'], [true, '${tgt}_B']];
          CE.colorSpace = ChannelExtraction.prototype.RGB;
          CE.sampleFormat = ChannelExtraction.prototype.SameAsSource;
          execOrThrow(CE, ImageWindow.windowById('${tgt}').mainView, 'lrgb_combine');
          'channels extracted';
        `, 'lrgb_combine');

        // Clone L to {target}_L (don't rename the original)
        await pjsrOrThrow(ctx, `
          var src = ImageWindow.windowById('${input.l_id}');
          var img = src.mainView.image;
          var dst = new ImageWindow(img.width, img.height, 1, 32, true, false, '${tgt}_L');
          dst.show();
          var PM = new PixelMath;
          PM.expression = '${input.l_id}';
          PM.useSingleExpression = true;
          PM.createNewImage = false;
          execOrThrow(PM, dst.mainView, 'lrgb_combine');
          'L cloned';
        `, 'lrgb_combine');

      } catch (e) {
        // Steps 1-3 now throw; do not leave temp windows behind.
        await ctx.pjsr(`
          var ids = ['lrgb_lum_ref','${tgt}_R','${tgt}_G','${tgt}_B','${tgt}_L'];
          for (var i = 0; i < ids.length; i++) {
            var w = ImageWindow.windowById(ids[i]);
            if (!w.isNull) w.forceClose();
          }
        `).catch(() => {});
        throw e;
      }

      const r = await ctx.pjsr(`
        var P = new LRGBCombination;
        P.channelL = [true, '${tgt}_L'];
        P.channelR = [true, '${tgt}_R'];
        P.channelG = [true, '${tgt}_G'];
        P.channelB = [true, '${tgt}_B'];
        P.lightness = ${lightness};
        P.saturation = ${saturation};
        P.noiseReduction = false;
        var ret = P.executeOn(ImageWindow.windowById('${tgt}').mainView);
        ret ? 'LRGB_OK' : 'LRGB_FAILED';
      `);

      // Clean up temp channel views
      await ctx.pjsr(`
        var ids = ['${tgt}_R','${tgt}_G','${tgt}_B','${tgt}_L'];
        for (var i = 0; i < ids.length; i++) {
          var w = ImageWindow.windowById(ids[i]);
          if (!w.isNull) w.forceClose();
        }
        'cleaned up';
      `);

      const lrgbOut = r.outputs?.consoleOutput?.trim() || '';
      let method = 'LRGBCombination';
      if (r.status === 'error' || lrgbOut.includes('LRGB_FAILED')) {
        // Fallback: PixelMath luminance replacement (saturation not supported)
        method = 'PixelMath fallback';
        await applyLuminanceInjection(ctx, input.rgb_id, input.l_id, lightness, null, 'lrgb_combine');
      }

      recordLUsage(brief, 'lrgb_combine', input.rgb_id);
      const stats = await getStats(ctx, input.rgb_id);
      return { type: 'text', profileCaps: lrgbCaps.length ? lrgbCaps : undefined, text: lrgbCapNote + ratioAdvisory + `LRGB combined via ${method} (lightness=${lightness}, saturation=${saturation}). ${statsLine(stats)}` };
    }
  },

  // --- WI-13: luminance injection (validated CIE-Y ratio blend) ---
  inject_luminance: {
    category: 'lrgb',
    definition: {
      name: 'inject_luminance',
      description: 'Inject a processed L channel into the RGB luminance via a CIE-Y ratio blend (PixelMath): Yn = w*L + (1-w)*Y; the RGB is scaled by Yn/Y (ratio capped at 3), hue preserved. Use INSTEAD of lrgb_combine when the L/RGB median ratio is large (>2x: LinearFit would crush L dynamic range; prep deliberately produces ~3x). weight 0.20-0.30 for 2-3x, 0.15-0.20 for >3x. Optional mask_view_id limits the injection (masked-out pixels are unchanged). Returns the L/RGB median ratio, pre/post stats and subject saturation P90. Galaxy profiles cap the weight (default 0.25; tools.LRGB.max_inject_weight).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'RGB (color) view to modify' },
          l_view_id: { type: 'string', description: 'Luminance view (default FILTER_L); must match geometry; stretched like the RGB' },
          weight: { type: 'number', description: 'L weight 0.10-0.50 (default 0.20)' },
          mask_view_id: { type: 'string', description: 'Optional mask view: injection applied only where the mask is 1' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const lView = input.l_view_id || 'FILTER_L';
      let weight = Math.max(0.10, Math.min(0.50, Number.isFinite(input.weight) ? input.weight : 0.20));
      const classif = brief?.target?.classification || '';
      let capNote = '';
      const caps = [];
      if (classif.startsWith('galaxy')) {
        const maxW = brief?.processingProfile?.tools?.LRGB?.max_inject_weight ?? 0.25;
        if (weight > maxW) {
          capNote = `PROFILE CAP (${classif}): weight requested ${weight} -> applied ${maxW}\n`;
          caps.push({ param: 'weight', requested: weight, applied: maxW, key: 'tools.LRGB.max_inject_weight' });
          process.stderr.write(`[inject_luminance] GALAXY CAP: weight ${weight} -> ${maxW} (profile limit for ${classif})\n`);
          weight = maxW;
        }
      }
      const pre = await getStats(ctx, input.view_id);
      const lSt = await getStats(ctx, lView);
      const ratio = (lSt?.median > 0 && pre?.median > 0) ? lSt.median / pre.median : null;
      await applyLuminanceInjection(ctx, input.view_id, lView, weight, input.mask_view_id, 'inject_luminance');
      recordLUsage(brief, 'inject_luminance', input.view_id);
      const post = await getStats(ctx, input.view_id);
      let satText = '';
      try {
        const sat = await checkSaturation(ctx, input.view_id);
        if (sat && Number.isFinite(sat.p90S)) satText = ` Subject saturation p90S=${sat.p90S.toFixed(3)}.`;
      } catch (_e) { /* optional */ }
      return {
        type: 'text', profileCaps: caps.length ? caps : undefined,
        text: capNote + `inject_luminance applied (L=${lView}, weight=${weight}${input.mask_view_id ? ', mask=' + input.mask_view_id : ''}). L/RGB median ratio: ${ratio != null ? ratio.toFixed(2) + 'x' : 'n/a'}. ` +
          `${statsLine(pre, 'Pre')} | ${statsLine(post, 'Post')}.${satText}`
      };
    }
  },

  // --- Ha injection ---
  ha_inject_red: {
    category: 'ha_injection',
    definition: {
      name: 'ha_inject_red',
      description: 'Inject Ha signal into the red channel of the target image. Uses conditional boost: only adds Ha where it exceeds the red channel by a threshold. strength controls how much Ha to add.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target RGB view ID' },
          ha_id: { type: 'string', description: 'Ha view ID (must be same dimensions, stretched to similar range)' },
          strength: { type: 'number', description: 'Ha injection strength (0.0-1.0, recommend 0.20-0.40)' },
          brightness_limit: { type: 'number', description: 'Only inject where Ha exceeds this fraction of red channel (0.0-0.50, default 0.25)' },
          max_output: { type: 'number', description: 'Soft-clamp R channel output. Values above this are compressed with 20% rolloff to prevent burnt Ha spots. Default 0.85. Range 0.70-0.95.' }
        },
        required: ['target_id', 'ha_id', 'strength']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const str = input.strength ?? 0.30;
      const limit = input.brightness_limit ?? 0.25;
      const maxOut = input.max_output ?? 0.85;
      // Conditional R-channel boost with soft-clamp: add Ha where it exceeds R by limit fraction,
      // then compress values above maxOut with a soft knee to prevent burnt Ha spots.
      // PixelMath: compute raw injection, then apply soft-clamp inline (no variables in PM expressions).
      // Soft-clamp: iif(raw > maxOut, maxOut + (raw - maxOut) * 0.20, raw)
      // We duplicate the raw expression in the outer iif — verbose but correct for PM.
      const rawExpr = `iif(${input.ha_id} > ${input.target_id}[0] * (1 + ${limit}), ${input.target_id}[0] + ${str} * (${input.ha_id} - ${input.target_id}[0]), ${input.target_id}[0])`;
      const clampedExpr = `iif(${rawExpr} > ${maxOut}, ${maxOut} + (${rawExpr} - ${maxOut}) * 0.20, ${rawExpr})`;
      await pjsrOrThrow(ctx, `
        var PM = new PixelMath;
        PM.expression = "${clampedExpr.replace(/"/g, '\\"')}";
        PM.expression1 = "${input.target_id}[1]";
        PM.expression2 = "${input.target_id}[2]";
        PM.useSingleExpression = false;
        PM.use64BitWorkingImage = true;
        PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
        PM.createNewImage = false;
        execOrThrow(PM, ImageWindow.windowById('${input.target_id}').mainView, 'ha_inject_red');
      `, 'ha_inject_red');
      const stats = await getStats(ctx, input.target_id);
      // Check per-channel max to warn about potential burning
      const chStats = await ctx.pjsr(`
        var w = ImageWindow.windowById('${input.target_id}');
        var img = w.mainView.image;
        img.selectedChannel = 0; var rMax = img.maximum();
        img.resetChannelSelection();
        JSON.stringify({ rMax: rMax });
      `);
      let rMaxInfo = '';
      try {
        const ch = JSON.parse(chStats.outputs?.consoleOutput || '{}');
        rMaxInfo = ` R_max=${ch.rMax?.toFixed(4) || 'N/A'}`;
        if (ch.rMax > 0.92) rMaxInfo += ' ⚠️ R channel near clipping — reduce Ha strength or max_output';
      } catch {}
      return { type: 'text', text: `Ha injected into red channel (strength=${str}, limit=${limit}, max_output=${maxOut}).${rMaxInfo} ${statsLine(stats)}` };
    }
  },

  ha_inject_luminance: {
    category: 'ha_injection',
    definition: {
      name: 'ha_inject_luminance',
      description: 'Blend Ha into the luminance of the target image. Adds Ha detail where it exceeds the current luminance. More subtle than red channel injection.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target RGB view ID' },
          ha_id: { type: 'string', description: 'Ha view ID' },
          strength: { type: 'number', description: 'Blend strength (0.0-0.50, recommend 0.15-0.30)' }
        },
        required: ['target_id', 'ha_id', 'strength']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const str = input.strength ?? 0.20;
      // Luminance overlay: Y_new = Y_old + strength * max(Ha - Y_old, 0)
      await pjsrOrThrow(ctx, `
        var PM = new PixelMath;
        PM.expression = "$T + ${str} * max(${input.ha_id} - (0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2]), 0) * $T / max(0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2], 0.00001)";
        PM.useSingleExpression = true;
        PM.use64BitWorkingImage = true;
        PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
        PM.createNewImage = false;
        execOrThrow(PM, ImageWindow.windowById('${input.target_id}').mainView, 'ha_inject_luminance');
      `, 'ha_inject_luminance');
      const hStats = await getStats(ctx, input.target_id);
      let chInfo = '';
      try {
        const chR = await ctx.pjsr(`
          var w = ImageWindow.windowById('${input.target_id}');
          var img = w.mainView.image; var mx = [];
          for (var c = 0; c < Math.min(3, img.numberOfChannels); c++) { img.selectedChannel = c; mx.push(img.maximum()); }
          img.resetChannelSelection();
          JSON.stringify(mx);
        `);
        const mx = JSON.parse(chR.outputs?.consoleOutput || '[]');
        if (mx.length === 3) {
          chInfo = ` R/G/B max=${mx.map(v => v.toFixed(4)).join('/')}`;
          if (Math.max(...mx) > 0.92) chInfo += ' \u26a0\ufe0f channel near clipping \u2014 reduce Ha strength';
        }
      } catch (_e) { /* optional */ }
      return { type: 'text', text: `Ha luminance blended (strength=${str}).${chInfo} ${statsLine(hStats)}` };
    }
  },

  // --- Narrowband Enhancement ---
  extract_pseudo_oiii: {
    category: 'narrowband',
    definition: {
      name: 'extract_pseudo_oiii',
      description: 'Extract pseudo-OIII emission from B channel by subtracting scaled R continuum. Creates a mono view of OIII signal. For emission objects (PNe, HII regions) where OIII data is in the broadband B filter. Use with dynamic_narrowband_blend for rich dual-zone color.',
      input_schema: {
        type: 'object',
        properties: {
          rgb_id: { type: 'string', description: 'Source RGB view ID' },
          continuum_factor: { type: 'number', description: 'R scaling factor for continuum (0.10-0.50, default 0.25). Higher = more aggressive continuum removal.' },
          output_id: { type: 'string', description: 'Output view ID (default: OIII_pseudo)' }
        },
        required: ['rgb_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await extractPseudoOIII(ctx, input.rgb_id, input.continuum_factor ?? 0.25, input.output_id ?? 'OIII_pseudo');
      return { type: 'text', text: `Pseudo-OIII extracted: ${result.viewId} (median=${result.median?.toFixed(6)}, max=${result.max?.toFixed(4)})` };
    }
  },

  continuum_subtract_ha: {
    category: 'narrowband',
    definition: {
      name: 'continuum_subtract_ha',
      description: 'Remove broadband continuum from Ha to isolate pure emission. Ha_pure = max(0, Ha - factor*R). Reduces star contamination and sharpens emission structures. Apply BEFORE Ha injection for cleaner results.',
      input_schema: {
        type: 'object',
        properties: {
          ha_id: { type: 'string', description: 'Ha view ID (mono)' },
          rgb_id: { type: 'string', description: 'RGB view ID (for R channel continuum reference)' },
          continuum_factor: { type: 'number', description: 'Scaling factor (0.20-0.40, default 0.28). Test in 0.02 increments.' }
        },
        required: ['ha_id', 'rgb_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await continuumSubtractHa(ctx, input.ha_id, input.rgb_id, input.continuum_factor ?? 0.28);
      return { type: 'text', text: `Ha continuum-subtracted (factor=${input.continuum_factor ?? 0.28}). median=${result.median?.toFixed(6)}, max=${result.max?.toFixed(4)}` };
    }
  },

  dynamic_narrowband_blend: {
    category: 'narrowband',
    definition: {
      name: 'dynamic_narrowband_blend',
      description: 'Inject Ha and OIII (real or pseudo) into RGB using dynamic weighting formula. Creates natural dual-zone color: Ha-dominant regions become red/pink, OIII-dominant regions become teal/blue, with smooth transitions. The community-proven formula f=(OIII*Ha)^(1-OIII*Ha) weights the green channel dynamically. Includes soft-clamp to prevent burning. Applied through a luminance mask to protect background from blue contamination (OIII noise residuals in B-R subtraction).',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target RGB view ID (modified in place)' },
          ha_id: { type: 'string', description: 'Ha view ID (mono)' },
          oiii_id: { type: 'string', description: 'OIII view ID (real or pseudo, mono)' },
          ha_strength: { type: 'number', description: 'Ha injection into R (0.10-0.50, default 0.35)' },
          oiii_strength: { type: 'number', description: 'OIII injection into B (0.10-0.60, default 0.40)' },
          g_strength: { type: 'number', description: 'OIII contribution to G (0.10-0.40, default 0.30)' },
          max_output: { type: 'number', description: 'Soft-clamp per channel (0.80-0.95, default 0.90)' },
          mask_clip: { type: 'number', description: 'Luminance mask clip threshold — pixels below this value are excluded from the blend (protects background from blue contamination). Lower = more inclusive, higher = tighter mask. (0.01-0.10, default 0.04)' }
        },
        required: ['target_id', 'ha_id', 'oiii_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await dynamicNarrowbandBlend(ctx, input.target_id, input.ha_id, input.oiii_id, {
        ha_strength: input.ha_strength,
        oiii_strength: input.oiii_strength,
        g_strength: input.g_strength,
        max_output: input.max_output,
        mask_clip: input.mask_clip
      });
      let warn = '';
      if (result.rMax > 0.92) warn += ' ⚠️ R hot';
      if (result.bMax > 0.92) warn += ' ⚠️ B hot';
      return { type: 'text', text: `Narrowband blend applied. median=${result.median?.toFixed(6)}, R_max=${result.rMax?.toFixed(4)}, B_max=${result.bMax?.toFixed(4)}${warn}` };
    }
  },

  create_synthetic_luminance: {
    category: 'narrowband',
    definition: {
      name: 'create_synthetic_luminance',
      description: 'Create synthetic luminance from Ha + OIII blend. For emission objects, this gives better nebula contrast than broadband L. Creates a new mono view. Use as L source for PixelMath L enhancement.',
      input_schema: {
        type: 'object',
        properties: {
          ha_id: { type: 'string', description: 'Ha view ID (mono)' },
          oiii_id: { type: 'string', description: 'OIII view ID (real or pseudo, mono)' },
          ha_weight: { type: 'number', description: 'Ha contribution (0.0-1.0, default 0.50)' },
          oiii_weight: { type: 'number', description: 'OIII contribution (0.0-1.0, default 0.50)' },
          output_id: { type: 'string', description: 'Output view ID (default: SYNTH_L)' }
        },
        required: ['ha_id', 'oiii_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await createSyntheticLuminance(ctx, input.ha_id, input.oiii_id, input.ha_weight ?? 0.50, input.oiii_weight ?? 0.50, input.output_id ?? 'SYNTH_L');
      return { type: 'text', text: `Synthetic luminance: ${result.viewId} (median=${result.median?.toFixed(6)}, max=${result.max?.toFixed(4)})` };
    }
  },

  // --- SHO / HOO false-color palette (mono narrowband masters) ---
  sho_combine: {
    category: 'narrowband',
    definition: {
      name: 'sho_combine',
      description: 'Build an RGB palette image from STRETCHED, STARLESS mono narrowband views (S, Ha, O). Palettes: "foraxx" (dynamic SHO — gold/blue directly, little green; best default), "sho" (classic Hubble R=S G=H B=O — Ha reads green, follow with sho_hue_shift), "hue_screen" (tint each channel with an HSV hue and screen-blend; hues in degrees, default S=0 red, H=35 gold, O=195 cyan — Jürgen Bätz NarrowbandHueCombination method), "hoo" (bicolor, no S; the only palette buildable without SII, and the default for HOO datasets). Gains scale each channel\'s signal ABOVE its own background (background level unchanged) — they are the normalization knob: SII/OIII are much weaker than Ha. If s_gain/o_gain are omitted they are auto-balanced (S span → 70% of H, O span → 85% of H). Creates/overwrites output_id; inputs untouched, so you can bracket palettes and gains freely.',
      input_schema: {
        type: 'object',
        properties: {
          palette: { type: 'string', enum: ['foraxx', 'sho', 'hue_screen', 'hoo'], description: 'Palette mapping (default foraxx; hoo for HOO datasets)' },
          s_id: { type: 'string', description: 'SII view (default FILTER_S)' },
          ha_id: { type: 'string', description: 'Ha view (default FILTER_Ha)' },
          o_id: { type: 'string', description: 'OIII view (default FILTER_O)' },
          output_id: { type: 'string', description: 'Output RGB view ID (default SHO)' },
          s_gain: { type: 'number', description: 'SII signal gain (0.5-4). Omit for auto-balance.' },
          o_gain: { type: 'number', description: 'OIII signal gain (0.5-4). Omit for auto-balance.' },
          h_gain: { type: 'number', description: 'Ha signal gain (default 1.0; <1 reduces Ha dominance / green)' },
          hues: { type: 'object', description: 'hue_screen only: {S, H, O} in degrees', properties: { S: { type: 'number' }, H: { type: 'number' }, O: { type: 'number' } } },
          sat: { type: 'number', description: 'hue_screen only: tint saturation (0.5-1, default 0.9)' },
          hoo_o_weight: { type: 'number', description: 'hoo only: OIII share of green (default 0.65)' }
        },
        required: []
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const rs = resolveShoInputs(_brief, input);
      if (rs.error) return { type: 'text', text: rs.error };
      const res = await shoCombine(ctx, rs.s_id, input.ha_id || 'FILTER_Ha', input.o_id || 'FILTER_O', {
        palette: rs.palette, output_id: input.output_id, s_gain: input.s_gain, o_gain: input.o_gain, h_gain: input.h_gain,
        hues: input.hues, sat: input.sat, hoo_o_weight: input.hoo_o_weight,
      });
      const bal = await measurePaletteBalance(ctx, res.viewId, { palette: res.palette });
      return { type: 'text', text: `${res.palette} palette → ${res.viewId} (gains S=${res.s_gain?.toFixed(2)} H=${res.h_gain?.toFixed(2)} O=${res.o_gain?.toFixed(2)}). median=${res.median?.toFixed(4)} max=${res.max?.toFixed(4)} ch medians R/G/B=${res.ch?.map(c => c.med.toFixed(4)).join('/')}\nPalette: ${bal.summary}` };
    }
  },

  reload_narrowband_channel: {
    category: 'narrowband',
    definition: {
      name: 'reload_narrowband_channel',
      description: 'Rebuild ONE narrowband channel (FILTER_S / FILTER_Ha / FILTER_O) from the prep\'s saved LINEAR STARLESS snapshot (after BXT + linear NXT + SXT, before any stretch). Force-closes the existing FILTER_<ch> view, reopens the snapshot, re-stretches it (Seti) at stretch_target (default: the prep target) and applies NXT at nxt_post (0 = none; omit = no post-stretch NXT). Use when a channel looks over-smoothed, grainy, or needs a different stretch depth than the prep gave — rebracket instead of stacking more denoise on an already-denoised channel. Rebuild palettes afterwards with sho_combine. The prep\'s own applied values are listed in the initial message (NXT post / stretch target).',
      input_schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['S', 'H', 'O'], description: 'Channel to rebuild (S=SII, H=Ha, O=OIII)' },
          stretch_target: { type: 'number', description: 'Median after stretch (default: prep stretch target)' },
          nxt_post: { type: 'number', description: 'Post-stretch NXT denoise 0-0.9 (0 or omitted = none)' }
        },
        required: ['channel']
      }
    },
    handler: async (ctx, store, brief, input) => {
      const k = String(input.channel || '').toUpperCase();
      if (!['S', 'H', 'O'].includes(k)) return { type: 'text', text: 'reload_narrowband_channel: channel must be S, H or O.' };
      const viewId = k === 'H' ? 'FILTER_Ha' : `FILTER_${k}`;
      let linPath = brief?._nbPrep?.linearStarless?.[k];
      if (!linPath || !fs.existsSync(linPath)) {
        const alt = path.join(store.baseDir, 'prep', `FILTER_${k}_linear_starless.xisf`);
        linPath = fs.existsSync(alt) ? alt : null;
      }
      if (!linPath) return { type: 'text', text: `reload_narrowband_channel: no linear starless snapshot for ${k} (not a narrowband run, or the prep predates snapshots).` };
      const pp = brief?._nbPrep?.prepParams || {};
      const target = typeof input.stretch_target === 'number' ? input.stretch_target
        : (pp.stretchTarget ?? brief?.processingProfile?.stretch?.target_median ?? 0.12);
      const headroom = pp.headroom ?? brief?.processingProfile?.stretch?.headroom ?? 0.08;
      const nxt = typeof input.nxt_post === 'number' ? input.nxt_post : 0;
      for (const img of await ctx.listImages()) {
        if (img.id === viewId) await pjsrOrThrow(ctx, `var w=ImageWindow.windowById('${viewId}');if(!w.isNull)w.forceClose();`, 'reload_narrowband_channel close');
      }
      await openXisfAs(ctx, linPath, viewId);
      await setiStretch(ctx, viewId, { targetMedian: target, hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: headroom });
      if (nxt > 0) {
        await pjsrOrThrow(ctx, `var P=new NoiseXTerminator;P.denoise=${nxt};P.detail=0.15;P.executeOn(ImageWindow.windowById('${viewId}').mainView);`, 'reload_narrowband_channel NXT');
      }
      const stats = await getStats(ctx, viewId);
      const count = (await ctx.listImages()).filter(i => i.id === viewId).length;
      return { type: 'text', text: `${viewId} rebuilt from ${path.basename(linPath)}: Seti target=${target}, NXT post=${nxt || 'none'}. ${statsLine(stats)} (windows named ${viewId}: ${count}). Rebuild the palette with sho_combine to see the effect.` };
    }
  },

  measure_background_grid: {
    category: 'measurement',
    definition: {
      name: 'measure_background_grid',
      description: 'Background flatness of a MONO view: 8x8 grid of cell medians in units of the image\'s pixel sigma; returns the border-ring spread (edgeSpread = max-min of border cells), edgeMin and edgeMax in sigma. The narrowband prep applies gradient correction only when edgeSpread exceeds 1.5 sigma; use this to verify a channel is flat (or to see whether GC is warranted).',
      input_schema: {
        type: 'object',
        properties: { view_id: { type: 'string', description: 'Mono view ID (e.g. FILTER_S, FILTER_Ha, FILTER_O)' } },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const iw = (await ctx.listImages()).find(i => i.id === input.view_id);
      if (!iw) return { type: 'text', text: `measure_background_grid: view ${input.view_id} not found.` };
      if (iw.isColor) return { type: 'text', text: 'measure_background_grid: mono views only.' };
      const g = await backgroundGrid(ctx, input.view_id);
      return { type: 'text', text: `Background grid ${input.view_id}: edgeSpread=${g.edgeSpread.toFixed(2)}σ edgeMin=${g.edgeMin?.toFixed(2)}σ edgeMax=${g.edgeMax?.toFixed(2)}σ (prep GC threshold 1.5σ)` };
    }
  },

  sho_hue_shift: {
    category: 'narrowband',
    definition: {
      name: 'sho_hue_shift',
      description: 'Hubble-palette hue rotation (CurvesTransformation hue→hue). Folds the GREEN band (Ha-dominated pixels) toward gold/orange while keeping reds and cyan/blue fixed — this is how classic SHO turns green into the Hubble gold WITHOUT greying it (SCNR removes green by desaturating; this re-hues it). Optional magenta fold (to_red or to_blue). Run measure_palette_balance after; iterate strength. Modifies view in place.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'RGB palette view' },
          strength: { type: 'number', description: '0-1 how far green moves to green_target (default 0.85)' },
          green_target: { type: 'number', description: 'Destination hue for green (0.08 orange … 0.15 yellow-gold; default 0.12)' },
          cyan_keep: { type: 'number', description: 'Hue above which nothing moves (default 0.48 = cyan protected)' },
          magenta: { type: 'string', enum: ['none', 'to_red', 'to_blue'], description: 'Fold magenta (default none)' },
          magenta_strength: { type: 'number', description: '0-1 (default 0.6)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const r = await shoHueShift(ctx, input.view_id, input);
      const bal = await measurePaletteBalance(ctx, input.view_id, { palette: nbPaletteOf(_brief) });
      return { type: 'text', text: `Hue curve applied: ${JSON.stringify(r.curve)}\nPalette: ${bal.summary}` };
    }
  },

  sho_hue_saturation: {
    category: 'narrowband',
    definition: {
      name: 'sho_hue_saturation',
      description: 'Hue-selective saturation (ColorSaturation HS curve) for palette images: boost/reduce saturation per hue family. Values −1..+1 (0 = unchanged; +0.3 is a strong boost). Typical Hubble finish: gold +0.15, cyan/blue +0.25, green −0.3. Modifies in place; check_saturation afterwards.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string' },
          red: { type: 'number' }, gold: { type: 'number' }, green: { type: 'number' },
          cyan: { type: 'number' }, blue: { type: 'number' }, magenta: { type: 'number' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const { view_id, ...boosts } = input;
      await shoHueSaturation(ctx, view_id, boosts);
      const bal = await measurePaletteBalance(ctx, view_id);
      return { type: 'text', text: `Hue saturation applied. Palette: ${bal.summary}` };
    }
  },

  measure_palette_balance: {
    category: 'narrowband',
    definition: {
      name: 'measure_palette_balance',
      description: 'Measure a false-color palette on SUBJECT pixels: fraction per hue family (red, gold, yellow, green, cyan, blue, magenta) with mean saturation, warm/cool split, background cast. Hubble-look goal: gold/orange dominant, cyan/blue present (>5%), green <10%, magenta <8%, neutral background. Read-only.',
      input_schema: { type: 'object', properties: { view_id: { type: 'string' } }, required: ['view_id'] }
    },
    handler: async (ctx, _store, _brief, input) => {
      const bal = await measurePaletteBalance(ctx, input.view_id, { palette: nbPaletteOf(_brief) });
      return { type: 'text', text: `Palette: ${bal.summary}\n${JSON.stringify(bal.families)}` };
    }
  },

  neutralize_palette_background: {
    category: 'narrowband',
    definition: {
      name: 'neutralize_palette_background',
      description: 'Make a false-color palette image\'s SKY neutral grey: measures per-channel sky level on the darkest grid cells and pulls each channel down to the darkest channel\'s level with a highlight falloff (nebula colors barely change). Needed after sho_hue_shift, which also rotates greenish background noise to gold (warm/brown sky). Modifies in place.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string' },
          falloff: { type: 'number', description: 'Highlight falloff exponent (default 2; higher = touches only the sky)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const r = await neutralizePaletteBackground(ctx, input.view_id, { falloff: input.falloff });
      return { type: 'text', text: `Background neutralized: sky R/G/B ${r.before.map(v => v.toFixed(4)).join('/')} → ${r.after.map(v => v.toFixed(4)).join('/')}` };
    }
  },

  lift_faint_halo: {
    category: 'narrowband',
    definition: {
      name: 'lift_faint_halo',
      description: 'USER-APPROVED finish step for emission palettes (PACMAN "really perfect"): reveal the faint outer nebulosity that the stretch/contrast curve crushed to black. Mask = view luminance band just above the sky and below the body (body excluded so it keeps contrast) × Ha guard (no sky-noise lift). Through it: lift curve, gold hue fold, LHE r250 (shapes in the cloud), NXT 0.25, halo colour (palette gold). Also builds BODY_EDGE for body_edge_contrast. Run AFTER the palette finish (curve/saturation/detail/chroma/neutralize), on a clone. Check 1:1 that revealed structure is real, not noise: save_and_show_preview(view_id, label, region="subject").',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Finished palette view (modified in place — clone first)' },
          ha_id: { type: 'string', description: 'Stretched starless Ha (default FILTER_Ha)' },
          out0: { type: 'number', description: 'Body exclusion ramp start, luminance (default 0.13; set between halo and body levels)' },
          out1: { type: 'number', description: 'Body exclusion ramp end (default 0.19)' },
          lhe_amount: { type: 'number', description: 'Cloud-shape LHE amount (default 0.35; 0 = off)' },
          color: { type: 'boolean', description: 'Apply halo palette colour boost (default true for SHO; default false for HOO, where the gold hue fold is also skipped)' },
          override: { type: 'boolean', description: 'Lift even though the class profile sets faint_halo.lift=false. Only if the user asked for it.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const fh = _brief?.processingProfile?.faint_halo;
      if (fh?.lift === false && !input.override) return { type: 'text', text: `lift_faint_halo refused for this class: ${fh.reason} Use compress_outer_haze (strength ${fh.compress_strength}) instead, or pass override=true only if the user asked for the lift.` };
      const isHoo = nbPaletteOf(_brief) === 'hoo';
      const r = await liftFaintHalo(ctx, input.view_id, input.ha_id || 'FILTER_Ha', { out0: input.out0, out1: input.out1, lhe_amount: input.lhe_amount, color: input.color ?? !isHoo, palette: isHoo ? 'hoo' : undefined });
      const bal = await measurePaletteBalance(ctx, input.view_id, { palette: nbPaletteOf(_brief) });
      return { type: 'text', text: `Halo lifted: sky lum ${r.sky?.toFixed(4)}, halo mask mean ${r.haloMaskMean?.toFixed(3)}, body-edge mask ${r.bodyMaskId} (mean ${r.bodyMaskMean?.toFixed(3)}), max ${r.max?.toFixed(3)}. Next: body_edge_contrast.\nPalette: ${bal.summary}` };
    }
  },

  body_edge_contrast: {
    category: 'narrowband',
    definition: {
      name: 'body_edge_contrast',
      description: 'After lift_faint_halo: restore the outer-body edge against the lifted halo (LHE r120 / 0.28 / slope 1.6 through the BODY_EDGE mask built from the pre-lift luminance). USER-APPROVED on PACMAN.',
      input_schema: { type: 'object', properties: { view_id: { type: 'string' }, amount: { type: 'number', description: 'default 0.28' } }, required: ['view_id'] }
    },
    handler: async (ctx, _store, _brief, input) => {
      const r = await bodyEdgeContrast(ctx, input.view_id, { amount: input.amount });
      return { type: 'text', text: `Body edge contrast applied (${r.result}).` };
    }
  },

  compress_outer_haze: {
    category: 'narrowband',
    definition: {
      name: 'compress_outer_haze',
      description: 'The opposite of lift_faint_halo, USER-APPROVED on the NGC6992 Veil ("haze75"; the lifted grey-pink fog was "way too much"): compress the faint outer haze toward the per-channel sky, X\' = sky + (X - sky)(1 - strength*mask). Mask = faint luminance outside a grown bright-filament body, so filaments and core are untouched and the arc keeps a soft edge. Run on a clone, on the finished palette view, before stars. Verify at 1:1 that no mask edge shows: save_and_show_preview(view_id, label, region="subject").',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Finished colour view (modified in place, clone first)' },
          strength: { type: 'number', description: '0-1 (default: profile faint_halo.compress_strength, else 0.75)' },
          body_lo: { type: 'number', description: 'Luminance above which the bright body is protected (default 0.28)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const strength = input.strength ?? _brief?.processingProfile?.faint_halo?.compress_strength;
      const r = await compressOuterHaze(ctx, input.view_id, { strength, body_lo: input.body_lo });
      return { type: 'text', text: `Outer haze compressed: strength ${r.strength}, sky lum ${r.skyLum?.toFixed(4)}, haze mask mean ${r.hazeMaskMean?.toFixed(3)}, median ${r.median?.toFixed(4)}. Check 1:1 for mask edges.` };
    }
  },

  chroma_smooth: {
    category: 'narrowband',
    definition: {
      name: 'chroma_smooth',
      description: 'Chroma-only noise reduction: blur CIE Lab a/b channels, keep lightness untouched. Use on palette images when 1:1 crops show orange/blue COLOR MOTTLE (blotches 30-80px) from weak gained channels (SII). Luminance detail is unaffected. sigma 6-10. Inspect the mottle with save_and_show_preview(view_id, label, region="subject") (1:1 crop) before and after.',
      input_schema: { type: 'object', properties: { view_id: { type: 'string' }, sigma: { type: 'number', description: 'Gaussian sigma px (default 8)' } }, required: ['view_id'] }
    },
    handler: async (ctx, _store, _brief, input) => {
      await chromaSmooth(ctx, input.view_id, { sigma: input.sigma });
      const bal = await measurePaletteBalance(ctx, input.view_id, { palette: nbPaletteOf(_brief) });
      return { type: 'text', text: `Chroma smoothed (sigma=${input.sigma ?? 8}). Palette: ${bal.summary}` };
    }
  },

  repair_star_residuals: {
    category: 'narrowband',
    definition: {
      name: 'repair_star_residuals',
      description: 'Flatten SXT residuals (halo/comatic wings left beside aberrated edge stars) in STARLESS mono views, using the saved linear star layers to locate stars. Only pixels near stars AND outside the Ha nebula envelope are replaced by the large-scale background — the nebula/center is never touched. Already run by narrowband prep; use again only if residuals are still visible in the outer field.',
      input_schema: {
        type: 'object',
        properties: {
          view_ids: { type: 'array', items: { type: 'string' }, description: 'Starless mono views (default FILTER_Ha, FILTER_O, FILTER_S)' },
          star_layer_paths: { type: 'array', items: { type: 'string' }, description: 'Linear star layer XISF paths (from prep summary)' },
          reach: { type: 'number', description: 'How far from a star a residual can sit, px (default 40)' },
          protect_above: { type: 'number', description: 'Ha envelope protection threshold above sky (default 0.015; lower = protect more)' }
        },
        required: ['star_layer_paths']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const views = input.view_ids || (nbWorkflow(_brief) === 'HOO' ? ['FILTER_Ha', 'FILTER_O'] : ['FILTER_Ha', 'FILTER_O', 'FILTER_S']);
      const r = await repairStarResiduals(ctx, views, input.star_layer_paths, { reach: input.reach, protect_above: input.protect_above, protect_view: 'FILTER_Ha' });
      return { type: 'text', text: `Residual repair: ${r.map(x => `${x.view} ${(x.weightMean * 100).toFixed(2)}%`).join(', ')} of pixels changed (outer field only).` };
    }
  },

  suggest_narrowband_balance: {
    category: 'narrowband',
    definition: {
      name: 'suggest_narrowband_balance',
      description: 'Measure the stretched S/H/O mono views (median, P90/P99/P99.5) and suggest s_gain/o_gain that bring SII and OIII signal spans to a chosen fraction of Ha. Read-only; feed the result to sho_combine.',
      input_schema: {
        type: 'object',
        properties: {
          s_id: { type: 'string' }, ha_id: { type: 'string' }, o_id: { type: 'string' },
          s_ratio: { type: 'number', description: 'target S span / H span (default 0.70)' },
          o_ratio: { type: 'number', description: 'target O span / H span (default 0.85)' }
        },
        required: []
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const b = await computeNarrowbandBalance(ctx, resolveShoInputs(_brief, { palette: nbPaletteOf(_brief), s_id: input.s_id }).s_id, input.ha_id || 'FILTER_Ha', input.o_id || 'FILTER_O', input);
      return { type: 'text', text: `Suggested gains: s_gain=${b.s_gain?.toFixed(2)} o_gain=${b.o_gain?.toFixed(2)}\nChannel stats: ${JSON.stringify(b.stats)}` };
    }
  },

  create_zone_masks: {
    category: 'narrowband',
    definition: {
      name: 'create_zone_masks',
      description: 'Create 3-zone masks for planetary nebulae: core (bright center), shell (main nebula body), halo (faint outer structure). Each zone gets a separate Gaussian-blurred mask for independent processing. Apply LHE with different amounts per zone, or enhance halo independently.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Source view to derive masks from' },
          core_clip: { type: 'number', description: 'Core threshold (default 0.40)' },
          shell_clip: { type: 'number', description: 'Shell threshold (default 0.15)' },
          halo_clip: { type: 'number', description: 'Halo threshold (default 0.04)' },
          blur_sigma: { description: 'Edge blur sigma: a number (all zones) or {core,shell,halo} (defaults 8/12/20)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await createZoneMasks(ctx, input.view_id, {
        core_clip: input.core_clip,
        shell_clip: input.shell_clip,
        halo_clip: input.halo_clip,
        blur_sigma: input.blur_sigma
      });
      const z = (n) => result.stats?.[n] ? `mean=${result.stats[n].mean.toFixed(3)}, cov=${(result.stats[n].coverage * 100).toFixed(1)}%${result.stats[n].flag ? ' [' + result.stats[n].flag + ']' : ''}` : 'n/a';
      return { type: 'text', text: `Zone masks created: ${result.coreId} (>${result.thresholds.core}; ${z('core')}), ${result.shellId} (${result.thresholds.shell}-${result.thresholds.core}; ${z('shell')}), ${result.haloId} (${result.thresholds.halo}-${result.thresholds.shell}; ${z('halo')}). Blur sigma core/shell/halo=${result.blur?.core}/${result.blur?.shell}/${result.blur?.halo}.` };
    }
  },

  continuous_clamp: {
    category: 'narrowband',
    definition: {
      name: 'continuous_clamp',
      description: 'Apply smooth brightness control that varies by brightness — bright cores compressed harder, faint regions barely affected. Uses a single smooth luminance mask with large blur. ZERO mask boundary artifacts.\n\nDefault mode is SOFT COMPRESSION (exponential saturation): values above the per-pixel knee are smoothly compressed, preserving relative brightness. A pixel at 0.90 and one at 0.85 remain distinguishable — gradients and detail are preserved. Hard mode (legacy) flattens everything above knee to a single value, destroying internal detail.\n\nCore (brightest) gets knee near min_clamp (default 0.80), shell (~0.5 brightness) near midpoint, background (faint) near max_clamp (default 0.95).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Target view to clamp (modified in place)' },
          min_clamp: { type: 'number', description: 'Knee level for brightest regions (default 0.80). Lower = harder compression on core.' },
          max_clamp: { type: 'number', description: 'Knee level for faintest regions (default 0.95). Higher = less effect on background.' },
          blur_sigma: { type: 'number', description: 'Gaussian blur sigma for luminance mask (default: auto = max(60, imageWidth/100)). Larger = smoother transitions.' },
          mode: { type: 'string', enum: ['soft', 'hard'], description: 'soft (default): exponential compression preserving detail. hard: legacy min() clamp that flattens to knee.' },
          headroom: { type: 'number', description: 'Soft mode only: how far above knee the output can reach (default 0.12). Higher = more dynamic range preserved above knee.' },
          rate: { type: 'number', description: 'Soft mode only: compression steepness (default 3.0). Higher = sharper rolloff at knee. 2.0 = gentle, 5.0 = aggressive.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await continuousClamp(ctx, input.view_id, {
        min_clamp: input.min_clamp,
        max_clamp: input.max_clamp,
        blur_sigma: input.blur_sigma,
        mode: input.mode,
        headroom: input.headroom,
        rate: input.rate
      });
      return { type: 'text', text: `Continuous clamp applied (${result.mode} mode): median=${result.median?.toFixed(6)}, max=${result.max?.toFixed(4)}, range=[${result.clampRange?.[0]}, ${result.clampRange?.[1]}], blur_sigma=${result.blur_sigma}${result.mode === 'soft' ? `, headroom=${result.headroom}, rate=${result.rate}` : ''}` };
    }
  },

  // --- Memory ---
  recall_memory: {
    category: 'memory',
    definition: {
      name: 'recall_memory',
      description: 'Read hierarchical memory from previous runs. Returns knowledge at 5 levels: universal rules, trait-level strategies (e.g. core_halo masking), type-level defaults (e.g. galaxy_spiral LHE), data-class parameters, and target-specific overrides. ALWAYS call this at the start.',
      input_schema: { type: 'object', properties: {} }
    },
    handler: async (_ctx, _store, brief, _input, agentName) => {
      // Try hierarchical memory first
      try {
        const { recallForBrief } = await import('../memory/hierarchical-memory.mjs');
        const result = recallForBrief(brief);
        const total = result.universal.length + result.trait.length + result.type.length +
          result.data_class.length + result.target.length;
        if (total > 0) {
          return { type: 'text', text: `## Hierarchical Memory (${total} entries across 5 levels)\n\n${result.summary}` };
        }
      } catch (e) {
        // Fall through to legacy
      }
      // Fallback: legacy flat memory
      const memDir = path.join(os.homedir(), '.pixinsight-mcp', 'agent-memory');
      const memFile = path.join(memDir, `${agentName}.json`);
      if (!fs.existsSync(memFile)) return { type: 'text', text: 'No memories yet. This is your first run.' };
      const entries = JSON.parse(fs.readFileSync(memFile, 'utf-8'));
      const summary = entries.map(e => `[${e.date || e.timestamp?.slice(0,10)}] **${e.title}**: ${e.content}`).join('\n\n');
      return { type: 'text', text: `## Legacy memories (${entries.length} entries)\n\n${summary}` };
    }
  },

  save_memory: {
    category: 'memory',
    definition: {
      name: 'save_memory',
      description: 'Save a lesson or insight to hierarchical memory. Specify the level: "universal" (applies to all), "trait" (applies to targets with a specific trait like core_halo), "type" (applies to a target classification), "data_class" (applies to similar data), "target" (applies to this specific target). Include param name and value for quantitative memories so the optimizer can track and promote them.',
      input_schema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['universal', 'trait', 'type', 'data_class', 'target'], description: 'Memory hierarchy level' },
          key: { type: 'string', description: 'Scope key: trait name, classification, data class, or target name. Ignored for universal.' },
          title: { type: 'string', description: 'Short title' },
          content: { type: 'string', description: 'Detailed lesson' },
          param: { type: 'string', description: 'Parameter name if this is a quantitative memory (e.g. "lhe_large_amount")' },
          value: { description: 'Parameter value (e.g. 0.35)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Additional tags' }
        },
        required: ['title', 'content']
      }
    },
    handler: async (_ctx, _store, brief, input, agentName) => {
      try {
        const { saveEntry } = await import('../memory/hierarchical-memory.mjs');
        const level = input.level || 'target';
        const key = input.key || brief?.target?.name || agentName;
        const entry = saveEntry(level, key, {
          title: input.title,
          content: input.content,
          param: input.param,
          value: input.value,
          tags: input.tags || [],
          classification: brief?.target?.classification,
        }, brief);
        return { type: 'text', text: `Memory saved at ${level} level (key: ${key}): "${input.title}"` };
      } catch (e) {
        // Fallback: legacy save
        const memDir = path.join(os.homedir(), '.pixinsight-mcp', 'agent-memory');
        fs.mkdirSync(memDir, { recursive: true });
        const memFile = path.join(memDir, `${agentName}.json`);
        let entries = [];
        if (fs.existsSync(memFile)) entries = JSON.parse(fs.readFileSync(memFile, 'utf-8'));
        entries.push({ title: input.title, content: input.content, tags: input.tags || [], timestamp: new Date().toISOString() });
        fs.writeFileSync(memFile, JSON.stringify(entries, null, 2));
        return { type: 'text', text: `Memory saved (legacy): "${input.title}"` };
      }
    }
  },

  // --- Control ---
  begin_composition: {
    category: 'control',
    definition: {
      name: 'begin_composition',
      description: 'Declare that candidate generation is done and move from generate_candidates to compose. Needed for runs with no star blend / LRGB step (e.g. starless SHO). Requires at least 2 saved variants. lrgb_combine and star_protected_blend also advance to compose.',
      input_schema: {
        type: 'object',
        properties: { note: { type: 'string', description: 'Optional: why generation is complete' } }
      }
    },
    handler: async (ctx, store, brief, input, agentName) => {
      const sm = brief?._stateMachine;
      if (!sm) return { type: 'text', text: 'begin_composition: no state machine active; nothing to do.' };
      const line = () => { const b = sm.getBudgetStatus(); return `[State: ${sm.state} | turns ${b.turnsRemaining}/${b.maxTurns} remaining]`; };
      if (sm.state === 'compose') return { type: 'text', text: `Already in compose. ${line()}` };
      if (sm.state !== 'generate_candidates') {
        return { type: 'text', text: `begin_composition is only meaningful from generate_candidates (current state: ${sm.state}). ${line()}` };
      }
      let n = 0;
      try { n = store ? store.listVariants(agentName).length : 0; } catch (e) { n = 0; }
      if (n < 2) {
        return { type: 'text', text: `Save at least 2 candidates first (save_variant): ${n} saved. ${line()}` };
      }
      sm.transitionTo('compose');
      return { type: 'text', text: `Entered compose with ${n} saved variants. ${line()}` };
    }
  },
  finish: {
    category: 'control',
    definition: {
      name: 'finish',
      description: 'Signal that you are done processing. You MUST provide a variant_id from a previous save_variant call — this is the durable artifact that will be exported. The variant must exist on disk. Quality gates run automatically on the view_id — if any FAIL, finish is REJECTED. Save your final image as a variant BEFORE calling finish.',
      input_schema: {
        type: 'object',
        properties: {
          variant_id: { type: 'string', description: 'REQUIRED: variant_id from save_variant (e.g. "variant_21"). This is the artifact that will be exported.' },
          view_id: { type: 'string', description: 'View ID for quality gate checks (must still be open in PixInsight). If omitted, uses the view from the variant metadata.' },
          rationale: { type: 'string', description: 'Explain why this is your best result and what trade-offs you made' },
          params_summary: { type: 'object', description: 'Key parameters used in the winning approach' },
          remaining_flaws: { type: 'array', items: { type: 'string' }, description: 'Known remaining flaws of the chosen image (critic flaws, your own preview vetoes, gate warnings). Persisted in final-selection.json and printed first in the run wrap-up. A warning is returned when absent. The rationale should start with "KNOWN FLAWS:".' }
        },
        required: ['variant_id', 'rationale']
      }
    },
    handler: async (ctx, store, brief, input, agentName) => {
      // === VARIANT VALIDATION ===
      // The variant_id is the source of truth for export.
      const variantId = input.variant_id;
      let variantMeta = null;

      if (variantId && store) {
        variantMeta = store.getVariantById(agentName, variantId);
        if (!variantMeta) {
          return {
            type: 'text',
            text: `FINISH REJECTED: variant_id="${variantId}" not found on disk. ` +
              `Call save_variant first to save your final image, then use the returned variant_id.`
          };
        }
        // Verify the XISF file actually exists
        if (!fs.existsSync(variantMeta.xisfPath)) {
          return {
            type: 'text',
            text: `FINISH REJECTED: variant_id="${variantId}" metadata exists but XISF file is missing at ${variantMeta.xisfPath}. ` +
              `Re-save the variant with save_variant.`
          };
        }
      }

      // Resolve view_id for quality gate checks
      // Prefer explicit view_id, fall back to the variant's source view
      const viewId = input.view_id || variantMeta?.viewId;
      if (!viewId) {
        return {
          type: 'text',
          text: `FINISH REJECTED: no view_id provided and variant has no source viewId. ` +
            `Provide view_id for quality gate checks.`
        };
      }

      const gateRun = await evaluateFinishGates(ctx, store, brief, viewId, agentName, { mode: 'run', variantId });
      const { failures, warnings, stats, metrics: gm } = gateRun;
      const gatesTrailer = `\n[GATES: ${failures.length ? 'FAIL' : 'PASS'}] ${failures.length} failures / ${warnings.length} warnings`;

      if (failures.length > 0) {
        return {
          type: 'text',
          text: `FINISH REJECTED — Quality gates failed:\n${failures.map(f => '  - ' + f).join('\n')}\n\n` +
            `You MUST fix these issues before calling finish again.\n` +
            `You remain in compose: masks (create_luminance_mask/apply_mask/mask_ops), multi_scale_enhance, shell_detail_enhance, run_hdrmt, inject_l_ifn/lift_dust, restore_from_clone are available \u2014 fix upstream, do not clamp harder.\n` +
            `Verify with: ${verifyToolsForGates(gateRun.failedGates)}.\n` +
            `Image stats: median=${stats.median.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}` + gatesTrailer +
            `\n\nGATES_JSON: ${JSON.stringify({ viewId, failedGates: gateRun.failedGates })}`
        };
      }

      // === WRITE FINAL SELECTION RECORD ===
      // This is the source of truth for export — artifact-based, not view-name-based.
      const remainingFlaws = Array.isArray(input.remaining_flaws) ? input.remaining_flaws.map(String) : null;
      if (!remainingFlaws) warnings.push('remaining_flaws not provided: pass the known remaining flaws (critic flaws, preview vetoes, gate warnings) so the run wrap-up can print them first.');
      if (variantMeta && store) {
        const seq = brief?._budget?.turnsUsed || 0;
        store.writeFinalSelection({
          variant_id: variantId,
          variant_path: variantMeta.xisfPath,
          agent: agentName,
          notes: variantMeta.params?.notes || input.rationale?.slice(0, 200) || '',
          finish_seq: seq,
          view_id: viewId, // for reference only — NOT used for export
          params_summary: input.params_summary || undefined,
          // WI-09: critical-summary inputs (flaws first in the wrap-up)
          gates: { passed: true, nearest: nearestGateMargins(gm, brief), metrics: summarizeGateMetrics(gm) },
          critic: gateRun.report?.critic || null,
          reference: gateRun.report?.reference || null,
          warnings: warnings.slice(),
          remaining_flaws: remainingFlaws || [],
          rationale_known_flaws_first: /^\s*KNOWN FLAWS:/i.test(input.rationale || ''),
        });
        process.stderr.write(`[finish] Committed final selection: ${variantId} → ${variantMeta.xisfPath}\n`);

        // WI-19: persist params_summary into the winner variant's metadata.params, and one
        // hierarchical-memory entry per numeric key (tagged auto/finish_params — NOT winning_param:
        // a passing finish is not user approval).
        if (input.params_summary && typeof input.params_summary === 'object') {
          try {
            const metaPath = path.join(store.agentDir(agentName), variantId, 'metadata.json');
            const md = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            md.params = { ...(md.params || {}), params_summary: input.params_summary };
            fs.writeFileSync(metaPath, JSON.stringify(md, null, 2));
          } catch (e) { /* non-fatal */ }
          try {
            const { saveEntry } = await import('../memory/hierarchical-memory.mjs');
            const cls = brief?.target?.classification || 'unknown';
            for (const [k, val] of Object.entries(input.params_summary)) {
              if (typeof val !== 'number' || !isFinite(val)) continue;
              saveEntry('target', brief?.target?.name || cls, { title: `finish param ${k}`, content: `${k}=${val} (run ${store.runId}, ${variantId}; passing finish, not user-approved)`, param: k, value: val, tags: ['auto', 'finish_params', cls] }, brief);
            }
          } catch (e) { /* non-fatal */ }
        }

        // B3a: record the promoted winner as a cross-run per-dimension champion.
        try {
          const classif = brief?.target?.classification || '';
          const maxP90 = brief?.processingProfile?.saturation?.max_p90 ?? 0.65;
          const raw = { detail: gm.detail, core: gm.core, saturation: gm.saturation, stars: gm.stars, dust: gm.dust };
          const dimScores = scoreVariantDimensions({ ...raw, maxP90, classification: classif, targetP90: brief?.processingProfile?.look?.target_p90 });
          recordChampions(ledgerKey(brief) || classif, store, { [variantId]: { dimensionScores: dimScores, xisfPath: variantMeta.xisfPath, rawMetrics: raw } });
        } catch (e) { /* non-fatal */ }
      }

      const finalStats = await getStats(ctx, viewId);
      const warnText = warnings.length > 0 ? `\nWarnings:\n${warnings.map(w => '  - ' + w).join('\n')}` : '';
      return {
        type: 'text',
        text: `Finished (quality gates PASSED). Final artifact: ${variantId} (${variantMeta?.xisfPath || 'N/A'})\n` +
          `Stats: median=${finalStats.median.toFixed(6)}, max=${(finalStats.max ?? 0).toFixed(4)}${warnText}\n` +
          `Rationale: ${input.rationale}` + gatesTrailer
      };
    }
  },

  // --- Star removal ---
  run_sxt: {
    category: 'star_removal',
    definition: {
      name: 'run_sxt',
      description: 'Run StarXTerminator to separate stars from the image. On LINEAR data: use stars=true, unscreen=false — creates a star image via subtraction. On NON-LINEAR (stretched) data: use stars=true, unscreen=true — creates screen-blend-compatible stars. WARNING for galaxies: SXT leaves residuals on HII regions, spiral knots. Consider skipping for large spirals.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to extract stars from (modified in-place to become starless)' },
          is_linear: { type: 'boolean', description: 'True if image is linear (pre-stretch). Determines unscreen mode.' },
          overlap: { type: 'number', description: 'Star overlap parameter (default 0.10)' }
        },
        required: ['view_id', 'is_linear']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const beforeIds = (await ctx.listImages()).map(i => i.id);
      const unscreen = input.is_linear ? 'false' : 'true';
      const r = await ctx.pjsr(`
        var P = new StarXTerminator;
        P.stars = true;
        P.unscreen = ${unscreen};
        P.overlap = ${input.overlap ?? 0.10};
        P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
        'OK';
      `);
      if (r.status === 'error') {
        return { type: 'text', text: `SXT failed: ${r.error?.message}` };
      }
      // Find the new stars image
      const afterImgs = await ctx.listImages();
      const newImgs = afterImgs.filter(i => !beforeIds.includes(i.id));
      const starsView = newImgs.find(i => i.id.includes('stars') || i.id.includes('star'));
      const starsId = starsView?.id || `${input.view_id}_stars`;
      return { type: 'text', text: `SXT complete. Starless: ${input.view_id}, Stars: ${starsId} (unscreen=${unscreen})` };
    }
  },

  // --- Readiness ---
  open_image: {
    category: 'readiness',
    definition: {
      name: 'open_image',
      description: 'Open an XISF/FITS image file in PixInsight. Returns the view ID assigned by PixInsight. Automatically closes any crop_mask windows that come with XISF files.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the image file' }
        },
        required: ['file_path']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const refused = await windowRefusal(ctx, 'open_image');
      if (refused) return refused;
      const r = await ctx.send('open_image', '__internal__', { filePath: input.file_path });
      if (r.status === 'error') {
        return { type: 'text', text: `Failed to open: ${r.error?.message}` };
      }
      // Close crop masks
      const imgs = await ctx.listImages();
      for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
        await pjsrOrThrow(ctx, `var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`, 'open_image');
      }
      const after = await ctx.listImages();
      const summary = after.map(i => `${i.id}: ${i.width}x${i.height} color=${i.isColor}`).join('\n');
      return { type: 'text', text: `Opened. Current images:\n${summary}` + await windowNote(ctx) };
    }
  },

  rename_view: {
    category: 'image_mgmt',
    definition: {
      name: 'rename_view',
      description: 'Rename an image view to a shorter or more convenient ID. Long XISF names can break PixInsight processes — rename to something like FILTER_R, FILTER_G, etc.',
      input_schema: {
        type: 'object',
        properties: {
          old_id: { type: 'string', description: 'Current view ID' },
          new_id: { type: 'string', description: 'New view ID (keep short, no spaces)' },
          replace_existing: { type: 'boolean', description: 'Close an already-open view with new_id first (default false: the rename is refused instead of PixInsight auto-suffixing)' }
        },
        required: ['old_id', 'new_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      if (input.new_id !== input.old_id) {
        const open = (await ctx.listImages()).some(i => i.id === input.new_id);
        if (open) {
          if (!input.replace_existing) return { type: 'text', text: `REFUSED: view ${input.new_id} already open — close it, pick another new_id, or pass replace_existing=true` };
          await pjsrOrThrow(ctx, `var w0 = ImageWindow.windowById('${input.new_id}'); if (!w0.isNull) w0.forceClose();`, 'rename_view');
        }
      }
      await pjsrOrThrow(ctx, `var w = ImageWindow.windowById('${input.old_id}'); if (!w.isNull) w.mainView.id = '${input.new_id}'; else throw new Error('View not found: ${input.old_id}');`, 'rename_view');
      return { type: 'text', text: `Renamed ${input.old_id} → ${input.new_id}` };
    }
  },

  get_image_dimensions: {
    category: 'image_mgmt',
    definition: {
      name: 'get_image_dimensions',
      description: 'Get dimensions, channel count, and color status for one or more views. Essential to check before ChannelCombination — all channels must have identical dimensions.',
      input_schema: {
        type: 'object',
        properties: {
          view_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'View IDs to check'
          }
        },
        required: ['view_ids']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const ids = input.view_ids.map(id => `'${id}'`).join(',');
      const r = await ctx.pjsr(`
        var ids = [${ids}];
        var res = [];
        for (var i = 0; i < ids.length; i++) {
          var w = ImageWindow.windowById(ids[i]);
          if (!w.isNull) {
            var img = w.mainView.image;
            res.push({ id: ids[i], width: img.width, height: img.height, channels: img.numberOfChannels, isColor: img.isColor });
          } else {
            res.push({ id: ids[i], error: 'not found' });
          }
        }
        JSON.stringify(res);
      `);
      return { type: 'text', text: r.outputs?.consoleOutput || '[]' };
    }
  },

  align_to_reference: {
    category: 'readiness',
    definition: {
      name: 'align_to_reference',
      description: 'Align a target image to a reference image using StarAlignment. The target is replaced in-place with the aligned version. Use this when channel dimensions differ before ChannelCombination.',
      input_schema: {
        type: 'object',
        properties: {
          reference_id: { type: 'string', description: 'Reference view ID (will not be modified)' },
          target_id: { type: 'string', description: 'Target view ID (will be replaced with aligned version)' }
        },
        required: ['reference_id', 'target_id']
      }
    },
    handler: async (ctx, store, _brief, input) => {
      const tmpDir = path.join(store.baseDir, 'tmp_align');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpRef = path.join(tmpDir, `${input.reference_id}.xisf`);
      const tmpTgt = path.join(tmpDir, `${input.target_id}.xisf`);

      // Save reference and target to temp files (StarAlignment requires file paths)
      for (const [viewId, filePath] of [[input.reference_id, tmpRef], [input.target_id, tmpTgt]]) {
        const saveR = await ctx.pjsr(`
          var w = ImageWindow.windowById('${viewId}');
          if (w.isNull) throw new Error('View not found: ${viewId}');
          var p = '${filePath.replace(/'/g, "\\'")}';
          if (File.exists(p)) File.remove(p);
          w.saveAs(p, false, false, false, false);
          if (w.mainView.id !== '${viewId}') w.mainView.id = '${viewId}';
          'OK';
        `);
        if (saveR.status === 'error') return { type: 'text', text: `Failed to save ${viewId}: ${saveR.error?.message}` };
      }

      // Run StarAlignment
      const saResult = await ctx.pjsr(`
        var P = new StarAlignment;
        P.referenceImage = '${tmpRef.replace(/'/g, "\\'")}';
        P.referenceIsFile = true;
        P.targets = [[true, true, '${tmpTgt.replace(/'/g, "\\'")}']];
        P.outputDirectory = '${tmpDir.replace(/'/g, "\\'")}';
        P.outputPrefix = 'aligned_';
        P.outputPostfix = '';
        P.overwriteExistingFiles = true;
        P.onError = StarAlignment.prototype.Continue;
        P.useTriangles = true;
        P.polygonSides = 5;
        P.useBrightnessRelations = true;
        P.sensitivity = 0.50;
        P.noGUIMessages = true;
        P.distortionCorrection = false;
        P.generateDrizzleData = false;
        var ok = P.executeGlobal();
        'SA_result=' + ok;
      `);

      const saOk = (saResult.outputs?.consoleOutput || '').includes('true');
      if (!saOk) return { type: 'text', text: `StarAlignment failed: ${saResult.outputs?.consoleOutput || saResult.error?.message}` };

      // Find the aligned output file — must match THIS target specifically
      const expectedName = `aligned_${input.target_id}.xisf`;
      const alignedPath = path.join(tmpDir, expectedName);
      if (!fs.existsSync(alignedPath)) {
        // Fallback: look for any aligned file that was just created
        const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('aligned_'));
        if (files.length === 0) return { type: 'text', text: 'StarAlignment produced no output file' };
        // Sort by modification time, newest first
        files.sort((a, b) => fs.statSync(path.join(tmpDir, b)).mtimeMs - fs.statSync(path.join(tmpDir, a)).mtimeMs);
        // Use the most recently modified file
        const fallbackPath = path.join(tmpDir, files[0]);
        return { type: 'text', text: `Warning: Expected ${expectedName} not found. Using ${files[0]} instead. Aligned file: ${fallbackPath}` };
      }

      // Close old target, open aligned, rename
      await pjsrOrThrow(ctx, `var w = ImageWindow.windowById('${input.target_id}'); if (!w.isNull) w.forceClose();`, 'align_to_reference');
      await ctx.send('open_image', '__internal__', { filePath: alignedPath });

      // Close crop masks
      const imgs = await ctx.listImages();
      for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
        await pjsrOrThrow(ctx, `var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`, 'align_to_reference');
      }

      // Find and rename the new view — look for the aligned file name specifically
      const newImgs = await ctx.listImages();
      const alignedBaseName = path.basename(alignedPath, '.xisf').replace(/[^a-zA-Z0-9_]/g, '_');
      const aligned = newImgs.find(i => i.id.includes('aligned') || i.id.includes(alignedBaseName));
      if (aligned && aligned.id !== input.target_id) {
        await pjsrOrThrow(ctx, `var w = ImageWindow.windowById('${aligned.id}'); if (!w.isNull) w.mainView.id = '${input.target_id}';`, 'align_to_reference');
      }
      // Fallback: if target_id still doesn't exist, find any new mono view that wasn't there before
      const targetExists = newImgs.some(i => i.id === input.target_id);
      if (!targetExists) {
        const beforeSet = new Set([input.reference_id, 'FILTER_L', 'FILTER_Ha', 'FILTER_G']);
        const candidate = newImgs.find(i => !i.isColor && !beforeSet.has(i.id));
        if (candidate) {
          await pjsrOrThrow(ctx, `var w = ImageWindow.windowById('${candidate.id}'); if (!w.isNull) w.mainView.id = '${input.target_id}';`, 'align_to_reference');
        }
      }

      // Verify
      const dimR = await ctx.pjsr(`
        var r = ImageWindow.windowById('${input.reference_id}');
        var t = ImageWindow.windowById('${input.target_id}');
        JSON.stringify({ ref: { w: r.mainView.image.width, h: r.mainView.image.height }, tgt: { w: t.mainView.image.width, h: t.mainView.image.height } });
      `);
      return { type: 'text', text: `Aligned ${input.target_id} to ${input.reference_id}. Aligned file on disk: ${alignedPath}. Dimensions: ${dimR.outputs?.consoleOutput}` };
    }
  },

  combine_channels: {
    category: 'readiness',
    definition: {
      name: 'combine_channels',
      description: 'Combine 3 mono views into a single RGB color image using ChannelCombination. All 3 views MUST have identical dimensions — align first if they differ. Returns the view ID of the combined image.',
      input_schema: {
        type: 'object',
        properties: {
          r_view_id: { type: 'string', description: 'Red channel view ID' },
          g_view_id: { type: 'string', description: 'Green channel view ID' },
          b_view_id: { type: 'string', description: 'Blue channel view ID' },
          output_id: { type: 'string', description: 'Desired output view ID (the combined image will be renamed to this)' }
        },
        required: ['r_view_id', 'g_view_id', 'b_view_id', 'output_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const beforeIds = (await ctx.listImages()).map(i => i.id);

      const r = await ctx.pjsr(`
        var P = new ChannelCombination;
        P.colorSpace = ChannelCombination.prototype.RGB;
        P.channels = [
          [true, '${input.r_view_id}'],
          [true, '${input.g_view_id}'],
          [true, '${input.b_view_id}']
        ];
        var ok = P.executeGlobal();
        'CC_result=' + ok;
      `);

      const ccOk = (r.outputs?.consoleOutput || '').includes('true');
      if (!ccOk) return { type: 'text', text: `ChannelCombination failed: ${r.outputs?.consoleOutput}. Check that all 3 views have identical dimensions.` };

      // Find the new color image
      const afterImgs = await ctx.listImages();
      const newImg = afterImgs.find(i => i.isColor && !beforeIds.includes(i.id));
      if (!newImg) {
        // Maybe it reused an existing window
        const anyColor = afterImgs.find(i => i.isColor);
        if (anyColor) {
          if (anyColor.id !== input.output_id) {
            await pjsrOrThrow(ctx, `var w = ImageWindow.windowById('${anyColor.id}'); if (!w.isNull) w.mainView.id = '${input.output_id}';`, 'combine_channels');
          }
          return { type: 'text', text: `Combined into ${input.output_id} (${anyColor.width}x${anyColor.height})` };
        }
        return { type: 'text', text: 'ChannelCombination returned true but no color image found' };
      }

      if (newImg.id !== input.output_id) {
        await pjsrOrThrow(ctx, `var w = ImageWindow.windowById('${newImg.id}'); if (!w.isNull) w.mainView.id = '${input.output_id}';`, 'combine_channels');
      }
      return { type: 'text', text: `Combined into ${input.output_id} (${newImg.width}x${newImg.height})` };
    }
  },

  // --- Quality Gates (automated, code-based — cannot be bypassed) ---
  run_quality_gates: {
    category: 'quality_gate',
    definition: {
      name: 'run_quality_gates',
      description: 'Run the FULL finish gate battery on a view WITHOUT finishing (read-only, no state change). Returns [GATE BATTERY: PASS|FAIL] with the exact failure/warning texts finish would produce, plus one metric line per dimension. Use it to see every blocking problem at once before calling finish. The aesthetic critic is skipped unless include_aesthetic=true. If variant_id is given the result is stored in that variant\'s metadata.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to evaluate (must be open in PixInsight)' },
          include_aesthetic: { type: 'boolean', description: 'Also run the independent aesthetic critic (slow; default false)' },
          include_reference: { type: 'boolean', description: 'Compare to the registered reference image when one exists (default true)' },
          variant_id: { type: 'string', description: 'Optional: persist the gate result into this variant\'s metadata' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, store, brief, input, agentName) => {
      const res = await evaluateFinishGates(ctx, store, brief, input.view_id, agentName, {
        mode: 'run',
        aesthetic: !!input.include_aesthetic,
        reference: input.include_reference !== false,
        variantId: input.variant_id,
      });
      const { failures, warnings, metrics, stats } = res;
      const f = (v, d = 3) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '?');
      const lines = [];
      const m = metrics;
      if (m.stars) lines.push(`stars: contrast=${f(m.stars.starBgContrast, 1)}x FWHM=${f(m.stars.medianFWHM, 1)}px count=${m.stars.starsFound ?? '?'}`);
      if (m.core) lines.push(`core: relContrast=${f(m.core.coreRelContrast)} ratio=${f(m.core.ratio, 2)} coreFraction=${f(m.core.coreFraction)}`);
      if (m.detail) lines.push(`detail: brightness=${f(m.detail.subjectBrightness)} contrast=${f(m.detail.contrastRatio, 1)}x detail=${f(m.detail.detailScore, 6)}`);
      if (m.saturation) lines.push(`saturation: P90=${f(m.saturation.p90S)} subjectPixels=${m.saturation.subjectPixelCount ?? '?'}`);
      if (m.dust) lines.push(`dust: ${m.dust.pass ? 'pass' : 'FAIL'} ${m.dust.details || ''}`.trim());
      if (m.noise) lines.push(`noise: bg=${f(m.noise.bgNoise, 4)} dust=${f(m.noise.dustNoise, 4)}`);
      if (m.tonal) lines.push(`tonal: separation=${f(m.tonal.separation, 2)}x roi=${m.tonal.roi_confidence ?? '?'}`);
      if (m.texture) lines.push(`texture: verdict=${m.texture.verdict ?? '?'}`);
      if (m.palette) lines.push(`palette: ${m.palette.summary || ''}`);
      lines.push(`image: median=${f(stats.median, 6)} max=${f(stats.max ?? 0, 4)}`);
      if (input.variant_id && store && typeof store.saveVariantMetrics === 'function') {
        try {
          store.saveVariantMetrics(agentName, input.variant_id, {
            pass: failures.length === 0, failures: failures.length, warnings: warnings.length,
            failedGates: res.failedGates.map(g => g.gate), metrics: summarizeGateMetrics(metrics),
          });
        } catch (e) { lines.push(`(could not persist to ${input.variant_id}: ${e.message})`); }
      }
      return {
        type: 'text',
        text: `[GATE BATTERY: ${failures.length ? 'FAIL' : 'PASS'}] ${failures.length} failures / ${warnings.length} warnings\n` +
          (failures.length ? `Failures:\n${failures.map(x => '  - ' + x).join('\n')}\n` : '') +
          (warnings.length ? `Warnings:\n${warnings.map(x => '  - ' + x).join('\n')}\n` : '') +
          `Metrics:\n${lines.map(x => '  ' + x).join('\n')}`
      };
    }
  },

  check_star_quality: {
    category: 'quality_gate',
    definition: {
      name: 'check_star_quality',
      description: 'Automated quality gate: measures star FWHM and color diversity using StarDetector + pixel sampling. PASS: median FWHM within the contract limit (FWHM_HARD; advisory for galaxies) AND color diversity > 0.05 AND star/background contrast above the prominence minimum for the profile. FAIL: bloated or colorless stars. Run this on the final composite (with stars reintegrated).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID of the final image (must include stars)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      // Per-profile brightness threshold (single source: gate-contract)
      const prominence = brief?.processingProfile?.stars?.prominence || 'balanced';
      const minContrast = starMinContrast(brief?.processingProfile);
      const fwhmLimit = gateThreshold(brief?.processingProfile, 'stars.fwhm_hard', FWHM_HARD);
      const isGalaxyQ = (brief?.target?.classification || '').startsWith('galaxy');
      const result = await checkStarQuality(ctx, input.view_id, { minContrast, fwhmHard: fwhmLimit, ...starFieldOpts(brief) });
      const brightnessOk = (result.starBgContrast || 0) >= minContrast;
      const overallPass = result.pass && brightnessOk;
      const status = overallPass ? 'PASS' : 'FAIL';
      let text = `[STAR QUALITY GATE: ${status}] ${result.details}\n` +
        `  Median FWHM: ${result.medianFWHM?.toFixed(2) || 'N/A'}px (limit: ${fwhmLimit}px${isGalaxyQ ? '; advisory for galaxies' : ''})\n` +
        `  Color diversity: ${result.colorDiversity?.toFixed(3) || 'N/A'} (limit: 0.05)\n` +
        `  Stars found: ${result.starsFound || 0}, measured: ${result.starsMeasured || 0}\n` +
        `  Star brightness: median peak=${result.medianPeak?.toFixed(3) || 'N/A'}, ` +
        `contrast=${result.starBgContrast?.toFixed(1) || 'N/A'}× vs bg=${result.bgMedian?.toFixed(4) || 'N/A'} ` +
        `(limit: ${minContrast}× for ${prominence} stars)`;
      // WI-16: advisory star-field block (compact-peak detection, local-bg FWHM, ellipticity, centre/edge, abs prominence)
      if (result.starField && result.starField.text) {
        const sf = result.starField;
        text += `\n  ${sf.text}` +
          `\n  (advisory only/PROVISIONAL; blocking metric stays contrast=${result.starBgContrast?.toFixed(1) || 'N/A'}x. Median FWHM here is local-background, uncapped walk, knots rejected; centre zone r=${Math.round(sf.centerRadiusPx || 0)}px)`;
      } else if (result.starField && result.starField.error) {
        text += `\n  star field metric unavailable: ${result.starField.error}`;
      }
      if (!brightnessOk) {
        text += `\n  FIX: Stars are too dim. Increase star_protected_blend strength, use brighter stretch_stars (lower setiMidtone or more iterations), or boost star layer brightness with curves before blending.`;
      }
      return { type: 'text', text };
    }
  },

  check_ringing: {
    category: 'quality_gate',
    definition: {
      name: 'check_ringing',
      description: 'Automated quality gate: detects concentric ring artifacts (HDRMT ringing) around the brightest region. Computes radial brightness profile (150 radii x 36 angles) and counts derivative oscillations. PASS: <= 1 oscillation. FAIL: >= 3 oscillations with amplitude > 0.01.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to check for ringing artifacts' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await checkRinging(ctx, input.view_id);
      const category = brief?.target?.classification || 'unknown';

      // Category-aware interpretation: edge-on galaxies have natural radial oscillations
      const morphologyConflict = ['galaxy_edge_on', 'galaxy_spiral'].includes(category);
      const blocking = !morphologyConflict; // only blocking for non-galaxy targets

      let status, interpretation;
      if (result.pass) {
        status = 'PASS';
        interpretation = '';
      } else if (morphologyConflict) {
        status = 'ADVISORY';
        interpretation = `\n  NOTE: ${category} targets have natural radial brightness oscillations (disk + dust lane). ` +
          `High oscillation count likely reflects STRUCTURE, not processing artifacts. ` +
          `This is NOT blocking for ${category}. Focus on edge overshoot and halo artifacts instead.`;
      } else {
        status = 'FAIL';
        interpretation = `\n  This indicates likely HDRMT or sharpening artifacts. Revert and reduce enhancement.`;
      }

      return {
        type: 'text',
        text: `[RINGING GATE: ${status}${morphologyConflict ? ' — morphology conflict' : ''}] ${result.details}\n` +
          `  Oscillations: ${result.oscillations} (limit: 1)\n` +
          `  Max amplitude: ${result.maxAmplitude?.toFixed(4) || 'N/A'}\n` +
          `  Brightest region center: [${result.center || 'N/A'}]` +
          `  Blocking: ${blocking}` +
          interpretation
      };
    }
  },

  check_sharpness: {
    category: 'quality_gate',
    definition: {
      name: 'check_sharpness',
      description: 'Measure sharpness as CREDIBLE detail (star-rejected Sobel energy minus the image\'s own noise floor) over the subject blocks, optionally restricted to a ROI. Returns detailCredible (the score), plus detailRaw/detailWeber and a noise-dominated flag. Use this to compare candidates — it is a RELATIVE metric, not pass/fail.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to measure' },
          roi_x: { type: 'number', description: 'ROI x offset (optional, defaults to center 50%)' },
          roi_y: { type: 'number', description: 'ROI y offset' },
          roi_w: { type: 'number', description: 'ROI width' },
          roi_h: { type: 'number', description: 'ROI height' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const roi = (input.roi_x != null && input.roi_w != null)
        ? { x: input.roi_x, y: input.roi_y, w: input.roi_w, h: input.roi_h }
        : undefined;
      const result = await checkSharpness(ctx, input.view_id, roi);
      return {
        type: 'text',
        text: `[SHARPNESS] ${result.details}`
      };
    }
  },

  scan_burnt_regions: {
    category: 'quality_gate',
    definition: {
      name: 'scan_burnt_regions',
      description: `Global burn scanner (one pass): tiles the ENTIRE image in 50x50 blocks; a block is burnt when >3% of its sampled pixels exceed ${BURN_CLIP} (PASS = ZERO burnt blocks, this is the finish burn_clip gate). The same pass also reports the fraction of blocks above ${BRIGHT_BLOCK_LEVEL} (the bright_blocks gate; per-profile limit, default 3%), per-channel exceedance (R/G/B) and the white fraction inside bright blocks, so you can preview both gates before finish. Catches burnt regions ANYWHERE, not just the brightest core.`,
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to scan' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await scanBurntRegions(ctx, input.view_id);
      const status = result.pass ? 'PASS' : 'FAIL';
      return {
        type: 'text',
        text: `[BURN SCAN: ${status}] ${result.details}\n` +
          `  Clip blocks (>${BURN_CLIP}): ${result.burntBlockCount || 0}/${result.totalBlocks || 0} (limit: 0)\n` +
          `  Bright blocks (>${BRIGHT_BLOCK_LEVEL}): ${result.brightBlocks || 0}/${result.totalBlocks || 0} (${((result.brightFraction || 0) * 100).toFixed(1)}%, profile limit default 3%)\n` +
          (result.perChannelExceedance ? `  Per-channel >${BURN_CLIP}: R ${(result.perChannelExceedance.R * 100).toFixed(2)}% G ${(result.perChannelExceedance.G * 100).toFixed(2)}% B ${(result.perChannelExceedance.B * 100).toFixed(2)}%; white fraction in bright blocks ${((result.coreWhiteFraction || 0) * 100).toFixed(0)}%` : '')
      };
    }
  },

  check_saturation: {
    category: 'quality_gate',
    definition: {
      name: 'check_saturation',
      description: 'Automated quality gate: measures HSV saturation in subject pixels (above background). Returns median, P90, P99 saturation. Use AFTER every saturation boost, curves, Ha injection, hue_boost — ideally on starless composite BEFORE star blend. Compare P90 against processing profile max_p90 limit. Over-saturation makes images look synthetic.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to measure saturation on' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      try {
        const result = await checkSaturation(ctx, input.view_id);
        const { maxP90, warnAt, failAt, targetP90 } = saturationThresholds(brief);
        let text = result.details;
        text += `\n\nProfile thresholds: P90 target/warn above ${warnAt.toFixed(2)}${targetP90 !== undefined ? ' (look.target_p90)' : ''}; finish gate limit: P90 above ${failAt.toFixed(2)} is rejected.`;

        // Add repair policy if saturation exceeds limit
        if (result.p90S > warnAt) {
          const provRec = brief?._provenance?.get(input.view_id);
          const provenance = provRec?.lastComposition || provRec;   // WI-06: composition provenance
          if (provenance && provenance.tool === 'lrgb_combine') {
            const origSat = provenance.params?.saturation ?? 0.80;
            const suggestedSat1 = Math.max(0.20, origSat - 0.20);
            const suggestedSat2 = Math.max(0.20, origSat - 0.30);
            text += `\n\n** REPAIR POLICY — UPSTREAM FIX REQUIRED **` +
              `\nSuspected source: lrgb_combine (saturation=${origSat})` +
              `\nP90=${result.p90S.toFixed(3)} exceeds limit ${maxP90.toFixed(2)}. LRGB combine amplified saturation.` +
              `\nREQUIRED ACTION: restore_from_clone → lrgb_combine with lower saturation param.` +
              `\n  Try: saturation=${suggestedSat1.toFixed(2)}, then saturation=${suggestedSat2.toFixed(2)}` +
              `\nPROHIBITED: Do NOT apply S-curve desaturation or downstream color correction.` +
              `\nPost-hoc desaturation destroys channel color gradients. Adjust the blend param instead.`;
          } else if (result.p90S > failAt) {
            text += `\n\nWARNING: P90=${result.p90S.toFixed(3)} exceeds hard limit ${failAt.toFixed(2)}. Reduce saturation at the source — curves, LRGB params, or Ha injection strength.`;
          }
        }

        return { type: 'text', text };
      } catch (e) {
        return { type: 'text', text: `Saturation check error: ${e.message}` };
      }
    }
  },

  stage_checkpoint: {
    category: 'quality_gate',
    definition: {
      name: 'stage_checkpoint',
      description: 'Measure the metrics of ONE processing stage on a view and record them (cheap, partial finish check). Recommended order — operations that move many metrics first: tone (core/disc vs prep, outer zone, sky, separation) -> local_contrast (mottle, core structure) -> detail_noise (fine detail vs prep, grain; sharpen and denoise judged together) -> colour (arm saturation floor, P90; colour tools move nothing else) -> stars. Call it when you finish a stage; if a later finish gate fails on a metric that passed here, the failure names the stage that drifted.',
      input_schema: { type: 'object', properties: { view_id: { type: 'string' }, stage: { type: 'string', enum: ['tone', 'local_contrast', 'detail_noise', 'colour'] } }, required: ['view_id', 'stage'] }
    },
    handler: async (ctx, _store, brief, input) => {
      const rows = await measureStage(ctx, brief, input.view_id, input.stage);
      if (brief) { brief._stageLocks = brief._stageLocks || {}; brief._stageLocks[input.stage] = { view: input.view_id, rows }; }
      const def = METRIC_STAGES.find(x => x.stage === input.stage);
      const lines = rows.map(r => `- ${r.pass ? 'PASS' : 'FAIL'} ${r.gate}: ${r.metric} = ${r.value} (${r.limit})${r.note ? ` — ${r.note}` : ''}`);
      const allPass = rows.every(r => r.pass);
      return { type: 'text', text: `[STAGE ${input.stage.toUpperCase()}: ${allPass ? 'PASS' : 'FAIL'}] on ${input.view_id}\n${lines.join('\n') || '- (no gates configured for this stage)'}\nStage tools: ${def?.tools}.\n${allPass ? 'Recorded. Later stages should not move these; finish will attribute any drift to this stage.' : 'Fix this stage before moving on: later stages cannot repair it without side effects.'}` };
    }
  },

  check_tonal_presence: {
    category: 'quality_gate',
    definition: {
      name: 'check_tonal_presence',
      description: 'Deterministic tonal critic: measures whether the subject is tonally impactful relative to background, or merely technically safe but subdued. Returns verdict: subdued (<3× separation), balanced (3-8×), aggressive (>8×). Use BEFORE star blend on composition candidates. Subdued = HARD FAIL if ROI confidence is high/medium.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to check (ideally starless composition)' },
          category: { type: 'string', description: 'Target classification (e.g. galaxy_spiral, planetary_nebula)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const category = input.category || brief?.target?.classification || 'unknown';
      const result = await checkTonalPresence(ctx, input.view_id, category);
      const status = result.pass ? (result.tonal_verdict === 'subdued' ? 'ADVISORY' : 'PASS') : 'FAIL';

      let guidance = '';
      if (result.tonal_verdict === 'subdued' && result.roi_confidence !== 'low') {
        guidance = '\n\nACTION REQUIRED: Subject is too dim relative to background.\n' +
          '  1. Restore pre-star checkpoint\n' +
          '  2. Apply ONE subject-masked midtone lift (run_curves through luminance mask)\n' +
          '  3. Re-blend stars after lifting\n' +
          '  Do NOT apply blind global brightness boost.';
      } else if (result.tonal_verdict === 'aggressive') {
        guidance = '\n\nNOTE: Very high separation — check for burns in subject bright areas with scan_burnt_regions.';
      }

      return {
        type: 'text',
        text: `[TONAL PRESENCE: ${status} — ${result.tonal_verdict.toUpperCase()}] ${result.details}\n` +
          `  Separation: ${result.separation?.toFixed(2)}× (subdued: <3, balanced: 3-8, aggressive: >8)\n` +
          `  Subject median: ${result.subject_median?.toFixed(4)}, Background median: ${result.background_median?.toFixed(4)}\n` +
          `  Core brightness: ${result.core_brightness?.toFixed(4)}, Faint visibility: ${result.faint_structure_visibility?.toFixed(3)}\n` +
          `  ROI confidence: ${result.roi_confidence}, mode: ${result.roi_mode}, subject pixels: ${result.subjectPixelCount}` +
          (result.category_metrics?.core_to_disk != null ? `\n  Core-to-disk ratio: ${result.category_metrics.core_to_disk.toFixed(2)}` : '') +
          guidance
      };
    }
  },

  check_star_layer_integrity: {
    category: 'quality_gate',
    definition: {
      name: 'check_star_layer_integrity',
      description: 'Pre-blend star layer validation: checks for clipping, color loss, and quality issues in the star layer. PRECONDITION for star_protected_blend — must be called before blending stars. FAIL: max >= 0.98 or any pixel > 0.995. WARN: >1% near-clipped or low color diversity.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Star layer view ID to validate' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await checkStarLayerIntegrity(ctx, input.view_id);

      // Detect unstretched star layer: median near zero AND most non-zero pixels are faint
      // A properly stretched star layer has bright star peaks spread across the range.
      // An unstretched one has median ~0 and only a handful of pixels above 0.1
      const stats = await getStats(ctx, input.view_id);
      // 2026-11-08 (M74 v8): the old absolute "< 20000 sampled pixels above 0.005" was set on full frames
      // (~3.8M samples, i.e. 0.5 %); a stretched 3000x2000 crop has only 375k samples and failed at 12k (3.3 %),
      // which stalled the run. Use the FRACTION of samples (same 0.5 % at full frame).
      const nzFrac = result.sampled_pixel_count > 0 ? result.nonzero_pixel_count / result.sampled_pixel_count : null;
      const isUnstretched = (stats.median < 0.001) && (result.max_value > 0.1) &&
        (nzFrac != null ? nzFrac < 0.005 : result.nonzero_pixel_count < 20000); // linear star layers have very few detectable pixels

      // Store result in brief for star_protected_blend precondition check
      if (brief) {
        if (!brief._starIntegrity) brief._starIntegrity = {};
        brief._starIntegrity[input.view_id] = {
          verdict: result.verdict,
          pass: result.pass,
          max_value: result.max_value,
          median: stats.median,
          nonzero_pixel_count: result.nonzero_pixel_count,
          unstretched: isUnstretched,
          seq: brief._budget?.turnsUsed || 0,
          turnsAgo: 0,
        };
      }

      let guidance = '';
      if (result.verdict === 'FAIL') {
        guidance = '\n\nFIX REQUIRED before star blend:\n' +
          '  Apply soft rolloff to star layer: run_pixelmath with expression:\n' +
          '    "iif($T > 0.65, 0.65 + ($T - 0.65) * 0.46, $T)" (compresses 0.65-1.0 → 0.65-0.81)\n' +
          '  Or simpler: "min($T, 0.95)" then re-check.\n' +
          '  Then call check_star_layer_integrity again to verify.';
      }
      if (isUnstretched) {
        guidance += '\n\nWARNING: Star layer appears UNSTRETCHED (median=' + stats.median.toFixed(6) +
          '). Stars will be invisible after blend.\n' +
          '  You MUST call stretch_stars on this layer before blending.\n' +
          '  star_protected_blend will REFUSE an unstretched star layer.';
      }

      return {
        type: 'text',
        text: `[STAR INTEGRITY: ${result.verdict}${isUnstretched ? ' — UNSTRETCHED' : ''}] ${result.details}\n` +
          `  Max value: ${result.max_value?.toFixed(4) || 'N/A'} (limit: <0.98)\n` +
          `  Median: ${stats.median?.toFixed(6) || 'N/A'} ${isUnstretched ? '⚠️ NEAR ZERO — unstretched!' : ''}\n` +
          `  Clipped >0.98: ${((result.clipped_fraction_98 || 0) * 100).toFixed(2)}%\n` +
          `  Clipped >0.995: ${((result.clipped_fraction_995 || 0) * 100).toFixed(2)}%\n` +
          `  Color diversity: ${result.color_diversity?.toFixed(4) || 'N/A'} (min: 0.05)\n` +
          `  Bright star chroma: ${result.bright_star_chroma?.toFixed(4) || 'N/A'}\n` +
          `  Non-zero pixels: ${result.nonzero_pixel_count || 0}` +
          guidance
      };
    }
  },

  check_bright_chroma: {
    category: 'quality_gate',
    definition: {
      name: 'check_bright_chroma',
      description: 'Measures color differentiation in bright subject pixels. Detects chroma collapse (core washout) that burn scans miss. Run BEFORE and AFTER star blend — if median chroma drops significantly, the blend washed out the core. Fix with restore_star_color or re-blend with tighter parameters.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to check' },
          brightness_threshold: { type: 'number', description: 'Luminance above which to measure chroma (default 0.50)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await checkBrightChroma(ctx, input.view_id, input.brightness_threshold ?? 0.50);
      const warn = result.medianChroma < 0.05 && result.brightPixelCount > 100;
      return {
        type: 'text',
        text: `[BRIGHT CHROMA${warn ? ' — WARNING: CHROMA COLLAPSE' : ''}] ${result.details}` +
          (warn ? '\n  Bright areas have near-zero color differentiation — core is visually washed out.' +
            '\n  Fix: use restore_star_color with the pre-star reference, or re-blend with tighter core protection.' : '')
      };
    }
  },

  measure_subject_detail: {
    category: 'measurement',
    definition: {
      name: 'measure_subject_detail',
      description: 'Measure subject brightness, detail and contrast ratio. HARD GATES: subjectBrightness >= 0.25 (goal: >0.35), detailScore (= detailRaw) >= 0.001, contrastRatio >= 3x (goal: >5x). finish WILL REJECT if a hard gate fails. Detail is sampled over ALL subject blocks with star windows rejected; detailCredible = detail above the image\'s own noise floor (the number to optimise), detailWeber = brightness-normalised detail (used for gain vs the prep baseline), noiseDominated = detailRaw/detailCredible > 2.5 (grain, not structure). detailCredible should rise modestly over the prep baseline (profile detail.max_gain is an ADVISORY ceiling); more is not better once noiseDominated.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to measure' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await measureSubjectDetail(ctx, input.view_id, { profile: brief?.processingProfile, faintStructureGoal: brief?.target?.fieldCharacteristics?.faintStructureGoal });
      return {
        type: 'text',
        text: `[SUBJECT METRICS] ${result.details}\n` +
          `  Brightness: ${result.subjectBrightness?.toFixed(4) || 'N/A'} (HARD GATE: 0.25, goal: >0.35)\n` +
          `  Detail score (raw): ${result.detailScore?.toFixed(6) || 'N/A'} (HARD GATE: 0.001, goal: >0.005)\n` +
          `  detailCredible: ${result.detailCredible?.toFixed(6) ?? 'N/A'} | detailWeber: ${result.detailWeber?.toExponential(3) ?? 'N/A'} | noiseDominated: ${result.noiseDominated ? 'YES (raw/credible > 2.5)' : 'no'}\n` +
          detailBaselineLine(brief, result) +
          `  Contrast ratio: ${result.contrastRatio?.toFixed(1) || 'N/A'}× (HARD GATE: 3×, goal: >5×)\n` +
          `  Subject regions: ${result.subjectCount || 0} / Background median: ${result.backgroundMedian?.toFixed(4) || 'N/A'}`
      };
    }
  },

  check_core_contrast: {
    category: 'measurement',
    definition: {
      name: 'check_core_contrast',
      description: 'Measure RELATIVE local contrast in the BRIGHT CORE vs the surrounding shell — catches a PERCEPTUAL burn that the clipping gates miss: a bright core that is NOT clipped (peak < 0.85) but reads as a flat washed-out white blob because its structure is tiny relative to its brightness. HARD GATE (finish WILL REJECT for extended-core targets): coreRelContrast >= 0.22 (goal: >0.30). relContrast = mean|local gradient| / mean luminance, in the brightest ~top-40%-of-dynamic-range region. If it fails, recover local contrast in the center (HDRMT/LHE reaching the core — shrink the donut hole — and/or compress the core pedestal with continuous_clamp so existing structure shows). Use after core/HDR/curve steps to verify the bright center is not flat.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to measure' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const cb = brief?.processingProfile?.core_burn || {};
      const relHard = (typeof cb.rel_contrast_hard === 'number') ? cb.rel_contrast_hard : 0.22;
      const whiteHard = (typeof cb.white_hard === 'number') ? cb.white_hard : 0.15;
      const result = await measureCoreContrast(ctx, input.view_id, brief?.target?.classification, cb);
      return {
        type: 'text',
        text: `[CORE CONTRAST] ${result.details}\n` +
          `  Core relContrast: ${result.coreRelContrast?.toFixed(3) ?? 'N/A'} (HARD GATE: ${relHard} unless the core is structured [struct>=80% & halo<=3% & not white-burnt] -> advisory; goal: >0.30)\n` +
          `  Core white-clipped fraction: ${((result.coreWhiteFraction ?? 0)*100).toFixed(1)}% (HARD GATE: <${(whiteHard*100).toFixed(0)}%) | core saturation: ${typeof result.coreSat==='number' && result.coreSat>=0 ? result.coreSat.toFixed(3)+' (min 0.10)' : 'n/a (mono)'}\n` +
          `  Shell relContrast: ${result.shellRelContrast?.toFixed(3) ?? 'N/A'} | core/shell ratio: ${(result.ratio ?? 0).toFixed(2)} (diagnostic)\n` +
          `  Core mean lum: ${result.coreLum?.toFixed(3) ?? 'N/A'} | core fraction: ${((result.coreFraction ?? 0)*100).toFixed(2)}%\n` +
          (result.relAdvisory ? `  ADVISORY: relContrast ${result.coreRelContrast?.toFixed(3)} < ${relHard} but the core is structured (struct ${((result.coreStructFrac ?? 0)*100).toFixed(0)}% >= ${((typeof cb.min_struct_frac === 'number' ? cb.min_struct_frac : 0.80)*100).toFixed(0)}%, halo ${((result.haloFrac ?? 0)*100).toFixed(1)}% <= ${((typeof cb.max_halo_frac === 'number' ? cb.max_halo_frac : 0.03)*100).toFixed(0)}%, not white-burnt) -> warning only\n` : '') +
          `  ${result.pass ? 'PASS' : 'FAIL — bright core is perceptually flat/white-burnt/desaturated'}`
      };
    }
  },

  measure_psf_field: {
    category: 'measurement',
    definition: {
      name: 'measure_psf_field',
      description: 'Field-dependent PSF map on a LINEAR view (read-only). HEAVY: a script-side pixel scan; above 30 MP it runs with stride 2 and is never run automatically by prep (a full scan aborted PixInsight on a 60 MP channel). Call it at most once per run on large frames. Reports: per grid cell star count, median FWHM, ellipticity, orientation relative to the radial direction (0 = radial elongation) and radial skew. Reports best/worst cell, centre FWHM, left/right and top/bottom asymmetry ratios, a verdict (uniform | radial coma | asymmetric — check tilt/backfocus when a ratio >= 1.5) and a suggested crop_box (largest rectangle of contiguous cells with FWHM <= 1.5x best and ellipticity <= 0.3). The crop_box is advice for the USER\'s crop of the stack; NEVER crop the starless deliverable. Uses one temporary 2x-binned window (closed afterwards). Not a gate. Result cached in brief._psf[view_id]. Prep already records the before/after-BXT maps (see the prep summary).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'LINEAR view ID (mono or colour; colour uses the G channel)' },
          cols: { type: 'integer', description: 'Grid columns (default 8)' },
          rows: { type: 'integer', description: 'Grid rows (default 6)' },
          max_stars: { type: 'integer', description: 'Maximum stars measured (default 1500)' },
          sat_limit: { type: 'number', description: 'Reject stars whose peak exceeds this (default 0.45)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const res = await measurePsfField(ctx, input.view_id, { cols: input.cols, rows: input.rows, maxStars: input.max_stars, satLimit: input.sat_limit });
      if (!res.ok) return { type: 'text', text: `[PSF FIELD: unavailable] ${res.error || res.verdict || 'no result'} ${res.details || ''}` };
      if (brief) { brief._psf = brief._psf || {}; brief._psf[input.view_id] = res; }
      const grid = res.cells.map(row => row.map(c => c.n ? c.fwhm_med.toFixed(1) : ' - ').join(' ')).join('\n    ');
      return { type: 'text', text: `[PSF FIELD: ${res.verdict}] ${res.details}\n  FWHM per cell (px):\n    ${grid}\n  ${JSON.stringify({ crop_box: res.crop_box, nStars: res.nStars })}` };
    }
  },

  measure_chroma_noise: {
    category: 'measurement',
    definition: {
      name: 'measure_chroma_noise',
      description: 'Measure CHROMA noise and colour MOTTLE in the background (the surface a lift_dust / lift_faint_halo / inject_l_ifn amplifies). Same 6x6 patch grid as check_noise (darkest 12 = clean sky, next 12 = dust band). Reports chromaNoise (1.4826*MAD of Ca=R-L, Cb=B-L minus the mean of 4 distance-2 neighbours), chromaToLumNoise, and mottle16/mottle48 (the same on 16 px and 48 px box means; large-scale blotchiness that survives NXT). ADVISORY: no pass/fail unless the profile sets noise.max_chroma_to_lum / noise.max_mottle48. Remedy: chroma_smooth sigma 6-8 through the halo/dust mask, or reduce lift/inject strength upstream; never global desaturation. Colour images only.',
      input_schema: { type: 'object', properties: { view_id: { type: 'string', description: 'Colour view ID to measure' } }, required: ['view_id'] }
    },
    handler: async (ctx, _store, brief, input) => {
      const r = await measureChromaNoise(ctx, input.view_id, { profile: brief?.processingProfile });
      if (r.error) return { type: 'text', text: `[CHROMA NOISE: unavailable] ${r.error}` };
      const b = (x) => x && x.n ? `chroma=${x.chromaNoise.toFixed(5)} lum=${x.lumNoise.toFixed(5)} mottle16=${x.mottle16.toFixed(5)} mottle48=${x.mottle48.toFixed(5)}` : 'n/a';
      return {
        type: 'text',
        text: `[CHROMA NOISE${r.pass ? '' : ': ADVISORY'}] ${r.details}\n  clean sky band: ${b(r.clean)}\n  dust band: ${b(r.dust)}\n` +
          `  Remedy if high: chroma_smooth sigma 6-8 through the halo/dust mask, or reduce lift/inject strength upstream; never global desaturation.`
      };
    }
  },

  check_background_floor: {
    category: 'quality',
    definition: {
      name: 'check_background_floor',
      description: 'Measure the SKY LEVEL and the fraction of background blocks crushed to black (<0.015). FINISH GATE (blocking where the profile has calibrated background.min_level / max_black_fraction): a background crushed to near-black loses faint IFN/halo/star signal and reads as a cut-out. If low, lift the shadows upstream (curves point just above the sky level, gentler black point in the last stretch/clamp/rolloff) rather than brightening the subject. Use on STRETCHED images, as a final evaluation.',
      input_schema: { type: 'object', properties: { view_id: { type: 'string', description: 'View ID (stretched)' } }, required: ['view_id'] }
    },
    handler: async (ctx, _store, brief, input) => {
      const bf = await measureBackgroundFloor(ctx, input.view_id);
      const profile = brief?.processingProfile || {};
      const minLevel = gateThreshold(profile, 'background.min_level', null);
      const maxBlack = gateThreshold(profile, 'background.max_black_fraction', null);
      const bad = (minLevel != null && bf.bgLevel < minLevel) || (maxBlack != null && bf.blackBlockFraction > maxBlack);
      const limits = `${minLevel != null ? `floor ${minLevel}` : 'floor uncalibrated'}, ${maxBlack != null ? `max black ${(maxBlack * 100).toFixed(0)}%` : 'max black uncalibrated'}`;
      return { type: 'text', text: `[BACKGROUND FLOOR: ${bad ? '*** FAILS GATE ***' : (minLevel != null || maxBlack != null ? 'PASS' : 'advisory')}] ${bf.details} (${limits}).` };
    }
  },

  check_noise: {
    category: 'measurement',
    definition: {
      name: 'check_noise',
      description: 'Measure background high-frequency (pixel-scale) GRAIN — the noise that aggressive LHE/stretching amplifies. HARD GATE (finish WILL REJECT): bgNoise <= 0.022 (goal <= 0.015). Estimated as MAD of (pixel - mean of dist-2 neighbors) over the cleanest background patches. If it fails, apply ONE light NoiseXTerminator pass (denoise 0.20-0.30) — just enough to smooth grain without over-smoothing (the core-contrast gate still needs resolved detail). Use as a FINAL evaluation before finish.',
      input_schema: { type: 'object', properties: { view_id: { type: 'string', description: 'View ID to measure' } }, required: ['view_id'] }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await measureBackgroundNoise(ctx, input.view_id, { profile: brief?.processingProfile });
      return {
        type: 'text',
        text: `[NOISE] ${result.details}\n  bgNoise (dark sky): ${result.bgNoise?.toFixed(4) ?? 'N/A'} (HARD GATE: 0.022) | dustNoise (lifted dust grain): ${result.dustNoise?.toFixed(4) ?? 'N/A'} (HARD GATE: 0.040)\n  ${result.pass ? 'PASS' : 'FAIL — apply a final NXT pass (denoise ~0.30, detail 0.10) AFTER lift_dust'}`
      };
    }
  },

  measure_dust_coverage: {
    category: 'measurement',
    definition: {
      name: 'measure_dust_coverage',
      description: 'Measure faint brown-IFN / DUST presence in the FIELD (everything below the bright core). Distinguishes a frame FILLED with dust from an EMPTY black field even when their medians are IDENTICAL — the median is blind to dust distribution. Reports dustCoverage (fraction of field that is faint dust), warmDustFraction (brown lean), dustMeanSat (dust color richness) and fieldP90/P95 (dust peak brightness). HARD GATE for reflection/dusty profiles (finish WILL REJECT): fails when the dust is BOTH greyed (dustMeanSat < min) AND crushed (fieldP95 < min). If it fails, use lift_dust (NOT a global additive lift). Calibrated on NGC 7023 iter03 (good) vs giga (bad).',
      input_schema: { type: 'object', properties: { view_id: { type: 'string', description: 'View ID to measure' } }, required: ['view_id'] }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await measureDustCoverage(ctx, input.view_id, brief?.processingProfile?.ifn);
      return {
        type: 'text',
        text: `[DUST/IFN] ${result.details}\n` +
          `  dustCoverage: ${((result.dustCoverage ?? 0)*100).toFixed(1)}% of field | warmDustFraction: ${((result.warmDustFraction ?? 0)*100).toFixed(1)}%\n` +
          `  dustMeanSat: ${(result.dustMeanSat ?? 0).toFixed(3)} | fieldP90: ${(result.fieldP90 ?? 0).toFixed(3)} | fieldP95: ${(result.fieldP95 ?? 0).toFixed(3)}\n` +
          `  ${result.pass ? 'PASS' : 'FAIL — dust greyed AND crushed; use lift_dust (selective), not a global lift'}`
      };
    }
  },

  lift_dust: {
    category: 'detail',
    definition: {
      name: 'lift_dust',
      description: 'SELECTIVE brown-IFN / dust recovery for reflection nebulae and dusty fields. Pass 1 is a hue-preserving brightness+contrast lift of the faint DUST band (just above background, below the core); pass 2 boosts its warm saturation (chroma expansion in the dust band only). Brightens the dust WITHOUT raising the background noise floor or touching the bright core. This is how you make the brown LDN-type dust fill the frame. CRITICAL: do NOT use a global additive lift ($T + k*(1-$T)) for this — it greys the whole field uniformly and FAILS the IFN/dust gate. Run measure_dust_coverage before and after to confirm dustMeanSat and fieldP95 rose. Params: lift_amount (0.3-0.9 dust brightness/contrast gain), sat_boost (0.2-0.6 dust warm color), core_taper_low/high (luminance band where the lift tapers off to protect the bright core).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to operate on' },
          lift_amount: { type: 'number', description: 'Dust brightness/contrast gain (default 0.6, range 0.3-1.2)' },
          sat_boost: { type: 'number', description: 'Dust warm-saturation boost (default 0.4, range 0-1)' },
          core_taper_low: { type: 'number', description: 'Luminance where lift begins tapering off (default 0.30)' },
          core_taper_high: { type: 'number', description: 'Luminance where lift is fully off, protecting the core (default 0.50)' },
          mask_view_id: { type: 'string', description: 'OPTIONAL outer-field mask (mono, same geometry): 1 = lift dust here, 0 = protect (the nebula). Confines the lift spatially so it never brightens/flattens the core. Build via create_luminance_mask(...) then mask_ops(invert=true, dilate_px, blur_sigma), or create_zone_masks(halo).' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const amt = Math.max(0, Math.min(1.2, input.lift_amount ?? 0.6));
      const satk = Math.max(0, Math.min(1.0, input.sat_boost ?? 0.4));
      const cLo = input.core_taper_low ?? 0.30;
      const cHi = input.core_taper_high ?? 0.50;
      const mv = input.mask_view_id;
      const maskMul = mv ? ` * ${mv}[0]` : '';   // optional outer-field mask: confine the lift spatially, protect the nebula
      const code = `
        var w = ImageWindow.windowById('${input.view_id}');
        if (w.isNull) throw new Error('lift_dust: view not found: ${input.view_id}');
        if (!w.mainView.image.isColor) throw new Error('lift_dust: requires a color image');
        ${mv ? `var mw=ImageWindow.windowById('${mv}'); if(mw.isNull) throw new Error('lift_dust: mask ${mv} not found'); if(mw.mainView.image.width!==w.mainView.image.width||mw.mainView.image.height!==w.mainView.image.height) throw new Error('lift_dust: mask geometry mismatch');` : ''}
        var bg = w.mainView.image.median();
        // Pass 1: hue-preserving dust-band brightness+contrast gain. Anchored at the
        // background median (factor=1 at L=bg) so the noise floor is NOT lifted; gain
        // tapers to 1 above core_taper_high so the bright core is untouched.
        // PixelMath: definitions are statements in the EXPRESSION (semicolon-separated,
        // last statement is the output); P.symbols lists the NAMES; conditionals use iif().
        var P = new PixelMath;
        P.expression = [
          'L = 0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2]',
          'mask = (1 - max(0, min(1, (L - ${cLo})/(${cHi} - ${cLo}))))${maskMul}',
          'Lp = ' + bg + ' + (L - ' + bg + ')*(1 + ${amt}*mask)',
          'factor = iif(L > 0.0008, Lp/L, 1)',
          '$T * factor'
        ].join('; ');
        P.symbols = 'L, mask, Lp, factor';
        P.useSingleExpression = true;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(w.mainView);
        // Pass 2: warm dust saturation boost (chroma expansion, peaks in the dust band)
        var bg2 = w.mainView.image.median();
        var P2 = new PixelMath;
        P2.expression = [
          'L = 0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2]',
          'lo = ' + bg2 + '*1.05',
          // ramp reaches full just above background (lo + bg*0.55 ~= bg*1.6) so the
          // FAINT dust band (L ~ bg*1.3..0.3) is fully covered, not the mid-tones.
          'up = max(0, min(1, (L - lo)/(' + bg2 + '*0.55)))',
          'down = 1 - max(0, min(1, (L - ${cLo})/(${cHi} - ${cLo})))',
          'dmask = up*down${maskMul}',
          'L + (1 + ${satk}*dmask)*($T - L)'
        ].join('; ');
        P2.symbols = 'L, lo, up, down, dmask';
        P2.useSingleExpression = true;
        P2.use64BitWorkingImage = true;
        P2.truncate = true; P2.truncateLower = 0; P2.truncateUpper = 1;
        P2.createNewImage = false;
        P2.executeOn(w.mainView);
        var s = w.mainView.image;
        JSON.stringify({ median: s.median(), max: s.maximum() });
      `;
      const r = await ctx.pjsr(code);
      if (r.status === 'error') return { type: 'text', text: `lift_dust FAILED: ${r.error?.message || r.result}` };
      let st = {}; try { st = JSON.parse(r.result || '{}'); } catch {}
      return { type: 'text', text: `lift_dust applied (lift=${amt}, sat=${satk}, taper ${cLo}-${cHi}). New median=${(st.median ?? 0).toFixed(4)}, max=${(st.max ?? 0).toFixed(4)}. Re-run measure_dust_coverage to confirm dustMeanSat/fieldP95 rose.` };
    }
  },

  inject_l_ifn: {
    category: 'detail',
    definition: {
      name: 'inject_l_ifn',
      description: 'Inject the faint IFN/DUST STRUCTURE from the deep L channel into the combined RGB luminance, so the frame-filling dust that lives in L (the longest exposure) actually reaches the final. For reflection/dust targets where the IFN is in L but the shallower per-channel RGB barely shows it (lrgb_combine LinearFits L down and loses it). Adds L\'s above-background dust signal to the combined luminance through a FIELD mask (hue-preserving, tapered off in the bright core), then gently WARM-TINTS the injected dust so it reads brown. CORE PROTECTION: by default the injection tapers off above core_taper_low luminance; for a structured bright nebula whose mid-brightness parts overlap the dust luminance, ALSO pass mask_view_id = an OUTER-FIELD mask (an inverted, dilated bright-nebula/luminance mask: 1 in the dusty outskirts, 0 over the nebula) so the dust fills AROUND the nebula and never flattens its blue core. This is the lever for "brown dust filling the frame WITHOUT washing the center". Run measure_dust_coverage before and after. Params: l_view_id (default FILTER_L), strength (0.2-0.7), warm (0-0.3), core_taper_low/high, mask_view_id (optional outer-field mask).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Combined RGB target view to inject into' },
          l_view_id: { type: 'string', description: 'L source view (default FILTER_L). Must match target geometry.' },
          strength: { type: 'number', description: 'Injection strength (default 0.4, range 0.2-0.7)' },
          warm: { type: 'number', description: 'Warm-tint amount on injected dust (default 0.12, range 0-0.3)' },
          core_taper_low: { type: 'number', description: 'Luminance where injection begins tapering off (default 0.22 — protects the bright nebula)' },
          core_taper_high: { type: 'number', description: 'Luminance where injection is fully off (default 0.38)' },
          mask_view_id: { type: 'string', description: 'OPTIONAL outer-field mask (mono, same geometry): 1 = fill dust here, 0 = protect (the nebula). Multiplies the luminance taper for hard spatial core protection. Build via create_luminance_mask(...) then mask_ops(invert=true, dilate_px, blur_sigma), or create_zone_masks(halo).' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const lView = input.l_view_id || 'FILTER_L';
      const mv = input.mask_view_id;
      const str = Math.max(0, Math.min(1.0, input.strength ?? 0.4));
      const warm = Math.max(0, Math.min(0.4, input.warm ?? 0.12));
      const cLo = input.core_taper_low ?? 0.22;
      const cHi = input.core_taper_high ?? 0.38;
      // Guard: target color, L view present + same geometry (and mask if provided). Return L background median.
      const g = await ctx.pjsr(`
        var t=ImageWindow.windowById('${input.view_id}'); var l=ImageWindow.windowById('${lView}');
        if(t.isNull) 'ERR:target ${input.view_id} missing';
        else if(l.isNull) 'ERR:L view ${lView} missing';
        else if(!t.mainView.image.isColor) 'ERR:target is not a color image';
        else { var ti=t.mainView.image, li=l.mainView.image;
          if(ti.width!==li.width || ti.height!==li.height) 'ERR:geometry mismatch '+ti.width+'x'+ti.height+' vs '+li.width+'x'+li.height;
          ${mv ? `else { var mw=ImageWindow.windowById('${mv}'); if(mw.isNull) 'ERR:mask ${mv} missing'; else if(mw.mainView.image.width!==ti.width||mw.mainView.image.height!==ti.height) 'ERR:mask geometry mismatch'; else 'OK:'+li.median(); }` : `else 'OK:'+li.median();`} }
      `);
      const gv = (g.result || g.outputs?.consoleOutput || '').trim();
      if (gv.indexOf('ERR:') === 0) return { type: 'text', text: `inject_l_ifn FAILED: ${gv.slice(4)}` };
      const Lbg = parseFloat(gv.split(':')[1]) || 0;
      const maskMul = mv ? ` * ${mv}[0]` : '';   // spatial core protection (outer-field mask)
      // Shared symbol chain (definitions live in the expression per PixelMath; symbols lists names)
      const chain = `Lc = 0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2]; Ld = max(0, ${lView}[0] - ${Lbg}); mask = (1 - max(0, min(1, (Lc - ${cLo})/(${cHi} - ${cLo}))))${maskMul}`;
      const code = `
        var w=ImageWindow.windowById('${input.view_id}');
        // Pass 1: hue-preserving luminance injection of L's faint dust structure into the field
        var P=new PixelMath;
        P.expression='${chain}; Lnew = Lc + ${str}*mask*Ld; factor = iif(Lc > 0.0008, Lnew/Lc, 1); $T * factor';
        P.symbols='Lc, Ld, mask, Lnew, factor';
        P.useSingleExpression=true; P.use64BitWorkingImage=true;
        P.truncate=true; P.truncateLower=0; P.truncateUpper=1; P.createNewImage=false;
        P.executeOn(w.mainView);
        // Pass 2: warm tint on the injected dust (per-channel, ADDITIVE so it tints
        // faint/dark dust toward brown — multiplicative does nothing to near-black dust).
        // tint scales with injected L dust amount; the field mask keeps the bright blue
        // core untouched. Brown = R up, G up less, B down.
        var Q=new PixelMath;
        Q.expression='${chain}; tint = ${warm}*mask*min(1, Ld*3); $T + tint';
        Q.expression1='${chain}; tint = ${warm}*mask*min(1, Ld*3); $T + 0.35*tint';
        Q.expression2='${chain}; tint = ${warm}*mask*min(1, Ld*3); $T - 0.45*tint';
        Q.symbols='Lc, Ld, mask, tint';
        Q.useSingleExpression=false; Q.use64BitWorkingImage=true;
        Q.truncate=true; Q.truncateLower=0; Q.truncateUpper=1; Q.createNewImage=false;
        Q.executeOn(w.mainView);
        var s=w.mainView.image; JSON.stringify({median:s.median(), max:s.maximum()});
      `;
      const r = await ctx.pjsr(code);
      if (r.status === 'error') return { type: 'text', text: `inject_l_ifn FAILED: ${r.error?.message || r.result}` };
      let st = {}; try { st = JSON.parse(r.result || '{}'); } catch {}
      recordLUsage(brief, 'inject_l_ifn', input.view_id);
      return { type: 'text', text: `inject_l_ifn applied (from ${lView}, strength=${str}, warm=${warm}, Lbg=${Lbg.toFixed(4)}). New median=${(st.median ?? 0).toFixed(4)}, max=${(st.max ?? 0).toFixed(4)}. Re-run measure_dust_coverage — dustCoverage/fieldP95 should rise.` };
    }
  },

  multi_scale_enhance: {
    category: 'detail',
    definition: {
      name: 'multi_scale_enhance',
      description: 'COMPOUND TOOL: applies 3-scale masked LHE + optional HDRMT in ONE call with before/after metrics. Much faster than individual LHE calls. Returns detail score improvement %. Use this INSTEAD of individual run_lhe calls for detail enhancement. Call multiple times with different params to bracket. If improvement < 5%, adjust mask (softer clipLow) or increase amounts.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to enhance' },
          mask_clip_low: { type: 'number', description: 'Mask clip low (0.04=soft/faint structure, 0.10=medium, 0.15=tight). Default 0.06' },
          mask_blur: { type: 'number', description: 'Mask blur sigma (3-10). Default 5' },
          mask_gamma: { type: 'number', description: 'Mask gamma (1.0-3.0, higher=protect brights more). Default 2.0' },
          lhe_fine_radius: { type: 'number', description: 'Fine LHE radius (16-32). Default 24' },
          lhe_fine_amount: { type: 'number', description: 'Fine LHE amount (0.10-0.40). Default 0.20' },
          lhe_mid_radius: { type: 'number', description: 'Mid LHE radius (35-64). Default 48' },
          lhe_mid_amount: { type: 'number', description: 'Mid LHE amount (0.15-0.50). Default 0.30' },
          lhe_large_radius: { type: 'number', description: 'Large LHE radius (80-150). Default 100' },
          lhe_large_amount: { type: 'number', description: 'Large LHE amount (0.20-0.50). Default 0.30' },
          lhe_slope_limit: { type: 'number', description: 'LHE slope limit (1.2-2.0). Default 1.5' },
          do_hdrmt: { type: 'boolean', description: 'Apply HDRMT after LHE. Default true' },
          hdrmt_layers: { type: 'number', description: 'HDRMT layers (4-7). Default 5' },
          hdrmt_median_transform: { type: 'boolean', description: 'Use median transform (prevents ringing in star fields). Default true' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      // POLICY BLOCK: emission nebulae must use shell_detail_enhance instead
      const classification = brief?.target?.classification || '';
      if (classification.includes('emission')) {
        return {
          type: 'text',
          text: `[BLOCKED] multi_scale_enhance is DISABLED for emission nebulae. ` +
            `LHE-driven brightness amplification causes destructive highlight compression on bright shells. ` +
            `Use shell_detail_enhance instead — it enhances texture without increasing peak brightness. ` +
            `Call: shell_detail_enhance(view_id="${input.view_id}", medium_amount=1.0, large_amount=0.5)`
        };
      }
      const result = await multiScaleEnhance(ctx, input.view_id, {
        maskClipLow: input.mask_clip_low,
        maskBlur: input.mask_blur,
        maskGamma: input.mask_gamma,
        lheFineRadius: input.lhe_fine_radius,
        lheFineAmount: input.lhe_fine_amount,
        lheMidRadius: input.lhe_mid_radius,
        lheMidAmount: input.lhe_mid_amount,
        lheLargeRadius: input.lhe_large_radius,
        lheLargeAmount: input.lhe_large_amount,
        lheSlopeLimit: input.lhe_slope_limit,
        doHDRMT: input.do_hdrmt,
        hdrmtLayers: input.hdrmt_layers,
        hdrmtMedianTransform: input.hdrmt_median_transform,
      });
      if (result.error) {
        return { type: 'text', text: `multi_scale_enhance FAILED: ${result.error}` };
      }
      return {
        type: 'text',
        text: `[MULTI-SCALE ENHANCE] ${result.details}\n` +
          `  Before: detail=${result.before.detailScore.toFixed(6)}, brightPx=${result.before.brightPixels}\n` +
          `  After:  detail=${result.after.detailScore.toFixed(6)}, brightPx=${result.after.brightPixels}\n` +
          `  Improvement: ${result.improvement > 0 ? '+' : ''}${result.improvement.toFixed(1)}%\n` +
          `  Params: LHE fine=${result.params.lhe.fine.r}/${result.params.lhe.fine.a} mid=${result.params.lhe.mid.r}/${result.params.lhe.mid.a} large=${result.params.lhe.large.r}/${result.params.lhe.large.a} | HDRMT=${result.params.hdrmt.applied ? result.params.hdrmt.layers + 'L' : 'off'}`
      };
    }
  },

  // --- Scoring (critics only) ---
  submit_scores: {
    category: 'scoring',
    hidden: true, visibleTo: ['aesthetic_critic','technical_critic'],
    definition: {
      name: 'submit_scores',
      description: 'Submit your quality assessment scores. Score each dimension 0-100. artifact_penalty: 0=clean, 100=severe artifacts.',
      input_schema: {
        type: 'object',
        properties: {
          detail_credibility: { type: 'number', description: 'Noise-free detail quality (0-100)' },
          background_quality: { type: 'number', description: 'Background smoothness and uniformity (0-100)' },
          color_naturalness: { type: 'number', description: 'Channel balance and color accuracy (0-100)' },
          star_integrity: { type: 'number', description: 'Star shape and rendering quality (0-100)' },
          tonal_balance: { type: 'number', description: 'Dynamic range utilization (0-100)' },
          subject_separation: { type: 'number', description: 'Subject vs background contrast (0-100)' },
          artifact_penalty: { type: 'number', description: 'Artifact severity (0=clean, 100=severe)' },
          aesthetic_coherence: { type: 'number', description: 'Overall visual harmony (0-100)' },
          verdict: { type: 'string', enum: ['accept', 'reject'], description: 'Accept or reject the image' },
          feedback: { type: 'string', description: 'Specific feedback for the doer agent (especially if rejecting)' }
        },
        required: ['detail_credibility', 'background_quality', 'color_naturalness', 'star_integrity',
          'tonal_balance', 'subject_separation', 'artifact_penalty', 'aesthetic_coherence', 'verdict']
      }
    },
    handler: async (_ctx, _store, _brief, input) => {
      // The orchestrator reads this from the finish result
      return { type: 'text', text: `Scores submitted. Verdict: ${input.verdict}` };
    }
  },

  // --- Highlight texture / shell-nebula tools ---

  check_highlight_texture: {
    category: 'quality_gate',
    definition: {
      name: 'check_highlight_texture',
      description: 'Detect perceptual burn — bright subject zones where internal tonal variation has collapsed into a featureless plateau. PRIMARY signal: relative texture retention vs a reference checkpoint (blocking). WITHOUT reference: advisory-only absolute heuristics. Clone BEFORE the operation, then call this AFTER with reference_id pointing to the clone.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Current image to assess' },
          reference_id: { type: 'string', description: 'Pre-operation clone/view for comparison. REQUIRED for blocking verdict. Without it, results are advisory only.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await checkHighlightTexture(ctx, input.view_id, {
        referenceId: input.reference_id,
        roi: brief?._roi
      });
      const status = result.pass ? (result.verdict === 'preserved' ? 'PASS' : 'ADVISORY') : 'FAIL';
      let text = `[HIGHLIGHT TEXTURE: ${status}] ${result.details}\n`;
      if (result.current) {
        text += `  Current: localStdDev=${result.current.shellLocalStdDev?.toFixed(4)}, tonalSpan=${result.current.shellTonalSpan?.toFixed(3)}, gradient=${result.current.shellGradientEnergy?.toFixed(6)}\n`;
      }
      if (result.reference) {
        text += `  Reference: localStdDev=${result.reference.shellLocalStdDev?.toFixed(4)}, tonalSpan=${result.reference.shellTonalSpan?.toFixed(3)}, gradient=${result.reference.shellGradientEnergy?.toFixed(6)}\n`;
        text += `  Retention: texture=${((result.textureRetention ?? 1) * 100).toFixed(0)}%, span=${((result.spanRetention ?? 1) * 100).toFixed(0)}%, gradient=${((result.gradientRetention ?? 1) * 100).toFixed(0)}%`;
      }
      if (!result.pass) {
        text += `\n  FIX: Restore pre-operation checkpoint. If after clamp: raise knee, increase headroom, or skip clamp. If after detail tool: reduce amount or switch to shell_detail_enhance. If after Ha: reduce strength or max_output. Do NOT clamp harder.`;
      }
      return { type: 'text', text };
    }
  },

  shell_detail_enhance: {
    category: 'detail',
    definition: {
      name: 'shell_detail_enhance',
      description: 'EMISSION SHELL DETAIL TOOL: Enhances texture/filament detail in bright emission shells WITHOUT increasing peak brightness. Uses multi-scale high-pass decomposition with soft protection factor — brightness-neutral by design, no subsequent clamping needed. Use this INSTEAD of multi_scale_enhance on bright emission shells (LHE pushes brightness, causing the clamp→flatten cycle). Returns before/after shell texture metrics.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View to enhance (modified in place)' },
          mask_id: { type: 'string', description: 'Shell zone mask ID (auto-created if omitted)' },
          medium_sigma: { type: 'number', description: 'Filament-scale blur sigma (default 18, range 10-30)' },
          medium_amount: { type: 'number', description: 'Filament boost strength (default 1.0, range 0.3-2.5)' },
          large_sigma: { type: 'number', description: 'Regional tonal gradient sigma (default 55, range 35-80)' },
          large_amount: { type: 'number', description: 'Regional boost strength (default 0.5, range 0.0-1.5)' },
          protect_knee: { type: 'number', description: 'Luminance above which enhancement attenuates (default 0.80)' },
          protect_softness: { type: 'number', description: 'Attenuation rate — higher=steeper rolloff (default 4.0)' },
          auto_zone: { type: 'boolean', description: 'Auto-create adaptive shell zone mask (default true)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await shellDetailEnhance(ctx, input.view_id, {
        maskId: input.mask_id,
        mediumSigma: input.medium_sigma,
        mediumAmount: input.medium_amount,
        largeSigma: input.large_sigma,
        largeAmount: input.large_amount,
        protectKnee: input.protect_knee,
        protectSoftness: input.protect_softness,
        autoZone: input.auto_zone,
        roi: brief?._roi
      });
      if (result.error) return { type: 'text', text: `shell_detail_enhance error: ${result.error}` };
      return {
        type: 'text',
        text: `[SHELL DETAIL ENHANCE] ${result.details}\n` +
          `  Before: gradient=${result.before?.gradientEnergy?.toFixed(6)}, localStdDev=${result.before?.shellLocalStdDev?.toFixed(4)}\n` +
          `  After:  gradient=${result.after?.gradientEnergy?.toFixed(6)}, localStdDev=${result.after?.shellLocalStdDev?.toFixed(4)}\n` +
          `  Improvement: gradient=${result.improvement?.toFixed(1)}%, stddev=${result.stddevImprovement?.toFixed(1)}%\n` +
          `  Max after: ${result.maxAfter?.toFixed(4)}, protection engaged: ${result.protectionEngaged}\n` +
          `  Params: medium=${result.params?.mediumSigma}/${result.params?.mediumAmount} large=${result.params?.largeSigma}/${result.params?.largeAmount} knee=${result.params?.protectKnee}`
      };
    }
  },

  create_adaptive_zone_masks: {
    category: 'masks',
    definition: {
      name: 'create_adaptive_zone_masks',
      description: 'Create ROI-anchored adaptive zone masks from actual image statistics. Unlike fixed-threshold zone masks, these adapt to the stretch level and subject brightness. Creates 3 soft masks: hot_core (top ~10%), bright_shell (P25-P90), outer_nebula (background-P25). Best for shell emission nebulae where zones need independent processing.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Source view for zone computation' },
          core_bias: { type: 'number', description: 'Shift core threshold: 0=wider core, 1=tighter core (default 0.5)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await createAdaptiveZoneMasks(ctx, input.view_id, {
        roi: brief?._roi,
        coreBias: input.core_bias
      });
      return {
        type: 'text',
        text: `Adaptive zone masks created:\n` +
          `  Core: ${result.coreId} (${result.pixelCounts?.core} px, threshold=${result.thresholds?.core?.toFixed(3)})\n` +
          `  Shell: ${result.shellId} (${result.pixelCounts?.shell} px, range=${result.thresholds?.shellLow?.toFixed(3)}–${result.thresholds?.core?.toFixed(3)})\n` +
          `  Outer: ${result.outerId} (${result.pixelCounts?.outer} px, threshold=${result.thresholds?.outer?.toFixed(3)})\n` +
          `  ROI: center=(${result.roi?.cx},${result.roi?.cy}), radius=${result.roi?.radius}`
      };
    }
  }
};

// ============================================================================
// Tool set builder — agents get different subsets
// ============================================================================

export const AGENT_TOOL_CATEGORIES = {
  // Mega-agent: everything except 'readiness' (no reopening 60 MP masters; recovery via load_variant)
  // and the critic-only 'scoring' category.
  giga_orchestrator: ['calibration', 'star_removal', 'measurement', 'preview', 'image_mgmt', 'gradient', 'denoise', 'sharpen', 'stretch', 'masks', 'detail', 'curves', 'lrgb', 'ha_injection', 'stars', 'narrowband', 'artifacts', 'memory', 'control', 'quality_gate'],
  readiness: ['measurement', 'readiness', 'image_mgmt', 'memory', 'control'],
  rgb_cleanliness: ['measurement', 'preview', 'image_mgmt', 'gradient', 'denoise', 'sharpen', 'stretch', 'calibration', 'star_removal', 'memory', 'artifacts', 'control'],
  luminance_detail: ['measurement', 'preview', 'image_mgmt', 'detail', 'masks', 'denoise', 'sharpen', 'stretch', 'gradient', 'calibration', 'readiness', 'star_removal', 'memory', 'artifacts', 'control'],
  star_policy: ['measurement', 'preview', 'image_mgmt', 'star_removal', 'stretch', 'curves', 'memory', 'artifacts', 'control'],
  ha_integration: ['measurement', 'preview', 'image_mgmt', 'gradient', 'denoise', 'sharpen', 'stretch', 'masks', 'ha_injection', 'narrowband', 'star_removal', 'memory', 'artifacts', 'control'],
  composition: ['measurement', 'preview', 'image_mgmt', 'curves', 'stars', 'lrgb', 'narrowband', 'masks', 'memory', 'artifacts', 'control'],
  aesthetic_critic: ['measurement', 'memory', 'control', 'scoring'],
  technical_critic: ['measurement', 'memory', 'control', 'scoring'],
  // Focused gradient sub-agent: flattens the background color gradient on the
  // LINEAR combined RGB (+ L) before SPCC/stretch. No 'control' (cannot finish/
  // export) and no 'stretch' (stays linear) — it just corrects and hands off.
  gradient_agent: ['measurement', 'preview', 'image_mgmt', 'gradient', 'memory'],
  // Focused core specialist (C-tier): improves ONLY the bright core of a finished
  // image (structure, no flat blob / no halo) through a core mask. Detail/clamp/zone
  // tools + masks + measurement + recall_champion/save_variant. No 'control' (cannot
  // finish/export), no 'stars' (no double star blend — the composer grafts only the
  // core back), no 'gradient'/'lrgb'/'ha' (not its job).
  core_specialist: ['measurement', 'preview', 'image_mgmt', 'detail', 'masks', 'narrowband', 'curves', 'stretch', 'denoise', 'memory', 'artifacts', 'quality_gate'],
};

/**
 * Build the tool set for an agent.
 * @param {string} agentName - Agent identifier (determines which tool categories are available)
 * @param {string[]} extraCategories - Additional categories to include
 * @returns {{ definitions: Array, handlers: Map }}
 */
// Tools withheld from a specific agent even when its category is allowed.
export const AGENT_TOOL_EXCLUDES = {
  gradient_agent: new Set(['run_scnr']),
  // core_specialist gets the quality_gate category for check_ringing / scan_burnt_regions /
  // check_highlight_texture, but not the whole-image or star-layer gates (no star tools by design).
  core_specialist: new Set(['run_quality_gates', 'check_star_quality', 'check_star_layer_integrity', 'check_tonal_presence', 'stage_checkpoint']),
};

// Automatic stage checkpoints (2026-11-08): the M74 v6 agent never called stage_checkpoint (0 calls), so the
// staged order gave no early feedback. When the main agent first uses a tool of a LATER stage on the working
// image, the pipeline measures every earlier stage not yet recorded — on the image as it is just before that
// operation — records it (drift attribution at finish) and appends the report to the tool result.
const TOOL_STAGE = {
  run_lhe: 'local_contrast', run_hdrmt: 'local_contrast', multi_scale_enhance: 'local_contrast', shell_detail_enhance: 'local_contrast',
  run_nxt: 'detail_noise',
  chroma_smooth: 'colour', run_scnr: 'colour',
  star_screen_blend: 'stars', star_protected_blend: 'stars',
};
const STAGE_ORDER = ['tone', 'local_contrast', 'detail_noise', 'colour', 'stars'];
function STAGE_OF_TOOL(name) { return TOOL_STAGE[name] || (name === 'run_curves' ? 'colour?' : null); }
async function isWorkingImage(ctx, brief, viewId) {
  if (!viewId || /mask|star|_M$|__/i.test(viewId) || !brief?._inventory?.zones) return false;
  const r = await ctx.pjsr(`var w = ImageWindow.windowById('${viewId}'); if (w.isNull) 'null'; else { var i = w.mainView.image; JSON.stringify({ c: i.isColor, w: i.width, h: i.height, m: i.median() }); }`);
  const o = (() => { try { return JSON.parse(r.outputs?.consoleOutput?.trim() || 'null'); } catch { return null; } })();
  if (!o || !o.c) return false;
  const [cx, cy] = brief._inventory.centre || [0, 0];
  return o.m > 0.03 && o.m < 0.35 && o.w > 1.6 * cx && o.h > 1.6 * cy;
}
function withAutoCheckpoint(name, handler) {
  return async (ctx, store, brief, input, agentName) => {
    let note = '';
    try {
      let st = STAGE_OF_TOOL(name);
      if (st === 'colour?') st = input?.channel === 'S' ? 'colour' : null;
      const k = STAGE_ORDER.indexOf(st);
      const vid = input?.view_id || input?.starless_id || input?.target_id;
      if (k > 0 && brief && await isWorkingImage(ctx, brief, vid)) {
        brief._stageLocks = brief._stageLocks || {};
        for (const prev of STAGE_ORDER.slice(0, k)) {
          if (prev === 'stars' || brief._stageLocks[prev]) continue;
          const rows = await measureStage(ctx, brief, vid, prev);
          brief._stageLocks[prev] = { view: vid, rows, auto: true, before: name };
          const bad = rows.filter(r => !r.pass);
          note += `\n[AUTO CHECKPOINT ${prev.toUpperCase()}: ${bad.length ? 'FAIL' : 'PASS'}] measured on ${vid} before this ${name} (you moved to a later stage):\n` +
            rows.map(r => `- ${r.pass ? 'PASS' : 'FAIL'} ${r.gate}: ${r.metric} = ${r.value} (${r.limit})`).join('\n') +
            (bad.length ? `\n  The '${prev}' stage is not done: fix it before going further (later-stage tools cannot repair it without side effects).` : '');
        }
      }
    } catch (e) { note += `\n[auto checkpoint skipped: ${e.message}]`; }
    const res = await handler(ctx, store, brief, input, agentName);
    if (note && res && res.type === 'text') res.text += note;
    return res;
  };
}

export function buildToolSet(agentName, extraCategories = []) {
  // If agent not in the map, give ALL categories (collect unique category values)
  const allCategories = [...new Set(Object.values(TOOL_CATALOG).map(t => t.category))];
  const categories = new Set([
    ...(AGENT_TOOL_CATEGORIES[agentName] || allCategories),
    ...extraCategories
  ]);

  const definitions = [];
  const handlers = new Map();

  for (const [name, tool] of Object.entries(TOOL_CATALOG)) {
    if (tool.hidden && !(tool.visibleTo || []).includes(agentName)) continue;
    if (AGENT_TOOL_EXCLUDES[agentName]?.has(name)) continue;
    if (categories.has(tool.category)) {
      definitions.push(tool.definition);
      handlers.set(name, agentName === 'giga_orchestrator' && STAGE_OF_TOOL(name) ? withAutoCheckpoint(name, tool.handler) : tool.handler);
    }
  }

  return { definitions, handlers };
}

/** Category of a catalog tool (or null if unknown). */
export function getToolCategory(name) {
  return TOOL_CATALOG[name]?.category || null;
}
