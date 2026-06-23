// ============================================================================
// Subject Metrics — goal-oriented measurements for iterative processing
//
// These are SOFT GOALS the agent optimizes toward, not hard gates.
// The agent measures after each processing step and keeps pushing until
// metrics improve sufficiently.
// ============================================================================

/**
 * Measure subject detail and brightness.
 * Finds bright non-background regions (subjects), measures:
 * - subjectBrightness: median luminance of subject pixels (goal: > 0.25 for visibility)
 * - detailScore: Sobel gradient energy within subject regions (higher = more resolved detail)
 * - contrastRatio: subject median / background median (goal: > 3× for good separation)
 * - subjectCount: number of distinct bright regions found
 *
 * Works for any target type — galaxies, nebulae, clusters.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to measure
 * @returns {object} { subjectBrightness, detailScore, contrastRatio, subjectCount, backgroundMedian, details }
 */
export async function measureSubjectDetail(ctx, viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureSubjectDetail: view not found: ${viewId}');
    var img = w.mainView.image;

    // Get luminance
    function getLum(x, y) {
      if (img.isColor) {
        return 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
      }
      return img.sample(x, y);
    }

    // Background stats
    var bgMedian = img.median();
    var bgMAD = img.MAD();

    // Subject threshold: background + 3*MAD (anything significantly above background)
    var subjectThreshold = bgMedian + 3 * 1.4826 * bgMAD;
    // Strong subject threshold: for measuring bright objects specifically
    var strongThreshold = bgMedian + 8 * 1.4826 * bgMAD;

    // Scan in blocks of 32x32, classify as background or subject
    var blockSize = 32;
    var subjectBlocks = [];
    var bgSamples = [];
    var subjectSamples = [];

    for (var by = 0; by < img.height - blockSize; by += blockSize) {
      for (var bx = 0; bx < img.width - blockSize; bx += blockSize) {
        img.selectedRect = new Rect(bx, by, bx + blockSize, by + blockSize);
        var blockMed;
        if (img.isColor) {
          var chMeds = [];
          for (var c = 0; c < 3; c++) {
            img.selectedChannel = c;
            chMeds.push(img.median());
          }
          img.resetChannelSelection();
          blockMed = 0.2126 * chMeds[0] + 0.7152 * chMeds[1] + 0.0722 * chMeds[2];
        } else {
          blockMed = img.median();
        }

        if (blockMed > strongThreshold) {
          subjectBlocks.push({ x: bx, y: by, med: blockMed });
          subjectSamples.push(blockMed);
        } else {
          bgSamples.push(blockMed);
        }
      }
    }
    img.resetSelections();

    // Subject brightness: median of subject block medians
    subjectSamples.sort(function(a, b) { return a - b; });
    var subjectBrightness = subjectSamples.length > 0 ? subjectSamples[Math.floor(subjectSamples.length / 2)] : 0;

    // Background median from non-subject blocks
    bgSamples.sort(function(a, b) { return a - b; });
    var bgMed = bgSamples.length > 0 ? bgSamples[Math.floor(bgSamples.length / 2)] : bgMedian;

    // Contrast ratio
    var contrastRatio = bgMed > 0.001 ? subjectBrightness / bgMed : 0;

    // Detail score: Sobel gradient energy within subject blocks
    var totalEnergy = 0;
    var detailCount = 0;
    var step = 4;

    for (var i = 0; i < subjectBlocks.length && i < 50; i++) {
      var sb = subjectBlocks[i];
      for (var y = sb.y + 1; y < sb.y + blockSize - 1; y += step) {
        for (var x = sb.x + 1; x < sb.x + blockSize - 1; x += step) {
          var tl = getLum(x-1, y-1), tc = getLum(x, y-1), tr = getLum(x+1, y-1);
          var ml = getLum(x-1, y),                          mr = getLum(x+1, y);
          var bl = getLum(x-1, y+1), bc = getLum(x, y+1), br = getLum(x+1, y+1);
          var gx = -tl + tr - 2*ml + 2*mr - bl + br;
          var gy = -tl - 2*tc - tr + bl + 2*bc + br;
          totalEnergy += gx * gx + gy * gy;
          detailCount++;
        }
      }
    }

    var detailScore = detailCount > 0 ? totalEnergy / detailCount : 0;

    JSON.stringify({
      subjectBrightness: subjectBrightness,
      detailScore: detailScore,
      contrastRatio: contrastRatio,
      subjectCount: subjectBlocks.length,
      backgroundMedian: bgMed,
      subjectThreshold: subjectThreshold,
      totalBlocks: Math.floor((img.width / blockSize) * (img.height / blockSize))
    });
  `);

  if (r.status === 'error') {
    return {
      subjectBrightness: 0, detailScore: 0, contrastRatio: 0, subjectCount: 0,
      error: r.error?.message, details: 'Measurement failed'
    };
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { subjectBrightness: 0, detailScore: 0, contrastRatio: 0, subjectCount: 0, error: 'Parse failed' };
  }

  // Build assessment — thresholds match finish handler hard gates
  const assessments = [];
  if (data.subjectBrightness < 0.25) {
    assessments.push('*** WILL FAIL GATE *** SUBJECTS TOO DIM (brightness=' + data.subjectBrightness.toFixed(3) + ', HARD GATE: 0.25, goal: >0.35). Stretch harder, apply shadow-lifting curves, boost through masks. For PNe: outer halo must be visible.');
  } else if (data.subjectBrightness < 0.35) {
    assessments.push('Subjects moderately bright (' + data.subjectBrightness.toFixed(3) + ', passes gate 0.25, goal: >0.35). Push harder — shadow-lift or masked boost.');
  } else {
    assessments.push('Subject brightness GOOD (' + data.subjectBrightness.toFixed(3) + ').');
  }

  if (data.contrastRatio < 3.0) {
    assessments.push('*** WILL FAIL GATE *** LOW CONTRAST (ratio=' + data.contrastRatio.toFixed(1) + '×, HARD GATE: 3×, goal: >5×). Use masked curves/LHE to boost subjects selectively.');
  } else if (data.contrastRatio < 5.0) {
    assessments.push('Moderate contrast (' + data.contrastRatio.toFixed(1) + '×, passes gate 3×, goal: >5×). Could improve.');
  } else {
    assessments.push('Contrast GOOD (' + data.contrastRatio.toFixed(1) + '×).');
  }

  if (data.detailScore < 0.001) {
    assessments.push('*** WILL FAIL GATE *** VERY LOW DETAIL (score=' + data.detailScore.toFixed(6) + ', HARD GATE: 0.001, goal: >0.005). Subjects look like smooth blobs. Apply LHE (r=32-128) through luminance masks.');
  } else if (data.detailScore < 0.005) {
    assessments.push('Moderate detail (' + data.detailScore.toFixed(6) + ', passes gate 0.001, goal: >0.005). Fine-scale LHE can help.');
  } else {
    assessments.push('Detail GOOD (' + data.detailScore.toFixed(6) + ').');
  }

  return {
    subjectBrightness: data.subjectBrightness,
    detailScore: data.detailScore,
    contrastRatio: data.contrastRatio,
    subjectCount: data.subjectCount,
    backgroundMedian: data.backgroundMedian,
    details: assessments.join(' '),
    raw: data
  };
}

/**
 * Measure bright-core RELATIVE local contrast — catches a "perceptual burn":
 * a bright core that is not numerically clipped but reads as a flat, washed-out
 * white zone because its fine structure is tiny relative to its brightness.
 *
 * The clipping-based burn gate (check_core_burnt / bright-block) cannot see this:
 * the core can sit at ~0.5 mean with peak < 0.85 (passes clipping) yet have
 * relative contrast (gradient / brightness) far below the surrounding dust/shell,
 * so it looks burnt. This metric compares core vs shell relative contrast.
 *
 * relContrast = mean|local gradient| / mean luminance, measured separately in:
 *   - core  : top 40% of the dynamic range (bg + 0.6*(peak-bg) .. peak)
 *   - shell : mid band (bg + 0.15*(peak-bg) .. core threshold)
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to measure
 * @returns {object} { coreRelContrast, shellRelContrast, ratio, coreLum, coreFraction, pass, details }
 */
export async function measureCoreContrast(ctx, viewId, classification, coreBurnCfg) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureCoreContrast: view not found: ${viewId}');
    var img = w.mainView.image;
    var W = img.width, H = img.height, isColor = img.isColor;
    function L(x, y) {
      if (isColor) return 0.2126*img.sample(x,y,0)+0.7152*img.sample(x,y,1)+0.0722*img.sample(x,y,2);
      return img.sample(x, y);
    }
    var bg = img.median();
    // Find peak luminance via coarse scan (luminance, robust to single hot pixels: 99.9th pct)
    var coarse = [];
    for (var y = 4; y < H-4; y += 24) for (var x = 4; x < W-4; x += 24) coarse.push(L(x,y));
    coarse.sort(function(a,b){return a-b;});
    var peak = coarse[Math.floor(coarse.length*0.999)];
    if (peak <= bg) peak = coarse[coarse.length-1];
    var coreThr = bg + 0.60*(peak - bg);
    var shellLo = bg + 0.15*(peak - bg);

    // Accumulate gradient + luminance in core and shell bands. In the CORE band
    // also accumulate per-pixel saturation and a "white-clipped" fraction — a
    // bright core can pass the gradient/luminance relContrast yet still look
    // burnt because it is desaturated white. (This is the 0.334 false-pass fix.)
    var step = 3;
    var cE=0, cL=0, cN=0, sE=0, sL=0, sN=0, cSat=0, cWhite=0;
    for (var y = step; y < H-step; y += step) {
      for (var x = step; x < W-step; x += step) {
        var l = L(x,y);
        if (l < shellLo) continue;
        var lr = L(x+step,y), ld = L(x,y+step);
        var grad = Math.abs(l-lr) + Math.abs(l-ld);
        if (l >= coreThr) {
          cE += grad; cL += l; cN++;
          if (isColor) {
            var rr=img.sample(x,y,0), gg=img.sample(x,y,1), bb=img.sample(x,y,2);
            var mx=Math.max(rr,gg,bb), mn=Math.min(rr,gg,bb);
            var sat = mx>0.0001 ? (mx-mn)/mx : 0;
            cSat += sat;
            if (sat < 0.08 && mx > 0.85) cWhite++;
          }
        }
        else { sE += grad; sL += l; sN++; }
      }
    }
    var coreMeanGrad = cN>0 ? cE/cN : 0, coreMeanLum = cN>0 ? cL/cN : 0;
    var shellMeanGrad = sN>0 ? sE/sN : 0, shellMeanLum = sN>0 ? sL/sN : 0;
    var coreRel = coreMeanLum>0.001 ? coreMeanGrad/coreMeanLum : 0;
    var shellRel = shellMeanLum>0.001 ? shellMeanGrad/shellMeanLum : 0;
    var totalSampled = Math.floor(((W-2*step)/step)*((H-2*step)/step));
    JSON.stringify({
      coreRelContrast: coreRel, shellRelContrast: shellRel,
      ratio: shellRel>0.0001 ? coreRel/shellRel : 0,
      coreLum: coreMeanLum, shellLum: shellMeanLum,
      coreSat: (isColor && cN>0) ? cSat/cN : -1,
      coreWhiteFraction: (isColor && cN>0) ? cWhite/cN : 0,
      corePixels: cN, coreFraction: totalSampled>0 ? cN/totalSampled : 0,
      peak: peak, bg: bg
    });
  `);

  if (r.status === 'error') {
    return { coreRelContrast: 0, shellRelContrast: 0, ratio: 0, error: r.error?.message, details: 'Measurement failed' };
  }
  let d;
  try { d = JSON.parse(r.outputs?.consoleOutput || '{}'); }
  catch { return { coreRelContrast: 0, shellRelContrast: 0, ratio: 0, error: 'Parse failed' }; }

  // Thresholds (calibrated): a well-resolved core has relContrast >= ~0.30 and is
  // within ~0.65x of its shell. A flat/perceptually-burnt core falls well below.
  // Burn thresholds default to the calibrated general values but can be tightened
  // per-classification via the profile's core_burn block. For reflection nebulae
  // (e.g. NGC 7023) the smooth HD200775 glow left by SXT passes the general gates
  // as a "moderate" 0.290 relContrast at 11.1% white-fraction — both validated
  // (against the user-approved iter03: 0.452 / 5.5%) to need rel>=0.35, white<0.10.
  const cb = coreBurnCfg || {};
  const HARD = (typeof cb.rel_contrast_hard === 'number') ? cb.rel_contrast_hard : 0.22;
  const GOAL = 0.30, RATIO_HARD = 0.55;
  const WHITE_HARD = (typeof cb.white_hard === 'number') ? cb.white_hard : 0.15;   // core white-clipped+desaturated fraction = burnt
  const SAT_LOW = 0.10;      // colored object whose core sat collapses = washed out
  const cr = d.coreRelContrast || 0, ratio = d.ratio || 0;
  const coreWhiteFraction = d.coreWhiteFraction || 0;
  const coreSat = (typeof d.coreSat === 'number') ? d.coreSat : -1; // -1 = mono/N/A
  // The relContrast gate alone let a desaturated white core pass (the 0.334
  // false-pass). Add an OR-clause: a core that is substantially white-clipped is
  // BURNT regardless of gradient energy (applies to all colored targets).
  // The SATURATION-collapse clause, however, only makes sense for emission/PNe
  // cores — galaxy bulges and white/blue reflection cores (e.g. NGC 7023) are
  // NATURALLY low-saturation, so applying it there would false-fail a correct
  // muted core and push toward the cooked look the user rejects. Gate it.
  const satGateApplies = /emission|planetary|pne|hii/i.test(classification || '');
  const whiteBurnt = coreWhiteFraction > WHITE_HARD;
  const desatBurnt = satGateApplies && coreSat >= 0 && coreSat < SAT_LOW;
  const pass = cr >= HARD && !whiteBurnt && !desatBurnt;
  const msgs = [];
  if (whiteBurnt) {
    msgs.push(`*** FAILS CORE GATE (WHITE BURN) *** ${(coreWhiteFraction*100).toFixed(1)}% of the bright core is white-clipped + desaturated (limit ${(WHITE_HARD*100)}%). The center reads as a blown white patch even if gradient energy passes. Compress the core pedestal (continuous_clamp) and recover color/structure so the center is not white.`);
  } else if (desatBurnt) {
    msgs.push(`*** FAILS CORE GATE (DESATURATED) *** Core saturation collapsed to ${coreSat.toFixed(3)} (min ${SAT_LOW}) — a colored object's bright core should keep hue, not go grey/white. Restore core color (often a sign of SCNR/clamp over-processing or missing color calibration).`);
  }
  if (cr < HARD) {
    msgs.push(`*** FAILS CORE-CONTRAST GATE *** Bright core is FLAT/perceptually burnt: relContrast=${cr.toFixed(3)} (hard gate ${HARD}, goal ${GOAL}). Core mean lum=${(d.coreLum||0).toFixed(3)} but structure is washed out vs brightness. Recover local contrast (HDRMT/LHE into the center; compress the bright pedestal).`);
  } else if (cr < GOAL) {
    msgs.push(`Core contrast moderate: relContrast=${cr.toFixed(3)} (passes ${HARD}, goal ${GOAL}).`);
  } else if (pass) {
    msgs.push(`Core GOOD: relContrast=${cr.toFixed(3)}, whiteFraction=${(coreWhiteFraction*100).toFixed(1)}%${coreSat>=0?`, sat=${coreSat.toFixed(3)}`:''}.`);
  }
  if (ratio < RATIO_HARD) {
    msgs.push(`(Diagnostic) core flatter than shell: ratio=${ratio.toFixed(2)} (core ${cr.toFixed(3)} vs shell ${(d.shellRelContrast||0).toFixed(3)}).`);
  }
  return {
    coreRelContrast: cr, shellRelContrast: d.shellRelContrast, ratio,
    coreLum: d.coreLum, coreSat, coreWhiteFraction, coreFraction: d.coreFraction, peak: d.peak, bg: d.bg,
    pass, details: msgs.join(' '), raw: d
  };
}

/**
 * Measure faint-DUST / IFN coverage in the FIELD (everything below the bright core).
 * Distinguishes a frame FILLED with brown dust from an EMPTY black field even when
 * their medians are identical — the median is blind to the distribution. Calibrated
 * on NGC 7023: the user-approved iter03 (dust fills frame) vs the regressed giga
 * run (empty field) have the SAME median 0.0784 but differ sharply on dust color
 * and dust peaks:
 *     metric            iter03(good)  giga(bad)  good/bad
 *     dustMeanSat          0.300        0.179      1.67x   (dust got GREYED)
 *     fieldP95             0.194        0.118      1.64x   (dust peaks CRUSHED)
 *     dustCoverage         0.280        0.209      1.34x
 *     warmDustFraction     0.476        0.407      1.17x
 * So the regression is "greyed + crushed dust", NOT low median. Gate on the two
 * strongest, best-margin signals (greyed AND crushed) to avoid false-failing a
 * genuinely good dusty frame.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID
 * @param {object} ifnCfg - optional { min_dust_mean_sat, min_field_p95, min_dust_coverage }
 * @returns {object} { dustCoverage, warmDustFraction, dustMeanSat, fieldP95, fieldP90, bg, coreThr, pass, details }
 */
export async function measureDustCoverage(ctx, viewId, ifnCfg) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureDustCoverage: view not found: ${viewId}');
    var img = w.mainView.image; var W=img.width, H=img.height, isColor=img.isColor;
    function L(x,y){ return isColor ? 0.2126*img.sample(x,y,0)+0.7152*img.sample(x,y,1)+0.0722*img.sample(x,y,2) : img.sample(x,y); }
    var bg = img.median();
    var coarse=[];
    for (var y=4;y<H-4;y+=24) for (var x=4;x<W-4;x+=24) coarse.push(L(x,y));
    coarse.sort(function(a,b){return a-b;});
    var peak = coarse[Math.floor(coarse.length*0.999)];
    if (peak<=bg) peak=coarse[coarse.length-1];
    var coreThr = bg + 0.60*(peak-bg);
    var step=3;
    var nField=0, nDust=0, nWarmDust=0, dustSatSum=0;
    var lum=[];
    var dustLo = bg*1.20, dustHi = coreThr;   // faint structure band above background, below core
    for (var y=step;y<H-step;y+=step){
      for (var x=step;x<W-step;x+=step){
        var l=L(x,y);
        if (l>=coreThr) continue;            // exclude bright core
        nField++; lum.push(l);
        if (l>dustLo && l<dustHi){
          nDust++;
          if (isColor){
            var rr=img.sample(x,y,0), gg=img.sample(x,y,1), bb=img.sample(x,y,2);
            var mx=Math.max(rr,gg,bb), mn=Math.min(rr,gg,bb);
            var sat = mx>0.0001?(mx-mn)/mx:0; dustSatSum+=sat;
            if (rr >= bb*1.03) nWarmDust++;   // warm/brown lean
          }
        }
      }
    }
    lum.sort(function(a,b){return a-b;});
    function pct(p){ return lum[Math.min(lum.length-1, Math.floor(lum.length*p))]; }
    JSON.stringify({
      bg: bg, peak: peak, coreThr: coreThr,
      fieldP90: pct(0.90), fieldP95: pct(0.95),
      dustCoverage: nField>0 ? nDust/nField : 0,
      warmDustFraction: nDust>0 ? nWarmDust/nDust : 0,
      dustMeanSat: nDust>0 ? dustSatSum/nDust : 0,
      nField: nField, nDust: nDust
    });
  `);
  if (r.status === 'error') return { dustCoverage: 0, dustMeanSat: 0, fieldP95: 0, error: r.error?.message, details: 'Measurement failed' };
  let d; try { d = JSON.parse(r.outputs?.consoleOutput || '{}'); } catch { return { dustCoverage: 0, error: 'Parse failed' }; }
  const cfg = ifnCfg || {};
  const MIN_SAT = (typeof cfg.min_dust_mean_sat === 'number') ? cfg.min_dust_mean_sat : 0.24;
  const MIN_P95 = (typeof cfg.min_field_p95 === 'number') ? cfg.min_field_p95 : 0.15;
  const MIN_COV = (typeof cfg.min_dust_coverage === 'number') ? cfg.min_dust_coverage : 0.24;
  const MIN_WARM = (typeof cfg.min_warm_fraction === 'number') ? cfg.min_warm_fraction : 0.35;
  const greyed = (d.dustMeanSat || 0) < MIN_SAT;
  const crushed = (d.fieldP95 || 0) < MIN_P95;
  const thin = (d.dustCoverage || 0) < MIN_COV;
  // APPLICABILITY GUARD: the greyed+crushed HARD-fail demands BROWN dust, so it must
  // only apply to targets that actually have brown IFN. A blue / sparse-dust reflection
  // nebula (e.g. M45 Pleiades) classifies as reflection_nebula too but has a LOW warm
  // fraction — do NOT block it for missing brown dust it physically lacks. NGC 7023's
  // field runs warmDustFraction ~0.41-0.48; blue reflection is well below 0.35.
  const isBrownDustField = (d.warmDustFraction || 0) >= MIN_WARM;
  // HARD fail only when dust is BOTH greyed AND crushed AND the field is genuinely a
  // brown-dust field — conservative AND avoids false-failing blue or saturated-but-faint
  // frames. Single-condition shortfalls are advisory.
  const pass = !(greyed && crushed && isBrownDustField);
  const msgs = [];
  if (!pass) {
    msgs.push(`*** FAILS IFN/DUST GATE *** The brown dust (warmFraction=${((d.warmDustFraction||0)*100).toFixed(0)}%) is BOTH greyed and crushed: dustMeanSat=${(d.dustMeanSat||0).toFixed(3)} (min ${MIN_SAT}) AND fieldP95=${(d.fieldP95||0).toFixed(3)} (min ${MIN_P95}). The frame reads empty. Lift the faint dust SELECTIVELY (lift_dust: masked shadow/midtone recovery in the bg*1.2..core band) and BOOST its warm saturation — do NOT use a global additive lift (it greys the field).`);
  } else {
    if (greyed) msgs.push(`(advisory) dust is muted: dustMeanSat=${(d.dustMeanSat||0).toFixed(3)} (goal >= ${MIN_SAT}). Boost warm saturation through a dust mask.`);
    if (crushed) msgs.push(`(advisory) dust peaks low: fieldP95=${(d.fieldP95||0).toFixed(3)} (goal >= ${MIN_P95}). Lift faint dust selectively (lift_dust).`);
    if (thin) msgs.push(`(advisory) dust coverage thin: ${((d.dustCoverage||0)*100).toFixed(1)}% of field (goal >= ${(MIN_COV*100).toFixed(0)}%).`);
    if (!greyed && !crushed && !thin) msgs.push(`Dust GOOD: coverage=${((d.dustCoverage||0)*100).toFixed(1)}%, meanSat=${(d.dustMeanSat||0).toFixed(3)}, P95=${(d.fieldP95||0).toFixed(3)}.`);
  }
  return {
    dustCoverage: d.dustCoverage, warmDustFraction: d.warmDustFraction, dustMeanSat: d.dustMeanSat,
    fieldP95: d.fieldP95, fieldP90: d.fieldP90, bg: d.bg, coreThr: d.coreThr,
    pass, details: msgs.join(' '), raw: d
  };
}

/**
 * Measure background high-frequency (pixel-scale) NOISE — the grain that
 * aggressive LHE / stretching amplifies. Distinct from the gradient/uniformity
 * metrics (large-scale) and from detail (subject structure). Estimates noise as
 * the MAD of (pixel - mean of its dist-2 neighbors) over the CLEANEST background
 * patches (grid, lowest-median patches), so subject structure does not inflate it.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID
 * @returns {object} { bgNoise, bgMedian, pass, details }
 */
export async function measureBackgroundNoise(ctx, viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureBackgroundNoise: view not found: ${viewId}');
    var img = w.mainView.image; var W=img.width, H=img.height, isC=img.isColor;
    function L(x,y){ if(isC) return 0.3*img.sample(x,y,0)+0.59*img.sample(x,y,1)+0.11*img.sample(x,y,2); return img.sample(x,y); }
    function patch(x0,y0,sz){ var med=[],hf=[]; for(var y=y0+2;y<y0+sz-2;y+=2){ for(var x=x0+2;x<x0+sz-2;x+=2){ var c=L(x,y); med.push(c); var nb=(L(x-2,y)+L(x+2,y)+L(x,y-2)+L(x,y+2))/4; hf.push(Math.abs(c-nb)); } } med.sort(function(a,b){return a-b;}); hf.sort(function(a,b){return a-b;}); return {med:med[med.length>>1]||0, hf:(hf[hf.length>>1]||0)*1.4826}; }
    var ms=[], hs=[]; var sz=Math.max(40,Math.floor(W*0.05));
    for(var gy=0; gy<6; gy++){ for(var gx=0; gx<6; gx++){ var px=Math.floor(W*(0.18+gx*0.11)), py=Math.floor(H*(0.18+gy*0.11)); var p=patch(px,py,sz); ms.push(p.med); hs.push(p.hf); } }
    var idx=[]; for(var i=0;i<ms.length;i++) idx.push(i);
    idx.sort(function(a,b){return ms[a]-ms[b];});  // sort patches by median (darkest = cleanest bg first)
    var clean=[]; for(var k=0;k<12;k++) clean.push(hs[idx[k]]);
    clean.sort(function(a,b){return a-b;});
    // DUST-BAND grain: the pixel-scale hf of the MID-brightness patches (the dust band,
    // brighter than dark sky but not the core/stars). The clean-bg metric above sorts
    // these OUT, so it is blind to grain on the lifted dust — the surface the user sees.
    // Real dust is smooth at pixel scale, so hf here is mostly grain.
    var dust=[]; for(var k=12;k<24 && k<idx.length;k++) dust.push(hs[idx[k]]);
    dust.sort(function(a,b){return a-b;});
    JSON.stringify({ bgNoise: clean[clean.length>>1], bgMedian: ms[idx[6]], dustNoise: dust.length? dust[dust.length>>1] : 0 });
  `);
  if (r.status === 'error') return { bgNoise: 0, bgMedian: 0, error: r.error?.message, details: 'Measurement failed' };
  let d; try { d = JSON.parse(r.outputs?.consoleOutput || '{}'); } catch { return { bgNoise: 0, error: 'Parse failed' }; }
  const HARD = 0.022, GOAL = 0.015;
  const DUST_HARD = 0.040;   // dust-band grain hard gate (looser than clean-bg — dust carries signal)
  const n = d.bgNoise || 0;
  const dn = d.dustNoise || 0;
  const pass = n <= HARD && dn <= DUST_HARD;
  let msg;
  if (n > HARD) msg = `*** FAILS NOISE GATE (dark sky) *** Background grain too high: bgNoise=${n.toFixed(4)} (hard gate ${HARD}, goal ${GOAL}). Apply ONE light NoiseXTerminator pass (denoise 0.25–0.35); do not over-smooth (core-contrast still needs resolved detail). Re-check after.`;
  else if (dn > DUST_HARD) msg = `*** FAILS NOISE GATE (dust grain) *** The lifted dust is grainy: dustNoise=${dn.toFixed(4)} (hard gate ${DUST_HARD}) even though dark sky is clean (bgNoise=${n.toFixed(4)}). The dark-sky metric is blind to this — apply a FINAL NoiseXTerminator pass (denoise 0.30, detail 0.10) on the dust AFTER lift_dust. Re-check after.`;
  else if (n > GOAL || dn > 0.030) msg = `Background acceptable but slightly grainy: bgNoise=${n.toFixed(4)} (goal ${GOAL}), dustNoise=${dn.toFixed(4)}.`;
  else msg = `Background noise GOOD: bgNoise=${n.toFixed(4)}, dustNoise=${dn.toFixed(4)}.`;
  return { bgNoise: n, bgMedian: d.bgMedian, dustNoise: dn, pass, details: msg };
}

/**
 * Locate subject ROI — produces a single authoritative subject location
 * used by adaptive zone masks and the highlight-texture critic.
 *
 * Computes a luminance-weighted centroid with spatial compactness filtering
 * (rejects isolated stars), plus a bounding radius enclosing 90% of subject flux.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to analyze
 * @returns {object} { cx, cy, radius, confidence, subjectPixelCount, subjectFraction }
 */
export async function locateSubjectROI(ctx, viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('locateSubjectROI: view not found: ${viewId}');
    var img = w.mainView.image;
    var isColor = img.isColor;
    var W = img.width, H = img.height;

    function getLum(px, py) {
      if (isColor) {
        return 0.2126 * img.sample(px, py, 0) + 0.7152 * img.sample(px, py, 1) + 0.0722 * img.sample(px, py, 2);
      }
      return img.sample(px, py);
    }

    // Background stats via sampling
    var bgMedian = img.median();
    var sampleStep = 32;
    var diffs = [];
    for (var y = 0; y < H; y += sampleStep) {
      for (var x = 0; x < W; x += sampleStep) {
        diffs.push(Math.abs(getLum(x, y) - bgMedian));
      }
    }
    diffs.sort(function(a, b) { return a - b; });
    var bgMAD = diffs[Math.floor(diffs.length / 2)];
    var subjectThreshold = bgMedian + 5 * bgMAD;

    // Collect subject pixels with spatial compactness (reject isolated stars)
    var step = 8;
    var probeD = 3;
    var sumWX = 0, sumWY = 0, sumW = 0;
    var subjectCount = 0;
    var totalSampled = 0;
    var subjectDistances = []; // filled after centroid is known

    // First pass: compute centroid
    var subjectCoords = [];
    for (var y = step; y < H - step; y += step) {
      for (var x = step; x < W - step; x += step) {
        totalSampled++;
        var lum = getLum(x, y);
        if (lum > subjectThreshold) {
          var bn = 0;
          if (x - probeD >= 0 && getLum(x - probeD, y) > subjectThreshold) bn++;
          if (x + probeD < W && getLum(x + probeD, y) > subjectThreshold) bn++;
          if (y - probeD >= 0 && getLum(x, y - probeD) > subjectThreshold) bn++;
          if (y + probeD < H && getLum(x, y + probeD) > subjectThreshold) bn++;
          if (bn >= 2) {
            sumWX += x * lum;
            sumWY += y * lum;
            sumW += lum;
            subjectCount++;
            subjectCoords.push(x * 65536 + y); // pack coords for second pass
          }
        }
      }
    }

    var cx = sumW > 0 ? Math.round(sumWX / sumW) : Math.round(W / 2);
    var cy = sumW > 0 ? Math.round(sumWY / sumW) : Math.round(H / 2);

    // Second pass: compute distances from centroid to determine bounding radius
    var distances = [];
    for (var i = 0; i < subjectCoords.length; i++) {
      var sx = Math.floor(subjectCoords[i] / 65536);
      var sy = subjectCoords[i] % 65536;
      var dx = sx - cx, dy = sy - cy;
      distances.push(Math.sqrt(dx * dx + dy * dy));
    }
    distances.sort(function(a, b) { return a - b; });

    // Radius enclosing 90% of subject pixels
    var radius = distances.length > 0
      ? distances[Math.floor(distances.length * 0.90)]
      : Math.min(W, H) / 4;

    // Clamp radius
    var maxRadius = Math.min(W, H) * 0.45;
    var minRadius = 50;
    if (radius > maxRadius) radius = maxRadius;
    if (radius < minRadius) radius = minRadius;
    radius = Math.round(radius);

    var subjectFraction = totalSampled > 0 ? subjectCount / totalSampled : 0;

    JSON.stringify({
      cx: cx,
      cy: cy,
      radius: radius,
      subjectPixelCount: subjectCount,
      subjectFraction: subjectFraction,
      totalSampled: totalSampled,
      bgMedian: bgMedian,
      bgMAD: bgMAD,
      subjectThreshold: subjectThreshold
    });
  `);

  if (r.status === 'error') {
    return { cx: 0, cy: 0, radius: 200, confidence: 'low', error: r.error?.message };
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { cx: 0, cy: 0, radius: 200, confidence: 'low', error: 'Parse failed' };
  }

  // Confidence from subject fraction
  let confidence;
  if (data.subjectFraction > 0.03 && data.subjectPixelCount > 500) {
    confidence = 'high';
  } else if (data.subjectFraction > 0.01) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Widen radius for medium confidence
  let radius = data.radius;
  if (confidence === 'medium') {
    radius = Math.round(radius * 1.2);
  }

  return {
    cx: data.cx,
    cy: data.cy,
    radius,
    confidence,
    subjectPixelCount: data.subjectPixelCount,
    subjectFraction: data.subjectFraction,
    bgMedian: data.bgMedian,
    bgMAD: data.bgMAD,
    subjectThreshold: data.subjectThreshold
  };
}

// ============================================================================
// compareToReference — similarity of viewId to a user-supplied reference image:
// CIELAB color EMD (histogram-matched bg cells) + multiscale luminance SSIM +
// faint-coverage delta. Reference opened from disk, measured, closed in finally.
//   color_emd 0..~1 (lower=closer color), ms_ssim 0..1 (null if geom mismatch),
//   coverage_delta -1..1 (positive = ref has MORE faint signal than target).
// ============================================================================
export async function compareToReference(ctx, viewId, referencePath, opts = {}) {
  const cols = opts.cols ?? 8;
  const rows = opts.rows ?? 6;
  const refEsc = String(referencePath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('compareToReference: view not found: ${viewId}');
    var refArr = ImageWindow.open('${refEsc}');
    if (!refArr || refArr.length === 0) throw new Error('compareToReference: failed to open reference: ${refEsc}');
    var rw = refArr[0];
    var out = {};
    try {
      var a = w.mainView.image;
      var b = rw.mainView.image;
      var geomOk = (a.width === b.width && a.height === b.height);
      out.geometry_ok = geomOk;
      function lumAt(img, x, y) {
        if (img.isColor) return 0.2126*img.sample(x,y,0)+0.7152*img.sample(x,y,1)+0.0722*img.sample(x,y,2);
        return img.sample(x, y);
      }
      function srgbToLin(c) { if (c <= 0.0) return 0.0; if (c <= 0.04045) return c/12.92; return Math.exp(2.4*Math.log((c+0.055)/1.055)); }
      function cbrt(t) { if (t <= 0.0) return 0.0; return Math.exp(Math.log(t)/3.0); }
      function fLab(t) { return t > 0.008856 ? cbrt(t) : (7.787*t + 16.0/116.0); }
      function rgbToLab(R, G, B) {
        var rl = srgbToLin(R), gl = srgbToLin(G), bl = srgbToLin(B);
        var X = (0.4124*rl + 0.3576*gl + 0.1805*bl) / 0.95047;
        var Y = (0.2126*rl + 0.7152*gl + 0.0722*bl) / 1.00000;
        var Z = (0.0193*rl + 0.1192*gl + 0.9505*bl) / 1.08883;
        var fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
        return [116.0*fy - 16.0, 500.0*(fx-fy), 200.0*(fy-fz)];
      }
      function bgMedians(img) {
        var med = [];
        if (img.isColor) { for (var c=0;c<3;c++){ img.selectedChannel=c; med.push(img.median()); } img.resetChannelSelection(); }
        else { var m=img.median(); med=[m,m,m]; }
        img.resetSelections();
        return med;
      }
      var color_emd = 0, dE_mean = 0, dE_p90 = 0, bgCells = 0;
      if (a.isColor && b.isColor) {
        var cols = ${cols}, rows = ${rows};
        function cellLabPalette(img) {
          var bgm = bgMedians(img);
          var cw = Math.floor(img.width/cols), chh = Math.floor(img.height/rows);
          var box = Math.max(24, Math.floor(Math.min(cw, chh)*0.6));
          var cells = [];
          for (var gy=0; gy<rows; gy++) {
            for (var gx=0; gx<cols; gx++) {
              var cx = gx*cw + Math.floor((cw-box)/2);
              var cy = gy*chh + Math.floor((chh-box)/2);
              img.selectedRect = new Rect(cx, cy, cx+box, cy+box);
              var m=[];
              for (var c=0;c<3;c++){ img.selectedChannel=c; m.push(img.median()); }
              img.resetChannelSelection();
              var lum=(m[0]+m[1]+m[2])/3;
              cells.push({R:m[0],G:m[1],B:m[2],lum:lum});
            }
          }
          img.resetSelections();
          var lums=[]; for (var i=0;i<cells.length;i++) lums.push(cells[i].lum);
          lums.sort(function(p,q){return p-q;});
          var medLum=lums[Math.floor(lums.length/2)];
          var devs=[]; for (var i=0;i<lums.length;i++) devs.push(Math.abs(lums[i]-medLum));
          devs.sort(function(p,q){return p-q;});
          var madLum=devs[Math.floor(devs.length/2)]*1.4826;
          var thr=medLum+3*madLum;
          var labs=[];
          for (var i=0;i<cells.length;i++) {
            if (cells[i].lum > thr) continue;
            var rR=cells[i].R-bgm[0]; if(rR<0)rR=0;
            var gG=cells[i].G-bgm[1]; if(gG<0)gG=0;
            var bB=cells[i].B-bgm[2]; if(bB<0)bB=0;
            labs.push(rgbToLab(rR,gG,bB));
          }
          return labs;
        }
        var labA = cellLabPalette(a);
        var labB = cellLabPalette(b);
        var n = Math.min(labA.length, labB.length);
        if (n > 0) {
          var dEs=[];
          for (var i=0;i<n;i++) {
            var dL=labA[i][0]-labB[i][0], da=labA[i][1]-labB[i][1], db=labA[i][2]-labB[i][2];
            dEs.push(Math.sqrt(dL*dL+da*da+db*db));
          }
          dEs.sort(function(p,q){return p-q;});
          var s=0; for (var i=0;i<dEs.length;i++) s+=dEs[i];
          dE_mean = s/dEs.length;
          dE_p90  = dEs[Math.floor(dEs.length*0.9)];
          color_emd = dE_mean/100.0;
          bgCells = n;
        }
      }
      out.color_emd = color_emd; out.deltaE_mean = dE_mean; out.deltaE_p90 = dE_p90; out.bg_cells = bgCells;
      var ms_ssim = null, perScale = [];
      if (geomOk) {
        var W=a.width, H=a.height;
        var C1=0.0001, C2=0.0009;
        var scaleSteps=[4,8,16];
        var prod=1.0, valid=0;
        for (var si=0; si<scaleSteps.length; si++) {
          var step=scaleSteps[si];
          var win=step*3;
          var sumS=0, cnt=0;
          for (var by=win; by<H-win; by+=win) {
            for (var bx=win; bx<W-win; bx+=win) {
              var ma=0, mb=0, k=0;
              for (var yy=by-win; yy<=by+win; yy+=step) { for (var xx=bx-win; xx<=bx+win; xx+=step) { ma+=lumAt(a,xx,yy); mb+=lumAt(b,xx,yy); k++; } }
              if (k<4) continue;
              ma/=k; mb/=k;
              var va=0, vb=0, cov=0;
              for (var yy=by-win; yy<=by+win; yy+=step) { for (var xx=bx-win; xx<=bx+win; xx+=step) { var pa=lumAt(a,xx,yy)-ma, pb=lumAt(b,xx,yy)-mb; va+=pa*pa; vb+=pb*pb; cov+=pa*pb; } }
              va/=(k-1); vb/=(k-1); cov/=(k-1);
              var ssim=((2*ma*mb+C1)*(2*cov+C2))/((ma*ma+mb*mb+C1)*(va+vb+C2));
              sumS+=ssim; cnt++;
            }
          }
          var scaleAvg = cnt>0 ? sumS/cnt : 1.0;
          if (scaleAvg<0) scaleAvg=0; if (scaleAvg>1) scaleAvg=1;
          perScale.push(scaleAvg);
          prod*=scaleAvg; valid++;
        }
        ms_ssim = valid>0 ? prod : null;
      }
      out.ms_ssim = ms_ssim; out.ms_ssim_per_scale = perScale;
      function faintFraction(img) {
        var bgM=img.median(), bgMAD=img.MAD();
        img.resetSelections();
        var lo=bgM+1*1.4826*bgMAD, hi=bgM+6*1.4826*bgMAD;
        var step=8, d=3;
        var sampled=0, faint=0;
        for (var y=d*step; y<img.height-d*step; y+=step) {
          for (var x=d*step; x<img.width-d*step; x+=step) {
            sampled++;
            var L=lumAt(img,x,y);
            if (L<=lo || L>=hi) continue;
            var nb=0;
            if (lumAt(img,x-d*step,y)>lo) nb++;
            if (lumAt(img,x+d*step,y)>lo) nb++;
            if (lumAt(img,x,y-d*step)>lo) nb++;
            if (lumAt(img,x,y+d*step)>lo) nb++;
            if (nb>=2) faint++;
          }
        }
        return sampled>0 ? faint/sampled : 0;
      }
      var fT = faintFraction(a);
      var fR = faintFraction(b);
      out.faint_target = fT; out.faint_ref = fR; out.coverage_delta = fR - fT;
    } finally { for (var ci=0; ci<refArr.length; ci++) { if(!refArr[ci].isNull) refArr[ci].forceClose(); } }
    JSON.stringify(out);
  `);
  if (r.status === 'error') return { error: r.error?.message || 'compareToReference failed' };
  let data;
  try { data = JSON.parse(r.outputs?.consoleOutput?.trim() || '{}'); }
  catch { return { error: 'compareToReference: unparseable result' }; }
  if (data.error) return data;
  const ge = data.geometry_ok;
  data.details =
    `color_emd=${(data.color_emd ?? 0).toFixed(3)} (ΔE mean=${(data.deltaE_mean ?? 0).toFixed(1)}, P90=${(data.deltaE_p90 ?? 0).toFixed(1)}, ${data.bg_cells ?? 0} bg cells); ` +
    `ms_ssim=${ge ? (data.ms_ssim ?? 0).toFixed(3) : 'n/a (geometry mismatch)'}; ` +
    `coverage_delta=${(data.coverage_delta ?? 0).toFixed(3)} (faint target=${(data.faint_target ?? 0).toFixed(3)}, ref=${(data.faint_ref ?? 0).toFixed(3)})`;
  return data;
}
