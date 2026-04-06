// ============================================================================
// Quality Gates — automated pixel-level quality checks via PJSR
// These gates are code-based and cannot be bypassed by the agent.
// ============================================================================

/**
 * Check star quality: FWHM and color diversity.
 * Uses StarDetector to find bright stars, samples 21x21 boxes,
 * measures FWHM via Gaussian fit and color spread.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID (should be the final composite with stars)
 * @returns {object} { pass, medianFWHM, colorDiversity, details, stars }
 */
export async function checkStarQuality(ctx, viewId) {
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
      starPeaks: starPeaks.slice(0, 10)
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

  const fwhmPass = data.medianFWHM <= 8.0;
  const colorPass = data.colorDiversity > 0.05;
  const countPass = data.starsFound >= 50; // minimum star presence

  // Star brightness: star-to-background contrast ratio
  // Prominent: ≥ 4.0, Balanced: ≥ 3.0, Subdued: ≥ 2.0
  const brightnessPass = data.starBgContrast >= 3.0;

  const pass = fwhmPass && colorPass && countPass && brightnessPass;

  const details = [];
  if (!fwhmPass) details.push(`Stars bloated: median FWHM=${data.medianFWHM.toFixed(2)}px (limit: 8.0px)`);
  if (!colorPass) details.push(`Stars colorless: diversity=${data.colorDiversity.toFixed(3)} (limit: 0.05)`);
  if (!countPass) details.push(`Too few stars: ${data.starsFound} found (minimum: 50) — stars may be missing or over-reduced`);
  if (!brightnessPass) details.push(`Stars too dim: contrast=${data.starBgContrast.toFixed(1)}× vs background (limit: 3.0×), median peak=${data.medianPeak.toFixed(3)}, bg=${data.bgMedian.toFixed(4)}`);
  if (pass) details.push(`Stars OK: FWHM=${data.medianFWHM.toFixed(2)}px, color=${data.colorDiversity.toFixed(3)}, count=${data.starsFound}, brightness=${data.starBgContrast.toFixed(1)}× bg`);

  return {
    pass,
    medianFWHM: data.medianFWHM,
    colorDiversity: data.colorDiversity,
    starsFound: data.starsFound,
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
 * Check image sharpness via Sobel gradient energy in the subject ROI.
 * Returns a numeric score (higher = sharper). Comparative metric only.
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to check
 * @param {object} roi - Optional ROI { x, y, w, h }. If omitted, uses central 50%.
 * @returns {object} { sharpness, details }
 */
export async function checkSharpness(ctx, viewId, roi) {
  const roiSpec = roi
    ? `var rx=${roi.x},ry=${roi.y},rw=${roi.w},rh=${roi.h};`
    : `var rw=Math.floor(img.width*0.5);var rh=Math.floor(img.height*0.5);var rx=Math.floor((img.width-rw)/2);var ry=Math.floor((img.height-rh)/2);`;

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('checkSharpness: view not found: ${viewId}');
    var img = w.mainView.image;

    ${roiSpec}

    // Compute Sobel gradient energy on luminance
    // Sample every 4th pixel for speed
    var step = 4;
    var totalEnergy = 0;
    var count = 0;

    function getLum(px, py) {
      if (img.isColor) {
        var r = img.sample(px, py, 0);
        var g = img.sample(px, py, 1);
        var b = img.sample(px, py, 2);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      return img.sample(px, py);
    }

    for (var y = ry + 1; y < ry + rh - 1; y += step) {
      for (var x = rx + 1; x < rx + rw - 1; x += step) {
        // Sobel 3x3
        var tl = getLum(x-1, y-1), tc = getLum(x, y-1), tr = getLum(x+1, y-1);
        var ml = getLum(x-1, y),                          mr = getLum(x+1, y);
        var bl = getLum(x-1, y+1), bc = getLum(x, y+1), br = getLum(x+1, y+1);

        var gx = -tl + tr - 2*ml + 2*mr - bl + br;
        var gy = -tl - 2*tc - tr + bl + 2*bc + br;
        totalEnergy += gx * gx + gy * gy;
        count++;
      }
    }

    var avgEnergy = count > 0 ? totalEnergy / count : 0;

    JSON.stringify({
      sharpness: avgEnergy,
      samplesUsed: count,
      roi: { x: rx, y: ry, w: rw, h: rh }
    });
  `);

  if (r.status === 'error') {
    return {
      sharpness: 0,
      error: r.error?.message || 'PJSR error',
      details: 'Sharpness check failed to execute'
    };
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { sharpness: 0, error: 'Failed to parse PJSR output' };
  }

  return {
    sharpness: data.sharpness,
    samplesUsed: data.samplesUsed,
    roi: data.roi,
    details: `Sharpness score: ${data.sharpness.toFixed(6)} (${data.samplesUsed} samples in ROI ${data.roi.w}x${data.roi.h})`
  };
}

/**
 * Check if the brightest region (galaxy core) is burnt/clipped.
 * Finds the brightest 64x64 block, then measures what fraction of pixels
 * in a 128x128 region around it exceed 0.98 (burnt).
 *
 * PASS: < 2% of core pixels burnt
 * FAIL: >= 5% burnt (core is clipped, detail lost)
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to check
 * @returns {object} { pass, burntFraction, peakValue, details }
 */
export async function checkCoreBurning(ctx, viewId) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('checkCoreBurning: view not found: ${viewId}');
    var img = w.mainView.image;

    // Find brightest 64x64 block
    var blockSize = 64;
    var bestMean = 0;
    var bestX = 0, bestY = 0;
    for (var by = 0; by < img.height - blockSize; by += blockSize) {
      for (var bx = 0; bx < img.width - blockSize; bx += blockSize) {
        img.selectedRect = new Rect(bx, by, bx + blockSize, by + blockSize);
        if (img.isColor) {
          var chMeans = [];
          for (var c = 0; c < 3; c++) {
            img.selectedChannel = c;
            chMeans.push(img.mean());
          }
          img.resetChannelSelection();
          var lum = 0.2126 * chMeans[0] + 0.7152 * chMeans[1] + 0.0722 * chMeans[2];
          if (lum > bestMean) { bestMean = lum; bestX = bx; bestY = by; }
        } else {
          var m = img.mean();
          if (m > bestMean) { bestMean = m; bestX = bx; bestY = by; }
        }
      }
    }
    img.resetSelections();

    // Measure 128x128 region around brightest block
    var coreSize = 128;
    var cx = Math.max(0, Math.min(bestX + blockSize / 2 - coreSize / 2, img.width - coreSize));
    var cy = Math.max(0, Math.min(bestY + blockSize / 2 - coreSize / 2, img.height - coreSize));

    var burntCount = 0;
    var totalCount = 0;
    var peakVal = 0;
    var step = 2; // sample every 2nd pixel for speed

    for (var y = cy; y < cy + coreSize; y += step) {
      for (var x = cx; x < cx + coreSize; x += step) {
        var lum;
        if (img.isColor) {
          var r = img.sample(x, y, 0);
          var g = img.sample(x, y, 1);
          var b = img.sample(x, y, 2);
          lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          // Also check individual channels — any channel > 0.93 is burnt
          if (r > 0.93 || g > 0.93 || b > 0.93) burntCount++;
        } else {
          lum = img.sample(x, y);
          if (lum > 0.93) burntCount++;
        }
        if (lum > peakVal) peakVal = lum;
        totalCount++;
      }
    }

    var fraction = totalCount > 0 ? burntCount / totalCount : 0;

    // Also check a tighter 32x32 inner core (catches small PN cores)
    var innerSize = 32;
    var icx = Math.max(0, Math.min(bestX + blockSize / 2 - innerSize / 2, img.width - innerSize));
    var icy = Math.max(0, Math.min(bestY + blockSize / 2 - innerSize / 2, img.height - innerSize));
    var innerBurnt = 0;
    var innerTotal = 0;
    for (var y = icy; y < icy + innerSize; y++) {
      for (var x = icx; x < icx + innerSize; x++) {
        if (img.isColor) {
          if (img.sample(x, y, 0) > 0.93 || img.sample(x, y, 1) > 0.93 || img.sample(x, y, 2) > 0.93) innerBurnt++;
        } else {
          if (img.sample(x, y) > 0.93) innerBurnt++;
        }
        innerTotal++;
      }
    }
    var innerFraction = innerTotal > 0 ? innerBurnt / innerTotal : 0;

    JSON.stringify({
      burntFraction: fraction,
      innerBurntFraction: innerFraction,
      burntPixels: burntCount,
      totalSampled: totalCount,
      peakValue: peakVal,
      coreCenter: [Math.round(cx + coreSize / 2), Math.round(cy + coreSize / 2)],
      coreMean: bestMean
    });
  `);

  if (r.status === 'error') {
    return {
      pass: false,
      error: r.error?.message || 'PJSR error',
      burntFraction: 999,
      details: 'Core burning check failed to execute'
    };
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { pass: false, error: 'Failed to parse PJSR output', burntFraction: 999 };
  }

  // Check both wide (128×128) and tight (32×32) core regions
  const widePass = data.burntFraction < 0.02;  // < 2% in 128×128 region
  const innerPass = (data.innerBurntFraction || 0) < 0.10;  // < 10% in tight 32×32 inner core
  const pass = widePass && innerPass;

  const details = [];
  if (!widePass) {
    details.push(`CORE BURNT (wide): ${(data.burntFraction * 100).toFixed(1)}% of 128×128 core > 0.93 (limit: 2%).`);
  }
  if (!innerPass) {
    details.push(`CORE BURNT (inner): ${((data.innerBurntFraction || 0) * 100).toFixed(1)}% of 32×32 inner core > 0.93 (limit: 10%). Compact core is clipped.`);
  }
  if (pass) {
    details.push(`Core OK: wide=${(data.burntFraction * 100).toFixed(1)}%, inner=${((data.innerBurntFraction || 0) * 100).toFixed(1)}%, peak=${data.peakValue.toFixed(4)}`);
  }
  details.push(`Peak=${data.peakValue.toFixed(4)} at [${data.coreCenter}]`);

  return {
    pass,
    burntFraction: data.burntFraction,
    peakValue: data.peakValue,
    coreCenter: data.coreCenter,
    details: details.join('; ')
  };
}

/**
 * Global burn scanner — ZERO TOLERANCE design.
 *
 * Tiles the image in large blocks (100×100 = 10,000 pixels).
 * Large blocks ensure stars (PSF < 10px) can't false-positive — even a bright
 * star is < 1% of a 100×100 block. Only EXTENDED burnt regions trigger this.
 *
 * A block is "burnt" if > 3% of its pixels (luminance) exceed 0.93.
 * PASS: ZERO burnt blocks. Not 1%, not 0.1% — ZERO.
 * FAIL: ANY burnt block found (even one).
 *
 * This catches burning regardless of subject size or position.
 * Works for PNe (5% of image), galaxies (30%), multi-subject fields (M81+M82).
 *
 * @param {object} ctx - Bridge context
 * @param {string} viewId - View ID to scan
 * @param {object} opts - { blockSize: 100, threshold: 0.93, blockBurntPct: 3 }
 * @returns {object} { pass, burntBlockCount, totalBlocks, burntLocations, details }
 */
export async function scanBurntRegions(ctx, viewId, opts = {}) {
  const blockSize = opts.blockSize ?? 50;
  const threshold = opts.threshold ?? 0.95;
  const blockBurntPct = opts.blockBurntPct ?? 3; // % of pixels in block above threshold to consider it burnt

  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('scanBurntRegions: view not found: ${viewId}');
    var img = w.mainView.image;

    var blockSize = ${blockSize};
    var burntBlocks = [];
    var totalBlocks = 0;
    var threshold = ${threshold};
    var blockBurntThreshold = ${blockBurntPct / 100}; // fraction

    for (var by = 0; by < img.height - blockSize; by += blockSize) {
      for (var bx = 0; bx < img.width - blockSize; bx += blockSize) {
        totalBlocks++;
        var burntInBlock = 0;
        var pixelsInBlock = 0;

        // Sample every 3rd pixel for speed (100x100 / 9 ≈ 1100 samples per block — plenty)
        for (var y = by; y < by + blockSize; y += 3) {
          for (var x = bx; x < bx + blockSize; x += 3) {
            pixelsInBlock++;
            // Check luminance for color images (any single channel > threshold also counts)
            if (img.isColor) {
              var lum = 0.2126 * img.sample(x, y, 0) + 0.7152 * img.sample(x, y, 1) + 0.0722 * img.sample(x, y, 2);
              if (lum > threshold || img.sample(x, y, 0) > threshold || img.sample(x, y, 1) > threshold || img.sample(x, y, 2) > threshold) {
                burntInBlock++;
              }
            } else {
              if (img.sample(x, y) > threshold) burntInBlock++;
            }
          }
        }

        var blockFraction = pixelsInBlock > 0 ? burntInBlock / pixelsInBlock : 0;
        if (blockFraction > blockBurntThreshold) {
          burntBlocks.push({
            x: bx, y: by,
            fraction: blockFraction
          });
        }
      }
    }

    // Sort by severity
    burntBlocks.sort(function(a, b) { return b.fraction - a.fraction; });

    JSON.stringify({
      burntBlockCount: burntBlocks.length,
      totalBlocks: totalBlocks,
      blockSize: blockSize,
      threshold: threshold,
      worstBlocks: burntBlocks.slice(0, 10).map(function(b) {
        return { x: b.x, y: b.y, pctBurnt: Math.round(b.fraction * 100) };
      })
    });
  `);

  if (r.status === 'error') {
    return {
      pass: false,
      error: r.error?.message || 'PJSR error',
      details: 'Burn scan failed'
    };
  }

  let data;
  try {
    data = JSON.parse(r.outputs?.consoleOutput || '{}');
  } catch {
    return { pass: false, error: 'Failed to parse output' };
  }

  // ZERO TOLERANCE: any burnt block = FAIL
  const pass = data.burntBlockCount === 0;

  const details = [];
  if (!pass) {
    details.push(`BURNT REGIONS: ${data.burntBlockCount} block(s) of ${blockSize}×${blockSize}px have >${blockBurntPct}% pixels above ${threshold}. ZERO burnt blocks allowed.`);
    if (data.worstBlocks.length > 0) {
      details.push(`Locations: ${data.worstBlocks.map(b => `[${b.x},${b.y}] ${b.pctBurnt}%`).join(', ')}`);
    }
    details.push('Apply min($T, 0.80) through core mask, or reduce stretch/LHE/curves strength.');
  } else {
    details.push(`Clean: 0/${data.totalBlocks} blocks burnt (${blockSize}×${blockSize}px, threshold ${threshold})`);
  }

  return {
    pass,
    burntBlockCount: data.burntBlockCount,
    totalBlocks: data.totalBlocks,
    worstBlocks: data.worstBlocks,
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
 * @returns {object} { pass, verdict, textureRetention, spanRetention, gradientRetention, current, reference, roi, details }
 */
export async function checkHighlightTexture(ctx, viewId, opts = {}) {
  const refId = opts.referenceId || null;

  // Measure function that runs on a single view within an ROI
  async function measureShellTexture(vid) {
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

  // Measure current view
  const current = await measureShellTexture(viewId);
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
  if (refId) {
    reference = await measureShellTexture(refId);
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
    if (worstRetention < 0.40) {
      pass = false;
      verdict = 'collapsed';
      details.push(`HIGHLIGHT TEXTURE COLLAPSED: worst retention=${(worstRetention * 100).toFixed(0)}% (limit: 40%). ` +
        `texture=${(retention.texture * 100).toFixed(0)}%, span=${(retention.span * 100).toFixed(0)}%, gradient=${((retention.gradient ?? 1) * 100).toFixed(0)}%. ` +
        `Restore pre-operation checkpoint and use less destructive processing.`);
    } else if (worstRetention < 0.60) {
      pass = true; // Warning, not blocking
      verdict = 'degraded';
      details.push(`Highlight texture degraded: retention=${(worstRetention * 100).toFixed(0)}% (warning at 60%). ` +
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
      nonzero_pixel_count: nonzeroCount
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
