// ============================================================================
// Luminance Detail Agent
// Owns: LHE (local contrast), HDRMT, NXT final, curves
// Goal: maximize genuine detail and structure while avoiding artifacts
// ============================================================================
import { BaseAgent } from './base-agent.mjs';
import { createLumMask, applyMask, removeMask, closeMask } from '../ops/masks.mjs';
import { purgeUndoHistory } from '../ops/image-mgmt.mjs';

export class LuminanceDetailAgent extends BaseAgent {
  constructor(store, brief) {
    super('luminance_detail', store, brief);
  }

  getSearchSpace() {
    const isGalaxy = this.targetClass.startsWith('galaxy');
    return [
      {
        name: 'lhe_amount',
        type: 'float',
        range: [0.10, 0.50],
        coarseGrid: isGalaxy ? [0.15, 0.25, 0.35] : [0.20, 0.35, 0.50],
        refinementMethod: 'bisection',
        default: 0.25
      },
      {
        name: 'lhe_radius',
        type: 'integer',
        range: [24, 128],
        coarseGrid: [32, 64, 96],
        refinementMethod: 'step_search_16',
        default: 64
      },
      {
        name: 'lhe_slopeLimit',
        type: 'float',
        range: [1.1, 2.5],
        coarseGrid: [1.3, 1.5, 2.0],
        refinementMethod: 'bisection',
        default: 1.5
      },
      {
        name: 'lhe_maskClipLow',
        type: 'float',
        range: [0.03, 0.20],
        coarseGrid: isGalaxy ? [0.08, 0.12, 0.15] : [0.04, 0.08, 0.12],
        refinementMethod: 'bisection',
        default: isGalaxy ? 0.10 : 0.06
      },
      {
        name: 'lhe_maskBlur',
        type: 'float',
        range: [2, 15],
        coarseGrid: isGalaxy ? [3, 6, 10] : [5, 10, 15],
        refinementMethod: 'bisection',
        default: isGalaxy ? 6 : 10
      },
      {
        name: 'hdrmt_enabled',
        type: 'boolean',
        coarseGrid: isGalaxy ? [true, false] : [false],
        refinementMethod: 'exhaustive',
        default: isGalaxy
      },
      {
        name: 'hdrmt_layers',
        type: 'integer',
        range: [4, 8],
        coarseGrid: [5, 6, 7],
        refinementMethod: 'exhaustive',
        default: 6
      },
      {
        name: 'hdrmt_inverted',
        type: 'boolean',
        coarseGrid: [true, false],
        refinementMethod: 'exhaustive',
        default: true
      },
      {
        name: 'nxt_final_denoise',
        type: 'float',
        range: [0.15, 0.40],
        coarseGrid: [0.20, 0.30],
        refinementMethod: 'bisection',
        default: 0.25
      }
    ];
  }

  async executeVariant(ctx, params, input) {
    const viewId = input.viewId;

    // --- LHE (Local Histogram Equalization) with luminance mask ---
    const maskId = await createLumMask(
      ctx, viewId, 'mask_lhe_agent',
      params.lhe_maskBlur, params.lhe_maskClipLow, 2.0
    );

    if (maskId) {
      await applyMask(ctx, viewId, maskId);
      await ctx.pjsr(`
        var P = new LocalHistogramEqualization;
        P.radius = ${params.lhe_radius};
        P.histogramBins = LocalHistogramEqualization.prototype.Bit12;
        P.slopeLimit = ${params.lhe_slopeLimit};
        P.amount = ${params.lhe_amount};
        P.circularKernel = true;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
      await removeMask(ctx, viewId);
      await closeMask(ctx, maskId);
    }

    // --- HDRMT (optional) ---
    if (params.hdrmt_enabled) {
      // Create tighter mask for HDRMT (higher clipLow to protect cores)
      const hdrmtMaskClip = Math.max(params.lhe_maskClipLow + 0.15, 0.25);
      const hdrmtMaskId = await createLumMask(
        ctx, viewId, 'mask_hdrmt_agent',
        params.lhe_maskBlur, hdrmtMaskClip, 2.0
      );

      if (hdrmtMaskId) {
        await applyMask(ctx, viewId, hdrmtMaskId);
      }

      await ctx.pjsr(`
        var P = new HDRMultiscaleTransform;
        P.numberOfLayers = ${params.hdrmt_layers};
        P.numberOfIterations = 1;
        P.invertedIterations = ${params.hdrmt_inverted};
        P.overdrive = 0;
        P.scalingFunctionData = [
          0.003906,0.015625,0.023438,0.015625,0.003906,
          0.015625,0.0625,0.09375,0.0625,0.015625,
          0.023438,0.09375,0.140625,0.09375,0.023438,
          0.015625,0.0625,0.09375,0.0625,0.015625,
          0.003906,0.015625,0.023438,0.015625,0.003906
        ];
        P.scalingFunctionRowFilter = [0.0625,0.25,0.375,0.25,0.0625];
        P.scalingFunctionColFilter = [0.0625,0.25,0.375,0.25,0.0625];
        P.scalingFunctionNoiseLayers = 0;
        P.scalingFunctionName = "B3 Spline (5)";
        P.largeScaleFunction = HDRMultiscaleTransform.prototype.MultiscaleMedianTransform;
        P.curveBreakPoint = 0.75;
        P.noiseReduction = true;
        P.deringing = true;
        P.toLightness = true;
        P.preserveHue = true;
        P.luminanceMask = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);

      if (hdrmtMaskId) {
        await removeMask(ctx, viewId);
        await closeMask(ctx, hdrmtMaskId);
      }
    }

    // --- NXT final (light denoise after detail enhancement) ---
    await ctx.pjsr(`
      var P = new NoiseXTerminator;
      P.denoise = ${params.nxt_final_denoise};
      P.detail = 0.15;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);

    await purgeUndoHistory(ctx, viewId);
    return viewId;
  }
}
