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
