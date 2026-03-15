// ============================================================================
// Composition Agent
// Owns: LRGB combine, star addition, final curves
// Goal: merge optimized products into coherent full-image candidates
// ============================================================================
import { BaseAgent } from './base-agent.mjs';
import { purgeUndoHistory } from '../ops/image-mgmt.mjs';

export class CompositionAgent extends BaseAgent {
  constructor(store, brief) {
    super('composition', store, brief);
  }

  getSearchSpace() {
    const isGalaxy = this.targetClass.startsWith('galaxy');
    return [
      {
        name: 'lrgb_lightness',
        type: 'float',
        range: [0.20, 0.80],
        coarseGrid: [0.35, 0.55, 0.75],
        refinementMethod: 'bisection',
        default: 0.55
      },
      {
        name: 'star_strength',
        type: 'float',
        range: [0.50, 1.20],
        coarseGrid: isGalaxy ? [0.70, 0.85, 1.00] : [0.80, 1.00, 1.10],
        refinementMethod: 'bisection',
        default: isGalaxy ? 0.85 : 1.00
      },
      {
        name: 'star_screenBlend',
        type: 'boolean',
        coarseGrid: isGalaxy ? [true] : [true, false],
        refinementMethod: 'exhaustive',
        default: true
      },
      {
        name: 'curves_mode',
        type: 'enum',
        values: ['conservative', 'balanced', 'assertive'],
        coarseGrid: ['conservative', 'balanced', 'assertive'],
        refinementMethod: 'exhaustive',
        default: 'balanced'
      },
      {
        name: 'saturation_boost',
        type: 'float',
        range: [0.0, 0.30],
        coarseGrid: isGalaxy ? [0.05, 0.10, 0.15] : [0.10, 0.20, 0.30],
        refinementMethod: 'bisection',
        default: 0.10
      }
    ];
  }

  async executeVariant(ctx, params, input) {
    const viewId = input.viewId;
    const starsId = input.starsViewId;

    // --- Final curves ---
    const curvePresets = {
      conservative: {
        contrast: [[0, 0], [0.10, 0.08], [0.50, 0.52], [0.90, 0.93], [1, 1]],
        saturation: [[0, 0], [0.50, 0.55], [1, 1]]
      },
      balanced: {
        contrast: [[0, 0], [0.10, 0.06], [0.50, 0.55], [0.90, 0.95], [1, 1]],
        saturation: [[0, 0], [0.50, 0.62], [1, 1]]
      },
      assertive: {
        contrast: [[0, 0], [0.08, 0.04], [0.50, 0.58], [0.90, 0.96], [1, 1]],
        saturation: [[0, 0], [0.45, 0.65], [1, 1]]
      }
    };

    const curves = curvePresets[params.curves_mode] || curvePresets.balanced;

    // Apply contrast curve (lightness channel)
    const contrastPts = curves.contrast.map(p => `[${p[0]},${p[1]}]`).join(',');
    await ctx.pjsr(`
      var P = new CurvesTransformation;
      P.L = [${contrastPts}];
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);

    // Apply saturation curve
    const satPts = curves.saturation.map(p => `[${p[0]},${p[1]}]`).join(',');
    await ctx.pjsr(`
      var P = new CurvesTransformation;
      P.St = [${satPts}];
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);

    // --- Additional saturation boost if requested ---
    if (params.saturation_boost > 0.01) {
      const boost = params.saturation_boost;
      const satBoostPts = `[0,0],[0.50,${(0.50 + boost).toFixed(3)}],[1,1]`;
      await ctx.pjsr(`
        var P = new CurvesTransformation;
        P.St = [${satBoostPts}];
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
    }

    // --- Star addition (if stars are available) ---
    if (starsId) {
      const strength = params.star_strength;
      if (params.star_screenBlend) {
        // Screen blend: 1 - (1-A)*(1-B*strength)
        await ctx.pjsr(`
          var P = new PixelMath;
          P.expression = '1-(1-${viewId})*(1-${strength}*${starsId})';
          P.useSingleExpression = true;
          P.createNewImage = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(ImageWindow.windowById('${viewId}').mainView);
        `);
      } else {
        // Additive blend
        await ctx.pjsr(`
          var P = new PixelMath;
          P.expression = 'min(1, ${viewId} + ${strength}*${starsId})';
          P.useSingleExpression = true;
          P.createNewImage = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(ImageWindow.windowById('${viewId}').mainView);
        `);
      }
    }

    await purgeUndoHistory(ctx, viewId);
    return viewId;
  }
}
