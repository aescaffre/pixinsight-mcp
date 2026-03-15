// ============================================================================
// Scoring model: dimension scores, hard constraints, weighted aggregates
// ============================================================================

/**
 * Score dimension definitions.
 * Each dimension is scored 0-100. Higher is better (except artifact_penalty).
 */
export const DIMENSIONS = [
  'detail_credibility',
  'background_quality',
  'color_naturalness',
  'star_integrity',
  'tonal_balance',
  'subject_separation',
  'artifact_penalty',     // 0 = no artifacts, 100 = severe artifacts
  'aesthetic_coherence'
];

/**
 * Target-specific weighting profiles.
 * Weights are relative (will be normalized to sum to 1.0).
 * artifact_penalty is always subtracted with its own weight.
 */
export const WEIGHT_PROFILES = {
  galaxy_spiral: {
    detail_credibility: 1.0,
    background_quality: 0.75,
    color_naturalness: 0.60,
    star_integrity: 0.50,
    tonal_balance: 0.85,
    subject_separation: 0.70,
    artifact_penalty: 0.20,
    aesthetic_coherence: 0.70
  },
  galaxy_edge_on: {
    detail_credibility: 1.0,
    background_quality: 0.80,
    color_naturalness: 0.55,
    star_integrity: 0.50,
    tonal_balance: 0.90,
    subject_separation: 0.65,
    artifact_penalty: 0.20,
    aesthetic_coherence: 0.65
  },
  emission_nebula: {
    detail_credibility: 0.75,
    background_quality: 0.65,
    color_naturalness: 1.0,
    star_integrity: 0.55,
    tonal_balance: 0.70,
    subject_separation: 0.95,
    artifact_penalty: 0.20,
    aesthetic_coherence: 0.85
  },
  reflection_nebula: {
    detail_credibility: 0.70,
    background_quality: 0.80,
    color_naturalness: 1.0,
    star_integrity: 0.55,
    tonal_balance: 0.75,
    subject_separation: 0.65,
    artifact_penalty: 0.25,
    aesthetic_coherence: 0.95
  },
  star_cluster: {
    detail_credibility: 0.60,
    background_quality: 0.85,
    color_naturalness: 0.80,
    star_integrity: 1.0,
    tonal_balance: 0.70,
    subject_separation: 0.50,
    artifact_penalty: 0.20,
    aesthetic_coherence: 0.75
  },
  mixed_field: {
    detail_credibility: 0.80,
    background_quality: 0.75,
    color_naturalness: 0.80,
    star_integrity: 0.70,
    tonal_balance: 0.75,
    subject_separation: 0.80,
    artifact_penalty: 0.25,
    aesthetic_coherence: 0.80
  }
};

/**
 * Hard constraint definitions.
 * Each function takes image stats and processing brief, returns { pass, detail }.
 */
export const HARD_CONSTRAINTS = {
  no_clipping(stats, brief) {
    const maxVal = brief?.hardConstraints?.maxPixelValue ?? 0.995;
    const pass = stats.max < maxVal;
    return { pass, detail: pass ? null : `max=${stats.max.toFixed(4)} exceeds ${maxVal}` };
  },
  no_black_crush(stats, brief) {
    const minBg = brief?.hardConstraints?.minBackgroundMedian ?? 0.001;
    const pass = stats.median > minBg;
    return { pass, detail: pass ? null : `median=${stats.median.toFixed(6)} below ${minBg}` };
  },
  background_within_range(stats, brief) {
    const maxBg = brief?.hardConstraints?.maxBackgroundMedian ?? 0.25;
    const pass = stats.median < maxBg;
    return { pass, detail: pass ? null : `median=${stats.median.toFixed(4)} exceeds ${maxBg}` };
  },
  channel_balanced(stats, brief) {
    if (!stats.perChannel) return { pass: true, detail: 'mono image' };
    const maxImbalance = brief?.hardConstraints?.maxChannelImbalance ?? 0.05;
    const { R, G, B } = stats.perChannel;
    const meds = [R.median, G.median, B.median];
    const avg = meds.reduce((a, b) => a + b, 0) / 3;
    if (avg === 0) return { pass: true, detail: 'zero median' };
    const maxDiff = Math.max(...meds.map(m => Math.abs(m - avg) / avg));
    const pass = maxDiff < maxImbalance;
    return { pass, detail: pass ? null : `channel imbalance ${(maxDiff * 100).toFixed(1)}% > ${maxImbalance * 100}%` };
  }
};

/**
 * Check all hard constraints against stats.
 * @returns {{ pass: boolean, violations: string[] }}
 */
export function checkHardConstraints(stats, brief) {
  const violations = [];
  for (const [name, checkFn] of Object.entries(HARD_CONSTRAINTS)) {
    const result = checkFn(stats, brief);
    if (!result.pass) violations.push(`${name}: ${result.detail}`);
  }
  return { pass: violations.length === 0, violations };
}

/**
 * Compute weighted aggregate score from dimension scores.
 * @param {object} scores - { detail_credibility: 85, background_quality: 72, ... }
 * @param {string} targetClass - e.g. 'galaxy_spiral', 'emission_nebula'
 * @returns {{ aggregate: number, weighted: object }}
 */
export function computeAggregate(scores, targetClass = 'mixed_field') {
  const weights = WEIGHT_PROFILES[targetClass] || WEIGHT_PROFILES.mixed_field;

  // Normalize positive weights (excluding artifact_penalty)
  const positiveDims = DIMENSIONS.filter(d => d !== 'artifact_penalty');
  const totalPosWeight = positiveDims.reduce((sum, d) => sum + (weights[d] || 0), 0);

  let positiveSum = 0;
  const weighted = {};

  for (const dim of positiveDims) {
    const w = (weights[dim] || 0) / totalPosWeight;
    const s = scores[dim] ?? 50; // default to 50 if missing
    weighted[dim] = { score: s, weight: w, contribution: s * w };
    positiveSum += s * w;
  }

  // Subtract artifact penalty
  const artifactPenalty = (scores.artifact_penalty ?? 0) * (weights.artifact_penalty ?? 0.20);
  weighted.artifact_penalty = {
    score: scores.artifact_penalty ?? 0,
    weight: weights.artifact_penalty ?? 0.20,
    contribution: -artifactPenalty
  };

  const aggregate = Math.max(0, positiveSum - artifactPenalty);

  return { aggregate, weighted };
}

/**
 * Compute dimension scores from raw image statistics.
 * These are objective, stats-derived scores (not aesthetic).
 * @param {object} stats - From getStats(): { median, mad, min, max, perChannel }
 * @param {object} uniformity - From measureUniformity(): { score, corners, mean }
 * @param {object} brief - Processing brief with target info
 * @returns {object} Partial dimension scores
 */
export function statsToScores(stats, uniformity, brief) {
  const scores = {};

  // Background quality: inversely proportional to uniformity stddev
  // Perfect = 0.0, bad = 0.01+. Map to 0-100.
  const uScore = uniformity?.score ?? 0.01;
  scores.background_quality = Math.max(0, Math.min(100, 100 * (1 - uScore / 0.005)));

  // Dynamic range / tonal balance
  const bgMedian = uniformity?.mean ?? stats.median;
  const dr = (stats.max - bgMedian) / Math.max(stats.max, 0.001);
  scores.tonal_balance = Math.max(0, Math.min(100, dr * 110));

  // Color naturalness: channel balance quality
  if (stats.perChannel) {
    const { R, G, B } = stats.perChannel;
    const meds = [R.median, G.median, B.median];
    const avg = meds.reduce((a, b) => a + b, 0) / 3;
    const maxDiff = avg > 0 ? Math.max(...meds.map(m => Math.abs(m - avg) / avg)) : 0;
    scores.color_naturalness = Math.max(0, Math.min(100, 100 * (1 - maxDiff / 0.10)));
  } else {
    scores.color_naturalness = 75; // mono images get neutral score
  }

  // Noise assessment: lower MAD = cleaner
  const madRatio = stats.mad / Math.max(stats.median, 0.001);
  scores.detail_credibility = Math.max(0, Math.min(100, 100 * (1 - madRatio / 0.5)));

  // Artifact penalty starts at 0 (stats can't detect most artifacts)
  scores.artifact_penalty = 0;

  // Placeholder for dimensions that need visual assessment
  scores.star_integrity = 70;        // needs visual assessment
  scores.subject_separation = 70;    // needs visual assessment
  scores.aesthetic_coherence = 70;   // needs visual assessment

  return scores;
}
