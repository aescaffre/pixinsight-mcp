// ============================================================================
// Quality Gates — automated pixel-level quality checks via PJSR
// These gates are code-based and cannot be bypassed by the agent.
// ============================================================================

import { measureSubjectDetail, locateSubjectROI } from './subject-metrics.mjs';
import fs from 'fs';
import path from 'path';
import { BURN_CLIP, BRIGHT_BLOCK_LEVEL, STAR_CONTRAST, FWHM_HARD, STAR_COUNT_WARN,
  STAR_ELLIPTICITY_WARN, STAR_DARK_RING_WARN, STAR_FWHM_ADVISORY, STAR_CENTER_RADIUS_FRAC, STAR_KNOT_RATIO, STAR_SATURATED } from '../llm/gate-contract.mjs';

/**
 * Check star quality: FWHM and color diversity.
 * Uses StarDetector to find bright stars, samples 21x21 boxes,
 * measures FWHM via Gaussian fit and color spread.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID (should be the final composite with stars)
 * @returns {object} { pass, medianFWHM, colorDiversity, details, stars }
 */
export async function checkStarQuality(ctx, viewId, opts = {}) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('checkStarQuality: view not found: ${viewId}');
    var img = w.mainView.image;
    var isColor = img.isColor;

    // Find stars by scanning for bright local maxima (no StarDetector — it crashes on getIntensity)
    // Scan every 16th pixel, find peaks above background + 5*MAD, verify local maximum in 5x5
    var bgMedian = img.median();
    var bgMAD = img.MAD();
    var threshold = bgMedian + 5 * bgMAD;
    var step = 16;
    var halfBox = 10;
    var candidates = [];

    // Get luminance for color images
    function getLum(x, y) {
      if (isColor) {
        return 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
      }
      return img.sample(x, y);
    }

    // Coarse scan for bright pixels
    for (var y = halfBox + 1; y < img.height - halfBox - 1; y += step) {
      for (var x = halfBox + 1; x < img.width - halfBox - 1; x += step) {
        var lum = getLum(x, y);
        if (lum > threshold) {
          // Refine: find local max in 5x5 around this point
          var bestX = x, bestY = y, bestLum = lum;
          for (var dy = -2; dy <= 2; dy++) {
            for (var dx = -2; dx <= 2; dx++) {
              var l = getLum(x + dx, y + dy);
              if (l > bestLum) { bestLum = l; bestX = x + dx; bestY = y + dy; }
            }
          }
          // Check it's actually a local max (not on a nebula edge)
          var isMax = true;
          for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              if (getLum(bestX + dx, bestY + dy) > bestLum) { isMax = false; break; }
            }
            if (!isMax) break;
          }
          if (isMax && bestLum > threshold) {
            candidates.push({ x: bestX, y: bestY, peak: bestLum });
          }
        }
      }
    }

    // Deduplicate: merge candidates within 20px of each other
    candidates.sort(function(a, b) { return b.peak - a.peak; });
    // Uncapped unique count (grid-bucket dedupe, 20 px) for the star-retention gate:
    // the quality list below is capped at 100, which made density meaningless.
    var seenCell = {}, starsDetected = 0, faintStars = 0;
    for (var ci = 0; ci < candidates.length; ci++) {
      var ck = Math.floor(candidates[ci].x / 20) + '_' + Math.floor(candidates[ci].y / 20);
      if (!seenCell[ck]) { seenCell[ck] = 1; starsDetected++; if (candidates[ci].peak < 0.25) faintStars++; }
    }
    var stars = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var isDupe = false;
      for (var j = 0; j < stars.length; j++) {
        var dist = Math.sqrt((c.x - stars[j].x) * (c.x - stars[j].x) + (c.y - stars[j].y) * (c.y - stars[j].y));
        if (dist < 20) { isDupe = true; break; }
      }
      if (!isDupe) stars.push(c);
      if (stars.length >= 100) break;
    }

    // Measure FWHM and color for top 30 stars
    var topStars = stars.slice(0, 30);
    var fwhms = [];
    var colorDivs = [];

    for (var i = 0; i < topStars.length; i++) {
      var s = topStars[i];
      var cx = s.x, cy = s.y;

      // FWHM: measure half-max radius in 4 directions
      var halfMax = s.peak / 2;
      var radii = [];
      var dirs = [[1,0],[0,1],[-1,0],[0,-1]];
      for (var d = 0; d < 4; d++) {
        for (var r = 1; r <= halfBox; r++) {
          var px = cx + dirs[d][0] * r;
          var py = cy + dirs[d][1] * r;
          if (px < 0 || px >= img.width || py < 0 || py >= img.height) break;
          if (getLum(px, py) < halfMax) { radii.push(r); break; }
        }
      }
      if (radii.length >= 2) {
        var avgRadius = 0;
        for (var ri = 0; ri < radii.length; ri++) avgRadius += radii[ri];
        avgRadius /= radii.length;
        fwhms.push(avgRadius * 2); // FWHM = 2 * half-max radius
      }

      // Color diversity
      if (isColor) {
        var chPeaks = [img.sample(cx, cy, 0), img.sample(cx, cy, 1), img.sample(cx, cy, 2)];
        var maxPeak = Math.max(chPeaks[0], chPeaks[1], chPeaks[2]);
        if (maxPeak > 0.01) {
          var normR = chPeaks[0] / maxPeak;
          var normG = chPeaks[1] / maxPeak;
          var normB = chPeaks[2] / maxPeak;
          var cdiv = Math.max(normR, normG, normB) - Math.min(normR, normG, normB);
          colorDivs.push(cdiv);
        }
      }
    }

    // Compute median FWHM
    fwhms.sort(function(a, b) { return a - b; });
    var medFWHM = fwhms.length > 0 ? fwhms[Math.floor(fwhms.length / 2)] : 0;

    // Compute median color diversity
    colorDivs.sort(function(a, b) { return a - b; });
    var medColorDiv = colorDivs.length > 0 ? colorDivs[Math.floor(colorDivs.length / 2)] : 0;

    // Star brightness: collect peak luminance values for all detected stars
    var starPeaks = [];
    for (var si = 0; si < topStars.length; si++) {
      starPeaks.push(topStars[si].peak);
    }
    starPeaks.sort(function(a, b) { return a - b; });
    var medianPeak = starPeaks.length > 0 ? starPeaks[Math.floor(starPeaks.length / 2)] : 0;
    var p25Peak = starPeaks.length >= 4 ? starPeaks[Math.floor(starPeaks.length * 0.25)] : medianPeak;
    var starBgContrast = bgMedian > 0.001 ? medianPeak / bgMedian : 0;

    JSON.stringify({
      starsFound: stars.length,
      starsMeasured: fwhms.length,
      medianFWHM: medFWHM,
      colorDiversity: medColorDiv,
      fwhms: fwhms.slice(0, 10),
      colorDivs: colorDivs.slice(0, 10),
      medianPeak: medianPeak,
      p25Peak: p25Peak,
      bgMedian: bgMedian,
      starBgContrast: starBgContrast,
      starPeaks: starPeaks.slice(0, 10),
      starsDetected: starsDetected,
      faintStars: faintStars,
      width: img.width,
      height: img.height
    });
  `);

  if (r.status === 'error') {
    // Throw so the finish handler's catch block can skip gracefully
    // (e.g. StarDetector crashes on certain fields, no stars in starless images)
    throw new Error('Star quality gate failed to execute: ' + (r.error?.message || 'PJSR error'));
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { pass: false, error: 'Failed to parse PJSR output', medianFWHM: 999, colorDiversity: 0 };
  }

  // Thresholds come from gate-contract (single source); callers may pass profile-resolved values.
  const minContrast = opts.minContrast ?? STAR_CONTRAST.balanced;
  const fwhmLimit = opts.fwhmHard ?? FWHM_HARD;
  const fwhmPass = data.medianFWHM <= fwhmLimit;
  const colorPass = data.colorDiversity > 0.05;
  const countPass = data.starsFound >= STAR_COUNT_WARN; // minimum star presence (finish only warns below this)

  // Star brightness: star-to-background contrast ratio
  // Prominent/Balanced/Subdued minimums: STAR_CONTRAST in gate-contract.mjs
  const brightnessPass = data.starBgContrast >= minContrast;

  const pass = fwhmPass && colorPass && countPass && brightnessPass;

  const details = [];
  if (!fwhmPass) details.push(`Stars bloated: median FWHM=${data.medianFWHM.toFixed(2)}px (limit: ${fwhmLimit}px)`);
  if (!colorPass) details.push(`Stars colorless: diversity=${data.colorDiversity.toFixed(3)} (limit: 0.05)`);
  if (!countPass) details.push(`Too few stars: ${data.starsFound} found (minimum: ${STAR_COUNT_WARN}) — stars may be missing or over-reduced`);
  if (!brightnessPass) details.push(`Stars too dim: contrast=${data.starBgContrast.toFixed(1)}× vs background (limit: ${minContrast}×), median peak=${data.medianPeak.toFixed(3)}, bg=${data.bgMedian.toFixed(4)}`);
  if (pass) details.push(`Stars OK: FWHM=${data.medianFWHM.toFixed(2)}px, color=${data.colorDiversity.toFixed(3)}, count=${data.starsFound}, brightness=${data.starBgContrast.toFixed(1)}× bg`);

  // WI-16: advisory star-field metric (never throws, never changes pass)
  let starField = null;
  if (opts.starField !== false) {
    try { starField = await measureStarField(ctx, viewId, { centerRadiusPx: opts.centerRadiusPx, peaks: opts.peaks }); }
    catch (e) { starField = { error: String(e.message || e) }; }
  }

  return {
    pass,
    starField,
    medianFWHM: data.medianFWHM,
    colorDiversity: data.colorDiversity,
    starsFound: data.starsFound,
    starsDetected: data.starsDetected ?? null,
    faintStars: data.faintStars ?? null,
    faintFraction: data.starsDetected ? data.faintStars / data.starsDetected : null,
    starsPerMpx: (data.width && data.height && data.starsDetected != null) ? data.starsDetected / (data.width * data.height / 1e6) : null,   // 2026-10-29 star-retention gate (uncapped unique count)
    starsMeasured: data.starsMeasured,
    medianPeak: data.medianPeak,
    p25Peak: data.p25Peak,
    bgMedian: data.bgMedian,
    starBgContrast: data.starBgContrast,
    details: details.join('; '),
    fwhmSamples: data.fwhms,
    colorSamples: data.colorDivs,
    peakSamples: data.starPeaks
  };
}

/**
 * WI-16: build the ES5 PJSR for the star-field metric (pure string builder, unit-testable).
 * opts: { centerRadiusPx, centerRadiusFrac, peaks:[{x,y}], maxStars=60, knotRatio, saturated }
 * No StarDetector (it crashes). Compact-peak detection with knot rejection, local-background
 * FWHM (annulus 6-8 FWHM), half-max walk up to 31 px, second-moment ellipticity, centre/edge split.
 */
export function buildStarFieldPjsr(viewId, opts = {}) {
  const peaks = Array.isArray(opts.peaks)
    ? opts.peaks.filter(p => p && isFinite(p.x) && isFinite(p.y)).slice(0, 200).map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))
    : [];
  const cfg = {
    centerRadiusPx: Number.isFinite(opts.centerRadiusPx) && opts.centerRadiusPx > 0 ? opts.centerRadiusPx : 0,
    centerFrac: opts.centerRadiusFrac ?? STAR_CENTER_RADIUS_FRAC,
    maxStars: opts.maxStars || 60,
    knotRatio: opts.knotRatio ?? STAR_KNOT_RATIO,
    saturated: opts.saturated ?? STAR_SATURATED,
    peaks
  };
  return `
    var CFG = ${JSON.stringify(cfg)};
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureStarField: view not found: ${viewId}');
    var img = w.mainView.image;
    var isColor = img.isColor;
    var W = img.width, H = img.height;
    function getLum(x, y) {
      if (x < 0 || y < 0 || x >= W || y >= H) return NaN;
      if (isColor) return 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
      return img.sample(x, y);
    }
    function median(a) {
      if (a.length === 0) return 0;
      var b = a.slice(0).sort(function(p, q) { return p - q; });
      return b[Math.floor(b.length / 2)];
    }
    function ringValues(cx, cy, r0, r1) {
      var vals = [];
      var nA = 48, nR = 3;
      for (var ri = 0; ri < nR; ri++) {
        var rr = r0 + (r1 - r0) * ri / (nR - 1);
        for (var ai = 0; ai < nA; ai++) {
          var ang = 2 * Math.PI * (ai + 0.5 * (ri % 2)) / nA;
          var v = getLum(Math.round(cx + rr * Math.cos(ang)), Math.round(cy + rr * Math.sin(ang)));
          if (!isNaN(v)) vals.push(v);
        }
      }
      return vals;
    }
    // Half-max walk up to 31 px (NOT capped at 10): FWHM = 2 * mean half-max radius, linear interpolation.
    function walkFwhm(cx, cy, peak, bg) {
      var halfMax = bg + (peak - bg) / 2;
      var dirs = [[1,0],[0,1],[-1,0],[0,-1],[0.7071,0.7071],[-0.7071,0.7071],[0.7071,-0.7071],[-0.7071,-0.7071]];
      var radii = [], capped = 0;
      for (var d = 0; d < dirs.length; d++) {
        var found = -1;
        var prevV = peak;
        for (var r = 1; r <= 31; r++) {
          var v = getLum(Math.round(cx + dirs[d][0] * r), Math.round(cy + dirs[d][1] * r));
          if (isNaN(v)) break;
          if (v < halfMax) {
            found = (r - 1) + (prevV - halfMax) / Math.max(1e-9, (prevV - v));
            break;
          }
          prevV = v;
        }
        if (found < 0) {
          var vEnd = getLum(Math.round(cx + dirs[d][0] * 31), Math.round(cy + dirs[d][1] * 31));
          if (!isNaN(vEnd)) { radii.push(31); capped++; }
        } else radii.push(found);
      }
      if (radii.length < 4) return null;
      var s = 0;
      for (var i = 0; i < radii.length; i++) s += radii[i];
      return { fwhm: 2 * s / radii.length, capped: capped };
    }

    var bgMedian = img.median();
    var bgMAD = img.MAD();
    var threshold = bgMedian + 5 * bgMAD;
    var candidates = [];
    if (CFG.peaks.length > 0) {
      for (var pi = 0; pi < CFG.peaks.length; pi++) {
        var px0 = CFG.peaks[pi].x, py0 = CFG.peaks[pi].y;
        var bx = px0, by = py0, bl = getLum(px0, py0);
        if (isNaN(bl)) continue;
        for (var dy = -3; dy <= 3; dy++) for (var dx = -3; dx <= 3; dx++) {
          var l2 = getLum(px0 + dx, py0 + dy);
          if (!isNaN(l2) && l2 > bl) { bl = l2; bx = px0 + dx; by = py0 + dy; }
        }
        candidates.push({ x: bx, y: by, peak: bl });
      }
    } else {
      var step = 16, margin = 12;
      for (var y = margin; y < H - margin; y += step) {
        for (var x = margin; x < W - margin; x += step) {
          var lum = getLum(x, y);
          if (lum > threshold) {
            var bestX = x, bestY = y, bestLum = lum;
            // hill-climb (5x5 steps, up to 25 iterations) so bloated stars sampled on their slope reach the peak
            for (var it = 0; it < 25; it++) {
              var mvX = bestX, mvY = bestY, mvL = bestLum;
              for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
                var l = getLum(bestX + dx, bestY + dy);
                if (!isNaN(l) && l > mvL) { mvL = l; mvX = bestX + dx; mvY = bestY + dy; }
              }
              if (mvX === bestX && mvY === bestY) break;
              bestX = mvX; bestY = mvY; bestLum = mvL;
            }
            var isMax = true;
            for (var dy = -1; dy <= 1 && isMax; dy++) for (var dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              if (getLum(bestX + dx, bestY + dy) > bestLum) { isMax = false; break; }
            }
            if (isMax && bestLum > threshold) candidates.push({ x: bestX, y: bestY, peak: bestLum });
          }
        }
      }
    }
    var rawCandidates = candidates.length;
    candidates.sort(function(a, b) { return b.peak - a.peak; });
    var stars = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var isDupe = false;
      for (var j = 0; j < stars.length; j++) {
        var ddx = c.x - stars[j].x, ddy = c.y - stars[j].y;
        if (ddx * ddx + ddy * ddy < 400) { isDupe = true; break; }
      }
      if (!isDupe) stars.push(c);
      if (stars.length >= 400) break;
    }

    var satSkipped = 0, knotRejected = 0, noWalk = 0, snrRejected = 0, blendRejected = 0;
    var cxImg = W / 2, cyImg = H / 2;
    var halfDiag = Math.sqrt(W * W + H * H) / 2;
    var centerR = CFG.centerRadiusPx > 0 ? CFG.centerRadiusPx : CFG.centerFrac * halfDiag;
    var measured = [];
    var compactPeaks = [];
    for (var si = 0; si < stars.length && measured.length < CFG.maxStars; si++) {
      var s = stars[si];
      if (s.peak > CFG.saturated) { satSkipped++; continue; }
      // provisional local background (near ring) and FWHM
      var bg0 = median(ringValues(s.x, s.y, 20, 26));
      var prom0 = s.peak - bg0;
      if (prom0 <= 5 * bgMAD) { snrRejected++; continue; }
      var wk0 = walkFwhm(s.x, s.y, s.peak, bg0);
      if (!wk0) { noWalk++; continue; }
      // final local background: median of the 6-8 FWHM annulus
      var rA = Math.max(14, Math.min(200, 6 * wk0.fwhm)), rB = Math.max(rA + 4, Math.min(240, 8 * wk0.fwhm));
      var ring = ringValues(s.x, s.y, rA, rB);
      if (ring.length < 24) { noWalk++; continue; }
      var localBg = median(ring);
      var devs = [];
      for (var q = 0; q < ring.length; q++) devs.push(Math.abs(ring[q] - localBg));
      var sigma = Math.max(1e-6, 1.4826 * median(devs));
      var prom = s.peak - localBg;
      if (prom <= 0) { snrRejected++; continue; }
      // compactness (vs the 6-8 FWHM annulus background): 4 neighbours at +/- offset (8 px, or the provisional FWHM for bloated stars)
      var off = Math.max(8, Math.min(31, Math.round(wk0.fwhm)));
      var nb = [getLum(s.x + off, s.y), getLum(s.x - off, s.y), getLum(s.x, s.y + off), getLum(s.x, s.y - off)];
      var knot = false;
      for (var ni = 0; ni < 4; ni++) {
        if (isNaN(nb[ni])) continue;
        if ((nb[ni] - localBg) >= CFG.knotRatio * prom) knot = true;
      }
      if (knot) { knotRejected++; continue; }
      var wk = walkFwhm(s.x, s.y, s.peak, localBg);
      if (!wk) { noWalk++; continue; }
      // dark ring: ring at 1.5-2.5 FWHM below the local background
      var dr0 = Math.max(10, Math.min(60, 1.5 * wk.fwhm)), dr1 = Math.max(dr0 + 4, Math.min(80, 2.5 * wk.fwhm));
      var darkMed = median(ringValues(s.x, s.y, dr0, dr1));
      var darkDepth = Math.max(0, (localBg - darkMed) / prom);
      // colour diversity from the 3x3 mean around the peak
      var cdiv = -1;
      if (isColor) {
        var mR = 0, mG = 0, mB = 0, mN = 0;
        for (var ey = -1; ey <= 1; ey++) for (var ex = -1; ex <= 1; ex++) {
          var qx = s.x + ex, qy = s.y + ey;
          if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
          mR += img.sample(qx, qy, 0); mG += img.sample(qx, qy, 1); mB += img.sample(qx, qy, 2); mN++;
        }
        if (mN > 0) {
          mR /= mN; mG /= mN; mB /= mN;
          var mxc = Math.max(mR, mG, mB);
          if (mxc > 0.01) cdiv = (mxc - Math.min(mR, mG, mB)) / mxc;
        }
      }
      // second moments: bg-subtracted 31x31 box thresholded at 10% of prominence; SNR > 20; reject blends
      var ell = -1, snr = prom / sigma;
      var thr = 0.10 * prom;
      var sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, blend = false;
      var vals = [];
      for (var by2 = -15; by2 <= 15; by2++) {
        var row = [];
        for (var bx2 = -15; bx2 <= 15; bx2++) {
          var vv = getLum(s.x + bx2, s.y + by2);
          row.push(isNaN(vv) ? 0 : vv - localBg);
        }
        vals.push(row);
      }
      for (var by3 = 1; by3 < 30 && !blend; by3++) for (var bx3 = 1; bx3 < 30; bx3++) {
        var dxs = bx3 - 15, dys = by3 - 15;
        if (dxs * dxs + dys * dys < 36) continue;
        var vc = vals[by3][bx3];
        if (vc < 0.30 * prom) continue;
        var isLM = true;
        for (var ky = -1; ky <= 1 && isLM; ky++) for (var kx = -1; kx <= 1; kx++) {
          if ((kx !== 0 || ky !== 0) && vals[by3 + ky][bx3 + kx] > vc) { isLM = false; break; }
        }
        if (isLM) { blend = true; break; }
      }
      if (snr > 20 && !blend) {
        for (var my = 0; my < 31; my++) for (var mx2 = 0; mx2 < 31; mx2++) {
          var vm = vals[my][mx2];
          if (vm < thr) continue;
          sw += vm; sx += vm * (mx2 - 15); sy += vm * (my - 15);
        }
        if (sw > 0) {
          var mux = sx / sw, muy = sy / sw;
          for (var my2 = 0; my2 < 31; my2++) for (var mx3 = 0; mx3 < 31; mx3++) {
            var vm2 = vals[my2][mx3];
            if (vm2 < thr) continue;
            var ux = (mx3 - 15) - mux, uy = (my2 - 15) - muy;
            sxx += vm2 * ux * ux; syy += vm2 * uy * uy; sxy += vm2 * ux * uy;
          }
          sxx /= sw; syy /= sw; sxy /= sw;
          var tr = sxx + syy, det = sxx * syy - sxy * sxy;
          var disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
          var e1 = tr / 2 + disc, e2 = tr / 2 - disc;
          if (e1 > 1e-9 && e2 >= 0) ell = 1 - Math.sqrt(e2 / e1);
        }
      } else if (blend) blendRejected++;
      else snrRejected++;
      var dcx = s.x - cxImg, dcy = s.y - cyImg;
      var dist = Math.sqrt(dcx * dcx + dcy * dcy);
      measured.push({ x: s.x, y: s.y, peak: s.peak, localBg: localBg, prom: prom, ratio: s.peak / Math.max(1e-6, localBg),
                      fwhm: wk.fwhm, capped: wk.capped, ell: ell, cdiv: cdiv, dark: darkDepth, center: dist <= centerR });
      compactPeaks.push({ x: s.x, y: s.y });
    }

    function col(arr, key, okFn) {
      var o = [];
      for (var i2 = 0; i2 < arr.length; i2++) { var v2 = arr[i2][key]; if (okFn ? okFn(v2) : true) o.push(v2); }
      return o;
    }
    function nonneg(v) { return v >= 0; }
    function positive(v) { return v > 0; }
    var ctr = [], edg = [];
    for (var mi = 0; mi < measured.length; mi++) { if (measured[mi].center) ctr.push(measured[mi]); else edg.push(measured[mi]); }
    JSON.stringify({
      starsFound: stars.length, rawCandidates: rawCandidates, starsMeasured: measured.length,
      rejected: { saturated: satSkipped, knots: knotRejected, noWalk: noWalk, lowSNR: snrRejected, blends: blendRejected },
      centerRadiusPx: centerR,
      medianFWHM: median(col(measured, 'fwhm')),
      centerFWHM: median(col(ctr, 'fwhm')), edgeFWHM: median(col(edg, 'fwhm')),
      centerCount: ctr.length, edgeCount: edg.length,
      cappedFraction: measured.length ? col(measured, 'capped', positive).length / measured.length : 0,
      medianEllipticity: median(col(measured, 'ell', nonneg)), centerEllipticity: median(col(ctr, 'ell', nonneg)), edgeEllipticity: median(col(edg, 'ell', nonneg)),
      ellipticityCount: col(measured, 'ell', nonneg).length,
      medianDarkRing: median(col(measured, 'dark')),
      colorDiversity: median(col(measured, 'cdiv', nonneg)),
      prominenceAbs: median(col(measured, 'prom')), localRatio: median(col(measured, 'ratio')),
      medianPeak: median(col(measured, 'peak')), bgMedian: bgMedian,
      compactPeaks: compactPeaks.slice(0, 120),
      sample: measured.slice(0, 12)
    });
  `;
}

/**
 * WI-16: measure the star field (compact peaks, local-bg FWHM, ellipticity, centre/edge, absolute prominence).
 * ADVISORY metric: does not replace the blocking checkStarQuality brightness/FWHM values.
 * opts: { centerRadiusPx, peaks:[{x,y}] (re-measure known star coordinates), maxStars }
 */
export async function measureStarField(ctx, viewId, opts = {}) {
  const r = await ctx.pjsr(buildStarFieldPjsr(viewId, opts));
  if (r.status === 'error') throw new Error('measureStarField failed: ' + (r.error?.message || 'PJSR error'));
  let d;
  try { d = JSON.parse(r.outputs?.consoleOutput || '{}'); } catch { throw new Error('measureStarField: unparseable PJSR output'); }
  return summarizeStarField(d, opts.thresholds);
}

/** Add advisory flags/text to raw measureStarField data (pure; unit-testable). */
export function summarizeStarField(d, thresholds = {}) {
  const ellWarn = thresholds.ellipticity ?? STAR_ELLIPTICITY_WARN;
  const ringWarn = thresholds.darkRing ?? STAR_DARK_RING_WARN;
  const fwhmAdv = thresholds.fwhmAdvisory ?? STAR_FWHM_ADVISORY;
  const advisories = [];
  if ((d.centerCount || 0) > 0 && d.centerFWHM > fwhmAdv) advisories.push(`centre FWHM ${d.centerFWHM.toFixed(1)}px > ${fwhmAdv}px`);
  if ((d.ellipticityCount || 0) >= 5 && d.centerEllipticity > ellWarn) advisories.push(`centre ellipticity ${d.centerEllipticity.toFixed(2)} > ${ellWarn}`);
  if ((d.starsMeasured || 0) >= 5 && d.medianDarkRing > ringWarn) advisories.push(`dark rings ${(d.medianDarkRing * 100).toFixed(1)}% of prominence > ${(ringWarn * 100).toFixed(0)}%`);
  const f = (v, n = 1) => (typeof v === 'number' && isFinite(v) && v > 0) ? v.toFixed(n) : 'n/a';
  const text = `star field: ${d.starsMeasured || 0} compact stars (rejected: ${d.rejected?.knots || 0} knots, ${d.rejected?.saturated || 0} saturated, ${d.rejected?.blends || 0} blends); ` +
    `FWHM centre ${f(d.centerFWHM)}px (n=${d.centerCount || 0}) / edge ${f(d.edgeFWHM)}px (n=${d.edgeCount || 0}); ` +
    `ellipticity centre ${f(d.centerEllipticity, 2)} / edge ${f(d.edgeEllipticity, 2)}; ` +
    `abs prominence ${f(d.prominenceAbs, 3)}, local ratio ${f(d.localRatio)}x` +
    (advisories.length ? ` [ADVISORY: ${advisories.join('; ')}]` : '');
  return { ...d, advisories, text };
}

/**
 * Check for ringing artifacts around the brightest region.
 * Computes radial brightness profile (150 radii x 36 angles)
 * and counts derivative sign changes (oscillations).
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to check
 * @returns {object} { pass, oscillations, maxAmplitude, details }
 */
export async function checkRinging(ctx, viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('checkRinging: view not found: ${viewId}');
    var img = w.mainView.image;

    // Find brightest region: scan 64x64 blocks, find block with highest mean
    var blockSize = 64;
    var bestMean = 0;
    var bestX = 0, bestY = 0;
    for (var by = 0; by < img.height - blockSize; by += blockSize) {
      for (var bx = 0; bx < img.width - blockSize; bx += blockSize) {
        img.selectedRect = new Rect(bx, by, bx + blockSize, by + blockSize);
        if (img.isColor) {
          // Use luminance approximation
          var chMeans = [];
          for (var c = 0; c < 3; c++) {
            img.selectedChannel = c;
            chMeans.push(img.mean());
          }
          img.resetChannelSelection();
          var lum = 0.2126 * chMeans[0] + 0.7152 * chMeans[1] + 0.0722 * chMeans[2];
          if (lum > bestMean) {
            bestMean = lum;
            bestX = bx + Math.floor(blockSize / 2);
            bestY = by + Math.floor(blockSize / 2);
          }
        } else {
          var m = img.mean();
          if (m > bestMean) {
            bestMean = m;
            bestX = bx + Math.floor(blockSize / 2);
            bestY = by + Math.floor(blockSize / 2);
          }
        }
      }
    }
    img.resetSelections();

    // Now compute radial brightness profile from the brightest center
    var numRadii = 150;
    var numAngles = 36;
    var maxRadius = Math.min(numRadii, Math.min(
      Math.min(bestX, img.width - bestX - 1),
      Math.min(bestY, img.height - bestY - 1)
    ));

    // For each radius, average brightness across angles
    var profile = [];
    for (var ri = 1; ri <= maxRadius; ri++) {
      var sum = 0;
      var count = 0;
      for (var ai = 0; ai < numAngles; ai++) {
        var angle = ai * 2 * Math.PI / numAngles;
        var px = Math.round(bestX + ri * Math.cos(angle));
        var py = Math.round(bestY + ri * Math.sin(angle));
        if (px >= 0 && px < img.width && py >= 0 && py < img.height) {
          if (img.isColor) {
            // Luminance
            var lum = 0;
            for (var c = 0; c < 3; c++) {
              img.selectedChannel = c;
              var v = img.sample(px, py);
              lum += c === 0 ? v * 0.2126 : c === 1 ? v * 0.7152 : v * 0.0722;
            }
            img.resetChannelSelection();
            sum += lum;
          } else {
            sum += img.sample(px, py);
          }
          count++;
        }
      }
      profile.push(count > 0 ? sum / count : 0);
    }

    // Count derivative sign changes (oscillations) with amplitude threshold
    var derivatives = [];
    for (var i = 1; i < profile.length; i++) {
      derivatives.push(profile[i] - profile[i - 1]);
    }

    var signChanges = 0;
    var maxAmp = 0;
    var oscillationAmplitudes = [];
    var lastSign = 0;
    var runStart = 0;

    for (var i = 0; i < derivatives.length; i++) {
      var sign = derivatives[i] > 0.001 ? 1 : derivatives[i] < -0.001 ? -1 : 0;
      if (sign !== 0 && lastSign !== 0 && sign !== lastSign) {
        // Sign change — measure amplitude of the run
        var amp = 0;
        for (var j = runStart; j <= i; j++) {
          amp += Math.abs(derivatives[j]);
        }
        if (amp > 0.01) {
          signChanges++;
          oscillationAmplitudes.push(amp);
          if (amp > maxAmp) maxAmp = amp;
        }
        runStart = i;
      }
      if (sign !== 0) lastSign = sign;
    }

    JSON.stringify({
      center: [bestX, bestY],
      centerMean: bestMean,
      profileLength: profile.length,
      oscillations: signChanges,
      maxAmplitude: maxAmp,
      oscillationAmplitudes: oscillationAmplitudes.slice(0, 10),
      profileSample: profile.slice(0, 30)
    });
  `);

  if (r.status === 'error') {
    return {
      pass: false,
      error: r.error?.message || 'PJSR error',
      oscillations: 999,
      maxAmplitude: 999,
      details: 'Ringing check failed to execute'
    };
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { pass: false, error: 'Failed to parse PJSR output', oscillations: 999, maxAmplitude: 999 };
  }

  const pass = data.oscillations === 0;

  const details = [];
  if (!pass) {
    details.push(`RINGING DETECTED: ${data.oscillations} oscillation(s) (limit: 0) around brightest region at [${data.center}], max amplitude=${data.maxAmplitude.toFixed(4)}`);
  } else {
    details.push(`No ringing: ${data.oscillations} oscillations around [${data.center}]`);
  }

  return {
    pass,
    oscillations: data.oscillations,
    maxAmplitude: data.maxAmplitude,
    center: data.center,
    details: details.join('; '),
    profileSample: data.profileSample
  };
}

/**
 * Check image sharpness. Delegates to measureSubjectDetail (credible, star-rejected Sobel energy).
 * Returns a numeric score (higher = sharper). Comparative metric only.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to check
 * @param {object} roi - Optional ROI { x, y, w, h }. If omitted, all subject blocks are used.
 * @returns {object} { sharpness, details }
 */
export async function checkSharpness(ctx, viewId, roi) {
  // Delegates to the credible detail measurement (star-rejected, noise-floor corrected).
  const d = await measureSubjectDetail(ctx, viewId, { roi });
  if (d.error) {
    return { sharpness: 0, error: d.error, details: 'Sharpness check failed to execute' };
  }
  const f = (v) => (typeof v === 'number' && isFinite(v) ? v.toFixed(6) : 'n/a');
  return {
    sharpness: d.detailCredible,
    detailCredible: d.detailCredible,
    detailRaw: d.detailRaw,
    detailWeber: d.detailWeber,
    noiseDominated: d.noiseDominated,
    samplesUsed: d.raw?.blocksUsed,
    roi: roi || null,
    details: `Sharpness (credible detail): ${f(d.detailCredible)} | raw=${f(d.detailRaw)} weber=${f(d.detailWeber)}` +
      `${d.noiseDominated ? ' | NOISE-DOMINATED (raw/credible > 2.5)' : ''} (${d.raw?.blocksUsed ?? 0} star-rejected blocks${roi ? ` in ROI ${roi.w}x${roi.h}` : ''})`
  };
}

/**
 * Single-pass burn assessment (WI-10). One PJSR scan of the image feeds BOTH
 * the clip gate (blocks with > blockBurntPct % of sampled pixels above `clip`,
 * default BURN_CLIP) and the bright-block fraction gate (same test at `bright`,
 * default BRIGHT_BLOCK_LEVEL) — it replaces the former two full scans.
 *
 * Blocks are blockSize x blockSize px (default 50), sampled every 3rd pixel.
 * A pixel counts as exceeding a level when its luminance OR any channel is above it.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to scan
 * @param {object} opts - { clip=BURN_CLIP, bright=BRIGHT_BLOCK_LEVEL, blockSize=50, blockBurntPct=3 }
 * @returns {Promise<{error?:string, totalBlocks:number, blockSize:number, clip:number, bright:number,
 *   clipBlocks:number, brightBlocks:number, brightFraction:number, worstClipBlocks:Array,
 *   perChannelExceedance:{R:number,G:number,B:number}, coreWhiteFraction:number}>}
 *   perChannelExceedance = fraction of sampled pixels with that channel above `clip`;
 *   coreWhiteFraction = fraction of sampled pixels inside bright blocks whose three
 *   channels are all above 0.90 (a white blob, not a coloured bright region).
 */
export async function assessBurn(ctx, viewId, opts = {}) {
  const clip = opts.clip ?? BURN_CLIP;
  const bright = opts.bright ?? BRIGHT_BLOCK_LEVEL;
  const blockSize = opts.blockSize ?? 50;
  const blockBurntPct = opts.blockBurntPct ?? 3;

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('assessBurn: view not found: ${viewId}');
    var img = w.mainView.image;
    var blockSize = ${blockSize};
    var clip = ${clip};
    var bright = ${bright};
    var frac = ${blockBurntPct / 100};
    var totalBlocks = 0, clipBlocks = 0, brightBlocks = 0;
    var worst = [];
    var chN = [0, 0, 0], chTotal = 0;
    var whiteN = 0, brightSamples = 0;
    for (var by = 0; by < img.height - blockSize; by += blockSize) {
      for (var bx = 0; bx < img.width - blockSize; bx += blockSize) {
        totalBlocks++;
        var nClip = 0, nBright = 0, nWhite = 0, n = 0;
        for (var y = by; y < by + blockSize; y += 3) {
          for (var x = bx; x < bx + blockSize; x += 3) {
            n++;
            var m;
            if (img.isColor) {
              var r0 = img.sample(x, y, 0), g0 = img.sample(x, y, 1), b0 = img.sample(x, y, 2);
              var lum = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
              m = Math.max(lum, r0, g0, b0);
              if (r0 > clip) chN[0]++;
              if (g0 > clip) chN[1]++;
              if (b0 > clip) chN[2]++;
              if (Math.min(r0, g0, b0) > 0.90) nWhite++;
            } else {
              m = img.sample(x, y);
            }
            if (m > clip) nClip++;
            if (m > bright) nBright++;
          }
        }
        chTotal += n;
        if (n > 0 && nClip / n > frac) {
          clipBlocks++;
          worst.push({ x: bx, y: by, fraction: nClip / n });
        }
        if (n > 0 && nBright / n > frac) {
          brightBlocks++;
          whiteN += nWhite;
          brightSamples += n;
        }
      }
    }
    worst.sort(function(a, b) { return b.fraction - a.fraction; });
    JSON.stringify({
      totalBlocks: totalBlocks, blockSize: blockSize, clipBlocks: clipBlocks, brightBlocks: brightBlocks,
      worst: worst.slice(0, 10).map(function(b) { return { x: b.x, y: b.y, pctBurnt: Math.round(b.fraction * 100) }; }),
      perChannel: { R: chTotal ? chN[0] / chTotal : 0, G: chTotal ? chN[1] / chTotal : 0, B: chTotal ? chN[2] / chTotal : 0 },
      coreWhiteFraction: brightSamples ? whiteN / brightSamples : 0
    });
  `);

  if (r.status === 'error') {
    return { error: r.error?.message || 'PJSR error', totalBlocks: 0, blockSize, clip, bright, clipBlocks: 0, brightBlocks: 0,
      brightFraction: 0, worstClipBlocks: [], perChannelExceedance: { R: 0, G: 0, B: 0 }, coreWhiteFraction: 0 };
  }
  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { error: 'Failed to parse output', totalBlocks: 0, blockSize, clip, bright, clipBlocks: 0, brightBlocks: 0,
      brightFraction: 0, worstClipBlocks: [], perChannelExceedance: { R: 0, G: 0, B: 0 }, coreWhiteFraction: 0 };
  }
  const totalBlocks = data.totalBlocks || 0;
  return {
    totalBlocks, blockSize, clip, bright,
    clipBlocks: data.clipBlocks || 0,
    brightBlocks: data.brightBlocks || 0,
    brightFraction: totalBlocks ? (data.brightBlocks || 0) / totalBlocks : 0,
    worstClipBlocks: data.worst || [],
    perChannelExceedance: data.perChannel || { R: 0, G: 0, B: 0 },
    coreWhiteFraction: data.coreWhiteFraction || 0,
  };
}

/**
 * Global burn scanner (standalone tool + back-compat wrapper over assessBurn).
 *
 * Tiles the image in blockSize x blockSize blocks (default 50x50, every 3rd pixel
 * sampled). A block is "burnt" if more than blockBurntPct % (default 3) of its
 * sampled pixels (luminance or any channel) exceed BURN_CLIP (0.95). Large blocks keep
 * stars (PSF < 10 px) from false-positiving; only EXTENDED burnt regions trigger.
 * PASS: ZERO burnt blocks. The result also carries the BRIGHT_BLOCK_LEVEL (0.80)
 * fraction pass (brightBlocks / brightFraction) so the agent can preview Gate 3b.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to scan
 * @param {object} opts - { blockSize, clip, bright, blockBurntPct } (legacy `threshold` = clip)
 * @returns {object} { pass, burntBlockCount, totalBlocks, worstBlocks, brightBlocks, brightFraction,
 *   perChannelExceedance, coreWhiteFraction, details }
 */
export async function scanBurntRegions(ctx, viewId, opts = {}) {
  const a = await assessBurn(ctx, viewId, { ...opts, clip: opts.clip ?? opts.threshold });
  if (a.error) return { pass: false, error: a.error, details: 'Burn scan failed' };
  const pass = a.clipBlocks === 0;
  const pct = opts.blockBurntPct ?? 3;
  const details = [];
  if (!pass) {
    details.push(`BURNT REGIONS: ${a.clipBlocks} block(s) of ${a.blockSize}×${a.blockSize}px have >${pct}% pixels above ${a.clip}. ZERO burnt blocks allowed.`);
    if (a.worstClipBlocks.length > 0) details.push(`Locations: ${a.worstClipBlocks.map(b => `[${b.x},${b.y}] ${b.pctBurnt}%`).join(', ')}`);
    details.push('Apply min($T, 0.80) through core mask, or reduce stretch/LHE/curves strength.');
  } else {
    details.push(`Clean: 0/${a.totalBlocks} blocks burnt (${a.blockSize}×${a.blockSize}px, threshold ${a.clip})`);
  }
  details.push(`Bright blocks (>${a.bright}): ${a.brightBlocks}/${a.totalBlocks} (${(a.brightFraction * 100).toFixed(1)}%)`);
  return {
    pass,
    burntBlockCount: a.clipBlocks,
    totalBlocks: a.totalBlocks,
    worstBlocks: a.worstClipBlocks,
    brightBlocks: a.brightBlocks,
    brightFraction: a.brightFraction,
    perChannelExceedance: a.perChannelExceedance,
    coreWhiteFraction: a.coreWhiteFraction,
    details: details.join(' ')
  };
}

/**
 * Check saturation naturalness in subject pixels.
 * Computes HSV saturation for pixels above background (subject only).
 * Returns percentile statistics for comparison against per-category limits.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to check (should be the final composite, ideally before star blend)
 * @returns {object} { medianS, p90S, p99S, maxS, subjectPixelCount, details }
 */
export async function checkSaturation(ctx, viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('checkSaturation: view not found: ${viewId}');
    var img = w.mainView.image;
    if (!img.isColor) {
      JSON.stringify({ mono: true, medianS: 0, p90S: 0, p99S: 0, maxS: 0, subjectPixelCount: 0 });
    } else {
      // Find background level (PJSR: must set selectedChannel before median())
      img.selectedChannel = 0; var bgR = img.median();
      img.selectedChannel = 1; var bgG = img.median();
      img.selectedChannel = 2; var bgB = img.median();
      img.resetChannelSelection();
      // Approximate MAD via sampling
      var sampleStep = 32;
      var diffs = [];
      for (var y = 0; y < img.height; y += sampleStep) {
        for (var x = 0; x < img.width; x += sampleStep) {
          var lum = 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
          diffs.push(Math.abs(lum - (0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB)));
        }
      }
      diffs.sort(function(a, b) { return a - b; });
      var bgMAD = diffs[Math.floor(diffs.length / 2)];
      var bgLum = 0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB;
      var subjectThreshold = bgLum + 5 * bgMAD;

      // Sample subject pixels and compute HSV saturation
      var satValues = [];
      var step = 8; // sample every 8th pixel for speed
      for (var y = 0; y < img.height; y += step) {
        for (var x = 0; x < img.width; x += step) {
          var r = img.sample(x, y, 0);
          var g = img.sample(x, y, 1);
          var b = img.sample(x, y, 2);
          var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (lum > subjectThreshold) {
            var maxC = Math.max(r, g, b);
            var minC = Math.min(r, g, b);
            var sat = maxC > 0.001 ? (maxC - minC) / maxC : 0;
            satValues.push(sat);
          }
        }
      }

      // Sort for percentiles
      satValues.sort(function(a, b) { return a - b; });
      var n = satValues.length;
      var medianS = n > 0 ? satValues[Math.floor(n * 0.5)] : 0;
      var p90S = n > 0 ? satValues[Math.floor(n * 0.9)] : 0;
      var p99S = n > 0 ? satValues[Math.floor(n * 0.99)] : 0;
      var maxS = n > 0 ? satValues[n - 1] : 0;

      JSON.stringify({
        mono: false,
        medianS: medianS,
        p90S: p90S,
        p99S: p99S,
        maxS: maxS,
        subjectPixelCount: n,
        bgLum: bgLum,
        subjectThreshold: subjectThreshold
      });
    }
  `);

  if (r.status === 'error') {
    throw new Error('Saturation check failed to execute: ' + (r.error?.message || 'PJSR error'));
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { medianS: 0, p90S: 0, p99S: 0, maxS: 0, subjectPixelCount: 0, error: 'Failed to parse PJSR output' };
  }

  if (data.mono) {
    return { medianS: 0, p90S: 0, p99S: 0, maxS: 0, subjectPixelCount: 0, details: 'Mono image — saturation check skipped' };
  }

  return {
    medianS: data.medianS,
    p90S: data.p90S,
    p99S: data.p99S,
    maxS: data.maxS,
    subjectPixelCount: data.subjectPixelCount,
    details: `Saturation: median=${data.medianS.toFixed(3)}, P90=${data.p90S.toFixed(3)}, P99=${data.p99S.toFixed(3)}, max=${data.maxS.toFixed(3)} (${data.subjectPixelCount} subject pixels)`
  };
}

/**
 * Check tonal presence: determines if the subject is tonally impactful
 * relative to the background, or merely technically safe but subdued.
 *
 * Uses ROI-based subject/background separation with per-channel median,
 * MAD-based thresholding, and category-specific metrics.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to check
 * @param {string} category - Target classification (e.g. 'galaxy_spiral')
 * @returns {object} { pass, tonal_verdict, separation, ... }
 */
export async function checkTonalPresence(ctx, viewId, category) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('checkTonalPresence: view not found: ${viewId}');
    var img = w.mainView.image;
    var isColor = img.isColor;

    // Background: per-channel median -> luminance
    var bgR, bgG, bgB, bgLum;
    if (isColor) {
      img.selectedChannel = 0; bgR = img.median();
      img.selectedChannel = 1; bgG = img.median();
      img.selectedChannel = 2; bgB = img.median();
      img.resetChannelSelection();
      bgLum = 0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB;
    } else {
      bgLum = img.median();
    }

    // MAD from sampling
    var sampleStep = 32;
    var diffs = [];
    for (var y = 0; y < img.height; y += sampleStep) {
      for (var x = 0; x < img.width; x += sampleStep) {
        var lum;
        if (isColor) {
          lum = 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
        } else {
          lum = img.sample(x, y);
        }
        diffs.push(Math.abs(lum - bgLum));
      }
    }
    diffs.sort(function(a, b) { return a - b; });
    var bgMAD = diffs[Math.floor(diffs.length / 2)];
    var subjectThreshold = bgLum + 5 * bgMAD;

    // Separate subject/background pixels by sampling every 8th pixel
    // with spatial compactness filter to reject isolated star-like pixels
    var step = 8;
    var subjectPixels = [];
    var bgPixels = [];
    var sumWX = 0, sumWY = 0, sumW = 0;
    var starlikeRejected = 0;
    var probeD = 3;

    function getLumAt(px, py) {
      if (isColor) {
        return 0.2126 * img.sample(px, py, 0) + 0.7152 * img.sample(px, py, 1) + 0.0722 * img.sample(px, py, 2);
      }
      return img.sample(px, py);
    }

    for (var y = 0; y < img.height; y += step) {
      for (var x = 0; x < img.width; x += step) {
        var lum;
        if (isColor) {
          lum = 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
        } else {
          lum = img.sample(x, y);
        }
        if (lum > subjectThreshold) {
          // Spatial compactness check: probe 4 cardinal neighbors at distance probeD.
          // Extended structure (nebula/galaxy) will have neighbors also above threshold.
          // Isolated bright pixels (star residuals) will not.
          var brightNeighbors = 0;
          if (x - probeD >= 0 && getLumAt(x - probeD, y) > subjectThreshold) brightNeighbors++;
          if (x + probeD < img.width && getLumAt(x + probeD, y) > subjectThreshold) brightNeighbors++;
          if (y - probeD >= 0 && getLumAt(x, y - probeD) > subjectThreshold) brightNeighbors++;
          if (y + probeD < img.height && getLumAt(x, y + probeD) > subjectThreshold) brightNeighbors++;

          if (brightNeighbors >= 2) {
            // Extended structure — count as subject
            subjectPixels.push(lum);
            sumWX += x * lum;
            sumWY += y * lum;
            sumW += lum;
          } else {
            // Isolated / star-like — reject from subject, count as background
            starlikeRejected++;
            bgPixels.push(lum);
          }
        } else {
          bgPixels.push(lum);
        }
      }
    }

    // Subject centroid
    var centroidX = sumW > 0 ? sumWX / sumW : img.width / 2;
    var centroidY = sumW > 0 ? sumWY / sumW : img.height / 2;

    // Multi-subject detection: check if there are two bright clusters > 25% image width apart
    var roiMode = 'single';
    if (subjectPixels.length > 50) {
      // Find second centroid by excluding pixels near first centroid
      var excludeRadius = img.width * 0.15;
      var sumWX2 = 0, sumWY2 = 0, sumW2 = 0;
      for (var y = 0; y < img.height; y += step) {
        for (var x = 0; x < img.width; x += step) {
          var lum;
          if (isColor) {
            lum = 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
          } else {
            lum = img.sample(x, y);
          }
          if (lum > subjectThreshold) {
            var dx = x - centroidX;
            var dy = y - centroidY;
            if (Math.sqrt(dx * dx + dy * dy) > excludeRadius) {
              sumWX2 += x * lum;
              sumWY2 += y * lum;
              sumW2 += lum;
            }
          }
        }
      }
      if (sumW2 > sumW * 0.15) {
        var c2x = sumWX2 / sumW2;
        var c2y = sumWY2 / sumW2;
        var clusterDist = Math.sqrt((c2x - centroidX) * (c2x - centroidX) + (c2y - centroidY) * (c2y - centroidY));
        if (clusterDist > img.width * 0.25) {
          roiMode = 'compound_roi';
        }
      }
    }

    // Sort subject and background pixels for percentiles
    subjectPixels.sort(function(a, b) { return a - b; });
    bgPixels.sort(function(a, b) { return a - b; });

    var sn = subjectPixels.length;
    var bn = bgPixels.length;

    var bgMedian = bn > 0 ? bgPixels[Math.floor(bn * 0.5)] : bgLum;
    var bgP90 = bn > 0 ? bgPixels[Math.floor(bn * 0.9)] : bgLum;
    var subjMedian = sn > 0 ? subjectPixels[Math.floor(sn * 0.5)] : 0;
    var subjP75 = sn > 0 ? subjectPixels[Math.floor(sn * 0.75)] : 0;
    var subjP90 = sn > 0 ? subjectPixels[Math.floor(sn * 0.9)] : 0;
    var subjP10 = sn > 0 ? subjectPixels[Math.floor(sn * 0.1)] : 0;

    // Core brightness: mean of brightest 5% of subject pixels
    var top5start = Math.max(0, Math.floor(sn * 0.95));
    var coreBrightSum = 0;
    var coreBrightCount = 0;
    for (var i = top5start; i < sn; i++) {
      coreBrightSum += subjectPixels[i];
      coreBrightCount++;
    }
    var coreBrightness = coreBrightCount > 0 ? coreBrightSum / coreBrightCount : 0;

    // Faint structure visibility
    var faintStructVis = (subjP10 - bgP90) / Math.max(bgP90, 0.001);

    // Separation
    var separation = subjMedian / Math.max(bgMedian, 0.001);

    // Category-specific: core_to_disk for galaxies
    var coreToDisk = subjMedian > 0.001 ? coreBrightness / subjMedian : 0;

    // ROI confidence based on subject pixel count
    var totalSampled = Math.floor((img.width / step) * (img.height / step));
    var subjectFraction = sn / Math.max(totalSampled, 1);
    var roiConfidence = subjectFraction > 0.03 ? 'high' : subjectFraction > 0.01 ? 'medium' : 'low';

    JSON.stringify({
      background_median: bgMedian,
      background_p90: bgP90,
      subject_median: subjMedian,
      subject_p75: subjP75,
      subject_p90: subjP90,
      core_brightness: coreBrightness,
      faint_structure_visibility: faintStructVis,
      separation: separation,
      roi_confidence: roiConfidence,
      roi_mode: roiMode,
      subjectPixelCount: sn,
      starlike_rejected: starlikeRejected,
      core_to_disk: coreToDisk,
      centroid: [Math.round(centroidX), Math.round(centroidY)]
    });
  `);

  if (r.status === 'error') {
    throw new Error('Tonal presence check failed: ' + (r.error?.message || 'PJSR error'));
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { pass: false, tonal_verdict: 'unknown', error: 'Failed to parse PJSR output' };
  }

  // Verdict: subdued if separation < 3, balanced if 3-8, aggressive if >8
  let tonal_verdict;
  if (data.separation < 3) tonal_verdict = 'subdued';
  else if (data.separation <= 8) tonal_verdict = 'balanced';
  else tonal_verdict = 'aggressive';

  // Pass: verdict !== 'subdued' OR roi_confidence === 'low'
  const pass = tonal_verdict !== 'subdued' || data.roi_confidence === 'low';

  const isGalaxy = (category || '').startsWith('galaxy');
  const category_metrics = {};
  if (isGalaxy) {
    category_metrics.core_to_disk = data.core_to_disk;
  }

  const details = [];
  if (tonal_verdict === 'subdued') {
    details.push(`SUBDUED: subject/background separation=${data.separation.toFixed(2)}× (need >3×). Subject median=${data.subject_median.toFixed(4)}, background median=${data.background_median.toFixed(4)}.`);
    if (data.roi_confidence === 'low') {
      details.push('ROI confidence LOW — few subject pixels detected. Verdict is advisory only.');
    }
  } else if (tonal_verdict === 'aggressive') {
    details.push(`AGGRESSIVE: separation=${data.separation.toFixed(2)}× (>8×). Check for burns in bright areas.`);
  } else {
    details.push(`BALANCED: separation=${data.separation.toFixed(2)}× (3-8× range). Subject is tonally impactful.`);
  }
  details.push(`Core brightness=${data.core_brightness.toFixed(4)}, faint visibility=${data.faint_structure_visibility.toFixed(3)}`);

  return {
    pass,
    tonal_verdict,
    background_median: data.background_median,
    background_p90: data.background_p90,
    subject_median: data.subject_median,
    subject_p75: data.subject_p75,
    subject_p90: data.subject_p90,
    separation: data.separation,
    core_brightness: data.core_brightness,
    faint_structure_visibility: data.faint_structure_visibility,
    roi_confidence: data.roi_confidence,
    roi_mode: data.roi_mode,
    subjectPixelCount: data.subjectPixelCount,
    starlike_rejected: data.starlike_rejected,
    category_metrics,
    details: details.join(' '),
  };
}

/**
 * Shell-texture metrics (local stddev, tonal span, Sobel energy) on a view within the subject ROI.
 * Exported so prep can store a deterministic baseline (brief._baselineTexture) and the star
 * blend can stash the starless input (brief._preBlendTexture) without opening any window.
 * @param {object} opts.roi - { cx, cy, radius } (computed internally if omitted)
 * @returns {object} metrics incl. roi, or { error }
 */
export async function measureShellTexture(ctx, vid, opts = {}) {
    const r = await ctx.pjsr(`
      var w = ImageWindow.windowById('${vid}');
      if (w.isNull) throw new Error('checkHighlightTexture: view not found: ${vid}');
      var img = w.mainView.image;
      var isColor = img.isColor;
      var W = img.width, H = img.height;

      function getLum(px, py) {
        if (isColor) {
          return 0.2126 * img.sample(px, py, 0) + 0.7152 * img.sample(px, py, 1) + 0.0722 * img.sample(px, py, 2);
        }
        return img.sample(px, py);
      }

      // Background stats
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

      // ROI: use provided or compute from subject centroid
      var roiCx = ${opts.roi?.cx ?? -1};
      var roiCy = ${opts.roi?.cy ?? -1};
      var roiR = ${opts.roi?.radius ?? -1};

      if (roiCx < 0) {
        // Compute ROI from subject centroid
        var step = 8, probeD = 3;
        var swx = 0, swy = 0, sw = 0, sc = 0, totalS = 0;
        var coords = [];
        for (var y = step; y < H - step; y += step) {
          for (var x = step; x < W - step; x += step) {
            totalS++;
            var lum = getLum(x, y);
            if (lum > subjectThreshold) {
              var bn = 0;
              if (x - probeD >= 0 && getLum(x - probeD, y) > subjectThreshold) bn++;
              if (x + probeD < W && getLum(x + probeD, y) > subjectThreshold) bn++;
              if (y - probeD >= 0 && getLum(x, y - probeD) > subjectThreshold) bn++;
              if (y + probeD < H && getLum(x, y + probeD) > subjectThreshold) bn++;
              if (bn >= 2) {
                swx += x * lum; swy += y * lum; sw += lum; sc++;
                coords.push(x * 65536 + y);
              }
            }
          }
        }
        roiCx = sw > 0 ? Math.round(swx / sw) : Math.round(W / 2);
        roiCy = sw > 0 ? Math.round(swy / sw) : Math.round(H / 2);
        // Compute 90th-percentile radius
        var dists = [];
        for (var i = 0; i < coords.length; i++) {
          var sx = Math.floor(coords[i] / 65536);
          var sy = coords[i] % 65536;
          var dx2 = sx - roiCx, dy2 = sy - roiCy;
          dists.push(Math.sqrt(dx2*dx2 + dy2*dy2));
        }
        dists.sort(function(a,b){return a-b;});
        roiR = dists.length > 0 ? dists[Math.floor(dists.length*0.90)] : Math.min(W,H)/4;
        roiR = Math.max(50, Math.min(roiR, Math.min(W,H)*0.45));
        roiR = Math.round(roiR);
      }

      // Collect subject pixels within ROI, identify bright shell zone
      var roiSubject = [];
      var step2 = 4;
      for (var y = Math.max(0, roiCy - roiR); y < Math.min(H, roiCy + roiR); y += step2) {
        for (var x = Math.max(0, roiCx - roiR); x < Math.min(W, roiCx + roiR); x += step2) {
          var dx = x - roiCx, dy = y - roiCy;
          if (dx*dx + dy*dy > roiR*roiR) continue;
          var lum = getLum(x, y);
          if (lum > subjectThreshold) {
            roiSubject.push(lum);
          }
        }
      }
      roiSubject.sort(function(a,b){return a-b;});

      if (roiSubject.length < 100) {
        JSON.stringify({ error: 'too_few_subject_pixels', count: roiSubject.length,
          roiCx: roiCx, roiCy: roiCy, roiR: roiR });
      } else {
        // Shell zone: P20 to P92 of subject pixels within ROI
        var shellLow = roiSubject[Math.floor(roiSubject.length * 0.20)];
        var shellHigh = roiSubject[Math.floor(roiSubject.length * 0.92)];

        // 1. Local stddev in 16x16 blocks within shell zone
        var blockSize = 16;
        var blockStdDevs = [];
        for (var by = Math.max(0, roiCy - roiR); by < Math.min(H - blockSize, roiCy + roiR); by += blockSize) {
          for (var bx = Math.max(0, roiCx - roiR); bx < Math.min(W - blockSize, roiCx + roiR); bx += blockSize) {
            // Check if block center is in ROI
            var bcx = bx + blockSize/2, bcy = by + blockSize/2;
            var ddx = bcx - roiCx, ddy = bcy - roiCy;
            if (ddx*ddx + ddy*ddy > roiR*roiR) continue;
            // Collect block luminances, count shell pixels
            var bVals = [];
            var shellCount = 0;
            for (var py = by; py < by + blockSize; py += 2) {
              for (var px = bx; px < bx + blockSize; px += 2) {
                if (px >= W || py >= H) continue;
                var l = getLum(px, py);
                bVals.push(l);
                if (l >= shellLow && l <= shellHigh) shellCount++;
              }
            }
            // Only use blocks with ≥40% shell pixels
            if (shellCount < bVals.length * 0.40) continue;
            // Compute stddev
            var sum = 0, sum2 = 0;
            for (var k = 0; k < bVals.length; k++) {
              sum += bVals[k];
              sum2 += bVals[k] * bVals[k];
            }
            var mean = sum / bVals.length;
            var variance = sum2 / bVals.length - mean * mean;
            if (variance > 0) {
              blockStdDevs.push(Math.sqrt(variance));
            }
          }
        }
        blockStdDevs.sort(function(a,b){return a-b;});
        var shellLocalStdDev = blockStdDevs.length > 0
          ? blockStdDevs[Math.floor(blockStdDevs.length / 2)] : 0;

        // 2. Tonal span: P90 - P10 of shell-zone pixels
        var shellPixels = [];
        for (var i = 0; i < roiSubject.length; i++) {
          if (roiSubject[i] >= shellLow && roiSubject[i] <= shellHigh) {
            shellPixels.push(roiSubject[i]);
          }
        }
        shellPixels.sort(function(a,b){return a-b;});
        var shellTonalSpan = shellPixels.length > 10
          ? shellPixels[Math.floor(shellPixels.length * 0.90)]
            - shellPixels[Math.floor(shellPixels.length * 0.10)]
          : 0;

        // 3. Gradient energy (Sobel) restricted to shell zone within ROI
        var gradEnergy = 0, gradCount = 0;
        var gStep = 4;
        for (var y = Math.max(1, roiCy - roiR); y < Math.min(H-1, roiCy + roiR); y += gStep) {
          for (var x = Math.max(1, roiCx - roiR); x < Math.min(W-1, roiCx + roiR); x += gStep) {
            var ddx2 = x - roiCx, ddy2 = y - roiCy;
            if (ddx2*ddx2 + ddy2*ddy2 > roiR*roiR) continue;
            var cl = getLum(x, y);
            if (cl < shellLow || cl > shellHigh) continue;
            var tl = getLum(x-1,y-1), tc = getLum(x,y-1), tr = getLum(x+1,y-1);
            var ml = getLum(x-1,y),                        mr = getLum(x+1,y);
            var bl = getLum(x-1,y+1), bc = getLum(x,y+1), br = getLum(x+1,y+1);
            var gx = -tl + tr - 2*ml + 2*mr - bl + br;
            var gy = -tl - 2*tc - tr + bl + 2*bc + br;
            gradEnergy += gx*gx + gy*gy;
            gradCount++;
          }
        }
        var shellGradientEnergy = gradCount > 0 ? gradEnergy / gradCount : 0;

        JSON.stringify({
          shellLocalStdDev: shellLocalStdDev,
          shellTonalSpan: shellTonalSpan,
          shellGradientEnergy: shellGradientEnergy,
          shellPixelCount: shellPixels.length,
          blockCount: blockStdDevs.length,
          shellZone: { low: shellLow, high: shellHigh },
          roi: { cx: roiCx, cy: roiCy, radius: roiR },
          bgMedian: bgMedian
        });
      }
    `);

    if (r.status === 'error') {
      return { error: r.error?.message || 'PJSR error' };
    }
    try {
      return JSON.parse(r.outputs?.consoleOutput || '{}');
    } catch {
      return { error: 'Parse failed' };
    }
}

/**
 * Check highlight texture: detects perceptual burn — bright subject zones
 * where internal tonal variation has collapsed into a featureless plateau.
 *
 * Primary signal: RELATIVE texture retention vs a reference checkpoint.
 * Secondary: absolute heuristics (advisory only, never blocking alone).
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - Current image to assess
 * @param {object} opts
 * @param {string} opts.referenceId - Pre-operation clone/view for comparison (required for blocking)
 * @param {object} opts.roi - { cx, cy, radius } from locateSubjectROI (computed internally if omitted)
 * @param {object} opts.referenceMetrics - precomputed measureShellTexture() of the reference (no window needed)
 * @param {object} opts.currentMetrics - precomputed measureShellTexture() of the current view
 * @param {number} opts.minRetention / opts.warnRetention - profile highlight_texture thresholds (default 0.40/0.60)
 * @returns {object} { pass, verdict, textureRetention, spanRetention, gradientRetention, current, reference, roi, details }
 */
export async function checkHighlightTexture(ctx, viewId, opts = {}) {
  const refId = opts.referenceId || null;

  const measureShellTexture_ = (vid) => measureShellTexture(ctx, vid, opts);
  // Measure current view
  const current = opts.currentMetrics || await measureShellTexture_(viewId);
  if (current.error) {
    const isTooFew = current.error === 'too_few_subject_pixels';
    return {
      pass: true, // Don't block on measurement failure
      verdict: 'unmeasurable',
      details: isTooFew
        ? `Too few subject pixels (${current.count}) in ROI for texture measurement — advisory only`
        : `Measurement error: ${current.error}`,
      current: null, reference: null, roi: current
    };
  }

  // Cache ROI from current measurement for reference
  const roi = current.roi;

  // Measure reference if provided
  let reference = null;
  let retention = {};
  if (opts.referenceMetrics && !opts.referenceMetrics.error) {
    reference = opts.referenceMetrics;
  } else if (refId) {
    reference = await measureShellTexture_(refId);
    if (reference.error) {
      reference = null;
    }
  }

  // Compute retention ratios
  if (reference && !reference.error) {
    retention.texture = reference.shellLocalStdDev > 0.0001
      ? current.shellLocalStdDev / reference.shellLocalStdDev : 1.0;
    retention.span = reference.shellTonalSpan > 0.001
      ? current.shellTonalSpan / reference.shellTonalSpan : 1.0;
    retention.gradient = reference.shellGradientEnergy > 0.0001
      ? current.shellGradientEnergy / reference.shellGradientEnergy : 1.0;
  }

  // Verdict logic
  let pass, verdict;
  const details = [];

  if (reference && !reference.error) {
    // RELATIVE mode (primary, can be blocking)
    const worstRetention = Math.min(retention.texture ?? 1.0, retention.span ?? 1.0);
    const minRet = typeof opts.minRetention === 'number' ? opts.minRetention : 0.40;
    const warnRet = typeof opts.warnRetention === 'number' ? opts.warnRetention : 0.60;
    if (worstRetention < minRet) {
      pass = false;
      verdict = 'collapsed';
      details.push(`HIGHLIGHT TEXTURE COLLAPSED: worst retention=${(worstRetention * 100).toFixed(0)}% (limit: ${(minRet * 100).toFixed(0)}%). ` +
        `texture=${(retention.texture * 100).toFixed(0)}%, span=${(retention.span * 100).toFixed(0)}%, gradient=${((retention.gradient ?? 1) * 100).toFixed(0)}%. ` +
        `Restore pre-operation checkpoint and use less destructive processing.`);
    } else if (worstRetention < warnRet) {
      pass = true; // Warning, not blocking
      verdict = 'degraded';
      details.push(`Highlight texture degraded: retention=${(worstRetention * 100).toFixed(0)}% (warning at ${(warnRet * 100).toFixed(0)}%). ` +
        `Consider gentler processing.`);
    } else {
      pass = true;
      verdict = 'preserved';
      details.push(`Highlight texture preserved: retention=${(worstRetention * 100).toFixed(0)}%.`);
    }
  } else {
    // ADVISORY-ONLY mode (no reference, never blocking)
    pass = true;
    verdict = current.shellLocalStdDev < 0.010 ? 'low_advisory' : 'ok_advisory';
    details.push(`Highlight texture (advisory, no reference): localStdDev=${current.shellLocalStdDev.toFixed(4)}` +
      ` (heuristic floor: 0.010), tonalSpan=${current.shellTonalSpan.toFixed(3)}` +
      ` (heuristic floor: 0.05).`);
    if (current.shellLocalStdDev < 0.010) {
      details.push(`Advisory: localStdDev is very low — bright shell may lack visible texture. ` +
        `Provide a reference_id for blocking assessment.`);
    }
  }

  // Add absolute context
  details.push(`Shell zone [${current.shellZone.low.toFixed(3)}–${current.shellZone.high.toFixed(3)}], ` +
    `${current.shellPixelCount} pixels, ${current.blockCount} blocks measured.`);

  return {
    pass,
    verdict,
    mode: reference ? 'relative' : 'advisory',
    textureRetention: retention.texture ?? null,
    spanRetention: retention.span ?? null,
    gradientRetention: retention.gradient ?? null,
    current: {
      shellLocalStdDev: current.shellLocalStdDev,
      shellTonalSpan: current.shellTonalSpan,
      shellGradientEnergy: current.shellGradientEnergy,
    },
    reference: reference ? {
      shellLocalStdDev: reference.shellLocalStdDev,
      shellTonalSpan: reference.shellTonalSpan,
      shellGradientEnergy: reference.shellGradientEnergy,
    } : null,
    roi,
    shellZone: current.shellZone,
    details: details.join(' ')
  };
}

/**
 * Check star layer integrity before blending.
 * Operates on the STAR view (mostly black with bright star pixels).
 * Detects clipping, color loss, and other issues that would contaminate
 * the composition during screen blend.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - Star layer view ID
 * @returns {object} { pass, verdict, max_value, clipped_fraction_98, ... }
 */
export async function checkStarLayerIntegrity(ctx, viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('checkStarLayerIntegrity: view not found: ${viewId}');
    var img = w.mainView.image;
    var isColor = img.isColor;

    // Per-channel max
    var maxVal = 0;
    if (isColor) {
      for (var c = 0; c < 3; c++) {
        img.selectedChannel = c;
        var chMax = img.maximum();
        if (chMax > maxVal) maxVal = chMax;
      }
      img.resetChannelSelection();
    } else {
      maxVal = img.maximum();
    }

    // Sample every 4th pixel, find non-zero pixels (> 0.005)
    var step = 4;
    var nonzeroCount = 0;
    var clipped98 = 0;
    var clipped995 = 0;
    var hsvSatValues = [];
    var brightPixels = []; // top brightness pixels for chroma check

    for (var y = 0; y < img.height; y += step) {
      for (var x = 0; x < img.width; x += step) {
        var val;
        if (isColor) {
          var rv = img.sample(x, y, 0);
          var gv = img.sample(x, y, 1);
          var bv = img.sample(x, y, 2);
          val = Math.max(rv, gv, bv);
        } else {
          val = img.sample(x, y);
        }

        if (val > 0.005) {
          nonzeroCount++;

          // Clipping checks
          if (isColor) {
            var rv = img.sample(x, y, 0);
            var gv = img.sample(x, y, 1);
            var bv = img.sample(x, y, 2);
            if (rv > 0.98 || gv > 0.98 || bv > 0.98) clipped98++;
            if (rv > 0.995 || gv > 0.995 || bv > 0.995) clipped995++;

            // HSV saturation for color diversity
            var maxC = Math.max(rv, gv, bv);
            var minC = Math.min(rv, gv, bv);
            var hsvS = maxC > 0.001 ? (maxC - minC) / maxC : 0;
            hsvSatValues.push(hsvS);

            // Track bright pixels for chroma check
            var brightness = rv + gv + bv;
            if (brightPixels.length < 20 || brightness > brightPixels[brightPixels.length - 1].b) {
              brightPixels.push({ b: brightness, r: rv, g: gv, bv: bv });
              brightPixels.sort(function(a, b) { return b.b - a.b; });
              if (brightPixels.length > 20) brightPixels.length = 20;
            }
          } else {
            if (val > 0.98) clipped98++;
            if (val > 0.995) clipped995++;
          }
        }
      }
    }

    var clippedFrac98 = nonzeroCount > 0 ? clipped98 / nonzeroCount : 0;
    var clippedFrac995 = nonzeroCount > 0 ? clipped995 / nonzeroCount : 0;

    // Color diversity: spread of HSV saturation values
    var colorDiv = 0;
    if (hsvSatValues.length > 10) {
      hsvSatValues.sort(function(a, b) { return a - b; });
      // IQR-based spread
      var q25 = hsvSatValues[Math.floor(hsvSatValues.length * 0.25)];
      var q75 = hsvSatValues[Math.floor(hsvSatValues.length * 0.75)];
      colorDiv = q75 - q25;
    }

    // Bright star chroma: top 20 brightest -> median of (max-min)/max per pixel
    var chromaValues = [];
    for (var i = 0; i < brightPixels.length; i++) {
      var p = brightPixels[i];
      var pMax = Math.max(p.r, p.g, p.bv);
      var pMin = Math.min(p.r, p.g, p.bv);
      chromaValues.push(pMax > 0.001 ? (pMax - pMin) / pMax : 0);
    }
    chromaValues.sort(function(a, b) { return a - b; });
    var brightStarChroma = chromaValues.length > 0 ? chromaValues[Math.floor(chromaValues.length / 2)] : 0;

    JSON.stringify({
      max_value: maxVal,
      clipped_fraction_98: clippedFrac98,
      clipped_fraction_995: clippedFrac995,
      color_diversity: colorDiv,
      bright_star_chroma: brightStarChroma,
      nonzero_pixel_count: nonzeroCount,
      sampled_pixel_count: Math.ceil(img.width / step) * Math.ceil(img.height / step)
    });
  `);

  if (r.status === 'error') {
    return {
      pass: false,
      verdict: 'FAIL',
      error: r.error?.message || 'PJSR error',
      details: 'Star layer integrity check failed to execute'
    };
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { pass: false, verdict: 'FAIL', error: 'Failed to parse PJSR output' };
  }

  // Verdict logic
  let verdict;
  const details = [];

  if (data.max_value >= 0.98 || data.clipped_fraction_995 > 0) {
    verdict = 'FAIL';
    details.push(`CLIPPED STARS: max=${data.max_value.toFixed(4)} (limit: <0.98), ${(data.clipped_fraction_995 * 100).toFixed(2)}% at >0.995.`);
    details.push('Apply soft rolloff on star layer BEFORE blending: min($T, 0.95) or smooth compression above 0.65.');
  } else if (data.clipped_fraction_98 > 0.01 || data.color_diversity < 0.05) {
    verdict = 'WARN';
    if (data.clipped_fraction_98 > 0.01) {
      details.push(`Near-clipping: ${(data.clipped_fraction_98 * 100).toFixed(2)}% of star pixels >0.98.`);
    }
    if (data.color_diversity < 0.05) {
      details.push(`Low color diversity: ${data.color_diversity.toFixed(4)} — stars may appear monochrome.`);
    }
  } else {
    verdict = 'PASS';
    details.push(`Stars clean: max=${data.max_value.toFixed(4)}, color diversity=${data.color_diversity.toFixed(4)}, chroma=${data.bright_star_chroma.toFixed(4)}.`);
  }

  const pass = verdict === 'PASS';

  return {
    pass,
    verdict,
    max_value: data.max_value,
    clipped_fraction_98: data.clipped_fraction_98,
    clipped_fraction_995: data.clipped_fraction_995,
    color_diversity: data.color_diversity,
    bright_star_chroma: data.bright_star_chroma,
    nonzero_pixel_count: data.nonzero_pixel_count,
    sampled_pixel_count: data.sampled_pixel_count,
    details: details.join(' '),
  };
}

/**
 * Check bright-region chroma collapse: measures whether bright subject pixels
 * have lost color differentiation (all channels near-equal = white wash).
 *
 * Returns the median channel spread in bright subject pixels.
 * Useful as a post-star-blend check — if bright-region chroma drops
 * significantly compared to pre-star, the blend washed out the core.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to check
 * @param {number} brightnessThreshold - Luminance above which to measure (default 0.50)
 * @returns {object} { medianChroma, meanChroma, brightPixelCount, details }
 */
export async function checkBrightChroma(ctx, viewId, brightnessThreshold = 0.50) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('checkBrightChroma: view not found: ${viewId}');
    var img = w.mainView.image;
    if (!img.isColor) {
      JSON.stringify({ mono: true, medianChroma: 0, meanChroma: 0, brightPixelCount: 0 });
    } else {
      var threshold = ${brightnessThreshold};
      var step = 8;
      var chromaValues = [];

      for (var y = 0; y < img.height; y += step) {
        for (var x = 0; x < img.width; x += step) {
          var rv = img.sample(x, y, 0);
          var gv = img.sample(x, y, 1);
          var bv = img.sample(x, y, 2);
          var lum = (rv + gv + bv) / 3;
          if (lum > threshold) {
            var maxC = Math.max(rv, gv, bv);
            var minC = Math.min(rv, gv, bv);
            var chroma = maxC > 0.001 ? (maxC - minC) / maxC : 0;
            chromaValues.push(chroma);
          }
        }
      }

      chromaValues.sort(function(a, b) { return a - b; });
      var n = chromaValues.length;
      var medianC = n > 0 ? chromaValues[Math.floor(n * 0.5)] : 0;
      var meanC = 0;
      for (var i = 0; i < n; i++) meanC += chromaValues[i];
      meanC = n > 0 ? meanC / n : 0;

      JSON.stringify({
        mono: false,
        medianChroma: medianC,
        meanChroma: meanC,
        brightPixelCount: n,
        p25Chroma: n > 0 ? chromaValues[Math.floor(n * 0.25)] : 0,
        p75Chroma: n > 0 ? chromaValues[Math.floor(n * 0.75)] : 0
      });
    }
  `);

  if (r.status === 'error') {
    return { medianChroma: 0, meanChroma: 0, brightPixelCount: 0, error: r.error?.message };
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { medianChroma: 0, meanChroma: 0, brightPixelCount: 0, error: 'Failed to parse output' };
  }

  if (data.mono) {
    return { medianChroma: 0, meanChroma: 0, brightPixelCount: 0, details: 'Mono image — chroma check skipped' };
  }

  const details = `Bright-region chroma (lum>${brightnessThreshold}): median=${data.medianChroma.toFixed(4)}, mean=${data.meanChroma.toFixed(4)}, ` +
    `P25=${data.p25Chroma.toFixed(4)}, P75=${data.p75Chroma.toFixed(4)} (${data.brightPixelCount} bright pixels)`;

  return {
    medianChroma: data.medianChroma,
    meanChroma: data.meanChroma,
    brightPixelCount: data.brightPixelCount,
    p25Chroma: data.p25Chroma,
    p75Chroma: data.p75Chroma,
    details,
  };
}

// ============================================================================
// WI-26 D: Field-dependent PSF map (ported from the validated PACMAN psf_study/psfmap.js)
// ----------------------------------------------------------------------------
// Detection on a 2x IntegerResample-binned temp copy (closed in finally), moments on the
// full-resolution view. Run on LINEAR data. Not a gate: informs BXT/crop decisions. The
// crop_box is a RECOMMENDATION for the user's crop only - never crop the starless deliverable.
// ============================================================================

function _med(a) {
  if (!a.length) return NaN;
  const b = a.slice().sort((p, q) => p - q);
  return b[Math.floor(b.length / 2)];
}

/**
 * Largest-area axis-aligned rectangle of contiguous GOOD cells.
 * @param {boolean[][]} good - good[row][col]
 * @returns {{c0:number,r0:number,c1:number,r1:number,cells:number}|null} inclusive cell indices
 */
export function largestGoodRect(good) {
  const rows = good.length, cols = rows ? good[0].length : 0;
  let best = null;
  for (let r0 = 0; r0 < rows; r0++) {
    for (let c0 = 0; c0 < cols; c0++) {
      for (let r1 = r0; r1 < rows; r1++) {
        for (let c1 = c0; c1 < cols; c1++) {
          let ok = true;
          for (let r = r0; r <= r1 && ok; r++) for (let c = c0; c <= c1; c++) if (!good[r][c]) { ok = false; break; }
          if (!ok) continue;
          const cells = (r1 - r0 + 1) * (c1 - c0 + 1);
          if (!best || cells > best.cells) best = { c0, r0, c1, r1, cells };
        }
      }
    }
  }
  return best;
}

/**
 * Summarise a PSF grid.
 * @param {object} raw - { W, H, nStars, grid: [row][col] -> {n, fwhm, e, rel, skew} }
 * @param {object} [opts] - { minStarsPerCell=3, fwhmFactor=1.5, maxEllipticity=0.3, asymmetryRatio=1.5 }
 */
export function summarizePsfField(raw, opts = {}) {
  const minN = opts.minStarsPerCell ?? 3;
  const fwhmFactor = opts.fwhmFactor ?? 1.5;
  const maxE = opts.maxEllipticity ?? 0.3;
  const asymR = opts.asymmetryRatio ?? 1.5;
  const rows = raw.grid.length, cols = rows ? raw.grid[0].length : 0;
  const cells = raw.grid.map((row, j) => row.map((c, i) => ({
    col: i, row: j, n: c.n,
    fwhm_med: c.n ? c.fwhm : null, ellipticity_med: c.n ? c.e : null,
    orient_vs_radial_deg: c.n ? c.rel : null, radial_skew: c.n ? c.skew : null,
  })));
  const valid = [];
  cells.forEach(row => row.forEach(c => { if (c.n >= minN && Number.isFinite(c.fwhm_med)) valid.push(c); }));
  if (valid.length < 4) return { ok: false, verdict: 'insufficient stars', nStars: raw.nStars, cells, details: `PSF map: only ${valid.length} cells with >= ${minN} stars.` };
  let best = valid[0], worst = valid[0];
  valid.forEach(c => { if (c.fwhm_med < best.fwhm_med) best = c; if (c.fwhm_med > worst.fwhm_med) worst = c; });
  // Centre = the middle 2x2 (or nearest) cells
  const cc = [Math.floor((cols - 1) / 2), Math.ceil((cols - 1) / 2)], cr = [Math.floor((rows - 1) / 2), Math.ceil((rows - 1) / 2)];
  const centreVals = [];
  cr.forEach(j => cc.forEach(i => { const c = cells[j][i]; if (c.n >= minN) centreVals.push(c.fwhm_med); }));
  const centerFwhm = centreVals.length ? _med(centreVals) : null;
  const side = (cs, rs) => {
    const v = [];
    rs.forEach(j => cs.forEach(i => { const c = cells[j][i]; if (c.n >= minN) v.push(c.fwhm_med); }));
    return v.length ? _med(v) : null;
  };
  const allRows = cells.map((_, j) => j);
  const allCols = cells[0].map((_, i) => i);
  const w = Math.min(2, Math.floor(cols / 2)), h = Math.min(2, Math.floor(rows / 2));
  const L = side(allCols.slice(0, w), allRows), R = side(allCols.slice(cols - w), allRows);
  const T = side(allCols, allRows.slice(0, h)), B = side(allCols, allRows.slice(rows - h));
  const ratio = (a, b) => (a && b) ? Math.max(a, b) / Math.min(a, b) : null;
  const lrRatio = ratio(L, R), tbRatio = ratio(T, B);
  const edgeRows = new Set([0, rows - 1]), edgeCols = new Set([0, cols - 1]);
  const edge = valid.filter(c => edgeRows.has(c.row) || edgeCols.has(c.col));
  const edgeFwhm = edge.length ? _med(edge.map(c => c.fwhm_med)) : null;
  const edgeRel = edge.length ? _med(edge.map(c => c.orient_vs_radial_deg)) : null;
  const edgeE = edge.length ? _med(edge.map(c => c.ellipticity_med)) : null;
  let verdict = 'uniform';
  if ((lrRatio && lrRatio >= asymR) || (tbRatio && tbRatio >= asymR)) verdict = 'asymmetric — check tilt/backfocus';
  else if (centerFwhm && edgeFwhm && edgeFwhm / centerFwhm >= 1.3 && edgeRel !== null && edgeRel < 35 && edgeE > 0.15) verdict = 'radial coma';
  // crop box: contiguous cells with fwhm <= factor*best and ellipticity <= maxE
  const good = cells.map(row => row.map(c => c.n >= minN && c.fwhm_med <= fwhmFactor * best.fwhm_med && c.ellipticity_med <= maxE));
  const rect = largestGoodRect(good);
  const cw = raw.W / cols, ch = raw.H / rows;
  const crop_box = rect ? {
    x0: Math.round(rect.c0 * cw), y0: Math.round(rect.r0 * ch), x1: Math.round((rect.c1 + 1) * cw), y1: Math.round((rect.r1 + 1) * ch),
    cells: rect.cells, fractionOfFrame: rect.cells / (cols * rows),
  } : null;
  const f = (x) => (x == null ? 'n/a' : x.toFixed(2));
  const details = `PSF field: verdict=${verdict}. FWHM best=${f(best.fwhm_med)}px (cell ${best.col},${best.row}) worst=${f(worst.fwhm_med)}px (cell ${worst.col},${worst.row}) centre=${f(centerFwhm)}px; ` +
    `L/R=${f(lrRatio)}x (L=${f(L)} R=${f(R)}), T/B=${f(tbRatio)}x. ` +
    (crop_box ? `Suggested crop box (for the user's crop; never crop the starless deliverable): x ${crop_box.x0}-${crop_box.x1}, y ${crop_box.y0}-${crop_box.y1} (${(crop_box.fractionOfFrame * 100).toFixed(0)}% of frame).` : 'No contiguous good-PSF region found.');
  return {
    ok: true, verdict, nStars: raw.nStars, W: raw.W, H: raw.H,
    best: { col: best.col, row: best.row, fwhm: best.fwhm_med }, worst: { col: worst.col, row: worst.row, fwhm: worst.fwhm_med },
    center_fwhm: centerFwhm, lr_ratio: lrRatio, tb_ratio: tbRatio, left_fwhm: L, right_fwhm: R, top_fwhm: T, bottom_fwhm: B,
    crop_box, cells, details,
  };
}

/** Pure builder of the PJSR scan (ES5). Returns a script that prints JSON {W,H,nStars,nCands,grid}. */
export function buildPsfFieldPjsr(viewId, o = {}) {
  const cols = o.cols ?? 8, rows = o.rows ?? 6, maxStars = o.maxStars ?? 1500, satLimit = o.satLimit ?? 0.45;
  return `
    var VID='${viewId}', NX=${cols}, NY=${rows}, MAXSTARS=${maxStars}, SAT=${satLimit};
    var w=ImageWindow.windowById(VID); if (w.isNull) throw new Error('measurePsfField: view not found: '+VID);
    var img=w.mainView.image; var W=img.width, H=img.height;
    var CH = img.isColor ? 1 : 0;
    var med=img.median(), sig=img.MAD()*1.4826;
    var b=null, out=null;
    try {
      b=new ImageWindow(W,H,img.numberOfChannels,32,true,img.isColor,'__psf_bin');
      b.mainView.beginProcess(); b.mainView.image.assign(img); b.mainView.endProcess();
      var IR=new IntegerResample; IR.zoomFactor=-2; IR.downsamplingMode=IntegerResample.prototype.Average; IR.executeOn(b.mainView);
      var bi=b.mainView.image, bw=bi.width, bh=bi.height;
      var thr=med+40*sig/2, cands=[];
      // Stride on large frames: a JS loop over every binned pixel of a 60 MP image
      // (15 M sample() calls) triggered a fatal automatic GC on 2026-10-29.
      var STEP = (W*H > 30000000) ? 2 : 1;
      for(var y=12;y<bh-12;y+=STEP){ for(var x=12;x<bw-12;x+=STEP){ var v=bi.sample(x,y,CH); if(v<thr) continue;
        var isMax=true; for(var dy=-2;dy<=2&&isMax;dy++)for(var dx=-2;dx<=2;dx++){ if((dx||dy)&&bi.sample(x+dx,y+dy,CH)>v){isMax=false;break;} }
        if(isMax) cands.push([x*2,y*2,v]); } }
      cands.sort(function(p,q){return q[2]-p[2];});
      var cx0=W/2, cy0=H/2, R=24, stars=[], cellCount={};
      for(var i=0;i<cands.length && stars.length<MAXSTARS;i++){
        var sx=cands[i][0], sy=cands[i][1]; if(sx<R+2||sy<R+2||sx>W-R-3||sy>H-R-3) continue;
        var pk=0,px=sx,py=sy; for(var dy=-2;dy<=2;dy++)for(var dx=-2;dx<=2;dx++){var v=img.sample(sx+dx,sy+dy,CH); if(v>pk){pk=v;px=sx+dx;py=sy+dy;}}
        if(pk>SAT) continue;
        var ci=Math.min(NX-1,Math.floor(px/W*NX)), cj=Math.min(NY-1,Math.floor(py/H*NY)), key=ci+','+cj;
        if((cellCount[key]||0)>=Math.ceil(MAXSTARS/(NX*NY))*2) continue;
        var ring=[]; for(var a=0;a<64;a++){var t=a/64*2*Math.PI; ring.push(img.sample(Math.round(px+R*Math.cos(t)),Math.round(py+R*Math.sin(t)),CH));}
        ring.sort(function(p,q){return p-q;}); var lb=ring[32];
        var amp=pk-lb; if(amp<20*sig) continue;
        var s0=0,sx1=0,sy1=0; var win=[];
        for(var dy=-R;dy<=R;dy++)for(var dx=-R;dx<=R;dx++){ var v=img.sample(px+dx,py+dy,CH)-lb; if(v<0.08*amp) continue; s0+=v; sx1+=v*dx; sy1+=v*dy; win.push([dx,dy,v]); }
        if(s0<=0||win.length<6) continue;
        var mx=sx1/s0, my=sy1/s0, ixx=0,iyy=0,ixy=0;
        for(var k=0;k<win.length;k++){var d=win[k]; var ex=d[0]-mx, ey=d[1]-my; ixx+=d[2]*ex*ex; iyy+=d[2]*ey*ey; ixy+=d[2]*ex*ey;}
        ixx/=s0; iyy/=s0; ixy/=s0;
        var tr=(ixx+iyy)/2, dd=Math.sqrt(Math.max(0,(ixx-iyy)*(ixx-iyy)/4+ixy*ixy)); var l1=tr+dd, l2=Math.max(1e-6,tr-dd);
        var aAx=Math.sqrt(l1), bAx=Math.sqrt(l2); var theta=0.5*Math.atan2(2*ixy,ixx-iyy);
        var rx=px+mx-cx0, ry=py+my-cy0, rr=Math.sqrt(rx*rx+ry*ry)||1, ux=rx/rr, uy=ry/rr, phi=Math.atan2(ry,rx);
        var m3=0, m2=0; for(var k=0;k<win.length;k++){var d=win[k]; var t=(d[0]-mx)*ux+(d[1]-my)*uy; m2+=d[2]*t*t; m3+=d[2]*t*t*t;} m2/=s0; m3/=s0;
        var skew=m3/Math.pow(Math.max(m2,1e-6),1.5);
        var rel=Math.abs(((theta-phi)*180/Math.PI)%180); if(rel>90) rel=180-rel;
        stars.push({fwhm:2.3548*Math.sqrt((l1+l2)/2),e:1-bAx/aAx,rel:rel,skew:skew,cell:key});
        cellCount[key]=(cellCount[key]||0)+1;
      }
      function medv(a){ if(!a.length) return NaN; a=a.slice().sort(function(p,q){return p-q;}); return a[Math.floor(a.length/2)]; }
      var cells={};
      for(var i=0;i<stars.length;i++){ var s=stars[i]; (cells[s.cell]=cells[s.cell]||[]).push(s); }
      out={W:W,H:H,nStars:stars.length,nCands:cands.length,grid:[]};
      for(var j=0;j<NY;j++){ var row=[]; for(var i=0;i<NX;i++){ var c=cells[i+','+j]||[];
        row.push({n:c.length, fwhm:medv(c.map(function(s){return s.fwhm;})), e:medv(c.map(function(s){return s.e;})), rel:medv(c.map(function(s){return s.rel;})), skew:medv(c.map(function(s){return s.skew;}))}); }
        out.grid.push(row); }
    } finally {
      if (b !== null) { try { b.forceClose(); } catch (e1) {} }
    }
    JSON.stringify(out);
  `;
}

/**
 * Measure the field-dependent PSF on a LINEAR view. Opens exactly one temporary binned window
 * (closed in finally). Read-only on the source.
 * @returns {object} summarizePsfField result, or { ok:false, error }
 */
export async function measurePsfField(ctx, viewId, opts = {}) {
  const r = await ctx.pjsr(buildPsfFieldPjsr(viewId, opts));
  if (r.status === 'error') return { ok: false, error: r.error?.message || 'PJSR error' };
  let raw;
  try {
    // NaN is not valid JSON: PJSR prints NaN for empty cells
    raw = JSON.parse((r.outputs?.consoleOutput || '{}').replace(/\bNaN\b/g, 'null'));
  } catch { return { ok: false, error: 'Parse failed' }; }
  if (!raw.grid) return { ok: false, error: 'no grid returned' };
  raw.grid = raw.grid.map(row => row.map(c => ({ ...c, fwhm: c.fwhm ?? NaN, e: c.e ?? NaN, rel: c.rel ?? NaN, skew: c.skew ?? NaN })));
  return summarizePsfField(raw, opts.thresholds || {});
}

/**
 * Prep helper: measure the PSF field on a linear view and record it on brief._psf[viewId]
 * (latest) and brief._psfPrep[label]. Never throws; failure is logged and skipped.
 */
export async function recordPsfField(ctx, viewId, brief, label, log = () => {}) {
  try {
    // 2026-10-29: the PSF scan is a JS pixel loop; on a 60 MP channel it triggered an
    // automatic GC that aborted PixInsight (8th crash, in a warmed session). The
    // automatic prep diagnostic is skipped above AUTO_PSF_MAX_MP; the agent can still
    // call measure_psf_field on demand (it uses a stride there).
    const AUTO_PSF_MAX_MP = 30;
    const dim = await ctx.pjsr(`var w=ImageWindow.windowById('${viewId}'); w.isNull ? '0' : String(w.mainView.image.width*w.mainView.image.height)`);
    const mp = (parseInt(dim.result, 10) || 0) / 1e6;
    if (mp > AUTO_PSF_MAX_MP) {
      log(`  [psf ${label}] skipped: ${mp.toFixed(0)} MP > ${AUTO_PSF_MAX_MP} MP (JS pixel loop is unsafe on this size; run measure_psf_field on demand)`);
      if (brief) { brief._psfPrep = brief._psfPrep || {}; brief._psfPrep[label] = { view: viewId, skipped: `${mp.toFixed(0)} MP > ${AUTO_PSF_MAX_MP} MP` }; }
      return { ok: false, skipped: true, error: 'too large for the automatic scan' };
    }
    const res = await measurePsfField(ctx, viewId, {});
    if (brief) {
      brief._psf = brief._psf || {};
      brief._psf[viewId] = res;
      brief._psfPrep = brief._psfPrep || {};
      brief._psfPrep[label] = { view: viewId, verdict: res.verdict ?? null, crop_box: res.crop_box ?? null, center_fwhm: res.center_fwhm ?? null, lr_ratio: res.lr_ratio ?? null, tb_ratio: res.tb_ratio ?? null, error: res.error ?? null };
    }
    log(`  [psf ${label}] ${res.ok ? res.details : (res.error || res.verdict || 'unavailable')}`);
    return res;
  } catch (e) {
    log(`  [psf ${label}] skipped: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * WI-26 C: deterministic highlight-texture baseline, run once at the end of prep.
 * Locates the subject ROI once, measures shell texture on each given view with that ROI,
 * stores brief._roi and brief._baselineTexture ({rgb,l,ha,roi}) and writes baseline-texture.json.
 * No window is opened. Never throws.
 * @param {object} views - { rgb, l?, ha? } view ids (stretched, starless where applicable)
 */
export async function measureBaselineTexture(ctx, views, opts = {}) {
  const log = opts.log || (() => {});
  const out = {};
  try {
    const roi = await locateSubjectROI(ctx, views.rgb);
    if (roi.error) throw new Error(roi.error);
    const roiBox = { cx: roi.cx, cy: roi.cy, radius: roi.radius };
    out.roi = roiBox;
    for (const key of ['rgb', 'l', 'ha']) {
      if (!views[key]) continue;
      try { out[key] = await measureShellTexture(ctx, views[key], { roi: roiBox }); }
      catch (e) { out[key] = { error: e.message }; }
    }
    if (opts.brief) { opts.brief._roi = roiBox; opts.brief._baselineTexture = out; }
    if (opts.runDir) {
      try { fs.writeFileSync(path.join(opts.runDir, 'baseline-texture.json'), JSON.stringify(out, null, 2)); } catch { /* */ }
    }
    log(`  [baseline texture] ROI=(${roiBox.cx},${roiBox.cy}) r=${roiBox.radius}; ` +
      ['rgb', 'l', 'ha'].filter(k => out[k]).map(k => `${k}: ${out[k].error ? 'err ' + out[k].error : 'stdDev=' + out[k].shellLocalStdDev.toFixed(4)}`).join(', '));
  } catch (e) {
    log(`  [baseline texture] skipped: ${e.message}`);
  }
  return out;
}
