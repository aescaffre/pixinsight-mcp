// ============================================================================
// Gradient removal: GradientCorrection and AutomaticBackgroundExtractor
// ============================================================================

/**
 * Run GradientCorrection on a view (with cleanup of model images).
 */
export async function runGC(ctx, viewId) {
  const beforeIds = (await ctx.listImages()).map(i => i.id);
  const r = await ctx.pjsr(`
    var P = new GradientCorrection;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `);
  if (r.status === 'error') ctx.log('  [GC] WARN: ' + r.error?.message);
  // Close any model images GC may produce
  const newImgs = await ctx.detectNewImages(beforeIds);
  if (newImgs.length > 0) {
    const closeIds = newImgs.map(i => "'" + i.id + "'").join(',');
    await ctx.pjsr(`var ids=[${closeIds}];for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(w&&!w.isNull)w.forceClose();processEvents();}`);
  }
}

/**
 * Run AutomaticBackgroundExtractor on a view.
 */
export async function runABE(ctx, viewId, opts = {}) {
  const polyDegree = opts.polyDegree ?? 4;
  const tolerance = opts.tolerance ?? 1.0;
  const deviation = opts.deviation ?? 0.8;
  const boxSeparation = opts.boxSeparation ?? 5;
  const beforeIds = (await ctx.listImages()).map(i => i.id);
  const r = await ctx.pjsr(`
    var P = new AutomaticBackgroundExtractor;
    P.tolerance = ${tolerance};
    P.deviation = ${deviation};
    P.unbalance = 1.800;
    P.minBoxFraction = 0.050;
    P.maxBackground = 1.0000;
    P.minBackground = 0.0000;
    P.useBezierSurface = false;
    P.polyDegree = ${polyDegree};
    P.boxSize = 5;
    P.boxSeparation = ${boxSeparation};
    P.abeDownsample = 2.00;
    P.writeSampleBoxes = false;
    P.justTrySamples = false;
    P.targetCorrection = 1; // 1 = Subtract(ion): numeric, because the prototype constant is named .Subtract or .Subtraction depending on the PI version (1.9.5 rejected .Subtract on 2026-10-29)
    P.normalize = true;
    P.discardModel = true;
    P.replaceTarget = true;
    P.correctedImageId = '';
    P.verbosity = 0;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `);
  // PI 1.9.x renamed/removed several ABE prototype enum constants (.Subtract, .f32, .SameAsTarget
  // -> 'unsigned integer value expected'). A failed ABE must surface, not log a WARN: a silent
  // no-op left the gradient agent believing degree-1 ABE 'converged' (2026-10-29).
  if (r.status === 'error') throw new Error('ABE failed: ' + (r.error?.message || JSON.stringify(r.error)));
  // Close any residual model images
  const newImgs = await ctx.detectNewImages(beforeIds);
  if (newImgs.length > 0) {
    const closeIds = newImgs.map(i => "'" + i.id + "'").join(',');
    await ctx.pjsr(`var ids=[${closeIds}];for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(w&&!w.isNull)w.forceClose();processEvents();}`);
  }
}

/**
 * Run per-channel ABE on stretched RGB — extracts R/G/B, ABEs each independently, recombines.
 * Fixes color-specific gradients that emerge during non-linear processing.
 * @param {object} ctx - Bridge context
 * @param {string} viewId - RGB view ID (must be non-linear/stretched)
 * @param {object} opts - { polyDegree, tolerance, maskViewId }
 */
export async function runPerChannelABE(ctx, viewId, opts = {}) {
  const polyDeg = opts.polyDegree ?? 1;
  const tol = opts.tolerance ?? 1.2;
  // Explicit mask: ABE does not honour an applied mask reliably, so the corrected
  // result is blended back through mask_view_id with PixelMath (orig + M*(corrected-orig)).
  const maskId = opts.maskViewId || null;
  const beforeIds = (await ctx.listImages()).map(i => i.id);
  const r = await ctx.pjsr(`
    var tgt = ImageWindow.windowById('${viewId}');
    if (tgt.isNull) throw new Error('View not found: ${viewId}');
    var maskId = ${maskId ? `'${maskId}'` : 'null'};
    var origCopy = null;
    var chans = ['__pca_R', '__pca_G', '__pca_B'];
    try {
    if (maskId) {
      var mw0 = ImageWindow.windowById(maskId);
      if (mw0.isNull) throw new Error('mask_view_id not found: ' + maskId);
      var ti = tgt.mainView.image;
      if (mw0.mainView.image.width !== ti.width || mw0.mainView.image.height !== ti.height)
        throw new Error('mask_view_id geometry differs from target');
      origCopy = new ImageWindow(ti.width, ti.height, ti.numberOfChannels, 32, true, ti.isColor, '__pca_orig');
      origCopy.mainView.beginProcess(); origCopy.mainView.image.assign(ti); origCopy.mainView.endProcess();
    }

    // Extract channels
    var CE = new ChannelExtraction;
    // PI 1.9.x: channels = [[enabled, id], ...]. The old channelEnabled/channelId
    // names are silently ignored (default <view>_R/_G/_B ids → ABE found nothing).
    CE.channels = [[true, '__pca_R'], [true, '__pca_G'], [true, '__pca_B']];
    CE.colorSpace = ChannelExtraction.prototype.RGB;
    CE.sampleFormat = ChannelExtraction.prototype.SameAsSource;
    CE.executeOn(tgt.mainView);
    processEvents();

    // ABE each channel
    for (var i = 0; i < chans.length; i++) {
      var cw = ImageWindow.windowById(chans[i]);
      if (cw.isNull) continue;
      var P = new AutomaticBackgroundExtractor;
      P.tolerance = ${tol};
      P.deviation = 0.8;
      P.polyDegree = ${polyDeg};
      P.boxSize = 5;
      P.boxSeparation = 5;
      P.targetCorrection = 1; // 1 = Subtract(ion): numeric, because the prototype constant is named .Subtract or .Subtraction depending on the PI version (1.9.5 rejected .Subtract on 2026-10-29)
      P.normalize = true;
      P.discardModel = true;
      P.replaceTarget = true;
      P.verbosity = 0;
      P.executeOn(cw.mainView);
      processEvents();
    }

    // Recombine into target
    var CC = new ChannelCombination;
    CC.colorSpace = ChannelCombination.prototype.RGB;
    CC.channels = [[true, '__pca_R'], [true, '__pca_G'], [true, '__pca_B']];
    CC.executeOn(tgt.mainView);
    processEvents();

    if (maskId) {
      var PMm = new PixelMath;
      PMm.expression = '__pca_orig + ' + maskId + ' * ($T - __pca_orig)';
      PMm.useSingleExpression = true;
      PMm.createNewImage = false;
      PMm.rescale = false;
      PMm.truncate = true; PMm.truncateLower = 0; PMm.truncateUpper = 1;
      PMm.executeOn(tgt.mainView);
      processEvents();
      var oc = ImageWindow.windowById('__pca_orig');
      if (!oc.isNull) oc.forceClose();
    }

    } finally {
      // Cleanup always runs: close temp channel windows and the masked-blend original copy
      var cl = chans.concat(['__pca_orig']);
      for (var ci = 0; ci < cl.length; ci++) {
        var cwin = ImageWindow.windowById(cl[ci]);
        if (!cwin.isNull) cwin.forceClose();
      }
    }
    'Per-channel ABE done (polyDeg=${polyDeg}, tol=${tol}${maskId ? ', masked by ' + maskId : ''})';
  `);
  if (r.status === 'error') ctx.log('  [PCA-ABE] WARN: ' + r.error?.message);
  // Close any leftover model images
  const newImgs = await ctx.detectNewImages(beforeIds);
  for (const img of newImgs) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${img.id}');if(!w.isNull)w.forceClose();`).catch(() => {});
  }
  return r;
}

/**
 * Run SCNR (SubtractiveChromaticNoiseReduction) on a view — removes green cast.
 * Unmasked; pass preserveLightness:true to keep brightness so warm dust/IFN is
 * not greyed out. Callers cap `amount` for dust/reflection targets.
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID
 * @param {object} opts - { amount, preserveLightness }
 */
export async function runSCNR(ctx, viewId, opts = {}) {
  const amount = opts.amount ?? 0.50;
  // preserveLightness keeps luminance while removing green — prevents greying
  // out warm dust/IFN (over-aggressive unmasked SCNR was greying brown dust).
  const preserveLightness = opts.preserveLightness ? 'true' : 'false';
  const r = await ctx.pjsr(`
    var P = new SCNR;
    P.colorToRemove = SCNR.prototype.Green;
    P.amount = ${amount};
    P.protectionMethod = SCNR.prototype.AverageNeutral;
    P.preserveLightness = ${preserveLightness};
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    'SCNR done (amount=${amount})';
  `);
  if (r.status === 'error') ctx.log('  [SCNR] WARN: ' + r.error?.message);
  return r;
}
