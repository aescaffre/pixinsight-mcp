// ============================================================================
// Mask creation, application, and cleanup
// ============================================================================

/**
 * Create a mask from a grayscale view (blur + shadow clip for smooth transitions).
 * Uses two-step pattern: query dimensions first, then create mask with literal values.
 */
export async function createMask(ctx, sourceViewId, maskId, blur = 5, clipLow = 0.10) {
  // Step 1: Query dimensions (PJSR Image.width/height don't pass cleanly to ImageWindow constructor)
  const dimR = await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${sourceViewId}');
    if (srcW.isNull) throw new Error('Source not found: ${sourceViewId}. Windows: ' + ImageWindow.windows.map(function(w){return w.mainView.id;}).join(','));
    var img = srcW.mainView.image;
    JSON.stringify({ w: Math.round(img.width), h: Math.round(img.height), id: srcW.mainView.id });
  `);
  if (dimR.status === 'error') {
    ctx.log(`  [mask] WARN: ${maskId}: ${dimR.error?.message}`);
    return null;
  }
  const rawOutput = dimR.outputs?.consoleOutput?.trim() || '{}';
  const dims = JSON.parse(rawOutput);
  if (!dims.w || !dims.h) {
    ctx.log(`  [mask] WARN: ${maskId}: invalid dimensions (raw=${rawOutput})`);
    return null;
  }

  // Step 2: Create mask with JS-interpolated literal dimensions
  const r = await ctx.pjsr(`
    var old = ImageWindow.windowById('${maskId}');
    if (!old.isNull) old.forceClose();
    var srcW = ImageWindow.windowById('${sourceViewId}');
    var maskW = new ImageWindow(${dims.w}, ${dims.h}, 1, 32, true, false, '${maskId}');
    maskW.mainView.beginProcess();
    maskW.mainView.image.assign(srcW.mainView.image);
    maskW.mainView.endProcess();
    ${blur > 0 ? `var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = ${blur}; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(maskW.mainView);` : ''}
    ${clipLow > 0 ? `var PM = new PixelMath; PM.expression = 'iif($T<${clipLow},0,($T-${clipLow})/${(1 - clipLow).toFixed(4)})'; PM.useSingleExpression = true; PM.createNewImage = false; PM.use64BitWorkingImage = true; PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1; PM.executeOn(maskW.mainView);` : ''}
    maskW.show();
    'OK';
  `);
  if (r.status === 'error') {
    ctx.log(`  [mask] WARN: ${maskId}: ${r.error?.message}`);
    return null;
  }
  ctx.log(`  [mask] Created ${maskId} (blur=${blur}, clipLow=${clipLow}, ${dims.w}x${dims.h})`);
  return maskId;
}

/**
 * Create luminance mask from a COLOR view.
 * Extracts Y = 0.2126R + 0.7152G + 0.0722B, then blurs and clips.
 */
export async function createLumMask(ctx, sourceViewId, maskId, blur = 5, clipLow = 0.10, gamma = 1.0, opts = {}) {
  const range = Array.isArray(opts.range) && opts.range.length === 2 && opts.range[1] > opts.range[0] ? opts.range : null;
  const invert = !!opts.invert;
  const dimR = await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${sourceViewId}');
    if (srcW.isNull) throw new Error('Source not found: ${sourceViewId}. Windows: ' + ImageWindow.windows.map(function(w){return w.mainView.id;}).join(','));
    var img = srcW.mainView.image;
    JSON.stringify({ w: Math.round(img.width), h: Math.round(img.height), color: img.isColor, id: srcW.mainView.id });
  `);
  if (dimR.status === 'error') {
    ctx.log(`  [mask] WARN: ${maskId}: ${dimR.error?.message}`);
    return null;
  }
  const rawOutput = dimR.outputs?.consoleOutput?.trim() || '{}';
  const dims = JSON.parse(rawOutput);
  if (!dims.w || !dims.h) {
    ctx.log(`  [mask] WARN: ${maskId}: invalid dimensions (raw=${rawOutput})`);
    return null;
  }

  const lumExpr = dims.color
    ? `0.2126*${sourceViewId}[0]+0.7152*${sourceViewId}[1]+0.0722*${sourceViewId}[2]`
    : sourceViewId;
  const r = await ctx.pjsr(`
    var old = ImageWindow.windowById('${maskId}');
    if (!old.isNull) old.forceClose();
    var mw = new ImageWindow(${dims.w}, ${dims.h}, 1, 32, true, false, '${maskId}');
    mw.show();
    var PM = new PixelMath;
    PM.expression = '${lumExpr}';
    PM.useSingleExpression = true;
    PM.createNewImage = false;
    PM.executeOn(mw.mainView);
    ${blur > 0 ? `var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = ${blur}; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(mw.mainView);` : ''}
    ${clipLow > 0 || gamma !== 1.0 ? `var PM2 = new PixelMath; PM2.expression = '${gamma !== 1.0 ? `iif($T<${clipLow},0,exp(${gamma.toFixed(4)}*ln(max(($T-${clipLow})/${(1 - clipLow).toFixed(4)},0.00001))))` : `iif($T<${clipLow},0,($T-${clipLow})/${(1 - clipLow).toFixed(4)})`}'; PM2.useSingleExpression = true; PM2.createNewImage = false; PM2.use64BitWorkingImage = true; PM2.truncate = true; PM2.truncateLower = 0; PM2.truncateUpper = 1; PM2.executeOn(mw.mainView);` : ''}
    ${range ? `var PM3 = new PixelMath; PM3.expression = '${rangeExpr(range[0], range[1])}'; PM3.useSingleExpression = true; PM3.createNewImage = false; PM3.use64BitWorkingImage = true; PM3.truncate = true; PM3.truncateLower = 0; PM3.truncateUpper = 1; PM3.executeOn(mw.mainView);` : ''}
    ${invert ? `var PM4 = new PixelMath; PM4.expression = '1-$T'; PM4.useSingleExpression = true; PM4.createNewImage = false; PM4.use64BitWorkingImage = true; PM4.truncate = true; PM4.truncateLower = 0; PM4.truncateUpper = 1; PM4.executeOn(mw.mainView);` : ''}
    'OK';
  `);
  if (r.status === 'error') {
    ctx.log(`  [mask] WARN: ${maskId}: ${r.error?.message}`);
    return null;
  }
  ctx.log(`  [mask] Created luminance mask ${maskId} (blur=${blur}, clipLow=${clipLow}${gamma !== 1.0 ? ', gamma=' + gamma : ''}${range ? ', range=' + range.join('-') : ''}${invert ? ', inverted' : ''}, ${dims.w}x${dims.h})`);
  return maskId;
}

/**
 * Apply a mask to a target view as a selection.
 */
export async function applyMask(ctx, targetViewId, maskId, inverted = false) {
  const r = await ctx.pjsr(`
    var tw = ImageWindow.windowById('${targetViewId}');
    var mw = ImageWindow.windowById('${maskId}');
    if (tw.isNull) throw new Error('apply_mask: target view not found: ${targetViewId}');
    if (mw.isNull) throw new Error('apply_mask: mask view not found: ${maskId}');
    var ti = tw.mainView.image, mi = mw.mainView.image;
    if (ti.width !== mi.width || ti.height !== mi.height)
      throw new Error('apply_mask: geometry mismatch - target ${targetViewId} is ' + ti.width + 'x' + ti.height + ' but mask ${maskId} is ' + mi.width + 'x' + mi.height + '. Rebuild the mask from a view with the same geometry.');
    tw.mask = mw; tw.maskVisible = false; tw.maskInverted = ${inverted ? 'true' : 'false'};
    'OK';
  `);
  if (r.status === 'error') throw new Error(r.error?.message || 'apply_mask failed');
  ctx.log(`  [mask] Applied ${maskId} to ${targetViewId}${inverted ? ' (inverted)' : ''}`);
}

/**
 * Remove mask from a target view.
 */
export async function removeMask(ctx, targetViewId) {
  await ctx.pjsr(`var tw = ImageWindow.windowById('${targetViewId}'); if (!tw.isNull) tw.removeMask();`);
}

/**
 * Close a mask window.
 */
export async function closeMask(ctx, maskId) {
  // Detach from every window that still uses it as a mask first (force-closing an active mask
  // window crashed PixInsight 1.9.5 on 2026-10-30).
  await ctx.pjsr(`
    var mw = ImageWindow.windowById('${maskId}');
    if (!mw.isNull) {
      var ws = ImageWindow.windows;
      for (var i = 0; i < ws.length; i++) { try { var mk = ws[i].mask; if (mk && !mk.isNull && mk.mainView.id === mw.mainView.id) ws[i].removeMask(); } catch (e) {} }
      processEvents();
      try { mw.hide(); } catch (eH) {} processEvents(); msleep(150); processEvents();   // flush UI events first (PI 1.9.5 crash, 2026-10-31)
      mw.forceClose();
      processEvents();
    }
  `);
}

/**
 * Create OIII veil mask from blue excess (B - max(R,G)).
 */
export async function createOiiiMask(ctx, sourceViewId, maskId, blur = 15, clipLow = 0.01) {
  const dimR = await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${sourceViewId}');
    if (srcW.isNull) throw new Error('Source not found: ${sourceViewId}');
    var img = srcW.mainView.image;
    JSON.stringify({ w: Math.round(img.width), h: Math.round(img.height), color: img.isColor });
  `);
  if (dimR.status === 'error') {
    ctx.log(`  [oiii] WARN: ${dimR.error?.message}`);
    return null;
  }
  const dims = JSON.parse(dimR.outputs?.consoleOutput?.trim() || '{}');

  const r = await ctx.pjsr(`
    var old = ImageWindow.windowById('${maskId}');
    if (!old.isNull) old.forceClose();
    var mw = new ImageWindow(${dims.w}, ${dims.h}, 1, 32, true, false, '${maskId}');
    mw.show();
    var PM = new PixelMath;
    PM.expression = 'max(0, ${sourceViewId}[2] - max(${sourceViewId}[0], ${sourceViewId}[1]))';
    PM.useSingleExpression = true;
    PM.createNewImage = false;
    PM.use64BitWorkingImage = true;
    PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
    PM.executeOn(mw.mainView);
    ${blur > 0 ? `var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = ${blur}; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(mw.mainView);` : ''}
    ${clipLow > 0 ? `var PM2 = new PixelMath; PM2.expression = 'iif($T<${clipLow},0,($T-${clipLow})/${(1 - clipLow).toFixed(6)})'; PM2.useSingleExpression = true; PM2.createNewImage = false; PM2.use64BitWorkingImage = true; PM2.truncate = true; PM2.truncateLower = 0; PM2.truncateUpper = 1; PM2.executeOn(mw.mainView);` : ''}
    var PM3 = new PixelMath;
    PM3.expression = '${maskId}/max(${maskId})';
    PM3.useSingleExpression = true;
    PM3.createNewImage = false;
    PM3.use64BitWorkingImage = true;
    PM3.truncate = true; PM3.truncateLower = 0; PM3.truncateUpper = 1;
    PM3.executeOn(mw.mainView);
    'OK';
  `);
  if (r.status === 'error') {
    ctx.log(`  [oiii] WARN: ${maskId}: ${r.error?.message}`);
    return null;
  }

  ctx.log(`  [oiii] Created OIII veil mask ${maskId} from ${sourceViewId} (blur=${blur}, clipLow=${clipLow}, ${dims.w}x${dims.h})`);
  return maskId;
}

// ============================================================================
// WI-15: mask shaping (pure PJSR processes, no per-pixel loops) + mask stats
// ============================================================================

/** PixelMath range-stretch expression: (T-lo)/(hi-lo) clipped to 0..1. */
export function rangeExpr(lo, hi) {
  return `max(0,min(1,($T-${lo})/(${hi}-${lo})))`;
}

/** Classify a mask by its mean: 'EMPTY' (<0.01), 'FULL' (>0.95) or ''. */
export function maskFlag(mean) {
  if (!(mean >= 0)) return '';
  if (mean < 0.01) return 'EMPTY';
  if (mean > 0.95) return 'FULL';
  return '';
}

const PM_HEAD = (expr) => `var PMx = new PixelMath; PMx.expression = '${expr}'; PMx.useSingleExpression = true; PMx.createNewImage = false; PMx.use64BitWorkingImage = true; PMx.truncate = true; PMx.truncateLower = 0; PMx.truncateUpper = 1; PMx.executeOn(OUTW.mainView);`;

/**
 * PJSR snippet (no template literals) computing mean/min/max (Image methods) and the
 * coverage fraction (>0.5) from a strided sample grid (~1M samples max) for window var `varName`.
 * Defines JS var MSTATS = {mean,coverage,min,max}.
 */
export function maskStatsSnippet(varName) {
  return `
    var _mi = ${varName}.mainView.image;
    var _step = Math.max(1, Math.floor(Math.sqrt(_mi.width * _mi.height / 1000000)));
    var _n = 0, _on = 0;
    for (var _y = 0; _y < _mi.height; _y += _step) for (var _x = 0; _x < _mi.width; _x += _step) { _n++; if (_mi.sample(_x, _y, 0) > 0.5) _on++; }
    var MSTATS = { mean: _mi.mean(), coverage: _n ? _on / _n : 0, min: _mi.minimum(), max: _mi.maximum() };
  `;
}

/**
 * Build the PJSR program for shapeMask. Pure (string in, string out) so it can be unit-tested.
 * Order: invert -> dilate/erode -> blur -> range -> gamma -> multiply.
 * Output JSON on the console: {id,w,h,mean,coverage,min,max}.
 */
export function buildShapeMaskPjsr(o) {
  const outId = o.outputId || o.maskId;
  const parts = [];
  parts.push(`
    var SRC = ImageWindow.windowById('${o.maskId}');
    if (SRC.isNull) throw new Error('mask_ops: mask not found: ${o.maskId}');
    var si = SRC.mainView.image;
    if (si.numberOfChannels !== 1) throw new Error('mask_ops: ${o.maskId} must be a mono image (has ' + si.numberOfChannels + ' channels)');
    var W0 = si.width, H0 = si.height;
    var OUTW = SRC;
    ${outId !== o.maskId ? `
    var OLD = ImageWindow.windowById('${outId}');
    if (!OLD.isNull) OLD.forceClose();
    OUTW = new ImageWindow(W0, H0, 1, 32, true, false, '${outId}');
    OUTW.mainView.beginProcess();
    OUTW.mainView.image.assign(si);
    OUTW.mainView.endProcess();` : ''}
  `);
  if (o.multiplyWith) {
    parts.push(`
    var OTH = ImageWindow.windowById('${o.multiplyWith}');
    if (OTH.isNull) throw new Error('mask_ops: multiply_with mask not found: ${o.multiplyWith}');
    if (OTH.mainView.image.width !== W0 || OTH.mainView.image.height !== H0 || OTH.mainView.image.numberOfChannels !== 1)
      throw new Error('mask_ops: multiply_with ${o.multiplyWith} geometry mismatch (' + OTH.mainView.image.width + 'x' + OTH.mainView.image.height + ' vs ' + W0 + 'x' + H0 + ', mono required)');
    `);
  }
  parts.push('var RES = "";\ntry {');
  if (o.invert) parts.push(PM_HEAD('1-$T'));
  const mt = (op, n) => `var MT = new MorphologicalTransformation; MT.operator = MorphologicalTransformation.prototype.${op}; MT.structureSize = 3; MT.numberOfIterations = ${n}; MT.amount = 1; MT.executeOn(OUTW.mainView);`;
  if (o.dilatePx > 0) parts.push(mt('Dilation', Math.round(o.dilatePx)));
  if (o.erodePx > 0) parts.push(mt('Erosion', Math.round(o.erodePx)));
  if (o.blurSigma > 0) parts.push(`var CV = new Convolution; CV.mode = Convolution.prototype.Parametric; CV.sigma = ${o.blurSigma}; CV.shape = 2; CV.aspectRatio = 1; CV.rotationAngle = 0; CV.executeOn(OUTW.mainView);`);
  if (o.clipLow != null || o.clipHigh != null) {
    const lo = o.clipLow ?? 0, hi = o.clipHigh ?? 1;
    parts.push(PM_HEAD(rangeExpr(lo, hi)));
  }
  if (o.gamma != null && o.gamma !== 1) parts.push(PM_HEAD(`exp(${o.gamma}*ln(max($T,1e-6)))`));
  if (o.multiplyWith) parts.push(PM_HEAD(`$T*${o.multiplyWith}[0]`));
  parts.push(maskStatsSnippet('OUTW'));
  parts.push(`
    if (OUTW !== SRC) OUTW.show();
    RES = JSON.stringify({ id: OUTW.mainView.id, w: W0, h: H0, mean: MSTATS.mean, coverage: MSTATS.coverage, min: MSTATS.min, max: MSTATS.max });
  } catch (e) {
    if (OUTW !== SRC && !OUTW.isNull) OUTW.forceClose();
    throw e;
  }
  RES;`);
  return parts.join('\n');
}

/**
 * Shape a mono mask with PJSR processes. See buildShapeMaskPjsr for the order.
 * @returns {{id,w,h,mean,coverage,min,max,flag}}
 */
export async function shapeMask(ctx, opts) {
  const o = {
    maskId: opts.maskId, outputId: opts.outputId || opts.maskId, invert: !!opts.invert,
    dilatePx: opts.dilatePx || 0, erodePx: opts.erodePx || 0, blurSigma: opts.blurSigma || 0,
    clipLow: opts.clipLow, clipHigh: opts.clipHigh, gamma: opts.gamma, multiplyWith: opts.multiplyWith
  };
  if (!o.maskId) throw new Error('shapeMask: maskId required');
  if ((o.clipLow != null || o.clipHigh != null) && (o.clipHigh ?? 1) <= (o.clipLow ?? 0)) throw new Error('mask_ops: clip_high must be greater than clip_low');
  const r = await ctx.pjsr(buildShapeMaskPjsr(o));
  if (r.status === 'error') throw new Error(`mask_ops: ${r.error?.message || 'PJSR error'}`);
  const data = JSON.parse(r.outputs?.consoleOutput?.trim() || '{}');
  data.flag = maskFlag(data.mean);
  return data;
}

/** Measure an existing mask view: {mean, coverage, min, max, flag}. */
export async function measureMask(ctx, maskId) {
  const r = await ctx.pjsr(`
    var MW = ImageWindow.windowById('${maskId}');
    if (MW.isNull) throw new Error('mask not found: ${maskId}');
    ${maskStatsSnippet('MW')}
    JSON.stringify(MSTATS);
  `);
  if (r.status === 'error') return null;
  const d = JSON.parse(r.outputs?.consoleOutput?.trim() || '{}');
  d.flag = maskFlag(d.mean);
  return d;
}

/** One-line mask summary for tool results. */
export function maskStatsText(d) {
  if (!d) return '(mask stats unavailable)';
  return `mean=${d.mean.toFixed(3)}, coverage(>0.5)=${(d.coverage * 100).toFixed(1)}%, min=${d.min.toFixed(3)}, max=${d.max.toFixed(3)}${d.flag ? ' [' + d.flag + (d.flag === 'EMPTY' ? ' - protects nothing/selects nothing' : ' - selects everything, no protection') + ']' : ''}`;
}
