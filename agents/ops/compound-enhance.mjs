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

  // Auto-create pre-detail reference clone for highlight-texture comparison
  const refCloneId = `__ref_pre_detail_${viewId}`;
  try {
    await ctx.pjsr(`
      var old = ImageWindow.windowById('${refCloneId}');
      if (!old.isNull) old.forceClose();
      var src = ImageWindow.windowById('${viewId}');
      if (src.isNull) throw new Error('multiScaleEnhance: view not found for ref clone: ${viewId}');
      var img = src.mainView.image;
      var clone = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, true, img.isColor, '${refCloneId}');
      clone.mainView.beginProcess();
      clone.mainView.image.assign(img);
      clone.mainView.endProcess();
      clone.hide();
    `);
  } catch (e) {
    // Non-fatal — highlight texture check will fall back to advisory mode
  }

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
    referenceCloneId: refCloneId,
    params: data.params,
    details: details.join(' ') + ` Reference clone: ${refCloneId} (use with check_highlight_texture)`
  };
}

/**
 * Shell-safe detail enhancement via multi-scale high-pass decomposition.
 *
 * Unlike multi_scale_enhance (LHE-based, pushes brightness), this tool
 * extracts detail at specific spatial scales and amplifies it while
 * preserving the smooth brightness component. Brightness-neutral by design.
 *
 * For each scale:
 *   1. Create smoothed version (Gaussian blur at target sigma)
 *   2. Detail layer = original - smoothed (locally zero-mean)
 *   3. Soft protection factor = exp(-softness * max(0, lum - knee) / (1 - knee))
 *      Attenuates enhancement near bright peaks to prevent ANY upward push.
 *   4. Result = original + amount × detail × protection (through optional mask)
 *
 * The detail layer sums to ~0 locally, so overall brightness is unchanged.
 * The protection factor ensures bright peaks receive near-zero enhancement.
 * No hard ceiling needed — the tool cannot significantly increase max pixel value.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View to enhance (modified in place)
 * @param {object} opts
 * @param {string} opts.maskId - Shell zone mask (auto-created if omitted + autoZone=true)
 * @param {number} opts.mediumSigma - Filament-scale blur sigma (default 18, range 10-30)
 * @param {number} opts.mediumAmount - Filament boost (default 1.0, range 0.3-2.5)
 * @param {number} opts.largeSigma - Regional tonal gradient sigma (default 55, range 35-80)
 * @param {number} opts.largeAmount - Regional boost (default 0.5, range 0.0-1.5)
 * @param {number} opts.protectKnee - Luminance where attenuation begins (default 0.80)
 * @param {number} opts.protectSoftness - Attenuation rate (default 4.0)
 * @param {boolean} opts.autoZone - Auto-create adaptive shell mask (default true)
 * @returns {object} { before, after, improvement, maxAfter, protectionEngaged, params }
 */
export async function shellDetailEnhance(ctx, viewId, opts = {}) {
  const medSigma = opts.mediumSigma ?? 18;
  const medAmount = opts.mediumAmount ?? 1.0;
  const lgSigma = opts.largeSigma ?? 55;
  const lgAmount = opts.largeAmount ?? 0.5;
  const knee = opts.protectKnee ?? 0.80;
  const softness = opts.protectSoftness ?? 4.0;
  const maskId = opts.maskId || null;
  const autoZone = opts.autoZone !== false;

  // Auto-create pre-detail reference clone for highlight-texture comparison
  const refCloneId = `__ref_pre_detail_${viewId}`;
  try {
    await ctx.pjsr(`
      var old = ImageWindow.windowById('${refCloneId}');
      if (!old.isNull) old.forceClose();
      var src = ImageWindow.windowById('${viewId}');
      if (src.isNull) throw new Error('shellDetailEnhance: view not found for ref clone: ${viewId}');
      var img = src.mainView.image;
      var clone = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, true, img.isColor, '${refCloneId}');
      clone.mainView.beginProcess();
      clone.mainView.image.assign(img);
      clone.mainView.endProcess();
      clone.hide();
    `);
  } catch (e) {
    // Non-fatal — highlight texture check will fall back to advisory mode
  }

  // Auto-create shell mask if needed
  let createdMask = false;
  let shellMaskId = maskId;
  if (!shellMaskId && autoZone) {
    try {
      const { createAdaptiveZoneMasks } = await import('./narrowband-enhance.mjs');
      const zones = await createAdaptiveZoneMasks(ctx, viewId, { roi: opts.roi });
      shellMaskId = zones.shellId;
      createdMask = true;
    } catch (e) {
      // Fall back to no mask
      shellMaskId = null;
    }
  }

  const hasMask = !!shellMaskId;
  const oneMinusKnee = Math.max(0.01, 1.0 - knee);

  // Pre-query color status in Node.js scope so template interpolation works
  const colorCheckResult = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('shellDetailEnhance: view not found: ${viewId}');
    JSON.stringify({ isColor: w.mainView.image.isColor });
  `);
  const imageIsColor = JSON.parse(colorCheckResult.outputs?.consoleOutput || '{}').isColor;

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('shellDetailEnhance: view not found: ${viewId}');
    var img = w.mainView.image;
    var isColor = img.isColor;
    var W = img.width, H = img.height;

    function getLum(px, py) {
      if (isColor) {
        return 0.2126 * img.sample(px, py, 0) + 0.7152 * img.sample(px, py, 1) + 0.0722 * img.sample(px, py, 2);
      }
      return img.sample(px, py);
    }

    // Measure shell texture before (in shell zone or all bright pixels)
    var bgMedian = img.median();
    var bgMAD = img.MAD();
    var subTh = bgMedian + 5 * 1.4826 * bgMAD;
    var beforeEnergy = 0, beforeCount = 0;
    var beforeVals = [];
    var step = 8;
    for (var y = 1; y < H-1; y += step) {
      for (var x = 1; x < W-1; x += step) {
        var lum = getLum(x, y);
        if (lum > subTh && lum < 0.98) {
          beforeVals.push(lum);
          var tl = getLum(x-1,y-1), tc = getLum(x,y-1), tr = getLum(x+1,y-1);
          var ml = getLum(x-1,y),                        mr = getLum(x+1,y);
          var bl = getLum(x-1,y+1), bc = getLum(x,y+1), br = getLum(x+1,y+1);
          var gx = -tl + tr - 2*ml + 2*mr - bl + br;
          var gy = -tl - 2*tc - tr + bl + 2*bc + br;
          beforeEnergy += gx*gx + gy*gy;
          beforeCount++;
        }
      }
    }
    var beforeGrad = beforeCount > 0 ? beforeEnergy / beforeCount : 0;

    // Local stddev before
    var bs = 16;
    var bStdDevs = [];
    for (var by = 0; by < H - bs; by += bs) {
      for (var bx = 0; bx < W - bs; bx += bs) {
        var vals = [], shellN = 0;
        for (var py = by; py < by+bs; py += 2) {
          for (var px = bx; px < bx+bs; px += 2) {
            if (px >= W || py >= H) continue;
            var l = getLum(px, py);
            vals.push(l);
            if (l > subTh && l < 0.98) shellN++;
          }
        }
        if (shellN < vals.length * 0.3) continue;
        var s = 0, s2 = 0;
        for (var k = 0; k < vals.length; k++) { s += vals[k]; s2 += vals[k]*vals[k]; }
        var mn = s / vals.length;
        var v = s2 / vals.length - mn*mn;
        if (v > 0) bStdDevs.push(Math.sqrt(v));
      }
    }
    bStdDevs.sort(function(a,b){return a-b;});
    var beforeStdDev = bStdDevs.length > 0 ? bStdDevs[Math.floor(bStdDevs.length/2)] : 0;

    // Apply mask if available
    ${hasMask ? `
    var maskW = ImageWindow.windowById('${shellMaskId}');
    if (!maskW.isNull) {
      w.mask = maskW;
      w.maskVisible = false;
      w.maskInverted = false;
    }` : '// No mask'}

    // Scale 1: medium (filament scale)
    if (${medAmount} > 0.01) {
      var blurId1 = '__shell_blur1';
      var oldB1 = ImageWindow.windowById(blurId1);
      if (!oldB1.isNull) oldB1.forceClose();

      // Clone view for blur
      var blurW1 = new ImageWindow(W, H, isColor ? 3 : 1, 32, true, isColor, blurId1);
      blurW1.mainView.beginProcess();
      blurW1.mainView.image.assign(img);
      blurW1.mainView.endProcess();
      blurW1.show();

      // Blur at medium sigma
      var conv1 = new Convolution;
      conv1.mode = Convolution.prototype.Parametric;
      conv1.sigma = ${medSigma};
      conv1.shape = 2;
      conv1.aspectRatio = 1;
      conv1.rotationAngle = 0;
      conv1.executeOn(blurW1.mainView);

      // PixelMath: $T + amount * ($T - blur) * protection
      // protection = exp(-softness * max(0, lum - knee) / (1 - knee))
      var PM1 = new PixelMath;
      var protExpr = 'exp(-${softness} * max(0, (0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2]) - ${knee}) / ${oneMinusKnee})';
      ${imageIsColor ? `
      var expr1 = '$T + ${medAmount} * ($T - ' + blurId1 + ') * ' + protExpr;
      PM1.expression = expr1;
      PM1.expression1 = expr1;
      PM1.expression2 = expr1;
      PM1.useSingleExpression = false;` : `
      var protMono = 'exp(-${softness} * max(0, $T - ${knee}) / ${oneMinusKnee})';
      PM1.expression = '$T + ${medAmount} * ($T - ' + blurId1 + ') * ' + protMono;
      PM1.useSingleExpression = true;`}
      PM1.use64BitWorkingImage = true;
      PM1.truncate = true;
      PM1.truncateLower = 0;
      PM1.truncateUpper = 1;
      PM1.createNewImage = false;
      PM1.executeOn(w.mainView);

      blurW1.forceClose();
    }

    // Scale 2: large (regional tonal gradients)
    if (${lgAmount} > 0.01) {
      var blurId2 = '__shell_blur2';
      var oldB2 = ImageWindow.windowById(blurId2);
      if (!oldB2.isNull) oldB2.forceClose();

      var blurW2 = new ImageWindow(W, H, isColor ? 3 : 1, 32, true, isColor, blurId2);
      blurW2.mainView.beginProcess();
      blurW2.mainView.image.assign(img);
      blurW2.mainView.endProcess();
      blurW2.show();

      var conv2 = new Convolution;
      conv2.mode = Convolution.prototype.Parametric;
      conv2.sigma = ${lgSigma};
      conv2.shape = 2;
      conv2.aspectRatio = 1;
      conv2.rotationAngle = 0;
      conv2.executeOn(blurW2.mainView);

      var PM2 = new PixelMath;
      var protExpr2 = 'exp(-${softness} * max(0, (0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2]) - ${knee}) / ${oneMinusKnee})';
      ${imageIsColor ? `
      var expr2 = '$T + ${lgAmount} * ($T - ' + blurId2 + ') * ' + protExpr2;
      PM2.expression = expr2;
      PM2.expression1 = expr2;
      PM2.expression2 = expr2;
      PM2.useSingleExpression = false;` : `
      var protMono2 = 'exp(-${softness} * max(0, $T - ${knee}) / ${oneMinusKnee})';
      PM2.expression = '$T + ${lgAmount} * ($T - ' + blurId2 + ') * ' + protMono2;
      PM2.useSingleExpression = true;`}
      PM2.use64BitWorkingImage = true;
      PM2.truncate = true;
      PM2.truncateLower = 0;
      PM2.truncateUpper = 1;
      PM2.createNewImage = false;
      PM2.executeOn(w.mainView);

      blurW2.forceClose();
    }

    // Remove mask
    ${hasMask ? 'w.removeMask();' : ''}

    // Measure after
    img = w.mainView.image; // re-read
    var afterEnergy = 0, afterCount = 0;
    var maxAfter = 0;
    var protEngaged = 0, totalEnhanced = 0;
    for (var y = 1; y < H-1; y += step) {
      for (var x = 1; x < W-1; x += step) {
        var lum = getLum(x, y);
        if (lum > maxAfter) maxAfter = lum;
        if (lum > subTh && lum < 0.98) {
          var tl = getLum(x-1,y-1), tc = getLum(x,y-1), tr = getLum(x+1,y-1);
          var ml = getLum(x-1,y),                        mr = getLum(x+1,y);
          var bl = getLum(x-1,y+1), bc = getLum(x,y+1), br = getLum(x+1,y+1);
          var gx = -tl + tr - 2*ml + 2*mr - bl + br;
          var gy = -tl - 2*tc - tr + bl + 2*bc + br;
          afterEnergy += gx*gx + gy*gy;
          afterCount++;
          totalEnhanced++;
          var prot = Math.exp(-${softness} * Math.max(0, lum - ${knee}) / ${oneMinusKnee});
          if (prot < 0.5) protEngaged++;
        }
      }
    }
    var afterGrad = afterCount > 0 ? afterEnergy / afterCount : 0;

    // Local stddev after
    var aStdDevs = [];
    for (var by = 0; by < H - bs; by += bs) {
      for (var bx = 0; bx < W - bs; bx += bs) {
        var vals = [], shellN = 0;
        for (var py = by; py < by+bs; py += 2) {
          for (var px = bx; px < bx+bs; px += 2) {
            if (px >= W || py >= H) continue;
            var l = getLum(px, py);
            vals.push(l);
            if (l > subTh && l < 0.98) shellN++;
          }
        }
        if (shellN < vals.length * 0.3) continue;
        var s = 0, s2 = 0;
        for (var k = 0; k < vals.length; k++) { s += vals[k]; s2 += vals[k]*vals[k]; }
        var mn = s / vals.length;
        var v = s2 / vals.length - mn*mn;
        if (v > 0) aStdDevs.push(Math.sqrt(v));
      }
    }
    aStdDevs.sort(function(a,b){return a-b;});
    var afterStdDev = aStdDevs.length > 0 ? aStdDevs[Math.floor(aStdDevs.length/2)] : 0;

    var improvement = beforeGrad > 0 ? ((afterGrad - beforeGrad) / beforeGrad) * 100 : 0;

    JSON.stringify({
      before: { gradientEnergy: beforeGrad, shellLocalStdDev: beforeStdDev },
      after: { gradientEnergy: afterGrad, shellLocalStdDev: afterStdDev },
      improvement: improvement,
      stddevImprovement: beforeStdDev > 0 ? ((afterStdDev - beforeStdDev) / beforeStdDev) * 100 : 0,
      maxAfter: maxAfter,
      protectionEngaged: totalEnhanced > 0 ? (protEngaged / totalEnhanced * 100) : 0,
      params: {
        mediumSigma: ${medSigma}, mediumAmount: ${medAmount},
        largeSigma: ${lgSigma}, largeAmount: ${lgAmount},
        protectKnee: ${knee}, protectSoftness: ${softness},
        hasMask: ${hasMask}
      }
    });
  `);

  // Clean up auto-created masks
  if (createdMask) {
    try {
      await ctx.pjsr(`
        var ids = ['azone_core', 'azone_shell', 'azone_outer'];
        for (var i = 0; i < ids.length; i++) {
          var mw = ImageWindow.windowById(ids[i]);
          if (!mw.isNull) mw.forceClose();
        }
      `);
    } catch {}
  }

  if (r.status === 'error') {
    throw new Error('shellDetailEnhance failed: ' + (r.error?.message || 'unknown'));
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { error: 'Failed to parse output' };
  }

  return {
    before: data.before,
    after: data.after,
    improvement: data.improvement,
    stddevImprovement: data.stddevImprovement,
    maxAfter: data.maxAfter,
    protectionEngaged: data.protectionEngaged?.toFixed(1) + '%',
    referenceCloneId: refCloneId,
    params: data.params,
    details: `Shell detail: gradient ${data.improvement > 0 ? '+' : ''}${data.improvement?.toFixed(1)}%, ` +
      `stddev ${data.stddevImprovement > 0 ? '+' : ''}${data.stddevImprovement?.toFixed(1)}%, ` +
      `max=${data.maxAfter?.toFixed(4)}, protection engaged on ${data.protectionEngaged?.toFixed(1)}% of pixels. ` +
      `Reference clone: ${refCloneId} (use with check_highlight_texture)`
  };
}
