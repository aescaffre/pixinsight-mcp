// ============================================================================
// Preview export and auto-stretch
// ============================================================================
import path from 'path';
import os from 'os';
import { getStats } from './stats.mjs';

const home = os.homedir();
const DEFAULT_PREVIEW_DIR = path.join(home, '.pixinsight-mcp', 'previews');

// Steps that run on linear data — previews need auto-stretch
const LINEAR_STEPS = new Set([
  'align', 'combine_rgb', 'gc', 'abe', 'abe_deg2', 'bxt_correct', 'plate_solve', 'spcc', 'scnr',
  'bxt_sharpen', 'nxt_pass1', 'sxt', 'ha_gc', 'ha_bxt_correct', 'ha_nxt_linear', 'ha_bxt_sharpen',
  'ha_sxt', 'l_sxt', 'l_bxt_correct', 'l_nxt_linear', 'l_bxt_sharpen'
]);

/**
 * Save a preview JPEG for a given view and step.
 * Auto-stretches if the step operates on linear data.
 * @param {object} ctx - Bridge context
 * @param {string} viewId - PixInsight view ID
 * @param {string} stepId - Step identifier (used for filename and linear detection)
 * @param {object} opts - Options: { previewDir, isLinear }
 */
export async function savePreview(ctx, viewId, stepId, opts = {}) {
  const previewDir = opts.previewDir || DEFAULT_PREVIEW_DIR;
  const previewPath = path.join(previewDir, stepId + '.jpg');
  const isLinear = opts.isLinear ?? LINEAR_STEPS.has(stepId);
  ctx.log(`    [preview] Exporting ${stepId} (${isLinear ? 'linear→auto-stretch' : 'non-linear'})...`);

  try {
    const r = await ctx.pjsr(`
      var srcW = ImageWindow.windowById('${viewId}');
      if (srcW.isNull) throw new Error('View not found: ${viewId}');
      var src = srcW.mainView;
      var img = src.image;
      var w = img.width, h = img.height;

      var tmp = new ImageWindow(w, h, img.numberOfChannels, 32, false, img.isColor, 'preview_tmp');
      tmp.mainView.beginProcess();
      tmp.mainView.image.assign(img);
      tmp.mainView.endProcess();

      ${isLinear ? `
      var meds = [], mads = [];
      var timg = tmp.mainView.image;
      if (timg.isColor) {
        for (var c = 0; c < timg.numberOfChannels; c++) {
          timg.selectedChannel = c;
          meds.push(timg.median());
          mads.push(timg.MAD());
        }
        timg.resetSelections();
      } else {
        meds = [timg.median()]; mads = [timg.MAD()];
      }
      var med = 0, mad = 0;
      for (var c = 0; c < meds.length; c++) { med += meds[c]; mad += mads[c]; }
      med /= meds.length; mad /= mads.length;
      var c0 = Math.max(0, med - 2.8 * mad);
      var x = (1 > c0) ? (med - c0) / (1 - c0) : 0.5;
      var tgt = 0.25;
      var m = (x <= 0 || x >= 1) ? 0.5 : x * (1 - tgt) / (x * (1 - 2*tgt) + tgt);
      var HT = new HistogramTransformation;
      HT.H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[c0,m,1,0,1],[0,0.5,1,0,1]];
      HT.executeOn(tmp.mainView);
      ` : ''}

      var dir = '${previewDir}';
      if (!File.directoryExists(dir)) File.createDirectory(dir, true);
      var p = '${previewPath}';
      if (File.exists(p)) File.remove(p);
      tmp.saveAs(p, false, false, false, false);
      tmp.forceClose();
      'OK';
    `);
    if (r.status === 'error') ctx.log('    [preview] WARN: ' + r.error?.message);
    else ctx.log('    [preview] Saved: ' + stepId + '.jpg');
  } catch (e) {
    ctx.log('    [preview] ERROR: ' + e.message);
  }
}

/**
 * Auto-stretch a view using STF-based histogram transformation.
 * @returns {{ stats, shadows, midtone }}
 */
export async function autoStretch(ctx, viewId, targetBg = 0.25) {
  const stats = await getStats(ctx, viewId);
  ctx.log(`    Stats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}`);
  const c0 = Math.max(0, stats.median - 2.8 * stats.mad);
  const x = (1 > c0) ? (stats.median - c0) / (1 - c0) : 0.5;
  let m;
  if (x <= 0 || x >= 1) m = 0.5;
  else m = x * (1 - targetBg) / (x * (1 - 2 * targetBg) + targetBg);
  ctx.log(`    Auto-stretch: shadows=${c0.toFixed(6)}, midtone=${m.toFixed(6)}`);
  const r = await ctx.pjsr(`
    var P = new HistogramTransformation;
    P.H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[${c0},${m},1,0,1],[0,0.5,1,0,1]];
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `);
  if (r.status === 'error') ctx.log('    WARN: ' + r.error?.message);
  else ctx.log('    Stretched OK.');
  return { stats, shadows: c0, midtone: m };
}
