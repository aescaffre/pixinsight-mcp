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
    P.modelImageSampleFormat = AutomaticBackgroundExtractor.prototype.f32;
    P.abeDownsample = 2.00;
    P.writeSampleBoxes = false;
    P.justTrySamples = false;
    P.targetCorrection = AutomaticBackgroundExtractor.prototype.Subtract;
    P.normalize = true;
    P.discardModel = true;
    P.replaceTarget = true;
    P.correctedImageId = '';
    P.correctedImageSampleFormat = AutomaticBackgroundExtractor.prototype.SameAsTarget;
    P.verbosity = 0;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `);
  if (r.status === 'error') ctx.log('  [ABE] WARN: ' + r.error?.message);
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
 * @param {object} opts - { polyDegree, tolerance }
 */
export async function runPerChannelABE(ctx, viewId, opts = {}) {
  const polyDeg = opts.polyDegree ?? 1;
  const tol = opts.tolerance ?? 1.2;
  const beforeIds = (await ctx.listImages()).map(i => i.id);
  const r = await ctx.pjsr(`
    var tgt = ImageWindow.windowById('${viewId}');
    if (tgt.isNull) throw new Error('View not found: ${viewId}');

    // Extract channels
    var CE = new ChannelExtraction;
    CE.channelEnabled = [true, true, true];
    CE.channelId = ['__pca_R', '__pca_G', '__pca_B'];
    CE.colorSpace = ChannelExtraction.prototype.RGB;
    CE.sampleFormat = ChannelExtraction.prototype.SameAsSource;
    CE.executeOn(tgt.mainView);
    processEvents();

    // ABE each channel
    var chans = ['__pca_R', '__pca_G', '__pca_B'];
    for (var i = 0; i < chans.length; i++) {
      var cw = ImageWindow.windowById(chans[i]);
      if (cw.isNull) continue;
      var P = new AutomaticBackgroundExtractor;
      P.tolerance = ${tol};
      P.deviation = 0.8;
      P.polyDegree = ${polyDeg};
      P.boxSize = 5;
      P.boxSeparation = 5;
      P.targetCorrection = AutomaticBackgroundExtractor.prototype.Subtract;
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

    // Cleanup
    for (var i = 0; i < chans.length; i++) {
      var w = ImageWindow.windowById(chans[i]);
      if (!w.isNull) w.forceClose();
    }
    'Per-channel ABE done (polyDeg=${polyDeg}, tol=${tol})';
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
 * Use through an inverted luminance mask to target background only.
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID
 * @param {object} opts - { amount, protection }
 */
export async function runSCNR(ctx, viewId, opts = {}) {
  const amount = opts.amount ?? 0.50;
  const r = await ctx.pjsr(`
    var P = new SCNR;
    P.colorToRemove = SCNR.prototype.Green;
    P.amount = ${amount};
    P.protectionMethod = SCNR.prototype.AverageNeutral;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    'SCNR done (amount=${amount})';
  `);
  if (r.status === 'error') ctx.log('  [SCNR] WARN: ' + r.error?.message);
  return r;
}
