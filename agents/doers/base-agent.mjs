// ============================================================================
// Base agent: abstract class for all doer agents
// Implements the iteration state machine and parameter search loop.
// ============================================================================
import { IterationStateMachine, STATES, generateCoarseCandidates, generateRefinementCandidates } from '../state-machine.mjs';
import { TechnicalQACritic } from '../critics/technical-qa.mjs';
import { BenchmarkCritic } from '../critics/benchmark.mjs';
import { getStats } from '../ops/stats.mjs';
import { measureUniformity } from '../ops/stats.mjs';
import { purgeUndoHistory } from '../ops/image-mgmt.mjs';

export class BaseAgent {
  /**
   * @param {string} name - Agent name (e.g. 'luminance_detail')
   * @param {object} store - ArtifactStore instance
   * @param {object} brief - Processing brief
   */
  constructor(name, store, brief) {
    this.name = name;
    this.store = store;
    this.brief = brief;
    this.targetClass = brief?.target?.classification || 'mixed_field';
    this.techCritic = new TechnicalQACritic(brief);
    this.benchCritic = new BenchmarkCritic(this.targetClass);
  }

  /**
   * Define the search space for this agent.
   * Override in subclasses.
   * @returns {Array} Search space definitions
   */
  getSearchSpace() {
    throw new Error('Subclass must implement getSearchSpace()');
  }

  /**
   * Execute a single variant with the given parameters.
   * Override in subclasses.
   * @param {object} ctx - Bridge context
   * @param {object} params - Parameter values
   * @param {object} input - Input artifact metadata
   * @returns {string} viewId of the result
   */
  async executeVariant(ctx, params, input) {
    throw new Error('Subclass must implement executeVariant()');
  }

  /**
   * Prepare for a new variant (restore checkpoint, etc.).
   * Override if needed.
   */
  async prepareVariant(ctx, input) {
    // Default: load the input artifact
    if (input.artifactId) {
      await this.store.loadVariant(ctx, input.artifactId);
    }
  }

  /**
   * Run the full optimization loop.
   * @param {object} ctx - Bridge context
   * @param {object} input - Input artifact: { artifactId, viewId }
   * @param {object} policy - Override policy settings
   * @returns {object} { winnerId, winnerScore, scorecards, summary }
   */
  async run(ctx, input, policy = {}) {
    const sm = new IterationStateMachine(this.name, {
      ...policy,
      maxIterations: this.brief?.hardConstraints?.maxIterationsPerAgent ?? 8,
      maxWallClockMs: (this.brief?.hardConstraints?.maxWallClockMinutes ?? 60) * 60000
    });
    sm.log = ctx.log;

    const searchSpace = this.getSearchSpace();
    let currentBestScorecard = null;
    const allScorecards = [];

    // Start the state machine
    sm.transition(STATES.EXPLORE);

    while (sm.state !== STATES.DONE && sm.state !== STATES.ACCEPT && sm.state !== STATES.ESCALATE) {
      let candidates;

      // Generate candidates based on current state
      if (sm.state === STATES.EXPLORE || sm.state === STATES.EXPLORE_ALT) {
        candidates = generateCoarseCandidates(searchSpace, sm.policy.coarseCandidates);
        ctx.log(`\n  [${this.name}] EXPLORE: generating ${candidates.length} coarse candidates`);
      } else if (sm.state === STATES.REFINE) {
        const bestParams = sm.history.length > 0
          ? sm.history[sm.history.length - 1].params
          : {};
        candidates = generateRefinementCandidates(bestParams, searchSpace, sm.policy.refineCandidates);
        ctx.log(`\n  [${this.name}] REFINE: generating ${candidates.length} refinement candidates`);
      } else {
        break;
      }

      if (candidates.length === 0) {
        ctx.log(`  [${this.name}] No candidates to evaluate. Accepting current best.`);
        sm.transition(STATES.ACCEPT);
        break;
      }

      // Evaluate each candidate
      const evaluated = [];
      for (let i = 0; i < candidates.length; i++) {
        const params = candidates[i];
        ctx.log(`\n  [${this.name}] Variant ${i + 1}/${candidates.length}: ${JSON.stringify(params).slice(0, 120)}...`);

        try {
          // Prepare (restore checkpoint)
          await this.prepareVariant(ctx, input);

          // Execute variant
          const viewId = await this.executeVariant(ctx, params, input);

          // Collect metrics
          const stats = await getStats(ctx, viewId);
          const uniformity = await measureUniformity(ctx, viewId);

          // Save artifact
          const artifact = await this.store.saveVariant(ctx, this.name, viewId, params, stats);

          // Score with technical critic
          const scorecard = this.techCritic.evaluate({
            artifactId: artifact.artifactId,
            metrics: stats,
            uniformity
          });

          ctx.log(`    Score: ${scorecard.aggregate.toFixed(1)} (pass=${scorecard.pass})`);
          allScorecards.push(scorecard);

          evaluated.push({
            variantId: artifact.metadata.variantId,
            artifactId: artifact.artifactId,
            params,
            score: scorecard.aggregate,
            scorecard
          });

          // Record in state machine
          sm.recordEvaluation(artifact.artifactId, params, scorecard.aggregate);

          // Purge undo history to manage memory
          await purgeUndoHistory(ctx, viewId);

        } catch (err) {
          ctx.log(`    ERROR: ${err.message}`);
        }

        // Check budget
        if (sm.budgetExhausted()) {
          ctx.log(`  [${this.name}] Budget exhausted during evaluation`);
          break;
        }
      }

      // Sort by score
      evaluated.sort((a, b) => b.score - a.score);

      if (evaluated.length === 0) {
        sm.transition(STATES.ESCALATE);
        break;
      }

      // Benchmark against current best
      if (currentBestScorecard) {
        const verdict = this.benchCritic.compare(currentBestScorecard, evaluated[0].scorecard);
        ctx.log(`  [${this.name}] Benchmark: ${verdict.verdict.action} (net=${verdict.netImprovement.toFixed(2)})`);

        if (verdict.verdict.action === 'replace_best') {
          currentBestScorecard = evaluated[0].scorecard;
          this.store.promoteWinner(this.name, evaluated[0].variantId, evaluated[0].score);
        }
      } else {
        currentBestScorecard = evaluated[0].scorecard;
        this.store.promoteWinner(this.name, evaluated[0].variantId, evaluated[0].score);
      }

      // Save scorecards
      this.store.saveScorecard(this.name, 'technical_qa', allScorecards);

      // Decide next state
      const nextState = sm.decide(evaluated);
      ctx.log(`  [${this.name}] State: ${sm.state} (best=${sm.bestScore?.toFixed(1)})`);

      // Handle oscillation
      if (sm.state === STATES.OSCILLATION_DETECTED) {
        const osc = sm.getOscillatingParam();
        if (osc) {
          ctx.log(`  [${this.name}] Oscillation on ${osc.param} — locking at ${osc.lockValue}`);
          // Lock the oscillating parameter by modifying search space
          const sp = searchSpace.find(s => s.name === osc.param);
          if (sp) {
            sp.coarseGrid = [osc.lockValue];
            sp.refinementMethod = 'none';
          }
        }
        sm.decide(evaluated); // re-decide after handling oscillation
      }
    }

    // Persist state machine
    const stateDir = this.store.agentDir(this.name);
    sm.save(`${stateDir}/state.json`);

    const winner = this.store.getWinner(this.name);
    const summary = sm.summary();

    ctx.log(`\n  [${this.name}] DONE: ${sm.state} — best=${summary.bestScore?.toFixed(1)}, iterations=${summary.iterations}`);

    return {
      winnerId: sm.bestVariantId,
      winnerScore: sm.bestScore,
      winnerMetadata: winner,
      scorecards: allScorecards,
      summary
    };
  }
}
