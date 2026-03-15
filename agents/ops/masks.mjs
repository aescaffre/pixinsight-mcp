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
export async function createLumMask(ctx, sourceViewId, maskId, blur = 5, clipLow = 0.10, gamma = 1.0) {
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
    'OK';
  `);
  if (r.status === 'error') {
    ctx.log(`  [mask] WARN: ${maskId}: ${r.error?.message}`);
    return null;
  }
  ctx.log(`  [mask] Created luminance mask ${maskId} (blur=${blur}, clipLow=${clipLow}${gamma !== 1.0 ? ', gamma=' + gamma : ''}, ${dims.w}x${dims.h})`);
  return maskId;
}

/**
 * Apply a mask to a target view as a selection.
 */
export async function applyMask(ctx, targetViewId, maskId, inverted = false) {
  await ctx.pjsr(`
    var tw = ImageWindow.windowById('${targetViewId}');
    var mw = ImageWindow.windowById('${maskId}');
    if (tw && mw) { tw.mask = mw; tw.maskVisible = false; tw.maskInverted = ${inverted}; }
  `);
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
  await ctx.pjsr(`var mw = ImageWindow.windowById('${maskId}'); if (!mw.isNull) mw.forceClose();`);
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
