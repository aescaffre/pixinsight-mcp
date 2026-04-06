// ============================================================================
// Narrowband Enhancement — extract and process emission signals from broadband
//
// For targets like planetary nebulae where narrowband signal (Ha, OIII) is
// captured in broadband filters (R, B), these tools extract the emission
// component and create narrowband-quality results from broadband data.
// ============================================================================

/**
 * Extract pseudo-OIII from B channel by subtracting scaled continuum.
 * OIII (496+501nm) is captured by typical B filters (390-500nm).
 * Subtracting scaled R (which has no OIII) removes the continuum.
 *
 * Creates a new view with the extracted emission signal.
 *
 * @param {object} ctx - Bridge context
 * @param {string} rgbId - RGB view ID (must be color)
 * @param {number} factor - Continuum scaling factor (0.10-0.50, default 0.25)
 * @param {string} outputId - Output view ID (default: 'OIII_pseudo')
 * @returns {object} { viewId, median, max }
 */
export async function extractPseudoOIII(ctx, rgbId, factor = 0.25, outputId = 'OIII_pseudo', { denoise = 0.15 } = {}) {
  // Extract B channel, subtract scaled R as continuum estimate
  // OIII_pseudo = max(0, B - factor * R)
  // Then normalize to bring the emission signal into a useful range
  const r = await ctx.pjsr(`
    var src = ImageWindow.windowById('${rgbId}');
    if (src.isNull) throw new Error('extractPseudoOIII: source not found: ${rgbId}');
    var img = src.mainView.image;
    if (!img.isColor) throw new Error('extractPseudoOIII: source must be color');

    // Close existing output if any
    var old = ImageWindow.windowById('${outputId}');
    if (!old.isNull) old.forceClose();

    // Create new mono image for OIII
    var w = img.width;
    var h = img.height;
    var outW = new ImageWindow(w, h, 1, 32, true, false, '${outputId}');
    var outImg = outW.mainView.image;

    // Extract: OIII = max(0, B - factor * R)
    outW.mainView.beginProcess();
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var b = img.sample(x, y, 2);
        var r = img.sample(x, y, 0);
        var val = Math.max(0, b - ${factor} * r);
        outImg.setSample(val, x, y);
      }
    }
    outW.mainView.endProcess();

    // Optional NXT denoise to clean up noise from B-R subtraction
    var denoiseVal = ${denoise};
    if (denoiseVal > 0) {
      var P = new NoiseXTerminator;
      P.denoise = denoiseVal;
      P.detail = 0.50;
      P.executeOn(outW.mainView);
    }

    outW.show();

    // Stats (re-read after potential denoise)
    outImg = outW.mainView.image;
    var med = outImg.median();
    var mx = outImg.maximum();
    JSON.stringify({ viewId: '${outputId}', median: med, max: mx, width: w, height: h, denoised: denoiseVal > 0 });
  `);

  if (r.status === 'error') {
    throw new Error('extractPseudoOIII failed: ' + (r.error?.message || 'unknown'));
  }

  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

/**
 * Continuum-subtract Ha to isolate pure emission signal.
 * Removes broadband continuum: Ha_pure = max(0, Ha - factor * R)
 * This reduces star contamination and isolates emission structures.
 *
 * Modifies the Ha view in-place.
 *
 * @param {object} ctx - Bridge context
 * @param {string} haId - Ha view ID (mono)
 * @param {string} rgbId - RGB view ID (for R channel continuum)
 * @param {number} factor - Continuum factor (0.20-0.40, default 0.28)
 * @returns {object} { median, max }
 */
export async function continuumSubtractHa(ctx, haId, rgbId, factor = 0.28) {
  const r = await ctx.pjsr(`
    var PM = new PixelMath;
    PM.expression = "max(0, ${haId} - ${factor} * ${rgbId}[0])";
    PM.useSingleExpression = true;
    PM.use64BitWorkingImage = true;
    PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
    PM.createNewImage = false;
    PM.executeOn(ImageWindow.windowById('${haId}').mainView);

    var img = ImageWindow.windowById('${haId}').mainView.image;
    JSON.stringify({ median: img.median(), max: img.maximum() });
  `);

  if (r.status === 'error') {
    throw new Error('continuumSubtractHa failed: ' + (r.error?.message || 'unknown'));
  }

  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

/**
 * Dynamic narrowband color blend — creates rich emission-line color
 * from Ha and pseudo-OIII using the community dynamic weighting formula.
 *
 * The formula naturally separates Ha-dominant regions (red) from
 * OIII-dominant regions (teal) with smooth transitions:
 *   R += ha_strength * Ha
 *   G += dynamic_weight * Ha + (1-dynamic_weight) * OIII * g_strength
 *   B += oiii_strength * OIII
 * where dynamic_weight = (OIII*Ha)^(1-(OIII*Ha))
 *
 * Applied through a luminance mask to protect background from blue
 * contamination caused by OIII noise residuals in the B-R subtraction.
 *
 * @param {object} ctx - Bridge context
 * @param {string} targetId - Target RGB view
 * @param {string} haId - Ha view (mono, stretched)
 * @param {string} oiiiId - OIII view (mono, real or pseudo)
 * @param {object} opts - { ha_strength, oiii_strength, g_strength, max_output, mask_clip }
 * @param {number} [opts.mask_clip=0.04] - Luminance mask clip threshold; pixels below this are excluded from blend
 * @returns {object} { median, max, rMax, bMax, maskClip }
 */
export async function dynamicNarrowbandBlend(ctx, targetId, haId, oiiiId, opts = {}) {
  const haStr = opts.ha_strength ?? 0.35;
  const oiiiStr = opts.oiii_strength ?? 0.40;
  const gStr = opts.g_strength ?? 0.30;
  const maxOut = opts.max_output ?? 0.90;
  const maskClip = opts.mask_clip ?? 0.04;

  // Dynamic weight: where both Ha and OIII are bright → Ha dominates G (warm core)
  // where OIII alone is bright → OIII dominates G (teal shell)
  // PixelMath: pow not available, use exp(b*ln(a))
  // f = (OIII*Ha)^(1-(OIII*Ha)) = exp((1-OIII*Ha)*ln(max(OIII*Ha, 0.00001)))
  //
  // Applied through a luminance mask to prevent background contamination:
  // OIII pseudo (B-R) has noise residuals that, when multiplied by oiii_strength,
  // create a blue color cast across the entire background. The mask ensures
  // the blend only affects nebula/subject regions.
  const r = await ctx.pjsr(`
    var tgtW = ImageWindow.windowById('${targetId}');
    if (tgtW.isNull) throw new Error('dynamicNarrowbandBlend: target not found: ${targetId}');
    var img = tgtW.mainView.image;
    var w = img.width;
    var h = img.height;

    // --- Create temporary luminance mask to protect background ---
    var nbMaskId = '__nb_blend_mask';
    var oldMask = ImageWindow.windowById(nbMaskId);
    if (!oldMask.isNull) oldMask.forceClose();

    var maskW = new ImageWindow(w, h, 1, 32, true, false, nbMaskId);
    var maskImg = maskW.mainView.image;

    // Extract luminance from target
    maskW.mainView.beginProcess();
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var lum = 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
        maskImg.setSample(lum, x, y);
      }
    }
    maskW.mainView.endProcess();

    // Blur the mask for smooth transitions
    var C = new Convolution;
    C.mode = Convolution.prototype.Parametric;
    C.sigma = 10;
    C.shape = 2;
    C.aspectRatio = 1;
    C.rotationAngle = 0;
    C.executeOn(maskW.mainView);

    // Clip mask: values below mask_clip become zero (background excluded),
    // remap remaining range to 0-1
    var clipVal = ${maskClip};
    if (clipVal > 0) {
      var PMclip = new PixelMath;
      PMclip.expression = 'iif($T<' + clipVal + ',0,($T-' + clipVal + ')/' + (1 - clipVal).toFixed(6) + ')';
      PMclip.useSingleExpression = true;
      PMclip.createNewImage = false;
      PMclip.use64BitWorkingImage = true;
      PMclip.truncate = true;
      PMclip.truncateLower = 0;
      PMclip.truncateUpper = 1;
      PMclip.executeOn(maskW.mainView);
    }

    maskW.show();

    // Apply mask to target
    tgtW.mask = maskW;
    tgtW.maskVisible = false;
    tgtW.maskInverted = false;

    // --- Apply narrowband blend (only affects masked areas = nebula) ---
    var PM = new PixelMath;
    // R: add Ha emission
    var rawR = "${targetId}[0] + ${haStr} * ${haId}";
    PM.expression = "iif(" + rawR + " > ${maxOut}, ${maxOut} + (" + rawR + " - ${maxOut}) * 0.20, " + rawR + ")";

    // G: dynamic blend of Ha and OIII
    // f = (OIII*Ha)^(1-OIII*Ha) — high where both are bright, low where one dominates
    var product = "${oiiiId} * ${haId}";
    var dynWeight = "exp((1 - " + product + ") * ln(max(" + product + ", 0.00001)))";
    var rawG = "${targetId}[1] + " + dynWeight + " * ${haStr} * 0.3 * ${haId} + (1 - " + dynWeight + ") * ${gStr} * ${oiiiId}";
    PM.expression1 = "iif(" + rawG + " > ${maxOut}, ${maxOut} + (" + rawG + " - ${maxOut}) * 0.20, " + rawG + ")";

    // B: add OIII emission
    var rawB = "${targetId}[2] + ${oiiiStr} * ${oiiiId}";
    PM.expression2 = "iif(" + rawB + " > ${maxOut}, ${maxOut} + (" + rawB + " - ${maxOut}) * 0.20, " + rawB + ")";

    PM.useSingleExpression = false;
    PM.use64BitWorkingImage = true;
    PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
    PM.createNewImage = false;
    PM.executeOn(tgtW.mainView);

    // --- Remove and close the mask ---
    tgtW.removeMask();
    maskW.forceClose();

    var finalImg = tgtW.mainView.image;
    finalImg.selectedChannel = 0; var rMax = finalImg.maximum();
    finalImg.selectedChannel = 2; var bMax = finalImg.maximum();
    finalImg.resetChannelSelection();
    JSON.stringify({ median: finalImg.median(), max: finalImg.maximum(), rMax: rMax, bMax: bMax, maskClip: clipVal });
  `);

  if (r.status === 'error') {
    throw new Error('dynamicNarrowbandBlend failed: ' + (r.error?.message || 'unknown'));
  }

  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

/**
 * Create synthetic emission luminance from Ha + OIII.
 * For emission objects, this gives better nebula contrast than broadband L.
 *
 * Creates a new view: synth_L = ha_weight * Ha + oiii_weight * OIII
 * Normalized so max ≤ 0.96.
 *
 * @param {object} ctx - Bridge context
 * @param {string} haId - Ha view (mono)
 * @param {string} oiiiId - OIII view (mono, real or pseudo)
 * @param {number} haWeight - Ha contribution (default 0.50)
 * @param {number} oiiiWeight - OIII contribution (default 0.50)
 * @param {string} outputId - Output view ID (default 'SYNTH_L')
 * @returns {object} { viewId, median, max }
 */
export async function createSyntheticLuminance(ctx, haId, oiiiId, haWeight = 0.50, oiiiWeight = 0.50, outputId = 'SYNTH_L') {
  const r = await ctx.pjsr(`
    // Close existing
    var old = ImageWindow.windowById('${outputId}');
    if (!old.isNull) old.forceClose();

    var PM = new PixelMath;
    PM.expression = "min(${haWeight} * ${haId} + ${oiiiWeight} * ${oiiiId}, 0.96)";
    PM.useSingleExpression = true;
    PM.use64BitWorkingImage = true;
    PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
    PM.createNewImage = true;
    PM.newImageId = '${outputId}';
    PM.newImageWidth = 0; PM.newImageHeight = 0; // inherit
    PM.newImageColorSpace = 0; // grayscale
    PM.executeOn(ImageWindow.windowById('${haId}').mainView);

    var img = ImageWindow.windowById('${outputId}').mainView.image;
    JSON.stringify({ viewId: '${outputId}', median: img.median(), max: img.maximum() });
  `);

  if (r.status === 'error') {
    throw new Error('createSyntheticLuminance failed: ' + (r.error?.message || 'unknown'));
  }

  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

/**
 * Continuous brightness clamping using a smooth luminance mask.
 * Replaces discrete zone-mask clamping (core/shell/halo) which creates
 * visible boundary artifacts at mask edges.
 *
 * How it works:
 *   1. Extract luminance, blur with LARGE sigma (60-100px proportional to image)
 *   2. Compute per-pixel knee level:
 *      knee = min_clamp + (max_clamp - min_clamp) * (1 - smooth_lum)
 *      Bright core (mask~1.0) → knee near min_clamp (0.80)
 *      Shell (mask~0.5)       → knee near midpoint (0.875)
 *      Background (mask~0)    → knee near max_clamp (0.95)
 *   3. Soft compression (default): values above knee are smoothly compressed
 *      using exponential saturation, preserving relative brightness:
 *        result = knee + headroom * (1 - exp(-rate * (pixel - knee) / headroom))
 *      Hard mode (legacy): result = min(pixel, knee)
 *
 * Soft mode preserves detail within bright areas — a pixel at 0.90 and one at 0.85
 * remain distinguishable after compression. Hard mode flattens both to the knee.
 *
 * Zero boundary artifacts because the mask is a single continuous gradient.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - Target view to clamp (modified in place)
 * @param {object} opts - { min_clamp, max_clamp, blur_sigma, mode, headroom, rate }
 *   mode: 'soft' (default) or 'hard'
 *   headroom: how far above knee the compression allows (default 0.12)
 *   rate: compression steepness (default 3.0; higher = more aggressive)
 * @returns {object} { median, max, clampRange: [min_clamp, max_clamp], blur_sigma, mode }
 */
export async function continuousClamp(ctx, viewId, opts = {}) {
  const minClamp = opts.min_clamp ?? 0.80;
  const maxClamp = opts.max_clamp ?? 0.95;
  const mode = opts.mode ?? 'soft';       // 'soft' (exponential compression) or 'hard' (min clamp)
  const headroom = opts.headroom ?? 0.12; // soft mode: how far above knee the output can reach
  const rate = opts.rate ?? 3.0;          // soft mode: compression steepness (higher = more aggressive)
  // blur_sigma: default auto = max(60, imageWidth/100)
  const blurSigmaExpr = opts.blur_sigma != null ? String(opts.blur_sigma) : null;
  const range = maxClamp - minClamp;

  const r = await ctx.pjsr(`
    var src = ImageWindow.windowById('${viewId}');
    if (src.isNull) throw new Error('continuousClamp: view not found: ${viewId}');
    var img = src.mainView.image;
    var w = img.width;
    var h = img.height;

    // Determine blur sigma
    var blurSigma = ${blurSigmaExpr !== null ? blurSigmaExpr : 'Math.max(60, Math.round(w / 100))'};

    // Close any existing temp mask
    var tmpId = '__cont_clamp_lum';
    var old = ImageWindow.windowById(tmpId);
    if (!old.isNull) old.forceClose();

    // Create luminance mask from source
    var maskW = new ImageWindow(w, h, 1, 32, true, false, tmpId);
    var maskImg = maskW.mainView.image;

    var isColor = img.isColor;
    maskW.mainView.beginProcess();
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var lum;
        if (isColor) {
          lum = 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
        } else {
          lum = img.sample(x, y);
        }
        maskImg.setSample(lum, x, y);
      }
    }
    maskW.mainView.endProcess();

    // Apply large Gaussian blur for perfectly smooth transitions
    var conv = new Convolution;
    conv.mode = Convolution.prototype.Parametric;
    conv.sigma = blurSigma;
    conv.shape = 2;
    conv.aspectRatio = 1;
    conv.rotationAngle = 0;
    conv.executeOn(maskW.mainView);

    // Normalize mask to 0-1 range (after blur, max may have shifted)
    var mMax = maskImg.maximum();
    if (mMax > 0) {
      maskW.mainView.beginProcess();
      for (var y2 = 0; y2 < h; y2++) {
        for (var x2 = 0; x2 < w; x2++) {
          maskImg.setSample(maskImg.sample(x2, y2) / mMax, x2, y2);
        }
      }
      maskW.mainView.endProcess();
    }

    maskW.show();

    // Build PixelMath expression
    // knee = per-pixel threshold from the blurred luminance mask
    var knee = '${minClamp} + ${range} * (1 - ' + tmpId + ')';

    var clampExpr;
    if ('${mode}' === 'soft') {
      // Soft compression: exponential saturation preserves relative brightness
      // result = iif($T > knee, knee + headroom * (1 - exp(-rate * ($T - knee) / headroom)), $T)
      // At knee: unchanged. Above knee: smoothly compressed toward knee + headroom.
      // A pixel at 0.90 and one at 0.85 remain distinguishable (gradient preserved).
      var hd = '${headroom}';
      var rt = '${rate}';
      clampExpr = 'iif($T > (' + knee + '), (' + knee + ') + ' + hd + ' * (1 - exp(-' + rt + ' * ($T - (' + knee + ')) / ' + hd + ')), $T)';
    } else {
      // Hard clamp (legacy): everything above knee flattened to knee value
      clampExpr = 'min($T, ' + knee + ')';
    }

    var PM = new PixelMath;
    PM.expression = clampExpr;
    PM.expression1 = clampExpr;
    PM.expression2 = clampExpr;
    PM.useSingleExpression = false;
    PM.use64BitWorkingImage = true;
    PM.truncate = true;
    PM.truncateLower = 0;
    PM.truncateUpper = 1;
    PM.createNewImage = false;
    PM.executeOn(src.mainView);

    // Clean up temp mask
    maskW.forceClose();

    // Report stats
    var finalImg = src.mainView.image;
    JSON.stringify({
      median: finalImg.median(),
      max: finalImg.maximum(),
      clampRange: [${minClamp}, ${maxClamp}],
      blur_sigma: blurSigma,
      mode: '${mode}',
      headroom: ${headroom},
      rate: ${rate}
    });
  `);

  if (r.status === 'error') {
    throw new Error('continuousClamp failed: ' + (r.error?.message || 'unknown'));
  }

  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

/**
 * Multi-zone masking for planetary nebulae.
 * Creates 3 masks from a single image: core, shell, halo.
 * Each zone can be processed independently.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - Source view
 * @param {object} thresholds - { core_clip, shell_clip, halo_clip }
 * @returns {object} { coreId, shellId, haloId }
 */
export async function createZoneMasks(ctx, viewId, thresholds = {}) {
  const coreClip = thresholds.core_clip ?? 0.40;
  const shellClip = thresholds.shell_clip ?? 0.15;
  const haloClip = thresholds.halo_clip ?? 0.04;

  const r = await ctx.pjsr(`
    var src = ImageWindow.windowById('${viewId}');
    if (src.isNull) throw new Error('createZoneMasks: view not found: ${viewId}');
    var img = src.mainView.image;
    var isColor = img.isColor;

    // Create luminance if color
    function getLum(x, y) {
      if (isColor) {
        return 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
      }
      return img.sample(x, y);
    }

    var w = img.width;
    var h = img.height;

    // Close existing masks
    var ids = ['mask_core', 'mask_shell', 'mask_halo'];
    for (var i = 0; i < ids.length; i++) {
      var ow = ImageWindow.windowById(ids[i]);
      if (!ow.isNull) ow.forceClose();
    }

    // Create 3 mono images
    var coreW = new ImageWindow(w, h, 1, 32, true, false, 'mask_core');
    var shellW = new ImageWindow(w, h, 1, 32, true, false, 'mask_shell');
    var haloW = new ImageWindow(w, h, 1, 32, true, false, 'mask_halo');

    var coreImg = coreW.mainView.image;
    var shellImg = shellW.mainView.image;
    var haloImg = haloW.mainView.image;

    var bgMedian = img.median();
    var bgMAD = img.MAD();

    coreW.mainView.beginProcess();
    shellW.mainView.beginProcess();
    haloW.mainView.beginProcess();

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var lum = getLum(x, y);
        // Core: bright central region
        coreImg.setSample(lum > ${coreClip} ? Math.min(1, (lum - ${coreClip}) / (1 - ${coreClip})) : 0, x, y);
        // Shell: medium brightness (between shell_clip and core_clip)
        shellImg.setSample(lum > ${shellClip} && lum <= ${coreClip} ? Math.min(1, (lum - ${shellClip}) / (${coreClip} - ${shellClip})) : 0, x, y);
        // Halo: faint outer structure (between halo_clip and shell_clip)
        haloImg.setSample(lum > ${haloClip} && lum <= ${shellClip} ? Math.min(1, (lum - ${haloClip}) / (${shellClip} - ${haloClip})) : 0, x, y);
      }
    }

    coreW.mainView.endProcess();
    shellW.mainView.endProcess();
    haloW.mainView.endProcess();

    // Blur masks for smooth transitions
    var conv = new Convolution;
    conv.mode = Convolution.prototype.Parametric;
    conv.shape = 2;
    conv.aspectRatio = 1;
    conv.rotationAngle = 0;
    conv.sigma = 8;
    conv.executeOn(coreW.mainView);
    conv.sigma = 12;
    conv.executeOn(shellW.mainView);
    conv.sigma = 20;
    conv.executeOn(haloW.mainView);

    coreW.show();
    shellW.show();
    haloW.show();

    JSON.stringify({
      coreId: 'mask_core',
      shellId: 'mask_shell',
      haloId: 'mask_halo',
      thresholds: { core: ${coreClip}, shell: ${shellClip}, halo: ${haloClip} }
    });
  `);

  if (r.status === 'error') {
    throw new Error('createZoneMasks failed: ' + (r.error?.message || 'unknown'));
  }

  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

/**
 * Adaptive zone masks — ROI-anchored, percentile-based zones for shell nebulae.
 *
 * Unlike createZoneMasks (fixed thresholds), this computes zone boundaries
 * from the actual pixel distribution within a subject ROI. Produces 3 soft masks:
 * hot_core (top ~10%), bright_shell (P25–P90), outer_nebula (below P25 above background).
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - Source view
 * @param {object} opts - { roi: {cx,cy,radius}, coreBias }
 * @returns {object} { coreId, shellId, outerId, roi, thresholds, pixelCounts }
 */
export async function createAdaptiveZoneMasks(ctx, viewId, opts = {}) {
  const roiCx = opts.roi?.cx ?? -1;
  const roiCy = opts.roi?.cy ?? -1;
  const roiR = opts.roi?.radius ?? -1;
  const coreBias = opts.coreBias ?? 0.5;

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('createAdaptiveZoneMasks: view not found: ${viewId}');
    var img = w.mainView.image;
    var isColor = img.isColor;
    var W = img.width, H = img.height;

    function getLum(px, py) {
      if (isColor) {
        return 0.2126 * img.sample(px, py, 0) + 0.7152 * img.sample(px, py, 1) + 0.0722 * img.sample(px, py, 2);
      }
      return img.sample(px, py);
    }

    var cx = ${roiCx}, cy = ${roiCy}, rad = ${roiR};
    if (cx < 0) {
      var bgM = img.median();
      var df = [];
      for (var y = 0; y < H; y += 32) for (var x = 0; x < W; x += 32) df.push(Math.abs(getLum(x,y) - bgM));
      df.sort(function(a,b){return a-b;});
      var bMAD = df[Math.floor(df.length/2)];
      var sTh = bgM + 5 * bMAD;
      var swx=0,swy=0,sw=0;
      for (var y=8;y<H-8;y+=8) for (var x=8;x<W-8;x+=8) {
        var l=getLum(x,y); if(l>sTh){swx+=x*l;swy+=y*l;sw+=l;}
      }
      cx = sw > 0 ? Math.round(swx/sw) : Math.round(W/2);
      cy = sw > 0 ? Math.round(swy/sw) : Math.round(H/2);
      rad = Math.round(Math.min(W,H)*0.35);
    }

    var bgMed = img.median();
    var df2 = [];
    for (var y = 0; y < H; y += 32) for (var x = 0; x < W; x += 32) df2.push(Math.abs(getLum(x,y) - bgMed));
    df2.sort(function(a,b){return a-b;});
    var bgMAD = df2[Math.floor(df2.length/2)];
    var subjectTh = bgMed + 5 * bgMAD;

    var roiSubject = [];
    for (var y = Math.max(0, cy-rad); y < Math.min(H, cy+rad); y += 4) {
      for (var x = Math.max(0, cx-rad); x < Math.min(W, cx+rad); x += 4) {
        var dx = x-cx, dy = y-cy;
        if (dx*dx + dy*dy > rad*rad) continue;
        var l = getLum(x, y);
        if (l > subjectTh) roiSubject.push(l);
      }
    }
    roiSubject.sort(function(a,b){return a-b;});

    if (roiSubject.length < 50) {
      JSON.stringify({ error: 'too_few_subject_pixels', count: roiSubject.length });
    } else {
      var corePerc = 0.85 + 0.10 * ${coreBias};
      var coreTh = roiSubject[Math.floor(roiSubject.length * corePerc)];
      var shellLow = roiSubject[Math.floor(roiSubject.length * 0.25)];

      var ids = ['azone_core', 'azone_shell', 'azone_outer'];
      for (var i = 0; i < 3; i++) {
        var old = ImageWindow.windowById(ids[i]);
        if (!old.isNull) old.forceClose();
      }

      var mC = new ImageWindow(W, H, 1, 32, true, false, 'azone_core');
      var mS = new ImageWindow(W, H, 1, 32, true, false, 'azone_shell');
      var mO = new ImageWindow(W, H, 1, 32, true, false, 'azone_outer');
      var iC = mC.mainView.image, iS = mS.mainView.image, iO = mO.mainView.image;
      var cc=0, sc=0, oc=0;

      mC.mainView.beginProcess(); mS.mainView.beginProcess(); mO.mainView.beginProcess();

      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var lum = getLum(x, y);
          var dx = x - cx, dy = y - cy;
          var dist = Math.sqrt(dx*dx + dy*dy);
          var roiW = dist < rad ? 1.0 : Math.max(0, 1.0 - (dist - rad) / 20.0);

          var cV = 0;
          if (lum > coreTh) {
            cV = Math.min(1.0, (lum - coreTh) / Math.max(0.01, 1.0 - coreTh));
            cc++;
          }
          var sV = 0;
          if (lum > shellLow && lum <= coreTh) {
            var mid = (shellLow + coreTh) / 2;
            var half = (coreTh - shellLow) / 2;
            sV = Math.max(0, Math.min(1, 1.0 - Math.abs(lum - mid) / half));
            sc++;
          }
          var oV = 0;
          if (lum > subjectTh && lum <= shellLow) {
            oV = Math.min(1.0, (lum - subjectTh) / Math.max(0.01, shellLow - subjectTh));
            oc++;
          }
          iC.setSample(cV * roiW, x, y);
          iS.setSample(sV * roiW, x, y);
          iO.setSample(oV * roiW, x, y);
        }
      }
      mC.mainView.endProcess(); mS.mainView.endProcess(); mO.mainView.endProcess();

      var sigmas = [5, 10, 20];
      var ms = [mC, mS, mO];
      for (var m = 0; m < 3; m++) {
        var conv = new Convolution;
        conv.mode = Convolution.prototype.Parametric;
        conv.sigma = sigmas[m]; conv.shape = 2; conv.aspectRatio = 1; conv.rotationAngle = 0;
        conv.executeOn(ms[m].mainView);
        ms[m].show();
      }

      JSON.stringify({
        coreId: 'azone_core', shellId: 'azone_shell', outerId: 'azone_outer',
        roi: { cx: cx, cy: cy, radius: rad },
        thresholds: { core: coreTh, shellLow: shellLow, outer: subjectTh },
        pixelCounts: { core: cc, shell: sc, outer: oc }
      });
    }
  `);

  if (r.status === 'error') {
    throw new Error('createAdaptiveZoneMasks failed: ' + (r.error?.message || 'unknown'));
  }
  const data = JSON.parse(r.outputs?.consoleOutput || '{}');
  if (data.error) throw new Error('createAdaptiveZoneMasks: ' + data.error + ' (' + data.count + ' pixels)');
  return data;
}
