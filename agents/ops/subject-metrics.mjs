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
      if (aspectOk) {
        var tw = ${targetWidth}, th = Math.round(tw * a.height / a.width);
        tmpW = new ImageWindow(a.width, a.height, a.numberOfChannels, 32, true, a.isColor, '${tmpId}');
        tmpW.mainView.beginProcess(); tmpW.mainView.image.assign(a); tmpW.mainView.endProcess();
        var shrink = function (win) {
          var R = new Resample;
          R.mode = Resample.prototype.AbsolutePixels;
          R.xSize = tw; R.ySize = th;
          R.absoluteMode = Resample.prototype.ForceWidthAndHeight;
          R.interpolation = Resample.prototype.MitchellNetravaliFilter;
          R.executeOn(win.mainView);
        };
        shrink(tmpW); shrink(rw);
        var ta = tmpW.mainView.image, tb = rw.mainView.image;
        if (ta.width === tb.width && ta.height === tb.height) {
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
    `dark_depth target=${f3(data.dark_depth_target)} ref=${f3(data.dark_depth_ref)}; local_contrast ratio=${f3(data.lc_ratio)} (p90 ${f3(data.lc_p90_ratio)}; 1.0 = same as reference)`;
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
