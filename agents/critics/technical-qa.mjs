// ============================================================================
// Technical QA Critic
// Pure stats-based: checks hard constraints and computes dimension scores.
// No LLM required.
// ============================================================================
import { checkHardConstraints, statsToScores, computeAggregate } from '../scoring.mjs';

export class TechnicalQACritic {
  constructor(brief) {
    this.brief = brief;
    this.targetClass = brief?.target?.classification || 'mixed_field';
  }

  /**
   * Evaluate a single variant.
   * @param {object} variant - { artifactId, metrics, uniformity }
   * @returns {object} Technical scorecard
   */
  evaluate(variant) {
    const stats = variant.metrics;
    const uniformity = variant.uniformity || { score: 0.005, corners: [], mean: stats.median };

    // Hard constraints
    const constraints = checkHardConstraints(stats, this.brief);

    // Dimension scores from stats
    const scores = statsToScores(stats, uniformity, this.brief);

    // Aggregate
    const { aggregate, weighted } = computeAggregate(scores, this.targetClass);

    return {
      critic: 'technical_qa',
      candidateId: variant.artifactId,
      timestamp: new Date().toISOString(),
      pass: constraints.pass,
      hardConstraints: constraints,
      scores,
      aggregate,
      weighted,
      measurements: {
        imageMedian: stats.median,
        imageMax: stats.max,
        imageMin: stats.min,
        imageMAD: stats.mad,
        backgroundUniformity: uniformity.score,
        backgroundMean: uniformity.mean,
        channelMedians: stats.perChannel ? {
          R: stats.perChannel.R.median,
          G: stats.perChannel.G.median,
          B: stats.perChannel.B.median
        } : null
      }
    };
  }

  /**
   * Evaluate and rank multiple variants.
   * @param {Array} variants - Array of { artifactId, metrics, uniformity }
   * @returns {Array} Sorted by aggregate score (descending), with hard constraint failures last
   */
  evaluateAll(variants) {
    const scorecards = variants.map(v => this.evaluate(v));

    // Sort: passing candidates first (by score), then failing candidates
    scorecards.sort((a, b) => {
      if (a.pass && !b.pass) return -1;
      if (!a.pass && b.pass) return 1;
      return b.aggregate - a.aggregate;
    });

    return scorecards;
  }
}
