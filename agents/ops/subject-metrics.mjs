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

  // Build assessment
  const assessments = [];
  if (data.subjectBrightness < 0.15) {
    assessments.push('SUBJECTS TOO DIM (brightness=' + data.subjectBrightness.toFixed(3) + ', goal: >0.25). Stretch harder or boost subject luminance.');
  } else if (data.subjectBrightness < 0.25) {
    assessments.push('Subjects moderately bright (' + data.subjectBrightness.toFixed(3) + '). Could push brighter for more impact.');
  } else {
    assessments.push('Subject brightness good (' + data.subjectBrightness.toFixed(3) + ').');
  }

  if (data.contrastRatio < 2.0) {
    assessments.push('LOW CONTRAST (ratio=' + data.contrastRatio.toFixed(1) + '×, goal: >3×). Subjects not separating from background.');
  } else if (data.contrastRatio < 3.0) {
    assessments.push('Moderate contrast (' + data.contrastRatio.toFixed(1) + '×). Could improve.');
  } else {
    assessments.push('Good contrast (' + data.contrastRatio.toFixed(1) + '×).');
  }

  if (data.detailScore < 0.001) {
    assessments.push('VERY LOW DETAIL (score=' + data.detailScore.toFixed(6) + '). Subjects look like smooth blobs. Push LHE/HDRMT harder.');
  } else if (data.detailScore < 0.005) {
    assessments.push('Moderate detail (' + data.detailScore.toFixed(6) + '). Room for improvement with fine-scale LHE.');
  } else {
    assessments.push('Good detail (' + data.detailScore.toFixed(6) + ').');
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
