// ============================================================================
// B1 Warm-start: base-run touch-up loading + gradient-solution cache.
// Lets `giga-run.mjs --base-run <runId>` skip prep+gradient and load a prior
// run's winning composition for a targeted touch-up, and replays a cached
// post-gradient snapshot for identical-input fresh runs (skips the sub-agent).
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import { GRADIENT_PROMPT_VERSION } from './prompts/gradient-agent.mjs';
import { ArtifactStore } from '../artifact-store.mjs';
import { getStats } from '../ops/stats.mjs';
import { readDetailBaseline } from '../ops/subject-metrics.mjs';
import { openXisfAs, CACHE_DIR } from './prep-cache-util.mjs';
import { detectNarrowbandWorkflow, computeNbCacheKey, resolveNbOptions } from './narrowband-prep.mjs';

const home = os.homedir();
const GRADIENT_CACHE_DIR = path.join(home, '.pixinsight-mcp', 'gradient-cache');

// Close crop_mask windows + rename a loaded window's mainView (mirrors
// ArtifactStore.loadVariant).
async function closeCropMasksAndRename(ctx, loadedId, targetId) {
  const allImgs = await ctx.listImages();
  for (const cm of allImgs.filter(i => i.id.indexOf('crop_mask') >= 0)) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
  }
  if (loadedId && loadedId !== targetId) {
    await ctx.pjsr(`var w = ImageWindow.windowById('${loadedId}'); if (!w.isNull) w.mainView.id = '${targetId}';`);
  }
}

/** Resolve the absolute winning XISF path of a prior run. */
export function resolveBaseWinner(baseRunId) {
  // Guard FIRST: ArtifactStore's constructor mkdirSync's the run dir, so a bad
  // run id would otherwise litter an empty ~/.pixinsight-mcp/runs/<bad-id>/.
  const runDir = path.join(home, '.pixinsight-mcp', 'runs', baseRunId);
  if (!fs.existsSync(runDir)) throw new Error(`Base run not found: ${baseRunId} (no ${runDir})`);
  const baseStore = new ArtifactStore(baseRunId);
  const sel = baseStore.readFinalSelection();
  if (!sel) throw new Error(`Base run ${baseRunId} has no final-selection.json — cannot warm-start from it.`);
  let xisf = sel.variant_path;
  if (!xisf || !fs.existsSync(xisf)) {
    const meta = baseStore.getVariantById(sel.agent || 'giga_orchestrator', sel.variant_id);
    xisf = meta?.xisfPath;
  }
  if (!xisf || !fs.existsSync(xisf)) {
    throw new Error(`Base run winner XISF not found (variant ${sel.variant_id}, path ${sel.variant_path}). Run likely pruned.`);
  }
  return { xisfPath: xisf, selection: sel };
}

/**
 * Open a prior run's winner as the active 'rgb' working view and synthesize a
 * prepResult equivalent to what runDeterministicPrep returns.
 */
export async function loadBaseRunAsPrep(ctx, baseRunId, targetName, opts = {}) {
  const { xisfPath, selection } = resolveBaseWinner(baseRunId);
  const r = await ctx.send('open_image', '__internal__', { filePath: xisfPath });
  if (r.status === 'error') throw new Error(`Failed to open base winner ${xisfPath}: ${r.error?.message}`);
  await closeCropMasksAndRename(ctx, r.outputs?.id, 'rgb');
  const stats = await getStats(ctx, 'rgb');
  const prepResult = {
    targetName: targetName || 'Target',
    views: { rgb: 'rgb' },
    stats: { rgb: stats },
    previews: {},
    baseRun: baseRunId,
  };
  // Narrowband base run: re-open the stretched starless FILTER_S/Ha/O so ha_inject/lift_faint_halo/sho_combine work.
  const baseDir = path.join(home, '.pixinsight-mcp', 'runs', baseRunId);
  let baseBrief = null;
  try { baseBrief = new ArtifactStore(baseRunId).loadBrief(); } catch { /* */ }
  if (baseBrief?.dataDescription?.narrowband) {
    await loadNarrowbandForWarmStart(ctx, baseRunId, baseDir, baseBrief, prepResult, opts);
  }
  // Carry the base run's prep detail baseline (prep-metrics.json) so the finish detail-gain advisory still has a reference.
  const baseline = readDetailBaseline(path.join(home, '.pixinsight-mcp', 'runs', baseRunId));
  if (baseline) prepResult.baselineDetail = baseline;
  try { const pm = JSON.parse(fs.readFileSync(path.join(home, '.pixinsight-mcp', 'runs', baseRunId, 'prep-metrics.json'), 'utf8')); if (pm.inventory) prepResult.inventory = pm.inventory; } catch { /* no inventory in the base run */ }
  return { prepResult, selection };
}

// --- Gradient-solution snapshot cache ---

/**
 * Deterministic prep-input fingerprint: input file paths + linear RGB stat signature.
 * NOTE: L-presence MUST remain encoded here — it is, via configFiles (which includes
 * the L path). Do NOT trim this to stats-only, or an RGB-only cache entry could replay
 * over an L run and skip L gradient correction.
 */
export function gradientHash(configFiles, rgbStats) {
  const sig = {
    promptVersion: GRADIENT_PROMPT_VERSION,
    files: configFiles || {},
    stats: { median: rgbStats?.median ?? null, max: rgbStats?.max ?? null, mean: rgbStats?.mean ?? null },
  };
  return crypto.createHash('sha1').update(JSON.stringify(sig)).digest('hex');
}

function cachePath(hash) { return path.join(GRADIENT_CACHE_DIR, `${hash}.xisf`); }

export function hasGradientSolution(hash, hasL = false) {
  // An L run needs BOTH snapshots: an RGB-only entry (saved while FILTER_L was missing) replayed
  // on NGC4490 (2026-10-29) left the run without an L view -> prep-B died.
  return fs.existsSync(cachePath(hash)) && (!hasL || fs.existsSync(cachePath(`${hash}_L`)));
}

/** Save the post-gradient linear views as a snapshot keyed by hash. */
export async function saveGradientSolution(ctx, hash, targetName, hasL) {
  fs.mkdirSync(GRADIENT_CACHE_DIR, { recursive: true });
  const rgbPath = cachePath(hash);
  await ctx.pjsr(`
    var w = ImageWindow.windowById('${targetName}');
    if (w.isNull) throw new Error('gradient-cache save: ${targetName} not found');
    var p = '${rgbPath.replace(/'/g, "\\'")}';
    if (File.exists(p)) File.remove(p);
    w.saveAs(p, false, false, false, false);
    'saved ' + p;
  `);
  if (hasL) {
    const lPath = cachePath(`${hash}_L`);
    const rl = await ctx.pjsr(`
      var w = ImageWindow.windowById('FILTER_L');
      if (!w.isNull) { var p = '${lPath.replace(/'/g, "\\'")}'; if (File.exists(p)) File.remove(p); w.saveAs(p, false, false, false, false); 'saved'; } else 'NO_L';
    `);
    if (!(rl.outputs?.consoleOutput || '').includes('saved')) {
      try { fs.unlinkSync(rgbPath); } catch { /* */ }
      throw new Error('FILTER_L is missing after the gradient phase (the gradient agent closed or renamed it) — snapshot NOT cached');
    }
  }
}

/** Replay a cached gradient solution: re-open the snapshot over the live views. */
export async function replayGradientSolution(ctx, hash, targetName, hasL) {
  const rgbPath = cachePath(hash);
  await ctx.pjsr(`var w=ImageWindow.windowById('${targetName}');if(!w.isNull)w.forceClose();`);
  const r = await ctx.send('open_image', '__internal__', { filePath: rgbPath });
  if (r.status === 'error') throw new Error(`gradient-cache replay open failed: ${r.error?.message}`);
  await closeCropMasksAndRename(ctx, r.outputs?.id, targetName);
  if (hasL) {
    const lPath = cachePath(`${hash}_L`);
    if (fs.existsSync(lPath)) {
      await ctx.pjsr(`var w=ImageWindow.windowById('FILTER_L');if(!w.isNull)w.forceClose();`);
      const rl = await ctx.send('open_image', '__internal__', { filePath: lPath });
      if (rl.status !== 'error') await closeCropMasksAndRename(ctx, rl.outputs?.id, 'FILTER_L');
    }
  }
}

/**
 * Warm-start for narrowband runs. Sources, in order: <baseRun>/prep/FILTER_*.xisf (+ nb-prep.json),
 * else the NB prep cache (key recomputed from the config + base brief), else throw.
 */
async function loadNarrowbandForWarmStart(ctx, baseRunId, baseDir, baseBrief, prepResult, opts) {
  const prepDir = path.join(baseDir, 'prep');
  const chans = [['s', 'FILTER_S'], ['ha', 'FILTER_Ha'], ['o', 'FILTER_O']];
  const hasS = fs.existsSync(path.join(prepDir, 'FILTER_S.xisf'));
  const want = chans.filter(([k]) => k !== 's' || hasS);
  let srcDir = null;
  if (want.every(([, id]) => fs.existsSync(path.join(prepDir, `${id}.xisf`)))) srcDir = prepDir;
  let nbMeta = null;
  if (srcDir) {
    try { nbMeta = JSON.parse(fs.readFileSync(path.join(prepDir, 'nb-prep.json'), 'utf-8')).narrowband; } catch { /* */ }
  } else {
    // Fallback: recompute the NB cache key.
    const F = opts.config?.files;
    const workflow = F && detectNarrowbandWorkflow(F);
    if (workflow) {
      const { nb, target, headroom } = resolveNbOptions(F, baseBrief, workflow);
      const dir = path.join(CACHE_DIR, `${computeNbCacheKey(F, nb, target, headroom)}_nb`);
      const mp = path.join(dir, 'meta.json');
      if (fs.existsSync(mp) && want.every(([, id]) => fs.existsSync(path.join(dir, `${id}.xisf`)))) {
        srcDir = dir;
        try { nbMeta = JSON.parse(fs.readFileSync(mp, 'utf-8')).result?.narrowband; } catch { /* */ }
      }
    }
  }
  if (!srcDir) throw new Error(`Warm-start of narrowband base run ${baseRunId}: no FILTER_S/Ha/O in ${prepDir} and no NB prep-cache hit — rerun prep (run without --base-run once).`);
  for (const [k, id] of want) {
    const w = (await ctx.listImages()).find(i => i.id === id);
    if (w) await ctx.pjsr(`var w=ImageWindow.windowById('${id}');if(!w.isNull)w.forceClose();`);
    await openXisfAs(ctx, path.join(srcDir, `${id}.xisf`), id);
    prepResult.views[k] = id;
    prepResult.stats[k] = await getStats(ctx, id);
  }
  const wf = (nbMeta?.workflow) || (prepResult.views.s ? 'SHO' : 'HOO');
  prepResult.narrowband = Object.assign({
    workflow: wf, palette: 'base-run winner', starLayers: {}, gradient: {}, linearStarless: {},
  }, nbMeta || {}, { warmStart: true, initialBalance: 'n/a (warm start: rgb is the base run winner)' });
  // Brief-level pointer so reload_narrowband_channel / giga-run can find the snapshots.
  prepResult.narrowbandPrepDir = srcDir;
}
