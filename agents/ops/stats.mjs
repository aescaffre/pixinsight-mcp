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

// ============================================================================
// Color-gradient measurement
// ----------------------------------------------------------------------------
// measureUniformity collapses to a single luminance stddev over 4 corners — a
// red corner and a green glow elsewhere can cancel and read "clean". This grids
// the whole frame, rejects subject cells (galaxies/bright stars), and reports
// the CHROMINANCE spread of the background — the thing a colored gradient moves.
// score = peak-to-peak chrominance across background cells (image units).
// Used by the agent to iterate gradient-correction scale until the background
// is color-flat WITHOUT eating faint signal.
// ============================================================================
export async function measureColorGradient(ctx, viewId, opts = {}) {
  const cols = opts.cols ?? 8;
  const rows = opts.rows ?? 6;
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureColorGradient: not found: ${viewId}');
    var img = w.mainView.image;
    if (!img.isColor) { JSON.stringify({ error: 'mono image — no color gradient' }); }
    else {
      var cols = ${cols}, rows = ${rows};
      var cw = Math.floor(img.width / cols), ch = Math.floor(img.height / rows);
      var box = Math.max(24, Math.floor(Math.min(cw, ch) * 0.6));
      var cells = [];
      for (var gy = 0; gy < rows; gy++) {
        for (var gx = 0; gx < cols; gx++) {
          var cx = gx * cw + Math.floor((cw - box) / 2);
          var cy = gy * ch + Math.floor((ch - box) / 2);
          img.selectedRect = new Rect(cx, cy, cx + box, cy + box);
          var m = [];
          for (var c = 0; c < 3; c++) { img.selectedChannel = c; m.push(img.median()); }
          img.resetChannelSelection();
          var lum = (m[0] + m[1] + m[2]) / 3;
          cells.push({ gx: gx, gy: gy, R: m[0], G: m[1], B: m[2], lum: lum });
        }
      }
      img.resetSelections();
      // Reject subject cells: lum > median(lum) + 3*MAD(lum)
      var lums = []; for (var i = 0; i < cells.length; i++) lums.push(cells[i].lum);
      lums.sort(function(a,b){return a-b;});
      var medLum = lums[Math.floor(lums.length/2)];
      var devs = []; for (var i = 0; i < lums.length; i++) devs.push(Math.abs(lums[i]-medLum));
      devs.sort(function(a,b){return a-b;});
      var madLum = devs[Math.floor(devs.length/2)] * 1.4826;
      var thr = medLum + 3 * madLum;
      var bg = [];
      for (var i = 0; i < cells.length; i++) if (cells[i].lum <= thr) bg.push(cells[i]);
      // Chrominance per background cell: channel minus local luminance
      var crMin=1, crMax=-1, cgMin=1, cgMax=-1, cbMin=1, cbMax=-1;
      var worst = null, worstAmp = -1;
      for (var i = 0; i < bg.length; i++) {
        var L = bg[i].lum;
        var cr = bg[i].R - L, cg = bg[i].G - L, cb = bg[i].B - L;
        if (cr<crMin)crMin=cr; if(cr>crMax)crMax=cr;
        if (cg<cgMin)cgMin=cg; if(cg>cgMax)cgMax=cg;
        if (cb<cbMin)cbMin=cb; if(cb>cbMax)cbMax=cb;
        var amp = Math.max(Math.abs(cr), Math.abs(cg), Math.abs(cb));
        if (amp > worstAmp) {
          worstAmp = amp;
          var dom = (Math.abs(cr)>=Math.abs(cg)&&Math.abs(cr)>=Math.abs(cb)) ? (cr>0?'red':'cyan')
                  : (Math.abs(cg)>=Math.abs(cb)) ? (cg>0?'green':'magenta') : (cb>0?'blue':'yellow');
          worst = { gx: bg[i].gx, gy: bg[i].gy, dominant: dom, amp: amp };
        }
      }
      var ppR = crMax - crMin, ppG = cgMax - cgMin, ppB = cbMax - cbMin;
      var score = Math.max(ppR, ppG, ppB);
      // Luminance peak-to-peak across background cells (reported, not the score)
      var bgLumMin=1, bgLumMax=-1;
      for (var i = 0; i < bg.length; i++){ if(bg[i].lum<bgLumMin)bgLumMin=bg[i].lum; if(bg[i].lum>bgLumMax)bgLumMax=bg[i].lum; }
      JSON.stringify({
        score: score,
        chromaPP: { R: ppR, G: ppG, B: ppB },
        lumPP: bgLumMax - bgLumMin,
        bgCells: bg.length, totalCells: cells.length,
        bgMedianLum: medLum,
        worst: worst
      });
    }
  `);
  if (r.status === 'error') {
    ctx.log(`  [colorGradient] WARN: ${r.error?.message || 'unknown error'}`);
    return { score: 999, error: r.error?.message };
  }
  return JSON.parse(r.outputs?.consoleOutput?.trim() || '{"score":999}');
}
