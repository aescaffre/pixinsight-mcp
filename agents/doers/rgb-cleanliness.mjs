// ============================================================================
// RGB Cleanliness Agent
// Owns: gradient correction, BXT, SPCC, SCNR, NXT linear, SXT, stretch, NXT post
// Goal: produce a clean, balanced, stretched RGB master
// ============================================================================
import { BaseAgent } from './base-agent.mjs';
import { runGC, runABE } from '../ops/gradient.mjs';
import { cloneImage, restoreFromClone, closeImage, purgeUndoHistory } from '../ops/image-mgmt.mjs';
import { measureUniformity } from '../ops/stats.mjs';
import { savePreview } from '../ops/preview.mjs';

export class RGBCleanlinessAgent extends BaseAgent {
  constructor(store, brief) {
    super('rgb_cleanliness', store, brief);
  }

  getSearchSpace() {
    const isGalaxy = this.targetClass.startsWith('galaxy');
    return [
      {
        name: 'gc_method',
        type: 'enum',
        values: ['gc', 'abe_deg2', 'abe_deg3', 'auto'],
        coarseGrid: ['auto'],
        refinementMethod: 'exhaustive',
        default: 'auto'
      },
      {
        name: 'bxt_sharpenNonstellar',
        type: 'float',
        range: [0.25, 1.0],
        coarseGrid: [0.50, 0.75],
        refinementMethod: 'bisection',
        default: 0.75
      },
      {
        name: 'nxt_denoise',
        type: 'float',
        range: [0.10, 0.40],
        coarseGrid: [0.15, 0.25, 0.35],
        refinementMethod: 'bisection',
        default: 0.25
      },
      {
        name: 'stretch_targetBg',
        type: 'float',
        range: isGalaxy ? [0.05, 0.15] : [0.12, 0.25],
        coarseGrid: isGalaxy ? [0.08, 0.10, 0.12] : [0.15, 0.20, 0.25],
        refinementMethod: 'bisection',
        default: isGalaxy ? 0.12 : 0.20
      },
      {
        name: 'stretch_headroom',
        type: 'float',
        range: [0.0, 0.10],
        coarseGrid: [0.0, 0.05],
        refinementMethod: 'bisection',
        default: 0.05
      }
    ];
  }

  async executeVariant(ctx, params, input) {
    const viewId = input.viewId;

    // --- Gradient removal ---
    if (params.gc_method === 'auto') {
      // A/B test GC vs ABE (same pattern as existing pipeline Phase 2)
      await cloneImage(ctx, viewId, viewId + '_gc_test');

      // Try GC
      await cloneImage(ctx, viewId, viewId + '_try_gc');
      await runGC(ctx, viewId + '_try_gc');
      const uGC = await measureUniformity(ctx, viewId + '_try_gc');

      // Try ABE deg2
      await restoreFromClone(ctx, viewId + '_try_gc', viewId + '_gc_test');
      // Reuse _try_gc window for ABE
      await runABE(ctx, viewId + '_try_gc', { polyDegree: 2 });
      const uABE2 = await measureUniformity(ctx, viewId + '_try_gc');

      // Pick winner
      if (uGC.score < uABE2.score) {
        ctx.log(`    GC wins (${uGC.score.toFixed(6)} < ${uABE2.score.toFixed(6)})`);
        await restoreFromClone(ctx, viewId, viewId + '_gc_test');
        await runGC(ctx, viewId);
      } else {
        ctx.log(`    ABE deg2 wins (${uABE2.score.toFixed(6)} < ${uGC.score.toFixed(6)})`);
        await runABE(ctx, viewId, { polyDegree: 2 });
      }

      await closeImage(ctx, viewId + '_gc_test');
      await closeImage(ctx, viewId + '_try_gc');
    } else if (params.gc_method === 'gc') {
      await runGC(ctx, viewId);
    } else if (params.gc_method.startsWith('abe')) {
      const deg = parseInt(params.gc_method.split('_deg')[1]) || 3;
      await runABE(ctx, viewId, { polyDegree: deg });
    }

    // --- BXT correct only ---
    await ctx.pjsr(`
      var P = new BlurXTerminator;
      P.correct_only = true;
      P.sharpen_stars = 0.50;
      P.sharpen_nonstellar = ${params.bxt_sharpenNonstellar};
      P.adjust_star_halos = 0.00;
      P.auto_nonstellar_psf = true;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);

    // --- NXT pass 1 (linear) ---
    await ctx.pjsr(`
      var P = new NoiseXTerminator;
      P.denoise = ${params.nxt_denoise};
      P.detail = 0.15;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);

    // --- Seti stretch ---
    // Import dynamically to avoid circular deps at module level
    const { setiStretch } = await import('../ops/stretch.mjs');
    await setiStretch(ctx, viewId, {
      targetMedian: params.stretch_targetBg,
      hdrCompress: true,
      hdrAmount: 0.25,
      hdrKnee: 0.35,
      hdrHeadroom: params.stretch_headroom
    });

    // --- NXT pass 2 (post-stretch, slightly stronger) ---
    await ctx.pjsr(`
      var P = new NoiseXTerminator;
      P.denoise = ${Math.min(params.nxt_denoise + 0.10, 0.50)};
      P.detail = 0.15;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);

    await purgeUndoHistory(ctx, viewId);
    return viewId;
  }
}
