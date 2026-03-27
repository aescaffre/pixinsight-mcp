// ============================================================================
// Compound Enhancement — multi-scale LHE + HDRMT in a single PJSR call
//
// Instead of the agent making 10+ individual bridge calls (2 min each),
// this does the full multi-scale enhancement in one shot with internal
// metric checks. Returns before/after metrics so the agent knows if it worked.
// ============================================================================

/**
 * Multi-scale detail enhancement with metrics.
 * Creates luminance mask, applies LHE at 3 scales + optional HDRMT,
 * measures detail score before and after.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to enhance
 * @param {object} opts
 * @param {number} opts.maskClipLow - Mask clip low (0.04-0.15, default 0.06)
 * @param {number} opts.maskBlur - Mask blur sigma (3-10, default 5)
 * @param {number} opts.maskGamma - Mask gamma (1.0-3.0, default 2.0)
 * @param {number} opts.lheFineRadius - Fine LHE radius (16-32, default 24)
 * @param {number} opts.lheFineAmount - Fine LHE amount (0.10-0.40, default 0.20)
 * @param {number} opts.lheMidRadius - Mid LHE radius (35-64, default 48)
 * @param {number} opts.lheMidAmount - Mid LHE amount (0.15-0.50, default 0.30)
 * @param {number} opts.lheLargeRadius - Large LHE radius (80-150, default 100)
 * @param {number} opts.lheLargeAmount - Large LHE amount (0.20-0.50, default 0.30)
 * @param {number} opts.lheSlopeLimit - LHE slope limit (1.2-2.0, default 1.5)
 * @param {boolean} opts.doHDRMT - Apply HDRMT after LHE (default true)
 * @param {number} opts.hdrmtLayers - HDRMT layers (4-7, default 5)
 * @param {boolean} opts.hdrmtMedianTransform - Use median transform (default true for star fields)
 * @returns {object} { before, after, improvement, details }
 */
export async function multiScaleEnhance(ctx, viewId, opts = {}) {
  const maskClipLow = opts.maskClipLow ?? 0.06;
  const maskBlur = opts.maskBlur ?? 5;
  const maskGamma = opts.maskGamma ?? 2.0;
  const lheFineR = opts.lheFineRadius ?? 24;
  const lheFineA = opts.lheFineAmount ?? 0.20;
  const lheMidR = opts.lheMidRadius ?? 48;
  const lheMidA = opts.lheMidAmount ?? 0.30;
  const lheLargeR = opts.lheLargeRadius ?? 100;
  const lheLargeA = opts.lheLargeAmount ?? 0.30;
  const slopeLimit = opts.lheSlopeLimit ?? 1.5;
  const doHDRMT = opts.doHDRMT !== false;
  const hdrmtLayers = opts.hdrmtLayers ?? 5;
  const hdrmtMedian = opts.hdrmtMedianTransform !== false;

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('View not found: ${viewId}');
    var img = w.mainView.image;

    // === MEASURE BEFORE ===
    function measureDetail() {
      var bgMed = img.median();
      var bgMAD = img.MAD();
      var threshold = bgMed + 8 * 1.4826 * bgMAD;

      // Sobel energy in bright regions
      var totalEnergy = 0;
      var count = 0;
      var brightCount = 0;
      var step = 8;

      function getLum(x, y) {
        if (img.isColor) {
          return 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
        }
        return img.sample(x, y);
      }

      for (var y = 1; y < img.height - 1; y += step) {
        for (var x = 1; x < img.width - 1; x += step) {
          var lum = getLum(x, y);
          if (lum > threshold) {
            brightCount++;
            var tl = getLum(x-1,y-1), tc = getLum(x,y-1), tr = getLum(x+1,y-1);
            var ml = getLum(x-1,y),                        mr = getLum(x+1,y);
            var bl = getLum(x-1,y+1), bc = getLum(x,y+1), br = getLum(x+1,y+1);
            var gx = -tl + tr - 2*ml + 2*mr - bl + br;
            var gy = -tl - 2*tc - tr + bl + 2*bc + br;
            totalEnergy += gx*gx + gy*gy;
            count++;
          }
        }
      }

      return {
        detailScore: count > 0 ? totalEnergy / count : 0,
        brightPixels: brightCount,
        bgMedian: bgMed,
        bgMAD: bgMAD
      };
    }

    var before = measureDetail();

    // === CREATE LUMINANCE MASK ===
    var maskId = '__mse_mask';
    var maskWin = ImageWindow.windowById(maskId);
    if (!maskWin.isNull) maskWin.forceClose();

    // Extract luminance for mask
    if (img.isColor) {
      var CE = new ChannelExtraction;
      CE.colorSpace = ChannelExtraction.prototype.CIELab;
      CE.channels = [[true, maskId], [false, ''], [false, '']];
      CE.executeOn(w.mainView);
    } else {
      // Clone for mono
      w.mainView.window.cloneView(w.mainView, maskId);
    }
    processEvents();

    maskWin = ImageWindow.windowById(maskId);
    if (maskWin.isNull) throw new Error('Failed to create luminance mask');

    // Clip low, apply gamma, blur
    var PM = new PixelMath;
    PM.expression = 'max((' + maskId + ' - ${maskClipLow}) / (1 - ${maskClipLow}), 0)';
    PM.useSingleExpression = true;
    PM.createNewImage = false;
    PM.executeOn(maskWin.mainView);
    processEvents();

    if (${maskGamma} !== 1.0) {
      var PM2 = new PixelMath;
      PM2.expression = 'exp(${1.0/maskGamma} * ln(max(' + maskId + ', 0.0001)))';
      PM2.useSingleExpression = true;
      PM2.createNewImage = false;
      PM2.executeOn(maskWin.mainView);
      processEvents();
    }

    if (${maskBlur} > 0) {
      var blur = new Convolution;
      blur.mode = Convolution.prototype.Parametric;
      blur.sigma = ${maskBlur};
      blur.shape = 2;
      blur.executeOn(maskWin.mainView);
      processEvents();
    }

    // Apply mask
    w.mask = maskWin;
    w.maskVisible = false;
    w.maskInverted = false;

    // === LHE PASS 1: LARGE SCALE ===
    var LHE1 = new LocalHistogramEqualization;
    LHE1.radius = ${lheLargeR};
    LHE1.slopeLimit = ${slopeLimit};
    LHE1.amount = ${lheLargeA};
    LHE1.circularKernel = true;
    LHE1.executeOn(w.mainView);
    processEvents();

    // === LHE PASS 2: MID SCALE ===
    var LHE2 = new LocalHistogramEqualization;
    LHE2.radius = ${lheMidR};
    LHE2.slopeLimit = ${slopeLimit};
    LHE2.amount = ${lheMidA};
    LHE2.circularKernel = true;
    LHE2.executeOn(w.mainView);
    processEvents();

    // === LHE PASS 3: FINE SCALE ===
    var LHE3 = new LocalHistogramEqualization;
    LHE3.radius = ${lheFineR};
    LHE3.slopeLimit = ${Math.min(slopeLimit, 1.3)};
    LHE3.amount = ${lheFineA};
    LHE3.circularKernel = true;
    LHE3.executeOn(w.mainView);
    processEvents();

    // === HDRMT (optional) ===
    ${doHDRMT ? `
    var HDRMT = new HDRMultiscaleTransform;
    HDRMT.numberOfLayers = ${hdrmtLayers};
    HDRMT.numberOfIterations = 1;
    HDRMT.invertedIterations = true;
    HDRMT.medianTransform = ${hdrmtMedian};
    HDRMT.toLightness = ${opts.toLightness !== false ? 'true' : 'false'};
    HDRMT.lightnessMask = true;
    HDRMT.executeOn(w.mainView);
    processEvents();
    ` : ''}

    // Remove mask
    w.removeMask();
    maskWin.forceClose();
    processEvents();

    // === MEASURE AFTER ===
    var after = measureDetail();

    var improvement = before.detailScore > 0 ? ((after.detailScore - before.detailScore) / before.detailScore * 100) : 0;

    JSON.stringify({
      before: before,
      after: after,
      improvement: improvement,
      params: {
        mask: { clipLow: ${maskClipLow}, blur: ${maskBlur}, gamma: ${maskGamma} },
        lhe: { fine: { r: ${lheFineR}, a: ${lheFineA} }, mid: { r: ${lheMidR}, a: ${lheMidA} }, large: { r: ${lheLargeR}, a: ${lheLargeA} }, slope: ${slopeLimit} },
        hdrmt: { layers: ${hdrmtLayers}, median: ${hdrmtMedian}, applied: ${doHDRMT} }
      }
    });
  `);

  if (r.status === 'error') {
    return {
      error: r.error?.message || 'PJSR error',
      details: 'Multi-scale enhancement failed'
    };
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { error: 'Failed to parse output' };
  }

  const details = [];
  details.push(`Detail score: ${data.before.detailScore.toFixed(6)} → ${data.after.detailScore.toFixed(6)} (${data.improvement > 0 ? '+' : ''}${data.improvement.toFixed(1)}%)`);
  if (data.improvement < 5) {
    details.push('WARNING: Less than 5% improvement — mask may be too tight or amounts too low. Try softer mask or higher amounts.');
  } else if (data.improvement > 50) {
    details.push('Strong improvement. Check for artifacts (ringing, noise amplification).');
  }

  return {
    before: data.before,
    after: data.after,
    improvement: data.improvement,
    params: data.params,
    details: details.join(' ')
  };
}
