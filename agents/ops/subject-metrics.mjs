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
