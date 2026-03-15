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

  // 2. Center 1:1 crop
  const centerPath = path.join(outputDir, 'center_crop.jpg');
  const centerR = await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${viewId}');
    var img = srcW.mainView.image;
    var w = img.width, h = img.height;
    var sz = Math.min(${cropSize}, w, h);
    var x0 = Math.round((w - sz) / 2), y0 = Math.round((h - sz) / 2);
    var tmp = new ImageWindow(sz, sz, img.numberOfChannels, 32, false, img.isColor, 'diag_center');
    tmp.mainView.beginProcess();
    img.selectedRect = new Rect(x0, y0, x0 + sz, y0 + sz);
    tmp.mainView.image.assign(img);
    img.resetSelections();
    tmp.mainView.endProcess();
    var p = '${centerPath.replace(/'/g, "\\'")}';
    if (File.exists(p)) File.remove(p);
    tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
    'OK';
  `);
  if (centerR.status !== 'error') paths.push(centerPath);

  // 3. Corner 1:1 crop (top-left)
  const cornerPath = path.join(outputDir, 'corner_crop.jpg');
  const cornerR = await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${viewId}');
    var img = srcW.mainView.image;
    var sz = Math.min(${cropSize}, img.width, img.height);
    var tmp = new ImageWindow(sz, sz, img.numberOfChannels, 32, false, img.isColor, 'diag_corner');
    tmp.mainView.beginProcess();
    img.selectedRect = new Rect(0, 0, sz, sz);
    tmp.mainView.image.assign(img);
    img.resetSelections();
    tmp.mainView.endProcess();
    var p = '${cornerPath.replace(/'/g, "\\'")}';
    if (File.exists(p)) File.remove(p);
    tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
    'OK';
  `);
  if (cornerR.status !== 'error') paths.push(cornerPath);

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
