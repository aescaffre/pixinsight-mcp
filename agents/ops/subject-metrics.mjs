// ============================================================================
// Subject Metrics — goal-oriented measurements for iterative processing
//
// These are SOFT GOALS the agent optimizes toward, not hard gates.
// The agent measures after each processing step and keeps pushing until
// metrics improve sufficiently.
// ============================================================================

import fs from 'fs';
import path from 'path';
import { gateThreshold, contrastGateFor, SUBJECT_MIN, DETAIL_MIN, NOISE_BG_HARD, NOISE_DUST_HARD } from '../llm/gate-contract.mjs';

// ---------------------------------------------------------------------------
// Detail-sampling helpers. Written in ES5 on purpose: the SAME source text is
// embedded into the PJSR pass (via Function.prototype.toString) and unit-tested
// in Node, so the tested code is the executed code.
// ---------------------------------------------------------------------------

/** Indices 0..n-1 spread evenly so that at most `max` are returned (every k-th, centred). */
export function stratifiedIndices(n, max) {
  var out = [];
  if (n <= 0 || max <= 0) return out;
  if (n <= max) { for (var i = 0; i < n; i++) out.push(i); return out; }
  var k = n / max;
  for (var j = 0; j < max; j++) out.push(Math.min(n - 1, Math.floor(j * k + k / 2)));
  return out;
}

/** True when a 3x3 window is star-contaminated: max > blockMedian+0.25 or any pixel > 0.85. */
export function isStarWindow(windowMax, blockMedian) {
  return windowMax > blockMedian + 0.25 || windowMax > 0.85;
}

/** Sobel energy of one block with star-window rejection. getLum(x,y) -> luminance. Returns {e, n, skipped, total, starDominated}. */
export function blockSobelEnergy(getLum, x0, y0, size, step, blockMedian) {
  var tot = 0, n = 0, skipped = 0, total = 0, bmax = 0;
  for (var y = y0 + 1; y < y0 + size - 1; y += step) {
    for (var x = x0 + 1; x < x0 + size - 1; x += step) {
      total++;
      var tl = getLum(x - 1, y - 1), tc = getLum(x, y - 1), tr = getLum(x + 1, y - 1);
      var ml = getLum(x - 1, y), mc = getLum(x, y), mr = getLum(x + 1, y);
      var bl = getLum(x - 1, y + 1), bc = getLum(x, y + 1), br = getLum(x + 1, y + 1);
      var wm = Math.max(tl, tc, tr, ml, mc, mr, bl, bc, br);
      if (wm > bmax) bmax = wm;
      if (isStarWindow(wm, blockMedian)) { skipped++; continue; }
      var gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      var gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      tot += gx * gx + gy * gy;
      n++;
    }
  }
  // Whole block is star-dominated: most windows rejected, or max/median ratio extreme.
  var starDominated = total > 0 && (skipped / total > 0.5 || (blockMedian > 0.0005 && bmax / blockMedian > 12 && skipped > 0));
  return { e: n > 0 ? tot / n : 0, n: n, skipped: skipped, total: total, starDominated: starDominated };
}

/**
 * Measure subject detail and brightness.
 * Finds bright non-background regions (subjects), measures:
 * - subjectBrightness: median luminance of subject pixels (goal: > 0.25 for visibility)
 * - detailScore (= detailRaw): Sobel gradient energy within subject regions, star-rejected,
 *   sampled over ALL subject blocks (stratified, <= 50 blocks)
 * - detailCredible: mean over subject blocks of max(0, E_block - E_noise), where E_noise is the
 *   Sobel energy (same kernel/stride) of the darkest background blocks
 * - detailWeber: mean of E_block / blockMedian^2 (brightness-normalised, comparable across stretches)
 * - noiseDominated: detailRaw / detailCredible > 2.5
 * - contrastRatio: subject median / background median (goal: > 3x for good separation)
 * - subjectCount: number of distinct bright regions found
 *
 * opts.roi {x,y,w,h}: restrict the sampled blocks to a region (used by check_sharpness).
 * With a ROI, if no subject block lies inside it every ROI block is used.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to measure
 * @returns {object} { subjectBrightness, detailScore, detailRaw, detailCredible, detailWeber, noiseDominated, contrastRatio, subjectCount, backgroundMedian, details }
 */
export async function measureSubjectDetail(ctx, viewId, opts = {}) {
  const roi = opts.roi && opts.roi.w > 0 && opts.roi.h > 0 ? opts.roi : null;
  const r = await ctx.pjsr(`
    ${stratifiedIndices.toString()}
    ${isStarWindow.toString()}
    ${blockSobelEnergy.toString()}
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureSubjectDetail: view not found: ${viewId}');
    var img = w.mainView.image;
    var roi = ${roi ? JSON.stringify({ x: roi.x, y: roi.y, w: roi.w, h: roi.h }) : 'null'};

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
    var bgBlocks = [];
    var roiBlocks = [];
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

        var inRoi = !roi || (bx >= roi.x && by >= roi.y && bx + blockSize <= roi.x + roi.w && by + blockSize <= roi.y + roi.h);
        if (blockMed > strongThreshold) {
          if (inRoi) subjectBlocks.push({ x: bx, y: by, med: blockMed });
          subjectSamples.push(blockMed);
        } else {
          bgSamples.push(blockMed);
          bgBlocks.push({ x: bx, y: by, med: blockMed });
        }
        if (roi && inRoi) roiBlocks.push({ x: bx, y: by, med: blockMed });
      }
    }
    img.resetSelections();
    if (roi && subjectBlocks.length === 0) subjectBlocks = roiBlocks;

    // Subject brightness: median of subject block medians
    subjectSamples.sort(function(a, b) { return a - b; });
    var subjectBrightness = subjectSamples.length > 0 ? subjectSamples[Math.floor(subjectSamples.length / 2)] : 0;

    // Background median from non-subject blocks
    bgSamples.sort(function(a, b) { return a - b; });
    var bgMed = bgSamples.length > 0 ? bgSamples[Math.floor(bgSamples.length / 2)] : bgMedian;

    // Contrast ratio
    var contrastRatio = bgMed > 0.001 ? subjectBrightness / bgMed : 0;

    // Detail: Sobel energy, STRATIFIED over all subject blocks (<= 50, spread across the subject),
    // star windows rejected, plus a self-calibrated noise floor from the darkest background blocks.
    var step = 4;
    var maxBlocks = 50;
    var idx = stratifiedIndices(subjectBlocks.length, maxBlocks);
    var rawSum = 0, rawN = 0, credSum = 0, credBlocks = 0, weberSum = 0, usedBlocks = 0, starBlocks = 0, skippedWin = 0, totalWin = 0;
    var blockE = [];
    for (var i = 0; i < idx.length; i++) {
      var sb = subjectBlocks[idx[i]];
      var res = blockSobelEnergy(getLum, sb.x, sb.y, blockSize, step, sb.med);
      skippedWin += res.skipped; totalWin += res.total;
      if (res.starDominated || res.n === 0) { starBlocks++; continue; }
      blockE.push({ e: res.e, med: sb.med });
      rawSum += res.e * res.n; rawN += res.n;
      usedBlocks++;
    }

    // Noise floor: N darkest background blocks, identical kernel/stride/star rejection.
    var bgSorted = bgBlocks.slice().sort(function(a, b) { return a.med - b.med; });
    var nNoise = Math.min(50, bgSorted.length);
    var noiseIdx = stratifiedIndices(Math.min(bgSorted.length, 200), nNoise);
    var noiseSum = 0, noiseCount = 0;
    for (var q = 0; q < noiseIdx.length; q++) {
      var nb = bgSorted[noiseIdx[q]];
      var nr = blockSobelEnergy(getLum, nb.x, nb.y, blockSize, step, nb.med);
      if (nr.n > 0 && !nr.starDominated) { noiseSum += nr.e; noiseCount++; }
    }
    var noiseEnergy = noiseCount > 0 ? noiseSum / noiseCount : 0;

    for (var k = 0; k < blockE.length; k++) {
      credSum += Math.max(0, blockE[k].e - noiseEnergy);
      var m2 = blockE[k].med * blockE[k].med;
      weberSum += m2 > 1e-8 ? blockE[k].e / m2 : 0;
    }
    var detailRaw = rawN > 0 ? rawSum / rawN : 0;
    var detailCredible = blockE.length > 0 ? credSum / blockE.length : 0;
    var detailWeber = blockE.length > 0 ? weberSum / blockE.length : 0;
    var noiseDominated = detailRaw > 0 && (detailCredible <= 0 || detailRaw / detailCredible > 2.5);

    JSON.stringify({
      subjectBrightness: subjectBrightness,
      detailScore: detailRaw,
      detailRaw: detailRaw,
      detailCredible: detailCredible,
      detailWeber: detailWeber,
      noiseEnergy: noiseEnergy,
      noiseDominated: noiseDominated,
      blocksUsed: usedBlocks,
      starBlocksSkipped: starBlocks,
      starWindowFraction: totalWin > 0 ? skippedWin / totalWin : 0,
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

  // Build assessment — thresholds come from gate-contract.mjs (same source as the finish handler)
  const contrastMin = contrastGateFor(opts.faintStructureGoal);
  const detailMin = gateThreshold(opts.profile, 'detail.min_detail', DETAIL_MIN);
  const assessments = [];
  if (data.subjectBrightness < SUBJECT_MIN) {
    assessments.push('*** WILL FAIL GATE *** SUBJECTS TOO DIM (brightness=' + data.subjectBrightness.toFixed(3) + ', HARD GATE: ' + SUBJECT_MIN + ', goal: >0.35). Stretch harder, apply shadow-lifting curves, boost through masks. For PNe: outer halo must be visible.');
  } else if (data.subjectBrightness < 0.35) {
    assessments.push('Subjects moderately bright (' + data.subjectBrightness.toFixed(3) + ', passes gate ' + SUBJECT_MIN + ', goal: >0.35). Push harder — shadow-lift or masked boost.');
  } else {
    assessments.push('Subject brightness GOOD (' + data.subjectBrightness.toFixed(3) + ').');
  }

  if (data.contrastRatio < contrastMin) {
    assessments.push('*** WILL FAIL GATE *** LOW CONTRAST (ratio=' + data.contrastRatio.toFixed(1) + '×, HARD GATE: ' + contrastMin + '×, goal: >5×). Use masked curves/LHE to boost subjects selectively.');
  } else if (data.contrastRatio < 5.0) {
    assessments.push('Moderate contrast (' + data.contrastRatio.toFixed(1) + '×, passes gate ' + contrastMin + '×, goal: >5×). Could improve.');
  } else {
    assessments.push('Contrast GOOD (' + data.contrastRatio.toFixed(1) + '×).');
  }

  if (data.detailScore < detailMin) {
    assessments.push('*** WILL FAIL GATE *** VERY LOW DETAIL (score=' + data.detailScore.toFixed(6) + ', HARD GATE: ' + detailMin + ', goal: >0.005). Subjects look like smooth blobs. Apply LHE (r=32-128) through luminance masks.');
  } else if (data.detailScore < 0.005) {
    assessments.push('Moderate detail (' + data.detailScore.toFixed(6) + ', passes gate ' + detailMin + ', goal: >0.005). Fine-scale LHE can help.');
  } else {
    assessments.push('Detail GOOD (' + data.detailScore.toFixed(6) + ').');
  }

  return {
    subjectBrightness: data.subjectBrightness,
    detailScore: data.detailScore,
    detailRaw: data.detailRaw,
    detailCredible: data.detailCredible,
    detailWeber: data.detailWeber,
    noiseDominated: data.noiseDominated,
    noiseEnergy: data.noiseEnergy,
    contrastRatio: data.contrastRatio,
    subjectCount: data.subjectCount,
    backgroundMedian: data.backgroundMedian,
    details: assessments.join(' ') + (data.noiseDominated ? ' NOISE-DOMINATED detail (raw/credible > 2.5): the energy is mostly grain, not structure.' : ''),
    raw: data
  };
}

const pickDetail = (d) => d ? {
  credible: d.detailCredible ?? null, weber: d.detailWeber ?? null, raw: d.detailRaw ?? d.detailScore ?? null,
  noiseDominated: !!d.noiseDominated,
} : null;
export { pickDetail as summarizeDetail };

/**
 * Prep baseline for the detail gate. Measures detailCredible/detailWeber on the prep RGB (and L / starless
 * L when present), builds {rgb, l, max} (max = element-wise max of rgb and l), and writes prep-metrics.json
 * into runDir. Best effort: never throws.
 */
export async function measureDetailBaseline(ctx, views, { runDir, log = console.log } = {}) {
  const out = { rgb: null, l: null, max: null };
  try { if (views?.rgb) out.rgb = pickDetail(await measureSubjectDetail(ctx, views.rgb)); } catch (e) { log(`  [baseline] rgb detail failed: ${e.message}`); }
  try { if (views?.l) out.l = pickDetail(await measureSubjectDetail(ctx, views.l)); } catch (e) { log(`  [baseline] L detail failed: ${e.message}`); }
  // Scale-band baseline (fine-detail retention advisory): L when present (that is what the detail rides on), else RGB.
  try { const sv = views?.l || views?.rgb; if (sv) { const sb = await measureScaleBands(ctx, sv); if (!sb.error) out.scale = sb; } } catch (e) { log(`  [baseline] scale bands failed: ${e.message}`); }
  const cands = [out.rgb, out.l].filter(Boolean);
  if (cands.length) {
    out.max = {
      credible: Math.max(...cands.map(c => c.credible ?? 0)),
      weber: Math.max(...cands.map(c => c.weber ?? 0)),
      raw: Math.max(...cands.map(c => c.raw ?? 0)),
    };
  }
  if (runDir) {
    try { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(path.join(runDir, 'prep-metrics.json'), JSON.stringify({ baselineDetail: out }, null, 2)); } catch { /* */ }
  }
  log(`  [baseline] detail: rgb weber=${out.rgb?.weber?.toExponential?.(3)} credible=${out.rgb?.credible?.toExponential?.(3)}${out.l ? ` | L weber=${out.l.weber?.toExponential?.(3)}` : ''}`);
  return out;
}

/** Read prep-metrics.json baselineDetail from a run dir (null when absent). */
export function readDetailBaseline(runDir) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'prep-metrics.json'), 'utf8')).baselineDetail || null; } catch { return null; }
}

/**
 * Compare a final/starless detail measurement with the prep baseline.
 * Baseline = `max` for LRGB/HaLRGB (hasL), `rgb` for RGB-only. Gain is a RATIO (1.28 = +28%).
 * @returns {{gain:number|null, maxGain:number|null, exceeded:boolean, noiseDominated:boolean, message:string|null}}
 */
export function evaluateDetailGain(measured, baseline, hasL, profile) {
  const base = baseline ? (hasL ? (baseline.max || baseline.rgb) : baseline.rgb) : null;
  const m = measured && (measured.weber != null ? measured : pickDetail(measured));
  const maxGain = profile?.detail?.max_gain ?? null;
  const out = { gain: null, maxGain, exceeded: false, noiseDominated: !!m?.noiseDominated, message: null };
  const msgs = [];
  if (base && m && base.weber > 0 && m.weber != null) {
    out.gain = m.weber / base.weber;
    if (maxGain != null && out.gain > maxGain) {
      out.exceeded = true;
      msgs.push(`detail gain x${out.gain.toFixed(2)} over the prep baseline exceeds profile detail.max_gain ${maxGain} (${profile.detail._calibration || 'uncalibrated'}) — enhancement may be amplifying noise/artefacts`);
    }
  }
  if (out.noiseDominated) msgs.push('detail is noise-dominated (detailRaw/detailCredible > 2.5)');
  if (msgs.length) out.message = msgs.join('; ');
  return out;
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
    var cE=0, cL=0, cN=0, sE=0, sL=0, sN=0, cSat=0, cWhite=0, cStruct=0, cSmoothBright=0;
    for (var y = step; y < H-step; y += step) {
      for (var x = step; x < W-step; x += step) {
        var l = L(x,y);
        if (l < shellLo) continue;
        var lr = L(x+step,y), ld = L(x,y+step);
        var grad = Math.abs(l-lr) + Math.abs(l-ld);
        if (l >= coreThr) {
          cE += grad; cL += l; cN++;
          // Structure vs halo (catches what relContrast averages away): a structured
          // core (dust lanes/detail) has most pixels with real local gradient; a flat
          // center has few; a smooth BRIGHT zone (>0.55, near-zero gradient) is a halo.
          if (grad > 0.012) cStruct++;
          if (grad < 0.004 && l > 0.55) cSmoothBright++;
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
      coreStructFrac: cN>0 ? cStruct/cN : 0,
      haloFrac: cN>0 ? cSmoothBright/cN : 0,
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
  // STRUCTURE + HALO gates (opt-in per profile via core_burn.min_struct_frac /
  // max_halo_frac). relContrast averages the whole core band, so it is BLIND to a flat
  // blue CENTER sitting inside a structured/bright halo (it passed such a core at 0.449).
  // coreStructFrac = fraction of core pixels with real local detail; haloFrac = fraction
  // that are smooth AND bright (a halo/blown ring). Calibrated on NGC7023: iter03 97.5%/0.3%,
  // best-of-both 95.7%/0.5% (PASS); flat-core 45.7%/12.3%, blown-halo graft 81.9%/6.1% (FAIL).
  const coreStructFrac = d.coreStructFrac || 0;
  const haloFrac = d.haloFrac || 0;
  const structBurnt = (typeof cb.min_struct_frac === 'number') && coreStructFrac < cb.min_struct_frac;
  const haloBurnt = (typeof cb.max_halo_frac === 'number') && haloFrac > cb.max_halo_frac;
  // WI-17: relC is advisory when the core is demonstrably structured (built-in 0.80/0.03
  // calibrated in 7ae7ef8). White burn still blocks regardless. structBurnt/haloBurnt stay
  // blocking only when the profile supplies the keys.
  const STRUCT_OK = (typeof cb.min_struct_frac === 'number') ? cb.min_struct_frac : 0.80;
  const HALO_OK = (typeof cb.max_halo_frac === 'number') ? cb.max_halo_frac : 0.03;
  const structuredCore = coreStructFrac >= STRUCT_OK && haloFrac <= HALO_OK && !whiteBurnt;
  const relBlocking = cr < HARD && !structuredCore;
  const relAdvisory = cr < HARD && structuredCore;
  const pass = !relBlocking && !whiteBurnt && !desatBurnt && !structBurnt && !haloBurnt;
  const msgs = [];
  if (structBurnt) {
    msgs.push(`*** FAILS CORE GATE (FLAT CENTER) *** Only ${(coreStructFrac*100).toFixed(0)}% of the bright core has real structure (min ${(cb.min_struct_frac*100)}%) — the blue center is a flat/washed blob even if relContrast passes (relContrast averages a structured halo). Recover internal structure in the CENTER (masked LHE/HDRMT into the core, or graft a structured-core champion); do not just brighten it.`);
  }
  if (haloBurnt) {
    msgs.push(`*** FAILS CORE GATE (HALO) *** ${(haloFrac*100).toFixed(1)}% of the core is a smooth bright zone (limit ${(cb.max_halo_frac*100)}%) — a halo/blown ring around the center. Compress the bright pedestal (continuous_clamp) or protect the core from over-injection; the dust-fill must not bleed a bright ring around the nebula.`);
  }
  if (whiteBurnt) {
    msgs.push(`*** FAILS CORE GATE (WHITE BURN) *** ${(coreWhiteFraction*100).toFixed(1)}% of the bright core is white-clipped + desaturated (limit ${(WHITE_HARD*100)}%). The center reads as a blown white patch even if gradient energy passes. Compress the core pedestal (continuous_clamp) and recover color/structure so the center is not white.`);
  } else if (desatBurnt) {
    msgs.push(`*** FAILS CORE GATE (DESATURATED) *** Core saturation collapsed to ${coreSat.toFixed(3)} (min ${SAT_LOW}) — a colored object's bright core should keep hue, not go grey/white. Restore core color (often a sign of SCNR/clamp over-processing or missing color calibration).`);
  }
  if (relAdvisory) {
    msgs.push(`relC advisory: structured core (struct ${(coreStructFrac*100).toFixed(0)}%, halo ${(haloFrac*100).toFixed(1)}%) — relContrast=${cr.toFixed(3)} is below ${HARD} but the core has real structure, so this is a warning, not a failure.`);
  } else if (cr < HARD) {
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
    coreLum: d.coreLum, coreSat, coreWhiteFraction, coreStructFrac, haloFrac,
    coreFraction: d.coreFraction, peak: d.peak, bg: d.bg,
    pass, relAdvisory, structuredCore, details: msgs.join(' '), raw: d
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
export async function measureBackgroundNoise(ctx, viewId, opts = {}) {
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
  const HARD = gateThreshold(opts.profile, 'noise.bg_hard', NOISE_BG_HARD), GOAL = 0.015;
  const DUST_HARD = gateThreshold(opts.profile, 'noise.dust_hard', NOISE_DUST_HARD);   // dust-band grain hard gate (looser than clean-bg — dust carries signal)
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


// ---------------------------------------------------------------------------
// Chroma-noise / mottle metric (WI-26 B).
// Pure ES5 helpers (embedded into the PJSR pass via toString so the tested code
// is the executed code).
// ---------------------------------------------------------------------------
// 1.4826 * MAD of an array (0 for empty).
export function madScaled(arr) {
  var n = arr.length;
  if (!n) return 0;
  var a = arr.slice().sort(function (p, q) { return p - q; });
  var med = a[n >> 1];
  var d = [];
  for (var i = 0; i < n; i++) d.push(Math.abs(arr[i] - med));
  d.sort(function (p, q) { return p - q; });
  return d[n >> 1] * 1.4826;
}
// Residual of each interior point of a row-major nx*ny grid minus the mean of its
// 4 axis neighbours at grid distance 1. NO sigma^2/64 white-noise correction:
// noise is spatially correlated after NXT, so this is a plain high-pass measure.
export function lapResiduals(vals, nx, ny) {
  var out = [];
  for (var y = 1; y < ny - 1; y++) {
    for (var x = 1; x < nx - 1; x++) {
      var c = vals[y * nx + x];
      var nb = (vals[y * nx + x - 1] + vals[y * nx + x + 1] + vals[(y - 1) * nx + x] + vals[(y + 1) * nx + x]) / 4;
      out.push(c - nb);
    }
  }
  return out;
}

function _median(a) {
  if (!a.length) return 0;
  var b = a.slice().sort(function (p, q) { return p - q; });
  return b[b.length >> 1];
}

/**
 * Measure chroma noise and large-scale colour mottle on a colour view.
 * Same 6x6 patch grid as measureBackgroundNoise; patches sorted by luminance
 * median: darkest 12 = clean sky band, next 12 = dust band.
 * Ca=R-L, Cb=B-L. chromaNoise = pooled 1.4826*MAD of (C - mean of 4 dist-2 neighbours).
 * mottle16/mottle48 = same on box means (16/48 px boxes) vs 4 adjacent boxes.
 * ADVISORY metric (no pass/fail unless the profile supplies ceilings).
 * @returns {object} { chromaNoise, chromaToLumNoise, mottle16, mottle48, lumNoise, clean:{...}, dust:{...}, pass, details }
 */
export async function measureChromaNoise(ctx, viewId, opts = {}) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureChromaNoise: view not found: ${viewId}');
    var img = w.mainView.image; var W = img.width, H = img.height;
    if (!img.isColor) { JSON.stringify({ error: 'mono image - no chroma' }); }
    else {
      ${madScaled.toString().replace('export ', '')}
      ${lapResiduals.toString().replace('export ', '')}
      ${_median.toString()}
      function lumAt(x, y) { return 0.3 * img.sample(x, y, 0) + 0.59 * img.sample(x, y, 1) + 0.11 * img.sample(x, y, 2); }
      // pixel-scale: grid at step 2 over the patch; returns {med, ca, cb, l} residual arrays
      function pixelPatch(x0, y0, sz) {
        var nx = 0, ny = 0, ca = [], cb = [], lm = [], meds = [];
        for (var y = y0; y < y0 + sz; y += 2) { ny++; nx = 0;
          for (var x = x0; x < x0 + sz; x += 2) { nx++;
            var R = img.sample(x, y, 0), G = img.sample(x, y, 1), B = img.sample(x, y, 2);
            var L = 0.3 * R + 0.59 * G + 0.11 * B;
            ca.push(R - L); cb.push(B - L); lm.push(L); meds.push(L);
          } }
        return { med: _median(meds), ca: lapResiduals(ca, nx, ny), cb: lapResiduals(cb, nx, ny), l: lapResiduals(lm, nx, ny) };
      }
      // box-scale: 5x5 boxes of size bs (step-2 subsampled means); residuals of chroma vs 4 neighbouring boxes
      function mottlePatch(cx, cy, bs) {
        var side = 5 * bs;
        var x0 = Math.max(0, Math.min(W - side - 1, Math.floor(cx - side / 2)));
        var y0 = Math.max(0, Math.min(H - side - 1, Math.floor(cy - side / 2)));
        var ca = [], cb = [];
        for (var by = 0; by < 5; by++) { for (var bx = 0; bx < 5; bx++) {
          var sa = 0, sb = 0, n = 0;
          for (var y = y0 + by * bs; y < y0 + (by + 1) * bs; y += 2) {
            for (var x = x0 + bx * bs; x < x0 + (bx + 1) * bs; x += 2) {
              var R = img.sample(x, y, 0), G = img.sample(x, y, 1), B = img.sample(x, y, 2);
              var L = 0.3 * R + 0.59 * G + 0.11 * B; sa += R - L; sb += B - L; n++;
            } }
          ca.push(sa / n); cb.push(sb / n);
        } }
        return lapResiduals(ca, 5, 5).concat(lapResiduals(cb, 5, 5));
      }
      var sz = Math.max(40, Math.floor(W * 0.05));
      var patches = [];
      for (var gy = 0; gy < 6; gy++) { for (var gx = 0; gx < 6; gx++) {
        var px = Math.floor(W * (0.18 + gx * 0.11)), py = Math.floor(H * (0.18 + gy * 0.11));
        px = Math.min(px, W - sz - 2); py = Math.min(py, H - sz - 2);
        var p = pixelPatch(px, py, sz);
        patches.push({
          med: p.med,
          cn: madScaled(p.ca.concat(p.cb)),
          ln: madScaled(p.l),
          m16: madScaled(mottlePatch(px + sz / 2, py + sz / 2, 16)),
          m48: madScaled(mottlePatch(px + sz / 2, py + sz / 2, 48))
        });
      } }
      patches.sort(function (a, b) { return a.med - b.med; });
      function band(lo, hi) {
        var cn = [], ln = [], m16 = [], m48 = [];
        for (var i = lo; i < hi && i < patches.length; i++) { cn.push(patches[i].cn); ln.push(patches[i].ln); m16.push(patches[i].m16); m48.push(patches[i].m48); }
        return { n: cn.length, chromaNoise: _median(cn), lumNoise: _median(ln), mottle16: _median(m16), mottle48: _median(m48) };
      }
      JSON.stringify({ clean: band(0, 12), dust: band(12, 24) });
    }
  `);
  if (r.status === 'error') return { chromaNoise: 0, error: r.error?.message, pass: true, details: 'Measurement failed' };
  let d; try { d = JSON.parse(r.outputs?.consoleOutput || '{}'); } catch { return { chromaNoise: 0, error: 'Parse failed', pass: true, details: 'Parse failed' }; }
  if (d.error) return { chromaNoise: 0, error: d.error, pass: true, details: d.error };
  return summarizeChromaNoise(d, opts.profile);
}

// Pure: derive headline values + advisory verdict from the raw bands.
export function summarizeChromaNoise(d, profile) {
  // Headline = the dust band when present (the surface the viewer sees), else the clean band.
  const hb = (d.dust && d.dust.n >= 3) ? d.dust : d.clean;
  const chromaNoise = hb.chromaNoise || 0;
  const lumNoise = hb.lumNoise || 0;
  const chromaToLumNoise = lumNoise > 1e-9 ? chromaNoise / lumNoise : 0;
  const nz = (profile && profile.noise) || {};
  const maxRatio = typeof nz.max_chroma_to_lum === 'number' ? nz.max_chroma_to_lum : null;
  const maxMottle = typeof nz.max_mottle48 === 'number' ? nz.max_mottle48 : null;
  const mottle16 = hb.mottle16 || 0, mottle48 = hb.mottle48 || 0;
  const over = [];
  if (maxRatio !== null && chromaToLumNoise > maxRatio) over.push(`chroma/lum noise ${chromaToLumNoise.toFixed(2)} > ${maxRatio}`);
  if (maxMottle !== null && mottle48 > maxMottle) over.push(`mottle48 ${mottle48.toFixed(4)} > ${maxMottle}`);
  const remedy = 'chroma_smooth sigma 6-8 through the halo/dust mask, or reduce lift/inject strength upstream; never global desaturation.';
  const details = `Chroma noise ${chromaNoise.toFixed(5)} (chroma/lum ${chromaToLumNoise.toFixed(2)}), mottle16=${mottle16.toFixed(5)}, mottle48=${mottle48.toFixed(5)} [band: ${hb === d.dust ? 'dust' : 'clean'}].` +
    (over.length ? ` ADVISORY: ${over.join('; ')}. Remedy: ${remedy}` : (maxRatio === null && maxMottle === null ? ' (no profile ceiling set — informational.)' : ' Within profile ceilings.'));
  return {
    chromaNoise, chromaToLumNoise, lumNoise, mottle16, mottle48,
    clean: d.clean, dust: d.dust,
    pass: over.length === 0, over, details
  };
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
// compareToReference — similarity of viewId to a user-supplied reference image.
// Reference opened from disk, measured, closed in finally. Peak extra windows: 2
// (the reference + one temp duplicate of the target, only during the SSIM step).
//
//   bg_cast_delta  dE(a*b* only) between the two images' dark-cell median RGB
//                  triplets converted to Lab directly (background colour cast).
//                  color_emd = bg_cast_delta/100 is kept as a DEPRECATED alias
//                  (the old residual-then-Lab color_emd was ~0 by construction).
//   palette_l1     L1 distance (0..2) between hue-family fractions of subject
//                  pixels with HSV saturation >= 0.08; sat_frac_* = fraction of
//                  subject pixels that are saturated enough to count.
//   lab_emd        CHROMA-ONLY sliced-Wasserstein distance (a*b* units, ~ Euclidean
//                  distance of a pure chroma shift) between subject a*b*
//                  histograms (24x24 over [-60,60], 8 angles). L* is excluded so a
//                  differently stretched reference does not dominate. Each image's
//                  own dark-cell bg median (RGB) is subtracted before Lab.
//   lum_cdf_dist   geometry-free mean |decile difference| of subject luminance (9 bins).
//   ms_ssim        multiscale luminance SSIM on both images resampled to ~1500 px
//                  wide (only when aspect ratios match within 1%, else null).
//   coverage_delta faint-signal fraction (reference minus target).
// ============================================================================

/** Add one (a,b) point to an n x n histogram over [lo,hi]; out-of-range clamps to the edge bins. ES5 (embedded in PJSR). */
export function chromaHistAdd(hist, a, b, n, lo, hi) {
  var bw = (hi - lo) / n;
  var ia = Math.floor((a - lo) / bw), ib = Math.floor((b - lo) / bw);
  if (ia < 0) ia = 0; if (ia > n - 1) ia = n - 1;
  if (ib < 0) ib = 0; if (ib > n - 1) ib = n - 1;
  hist[ib * n + ia] += 1;
}

/**
 * Sliced-Wasserstein-1 distance between two n x n a*b* histograms over [lo,hi].
 * nAngles fixed projection directions k*PI/nAngles. The result is divided by the
 * mean |cos| of those directions so a pure translation by d gives ~d (a*b* units).
 * Returns 0 for identical histograms; null if either is empty. ES5 (embedded in PJSR).
 */
export function slicedWasserstein(histA, histB, n, lo, hi, nAngles) {
  var bw = (hi - lo) / n, N = n * n, i, k;
  var sa = 0, sb = 0;
  for (i = 0; i < N; i++) { sa += histA[i]; sb += histB[i]; }
  if (!(sa > 0) || !(sb > 0)) return null;
  var idx = [];
  for (i = 0; i < N; i++) { if (histA[i] > 0 || histB[i] > 0) idx.push(i); }
  var total = 0, cosSum = 0;
  for (k = 0; k < nAngles; k++) {
    var th = k * Math.PI / nAngles, c = Math.cos(th), s = Math.sin(th);
    cosSum += Math.abs(c);
    var items = [];
    for (var j = 0; j < idx.length; j++) {
      var q = idx[j], ia = q % n, ib = Math.floor(q / n);
      var ca = lo + (ia + 0.5) * bw, cb = lo + (ib + 0.5) * bw;
      items.push([ca * c + cb * s, histA[q] / sa, histB[q] / sb]);
    }
    items.sort(function (p, r) { return p[0] - r[0]; });
    var cdfA = 0, cdfB = 0, w1 = 0;
    for (var m = 0; m < items.length - 1; m++) {
      cdfA += items[m][1]; cdfB += items[m][2];
      w1 += Math.abs(cdfA - cdfB) * (items[m + 1][0] - items[m][0]);
    }
    total += w1;
  }
  var meanCos = cosSum / nAngles;
  return (total / nAngles) / (meanCos > 1e-9 ? meanCos : 1);
}

/** Mean absolute difference of the 9 decile values (10..90%) of two ascending-sorted arrays. ES5 (embedded in PJSR). */
export function decileCdfDistance(sortedA, sortedB) {
  if (!sortedA.length || !sortedB.length) return null;
  var s = 0;
  for (var d = 1; d <= 9; d++) {
    var qa = sortedA[Math.min(sortedA.length - 1, Math.floor(sortedA.length * d / 10))];
    var qb = sortedB[Math.min(sortedB.length - 1, Math.floor(sortedB.length * d / 10))];
    s += Math.abs(qa - qb);
  }
  return s / 9;
}

export async function compareToReference(ctx, viewId, referencePath, opts = {}) {
  const refEsc = String(referencePath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const tmpId = `__cmp_tgt_${Date.now().toString(36)}`;
  const targetWidth = opts.targetWidth ?? 1500;
  const r = await ctx.pjsr(`
    ${chromaHistAdd.toString()}
    ${slicedWasserstein.toString()}
    ${decileCdfDistance.toString()}
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('compareToReference: view not found: ${viewId}');
    var refArr = ImageWindow.open('${refEsc}');
    if (!refArr || refArr.length === 0) throw new Error('compareToReference: failed to open reference: ${refEsc}');
    var rw = refArr[0];
    var tmpW = null;
    var out = {};
    // Crash bisect marker (PI 1.9.5 aborted inside this script on 60 MP images, 2026-10-28):
    // the last stage name survives the crash in ~/.pixinsight-mcp/bridge/last-stage.txt.
    function __mark(s) { try { File.writeTextFile(File.homeDirectory + '/.pixinsight-mcp/bridge/last-stage.txt', 'compareToReference: ' + s + ' ' + (new Date()).toISOString()); } catch (e) {} }
    __mark('opened reference');
    try {
      var a = w.mainView.image;
      var b = rw.mainView.image;
      var aspectA = a.width / a.height, aspectB = b.width / b.height;
      var aspectOk = Math.abs(aspectA / aspectB - 1) <= 0.01;
      out.aspect_ok = aspectOk; out.geometry_ok = aspectOk;
      out.same_size = (a.width === b.width && a.height === b.height);
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
      function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
      // Dark-cell background: median RGB of the darkest 20% of a 12x8 grid.
      function darkCellMedians(img) {
        var W = img.width, H = img.height, nx = 12, ny = 8, cells = [];
        for (var gy = 0; gy < ny; gy++) for (var gx = 0; gx < nx; gx++) {
          img.selectedRect = new Rect(Math.floor(gx*W/nx), Math.floor(gy*H/ny), Math.floor((gx+1)*W/nx), Math.floor((gy+1)*H/ny));
          var m = [];
          for (var c = 0; c < 3; c++) { img.selectedChannel = c; m.push(img.median()); }
          img.resetChannelSelection();
          cells.push({ l: 0.2126*m[0] + 0.7152*m[1] + 0.0722*m[2], m: m });
        }
        img.resetSelections();
        cells.sort(function (p, q) { return p.l - q.l; });
        var n = Math.max(3, Math.floor(cells.length * 0.2)), res = [0, 0, 0];
        for (var c2 = 0; c2 < 3; c2++) { var v = []; for (var i = 0; i < n; i++) v.push(cells[i].m[c2]); v.sort(function (p, q) { return p - q; }); res[c2] = v[Math.floor(v.length / 2)]; }
        return res;
      }
      var FAMS = ['red','orange_gold','yellow','green','cyan','blue','magenta'];
      function famOf(h) { return (h < 18 || h >= 335) ? 0 : h < 50 ? 1 : h < 70 ? 2 : h < 160 ? 3 : h < 200 ? 4 : h < 255 ? 5 : 6; }
      // Subject analysis of one image: a*b* histogram, hue-family fractions (saturated only), subject luminance list.
      function analyse(img, bg) {
        var W = img.width, H = img.height, color = img.isColor;
        __mark('pixel sampling (step ' + Math.max(1, Math.ceil(Math.sqrt(W * H / 200000))) + ')');
        var step = Math.max(1, Math.ceil(Math.sqrt(W * H / 200000)));
        var px = [], L = [];
        for (var y = 0; y < H; y += step) for (var x = 0; x < W; x += step) {
          var r, g, bl;
          if (color) { r = img.sample(x,y,0); g = img.sample(x,y,1); bl = img.sample(x,y,2); }
          else { r = img.sample(x,y); g = r; bl = r; }
          var l = 0.2126*r + 0.7152*g + 0.0722*bl;
          px.push([r, g, bl, l]); L.push(l);
        }
        var Ls = L.slice().sort(function (p, q) { return p - q; });
        var med = Ls[Math.floor(Ls.length / 2)];
        var dv = []; for (var i = 0; i < Ls.length; i++) dv.push(Math.abs(Ls[i] - med)); dv.sort(function (p, q) { return p - q; });
        var thr = med + 4 * 1.4826 * dv[Math.floor(dv.length / 2)];
        var subj = [];
        for (var i2 = 0; i2 < px.length; i2++) if (px[i2][3] > thr) subj.push(px[i2]);
        // <= 50k subject pixels (even stride)
        var cap = 50000, sel = subj;
        if (subj.length > cap) { sel = []; var kk = subj.length / cap; for (var j = 0; j < cap; j++) sel.push(subj[Math.min(subj.length - 1, Math.floor(j * kk + kk / 2))]); }
        var hist = []; for (var hI = 0; hI < 576; hI++) hist.push(0);
        var fam = [0,0,0,0,0,0,0], nSat = 0, lums = [];
        for (var s2 = 0; s2 < sel.length; s2++) {
          var p = sel[s2];
          lums.push(p[3]);
          if (color) {
            var lab = rgbToLab(clamp01(p[0] - bg[0]), clamp01(p[1] - bg[1]), clamp01(p[2] - bg[2]));
            chromaHistAdd(hist, lab[1], lab[2], 24, -60, 60);
          }
          var mx = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]), c = mx - mn;
          var sat = mx > 0 ? c / mx : 0;
          if (sat < 0.08) continue;
          var h = 0;
          if (c > 1e-6) {
            if (mx === p[0]) h = 60 * (((p[1] - p[2]) / c) % 6);
            else if (mx === p[1]) h = 60 * ((p[2] - p[0]) / c + 2);
            else h = 60 * ((p[0] - p[1]) / c + 4);
            if (h < 0) h += 360;
          }
          fam[famOf(h)]++; nSat++;
        }
        lums.sort(function (p, q) { return p - q; });
        var fr = []; for (var f = 0; f < 7; f++) fr.push(nSat > 0 ? fam[f] / nSat : 0);
        return { hist: hist, fam: fr, nSubject: sel.length, nSat: nSat, satFrac: sel.length > 0 ? nSat / sel.length : 0, lums: lums };
      }
      var bothColor = a.isColor && b.isColor;
      var bgA = a.isColor ? darkCellMedians(a) : [a.median(), a.median(), a.median()];
      var bgB = b.isColor ? darkCellMedians(b) : [b.median(), b.median(), b.median()];
      a.resetSelections(); b.resetSelections();
      var AA = analyse(a, bgA), BB = analyse(b, bgB);
      out.lum_cdf_dist = decileCdfDistance(AA.lums, BB.lums);
      out.subject_samples_target = AA.nSubject; out.subject_samples_ref = BB.nSubject;
      out.sat_frac_target = AA.satFrac; out.sat_frac_ref = BB.satFrac;
      out.bg_cast_delta = null; out.palette_l1 = null; out.lab_emd = null;
      if (bothColor) {
        var labA = rgbToLab(bgA[0], bgA[1], bgA[2]), labB = rgbToLab(bgB[0], bgB[1], bgB[2]);
        var da = labA[1] - labB[1], db = labA[2] - labB[2];
        out.bg_cast_delta = Math.sqrt(da*da + db*db);
        if (AA.nSat > 0 && BB.nSat > 0) {
          var l1 = 0; for (var f2 = 0; f2 < 7; f2++) l1 += Math.abs(AA.fam[f2] - BB.fam[f2]);
          out.palette_l1 = l1;
        }
        out.lab_emd = slicedWasserstein(AA.hist, BB.hist, 24, -60, 60, 8);
        out.fam_target = AA.fam; out.fam_ref = BB.fam;
      }
      out.color_emd = out.bg_cast_delta != null ? out.bg_cast_delta / 100.0 : 0;

      function faintFraction(img) {
        var bgM=img.median(), bgMAD=img.MAD();
        img.resetSelections();
        var lo=bgM+1*1.4826*bgMAD, hi=bgM+6*1.4826*bgMAD;
        __mark('detail loop');
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

      // STRUCTURE (2026-10-30), geometry-free and scale-relative so a downscaled screenshot reference
      // compares fairly with a 100 MP target. Global colour/brightness matching alone pulled a run
      // toward a flat muddy average (IC5146 4af9697f): these capture contrast the eye cares about.
      //   dark_depth  = (P50 - P5) / P50 of luminance  -> how far dark nebulae sit below the field
      //   lc_med/p90  = local contrast |L - mean(L at +-4 steps)| / P50, step = width/400
      function structureStats(img) {
        __mark('structure loop');
        var st = Math.max(1, Math.floor(img.width / 400)), k = 4 * st, Ls = [], lc = [];
        for (var y = k; y < img.height - k; y += st) for (var x = k; x < img.width - k; x += st) {
          var L = lumAt(img, x, y); Ls.push(L);
          var m = (lumAt(img, x - k, y) + lumAt(img, x + k, y) + lumAt(img, x, y - k) + lumAt(img, x, y + k)) / 4;
          lc.push(Math.abs(L - m));
        }
        Ls.sort(function (p, q) { return p - q; }); lc.sort(function (p, q) { return p - q; });
        function pc(a2, f) { return a2.length ? a2[Math.min(a2.length - 1, Math.floor(f * a2.length))] : 0; }
        var p50 = Math.max(1e-4, pc(Ls, 0.5));
        return { depth: (p50 - pc(Ls, 0.05)) / p50, lcMed: pc(lc, 0.5) / p50, lcP90: pc(lc, 0.9) / p50 };
      }
      var sT = structureStats(a), sR = structureStats(b);
      out.dark_depth_target = sT.depth; out.dark_depth_ref = sR.depth; out.dark_depth_delta = sR.depth - sT.depth;
      out.lc_ratio = sR.lcMed > 0 ? sT.lcMed / sR.lcMed : null; out.lc_p90_ratio = sR.lcP90 > 0 ? sT.lcP90 / sR.lcP90 : null;

      // MS-SSIM last: both images at a common ~${targetWidth}px width. The reference window is ours
      // and is resampled in place; the target is only ever duplicated, never touched.
      __mark('ms-ssim resample (new 60 MP window + Resample)');
      var ms_ssim = null, perScale = [];
      {
        var tw = ${targetWidth};
        tmpW = new ImageWindow(a.width, a.height, a.numberOfChannels, 32, true, a.isColor, '${tmpId}');
        tmpW.mainView.beginProcess(); tmpW.mainView.image.assign(a); tmpW.mainView.endProcess();
        var shrink = function (win) {
          var im0 = win.mainView.image;
          var R = new Resample;
          R.mode = Resample.prototype.AbsolutePixels;
          R.xSize = tw; R.ySize = Math.round(tw * im0.height / im0.width);
          R.absoluteMode = Resample.prototype.ForceWidthAndHeight;
          R.interpolation = Resample.prototype.MitchellNetravaliFilter;
          R.executeOn(win.mainView);
        };
        shrink(tmpW); shrink(rw);
        var ta = tmpW.mainView.image, tb = rw.mainView.image;
        // GRAIN (2026-10-31, Abell2151 96508fc1): pixel-scale granularity inside extended subject
        // halos and in the sky, both images at the same width so the ratio is scale-fair. The run
        // passed every gate while its galaxies were ~1.9x grainier than the reference (LHE after
        // the last NXT + noisy L injection). hf = |L - mean of 4 neighbours|; halo = smooth level
        // between P50+0.06 and P50+0.35, star-like pixels excluded.
        function grainStats(img) {
          __mark('grain loop');
          var W2 = img.width, H2 = img.height, Ls2 = [];
          for (var y = 8; y < H2 - 8; y += 4) for (var x = 8; x < W2 - 8; x += 4) Ls2.push(lumAt(img, x, y));
          Ls2.sort(function (p, q) { return p - q; });
          var p50 = Ls2.length ? Ls2[Math.floor(Ls2.length / 2)] : 0;
          var halo = [], sky = [];
          for (var y = 8; y < H2 - 8; y += 2) for (var x = 8; x < W2 - 8; x += 2) {
            var L = lumAt(img, x, y);
            var n1 = (lumAt(img, x - 1, y) + lumAt(img, x + 1, y) + lumAt(img, x, y - 1) + lumAt(img, x, y + 1)) / 4;
            var wide = (lumAt(img, x - 6, y) + lumAt(img, x + 6, y) + lumAt(img, x, y - 6) + lumAt(img, x, y + 6)
                      + lumAt(img, x - 4, y - 4) + lumAt(img, x + 4, y + 4) + lumAt(img, x - 4, y + 4) + lumAt(img, x + 4, y - 4)) / 8;
            if (Math.abs(L - wide) > 0.08) continue;
            var hf = Math.abs(L - n1);
            if (wide > p50 + 0.06 && wide < p50 + 0.35) halo.push(hf);
            else if (wide < p50 + 0.01) sky.push(hf);
          }
          halo.sort(function (p, q) { return p - q; }); sky.sort(function (p, q) { return p - q; });
          return { halo: halo.length > 200 ? halo[Math.floor(halo.length / 2)] : null, sky: sky.length > 200 ? sky[Math.floor(sky.length / 2)] : null, nHalo: halo.length };
        }
        var gT = grainStats(ta), gR = grainStats(tb);
        out.grain_halo_target = gT.halo; out.grain_halo_ref = gR.halo; out.grain_sky_target = gT.sky; out.grain_sky_ref = gR.sky;
        out.grain_halo_ratio = (gT.halo != null && gR.halo > 0) ? gT.halo / gR.halo : null;
        out.grain_sky_ratio = (gT.sky != null && gR.sky > 0) ? gT.sky / gR.sky : null;
        if (aspectOk && ta.width === tb.width && ta.height === tb.height) {
          var W = ta.width, H = ta.height;
          var C1=0.0001, C2=0.0009;
          var scaleSteps=[2,4,8];
          var prod=1.0, valid=0;
          for (var si=0; si<scaleSteps.length; si++) {
            var step=scaleSteps[si];
            var win=step*3;
            var sumS=0, cnt=0;
            for (var by=win; by<H-win; by+=win) {
              for (var bx=win; bx<W-win; bx+=win) {
                var ma=0, mb=0, k=0;
                for (var yy=by-win; yy<=by+win; yy+=step) { for (var xx=bx-win; xx<=bx+win; xx+=step) { ma+=lumAt(ta,xx,yy); mb+=lumAt(tb,xx,yy); k++; } }
                if (k<4) continue;
                ma/=k; mb/=k;
                var va=0, vb=0, cov=0;
                for (var yy=by-win; yy<=by+win; yy+=step) { for (var xx=bx-win; xx<=bx+win; xx+=step) { var pa=lumAt(ta,xx,yy)-ma, pb=lumAt(tb,xx,yy)-mb; va+=pa*pa; vb+=pb*pb; cov+=pa*pb; } }
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
      }
      out.ms_ssim = ms_ssim; out.ms_ssim_per_scale = perScale;
    } finally {
      __mark('closing windows');
      // Gentle close: purge + drain events + settle before the next heavy call
      // (PI 1.9.5 aborted after back-to-back 60 MP close/open, 2026-10-28).
      if (tmpW && !tmpW.isNull) { try { tmpW.purge(); } catch (e0) {} tmpW.forceClose(); }
      processEvents();
      for (var ci=0; ci<refArr.length; ci++) { if(!refArr[ci].isNull) { try { refArr[ci].purge(); } catch (e1) {} refArr[ci].forceClose(); } }
      processEvents(); msleep(1500); processEvents();
    }
    JSON.stringify(out);
  `);
  if (r.status === 'error') return { error: r.error?.message || 'compareToReference failed' };
  let data;
  try { data = JSON.parse(r.outputs?.consoleOutput?.trim() || '{}'); }
  catch { return { error: 'compareToReference: unparseable result' }; }
  if (data.error) return data;
  const f3 = v => (v == null ? 'n/a' : (+v).toFixed(3));
  const f1 = v => (v == null ? 'n/a' : (+v).toFixed(1));
  data.details =
    `bg_cast_delta=${f1(data.bg_cast_delta)} dE(a*b*) [color_emd alias=${f3(data.color_emd)}]; ` +
    `palette_l1=${f3(data.palette_l1)} (saturated subject: target ${f3(data.sat_frac_target)}, ref ${f3(data.sat_frac_ref)}); ` +
    `lab_emd=${f1(data.lab_emd)} (chroma-only a*b*); lum_cdf_dist=${f3(data.lum_cdf_dist)}; ` +
    `ms_ssim=${data.aspect_ok ? f3(data.ms_ssim) : 'n/a (aspect mismatch)'}; ` +
    `coverage_delta=${f3(data.coverage_delta)} (faint target=${f3(data.faint_target)}, ref=${f3(data.faint_ref)}); ` +
    `dark_depth target=${f3(data.dark_depth_target)} ref=${f3(data.dark_depth_ref)}; local_contrast ratio=${f3(data.lc_ratio)} (p90 ${f3(data.lc_p90_ratio)}; 1.0 = same as reference); grain halo ratio=${f3(data.grain_halo_ratio)} sky ratio=${f3(data.grain_sky_ratio)} (>1 = grainier than reference)`;
  return data;
}


/**
 * Background floor — "crushed to black" detector (2026-10-29, user-approved gate #2).
 * Blocks of 64 px whose luminance median is below global median + 3*sigma are background.
 * Returns the sky level (median of those block medians), its p10/p90, and the fraction of
 * background blocks that are essentially black (< 0.015). Stretched images only.
 */
export async function measureBackgroundFloor(ctx, viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureBackgroundFloor: view not found: ${viewId}');
    var img = w.mainView.image;
    var gMed = img.median(), gMAD = img.MAD();
    var thr = gMed + 3 * 1.4826 * gMAD;
    var B = 64, meds = [], nBlocks = 0;
    for (var by = 0; by + B <= img.height; by += B) {
      for (var bx = 0; bx + B <= img.width; bx += B) {
        img.selectedRect = new Rect(bx, by, bx + B, by + B);
        var m;
        if (img.isColor) {
          img.selectedChannel = 0; var r0 = img.median();
          img.selectedChannel = 1; var g0 = img.median();
          img.selectedChannel = 2; var b0 = img.median();
          img.resetChannelSelection();
          m = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
        } else m = img.median();
        nBlocks++;
        if (m < thr) meds.push(m);
      }
    }
    img.resetSelections();
    meds.sort(function(a, b) { return a - b; });
    var n = meds.length;
    function q(p) { return n ? meds[Math.min(n - 1, Math.floor(p * n))] : 0; }
    var black = 0; for (var i = 0; i < n; i++) if (meds[i] < 0.015) black++;
    JSON.stringify({ bgLevel: q(0.5), p10: q(0.1), p90: q(0.9), blackBlockFraction: n ? black / n : 0,
                     bgBlocks: n, totalBlocks: nBlocks, globalMedian: gMed, blockSize: B });
  `);
  if (r.status === 'error') throw new Error('measureBackgroundFloor: ' + (r.error?.message || 'PJSR error'));
  const d = JSON.parse(r.outputs?.consoleOutput || '{}');
  d.details = `sky level ${(d.bgLevel ?? 0).toFixed(4)} (p10 ${(d.p10 ?? 0).toFixed(4)}, p90 ${(d.p90 ?? 0).toFixed(4)}), black background blocks ${((d.blackBlockFraction ?? 0) * 100).toFixed(1)}% of ${d.bgBlocks}`;
  return d;
}

/**
 * Faint-disc retention (2026-11-07, M74 v2): the tonal gate rewards darkening a galaxy's faint
 * outer disc, so nothing stopped truncated outer arms. Block-median luminance map (24 px blocks,
 * no resampling of the image itself) -> sky = median block; galaxy = largest connected region
 * 0.02 above sky, grown (<= 50 blocks) through blocks 0.015 above sky. faintFraction = share of
 * galaxy blocks less than 0.05 above sky; extent = galaxy blocks / blocks 0.10 above sky.
 * Calibration (python prototype, same algorithm): approved NGC4490 RGB 0.437, NGC3628 v3 0.504;
 * user-rejected M74 v1 0.319, M74 v2 0.313.
 */
export function summarizeFaintDisc(grid, w, h) {
  const n = w * h; if (!n) return { faintFraction: 0, extent: 0, galaxyBlocks: 0 };
  const sorted = Array.from(grid).sort((a, b) => a - b); const sky = sorted[Math.floor(n / 2)];
  const e = new Float64Array(n); for (let i = 0; i < n; i++) e[i] = grid[i] - sky;
  const label = (mask) => {          // 4-connected components
    const lab = new Int32Array(n); let next = 0; const stack = [];
    for (let s = 0; s < n; s++) { if (!mask[s] || lab[s]) continue; next++; lab[s] = next; stack.push(s);
      while (stack.length) { const p = stack.pop(), x = p % w, y = (p - x) / w;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
          if (q >= 0 && mask[q] && !lab[q]) { lab[q] = next; stack.push(q); } } }
    return { lab, count: next };
  };
  const core = new Uint8Array(n); for (let i = 0; i < n; i++) core[i] = e[i] > 0.02 ? 1 : 0;
  const { lab, count } = label(core); if (!count) return { faintFraction: 0, extent: 0, galaxyBlocks: 0, sky };
  const sizes = new Int32Array(count + 1); for (let i = 0; i < n; i++) sizes[lab[i]]++;
  let best = 1; for (let k = 2; k <= count; k++) if (sizes[k] > sizes[best]) best = k;
  // manhattan distance (<= 50) from the core region = scipy binary_dilation(iterations=50)
  const dist = new Int32Array(n).fill(1e9); const qu = [];
  for (let i = 0; i < n; i++) if (lab[i] === best) { dist[i] = 0; qu.push(i); }
  for (let qi = 0; qi < qu.length; qi++) { const p = qu[qi], x = p % w, y = (p - x) / w; if (dist[p] >= 50) continue;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
      if (q >= 0 && dist[q] > dist[p] + 1) { dist[q] = dist[p] + 1; qu.push(q); } }
  const grow = new Uint8Array(n); for (let i = 0; i < n; i++) grow[i] = dist[i] <= 50 && e[i] > 0.015 ? 1 : 0;
  const g2 = label(grow); const keep = new Set(); for (let i = 0; i < n; i++) if (lab[i] === best && g2.lab[i]) keep.add(g2.lab[i]);
  let gal = 0, faint = 0, bright = 0;
  for (let i = 0; i < n; i++) if (keep.has(g2.lab[i])) { gal++; if (e[i] < 0.05) faint++; if (e[i] > 0.10) bright++; }
  return { faintFraction: gal ? faint / gal : 0, extent: gal / Math.max(bright, 1), galaxyBlocks: gal, sky };
}

export async function measureFaintDisc(ctx, viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureFaintDisc: view not found: ${viewId}');
    var img = w.mainView.image, B = 24, gw = Math.floor(img.width / B), gh = Math.floor(img.height / B), g = [];
    for (var by = 0; by < gh; by++) for (var bx = 0; bx < gw; bx++) {
      img.selectedRect = new Rect(bx * B, by * B, bx * B + B, by * B + B);
      if (img.isColor) {
        img.selectedChannel = 0; var r0 = img.median(); img.selectedChannel = 1; var g0 = img.median(); img.selectedChannel = 2; var b0 = img.median();
        g.push(Math.round((0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0) * 1e5) / 1e5);
      } else g.push(Math.round(img.median() * 1e5) / 1e5);
    }
    img.resetSelections();
    JSON.stringify({ w: gw, h: gh, g: g });
  `, { timeout: 600000 });
  if (r.status === 'error') throw new Error('measureFaintDisc: ' + (r.error?.message || 'PJSR error'));
  const d = JSON.parse(r.outputs?.consoleOutput || '{}');
  const s = summarizeFaintDisc(d.g || [], d.w || 0, d.h || 0);
  s.details = `faint outer disc ${(s.faintFraction * 100).toFixed(1)}% of galaxy area (extent ${s.extent.toFixed(2)}x the bright body, ${s.galaxyBlocks} blocks of 24 px)`;
  return s;
}

/**
 * Scale-band balance on the galaxy disc (2026-11-07, M74 v2 "watercolour" look): ratio of
 * fine-band (gauss 0.7k - gauss 3k px) to blob-band (gauss 3k - gauss 6k px), k = r_disc/300 (size-relative) luminance std over disc
 * pixels (48 px blocks 0.05 above sky; star pixels rejected). Compared final / prep baseline
 * (fineRetention). M74 v2 measured 0.5-0.7 in the disc with the 3-6 px band boosted 1.6x.
 * ADVISORY only until calibrated on an approved galaxy run.
 */
export async function measureScaleBands(ctx, viewId, { rDisc = null } = {}) {
  // rDisc: fix the scale from the PREP disc radius — the final image's own radius grows when faint outskirts are
  // lifted, which coarsens the bands and lets a soft disc pass (M74 v4: 552 prep -> 681 final).
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureScaleBands: view not found: ${viewId}');
    var img = w.mainView.image, W = img.width, H = img.height, B = 48, gw = Math.floor(W / B), gh = Math.floor(H / B);
    function lumBlock(rect) { if (!img.isColor) { img.selectedRect = rect; return img.median(); }
      img.selectedRect = rect; img.selectedChannel = 0; var a = img.median(); img.selectedChannel = 1; var b = img.median(); img.selectedChannel = 2; var c = img.median();
      img.resetChannelSelection(); return 0.2126 * a + 0.7152 * b + 0.0722 * c; }
    var g = [], i, x, y;
    for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) g.push(lumBlock(new Rect(x * B, y * B, x * B + B, y * B + B)));
    img.resetSelections();
    var s = g.slice().sort(function (a, b) { return a - b; }), sky = s[Math.floor(s.length / 2)];
    var x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, nd = 0;
    for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) if (g[y * gw + x] - sky > 0.05) { nd++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    var out;
    if (nd < 20) out = { error: 'no disc', discBlocks: nd };
    else {
      var px0 = x0 * B, py0 = y0 * B, bw = (x1 - x0 + 1) * B, bh = (y1 - y0 + 1) * B;
      if (bw * bh > 16e6) { var k = Math.sqrt(16e6 / (bw * bh)); var nw = Math.floor(bw * k / B) * B, nh = Math.floor(bh * k / B) * B; px0 += Math.floor((bw - nw) / 2 / B) * B; py0 += Math.floor((bh - nh) / 2 / B) * B; bw = nw; bh = nh; }
      var rect = new Rect(px0, py0, px0 + bw, py0 + bh), n = bw * bh, L = new Float32Array(n);
      if (img.isColor) { var c0 = new Float32Array(n), c1 = new Float32Array(n), c2 = new Float32Array(n);
        img.getSamples(c0, rect, 0); img.getSamples(c1, rect, 1); img.getSamples(c2, rect, 2);
        for (i = 0; i < n; i++) L[i] = 0.2126 * c0[i] + 0.7152 * c1[i] + 0.0722 * c2[i]; }
      else img.getSamples(L, rect, 0);
      function blur(src, sig) { var rad = Math.ceil(3 * sig), kk = [], t = 0, j;
        for (j = -rad; j <= rad; j++) { var v = Math.exp(-j * j / (2 * sig * sig)); kk.push(v); t += v; } for (j = 0; j < kk.length; j++) kk[j] /= t;
        var tmp = new Float32Array(n), dst = new Float32Array(n), xx, yy, acc, q;
        for (yy = 0; yy < bh; yy++) for (xx = 0; xx < bw; xx++) { acc = 0; for (j = -rad; j <= rad; j++) { q = xx + j; if (q < 0) q = 0; else if (q >= bw) q = bw - 1; acc += kk[j + rad] * src[yy * bw + q]; } tmp[yy * bw + xx] = acc; }
        for (yy = 0; yy < bh; yy++) for (xx = 0; xx < bw; xx++) { acc = 0; for (j = -rad; j <= rad; j++) { q = yy + j; if (q < 0) q = 0; else if (q >= bh) q = bh - 1; acc += kk[j + rad] * tmp[q * bw + xx]; } dst[yy * bw + xx] = acc; }
        return dst; }
      var rD = ${Number.isFinite(rDisc) && rDisc > 0 ? Number(rDisc) : 'Math.sqrt(nd * B * B / Math.PI)'}, kS = Math.max(0.6, rD / 300);   // galaxy-size-relative scales (r_disc 300 px -> 0.7/3/6 px)
      var g07 = blur(L, 0.7 * kS), g3 = blur(L, 3 * kS), g6 = blur(L, 6 * kS);
      var sf = 0, sf2 = 0, sm = 0, sm2 = 0, cnt = 0;
      for (y = 0; y < bh; y++) for (x = 0; x < bw; x++) {
        var gx = Math.floor((px0 + x) / B), gy = Math.floor((py0 + y) / B);
        if (gx >= gw || gy >= gh || g[gy * gw + gx] - sky <= 0.05) continue;
        i = y * bw + x; if (L[i] - g6[i] > 0.05) continue;   // star / hot knot core
        var f = g07[i] - g3[i], m = g3[i] - g6[i]; sf += f; sf2 += f * f; sm += m; sm2 += m * m; cnt++; }
      var sdF = Math.sqrt(Math.max(0, sf2 / cnt - (sf / cnt) * (sf / cnt))), sdM = Math.sqrt(Math.max(0, sm2 / cnt - (sm / cnt) * (sm / cnt)));
      out = { fine: sdF, blob: sdM, ratio: sdM > 0 ? sdF / sdM : 0, pixels: cnt, discBlocks: nd, rDisc: Math.round(rD), scaleK: kS, box: [px0, py0, bw, bh] };
    }
    JSON.stringify(out);
  `, { timeout: 900000 });
  if (r.status === 'error') throw new Error('measureScaleBands: ' + (r.error?.message || 'PJSR error'));
  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

/**
 * Disc mottle ("watercolour" blotchiness, 2026-11-07): relative contrast of a galaxy disc at blob
 * scale = std(gauss(s) - gauss(l)) / mean(gauss(l) - sky) over disc pixels, per zone (mid = 25-60%
 * of the disc's p99 brightness above sky, outer = below 25%). Scales follow the galaxy size
 * (r = sqrt(area/pi) from the 24 px block map: s = r/300, l = r/38), so a 2k web JPEG and a 9k
 * master are comparable. Python prototype on the user's references (M101 x2, M83): mid 0.07-0.10,
 * outer 0.12-0.21; M74 v2 (user: "mottled") mid 0.15, outer 0.25.
 */
export function galaxyBlockMask(grid, w, h) {
  const n = w * h; const sorted = Array.from(grid).sort((a, b) => a - b); const sky = sorted[Math.floor(n / 2)];
  const core = new Uint8Array(n); for (let i = 0; i < n; i++) core[i] = grid[i] - sky > 0.02 ? 1 : 0;
  const lab = new Int32Array(n); let next = 0, best = 0, bestN = 0; const st = [];
  for (let s = 0; s < n; s++) { if (!core[s] || lab[s]) continue; next++; let cnt = 0; lab[s] = next; st.push(s);
    while (st.length) { const p = st.pop(), x = p % w, y = (p - x) / w; cnt++;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
        if (q >= 0 && core[q] && !lab[q]) { lab[q] = next; st.push(q); } }
    if (cnt > bestN) { bestN = cnt; best = next; } }
  let bits = ''; for (let i = 0; i < n; i++) bits += lab[i] === best ? '1' : '0';
  return { bits, blocks: bestN, sky };
}

export async function measureDiscMottle(ctx, viewId, { radius = null } = {}) {
  const B = 24;
  const g = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('measureDiscMottle: view not found: ${viewId}');
    var img = w.mainView.image, gw = Math.floor(img.width / ${B}), gh = Math.floor(img.height / ${B}), g = [];
    for (var by = 0; by < gh; by++) for (var bx = 0; bx < gw; bx++) {
      img.selectedRect = new Rect(bx * ${B}, by * ${B}, bx * ${B} + ${B}, by * ${B} + ${B});
      if (img.isColor) { img.selectedChannel = 0; var a = img.median(); img.selectedChannel = 1; var b = img.median(); img.selectedChannel = 2; var c = img.median(); img.resetChannelSelection(); g.push(Math.round((0.2126 * a + 0.7152 * b + 0.0722 * c) * 1e5) / 1e5); }
      else g.push(Math.round(img.median() * 1e5) / 1e5); }
    img.resetSelections(); JSON.stringify({ w: gw, h: gh, g: g });`, { timeout: 600000 });
  if (g.status === 'error') throw new Error('measureDiscMottle grid: ' + (g.error?.message || 'PJSR error'));
  const d = JSON.parse(g.outputs?.consoleOutput || '{}');
  const m = galaxyBlockMask(d.g || [], d.w, d.h);
  if (m.blocks < 20) return { error: 'no galaxy', blocks: m.blocks };
  const r = (Number.isFinite(radius) && radius > 0) ? radius : Math.sqrt(m.blocks * B * B / Math.PI), sS = Math.max(0.6, r / 300), sL = Math.max(4, r / 38);
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); var img = w.mainView.image, W = img.width, H = img.height, n = W * H, i;
    var L = new Float32Array(n);
    if (img.isColor) { var c = new Float32Array(n); img.getSamples(c, new Rect(0,0,W,H), 0); for (i = 0; i < n; i++) L[i] = 0.2126 * c[i];
      img.getSamples(c, new Rect(0,0,W,H), 1); for (i = 0; i < n; i++) L[i] += 0.7152 * c[i]; img.getSamples(c, new Rect(0,0,W,H), 2); for (i = 0; i < n; i++) L[i] += 0.0722 * c[i]; }
    else img.getSamples(L, new Rect(0,0,W,H), 0);
    function blurred(sig, id) { var bw = new ImageWindow(W, H, 1, 32, true, false, id); bw.mainView.beginProcess(); bw.mainView.image.setSamples(L, new Rect(0,0,W,H), 0); bw.mainView.endProcess();
      var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = sig; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(bw.mainView);
      var o = new Float32Array(n); bw.mainView.image.getSamples(o, new Rect(0,0,W,H), 0); bw.forceClose(); return o; }
    var gs = blurred(${sS.toFixed(3)}, 'MOT_S'), gl = blurred(${sL.toFixed(3)}, 'MOT_L'), g6 = blurred(${(Math.max(2, r / 75)).toFixed(3)}, 'MOT_6');
    var bits = '${m.bits}', gw = ${d.w}, sky = ${m.sky}, B = ${B}, e = [], x, y;
    function inGal(x, y) { var bx = Math.floor(x / B), by = Math.floor(y / B); return bx < gw && bits.charAt(by * gw + bx) === '1'; }
    for (y = 0; y < H; y += 4) for (x = 0; x < W; x += 4) if (inGal(x, y)) e.push(gl[y * W + x] - sky);
    e.sort(function (a, b) { return a - b; }); var top = e[Math.floor(e.length * 0.99)];
    var z = { mid: [0, 0, 0, 0], outer: [0, 0, 0, 0] };
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) { if (!inGal(x, y)) continue; i = y * W + x;
      if (L[i] - g6[i] > 0.06) continue;
      var ev = gl[i] - sky, k = ev < 0.25 * top ? 'outer' : (ev < 0.6 * top ? 'mid' : null); if (!k || ev <= 0) continue;
      var dd = gs[i] - gl[i], a = z[k]; a[0] += dd; a[1] += dd * dd; a[2] += ev; a[3]++; }
    function web(a) { if (a[3] < 100) return null; var mu = a[0] / a[3]; return Math.sqrt(Math.max(0, a[1] / a[3] - mu * mu)) / Math.max(a[2] / a[3], 1e-3); }
    JSON.stringify({ mid: web(z.mid), outer: web(z.outer), midPx: z.mid[3], outerPx: z.outer[3] });`, { timeout: 900000 });
  if (res.status === 'error') throw new Error('measureDiscMottle: ' + (res.error?.message || 'PJSR error'));
  const o = JSON.parse(res.outputs?.consoleOutput || '{}');
  o.radius = Math.round(r); o.sigmas = [+sS.toFixed(2), +sL.toFixed(2)];
  o.details = `disc mottle mid ${o.mid?.toFixed(3)} outer ${o.outer?.toFixed(3)} (galaxy r~${o.radius}px, bands ${o.sigmas.join('-')}px)`;
  return o;
}

// Outer-arm visibility (2026-11-07, M74 v3: arms present in the linear L to ~6' but displayed at <0.01 above sky).
// Spread (p90-p10) of the sigma-8 smoothed display luminance in an annulus [r0,r1] px around the galaxy core,
// star pixels excluded (g2-g8 excess). Arms vs inter-arm contrast, insensitive to a uniform glow lift.
export async function measureOuterArms(ctx, viewId, r0, r1, sigma = 8) {
  const B = 24;
  const g = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('measureOuterArms: view not found: ${viewId}');
    var img = w.mainView.image, gw = Math.floor(img.width / ${B}), gh = Math.floor(img.height / ${B}), g = [];
    for (var by = 0; by < gh; by++) for (var bx = 0; bx < gw; bx++) {
      img.selectedRect = new Rect(bx * ${B}, by * ${B}, bx * ${B} + ${B}, by * ${B} + ${B});
      if (img.isColor) { img.selectedChannel = 0; var a = img.median(); img.selectedChannel = 1; var b = img.median(); img.selectedChannel = 2; var c = img.median(); img.resetChannelSelection(); g.push(Math.round((0.2126 * a + 0.7152 * b + 0.0722 * c) * 1e5) / 1e5); }
      else g.push(Math.round(img.median() * 1e5) / 1e5); }
    img.resetSelections(); JSON.stringify({ w: gw, h: gh, g: g });`, { timeout: 600000 });
  if (g.status === 'error') throw new Error('measureOuterArms grid: ' + (g.error?.message || 'PJSR error'));
  const d = JSON.parse(g.outputs?.consoleOutput || '{}');
  const m = galaxyBlockMask(d.g || [], d.w, d.h);
  if (m.blocks < 20) return { error: 'no galaxy', blocks: m.blocks };
  // core = brightest block inside the galaxy component (block medians reject stars)
  let bi = -1, bv = -Infinity; for (let i = 0; i < m.bits.length; i++) if (m.bits[i] === '1' && d.g[i] > bv) { bv = d.g[i]; bi = i; }
  const cx = (bi % d.w) * B + B / 2, cy = Math.floor(bi / d.w) * B + B / 2;
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); var img = w.mainView.image, W = img.width, H = img.height, n = W * H, i;
    var L = new Float32Array(n);
    if (img.isColor) { var c = new Float32Array(n); img.getSamples(c, new Rect(0,0,W,H), 0); for (i = 0; i < n; i++) L[i] = 0.2126 * c[i];
      img.getSamples(c, new Rect(0,0,W,H), 1); for (i = 0; i < n; i++) L[i] += 0.7152 * c[i]; img.getSamples(c, new Rect(0,0,W,H), 2); for (i = 0; i < n; i++) L[i] += 0.0722 * c[i]; }
    else img.getSamples(L, new Rect(0,0,W,H), 0);
    function blurred(sig, id) { var bw = new ImageWindow(W, H, 1, 32, true, false, id); bw.mainView.beginProcess(); bw.mainView.image.setSamples(L, new Rect(0,0,W,H), 0); bw.mainView.endProcess();
      var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = sig; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(bw.mainView);
      var o = new Float32Array(n); bw.mainView.image.getSamples(o, new Rect(0,0,W,H), 0); bw.forceClose(); return o; }
    var g2 = blurred(2, 'ARM_2'), g8 = blurred(${sigma}, 'ARM_8'), cx = ${cx}, cy = ${cy}, r0 = ${r0}, r1 = ${r1}, v = [], sk = [], x, y;
    for (y = 0; y < H; y += 2) for (x = 0; x < W; x += 2) { var dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy); i = y * W + x;
      if (g2[i] - g8[i] > 0.02) continue;
      if (r >= r0 && r < r1) v.push(g8[i]); else if (r >= r1 + 150 && r < r1 + 250) sk.push(g8[i]); }
    function q(a, p) { return a[Math.min(a.length - 1, Math.floor(a.length * p))]; }
    v.sort(function (a, b) { return a - b; }); sk.sort(function (a, b) { return a - b; });
    JSON.stringify({ n: v.length, p10: q(v, 0.1), p50: q(v, 0.5), p90: q(v, 0.9), sky: sk.length ? q(sk, 0.5) : null, skySpread: sk.length > 100 ? q(sk, 0.9) - q(sk, 0.1) : null });`, { timeout: 900000 });
  if (res.status === 'error') throw new Error('measureOuterArms: ' + (res.error?.message || 'PJSR error'));
  const o = JSON.parse(res.outputs?.consoleOutput || '{}');
  if (!(o.n > 500)) return { error: 'annulus empty', n: o.n, centre: [cx, cy] };
  o.spread = o.p90 - o.p10; o.net = o.spread - (o.skySpread || 0); o.centre = [cx, cy]; o.r = [r0, r1];
  o.details = `outer-arm net contrast ${o.net.toFixed(4)} (spread ${o.spread.toFixed(4)} in r ${r0}-${r1}px (median ${o.p50.toFixed(3)}, sky ${o.sky?.toFixed(3)}, sky spread ${o.skySpread?.toFixed(4)})), core at ${cx},${cy}`;
  return o;
}

/**
 * Radial zone statistics around a centre on the sigma-smoothed luminance (stars / star residuals excluded by
 * g2-gS excess). zones: [[r0,r1], ...] in px. Returns per zone {n,p10,p50,p90} plus noise (MAD of gS-g40 on
 * sky blocks) when withNoise. Shared by the prep signal inventory and the finish gates (same geometry).
 */

const EMPTY_PJSR = (sig) => `
    var EMP = null; (function () { var ne = 0, E = new Float32Array(n); for (var j = 0; j < n; j++) if (L[j] <= 1e-6) { E[j] = 1; ne++; }
      if (ne > 0 && ne < n) { var ew = new ImageWindow(W, H, 1, 32, true, false, 'EMPTY_M'); ew.mainView.beginProcess(); ew.mainView.image.setSamples(E, new Rect(0,0,W,H), 0); ew.mainView.endProcess();
        var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = ${sig}; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(ew.mainView);
        EMP = new Float32Array(n); ew.mainView.image.getSamples(EMP, new Rect(0,0,W,H), 0); ew.forceClose(); } })();
    function isEmpty(j) { return EMP !== null && EMP[j] > 0.002; }`;

export async function measureRadialZones(ctx, viewId, centre, zones, { sigma = 8, withNoise = false, skyBits = null, gridW = 0, B = 24 } = {}) {
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('measureRadialZones: view not found: ${viewId}');
    var img = w.mainView.image, W = img.width, H = img.height, n = W * H, i;
    var L = new Float32Array(n);
    if (img.isColor) { var c = new Float32Array(n); img.getSamples(c, new Rect(0,0,W,H), 0); for (i = 0; i < n; i++) L[i] = 0.2126 * c[i];
      img.getSamples(c, new Rect(0,0,W,H), 1); for (i = 0; i < n; i++) L[i] += 0.7152 * c[i]; img.getSamples(c, new Rect(0,0,W,H), 2); for (i = 0; i < n; i++) L[i] += 0.0722 * c[i]; }
    else img.getSamples(L, new Rect(0,0,W,H), 0);
    ${EMPTY_PJSR(3 * sigma)}
    function blurred(sig, id) { var bw = new ImageWindow(W, H, 1, 32, true, false, id); bw.mainView.beginProcess(); bw.mainView.image.setSamples(L, new Rect(0,0,W,H), 0); bw.mainView.endProcess();
      var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = sig; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(bw.mainView);
      var o = new Float32Array(n); bw.mainView.image.getSamples(o, new Rect(0,0,W,H), 0); bw.forceClose(); return o; }
    var g2 = blurred(2, 'RZ_2'), gS = blurred(${sigma}, 'RZ_S'), cx = ${centre[0]}, cy = ${centre[1]}, Z = ${JSON.stringify(zones)}, k, x, y;
    var acc = []; for (k = 0; k < Z.length; k++) acc.push([]);
    var rMaxZ = 0; for (k = 0; k < Z.length; k++) if (Z[k][1] > rMaxZ) rMaxZ = Z[k][1];
    for (y = 0; y < H; y += 2) for (x = 0; x < W; x += 2) { var dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy); if (r >= rMaxZ) continue; i = y * W + x;
      if (g2[i] - gS[i] > 0.02 || isEmpty(i)) continue;
      for (k = 0; k < Z.length; k++) if (r >= Z[k][0] && r < Z[k][1]) acc[k].push(gS[i]); }
    function q(a, p) { return a[Math.min(a.length - 1, Math.floor(a.length * p))]; }
    var out = { zones: [] };
    for (k = 0; k < Z.length; k++) { var a = acc[k]; a.sort(function (u, v) { return u - v; });
      out.zones.push(a.length ? { n: a.length, p10: q(a, 0.1), p50: q(a, 0.5), p90: q(a, 0.9) } : { n: 0 }); }
    ${withNoise ? `
    var g40 = blurred(40, 'RZ_40'), bits = '${skyBits || ''}', gw = ${gridW}, B = ${B}, hp = [];
    for (y = 0; y < H; y += 4) for (x = 0; x < W; x += 4) { var bx = Math.floor(x / B), by = Math.floor(y / B);
      if (bits.length && bits.charAt(by * gw + bx) !== '1') continue; i = y * W + x; if (isEmpty(i)) continue; if (g2[i] - gS[i] > 0.02) continue; hp.push(gS[i] - g40[i]); }
    hp.sort(function (u, v) { return u - v; }); var md = q(hp, 0.5), dev = []; for (k = 0; k < hp.length; k++) dev.push(Math.abs(hp[k] - md));
    dev.sort(function (u, v) { return u - v; }); out.noise = 1.4826 * q(dev, 0.5); out.noiseN = hp.length;` : ''}
    JSON.stringify(out);`, { timeout: 900000 });
  if (res.status === 'error') throw new Error('measureRadialZones: ' + (res.error?.message || 'PJSR error'));
  return JSON.parse(res.outputs?.consoleOutput || '{}');
}

async function lumGrid(ctx, viewId, B) {
  const g = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('lumGrid: view not found: ${viewId}');
    var img = w.mainView.image, gw = Math.floor(img.width / ${B}), gh = Math.floor(img.height / ${B}), g = [];
    for (var by = 0; by < gh; by++) for (var bx = 0; bx < gw; bx++) {
      img.selectedRect = new Rect(bx * ${B}, by * ${B}, bx * ${B} + ${B}, by * ${B} + ${B});
      if (img.isColor) { img.selectedChannel = 0; var a = img.median(); img.selectedChannel = 1; var b = img.median(); img.selectedChannel = 2; var c = img.median(); img.resetChannelSelection(); g.push(Math.round((0.2126 * a + 0.7152 * b + 0.0722 * c) * 1e6) / 1e6); }
      else g.push(Math.round(img.median() * 1e6) / 1e6); }
    img.resetSelections(); JSON.stringify({ w: gw, h: gh, W: img.width, H: img.height, g: g });`, { timeout: 600000 });
  if (g.status === 'error') throw new Error('lumGrid: ' + (g.error?.message || 'PJSR error'));
  return JSON.parse(g.outputs?.consoleOutput || '{}');
}

/**
 * Pure: detection radius from a radial profile. ann = [{r0,r1,p10,p50,p90,n}] on the sigma-smoothed view.
 * Detection = arm/inter-arm STRUCTURE (p90-p10) above the sky's own texture (skySpread: residual galaxies,
 * gradients), in units of the smoothed noise. The annulus median level is NOT used: averaged over thousands of
 * pixels, any residual gradient or smooth halo reads "significant" (M74 prep L: level >= 5 sigma out to 1050 px,
 * structure stops at 750 px, matching the hand measurement on the linear master).
 */
export function summarizeInventory(ann, sky, noise, { minSnr = 3, gapsAllowed = 1, skySpread = null } = {}) {
  const floor = Number.isFinite(skySpread) ? skySpread : 2.563 * noise;
  const prof = ann.map(a => ({ r0: a.r0, r1: a.r1, level: a.n ? (a.p50 - sky) / noise : 0, structure: a.n ? (a.p90 - a.p10 - floor) / noise : 0 }));
  let rDet = 0, gaps = 0;
  for (const p of prof) {
    if (p.structure >= minSnr) { rDet = p.r1; gaps = 0; }
    else if (rDet > 0 && ++gaps > gapsAllowed) break;
  }
  return { rDet, floor, profile: prof.map(p => ({ r0: p.r0, r1: p.r1, level: +p.level.toFixed(1), structure: +p.structure.toFixed(1) })) };
}

/** Zone geometry derived from the detection radius (shared by prep and finish). */
export function inventoryZones(rDet) {
  return {
    core: [0, Math.max(12, Math.round(0.08 * rDet))],
    disc: [Math.round(0.35 * rDet), Math.round(0.55 * rDet)],
    outer: [Math.round(0.8 * rDet), rDet],
    sky: [rDet + 150, rDet + 250],
  };
}

/** Core-to-disc index and outer-zone net contrast from zone stats (pure). */
export function zoneIndices(z) {
  const [core, disc, outer, sky] = z;
  const s = sky?.n ? sky.p50 : null;
  if (s == null || !core?.n || !disc?.n) return { coreIdx: null, outerNet: null };
  const skySpread = sky.p90 - sky.p10;
  return {
    sky: s,
    coreIdx: (disc.p50 - s) > 1e-6 ? (core.p50 - s) / (disc.p50 - s) : null,
    outerNet: outer?.n ? (outer.p90 - outer.p10) - skySpread : null,
    outerLevel: outer?.n ? outer.p50 - s : null,
  };
}

/**
 * PREP signal inventory (user methodology 2026-11-07: "stretch the longest exposure early to understand what
 * there is to see"). On the deepest starless view (prep L, else RGB): galaxy centre, detection radius rDet (where
 * the smoothed signal / arm structure is still >= 5 sigma), the zone geometry used by the finish gates, the prep
 * core-to-disc index, and a hard-stretched preview for the agents.
 */
export async function measureSignalInventory(ctx, viewId, { previewDir = null, log = console.log } = {}) {
  const B = 24;
  const d = await lumGrid(ctx, viewId, B);
  const m = galaxyBlockMask(d.g || [], d.w, d.h);
  if (m.blocks < 20) return { error: 'no subject component', blocks: m.blocks };
  let bi = -1, bv = -Infinity; for (let i = 0; i < m.bits.length; i++) if (m.bits[i] === '1' && d.g[i] > bv) { bv = d.g[i]; bi = i; }
  const centre = [(bi % d.w) * B + B / 2, Math.floor(bi / d.w) * B + B / 2];
  // sky blocks for the noise estimate: outside the subject component and in the lower half of block values
  // empty (zero) blocks outside a drizzle/registration footprint are not sky (M101 friend crop 2026-11-08: sky read 0)
  const sorted = Array.from(d.g).filter(v => v > 1e-6).sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)] ?? 0;
  let skyBits = ''; for (let i = 0; i < d.g.length; i++) skyBits += (m.bits[i] !== '1' && d.g[i] > 1e-6 && d.g[i] <= med) ? '1' : '0';
  const rMax = Math.floor(Math.hypot(Math.max(centre[0], d.W - centre[0]), Math.max(centre[1], d.H - centre[1])));
  const step = 25, ann = [];
  for (let r = 0; r + step <= rMax; r += step) ann.push([r, r + step]);
  const z = await measureRadialZones(ctx, viewId, centre, ann, { withNoise: true, skyBits, gridW: d.w, B });
  // sky = median of the outermost well-sampled annuli (beyond 85% of rMax), else the sky-block median
  const outerAnn = z.zones.map((s, k) => ({ ...s, r0: ann[k][0], r1: ann[k][1] }));
  const skyAnn = outerAnn.filter(a => a.n > 1000 && a.r0 >= 0.85 * Math.min(rMax, Math.min(d.W, d.H) / 2 * 1.4));
  const sky = skyAnn.length ? skyAnn.map(a => a.p50).sort((a, b) => a - b)[Math.floor(skyAnn.length / 2)] : med;
  const noise = Math.max(z.noise || 0, 1e-7);
  const skySpreads = skyAnn.map(a => a.p90 - a.p10).sort((a, b) => a - b);
  const skySpread = skySpreads.length ? skySpreads[Math.floor(skySpreads.length / 2)] : null;
  const inv = summarizeInventory(outerAnn.filter(a => a.n > 200), sky, noise, { skySpread });
  if (!inv.rDet) return { error: 'no detection', centre, noise, sky };
  const zones = inventoryZones(inv.rDet);
  const zz = await measureRadialZones(ctx, viewId, centre, [zones.core, zones.disc, zones.outer, zones.sky]);
  const idx = zoneIndices(zz.zones);
  let prepCoreWeber = null;
  try { prepCoreWeber = (await measureZoneStructure(ctx, viewId, { centre, rDet: inv.rDet, zones })).coreWeber; } catch (e) { log(`  [inventory] core structure failed: ${e.message}`); }
  let prepEnvelope = null;
  try { prepEnvelope = (await measureEnvelopeSectors(ctx, viewId, { centre, rDet: inv.rDet })).excess; } catch (e) { log(`  [inventory] envelope sectors failed: ${e.message}`); }
  const out = { view: viewId, centre, rDet: inv.rDet, skySpread, prepCoreWeber, prepEnvelope, rFrameMax: rMax, sky, noise, zones, prepCoreIdx: idx.coreIdx, prepOuterNet: idx.outerNet, profile: inv.profile };
  out.text = `subject centre (${centre[0]}, ${centre[1]}); arm-scale structure detected (>= 3 sigma above the sky texture) out to r = ${inv.rDet} px` +
    `${inv.rDet + 250 > Math.min(centre[0], centre[1], d.W - centre[0], d.H - centre[1]) ? ' (close to the frame edge)' : ''}; ` +
    `outer zone ${zones.outer[0]}-${zones.outer[1]} px must stay VISIBLE in the final image; prep core/disc index ${idx.coreIdx?.toFixed(2)}.`;
  if (previewDir) {
    try {
      const fsMod = await import('fs'); fsMod.mkdirSync(previewDir, { recursive: true });
      // hard stretch scaled to what the OUTER zone holds: its p90 lands near 0.45, the core saturates (by design)
      const oz = zz.zones[2], span = Math.max(((oz?.n ? oz.p90 : sky) - sky) * 2.5, 10 * noise);
      await ctx.pjsr(`
        var w = ImageWindow.windowById('${viewId}'); var img = w.mainView.image, W = img.width, H = img.height, n = W * H, i, R = new Rect(0,0,W,H);
        var L = new Float32Array(n);
        if (img.isColor) { var c = new Float32Array(n); img.getSamples(c, R, 0); for (i = 0; i < n; i++) L[i] = 0.2126 * c[i];
          img.getSamples(c, R, 1); for (i = 0; i < n; i++) L[i] += 0.7152 * c[i]; img.getSamples(c, R, 2); for (i = 0; i < n; i++) L[i] += 0.0722 * c[i]; }
        else img.getSamples(L, R, 0);
        var t = new ImageWindow(W, H, 1, 32, true, false, 'INV_HARD');
        t.mainView.beginProcess(); t.mainView.image.setSamples(L, R, 0); t.mainView.endProcess();
        var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = 4; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(t.mainView);
        var P = new PixelMath; P.expression = 'v = max(0, ($T - ${sky.toFixed(6)}) / ${span.toExponential(4)} + 0.03); v / (v + 0.25) * 1.25';
        P.symbols = 'v'; P.useSingleExpression = true; P.createNewImage = false; P.rescale = false; P.truncate = true; P.executeOn(t.mainView); 'ok';`);
      const { generateDiagnosticViews } = await import('../llm/vision.mjs');
      out.preview = await generateDiagnosticViews(ctx, 'INV_HARD', previewDir);
    } catch (e) { log(`  [inventory] hard-stretch preview failed: ${e.message}`); }
    finally { await ctx.pjsr(`var w = ImageWindow.windowById('INV_HARD'); if (!w.isNull) w.forceClose(); 'ok';`).catch(() => {}); }
  }
  log(`  [inventory] ${out.text}`);
  return out;
}

/** Finish-side: same geometry on the candidate image. */
export async function measureInventoryZones(ctx, viewId, inv) {
  const z = inv.zones;
  const zz = await measureRadialZones(ctx, viewId, inv.centre, [z.core, z.disc, z.outer, z.sky]);
  return zoneIndices(zz.zones);
}

/**
 * Zone structure + colour on the inventory geometry (2026-11-07, M74 v5 loopholes):
 * - coreWeber: fine structure inside the core, std(g1-g6)/mean(g6-sky) for r < 0.2 rDet (a bright but featureless
 *   core passes core/disc brightness but fails this).
 * - armSat / gapSat: median HSV saturation of ARM pixels (above the 60th lum percentile of their 25 px annulus,
 *   sigma-8 luminance) vs inter-arm GAP pixels (below the 40th), r in [0.2, 1.0] rDet. A saturation floor on the
 *   whole subject was met in v5 by tinting the gaps blue; on arms only that loophole closes.
 */
export async function measureZoneStructure(ctx, viewId, inv) {
  const [cx, cy] = inv.centre, rDet = inv.rDet, rCore = Math.round(0.2 * rDet), r0 = Math.round(0.2 * rDet);
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('measureZoneStructure: view not found: ${viewId}');
    var img = w.mainView.image, W = img.width, H = img.height, n = W * H, i, R = new Rect(0,0,W,H), col = img.isColor;
    var L = new Float32Array(n), c0, c1, c2;
    if (col) { c0 = new Float32Array(n); c1 = new Float32Array(n); c2 = new Float32Array(n); img.getSamples(c0, R, 0); img.getSamples(c1, R, 1); img.getSamples(c2, R, 2);
      for (i = 0; i < n; i++) L[i] = 0.2126 * c0[i] + 0.7152 * c1[i] + 0.0722 * c2[i]; }
    else img.getSamples(L, R, 0);
    ${EMPTY_PJSR(24)}
    function blurred(sig, id) { var bw = new ImageWindow(W, H, 1, 32, true, false, id); bw.mainView.beginProcess(); bw.mainView.image.setSamples(L, R, 0); bw.mainView.endProcess();
      var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = sig; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(bw.mainView);
      var o = new Float32Array(n); bw.mainView.image.getSamples(o, R, 0); bw.forceClose(); return o; }
    var g1 = blurred(1, 'ZS_1'), g6 = blurred(6, 'ZS_6'), g8 = blurred(8, 'ZS_8');
    var cx = ${cx}, cy = ${cy}, rDet = ${rDet}, rCore = ${rCore}, r0 = ${r0}, x, y, k;
    // sky: median g8 in the inventory sky zone
    var sk = []; for (y = 0; y < H; y += 4) for (x = 0; x < W; x += 4) { var d = Math.sqrt((x-cx)*(x-cx)+(y-cy)*(y-cy)); if (d >= ${inv.zones.sky[0]} && d < ${inv.zones.sky[1]} && !isEmpty(y*W+x)) sk.push(g8[y*W+x]); }
    sk.sort(function(a,b){return a-b;}); var sky = sk.length ? sk[sk.length >> 1] : 0;
    // core structure
    var s = 0, s2 = 0, m = 0, cn = 0;
    for (y = Math.max(0, cy - rCore); y < Math.min(H, cy + rCore); y++) for (x = Math.max(0, cx - rCore); x < Math.min(W, cx + rCore); x++) {
      if ((x-cx)*(x-cx)+(y-cy)*(y-cy) >= rCore*rCore) continue; i = y*W+x; var dd = g1[i] - g6[i]; s += dd; s2 += dd*dd; m += g6[i] - sky; cn++; }
    var mu = s / cn, coreWeber = Math.sqrt(Math.max(0, s2/cn - mu*mu)) / Math.max(m / cn, 1e-4);
    var out = { coreWeber: coreWeber, corePx: cn, sky: sky };
    if (col) {
      var NA = Math.ceil(rDet / 25), ann = []; for (k = 0; k < NA; k++) ann.push([]);
      for (y = 0; y < H; y += 2) for (x = 0; x < W; x += 2) { var r = Math.sqrt((x-cx)*(x-cx)+(y-cy)*(y-cy)); if (r < r0 || r >= rDet || isEmpty(y*W+x)) continue; ann[Math.floor(r / 25)].push(g8[y*W+x]); }
      var lo = [], hi = []; for (k = 0; k < NA; k++) { var a = ann[k]; a.sort(function(p,q){return p-q;}); lo.push(a.length ? a[Math.floor(a.length*0.4)] : 0); hi.push(a.length ? a[Math.floor(a.length*0.6)] : 0); }
      var arm = [], gap = [];
      for (y = 0; y < H; y += 2) for (x = 0; x < W; x += 2) { var r = Math.sqrt((x-cx)*(x-cx)+(y-cy)*(y-cy)); if (r < r0 || r >= rDet) continue; i = y*W+x; if (isEmpty(i)) continue; k = Math.floor(r / 25);
        if (L[i] - g6[i] > 0.05) continue;
        var mx = Math.max(c0[i], c1[i], c2[i]), mn = Math.min(c0[i], c1[i], c2[i]), sat = mx > 0.001 ? (mx - mn) / mx : 0;
        if (g8[i] >= hi[k]) arm.push(sat); else if (g8[i] <= lo[k]) gap.push(sat); }
      arm.sort(function(p,q){return p-q;}); gap.sort(function(p,q){return p-q;});
      out.armSat = arm.length ? arm[arm.length >> 1] : null; out.gapSat = gap.length ? gap[gap.length >> 1] : null; out.armN = arm.length;
    }
    JSON.stringify(out);`, { timeout: 900000 });
  if (res.status === 'error') throw new Error('measureZoneStructure: ' + (res.error?.message || 'PJSR error'));
  return JSON.parse(res.outputs?.consoleOutput || '{}');
}

/**
 * Envelope by direction (2026-11-08, M74 v5/v6 "mask-like edge" on one side): 8 sectors around the subject;
 * per sector, excess of the sigma-8 luminance in [0.9, 1.05] x rDet over that sector's own sky ring
 * [rDet+100, rDet+400]. Compared final vs prep (relative to each image's median sector), a sector that the data
 * fills but the final drops to sky is a threshold/mask clip. M74 prep L: right sector 0.73 of median; v6 0.004.
 */
export async function measureEnvelopeSectors(ctx, viewId, inv) {
  const [cx, cy] = inv.centre, rd = inv.rDet;
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('measureEnvelopeSectors: view not found: ${viewId}');
    var img = w.mainView.image, W = img.width, H = img.height, n = W * H, i, R = new Rect(0,0,W,H);
    var L = new Float32Array(n);
    if (img.isColor) { var c = new Float32Array(n); img.getSamples(c, R, 0); for (i = 0; i < n; i++) L[i] = 0.2126 * c[i];
      img.getSamples(c, R, 1); for (i = 0; i < n; i++) L[i] += 0.7152 * c[i]; img.getSamples(c, R, 2); for (i = 0; i < n; i++) L[i] += 0.0722 * c[i]; }
    else img.getSamples(L, R, 0);
    ${EMPTY_PJSR(24)}
    function blurred(sig, id) { var bw = new ImageWindow(W, H, 1, 32, true, false, id); bw.mainView.beginProcess(); bw.mainView.image.setSamples(L, R, 0); bw.mainView.endProcess();
      var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = sig; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(bw.mainView);
      var o = new Float32Array(n); bw.mainView.image.getSamples(o, R, 0); bw.forceClose(); return o; }
    var g2 = blurred(2, 'ES_2'), g8 = blurred(8, 'ES_8'), cx = ${cx}, cy = ${cy}, rd = ${rd}, env = [], sky = [], s, x, y;
    for (s = 0; s < 8; s++) { env.push([]); sky.push([]); }
    for (y = 0; y < H; y += 2) for (x = 0; x < W; x += 2) { var dx = x - cx, dy = y - cy, r = Math.sqrt(dx*dx + dy*dy); i = y*W + x;
      if (g2[i] - g8[i] > 0.02 || isEmpty(i)) continue;
      s = Math.floor((Math.atan2(dy, dx) + Math.PI) / (Math.PI / 4)); if (s > 7) s = 7;
      if (r > 0.9*rd && r < 1.05*rd) env[s].push(g8[i]); else if (r > rd + 100 && r < rd + 400) sky[s].push(g8[i]); }
    function med(a) { if (a.length < 2000) return null; a.sort(function(p,q){return p-q;}); return a[a.length >> 1]; }
    var ex = []; for (s = 0; s < 8; s++) { var e = med(env[s]), k = med(sky[s]); ex.push(e == null || k == null ? null : e - k); }
    JSON.stringify({ excess: ex });`, { timeout: 900000 });
  if (res.status === 'error') throw new Error('measureEnvelopeSectors: ' + (res.error?.message || 'PJSR error'));
  return JSON.parse(res.outputs?.consoleOutput || '{}');
}

/** Pure: compare final vs prep envelope sectors. Sector s spans atan2 angle [-pi + s*pi/4, ...) (image y down). */
export function compareEnvelopeSectors(finalEx, prepEx, { minLevel = 0.005 } = {}) {
  const names = ['left/upper-left', 'upper-left/top', 'top/upper-right', 'upper-right/right', 'right/lower-right', 'lower-right/bottom', 'bottom/lower-left', 'lower-left/left'];
  const ok = (a) => Array.isArray(a) && a.length === 8;
  if (!ok(finalEx) || !ok(prepEx)) return { evaluated: false, reason: 'missing sectors' };
  const idx = [...Array(8).keys()].filter(s => finalEx[s] != null && prepEx[s] != null);
  if (idx.length < 5) return { evaluated: false, reason: 'too few sectors inside the frame' };
  const medOf = (a) => { const v = idx.map(s => a[s]).sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };
  const mf = medOf(finalEx), mp = medOf(prepEx);
  if (!(mf >= minLevel) || !(mp > 0)) return { evaluated: false, reason: `envelope not lifted (median ${mf?.toFixed(4)} < ${minLevel})` };
  let worst = null;
  for (const s of idx) {
    const relP = prepEx[s] / mp; if (relP < 0.3) continue;   // the data itself is faint there: not a clip
    const ratio = (finalEx[s] / mf) / relP;
    if (!worst || ratio < worst.ratio) worst = { sector: s, name: names[s], ratio, finalRel: finalEx[s] / mf, prepRel: relP };
  }
  return { evaluated: true, worst, medianFinal: mf };
}

/**
 * Radial profiles by direction (2026-11-08, M74 v7 "mask-shaped glow boundary with a dark moat"): sigma-8 luminance
 * median per 15 px radial bin, per 8 sectors, star-rejected, from 0.4 x rDet to rDet + 450. Used to compare how
 * the outer glow FALLS to the sky in the final vs the prep data (a global stretch can only widen the falloff of
 * faint signal; a narrower falloff, or a dip below the far sky, is a mask edge).
 */
export async function measureSectorProfiles(ctx, viewId, inv, { bin = 15 } = {}) {
  const [cx, cy] = inv.centre, rd = inv.rDet;
  const r0 = Math.round(0.4 * rd), r1 = rd + 450;
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('measureSectorProfiles: view not found: ${viewId}');
    var img = w.mainView.image, W = img.width, H = img.height, n = W * H, i, R = new Rect(0,0,W,H);
    var L = new Float32Array(n);
    if (img.isColor) { var c = new Float32Array(n); img.getSamples(c, R, 0); for (i = 0; i < n; i++) L[i] = 0.2126 * c[i];
      img.getSamples(c, R, 1); for (i = 0; i < n; i++) L[i] += 0.7152 * c[i]; img.getSamples(c, R, 2); for (i = 0; i < n; i++) L[i] += 0.0722 * c[i]; }
    else img.getSamples(L, R, 0);
    ${EMPTY_PJSR(24)}
    function blurred(sig, id) { var bw = new ImageWindow(W, H, 1, 32, true, false, id); bw.mainView.beginProcess(); bw.mainView.image.setSamples(L, R, 0); bw.mainView.endProcess();
      var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = sig; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(bw.mainView);
      var o = new Float32Array(n); bw.mainView.image.getSamples(o, R, 0); bw.forceClose(); return o; }
    var g2 = blurred(2, 'SP_2'), g8 = blurred(8, 'SP_8'), cx = ${cx}, cy = ${cy}, r0 = ${r0}, r1 = ${r1}, B = ${bin};
    var NB = Math.ceil((r1 - r0) / B), acc = [], s, k, x, y;
    for (s = 0; s < 8; s++) { acc.push([]); for (k = 0; k < NB; k++) acc[s].push([]); }
    for (y = 0; y < H; y += 2) for (x = 0; x < W; x += 2) { var dx = x - cx, dy = y - cy, r = Math.sqrt(dx*dx + dy*dy); if (r < r0 || r >= r1) continue; i = y*W + x;
      if (g2[i] - g8[i] > 0.02 || isEmpty(i)) continue;
      s = Math.floor((Math.atan2(dy, dx) + Math.PI) / (Math.PI / 4)); if (s > 7) s = 7;
      acc[s][Math.floor((r - r0) / B)].push(g8[i]); }
    var prof = [];
    for (s = 0; s < 8; s++) { var p = []; for (k = 0; k < NB; k++) { var a = acc[s][k]; if (a.length < 150) { p.push(null); continue; } a.sort(function(u,v){return u-v;}); p.push(a[a.length >> 1]); } prof.push(p); }
    JSON.stringify({ r0: r0, bin: B, profiles: prof });`, { timeout: 900000 });
  if (res.status === 'error') throw new Error('measureSectorProfiles: ' + (res.error?.message || 'PJSR error'));
  return JSON.parse(res.outputs?.consoleOutput || '{}');
}

/**
 * Core trough statistics (2026-11-08, M74 v7 "cooked core": local contrast carved near-black outlines into the
 * core; coreWeber 0.074 = v6's natural 0.073, so a symmetric spread metric is blind). Relative residual
 * rel = (g1 - g6) / (g6 - sky) inside r < 0.25 x rDet; reports the negative tail (p2, p5), the positive tail
 * (p95, p98) and the fraction of pixels darker than -0.25 (outline pixels).
 */
export async function measureCoreTroughs(ctx, viewId, inv, { fracs = [1 / 250, 1 / 60, 1 / 30], coreFrac = 0.25 } = {}) {
  // Scales are FRACTIONS of rDet so images of different pixel scale / galaxy size compare (user reference JPEGs).
  const [cx, cy] = inv.centre, rC = Math.round(coreFrac * inv.rDet);
  const sig = fracs.map(f => Math.max(0.7, +(f * inv.rDet).toFixed(2)));
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('measureCoreTroughs: view not found: ${viewId}');
    var img = w.mainView.image, W = img.width, H = img.height, n = W * H, i, R = new Rect(0,0,W,H);
    var L = new Float32Array(n);
    if (img.isColor) { var c = new Float32Array(n); img.getSamples(c, R, 0); for (i = 0; i < n; i++) L[i] = 0.2126 * c[i];
      img.getSamples(c, R, 1); for (i = 0; i < n; i++) L[i] += 0.7152 * c[i]; img.getSamples(c, R, 2); for (i = 0; i < n; i++) L[i] += 0.0722 * c[i]; }
    else img.getSamples(L, R, 0);
    function blurred(sig, id) { var bw = new ImageWindow(W, H, 1, 32, true, false, id); bw.mainView.beginProcess(); bw.mainView.image.setSamples(L, R, 0); bw.mainView.endProcess();
      var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = sig; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(bw.mainView);
      var o = new Float32Array(n); bw.mainView.image.getSamples(o, R, 0); bw.forceClose(); return o; }
    var cx = ${cx}, cy = ${cy}, rC = ${rC}, x, y, SIG = ${JSON.stringify(sig)}, out = { scales: [] };
    var gs = blurred(Math.max(8, SIG[SIG.length - 1] * 4), 'CT_S');
    var sk = []; for (y = 0; y < H; y += 4) for (x = 0; x < W; x += 4) { var d = Math.sqrt((x-cx)*(x-cx)+(y-cy)*(y-cy)); if (d >= ${inv.zones.sky[0]} && d < ${inv.zones.sky[1]}) sk.push(gs[y*W+x]); }
    sk.sort(function(a,b){return a-b;}); var sky = sk.length ? sk[sk.length >> 1] : 0; out.sky = sky;
    for (var si = 0; si < SIG.length; si++) {
      var ga = blurred(SIG[si], 'CT_A'), gb = blurred(SIG[si] * 4, 'CT_B'), rel = [];
      for (y = Math.max(0, cy - rC); y < Math.min(H, cy + rC); y++) for (x = Math.max(0, cx - rC); x < Math.min(W, cx + rC); x++) {
        if ((x-cx)*(x-cx)+(y-cy)*(y-cy) >= rC*rC) continue; i = y*W+x; rel.push((ga[i] - gb[i]) / Math.max(gb[i] - sky, 0.02)); }
      rel.sort(function(a,b){return a-b;}); var N = rel.length, dark = 0;
      for (i = 0; i < N; i++) { if (rel[i] < -0.25) dark++; else break; }
      function q(f) { return rel[Math.min(N - 1, Math.floor(f * N))]; }
      out.scales.push({ sigma: SIG[si], p2: q(0.02), p5: q(0.05), p50: q(0.5), p95: q(0.95), p98: q(0.98), darkFrac: dark / N, asym: -q(0.02) / Math.max(q(0.98), 1e-4) });
    }
    out.n = rC; JSON.stringify(out);`, { timeout: 900000 });
  if (res.status === 'error') throw new Error('measureCoreTroughs: ' + (res.error?.message || 'PJSR error'));
  return JSON.parse(res.outputs?.consoleOutput || '{}');
}

/**
 * Core texture character (2026-11-08, M74 v7 "cooked core"): a dense, ISOTROPIC cell pattern (dark brown blobs on
 * cream) replaced the few coherent spiral lanes; trough depth and coreWeber were blind to it (v7 0.074 = v6 0.073).
 * Per scale s (fraction of rDet), inside r < coreFrac x rDet:
 *  - coherence: energy-weighted structure-tensor coherence of the s-smoothed luminance (gradients integrated over
 *    3s). Spiral lanes are oriented (high); a cell/worm pattern is isotropic (low).
 *  - lumTex: std of the band-pass (g_s - g_4s) luminance relative to the local level (g_4s - sky).
 *  - chromaTex: std of the band-pass of the two opponent chroma axes (R-G, (R+G)/2-B), relative to local luminance.
 */
export async function measureCoreTexture(ctx, viewId, inv, { fracs = [1 / 120, 1 / 50], coreFrac = 0.25 } = {}) {
  const [cx, cy] = inv.centre, rC = Math.round(coreFrac * inv.rDet);
  const sig = fracs.map(f => Math.max(0.8, +(f * inv.rDet).toFixed(2)));
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('measureCoreTexture: view not found: ${viewId}');
    var img = w.mainView.image, W = img.width, H = img.height, n = W * H, i, R = new Rect(0,0,W,H), col = img.isColor;
    var L = new Float32Array(n), A = null, Bc = null;
    if (col) { var c0 = new Float32Array(n), c1 = new Float32Array(n), c2 = new Float32Array(n); img.getSamples(c0, R, 0); img.getSamples(c1, R, 1); img.getSamples(c2, R, 2);
      A = new Float32Array(n); Bc = new Float32Array(n);
      for (i = 0; i < n; i++) { L[i] = 0.2126 * c0[i] + 0.7152 * c1[i] + 0.0722 * c2[i]; A[i] = c0[i] - c1[i]; Bc[i] = 0.5 * (c0[i] + c1[i]) - c2[i]; } c0 = c1 = c2 = null; }
    else img.getSamples(L, R, 0);
    function blur(src, sig) { var bw = new ImageWindow(W, H, 1, 32, true, false, 'CTX_T'); bw.mainView.beginProcess(); bw.mainView.image.setSamples(src, R, 0); bw.mainView.endProcess();
      var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = sig; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(bw.mainView);
      var o = new Float32Array(n); bw.mainView.image.getSamples(o, R, 0); bw.forceClose(); return o; }
    var cx = ${cx}, cy = ${cy}, rC = ${rC}, SIG = ${JSON.stringify(sig)}, x, y, out = { scales: [] };
    var gS = blur(L, Math.max(8, SIG[SIG.length - 1] * 4)), sk = [];
    for (y = 0; y < H; y += 4) for (x = 0; x < W; x += 4) { var d = Math.sqrt((x-cx)*(x-cx)+(y-cy)*(y-cy)); if (d >= ${inv.zones.sky[0]} && d < ${inv.zones.sky[1]}) sk.push(gS[y*W+x]); }
    sk.sort(function(a,b){return a-b;}); var sky = sk.length ? sk[sk.length >> 1] : 0; out.sky = sky; gS = null;
    var x0 = Math.max(1, cx - rC), x1 = Math.min(W - 1, cx + rC), y0 = Math.max(1, cy - rC), y1 = Math.min(H - 1, cy + rC);
    for (var si = 0; si < SIG.length; si++) {
      var s = SIG[si], ga = blur(L, s), gb = blur(L, 4 * s);
      var jxx = new Float32Array(n), jxy = new Float32Array(n), jyy = new Float32Array(n);
      for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) { i = y*W+x; var gx = 0.5 * (ga[i+1] - ga[i-1]), gy = 0.5 * (ga[i+W] - ga[i-W]); jxx[i] = gx*gx; jxy[i] = gx*gy; jyy[i] = gy*gy; }
      jxx = blur(jxx, 3 * s); jxy = blur(jxy, 3 * s); jyy = blur(jyy, 3 * s);
      var num = 0, den = 0, lt = 0, lt2 = 0, cnt = 0, ca = null, cb = null, cA = 0, cA2 = 0, cB = 0, cB2 = 0;
      if (col) { var aa = blur(A, s), ab = blur(A, 4 * s), ba = blur(Bc, s), bb = blur(Bc, 4 * s); }
      for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) { if ((x-cx)*(x-cx)+(y-cy)*(y-cy) >= rC*rC) continue; i = y*W+x;
        var tr = jxx[i] + jyy[i], df = Math.sqrt((jxx[i]-jyy[i])*(jxx[i]-jyy[i]) + 4*jxy[i]*jxy[i]); num += df; den += tr;
        var lvl = Math.max(gb[i] - sky, 0.02), v = (ga[i] - gb[i]) / lvl; lt += v; lt2 += v*v; cnt++;
        if (col) { var va = (aa[i] - ab[i]) / lvl, vb = (ba[i] - bb[i]) / lvl; cA += va; cA2 += va*va; cB += vb; cB2 += vb*vb; } }
      function sd(s1, s2) { var m = s1 / cnt; return Math.sqrt(Math.max(0, s2 / cnt - m*m)); }
      out.scales.push({ sigma: s, coherence: den > 0 ? num / den : null, lumTex: sd(lt, lt2), chromaTex: col ? Math.sqrt(sd(cA, cA2)*sd(cA, cA2) + sd(cB, cB2)*sd(cB, cB2)) : null });
      ga = gb = jxx = jxy = jyy = null;
    }
    JSON.stringify(out);`, { timeout: 1200000 });
  if (res.status === 'error') throw new Error('measureCoreTexture: ' + (res.error?.message || 'PJSR error'));
  return JSON.parse(res.outputs?.consoleOutput || '{}');
}

/**
 * Core texture SPECTRUM (2026-11-08, M74 v7 "cooked core", calibrated on 5 user reference galaxies).
 * spectrum = std(g_u - g_2u) / std(g_4u - g_8u) inside r < 0.22 x rDet, u = rDet / 300 (scale-free across images).
 * Natural cores carry MORE structure at larger scales (lanes, inner arms): refs 0.68-0.86, v3 0.81, v5 1.04,
 * v6 1.12. Local contrast at small radius inverts it into a cell/worm pattern: v7 1.71. Trough depth, coreWeber,
 * coherence, kurtosis and central concentration were all blind to it (v7 = v6 or = the M74 reference).
 */
export async function measureCoreSpectrum(ctx, viewId, inv, { coreFrac = 0.22 } = {}) {
  const [cx, cy] = inv.centre, rC = Math.round(coreFrac * inv.rDet), u = Math.max(0.6, inv.rDet / 300);
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('measureCoreSpectrum: view not found: ${viewId}');
    var img = w.mainView.image, W = img.width, H = img.height, cx = ${cx}, cy = ${cy}, rC = ${rC}, u = ${u}, pad = Math.ceil(${u} * 8 * 3);
    var x0 = Math.max(0, cx - rC - pad), y0 = Math.max(0, cy - rC - pad), x1 = Math.min(W, cx + rC + pad), y1 = Math.min(H, cy + rC + pad);
    var CW = x1 - x0, CH = y1 - y0, n = CW * CH, i, R = new Rect(x0, y0, x1, y1), L = new Float32Array(n);
    if (img.isColor) { var c = new Float32Array(n); img.getSamples(c, R, 0); for (i = 0; i < n; i++) L[i] = 0.2126 * c[i];
      img.getSamples(c, R, 1); for (i = 0; i < n; i++) L[i] += 0.7152 * c[i]; img.getSamples(c, R, 2); for (i = 0; i < n; i++) L[i] += 0.0722 * c[i]; }
    else img.getSamples(L, R, 0);
    var RR = new Rect(0, 0, CW, CH);
    function blur(sig) { var bw = new ImageWindow(CW, CH, 1, 32, true, false, 'CSP_T'); bw.mainView.beginProcess(); bw.mainView.image.setSamples(L, RR, 0); bw.mainView.endProcess();
      var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = sig; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(bw.mainView);
      var o = new Float32Array(n); bw.mainView.image.getSamples(o, RR, 0); bw.forceClose(); return o; }
    var g1 = blur(u), g2 = blur(2 * u), g4 = blur(4 * u), g8 = blur(8 * u);
    function sd(a, b) { var s = 0, s2 = 0, k = 0, x, y, d; for (y = 0; y < CH; y++) for (x = 0; x < CW; x++) { var dx = x + x0 - cx, dy = y + y0 - cy; if (dx*dx + dy*dy >= rC*rC) continue; i = y*CW + x; d = a[i] - b[i]; s += d; s2 += d*d; k++; }
      var m = s / k; return Math.sqrt(Math.max(0, s2 / k - m*m)); }
    var fine = sd(g1, g2), mid = sd(g2, g4), coarse = sd(g4, g8);
    JSON.stringify({ u: u, fine: fine, mid: mid, coarse: coarse, spectrum: coarse > 0 ? fine / coarse : null, midCoarse: coarse > 0 ? mid / coarse : null });`, { timeout: 900000 });
  if (res.status === 'error') throw new Error('measureCoreSpectrum: ' + (res.error?.message || 'PJSR error'));
  return JSON.parse(res.outputs?.consoleOutput || '{}');
}

/**
 * Pure: outer-glow EDGE STEEPENING from measureSectorProfiles (2026-11-08, M74 v7 "mask-shaped boundary").
 * On the 8-sector-median profile, excess over the far sky normalised at 0.6 x rDet; k_inner = log-slope while
 * the excess falls 0.6 -> 0.2, k_edge = log-slope while it falls 0.2 -> 0.03; steepening = k_edge / k_inner.
 * Natural discs fade at a steady or slowing rate (user refs 0.94-1.48, prep data 0.46-0.53); a lifted plateau that
 * ends in a cliff speeds up at the end (v6 2.35, v7 4.59; v5 1.50, v3 0.96).
 */
export function edgeSteepening(prof, rDet) {
  if (!prof?.profiles?.length) return { evaluated: false, reason: 'no profiles' };
  const nb = prof.profiles[0].length, rr = [...Array(nb).keys()].map(k => (prof.r0 + prof.bin * (k + 0.5)) / rDet);
  const med = (a) => { const v = a.filter(x => x != null).sort((p, q) => p - q), h = v.length >> 1; return v.length ? (v.length % 2 ? v[h] : 0.5 * (v[h - 1] + v[h])) : null; };
  const p = rr.map((r, k) => ({ r, v: med(prof.profiles.map(s => s[k])) })).filter(o => o.v != null);
  const sky = med(p.filter(o => o.r > 1 + 300 / rDet).map(o => o.v)), ref = med(p.filter(o => o.r > 0.55 && o.r < 0.65).map(o => o.v));
  if (sky == null || ref == null || !(ref - sky > 0)) return { evaluated: false, reason: 'no far sky or no glow at 0.6 rDet' };
  let e = p.map(o => ({ r: o.r, v: (o.v - sky) / (ref - sky) }));
  e = e.slice(1, -1).map((o, i) => ({ r: o.r, v: (e[i].v + e[i + 1].v + e[i + 2].v) / 3 }));
  const cross = (t) => { for (let i = 1; i < e.length; i++) if (e[i].r > 0.6 && e[i].v < t) { const a = e[i - 1], b = e[i]; return a.v !== b.v ? a.r + (b.r - a.r) * (a.v - t) / (a.v - b.v) : b.r; } return null; };
  const r60 = cross(0.6), r20 = cross(0.2), r03 = cross(0.03);
  if (r60 == null || r20 == null || r03 == null || !(r20 > r60) || !(r03 > r20)) return { evaluated: false, reason: 'glow does not fall to the sky inside the measured range' };
  const kIn = Math.log(3) / (r20 - r60), kEdge = Math.log(0.2 / 0.03) / (r03 - r20);
  return { evaluated: true, steepening: kEdge / kIn, r60, r20, r03, tail: r03 - r20 };
}

/**
 * Arm/gap DEPTH (2026-11-08, M74 "blue-grey haze between the arms"; calibrated on 5 user reference galaxies).
 * Per annulus 0.30-0.85 x rDet (step 0.05): smoothed luminance (sigma 2u, u = rDet/300, star pixels skipped),
 * depth = (p80 - p20) / (p80 - sky). Median over annuli. Refs 0.38-0.88 (the M74 reference 0.63); M74 v3 0.45,
 * v5 0.39, v6 0.34, v7 0.31 — each version filled the gaps more. Gap HUE was inside the reference range (not gated),
 * and knot hue is Ha-limited (refs have Ha; user: no H data yet), so neither is gated.
 */
export async function measureArmGapDepth(ctx, viewId, inv) {
  const [cx, cy] = inv.centre, rd = inv.rDet, u = Math.max(0.7, rd / 300);
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('measureArmGapDepth: view not found: ${viewId}');
    var img = w.mainView.image, W = img.width, H = img.height, n = W * H, i, R = new Rect(0,0,W,H);
    var L = new Float32Array(n);
    if (img.isColor) { var c = new Float32Array(n); img.getSamples(c, R, 0); for (i = 0; i < n; i++) L[i] = 0.2126 * c[i];
      img.getSamples(c, R, 1); for (i = 0; i < n; i++) L[i] += 0.7152 * c[i]; img.getSamples(c, R, 2); for (i = 0; i < n; i++) L[i] += 0.0722 * c[i]; }
    else img.getSamples(L, R, 0);
    ${EMPTY_PJSR(Math.max(24, 18 * u))}
    function blurred(sig, id) { var bw = new ImageWindow(W, H, 1, 32, true, false, id); bw.mainView.beginProcess(); bw.mainView.image.setSamples(L, R, 0); bw.mainView.endProcess();
      var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = sig; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(bw.mainView);
      var o = new Float32Array(n); bw.mainView.image.getSamples(o, R, 0); bw.forceClose(); return o; }
    var u = ${u}, gs = blurred(Math.max(0.7, u / 2), 'AG_S'), g = blurred(2 * u, 'AG_2'), gw = blurred(Math.max(8, 6 * u), 'AG_W');
    var cx = ${cx}, cy = ${cy}, rd = ${rd}, NA = 11, ann = [], sk = [], x, y, k;
    for (k = 0; k < NA; k++) ann.push([]);
    for (y = 0; y < H; y += 2) for (x = 0; x < W; x += 2) { var r = Math.sqrt((x-cx)*(x-cx)+(y-cy)*(y-cy)) / rd; i = y*W + x;
      if (gs[i] - gw[i] > 0.08 || isEmpty(i)) continue;   // star / bright compact source
      if (r >= 1.15 && r < 1.3) { sk.push(g[i]); continue; }
      if (r < 0.30 || r >= 0.85) continue; k = Math.floor((r - 0.30) / 0.05); if (k >= 0 && k < NA) ann[k].push(g[i]); }
    function q(a, f) { return a[Math.min(a.length - 1, Math.floor(f * a.length))]; }
    sk.sort(function(a,b){return a-b;});
    var sky = sk.length > 200 ? q(sk, 0.5) : null;
    if (sky === null) { var s2 = []; for (y = 0; y < H; y += 4) for (x = 0; x < W; x += 4) { var d = Math.sqrt((x-cx)*(x-cx)+(y-cy)*(y-cy)); if (d >= ${inv.zones.sky[0]} && d < ${inv.zones.sky[1]} && !isEmpty(y*W+x)) s2.push(g[y*W+x]); } s2.sort(function(a,b){return a-b;}); sky = s2.length ? q(s2, 0.5) : 0; }
    var depths = [];
    for (k = 0; k < NA; k++) { var a = ann[k]; if (a.length < 200) continue; a.sort(function(p,qq){return p-qq;}); var hi = q(a, 0.8), lo = q(a, 0.2); depths.push((hi - lo) / Math.max(hi - sky, 1e-3)); }
    var ds = depths.slice().sort(function(a,b){return a-b;});
    JSON.stringify({ depth: ds.length ? (ds.length % 2 ? ds[ds.length >> 1] : 0.5 * (ds[(ds.length >> 1) - 1] + ds[ds.length >> 1])) : null, min: ds.length ? ds[0] : null, perAnnulus: depths, sky: sky });`, { timeout: 900000 });
  if (res.status === 'error') throw new Error('measureArmGapDepth: ' + (res.error?.message || 'PJSR error'));
  return JSON.parse(res.outputs?.consoleOutput || '{}');
}

/**
 * Ha KNOTS (2026-11-08, M101 friend data: pink HII knots visible on 2026-10-30, gone today after a "cool hue shift"
 * + chroma/brightness push; the reference-palette gate did not see it: knots are a tiny pixel fraction).
 * On the prep starless Ha (same geometry as RGB): band-pass g1 - g8 inside 1.1 x rDet; knot pixels = band-pass
 * above max(p99.5, 6 x its robust noise). Returns up to maxN [x, y] samples.
 */
export async function measureHaKnots(ctx, haViewId, inv, { maxN = 6000 } = {}) {
  const [cx, cy] = inv.centre, rMax = Math.round(1.1 * inv.rDet);
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${haViewId}'); if (w.isNull) throw new Error('measureHaKnots: view not found: ${haViewId}');
    var img = w.mainView.image, W = img.width, H = img.height, n = W * H, i, R = new Rect(0,0,W,H), L = new Float32Array(n);
    img.getSamples(L, R, 0);
    ${EMPTY_PJSR(24)}
    function blurred(sig, id) { var bw = new ImageWindow(W, H, 1, 32, true, false, id); bw.mainView.beginProcess(); bw.mainView.image.setSamples(L, R, 0); bw.mainView.endProcess();
      var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = sig; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(bw.mainView);
      var o = new Float32Array(n); bw.mainView.image.getSamples(o, R, 0); bw.forceClose(); return o; }
    var g1 = blurred(1, 'HK_1'), g8 = blurred(8, 'HK_8'), cx = ${cx}, cy = ${cy}, rM = ${rMax}, x, y, v = [], idx = [];
    for (y = 0; y < H; y += 1) for (x = 0; x < W; x += 1) { var dx = x - cx, dy = y - cy; if (dx*dx + dy*dy > rM*rM) continue; i = y*W + x; if (isEmpty(i)) continue; v.push(g1[i] - g8[i]); idx.push(i); }
    var s = v.slice().sort(function(a,b){return a-b;}), N = s.length, md = s[N >> 1], dv = [];
    for (i = 0; i < N; i += 7) dv.push(Math.abs(s[i] - md)); dv.sort(function(a,b){return a-b;});
    var noise = 1.4826 * dv[dv.length >> 1], thr = Math.max(s[Math.floor(0.995 * N)], md + 6 * noise), pts = [];
    for (i = 0; i < v.length; i++) if (v[i] > thr) pts.push(idx[i]);
    var step = Math.max(1, Math.ceil(pts.length / ${maxN})), out = [];
    for (i = 0; i < pts.length; i += step) out.push([pts[i] % W, Math.floor(pts[i] / W)]);
    JSON.stringify({ W: W, H: H, n: pts.length, thr: thr, noise: noise, pts: out });`, { timeout: 900000 });
  if (res.status === 'error') throw new Error('measureHaKnots: ' + (res.error?.message || 'PJSR error'));
  return JSON.parse(res.outputs?.consoleOutput || '{}');
}

/**
 * Final-image colour at the prep Ha knots: 3x3-mean RGB -> HSV. pinkFrac = share with hue >= 290 or < 35 deg and
 * saturation >= 0.10 (pink-red); whiteFrac = share clipped to white (max > 0.92 and sat < 0.10).
 */
export async function measureHaKnotColour(ctx, viewId, knots) {
  if (!knots?.pts?.length) return { evaluated: false, reason: 'no Ha knots' };
  const res = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('measureHaKnotColour: view not found: ${viewId}');
    var img = w.mainView.image; if (!img.isColor) throw new Error('measureHaKnotColour: needs a colour image');
    if (img.width !== ${knots.W} || img.height !== ${knots.H}) JSON.stringify({ evaluated: false, reason: 'geometry differs from prep (' + img.width + 'x' + img.height + ' vs ${knots.W}x${knots.H})' });
    else {
      var P = ${JSON.stringify(knots.pts)}, pink = 0, white = 0, n = 0, hs = [];
      for (var k = 0; k < P.length; k++) { var x = P[k][0], y = P[k][1]; if (x < 1 || y < 1 || x >= img.width - 1 || y >= img.height - 1) continue;
        var r = 0, g = 0, b = 0; for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) { r += img.sample(x+dx, y+dy, 0); g += img.sample(x+dx, y+dy, 1); b += img.sample(x+dx, y+dy, 2); }
        r /= 9; g /= 9; b /= 9; var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, s = mx > 0 ? d / mx : 0, h = 0;
        if (d > 1e-6) { if (mx === r) h = 60 * (((g - b) / d) % 6); else if (mx === g) h = 60 * ((b - r) / d + 2); else h = 60 * ((r - g) / d + 4); if (h < 0) h += 360; }
        n++; if (s >= 0.10 && (h >= 290 || h < 35)) pink++; if (mx > 0.92 && s < 0.10) white++; hs.push(h); }
      hs.sort(function(a,b){return a-b;});
      JSON.stringify({ evaluated: true, n: n, pinkFrac: pink / n, whiteFrac: white / n, medHue: hs[hs.length >> 1] });
    }`, { timeout: 600000 });
  if (res.status === 'error') throw new Error('measureHaKnotColour: ' + (res.error?.message || 'PJSR error'));
  return JSON.parse(res.outputs?.consoleOutput || '{}');
}
