// ============================================================================
// Iteration state machine for doer agents
// ============================================================================
import fs from 'fs';
import path from 'path';

/**
 * States in the optimization loop.
 */
export const STATES = {
  INITIAL: 'INITIAL',
  EXPLORE: 'EXPLORE',
  EVALUATE: 'EVALUATE',
  SELECT_BEST: 'SELECT_BEST',
  REFINE: 'REFINE',
  REGRESS_CHECK: 'REGRESS_CHECK',
  OSCILLATION_DETECTED: 'OSCILLATION_DETECTED',
  EXPLORE_ALT: 'EXPLORE_ALT',
  ACCEPT: 'ACCEPT',
  ESCALATE: 'ESCALATE',
  DONE: 'DONE'
};

/**
 * Default stopping conditions.
 */
const DEFAULT_POLICY = {
  convergenceThreshold: 1.5,    // score delta below this = converged
  convergenceRounds: 2,         // must be below threshold for N consecutive rounds
  acceptThreshold: 70,          // minimum aggregate score to accept
  maxIterations: 8,             // hard cap on iterations
  maxWallClockMs: 60 * 60000,  // 60 minutes per agent
  maxRegressions: 3,            // consecutive regressions before oscillation
  maxExploreAlternatives: 2,    // max alternative approaches
  coarseCandidates: 4,          // candidates in EXPLORE phase
  refineCandidates: 3           // candidates in REFINE phase
};

/**
 * Iteration state machine.
 * Manages the explore → evaluate → refine → accept loop for a doer agent.
 */
export class IterationStateMachine {
  constructor(agentName, policy = {}) {
    this.agentName = agentName;
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.state = STATES.INITIAL;
    this.startTime = Date.now();
    this.iterationCount = 0;
    this.regressionCount = 0;
    this.altExplorations = 0;
    this.history = [];         // { iteration, params, score, state }
    this.bestScore = null;
    this.bestVariantId = null;
    this.convergenceCount = 0;
    this.log = console.log;
  }

  /**
   * Persist state to a JSON file for crash recovery.
   */
  save(filePath) {
    const data = {
      agentName: this.agentName,
      state: this.state,
      startTime: this.startTime,
      iterationCount: this.iterationCount,
      regressionCount: this.regressionCount,
      altExplorations: this.altExplorations,
      history: this.history,
      bestScore: this.bestScore,
      bestVariantId: this.bestVariantId,
      convergenceCount: this.convergenceCount,
      savedAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Restore state from a saved JSON file.
   */
  static load(filePath, policy = {}) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const sm = new IterationStateMachine(data.agentName, policy);
    sm.state = data.state;
    sm.startTime = data.startTime;
    sm.iterationCount = data.iterationCount;
    sm.regressionCount = data.regressionCount;
    sm.altExplorations = data.altExplorations;
    sm.history = data.history;
    sm.bestScore = data.bestScore;
    sm.bestVariantId = data.bestVariantId;
    sm.convergenceCount = data.convergenceCount;
    return sm;
  }

  /**
   * Check if budget is exhausted.
   */
  budgetExhausted() {
    if (this.iterationCount >= this.policy.maxIterations) return 'max_iterations';
    if (Date.now() - this.startTime > this.policy.maxWallClockMs) return 'wall_clock';
    return null;
  }

  /**
   * Transition to a new state with logging.
   */
  transition(newState) {
    this.log(`  [state] ${this.agentName}: ${this.state} → ${newState}`);
    this.state = newState;
  }

  /**
   * Record a completed variant evaluation.
   * @param {string} variantId - Artifact identifier
   * @param {object} params - Parameters used
   * @param {number} score - Aggregate score
   * @returns {string} Next state recommendation
   */
  recordEvaluation(variantId, params, score) {
    this.iterationCount++;
    this.history.push({
      iteration: this.iterationCount,
      variantId,
      params,
      score,
      state: this.state,
      timestamp: Date.now()
    });

    // Check budget first
    const budget = this.budgetExhausted();
    if (budget) {
      this.log(`  [state] Budget exhausted: ${budget}`);
      this.transition(STATES.ESCALATE);
      return STATES.ESCALATE;
    }

    return this.state; // caller must use decide() for state transitions
  }

  /**
   * After evaluating candidates, decide next state.
   * @param {Array} candidates - [{ variantId, score, params }] sorted by score desc
   * @returns {string} Next state
   */
  decide(candidates) {
    if (candidates.length === 0) {
      this.transition(STATES.ESCALATE);
      return STATES.ESCALATE;
    }

    const best = candidates[0];

    switch (this.state) {
      case STATES.INITIAL:
        this.transition(STATES.EXPLORE);
        return STATES.EXPLORE;

      case STATES.EXPLORE:
      case STATES.EXPLORE_ALT:
        // After coarse exploration, pick best and move to refine
        if (best.score >= this.policy.acceptThreshold) {
          this.bestScore = best.score;
          this.bestVariantId = best.variantId;
          this.transition(STATES.REFINE);
          return STATES.REFINE;
        }
        // No candidate meets threshold — try alternative if budget allows
        if (this.altExplorations < this.policy.maxExploreAlternatives) {
          this.altExplorations++;
          this.transition(STATES.EXPLORE_ALT);
          return STATES.EXPLORE_ALT;
        }
        // Accept best anyway
        this.bestScore = best.score;
        this.bestVariantId = best.variantId;
        this.transition(STATES.ACCEPT);
        return STATES.ACCEPT;

      case STATES.REFINE:
      case STATES.REGRESS_CHECK:
        return this._handleRefinement(best);

      case STATES.OSCILLATION_DETECTED:
        if (this.altExplorations < this.policy.maxExploreAlternatives) {
          this.altExplorations++;
          this.transition(STATES.EXPLORE_ALT);
          return STATES.EXPLORE_ALT;
        }
        this.transition(STATES.ACCEPT);
        return STATES.ACCEPT;

      default:
        return this.state;
    }
  }

  _handleRefinement(candidate) {
    const delta = this.bestScore !== null ? candidate.score - this.bestScore : candidate.score;

    if (candidate.score > this.bestScore) {
      // Improvement
      this.regressionCount = 0;

      // Check convergence
      if (Math.abs(delta) < this.policy.convergenceThreshold) {
        this.convergenceCount++;
        if (this.convergenceCount >= this.policy.convergenceRounds) {
          this.bestScore = candidate.score;
          this.bestVariantId = candidate.variantId;
          this.log(`  [state] Converged after ${this.convergenceCount} rounds (delta=${delta.toFixed(2)})`);
          this.transition(STATES.ACCEPT);
          return STATES.ACCEPT;
        }
      } else {
        this.convergenceCount = 0;
      }

      // Update best and continue refining
      this.bestScore = candidate.score;
      this.bestVariantId = candidate.variantId;
      this.transition(STATES.REFINE);
      return STATES.REFINE;
    } else {
      // Regression
      this.regressionCount++;
      this.convergenceCount = 0;

      if (this.regressionCount >= this.policy.maxRegressions) {
        // Check for oscillation pattern
        if (this._detectOscillation()) {
          this.transition(STATES.OSCILLATION_DETECTED);
          return STATES.OSCILLATION_DETECTED;
        }
        // No clear oscillation, just stalled — accept best
        this.transition(STATES.ACCEPT);
        return STATES.ACCEPT;
      }

      // Continue refining with different parameters
      this.transition(STATES.REFINE);
      return STATES.REFINE;
    }
  }

  /**
   * Detect oscillation: parameter bouncing between two values.
   * Pattern: A, B, A, B across last 4 iterations.
   */
  _detectOscillation() {
    if (this.history.length < 4) return false;
    const last4 = this.history.slice(-4);
    const scores = last4.map(h => h.score);

    // Check if scores alternate: high-low-high-low or low-high-low-high
    const d01 = scores[1] - scores[0];
    const d12 = scores[2] - scores[1];
    const d23 = scores[3] - scores[2];

    // Alternating signs = oscillation
    if ((d01 > 0 && d12 < 0 && d23 > 0) || (d01 < 0 && d12 > 0 && d23 < 0)) {
      this.log(`  [state] Oscillation detected: scores=${scores.map(s => s.toFixed(1)).join(', ')}`);
      return true;
    }
    return false;
  }

  /**
   * Get the oscillating parameter to lock.
   * Returns { param, lockValue } or null.
   */
  getOscillatingParam() {
    if (this.history.length < 4) return null;
    const last4 = this.history.slice(-4);

    // Find parameters that changed and check for A-B-A-B pattern
    const allParams = new Set();
    for (const h of last4) {
      for (const k of Object.keys(h.params || {})) allParams.add(k);
    }

    for (const param of allParams) {
      const values = last4.map(h => {
        const p = h.params || {};
        // Handle nested params (e.g., "lhe.amount")
        const parts = param.split('.');
        let val = p;
        for (const part of parts) val = val?.[part];
        return val;
      });

      // Check A-B-A-B pattern (with tolerance)
      if (values[0] !== undefined && values[1] !== undefined) {
        const isOscillating =
          Math.abs(values[0] - values[2]) < 0.001 * Math.abs(values[0] || 1) &&
          Math.abs(values[1] - values[3]) < 0.001 * Math.abs(values[1] || 1) &&
          Math.abs(values[0] - values[1]) > 0.001;

        if (isOscillating) {
          const lockValue = (values[2] + values[3]) / 2;
          return { param, lockValue, values };
        }
      }
    }
    return null;
  }

  /**
   * Get summary of current state for logging.
   */
  summary() {
    return {
      agent: this.agentName,
      state: this.state,
      iterations: this.iterationCount,
      bestScore: this.bestScore,
      bestVariantId: this.bestVariantId,
      regressions: this.regressionCount,
      convergenceCount: this.convergenceCount,
      elapsedMs: Date.now() - this.startTime
    };
  }
}

/**
 * Generate parameter combinations from a search space definition.
 * @param {Array} searchSpace - [{ name, coarseGrid, ... }]
 * @param {number} maxCandidates - Maximum number of combinations
 * @returns {Array} Array of parameter objects
 */
export function generateCoarseCandidates(searchSpace, maxCandidates = 4) {
  // Build all combinations from coarse grids
  const grids = searchSpace.map(p => ({
    name: p.name,
    values: p.coarseGrid || [p.default]
  }));

  let combinations = [{}];
  for (const grid of grids) {
    const newCombinations = [];
    for (const combo of combinations) {
      for (const val of grid.values) {
        newCombinations.push({ ...combo, [grid.name]: val });
      }
    }
    combinations = newCombinations;
  }

  // If too many, sample evenly
  if (combinations.length > maxCandidates) {
    const step = Math.floor(combinations.length / maxCandidates);
    const sampled = [];
    for (let i = 0; i < combinations.length && sampled.length < maxCandidates; i += step) {
      sampled.push(combinations[i]);
    }
    return sampled;
  }
  return combinations;
}

/**
 * Generate refinement candidates around the best parameters.
 * Uses bisection for continuous params, exhaustive for discrete.
 * @param {object} bestParams - Current best parameter values
 * @param {Array} searchSpace - Search space definitions
 * @param {number} maxCandidates - Maximum refinement candidates
 * @returns {Array} Array of refined parameter objects
 */
export function generateRefinementCandidates(bestParams, searchSpace, maxCandidates = 3) {
  const candidates = [];

  for (const param of searchSpace) {
    if (param.refinementMethod === 'none') continue;
    const currentVal = bestParams[param.name];
    if (currentVal === undefined) continue;

    if (param.type === 'float' && param.refinementMethod === 'bisection') {
      // Try value slightly above and below current best
      const range = (param.range[1] - param.range[0]);
      const delta = range * 0.15; // 15% of range
      const lower = Math.max(param.range[0], currentVal - delta);
      const upper = Math.min(param.range[1], currentVal + delta);

      if (lower !== currentVal) {
        candidates.push({ ...bestParams, [param.name]: lower });
      }
      if (upper !== currentVal) {
        candidates.push({ ...bestParams, [param.name]: upper });
      }
    } else if (param.type === 'integer') {
      const step = param.refinementMethod?.startsWith('step_search_')
        ? parseInt(param.refinementMethod.split('_')[2]) || 1
        : 1;
      if (currentVal - step >= param.range[0]) {
        candidates.push({ ...bestParams, [param.name]: currentVal - step });
      }
      if (currentVal + step <= param.range[1]) {
        candidates.push({ ...bestParams, [param.name]: currentVal + step });
      }
    } else if (param.type === 'enum' || param.type === 'boolean') {
      // Try other values not yet tested
      const allValues = param.type === 'boolean' ? [true, false] : (param.values || param.coarseGrid);
      for (const val of allValues) {
        if (val !== currentVal) {
          candidates.push({ ...bestParams, [param.name]: val });
        }
      }
    }
  }

  // Deduplicate and limit
  const seen = new Set();
  const unique = candidates.filter(c => {
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.slice(0, maxCandidates);
}
