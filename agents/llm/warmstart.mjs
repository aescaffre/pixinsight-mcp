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

import { ArtifactStore } from '../artifact-store.mjs';
import { getStats } from '../ops/stats.mjs';

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
export async function loadBaseRunAsPrep(ctx, baseRunId, targetName) {
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
    files: configFiles || {},
    stats: { median: rgbStats?.median ?? null, max: rgbStats?.max ?? null, mean: rgbStats?.mean ?? null },
  };
  return crypto.createHash('sha1').update(JSON.stringify(sig)).digest('hex');
}

function cachePath(hash) { return path.join(GRADIENT_CACHE_DIR, `${hash}.xisf`); }

export function hasGradientSolution(hash) { return fs.existsSync(cachePath(hash)); }

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
    await ctx.pjsr(`
      var w = ImageWindow.windowById('FILTER_L');
      if (!w.isNull) { var p = '${lPath.replace(/'/g, "\\'")}'; if (File.exists(p)) File.remove(p); w.saveAs(p, false, false, false, false); }
    `);
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
