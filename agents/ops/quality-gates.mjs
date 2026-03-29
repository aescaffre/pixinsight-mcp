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

    JSON.stringify({
      starsFound: stars.length,
      starsMeasured: fwhms.length,
      medianFWHM: medFWHM,
      colorDiversity: medColorDiv,
      fwhms: fwhms.slice(0, 10),
      colorDivs: colorDivs.slice(0, 10)
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
  const pass = fwhmPass && colorPass && countPass;

  const details = [];
  if (!fwhmPass) details.push(`Stars bloated: median FWHM=${data.medianFWHM.toFixed(2)}px (limit: 8.0px)`);
  if (!colorPass) details.push(`Stars colorless: diversity=${data.colorDiversity.toFixed(3)} (limit: 0.05)`);
  if (!countPass) details.push(`Too few stars: ${data.starsFound} found (minimum: 50) — stars may be missing or over-reduced`);
  if (pass) details.push(`Stars OK: FWHM=${data.medianFWHM.toFixed(2)}px, color=${data.colorDiversity.toFixed(3)}, count=${data.starsFound}`);

  return {
    pass,
    medianFWHM: data.medianFWHM,
    colorDiversity: data.colorDiversity,
    starsFound: data.starsFound,
    starsMeasured: data.starsMeasured,
    details: details.join('; '),
    fwhmSamples: data.fwhms,
    colorSamples: data.colorDivs
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
