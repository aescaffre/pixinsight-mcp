// ============================================================================
// Image statistics and quality measurement
// ============================================================================

/**
 * Get basic image statistics (median, MAD, min, max) for a view.
 * @param {object} ctx - Bridge context from createBridgeContext()
 * @param {string} viewId - PixInsight view ID
 * @returns {object} { median, mad, min, max, perChannel? }
 */
export async function getStats(ctx, viewId) {
  const r = await ctx.pjsr(`
    var v = ImageWindow.windowById('${viewId}').mainView;
    var img = v.image;
    var result = {};
    if (img.isColor) {
      var meds = [], mads = [];
      for (var c = 0; c < img.numberOfChannels; c++) {
        img.selectedChannel = c;
        meds.push(img.median());
        mads.push(img.MAD());
      }
      img.resetSelections();
      result.median = (meds[0] + meds[1] + meds[2]) / 3;
      result.mad = (mads[0] + mads[1] + mads[2]) / 3;
      result.perChannel = {
        R: { median: meds[0], mad: mads[0] },
        G: { median: meds[1], mad: mads[1] },
        B: { median: meds[2], mad: mads[2] }
      };
    } else {
      result.median = img.median();
      result.mad = img.MAD();
    }
    result.min = img.minimum();
    result.max = img.maximum();
    JSON.stringify(result);
  `);
  try { return JSON.parse(r.outputs?.consoleOutput || '{}'); }
  catch { return { median: 0.01, mad: 0.001 }; }
}

/**
 * Measure background uniformity via 4-corner median stddev.
 * @param {object} ctx - Bridge context
 * @param {string} viewId - PixInsight view ID
 * @param {number} sampleSize - Corner sample size in pixels (default 200)
 * @returns {object} { score, corners, perChannel, mean }
 */
export async function measureUniformity(ctx, viewId, sampleSize = 200) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureUniformity: not found: ${viewId}');
    var img = w.mainView.image;
    var sz = ${sampleSize};
    var corners = [
      [0, 0],
      [img.width - sz, 0],
      [0, img.height - sz],
      [img.width - sz, img.height - sz]
    ];
    var meds = [];
    var perCh = [];
    for (var i = 0; i < corners.length; i++) {
      var r = new Rect(corners[i][0], corners[i][1], corners[i][0] + sz, corners[i][1] + sz);
      img.selectedRect = r;
      if (img.isColor) {
        var chMeds = [];
        for (var c = 0; c < img.numberOfChannels; c++) {
          img.selectedChannel = c;
          chMeds.push(img.median());
        }
        img.resetChannelSelection();
        perCh.push(chMeds);
        meds.push((chMeds[0] + chMeds[1] + chMeds[2]) / 3);
      } else {
        var m = img.median();
        meds.push(m);
        perCh.push([m]);
      }
    }
    img.resetSelections();
    var mean = 0;
    for (var i = 0; i < meds.length; i++) mean += meds[i];
    mean /= meds.length;
    var variance = 0;
    for (var i = 0; i < meds.length; i++) variance += (meds[i] - mean) * (meds[i] - mean);
    var stddev = Math.sqrt(variance / meds.length);
    JSON.stringify({ score: stddev, corners: meds, perChannel: perCh, mean: mean });
  `);
  if (r.status === 'error') {
    ctx.log(`  [uniformity] WARN: ${r.error?.message || 'unknown error'}`);
    return { score: 999, corners: [], perChannel: [], mean: 0 };
  }
  return JSON.parse(r.outputs?.consoleOutput?.trim() || '{"score":999}');
}
