// ============================================================================
// Benchmark Critic
// Compares a challenger against the current best, detects regressions.
// ============================================================================
import { DIMENSIONS, computeAggregate } from '../scoring.mjs';

export class BenchmarkCritic {
  constructor(targetClass = 'mixed_field') {
    this.targetClass = targetClass;
  }

  /**
   * Compare a challenger against the current best.
   * @param {object} currentBest - Technical scorecard of the current best
   * @param {object} challenger - Technical scorecard of the challenger
   * @returns {object} Benchmark verdict
   */
  compare(currentBest, challenger) {
    if (!currentBest) {
      return {
        critic: 'benchmark',
        comparisonType: 'vs_best_so_far',
        currentBestId: null,
        challengerId: challenger.candidateId,
        verdict: { pass: true, action: 'replace_best' },
        netImprovement: challenger.aggregate,
        isFirstRun: true,
        timestamp: new Date().toISOString()
      };
    }

    const improvements = [];
    const regressions = [];

    for (const dim of DIMENSIONS) {
      const currentScore = currentBest.scores[dim] ?? 50;
      const challengerScore = challenger.scores[dim] ?? 50;
      const delta = challengerScore - currentScore;

      if (dim === 'artifact_penalty') {
        // For artifact penalty, lower is better
        if (delta > 2) {
          regressions.push({ dimension: dim, delta, current: currentScore, challenger: challengerScore, acceptable: delta < 10 });
        } else if (delta < -2) {
          improvements.push({ dimension: dim, delta: -delta, current: currentScore, challenger: challengerScore });
        }
      } else {
        if (delta > 2) {
          improvements.push({ dimension: dim, delta, current: currentScore, challenger: challengerScore });
        } else if (delta < -2) {
          regressions.push({ dimension: dim, delta, current: currentScore, challenger: challengerScore, acceptable: Math.abs(delta) < 5 });
        }
      }
    }

    const netImprovement = challenger.aggregate - currentBest.aggregate;
    const hasUnacceptableRegression = regressions.some(r => !r.acceptable);
    const challengerPassesConstraints = challenger.pass;

    let action;
    if (!challengerPassesConstraints) {
      action = 'keep_current_best';
    } else if (hasUnacceptableRegression) {
      action = 'revisit_with_changes';
    } else if (netImprovement > 0.5) {
      action = 'replace_best';
    } else if (netImprovement > -0.5) {
      // Marginal difference — keep current best (prefer stability)
      action = 'keep_current_best';
    } else {
      action = 'keep_current_best';
    }

    return {
      critic: 'benchmark',
      comparisonType: 'vs_best_so_far',
      currentBestId: currentBest.candidateId,
      challengerId: challenger.candidateId,
      verdict: {
        pass: action === 'replace_best',
        action
      },
      improvements,
      regressions,
      netImprovement,
      aggregates: {
        currentBest: currentBest.aggregate,
        challenger: challenger.aggregate
      },
      timestamp: new Date().toISOString()
    };
  }
}
