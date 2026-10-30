// ============================================================================
// Vision utilities: JPEG encoding, diagnostic views, message building
// for Claude API multimodal conversations.
// ============================================================================
import fs from 'fs';
import path from 'path';

/**
 * Convert a JPEG file to an Anthropic API image content block.
 * @param {string} jpegPath - Absolute path to JPEG file
 * @returns {{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: string } }}
 */
export function jpegToContentBlock(jpegPath) {
  const data = fs.readFileSync(jpegPath);
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: data.toString('base64')
    }
  };
}

/**
 * Render a crop of a view to a JPEG (WI-15). Crop is taken at native resolution (scale=1 is a true 1:1 crop)
 * via Image.assign(src, rect); the temp window is always force-closed in a finally block.
 * Rect is clamped to the image. Median/MAD are measured on the crop pixels.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - Source view
 * @param {string} outPath - JPEG output path
 * @param {object} o - { x0, y0, size (square) | w,h, scale=1 }
 * @returns {Promise<{x0,y0,w,h,scale,outW,outH,median,mad}>} crop rect in full-image coordinates
 */
export async function renderCropJpeg(ctx, viewId, outPath, { x0, y0, size, w, h, scale = 1 } = {}) {
  const cw0 = Math.round(w ?? size ?? 1024), ch0 = Math.round(h ?? size ?? 1024);
  const p = outPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const r = await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${viewId}');
    if (srcW.isNull) throw new Error('renderCropJpeg: view not found: ${viewId}');
    var img = srcW.mainView.image;
    var W = img.width, H = img.height;
    var cw = Math.max(1, Math.min(${cw0}, W)), ch = Math.max(1, Math.min(${ch0}, H));
    var cx0 = Math.max(0, Math.min(W - cw, Math.round(${Math.round(x0 ?? 0)})));
    var cy0 = Math.max(0, Math.min(H - ch, Math.round(${Math.round(y0 ?? 0)})));
    var sc = ${Number(scale) || 1};
    var tmp = new ImageWindow(cw, ch, img.numberOfChannels, 32, false, img.isColor, 'crop_render_tmp');
    var RES = '';
    try {
      tmp.mainView.beginProcess();
      tmp.mainView.image.assign(img, new Rect(cx0, cy0, cx0 + cw, cy0 + ch));
      tmp.mainView.endProcess();
      var cm = tmp.mainView.image.median(), cd = tmp.mainView.image.MAD();
      if (sc !== 1) {
        var R = new Resample;
        R.mode = Resample.prototype.RelativeDimensions;
        R.xSize = sc; R.ySize = sc;
        R.absoluteMode = Resample.prototype.ForceWidthAndHeight;
        R.interpolation = Resample.prototype.MitchellNetravaliFilter;
        R.executeOn(tmp.mainView);
      }
      var p = '${p}';
      if (File.exists(p)) File.remove(p);
      tmp.saveAs(p, false, false, false, false);
      RES = JSON.stringify({ x0: cx0, y0: cy0, w: cw, h: ch, scale: sc, outW: tmp.mainView.image.width, outH: tmp.mainView.image.height, median: cm, mad: cd });
    } finally {
      tmp.forceClose();
    }
    RES;
  `);
  if (r.status === 'error') throw new Error(`renderCropJpeg: ${r.error?.message || 'PJSR error'}`);
  return JSON.parse(r.outputs?.consoleOutput?.trim() || '{}');
}

/**
 * Generate diagnostic views for an image via PJSR.
 * Creates 4 previews:
 *   - overview (resized to maxDim)
 *   - center 1:1 crop
 *   - corner 1:1 crop
 *   - background-stretched view (reveals faint structure)
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - PixInsight view ID
 * @param {string} outputDir - Directory to write JPEGs
 * @param {object} opts - { maxDim: 2048, cropSize: 800 }
 * @returns {string[]} Array of JPEG file paths created
 */
export async function generateDiagnosticViews(ctx, viewId, outputDir, opts = {}) {
  const maxDim = opts.maxDim || 2048;
  const cropSize = opts.cropSize || 800;
  fs.mkdirSync(outputDir, { recursive: true });

  const paths = [];

  // 1. Overview (resized)
  const overviewPath = path.join(outputDir, 'overview.jpg');
  const overviewR = await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${viewId}');
    if (srcW.isNull) throw new Error('View not found: ${viewId}');
    var img = srcW.mainView.image;
    var w = img.width, h = img.height;
    var scale = Math.min(1, ${maxDim} / Math.max(w, h));
    var nw = Math.round(w * scale), nh = Math.round(h * scale);
    var tmp = new ImageWindow(nw, nh, img.numberOfChannels, 32, false, img.isColor, 'diag_overview');
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
    var p = '${overviewPath.replace(/'/g, "\\'")}';
    if (File.exists(p)) File.remove(p);
    tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
    'OK';
  `);
  if (overviewR.status !== 'error') paths.push(overviewPath);

  // 2. Center 1:1 crop (WI-15: shared renderCropJpeg)
  const centerPath = path.join(outputDir, 'center_crop.jpg');
  try {
    const dims = await ctx.pjsr(`var w = ImageWindow.windowById('${viewId}'); JSON.stringify({ w: w.mainView.image.width, h: w.mainView.image.height });`);
    const d = JSON.parse(dims.outputs?.consoleOutput?.trim() || '{}');
    const sz = Math.min(cropSize, d.w, d.h);
    await renderCropJpeg(ctx, viewId, centerPath, { x0: Math.round((d.w - sz) / 2), y0: Math.round((d.h - sz) / 2), size: sz });
    paths.push(centerPath);

    // 3. Corner 1:1 crop (top-left)
    const cornerPath = path.join(outputDir, 'corner_crop.jpg');
    try {
      await renderCropJpeg(ctx, viewId, cornerPath, { x0: 0, y0: 0, size: sz });
      paths.push(cornerPath);
    } catch (_e) { /* skip corner */ }
  } catch (_e) { /* skip crops */ }

  // 4. Background-stretched view (aggressive stretch to reveal faint structure)
  const bgStretchPath = path.join(outputDir, 'bg_stretch.jpg');
  const bgR = await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${viewId}');
    var img = srcW.mainView.image;
    var w = img.width, h = img.height;
    var scale = Math.min(1, ${maxDim} / Math.max(w, h));
    var nw = Math.round(w * scale), nh = Math.round(h * scale);
    var tmp = new ImageWindow(nw, nh, img.numberOfChannels, 32, false, img.isColor, 'diag_bgstretch');
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
    var timg = tmp.mainView.image;
    var med = timg.median(), mad = timg.MAD();
    var c0 = Math.max(0, med - 1.5 * mad);
    var x = (1 > c0) ? (med - c0) / (1 - c0) : 0.5;
    var tgt = 0.45;
    var m = (x <= 0 || x >= 1) ? 0.5 : x * (1 - tgt) / (x * (1 - 2*tgt) + tgt);
    var HT = new HistogramTransformation;
    HT.H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[c0,m,1,0,1],[0,0.5,1,0,1]];
    HT.executeOn(tmp.mainView);
    var p = '${bgStretchPath.replace(/'/g, "\\'")}';
    if (File.exists(p)) File.remove(p);
    tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
    'OK';
  `);
  if (bgR.status !== 'error') paths.push(bgStretchPath);

  return paths;
}

/**
 * Build an Anthropic API content array combining text and images.
 * @param {string} text - Text message
 * @param {string[]} imagePaths - JPEG file paths to include
 * @returns {Array} Content array for Anthropic API message
 */
export function buildImageMessage(text, imagePaths = []) {
  const content = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  for (const p of imagePaths) {
    if (fs.existsSync(p)) {
      content.push(jpegToContentBlock(p));
    }
  }
  return content;
}
