// ============================================================================
// Tool definitions and handlers: maps ops library to Claude API tool_use
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getStats, measureUniformity, measureColorGradient,
  savePreview, autoStretch,
  cloneImage, restoreFromClone, closeImage, purgeUndoHistory,
  runGC, runABE, runPerChannelABE, runSCNR,
  setiStretch,
  createLumMask, applyMask, removeMask, closeMask,
  checkStarQuality, checkRinging, checkSharpness, checkCoreBurning, scanBurntRegions, checkSaturation, checkTonalPresence, checkStarLayerIntegrity, checkBrightChroma, checkHighlightTexture,
  measureSubjectDetail, locateSubjectROI, measureCoreContrast, measureBackgroundNoise, measureDustCoverage, compareToReference,
  multiScaleEnhance, shellDetailEnhance,
  extractPseudoOIII, continuumSubtractHa, dynamicNarrowbandBlend, createSyntheticLuminance, createZoneMasks, createAdaptiveZoneMasks, continuousClamp,
} from '../ops/index.mjs';
import { checkHardConstraints, statsToScores, computeAggregate } from '../scoring.mjs';
import { jpegToContentBlock } from './vision.mjs';
import { critiqueAesthetic } from './aesthetic-critic.mjs';
import { getChampions, recordChampions, scoreVariantDimensions } from '../ledger.mjs';

// ============================================================================
// Helpers
// ============================================================================

/** Format stats with burn warning if max > 0.90 */
function statsLine(stats, label = 'Stats') {
  const med = stats.median?.toFixed(6) ?? '?';
  const max = (stats.max ?? 0).toFixed(4);
  let warn = '';
  if (stats.max > 0.95) warn = ' ⚠️ CLIPPING: max=' + max + ' — actual pixel clipping. Reduce stretch/curves or apply continuous_clamp.';
  else if (stats.max > 0.80) warn = ' ⚡ BRIGHT: max=' + max + ' — core may look bright. Check visually: if internal structure is visible, this is OK. If featureless, apply continuous_clamp.';
  return `${label}: median=${med}, max=${max}${warn}`;
}

// ============================================================================
// Tool definition catalog
// ============================================================================

const TOOL_CATALOG = {

  // --- Measurement ---
  get_image_stats: {
    category: 'measurement',
    definition: {
      name: 'get_image_stats',
      description: 'Get image statistics: median, MAD, min, max, per-channel medians. Use this to understand the current state of the image before and after operations.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: JSON.stringify(stats, null, 2) };
    }
  },

  compare_to_reference: {
    category: 'measurement',
    definition: {
      name: 'compare_to_reference',
      description: 'Compare a view against a user-supplied reference image. Returns color_emd (CIELAB earth-mover distance on histogram-matched background cells; lower=closer color, >0.25 = strong divergence), ms_ssim (multiscale luminance structure similarity 0..1, only valid when geometry matches), and coverage_delta (reference faint-signal fraction minus yours; >0.30 = reference shows substantially MORE faint nebulosity/IFN, i.e. you are under-stretched or over-denoised). Use to steer toward the reference palette and faint-structure depth.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View to evaluate.' },
          reference_path: { type: 'string', description: 'Absolute path to reference image (XISF/TIFF/PNG). If omitted, uses brief.reference_path.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, store, brief, input) => {
      const refPath = (input.reference_path || brief?.reference_path || '').trim();
      if (!refPath) return { type: 'text', text: 'compare_to_reference: no reference_path provided and brief.reference_path is unset.' };
      if (!fs.existsSync(refPath)) return { type: 'text', text: `compare_to_reference: reference file not found: ${refPath}` };
      const res = await compareToReference(ctx, input.view_id, refPath);
      if (res.error) return { type: 'text', text: `compare_to_reference: ${res.error}` };
      return { type: 'text', text: `Reference comparison: ${res.details}` };
    }
  },

  measure_uniformity: {
    category: 'measurement',
    definition: {
      name: 'measure_uniformity',
      description: 'Measure background uniformity via 4-corner median stddev. Lower score = more uniform. Score < 0.002 is excellent, > 0.005 is problematic.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' },
          sample_size: { type: 'integer', description: 'Corner sample size in pixels (default 200)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const uni = await measureUniformity(ctx, input.view_id, input.sample_size || 200);
      return { type: 'text', text: JSON.stringify(uni, null, 2) };
    }
  },

  measure_color_gradient: {
    category: 'measurement',
    definition: {
      name: 'measure_color_gradient',
      description: 'Measure the residual COLOR gradient across the background — what measure_uniformity (a single luminance number over 4 corners) misses. Grids the whole frame, rejects subject cells (galaxies/bright stars), and reports the chrominance peak-to-peak across background cells plus the worst cell\'s location and dominant cast. Use this to drive gradient-correction scale: correct, re-measure, adjust scale until flat — but watch faint signal (measure_subject_detail) so you do not over-correct. On LINEAR data set linear=true so it measures on a temporary STF-stretched clone (chrominance is invisible on un-stretched linear data). Verdict thresholds (stretched units): score < 0.008 = FLAT (pass), 0.008-0.015 = MILD, > 0.015 = VISIBLE COLOR GRADIENT (keep correcting).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' },
          linear: { type: 'boolean', description: 'Set true if the image is still linear (un-stretched). Measures on a temporary auto-stretched clone so the metric is meaningful. Default false.' },
          cols: { type: 'integer', description: 'Grid columns (default 8)' },
          rows: { type: 'integer', description: 'Grid rows (default 6)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      let measureId = input.view_id;
      const tempId = '__cg_eval';
      let cg;
      try {
        if (input.linear) {
          // Chrominance is invisible on un-stretched linear data — measure on an STF-stretched clone.
          // Close any leftover temp from a prior call that errored before cleanup (avoids id collision).
          await closeImage(ctx, tempId).catch(() => {});
          await cloneImage(ctx, input.view_id, tempId);
          await autoStretch(ctx, tempId, 0.10);
          measureId = tempId;
        }
        cg = await measureColorGradient(ctx, measureId, { cols: input.cols, rows: input.rows });
      } finally {
        if (input.linear) await closeImage(ctx, tempId).catch(() => {});
      }
      if (!cg || typeof cg.score !== 'number') {
        return { type: 'text', text: `[COLOR GRADIENT: measurement failed] ${cg?.error || 'no result'} — retry, or check the view is open.` };
      }
      const s = cg.score ?? 999;
      const verdict = s < 0.008 ? 'FLAT (pass)' : s <= 0.015 ? 'MILD — optional further correction' : 'VISIBLE COLOR GRADIENT — keep correcting';
      const w = cg.worst ? ` Worst cell (grid ${cg.worst.gx},${cg.worst.gy}): ${cg.worst.dominant} cast, amp=${cg.worst.amp?.toFixed(4)}.` : '';
      const text = `[COLOR GRADIENT: ${verdict}] score=${s.toFixed(4)} (chroma peak-to-peak across ${cg.bgCells}/${cg.totalCells} background cells).${w}\n` +
        `  Per-channel chroma PP: R=${cg.chromaPP?.R?.toFixed(4)} G=${cg.chromaPP?.G?.toFixed(4)} B=${cg.chromaPP?.B?.toFixed(4)} | lum PP=${cg.lumPP?.toFixed(4)}\n` +
        JSON.stringify(cg);
      return { type: 'text', text };
    }
  },

  list_open_images: {
    category: 'measurement',
    definition: {
      name: 'list_open_images',
      description: 'List all currently open images in PixInsight with their dimensions and color status.',
      input_schema: { type: 'object', properties: {} }
    },
    handler: async (ctx, _store, _brief, _input) => {
      const imgs = await ctx.listImages();
      return { type: 'text', text: JSON.stringify(imgs, null, 2) };
    }
  },

  compute_scores: {
    category: 'measurement',
    definition: {
      name: 'compute_scores',
      description: 'Compute quality scores (0-100 per dimension) and weighted aggregate from current image stats. Also checks hard constraints.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const stats = await getStats(ctx, input.view_id);
      const uni = await measureUniformity(ctx, input.view_id);
      const constraints = checkHardConstraints(stats, brief);
      const scores = statsToScores(stats, uni, brief);
      const agg = computeAggregate(scores, brief?.target?.classification);
      return {
        type: 'text',
        text: JSON.stringify({ constraints, scores, aggregate: agg.aggregate, stats, uniformity: uni }, null, 2)
      };
    }
  },

  check_constraints: {
    category: 'measurement',
    definition: {
      name: 'check_constraints',
      description: 'Check hard constraints only (clipping, black crush, background range, channel balance). Returns pass/fail with violation details.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const stats = await getStats(ctx, input.view_id);
      const result = checkHardConstraints(stats, brief);
      return { type: 'text', text: JSON.stringify({ ...result, stats }, null, 2) };
    }
  },

  // --- Preview ---
  save_and_show_preview: {
    category: 'preview',
    definition: {
      name: 'save_and_show_preview',
      description: 'Save a JPEG preview and return it as an image so you can see the current state. Always use this after significant operations to visually assess the result.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'PixInsight view ID' },
          label: { type: 'string', description: 'Short label for this preview (e.g. "after_stretch", "final")' }
        },
        required: ['view_id', 'label']
      }
    },
    handler: async (ctx, store, _brief, input) => {
      const previewDir = path.join(store.baseDir, 'previews');
      fs.mkdirSync(previewDir, { recursive: true });
      const previewPath = path.join(previewDir, `${input.label}.jpg`);

      await ctx.pjsr(`
        var srcW = ImageWindow.windowById('${input.view_id}');
        if (srcW.isNull) throw new Error('View not found: ${input.view_id}');
        var img = srcW.mainView.image;
        var w = img.width, h = img.height;
        var scale = Math.min(1, 2048 / Math.max(w, h));
        var nw = Math.round(w * scale), nh = Math.round(h * scale);
        var tmp = new ImageWindow(nw, nh, img.numberOfChannels, 32, false, img.isColor, 'preview_show_tmp');
        tmp.mainView.beginProcess();
        tmp.mainView.image.assign(img);
        tmp.mainView.endProcess();
        if (scale < 1) {
          var R = new Resample;
          R.mode = Resample.prototype.RelativeDimensions;
          R.xSize = scale; R.ySize = scale;
          R.absoluteMode = Resample.prototype.ForceWidthAndHeight;
          R.interpolation = Resample.prototype.MitchellNetravaliFilter;
          R.executeOn(tmp.mainView);
        }
        var p = '${previewPath.replace(/'/g, "\\'")}';
        if (File.exists(p)) File.remove(p);
        tmp.saveAs(p, false, false, false, false);
        tmp.forceClose();
        'OK';
      `);

      // Get stats for the text portion
      const stats = await getStats(ctx, input.view_id);
      const textSummary = `Preview saved: ${input.label}\nFile: ${previewPath}\nStats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}`;

      // Return multi-content: text + image (in MCP mode, image block is converted to file path hint)
      if (fs.existsSync(previewPath)) {
        return [
          { type: 'text', text: textSummary },
          jpegToContentBlock(previewPath)
        ];
      }
      return { type: 'text', text: textSummary + '\n(Preview file not created)' };
    }
  },

  // --- Vision aesthetic critic (fresh independent judge) ---
  vision_aesthetic_critic: {
    category: 'measurement',
    definition: {
      name: 'vision_aesthetic_critic',
      description: 'Render the view to a JPEG and have a FRESH, independent Claude judge score it 0-10 on a competition rubric (natural-vs-cooked, core integrity, IFN/faint structure, stars, color) and list flaws. COST GUARD: only runs at the composition-critic stage or at finish — pass phase="composition_critic" (judging a candidate before finish) or phase="finish". Cached by rendered-image hash, so identical pixels never re-judge. Use on your best composition candidate to get an unbiased aesthetic read before committing.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to critique' },
          phase: { type: 'string', enum: ['composition_critic', 'finish'], description: 'Critic stage. Only these phases spawn the judge (cost guard).' },
          label: { type: 'string', description: 'Short label for the critique JPEG (e.g. "COMP_balanced")' }
        },
        required: ['view_id', 'phase']
      }
    },
    handler: async (ctx, store, _brief, input) => {
      if (input.phase !== 'composition_critic' && input.phase !== 'finish') {
        return { type: 'text', text: `vision_aesthetic_critic SKIPPED: phase="${input.phase}" is not a critic phase (cost guard). Pass phase="composition_critic" or "finish".` };
      }
      const r = await critiqueAesthetic(ctx, input.view_id, { baseDir: store?.baseDir, label: input.label || input.view_id, maxDim: 1500, model: 'opus' });
      if (r.error) return { type: 'text', text: `vision_aesthetic_critic ERROR: ${r.error} (advisory — does not block).` };
      const flawText = r.flaws.length ? `\nFlaws: ${r.flaws.map(f => '• ' + f).join('  ')}` : '\nFlaws: none noted.';
      return { type: 'text', text: `AESTHETIC SCORE: ${r.aesthetic_score.toFixed(1)}/10${r.cached ? ' (cached)' : ''}${flawText}\n` + JSON.stringify({ aesthetic_score: r.aesthetic_score, flaws: r.flaws }) };
    }
  },

  // --- Image management ---
  clone_image: {
    category: 'image_mgmt',
    definition: {
      name: 'clone_image',
      description: 'Clone an image to a backup. ALWAYS clone before experimenting so you can restore if needed.',
      input_schema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Source view ID' },
          clone_id: { type: 'string', description: 'Name for the clone (e.g. "backup_pre_stretch")' }
        },
        required: ['source_id', 'clone_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await cloneImage(ctx, input.source_id, input.clone_id);
      return { type: 'text', text: `Cloned ${input.source_id} → ${input.clone_id}` };
    }
  },

  restore_from_clone: {
    category: 'image_mgmt',
    definition: {
      name: 'restore_from_clone',
      description: 'Restore an image from a backup clone, undoing all changes since the clone was made.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target view ID to overwrite' },
          clone_id: { type: 'string', description: 'Clone view ID to restore from' }
        },
        required: ['target_id', 'clone_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await restoreFromClone(ctx, input.target_id, input.clone_id);
      return { type: 'text', text: `Restored ${input.target_id} from ${input.clone_id}` };
    }
  },

  close_image: {
    category: 'image_mgmt',
    definition: {
      name: 'close_image',
      description: 'Close an image window to free memory.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to close' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await closeImage(ctx, input.view_id);
      return { type: 'text', text: `Closed ${input.view_id}` };
    }
  },

  purge_undo: {
    category: 'image_mgmt',
    definition: {
      name: 'purge_undo',
      description: 'Purge undo history for a view to free memory. Do this after mask-heavy steps.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await purgeUndoHistory(ctx, input.view_id);
      return { type: 'text', text: `Purged undo history for ${input.view_id}` };
    }
  },

  // --- Gradient ---
  run_gradient_correction: {
    category: 'gradient',
    definition: {
      name: 'run_gradient_correction',
      description: 'Run GradientCorrection (GC) on an image. Good general-purpose gradient removal. Compare with ABE to see which gives better uniformity.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await runGC(ctx, input.view_id);
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `GC complete. Stats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}` };
    }
  },

  run_abe: {
    category: 'gradient',
    definition: {
      name: 'run_abe',
      description: 'Run AutomaticBackgroundExtractor (ABE). Use polyDegree=2 for gentle correction (galaxies), 4 for aggressive (nebulae).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          poly_degree: { type: 'integer', description: 'Polynomial degree (1-6, default 4). Lower = gentler.' },
          tolerance: { type: 'number', description: 'Sample rejection tolerance (default 1.0)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await runABE(ctx, input.view_id, {
        polyDegree: input.poly_degree,
        tolerance: input.tolerance
      });
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `ABE complete (degree=${input.poly_degree || 4}). Stats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}` };
    }
  },

  run_per_channel_abe: {
    category: 'gradient',
    definition: {
      name: 'run_per_channel_abe',
      description: 'Run ABE independently on each R/G/B channel then recombine. Fixes color-specific gradients (e.g., green gradient on one side) that emerge after stretching/curves. Use on NON-LINEAR (stretched) data. polyDegree=1 is safest.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'RGB view ID (must be stretched/non-linear)' },
          poly_degree: { type: 'integer', description: 'ABE polynomial degree per channel (1-3, default 1). Keep low!' },
          tolerance: { type: 'number', description: 'Sample rejection tolerance (default 1.2)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await runPerChannelABE(ctx, input.view_id, {
        polyDegree: input.poly_degree ?? 1,
        tolerance: input.tolerance ?? 1.2
      });
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `Per-channel ABE complete (degree=${input.poly_degree || 1}). Stats: median=${stats.median.toFixed(6)}` };
    }
  },

  run_scnr: {
    category: 'gradient',
    definition: {
      name: 'run_scnr',
      description: 'Run SCNR (SubtractiveChromaticNoiseReduction) to remove green cast. preserveLightness keeps brightness so it does NOT grey out warm dust/IFN. Amount 0.30-0.50 moderate, 0.70+ aggressive. For reflection nebulae / dust-heavy fields the amount is auto-capped at 0.30 to protect brown IFN color.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          amount: { type: 'number', description: 'Green removal amount (0.0-1.0, default 0.50; auto-capped to 0.30 for dust/reflection targets)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      let amount = input.amount ?? 0.50;
      // Protect warm dust/IFN color: cap SCNR on reflection/dust-heavy targets.
      const cls = brief?.target?.classification || '';
      const dustHeavy = /reflection|ifn|dark_nebula|molecular/i.test(cls);
      let note = '';
      if (dustHeavy && amount > 0.30) { amount = 0.30; note = ' (capped 0.30 — dust/IFN color protection)'; }
      await runSCNR(ctx, input.view_id, { amount, preserveLightness: true });
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `SCNR green removal (amount=${amount}${note}, preserveLightness=on). Stats: median=${stats.median.toFixed(6)}` };
    }
  },

  // --- Denoise ---
  run_nxt: {
    category: 'denoise',
    definition: {
      name: 'run_nxt',
      description: 'Run NoiseXTerminator. Use multiple light passes (0.15-0.25) rather than one heavy pass. denoise=0.15 is very gentle, 0.35 is moderate.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          denoise: { type: 'number', description: 'Denoise strength (0.0-1.0, recommend 0.15-0.35)' },
          detail: { type: 'number', description: 'Detail preservation (0.0-1.0, default 0.15)' }
        },
        required: ['view_id', 'denoise']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await ctx.pjsr(`
        var P = new NoiseXTerminator;
        P.denoise = ${input.denoise};
        P.detail = ${input.detail ?? 0.15};
        P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
      `);
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `NXT complete (denoise=${input.denoise}). Stats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}` };
    }
  },

  // --- Sharpen ---
  run_bxt: {
    category: 'sharpen',
    definition: {
      name: 'run_bxt',
      description: 'Run BlurXTerminator. For correction mode (linear data): use correct_only=true. For sharpening: set sharpen_nonstellar (0.25-1.0) and sharpen_stellar.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          correct_only: { type: 'boolean', description: 'Correct-only mode (no sharpening, good for linear data)' },
          sharpen_nonstellar: { type: 'number', description: 'Non-stellar sharpening (0.0-1.0, default 0.50)' },
          sharpen_stellar: { type: 'number', description: 'Stellar sharpening (0.0-1.0, default 0.50)' },
          adjust_star_halos: { type: 'number', description: 'Star halo adjustment (-1.0 to 1.0, use 0.0 to avoid ringing)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const correctOnly = input.correct_only ? 'true' : 'false';
      await ctx.pjsr(`
        var P = new BlurXTerminator;
        P.AI = true;
        P.correct_only = ${correctOnly};
        ${!input.correct_only ? `P.nonstellar_then_stellar = true;
        P.sharpen_nonstellar = ${input.sharpen_nonstellar ?? 0.50};
        P.sharpen_stellar = ${input.sharpen_stellar ?? 0.50};` : ''}
        P.adjust_halos = ${input.adjust_star_halos ?? 0.0};
        P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
      `);
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `BXT complete (${input.correct_only ? 'correct_only' : 'sharpen'}). Stats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}` };
    }
  },

  // --- Stretch ---
  seti_stretch: {
    category: 'stretch',
    definition: {
      name: 'seti_stretch',
      description: 'Seti Statistical Stretch — the preferred stretch method. Converts linear data to non-linear. target_median=0.12 for galaxies, 0.20-0.25 for nebulae. headroom=0.05 prevents core clipping.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to stretch' },
          target_median: { type: 'number', description: 'Target median after stretch (0.05-0.30, default 0.25)' },
          hdr_compress: { type: 'boolean', description: 'Enable HDR compression (default true)' },
          hdr_amount: { type: 'number', description: 'HDR compression amount (0.0-1.0, default 0.25)' },
          hdr_headroom: { type: 'number', description: 'HDR headroom to prevent clipping (0.0-0.15, default 0.05)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const stats = await setiStretch(ctx, input.view_id, {
        targetMedian: input.target_median ?? 0.25,
        hdrCompress: input.hdr_compress ?? true,
        hdrAmount: input.hdr_amount ?? 0.25,
        hdrKnee: 0.35,
        hdrHeadroom: input.hdr_headroom ?? 0.05
      });
      return { type: 'text', text: `Seti stretch complete. Final: median=${stats.median.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}` };
    }
  },

  stretch_stars: {
    category: 'stretch',
    definition: {
      name: 'stretch_stars',
      description: 'Stretch a LINEAR star image using the Seti method: clip background pedestal, then iterative MTF. Produces tight, point-like stars on a black background. DO NOT use auto_stretch or seti_stretch on star images — they amplify background noise.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Star image view ID (must be linear)' },
          midtone: { type: 'number', description: 'MTF midtone (0.15-0.25, default 0.20). Lower = brighter faint stars but risk of bloat.' },
          iterations: { type: 'integer', description: 'Number of MTF iterations (3-7, default 5). More = brighter faint stars.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      // PROFILE ENFORCEMENT: galaxy targets get conservative star stretch params
      // to prevent bloated stars (NGC4490: agent used 0.15/6, producing 15-18px FWHM)
      const classification = brief?.target?.classification || '';
      const starProfile = brief?.processingProfile?.stars || {};
      const isGalaxy = classification.startsWith('galaxy');

      let midtone = input.midtone ?? 0.20;
      let iterations = input.iterations ?? 5;

      if (isGalaxy) {
        const profileMidtone = starProfile.stretch_midtone ?? 0.25;
        const profileIter = starProfile.stretch_iterations ?? 4;
        if (midtone < profileMidtone) {
          const oldMid = midtone;
          midtone = profileMidtone;
          process.stderr.write(`[stretch_stars] GALAXY OVERRIDE: midtone ${oldMid} → ${midtone} (profile minimum for ${classification})\n`);
        }
        if (iterations > profileIter) {
          const oldIter = iterations;
          iterations = profileIter;
          process.stderr.write(`[stretch_stars] GALAXY OVERRIDE: iterations ${oldIter} → ${iterations} (profile maximum for ${classification})\n`);
        }
      }

      // Seti star stretch method (proven in scripted pipeline):
      // 1. Check linearity — refuse if already non-linear
      // 2. Clip background pedestal (subtract median, rescale)
      // 3. MTF iterations: progressively lift faint stars while constraining bright ones
      const r = await ctx.pjsr(`
        var w = ImageWindow.windowById('${input.view_id}');
        if (w.isNull) throw new Error('View not found: ${input.view_id}');
        var v = w.mainView;

        // Linearity guard: if max is very high but median is near zero,
        // data is likely already stretched (non-linear). Stars on black background
        // have median ~0 even when stretched, so check the 99th percentile of
        // non-zero pixels instead.
        var maxVal = v.image.maximum();
        var med = v.image.median();
        // Sample non-zero pixels to estimate stretch state
        var nonzeroAbove05 = 0;
        var nonzeroTotal = 0;
        var step = 16;
        for (var y = 0; y < v.image.height; y += step) {
          for (var x = 0; x < v.image.width; x += step) {
            var val = v.image.isColor ? Math.max(v.image.sample(x,y,0), v.image.sample(x,y,1), v.image.sample(x,y,2)) : v.image.sample(x,y);
            if (val > 0.005) {
              nonzeroTotal++;
              if (val > 0.5) nonzeroAbove05++;
            }
          }
        }
        var highFraction = nonzeroTotal > 0 ? nonzeroAbove05 / nonzeroTotal : 0;

        // If >30% of star pixels are already above 0.5, data is non-linear
        if (highFraction > 0.30) {
          JSON.stringify({ alreadyStretched: true, highFraction: highFraction, maxVal: maxVal, med: med });
        } else {

        // Step 1: Clip background pedestal
        if (med > 0.00001) {
          var P = new PixelMath;
          P.expression = 'max(0, ($T - ' + med + ') / (1 - ' + med + '))';
          P.useSingleExpression = true;
          P.createNewImage = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(v);
        }

        // Step 2: Seti MTF stretch — N iterations
        // MTF(m, x) = (1-m)*x / ((1-2*m)*x + m)
        var m = ${midtone};
        var a = (1 - m).toFixed(6);
        var b = (1 - 2*m).toFixed(6);
        var mtfExpr = '(' + a + '*$T)/((' + b + ')*$T+' + m.toFixed(6) + ')';
        for (var i = 0; i < ${iterations}; i++) {
          var P2 = new PixelMath;
          P2.expression = mtfExpr;
          P2.useSingleExpression = true;
          P2.createNewImage = false;
          P2.use64BitWorkingImage = true;
          P2.truncate = true; P2.truncateLower = 0; P2.truncateUpper = 1;
          P2.executeOn(v);
          processEvents();
        }

        var finalMed = v.image.median();
        var finalMax = v.image.maximum();
        JSON.stringify({ bgClip: med, midtone: m, iterations: ${iterations}, finalMedian: finalMed, finalMax: finalMax });

        } // end else (linearity guard)
      `);
      const result = JSON.parse(r.outputs?.consoleOutput || '{}');

      // Handle already-stretched guard
      if (result.alreadyStretched) {
        return { type: 'text', text: `REFUSED: Star layer appears already non-linear (${(result.highFraction * 100).toFixed(0)}% of star pixels > 0.5, max=${result.maxVal?.toFixed(4)}). stretch_stars is designed for LINEAR input only. The star layer from prep is already stretched — skip this tool and proceed directly to saturation curves and rolloff.` };
      }

      return { type: 'text', text: `Stars stretched (Seti method): bgClip=${result.bgClip?.toFixed(6)}, midtone=${midtone}, ${iterations} iterations. Final: median=${result.finalMedian?.toFixed(4)}, max=${result.finalMax?.toFixed(4)}` };
    }
  },

  auto_stretch: {
    category: 'stretch',
    definition: {
      name: 'auto_stretch',
      description: 'Quick auto-stretch using STF-based histogram transformation. Simpler than Seti but less control. Good for previewing linear data.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to stretch' },
          target_bg: { type: 'number', description: 'Target background level (default 0.25)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      // Import dynamically to avoid circular deps
      const { autoStretch } = await import('../ops/preview.mjs');
      const result = await autoStretch(ctx, input.view_id, input.target_bg || 0.25);
      return { type: 'text', text: `Auto-stretch complete. Shadows=${result.shadows.toFixed(6)}, midtone=${result.midtone.toFixed(6)}` };
    }
  },

  // --- Calibration ---
  run_spcc: {
    category: 'calibration',
    definition: {
      name: 'run_spcc',
      description: 'Run SpectrophotometricColorCalibration (SPCC) for accurate color calibration. CRITICAL for galaxy work — SCNR cannot replace proper spectrophotometric calibration. Requires the image to have an astrometric solution (plate solve first if needed). The image must be LINEAR (not stretched).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to calibrate (must be linear, must have WCS/astrometric solution)' },
          white_reference: { type: 'string', description: 'White reference type (default "Average Spiral Galaxy"). Other options: "G2V Star", "Average Star".' },
          narrowband_mode: { type: 'boolean', description: 'Enable narrowband mode (default false)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const narrowband = input.narrowband_mode ? 'true' : 'false';
      // IMPORTANT: Do NOT set whiteReferenceSpectrum, filter curves, or QE as string names.
      // SPCC expects raw spectral data (wavelength,value pairs). The defaults are correct for
      // broadband imaging. Setting string names like 'Average Spiral Galaxy' causes a parse error.
      const r = await ctx.pjsr(`
        var P = new SpectrophotometricColorCalibration;
        P.applyCalibration = true;
        P.narrowbandMode = ${narrowband};
        P.generateGraphs = false;
        P.generateStarMaps = false;
        P.generateTextFiles = false;
        P.backgroundNeutralizationEnabled = true;
        P.psfStructureLayers = 5;
        P.psfMinSNR = 10;
        P.psfAllowClusteredSources = true;
        P.psfType = 4;
        P.psfGrowth = 1.25;
        P.psfMaxStars = 4096;
        P.psfChannelSearchTolerance = 2;
        var ok = P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
        'SPCC_result=' + ok;
      `);
      const ok = (r.outputs?.consoleOutput || '').includes('true');
      if (!ok) {
        return { type: 'text', text: `SPCC failed: ${r.outputs?.consoleOutput || r.error?.message}. Ensure the image has an astrometric solution (use copy_astrometric_solution from an original master after BXT).` };
      }
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `SPCC complete. Channels now balanced: R=${stats.perChannel?.R?.median?.toFixed(6)}, G=${stats.perChannel?.G?.median?.toFixed(6)}, B=${stats.perChannel?.B?.median?.toFixed(6)} (median=${stats.median.toFixed(6)})` };
    }
  },

  run_plate_solve: {
    category: 'calibration',
    definition: {
      name: 'run_plate_solve',
      description: 'Run ImageSolver to add an astrometric solution (WCS) to an image. Required before SPCC. Uses online catalog (requires internet).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to plate solve' },
          center_ra: { type: 'number', description: 'Approximate RA in degrees (optional, helps solver converge faster)' },
          center_dec: { type: 'number', description: 'Approximate Dec in degrees (optional)' },
          pixel_scale: { type: 'number', description: 'Pixel scale in arcsec/pixel (optional, default auto-detect)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const centerRA = input.center_ra !== undefined ? `P.centerRA = ${input.center_ra};` : '';
      const centerDec = input.center_dec !== undefined ? `P.centerDec = ${input.center_dec};` : '';
      const pixelScale = input.pixel_scale !== undefined ? `P.resolution = ${input.pixel_scale}; P.autoResolution = false;` : 'P.autoResolution = true;';
      const r = await ctx.pjsr(`
        var P = new ImageSolver;
        ${centerRA}
        ${centerDec}
        ${pixelScale}
        P.catalogMode = ImageSolver.prototype.DataRelease;
        P.catalog = ImageSolver.prototype.GaiaDR3;
        P.distortionCorrection = true;
        P.projectionSystem = ImageSolver.prototype.Gnomonic;
        P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
        'OK';
      `);
      if (r.status === 'error') {
        return { type: 'text', text: `Plate solve failed: ${r.error?.message}. The image may need better initial coordinates or more stars.` };
      }
      return { type: 'text', text: 'Plate solve complete. Astrometric solution added to image.' };
    }
  },

  copy_astrometric_solution: {
    category: 'calibration',
    definition: {
      name: 'copy_astrometric_solution',
      description: 'Copy the astrometric solution (WCS) from a source image to a target image. Use this after BXT which is known to strip WCS data. The source should be an original master file that was plate-solved during stacking.',
      input_schema: {
        type: 'object',
        properties: {
          source_file: { type: 'string', description: 'Absolute path to the source XISF file with WCS (typically an original master)' },
          target_id: { type: 'string', description: 'Target view ID to receive the WCS' }
        },
        required: ['source_file', 'target_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      // Open source temporarily, use copyAstrometricSolution API, copy observation keywords, close
      const r = await ctx.pjsr(`
        var srcPath = '${input.source_file.replace(/'/g, "\\'")}';
        var tgtW = ImageWindow.windowById('${input.target_id}');
        if (tgtW.isNull) throw new Error('Target not found: ${input.target_id}');

        // Check file exists BEFORE opening (avoids modal popup on missing file)
        if (!File.exists(srcPath)) throw new Error('Source file not found: ' + srcPath);

        var wins = ImageWindow.open(srcPath);
        if (!wins || wins.length === 0) throw new Error('Cannot open source: ' + srcPath);
        var srcW = wins[0];

        // Close any crop masks that came with the source
        var allW = ImageWindow.windows;
        for (var i = 0; i < allW.length; i++) {
          if (allW[i].mainView.id.indexOf('crop_mask') >= 0) allW[i].forceClose();
        }

        var info = '';
        if (!srcW.hasAstrometricSolution) {
          info = 'WARNING: source has no astrometric solution';
        } else {
          // Check dimension match — WCS is dimension-specific
          var sw = srcW.mainView.image.width, sh = srcW.mainView.image.height;
          var tw = tgtW.mainView.image.width, th = tgtW.mainView.image.height;
          if (sw !== tw || sh !== th) {
            info = 'WARNING: dimension mismatch (source ' + sw + 'x' + sh + ' vs target ' + tw + 'x' + th + '). WCS not copied — SPCC may fail.';
          } else {
            tgtW.copyAstrometricSolution(srcW);
            info = 'Astrometric solution copied (hasAstro=' + tgtW.hasAstrometricSolution + ')';
          }
        }

        // Copy observation keywords (BXT may have cleared them)
        var rKW = srcW.keywords, tKW = tgtW.keywords;
        var copyNames = ['DATE-OBS','DATE-END','OBSGEO-L','OBSGEO-B','OBSGEO-H',
                         'LONG-OBS','LAT-OBS','ALT-OBS','EXPTIME','TELESCOP','INSTRUME','OBJECT',
                         'FOCALLEN','XPIXSZ','YPIXSZ','RA','DEC','OBJCTRA','OBJCTDEC'];
        var copied = [];
        for (var k = 0; k < copyNames.length; k++) {
          var name = copyNames[k], exists = false;
          for (var j = 0; j < tKW.length; j++) { if (tKW[j].name === name) { exists = true; break; } }
          if (!exists) {
            for (var m = 0; m < rKW.length; m++) {
              if (rKW[m].name === name) { tKW.push(new FITSKeyword(rKW[m].name, rKW[m].value, rKW[m].comment)); copied.push(name); break; }
            }
          }
        }
        tgtW.keywords = tKW;

        // Copy XISF observation properties
        var obsProps = ['Observation:Time:Start','Observation:Time:End',
          'Observation:Location:Longitude','Observation:Location:Latitude','Observation:Location:Elevation'];
        for (var p = 0; p < obsProps.length; p++) {
          try { var v = srcW.mainView.propertyValue(obsProps[p]); var t = srcW.mainView.propertyType(obsProps[p]);
            if (v !== undefined && v !== null) tgtW.mainView.setPropertyValue(obsProps[p], v, t); } catch(e) {}
        }

        info += '. Keywords copied: ' + copied.join(',');
        srcW.forceClose();
        info;
      `);
      return { type: 'text', text: r.outputs?.consoleOutput || r.error?.message || 'WCS copy attempted' };
    }
  },

  run_background_neutralization: {
    category: 'calibration',
    definition: {
      name: 'run_background_neutralization',
      description: 'Run BackgroundNeutralization to equalize background levels across channels. Useful after SPCC or as a standalone calibration step.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to neutralize' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await ctx.pjsr(`
        var P = new BackgroundNeutralization;
        P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
      `);
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `Background neutralization complete. Per-channel: R=${stats.perChannel?.R?.median?.toFixed(6)}, G=${stats.perChannel?.G?.median?.toFixed(6)}, B=${stats.perChannel?.B?.median?.toFixed(6)}` };
    }
  },

  // NOTE: a duplicate `run_scnr` (category 'calibration', default 0.80, unmasked)
  // previously lived here and SHADOWED the masked 0.50 version above (JS keeps the
  // last key), so the agent always got the over-aggressive one that greyed out
  // warm dust/IFN. Removed 2026-06-22. The single run_scnr is the one above.

  // --- Detail ---
  run_lhe: {
    category: 'detail',
    definition: {
      name: 'run_lhe',
      description: 'DEPRECATED — use multi_scale_enhance instead. Direct LHE is disabled for normal processing.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          radius: { type: 'integer', description: 'Kernel radius in pixels (24-128)' },
          amount: { type: 'number', description: 'Effect strength (0.10-0.50)' },
          slope_limit: { type: 'number', description: 'Contrast slope limiter (1.1-2.5, default 1.5)' }
        },
        required: ['view_id', 'radius', 'amount']
      }
    },
    handler: async (_ctx, _store, _brief, _input) => {
      return {
        type: 'text',
        text: `TOOL POLICY VIOLATION: Direct run_lhe is disabled. Use multi_scale_enhance instead — it does 3-scale LHE + optional HDRMT + before/after metrics in ONE call. It is 5x faster and includes automatic masking. Call multi_scale_enhance with your desired amounts (lhe_fine_amount, lhe_mid_amount, lhe_large_amount) and mask settings.`
      };
    }
  },

  run_hdrmt: {
    category: 'detail',
    definition: {
      name: 'run_hdrmt',
      description: 'Run HDRMultiscaleTransform. Inverted mode enhances detail; normal mode compresses dynamic range. Use layers=5-7, iterations=1 for inverted. ALWAYS check for ringing on bright cores after.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          layers: { type: 'integer', description: 'Number of decomposition layers (4-8, default 6)' },
          iterations: { type: 'integer', description: 'Number of iterations (default 1)' },
          inverted: { type: 'boolean', description: 'Inverted mode (enhances detail instead of compressing). Preferred for luminance.' },
          to_lightness: { type: 'boolean', description: 'Apply to lightness only for color images (default true)' },
          preserve_hue: { type: 'boolean', description: 'Preserve hue for color images (default true)' }
        },
        required: ['view_id', 'layers']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const inverted = input.inverted ? 'true' : 'false';
      const toLightness = (input.to_lightness !== false) ? 'true' : 'false';
      const preserveHue = (input.preserve_hue !== false) ? 'true' : 'false';
      await ctx.pjsr(`
        var P = new HDRMultiscaleTransform;
        P.numberOfLayers = ${input.layers};
        P.numberOfIterations = ${input.iterations ?? 1};
        P.invertedIterations = ${inverted};
        P.overdrive = 0;
        P.medianTransform = false;
        P.scalingFunctionData = [
          0.003906,0.015625,0.023438,0.015625,0.003906,
          0.015625,0.0625,0.09375,0.0625,0.015625,
          0.023438,0.09375,0.140625,0.09375,0.023438,
          0.015625,0.0625,0.09375,0.0625,0.015625,
          0.003906,0.015625,0.023438,0.015625,0.003906
        ];
        P.scalingFunctionRowFilter = [0.0625,0.25,0.375,0.25,0.0625];
        P.scalingFunctionColFilter = [0.0625,0.25,0.375,0.25,0.0625];
        P.scalingFunctionNoiseLayers = 1;
        P.scalingFunctionName = "B3 Spline (5)";
        P.deringing = true;
        P.smallScaleDeringing = 0.000;
        P.largeScaleDeringing = 0.500;
        P.outputDeringingMaps = false;
        P.toLightness = ${toLightness};
        P.preserveHue = ${preserveHue};
        P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
      `);
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `HDRMT complete (layers=${input.layers}, inverted=${inverted}). ${statsLine(stats)}` };
    }
  },

  // --- Masks ---
  create_luminance_mask: {
    category: 'masks',
    definition: {
      name: 'create_luminance_mask',
      description: 'Create a luminance mask from a color image. blur=3-6 for tight galaxy masks, 8-15 for nebulae. clipLow=0.10-0.15 for galaxies (must exclude background). gamma=2.0 expands midtones.',
      input_schema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Source color view ID' },
          mask_id: { type: 'string', description: 'Name for the mask' },
          blur: { type: 'number', description: 'Blur sigma (default 5)' },
          clip_low: { type: 'number', description: 'Shadow clip threshold (default 0.10)' },
          gamma: { type: 'number', description: 'Gamma curve for mask (default 1.0, use 2.0 for galaxy enhancement)' }
        },
        required: ['source_id', 'mask_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await createLumMask(
        ctx, input.source_id, input.mask_id,
        input.blur ?? 5, input.clip_low ?? 0.10, input.gamma ?? 1.0
      );
      return { type: 'text', text: result ? `Luminance mask created: ${result}` : 'Failed to create mask' };
    }
  },

  apply_mask: {
    category: 'masks',
    definition: {
      name: 'apply_mask',
      description: 'Apply a mask to a target view. The mask protects areas where it is black (0) and allows processing where it is white (1). Use inverted=true to flip this.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target view ID' },
          mask_id: { type: 'string', description: 'Mask view ID' },
          inverted: { type: 'boolean', description: 'Invert mask (default false)' }
        },
        required: ['target_id', 'mask_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await applyMask(ctx, input.target_id, input.mask_id, input.inverted || false);
      return { type: 'text', text: `Mask ${input.mask_id} applied to ${input.target_id}${input.inverted ? ' (inverted)' : ''}` };
    }
  },

  remove_mask: {
    category: 'masks',
    definition: {
      name: 'remove_mask',
      description: 'Remove the current mask from a view.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target view ID' }
        },
        required: ['target_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await removeMask(ctx, input.target_id);
      return { type: 'text', text: `Mask removed from ${input.target_id}` };
    }
  },

  close_mask: {
    category: 'masks',
    definition: {
      name: 'close_mask',
      description: 'Close and delete a mask window to free memory.',
      input_schema: {
        type: 'object',
        properties: {
          mask_id: { type: 'string', description: 'Mask view ID to close' }
        },
        required: ['mask_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await closeMask(ctx, input.mask_id);
      return { type: 'text', text: `Mask ${input.mask_id} closed` };
    }
  },

  // --- Curves ---
  run_curves: {
    category: 'curves',
    definition: {
      name: 'run_curves',
      description: 'Apply a CurvesTransformation. Provide control points as [[x,y], ...] for the desired channel. Channel: "RGB" (all), "L" (lightness), "S" (saturation), "R", "G", "B".',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          channel: { type: 'string', enum: ['RGB', 'L', 'S', 'R', 'G', 'B'], description: 'Channel to apply curve to' },
          points: {
            type: 'array',
            items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
            description: 'Control points [[x,y], ...] from (0,0) to (1,1). Include endpoints.'
          }
        },
        required: ['view_id', 'channel', 'points']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      // CurvesTransformation PJSR properties: R, G, B, K (RGB/K combined), L, S
      // Each is an array of [x, y] control points. Kt, Lt, St etc. set interpolation type.
      const channelProp = { R: 'R', G: 'G', B: 'B', RGB: 'K', L: 'L', S: 'S' };
      const prop = channelProp[input.channel] || 'K';
      const pts = input.points.map(p => `[${p[0]},${p[1]}]`).join(',');
      await ctx.pjsr(`
        var P = new CurvesTransformation;
        P.${prop} = [${pts}];
        P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
      `);
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `Curves (${input.channel}) applied. ${statsLine(stats)}` };
    }
  },

  run_pixelmath: {
    category: 'curves',
    definition: {
      name: 'run_pixelmath',
      description: 'Run an arbitrary PixelMath expression. RULES: (1) NO pow() — use exp(exponent*ln(base)). (2) Channel access is $T[0] for R, $T[1] for G, $T[2] for B — NOT $T.R or $T.B. (3) For other images use viewId[0], viewId[1], viewId[2].',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          expression: { type: 'string', description: 'PixelMath expression using $T for current pixel value' },
          single_expression: { type: 'boolean', description: 'Apply same expression to all channels (default true)' },
          symbols: { type: 'string', description: 'Symbol declarations (comma-separated)' }
        },
        required: ['view_id', 'expression']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const useSingle = (input.single_expression !== false) ? 'true' : 'false';
      await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "${input.expression.replace(/"/g, '\\"')}";
        P.useSingleExpression = ${useSingle};
        ${input.symbols ? `P.symbols = "${input.symbols}";` : ''}
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
      `);
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `PixelMath applied. ${statsLine(stats)}` };
    }
  },

  // --- Stars ---
  star_protected_blend: {
    category: 'stars',
    definition: {
      name: 'star_protected_blend',
      description: 'HYBRID color-preserving star reintegration. In dark areas: normal RGB screen blend (gorgeous stars). In bright areas: luminance-only injection that preserves the target color ratios (prevents core washout). Smooth transition between modes. PRECONDITION: check_star_layer_integrity must have been called first.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Starless image view ID' },
          stars_id: { type: 'string', description: 'Stars-only image view ID' },
          strength: { type: 'number', description: 'Star blend strength (0.5-1.2, default 0.95)' },
          core_threshold_low: { type: 'number', description: 'Luminance below which pure screen blend applies (default 0.60)' },
          core_threshold_high: { type: 'number', description: 'Luminance above which pure color-preserving mode applies (default 0.82)' },
          min_strength_fraction: { type: 'number', description: 'Minimum star strength fraction in brightest cores (default 0.10)' },
          pre_star_id: { type: 'string', description: 'Optional: pre-star view ID for post-blend color restoration. If provided, bright-area color ratios are restored from this reference after blending.' }
        },
        required: ['target_id', 'stars_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const starsId = input.stars_id;
      const targetId = input.target_id;

      // Check precondition: star integrity must have been checked
      const integrityRecord = brief?._starIntegrity?.[starsId];
      if (!integrityRecord) {
        return {
          type: 'text',
          text: `REFUSED: No star layer integrity check found for "${starsId}". ` +
            `Call check_star_layer_integrity on the star layer FIRST, then retry star_protected_blend.`
        };
      }
      if (integrityRecord.verdict === 'FAIL') {
        return {
          type: 'text',
          text: `REFUSED: Star layer "${starsId}" FAILED integrity check (max=${integrityRecord.max_value?.toFixed(4)}). ` +
            `Fix the star layer first: apply soft rolloff (e.g. min($T, 0.95) or smooth compression above 0.65), ` +
            `then re-run check_star_layer_integrity before blending.`
        };
      }
      if (integrityRecord.unstretched) {
        return {
          type: 'text',
          text: `REFUSED: Star layer "${starsId}" appears UNSTRETCHED (median=${integrityRecord.median?.toFixed(6)}, ` +
            `nonzero=${integrityRecord.nonzero_pixel_count}). Stars will be invisible after blend. ` +
            `Call stretch_stars on the star layer FIRST, then re-run check_star_layer_integrity.`
        };
      }
      if (integrityRecord.turnsAgo > 15) {
        // Warn but don't refuse — stale check
      }

      // PROFILE ENFORCEMENT: cap blend strength for galaxies
      const classif = brief?.target?.classification || '';
      const starProf = brief?.processingProfile?.stars || {};
      let str = input.strength ?? 0.95;
      if (classif.startsWith('galaxy') && starProf.screen_blend_strength) {
        const maxStr = starProf.screen_blend_strength;
        if (str > maxStr) {
          process.stderr.write(`[star_protected_blend] GALAXY CAP: strength ${str} → ${maxStr} (profile limit for ${classif})\n`);
          str = maxStr;
        }
      }
      const low = input.core_threshold_low ?? 0.60;
      const high = input.core_threshold_high ?? 0.82;
      const minFrac = input.min_strength_fraction ?? 0.10;

      // Get pre-blend stats for logging
      const preStat = await getStats(ctx, targetId);

      // ================================================================
      // HYBRID BLEND: screen in dark areas, color-preserving in bright
      // ================================================================
      // Per-channel PixelMath with symbols for intermediate values.
      // L = target luminance (average of 3 channels)
      // SL = star luminance
      // prot = protection ramp (1.0 in dark, minFrac in bright core)
      // k = strength * prot
      // rgb = normal screen blend result
      // Lrgb = luminance-only screen (preserves color ratios)
      // cp = color-preserving: target color scaled by Lrgb/L
      // w = blend weight (0 in dark = pure screen, 1 in bright = pure color-preserving)
      // final = rgb*(1-w) + cp*w

      const coreStart = low;    // where color-preserving mode begins
      const coreEnd = high;     // where it's fully active
      const invRange = (1 - minFrac).toFixed(6);
      const range = (coreEnd - coreStart).toFixed(6);

      // Build per-channel expressions (R=0, G=1, B=2)
      const channelExprs = [0, 1, 2].map(c => {
        // All expressions share the same symbols but produce channel-specific output
        return [
          // L = target luminance (simple average for robustness)
          `L = (${targetId}[0] + ${targetId}[1] + ${targetId}[2]) / 3`,
          // SL = star luminance
          `SL = (${starsId}[0] + ${starsId}[1] + ${starsId}[2]) / 3`,
          // protection ramp
          `prot = iif(L < ${coreStart}, 1.0, iif(L > ${coreEnd}, ${minFrac}, 1.0 - ${invRange} * (L - ${coreStart}) / ${range}))`,
          // effective star strength
          `k = ${str} * prot`,
          // normal RGB screen blend for this channel
          `rgb = 1 - (1 - $T) * (1 - ${starsId}[${c}] * k)`,
          // luminance-only screen (same brightness but preserves color ratios)
          `Lrgb = 1 - (1 - L) * (1 - SL * k)`,
          // color-preserving: scale original channel by lum ratio
          `cp = min(${targetId}[${c}] * Lrgb / max(L, 0.001), 0.98)`,
          // blend weight: 0 in dark (pure screen), 1 in bright (pure color-preserving)
          `w = iif(L < ${coreStart}, 0.0, iif(L > ${coreEnd}, 1.0, (L - ${coreStart}) / ${range}))`,
          // final output
          `rgb * (1 - w) + cp * w`,
        ].join('; ');
      });

      await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "${channelExprs[0].replace(/"/g, '\\"')}";
        P.expression1 = "${channelExprs[1].replace(/"/g, '\\"')}";
        P.expression2 = "${channelExprs[2].replace(/"/g, '\\"')}";
        P.useSingleExpression = false;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.symbols = 'L, SL, prot, k, rgb, Lrgb, cp, w';
        P.executeOn(ImageWindow.windowById('${targetId}').mainView);
      `);

      // ================================================================
      // OPTIONAL: Post-blend color restoration from pre-star reference
      // ================================================================
      let restorationNote = '';
      if (input.pre_star_id) {
        const preId = input.pre_star_id;
        const restoreStart = coreStart;
        const restoreEnd = coreEnd;
        const restRange = (restoreEnd - restoreStart).toFixed(6);

        const restoreExprs = [0, 1, 2].map(c => {
          return [
            `Lp = (${preId}[0] + ${preId}[1] + ${preId}[2]) / 3`,
            `Lb = ($T[0] + $T[1] + $T[2]) / 3`,
            `restored = min(${preId}[${c}] * Lb / max(Lp, 0.001), 0.98)`,
            `wr = iif(Lp < ${restoreStart}, 0.0, iif(Lp > ${restoreEnd}, 1.0, (Lp - ${restoreStart}) / ${restRange}))`,
            `$T * (1 - wr) + restored * wr`,
          ].join('; ');
        });

        await ctx.pjsr(`
          var P = new PixelMath;
          P.expression = "${restoreExprs[0].replace(/"/g, '\\"')}";
          P.expression1 = "${restoreExprs[1].replace(/"/g, '\\"')}";
          P.expression2 = "${restoreExprs[2].replace(/"/g, '\\"')}";
          P.useSingleExpression = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.createNewImage = false;
          P.symbols = 'Lp, Lb, restored, wr';
          P.executeOn(ImageWindow.windowById('${targetId}').mainView);
        `);
        restorationNote = ` + color restoration from ${preId}`;
      }

      const postStat = await getStats(ctx, targetId);
      const staleNote = integrityRecord.turnsAgo > 15
        ? ' (NOTE: star integrity check is stale — consider re-checking)'
        : '';
      return {
        type: 'text',
        text: `Stars blended (HYBRID color-preserving, strength=${str}, core=[${low},${high}], min_frac=${minFrac}${restorationNote}). ` +
          `Pre: median=${preStat.median.toFixed(4)}, max=${(preStat.max ?? 0).toFixed(4)} → ` +
          `Post: ${statsLine(postStat)}${staleNote}`
      };
    }
  },

  // B3b: region-graft — blend a donor (e.g. a recalled champion) into base by a mask.
  blend_regions: {
    category: 'stars',
    definition: {
      name: 'blend_regions',
      description: 'Region-graft: blend donor_view into base_view weighted by a grayscale mask_view (mask 1 = full donor, 0 = keep base). Per-channel PixelMath; base_view is modified IN PLACE. Use to graft a recalled CHAMPION region (recall_champion donor) into your composition — e.g. donate strong IFN nebulosity or a clean core. base, donor and mask MUST be the same dimensions (champions are cross-run — this tool refuses on geometry mismatch; resample/align first).',
      input_schema: {
        type: 'object',
        properties: {
          base_view: { type: 'string', description: 'View modified in place (your composition).' },
          donor_view: { type: 'string', description: 'Source of the grafted region (e.g. a champion).' },
          mask_view: { type: 'string', description: 'Grayscale [0..1] weight: 1 = full donor, 0 = keep base.' },
          strength: { type: 'number', description: 'Global donor-weight multiplier 0..1.5 (default 1.0).' }
        },
        required: ['base_view', 'donor_view', 'mask_view']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const b = input.base_view, d = input.donor_view, m = input.mask_view;
      const s = Math.max(0, Math.min(1.5, input.strength == null ? 1.0 : input.strength)).toFixed(4);
      const geomR = await ctx.pjsr(`
        var wb = ImageWindow.windowById('${b}'); var wd = ImageWindow.windowById('${d}'); var wm = ImageWindow.windowById('${m}');
        var out;
        if (wb.isNull || wd.isNull || wm.isNull) { out = JSON.stringify({ ok:false, reason:'missing_view', base:null, donor:null, mask:null, mono:false }); }
        else {
          var ib = wb.mainView.image, id = wd.mainView.image, im = wm.mainView.image;
          var match = (ib.width===id.width && ib.height===id.height && ib.width===im.width && ib.height===im.height);
          out = JSON.stringify({ ok:match, reason: match?'ok':'geometry_mismatch', base:[ib.width,ib.height], donor:[id.width,id.height], mask:[im.width,im.height], mono: ib.numberOfChannels < 3 });
        }
        out;
      `);
      let geom = {};
      try { geom = JSON.parse(geomR.outputs && geomR.outputs.consoleOutput); } catch (e) { /* */ }
      if (!geom.ok) {
        const dims = geom.reason === 'missing_view' ? 'one or more views not found' : `base=${JSON.stringify(geom.base)} donor=${JSON.stringify(geom.donor)} mask=${JSON.stringify(geom.mask)}`;
        return { type: 'text', text: `REFUSED blend_regions: ${geom.reason || 'unknown'}. ${dims}. Resample/align donor and mask to base geometry before blending.` };
      }
      const preStat = await getStats(ctx, b);
      // Per-channel: w = clamp(mask*strength,0,1); out = base[c]*(1-w) + donor[c]*w.
      // Mono base → single expression on the lone channel (no [1]/[2]).
      const chExpr = (c) => `w = max(0, min(1, ${m} * ${s})); ${b}[${c}] * (1 - w) + ${d}[${c}] * w`.replace(/"/g, '\\"');
      if (geom.mono) {
        const monoExpr = `w = max(0, min(1, ${m} * ${s})); ${b} * (1 - w) + ${d} * w`.replace(/"/g, '\\"');
        await ctx.pjsr(`
          var P = new PixelMath;
          P.expression = "${monoExpr}";
          P.useSingleExpression = true;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.createNewImage = false;
          P.symbols = 'w';
          P.executeOn(ImageWindow.windowById('${b}').mainView);
        `);
      } else {
        await ctx.pjsr(`
          var P = new PixelMath;
          P.expression = "${chExpr(0)}";
          P.expression1 = "${chExpr(1)}";
          P.expression2 = "${chExpr(2)}";
          P.useSingleExpression = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.createNewImage = false;
          P.symbols = 'w';
          P.executeOn(ImageWindow.windowById('${b}').mainView);
        `);
      }
      const postStat = await getStats(ctx, b);
      return { type: 'text', text: `Region-grafted ${d} into ${b} via mask ${m} (strength ${s}). Pre: median=${preStat.median.toFixed(4)}, max=${(preStat.max ?? 0).toFixed(4)} → Post: ${statsLine(postStat)}` };
    }
  },

  // B3b: advisory Pareto signal vs recorded cross-run champions (never blocks).
  // Uses the SAME scoreVariantDimensions scoring the champions are keyed on.
  compare_to_champions: {
    category: 'measurement',
    definition: {
      name: 'compare_to_champions',
      description: 'PARETO SIGNAL (advisory): compares the current view against recorded cross-run CHAMPIONS for this target classification, per quality dimension (ifn_visibility, core_integrity, color_richness, detail, star_quality). Reports ahead/behind/tied per dimension and names the WEAKEST — use it to decide which recall_champion + blend_regions graft is worth attempting. Does not modify the image.',
      input_schema: {
        type: 'object',
        properties: { view_id: { type: 'string', description: 'View to evaluate (your current best composition).' } },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const classif = brief?.target?.classification || '';
      const champs = getChampions(classif);
      if (!champs || Object.keys(champs).length === 0) {
        return { type: 'text', text: `No cross-run champions recorded for "${classif}" yet — nothing to compare against.` };
      }
      const v = input.view_id;
      let detail = null, core = null, sat = null, stars = null;
      try { detail = await measureSubjectDetail(ctx, v); } catch (e) { /* */ }
      try { core = await measureCoreContrast(ctx, v, classif, brief?.processingProfile?.core_burn); } catch (e) { /* */ }
      try { sat = await checkSaturation(ctx, v); } catch (e) { /* */ }
      try { stars = await checkStarQuality(ctx, v); } catch (e) { /* */ }
      const maxP90 = brief?.processingProfile?.saturation?.max_p90 ?? 0.65;
      const cur = scoreVariantDimensions({ detail, core, saturation: sat, stars, maxP90 });
      const rows = [];
      let weakest = null, weakestGap = -Infinity;
      for (const dim of Object.keys(champs)) {
        const champScore = champs[dim].score;
        const c = cur[dim];
        if (typeof c !== 'number' || typeof champScore !== 'number') { rows.push(`  ${dim}: champion=${(champScore ?? 0).toFixed ? champScore.toFixed(4) : champScore} (current not measured)`); continue; }
        const gap = champScore - c;
        const verdict = gap > 0.02 ? 'BEHIND' : (gap < -0.02 ? 'AHEAD' : 'tied');
        rows.push(`  ${dim}: current=${c.toFixed(4)} vs champion=${champScore.toFixed(4)} → ${verdict} (run ${champs[dim].run_id})`);
        if (gap > weakestGap) { weakestGap = gap; weakest = dim; }
      }
      const reco = (weakest && weakestGap > 0.02)
        ? `\nWEAKEST vs champion: ${weakest} (behind by ${weakestGap.toFixed(4)}). Consider: recall_champion("${weakest}") → build a region mask → blend_regions.`
        : `\nCurrent view matches or beats all champions — no graft needed.`;
      return { type: 'text', text: `Champion comparison for "${classif}":\n${rows.join('\n')}${reco}` };
    }
  },

  // Standalone color restoration tool (can be used independently after any star blend)
  restore_star_color: {
    category: 'stars',
    definition: {
      name: 'restore_star_color',
      description: 'Post-blend color restoration: restores pre-star color ratios in bright areas while keeping post-star luminance (and stars). Use when star blend washed out color in the bright core. Requires the pre-star image to still be open.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Post-star image to repair (modified in-place)' },
          pre_star_id: { type: 'string', description: 'Pre-star reference image (must still be open)' },
          restore_start: { type: 'number', description: 'Luminance below which no restoration applies (default 0.60)' },
          restore_end: { type: 'number', description: 'Luminance above which full restoration applies (default 0.82)' }
        },
        required: ['target_id', 'pre_star_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const targetId = input.target_id;
      const preId = input.pre_star_id;
      const restoreStart = input.restore_start ?? 0.60;
      const restoreEnd = input.restore_end ?? 0.82;
      const restRange = (restoreEnd - restoreStart).toFixed(6);

      const preStat = await getStats(ctx, targetId);

      const restoreExprs = [0, 1, 2].map(c => {
        return [
          `Lp = (${preId}[0] + ${preId}[1] + ${preId}[2]) / 3`,
          `Lb = ($T[0] + $T[1] + $T[2]) / 3`,
          `restored = min(${preId}[${c}] * Lb / max(Lp, 0.001), 0.98)`,
          `wr = iif(Lp < ${restoreStart}, 0.0, iif(Lp > ${restoreEnd}, 1.0, (Lp - ${restoreStart}) / ${restRange}))`,
          `$T * (1 - wr) + restored * wr`,
        ].join('; ');
      });

      await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "${restoreExprs[0].replace(/"/g, '\\"')}";
        P.expression1 = "${restoreExprs[1].replace(/"/g, '\\"')}";
        P.expression2 = "${restoreExprs[2].replace(/"/g, '\\"')}";
        P.useSingleExpression = false;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.symbols = 'Lp, Lb, restored, wr';
        P.executeOn(ImageWindow.windowById('${targetId}').mainView);
      `);

      const postStat = await getStats(ctx, targetId);
      return {
        type: 'text',
        text: `Color restoration applied (ref=${preId}, range=[${restoreStart},${restoreEnd}]). ` +
          `Pre: median=${preStat.median.toFixed(4)}, max=${(preStat.max ?? 0).toFixed(4)} → ` +
          `Post: ${statsLine(postStat)}`
      };
    }
  },

  // Backward compatibility alias
  star_screen_blend: {
    category: 'stars',
    definition: {
      name: 'star_screen_blend',
      description: '[DEPRECATED — use star_protected_blend instead] Redirects to star_protected_blend with default core protection. Call check_star_layer_integrity on the star layer first.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Starless image view ID' },
          stars_id: { type: 'string', description: 'Stars-only image view ID' },
          strength: { type: 'number', description: 'Star blend strength (0.5-1.2, default 0.85)' }
        },
        required: ['target_id', 'stars_id']
      }
    },
    handler: async (ctx, store, brief, input, agentName) => {
      // Redirect to star_protected_blend
      return TOOL_CATALOG.star_protected_blend.handler(ctx, store, brief, input, agentName);
    }
  },

  // --- Artifacts ---
  save_variant: {
    category: 'artifacts',
    definition: {
      name: 'save_variant',
      description: 'Save the current image as a durable variant on disk. Returns a variant_id (e.g. "variant_21") that you MUST use when calling finish. The variant is the source of truth for export — not the live PixInsight view.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to save' },
          params: { type: 'object', description: 'Parameters used to produce this variant' },
          notes: { type: 'string', description: 'Human-readable notes about this variant' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, store, brief, input, agentName) => {
      const stats = await getStats(ctx, input.view_id);
      const uni = await measureUniformity(ctx, input.view_id);
      const result = await store.saveVariant(ctx, agentName, input.view_id, {
        ...input.params,
        notes: input.notes
      }, { ...stats, uniformity: uni.score });
      // Extract the short variant_id (e.g. "variant_21") from the full artifactId
      const variantId = result.artifactId.split('/').pop();
      return { type: 'text', text: `Variant saved: variant_id="${variantId}" (${result.artifactId})\nUse this variant_id when calling finish.\nStats: median=${stats.median.toFixed(6)}, uniformity=${uni.score.toFixed(6)}` };
    }
  },

  load_variant: {
    category: 'artifacts',
    definition: {
      name: 'load_variant',
      description: 'Load a previously saved variant back into PixInsight.',
      input_schema: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string', description: 'Full artifact ID (runId/agent/variant_XX)' }
        },
        required: ['artifact_id']
      }
    },
    handler: async (ctx, store, _brief, input) => {
      const meta = await store.loadVariant(ctx, input.artifact_id);
      return { type: 'text', text: `Loaded: ${input.artifact_id} (view: ${meta.viewId})` };
    }
  },

  load_prior_winner: {
    category: 'artifacts',
    definition: {
      name: 'load_prior_winner',
      description: 'Open the FINAL winning composition of a PREVIOUS run into PixInsight (cross-run). Use to A/B against, or graft a region from, a prior result. Returns the loaded view ID.',
      input_schema: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'Run ID of the prior run (e.g. run_2026-06-20_ab12cd34)' },
          view_id: { type: 'string', description: 'Optional ID to rename the loaded view to (default: prior_winner)' }
        },
        required: ['run_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const { resolveBaseWinner } = await import('./warmstart.mjs');
      let xisfPath, selection;
      try { ({ xisfPath, selection } = resolveBaseWinner(input.run_id)); }
      catch (e) { return { type: 'text', text: `Cannot load prior winner: ${e.message}` }; }
      const r = await ctx.send('open_image', '__internal__', { filePath: xisfPath });
      if (r.status === 'error') return { type: 'text', text: `Failed to open ${xisfPath}: ${r.error?.message}` };
      const loadedId = r.outputs?.id;
      const targetId = input.view_id || 'prior_winner';
      const imgs = await ctx.listImages();
      for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
      }
      if (loadedId && loadedId !== targetId) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${loadedId}');if(!w.isNull)w.mainView.id='${targetId}';`);
      }
      return { type: 'text', text: `Prior winner loaded as view="${targetId}" (run ${input.run_id}, variant ${selection.variant_id}).` };
    }
  },

  recall_champion: {
    category: 'artifacts',
    definition: {
      name: 'recall_champion',
      description: 'Open the cross-run CHAMPION image for a quality dimension and the current target classification. Dimensions: ifn_visibility, core_integrity, color_richness, star_quality, detail. The champion is a finished image from a PRIOR run that scored best on that dimension for this target class. Returns the opened view ID so you can graft its strong region into your composition (via blend_regions / star_protected_blend). NOTE: a champion may have a different crop/geometry — align/resample before per-pixel blending. Returns a "no champion" message if none recorded yet.',
      input_schema: {
        type: 'object',
        properties: {
          dimension: { type: 'string', enum: ['ifn_visibility', 'core_integrity', 'color_richness', 'star_quality', 'detail'], description: 'Which quality dimension to recall the best prior image for.' }
        },
        required: ['dimension']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const classif = brief?.target?.classification || '';
      const champs = getChampions(classif);
      const c = champs[input.dimension];
      if (!c) return { type: 'text', text: `No cross-run champion recorded for ${classif || 'unknown'}/${input.dimension} yet. Process this dimension from scratch.` };
      if (!fs.existsSync(c.xisfPath)) return { type: 'text', text: `Champion XISF missing on disk: ${c.xisfPath} (run ${c.run_id} likely pruned). Process from scratch.` };
      const r = await ctx.send('open_image', '__internal__', { filePath: c.xisfPath });
      if (r.status === 'error') return { type: 'text', text: `Failed to open champion: ${r.error?.message}` };
      const imgs = await ctx.listImages();
      for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
      }
      const loadedId = r.outputs?.id;
      const champId = `champ_${input.dimension}`;
      if (loadedId && loadedId !== champId) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${loadedId}');if(!w.isNull)w.mainView.id='${champId}';`);
      }
      return { type: 'text', text: `Champion opened: view="${champId}" dimension=${input.dimension} score=${(c.score ?? 0).toFixed(4)} from run ${c.run_id} (${c.variant_id}). Graft its strong region into your composition; align/resample first if geometry differs.` };
    }
  },

  list_variants: {
    category: 'artifacts',
    definition: {
      name: 'list_variants',
      description: 'List all saved variants for the current agent.',
      input_schema: { type: 'object', properties: {} }
    },
    handler: async (_ctx, store, _brief, _input, agentName) => {
      const variants = store.listVariants(agentName);
      const summary = variants.map(v =>
        `${v.variantId}: median=${v.metrics?.median?.toFixed(6) || '?'}, uniformity=${v.metrics?.uniformity?.toFixed(6) || '?'}`
      ).join('\n');
      return { type: 'text', text: summary || 'No variants saved yet.' };
    }
  },

  // --- LRGB combine ---
  lrgb_combine: {
    category: 'lrgb',
    definition: {
      name: 'lrgb_combine',
      description: 'Combine a processed luminance channel with the RGB image via luminance replacement. This dramatically improves detail and reveals faint structure (IFN). The L channel should be stretched and enhanced before combining. lightness=0.55 for spirals, 0.35 for edge-on. CRITICAL: L must be LinearFit to RGB luminance first to avoid veil effect.',
      input_schema: {
        type: 'object',
        properties: {
          rgb_id: { type: 'string', description: 'RGB color image view ID' },
          l_id: { type: 'string', description: 'Processed luminance view ID (must be grayscale, stretched)' },
          lightness: { type: 'number', description: 'Luminance weight (0.0-1.0, default 0.55 for spirals, 0.35 for edge-on)' },
          saturation: { type: 'number', description: 'Saturation preservation (0.0-1.0, default 0.80)' }
        },
        required: ['rgb_id', 'l_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      let lightness = input.lightness ?? 0.55;
      const saturation = input.saturation ?? 0.80;

      // PROFILE ENFORCEMENT: cap lightness for galaxies to prevent core burn
      const classifLrgb = brief?.target?.classification || '';
      if (classifLrgb.startsWith('galaxy')) {
        const profileLightness = brief?.processingProfile?.tools?.LRGB?.lightness ?? 0.55;
        const maxLightness = Math.min(profileLightness, 0.50); // never exceed 0.50 for galaxies
        if (lightness > maxLightness) {
          process.stderr.write(`[lrgb_combine] GALAXY CAP: lightness ${lightness} → ${maxLightness} (profile limit for ${classifLrgb})\n`);
          lightness = maxLightness;
        }
      }

      // Step 1: LinearFit L to RGB luminance (prevents veil effect)
      await ctx.pjsr(`
        var rgbW = ImageWindow.windowById('${input.rgb_id}');
        var lW = ImageWindow.windowById('${input.l_id}');
        if (rgbW.isNull) throw new Error('RGB not found: ${input.rgb_id}');
        if (lW.isNull) throw new Error('L not found: ${input.l_id}');

        // Extract RGB luminance for LinearFit reference
        var img = rgbW.mainView.image;
        var w = img.width, h = img.height;
        var lumRef = new ImageWindow(w, h, 1, 32, true, false, 'lrgb_lum_ref');
        lumRef.show();
        var PM = new PixelMath;
        PM.expression = '0.2126*${input.rgb_id}[0] + 0.7152*${input.rgb_id}[1] + 0.0722*${input.rgb_id}[2]';
        PM.useSingleExpression = true;
        PM.createNewImage = false;
        PM.executeOn(lumRef.mainView);

        // LinearFit L to RGB luminance
        var LF = new LinearFit;
        LF.referenceViewId = 'lrgb_lum_ref';
        LF.rejectHigh = 0.92;
        LF.executeOn(lW.mainView);

        lumRef.forceClose();
        'LinearFit done';
      `);

      // Step 2: Native LRGBCombination
      // executeOn() requires channel views named {target}_L, {target}_R, etc.
      // So we extract RGB channels and clone L with the expected names.
      const tgt = input.rgb_id;
      await ctx.pjsr(`
        var CE = new ChannelExtraction;
        CE.channelEnabled = [true, true, true];
        CE.channelId = ['${tgt}_R', '${tgt}_G', '${tgt}_B'];
        CE.colorSpace = ChannelExtraction.prototype.RGB;
        CE.sampleFormat = ChannelExtraction.prototype.SameAsSource;
        CE.executeOn(ImageWindow.windowById('${tgt}').mainView);
        'channels extracted';
      `);

      // Clone L to {target}_L (don't rename the original)
      await ctx.pjsr(`
        var src = ImageWindow.windowById('${input.l_id}');
        var img = src.mainView.image;
        var dst = new ImageWindow(img.width, img.height, 1, 32, true, false, '${tgt}_L');
        dst.show();
        var PM = new PixelMath;
        PM.expression = '${input.l_id}';
        PM.useSingleExpression = true;
        PM.createNewImage = false;
        PM.executeOn(dst.mainView);
        'L cloned';
      `);

      const r = await ctx.pjsr(`
        var P = new LRGBCombination;
        P.channelL = [true, '${tgt}_L'];
        P.channelR = [true, '${tgt}_R'];
        P.channelG = [true, '${tgt}_G'];
        P.channelB = [true, '${tgt}_B'];
        P.lightness = ${lightness};
        P.saturation = ${saturation};
        P.noiseReduction = false;
        var ret = P.executeOn(ImageWindow.windowById('${tgt}').mainView);
        ret ? 'LRGB_OK' : 'LRGB_FAILED';
      `);

      // Clean up temp channel views
      await ctx.pjsr(`
        var ids = ['${tgt}_R','${tgt}_G','${tgt}_B','${tgt}_L'];
        for (var i = 0; i < ids.length; i++) {
          var w = ImageWindow.windowById(ids[i]);
          if (!w.isNull) w.forceClose();
        }
        'cleaned up';
      `);

      const lrgbOut = r.outputs?.consoleOutput?.trim() || '';
      let method = 'LRGBCombination';
      if (r.status === 'error' || lrgbOut.includes('LRGB_FAILED')) {
        // Fallback: PixelMath luminance replacement (saturation not supported)
        method = 'PixelMath fallback';
        await ctx.pjsr(`
          var PM = new PixelMath;
          PM.expression = "Yo = 0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2]; Yb = (1-${lightness})*Yo + ${lightness}*${input.l_id}; ratio = min(max(Yb, 0.00001) / max(Yo, 0.00001), 3.0); $T * ratio";
          PM.symbols = "Yo, Yb, ratio";
          PM.useSingleExpression = true;
          PM.use64BitWorkingImage = true;
          PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
          PM.createNewImage = false;
          PM.executeOn(ImageWindow.windowById('${input.rgb_id}').mainView);
        `);
      }

      const stats = await getStats(ctx, input.rgb_id);
      return { type: 'text', text: `LRGB combined via ${method} (lightness=${lightness}, saturation=${saturation}). ${statsLine(stats)}` };
    }
  },

  // --- Ha injection ---
  ha_inject_red: {
    category: 'ha_injection',
    definition: {
      name: 'ha_inject_red',
      description: 'Inject Ha signal into the red channel of the target image. Uses conditional boost: only adds Ha where it exceeds the red channel by a threshold. strength controls how much Ha to add.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target RGB view ID' },
          ha_id: { type: 'string', description: 'Ha view ID (must be same dimensions, stretched to similar range)' },
          strength: { type: 'number', description: 'Ha injection strength (0.0-1.0, recommend 0.20-0.40)' },
          brightness_limit: { type: 'number', description: 'Only inject where Ha exceeds this fraction of red channel (0.0-0.50, default 0.25)' },
          max_output: { type: 'number', description: 'Soft-clamp R channel output. Values above this are compressed with 20% rolloff to prevent burnt Ha spots. Default 0.85. Range 0.70-0.95.' }
        },
        required: ['target_id', 'ha_id', 'strength']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const str = input.strength ?? 0.30;
      const limit = input.brightness_limit ?? 0.25;
      const maxOut = input.max_output ?? 0.85;
      // Conditional R-channel boost with soft-clamp: add Ha where it exceeds R by limit fraction,
      // then compress values above maxOut with a soft knee to prevent burnt Ha spots.
      // PixelMath: compute raw injection, then apply soft-clamp inline (no variables in PM expressions).
      // Soft-clamp: iif(raw > maxOut, maxOut + (raw - maxOut) * 0.20, raw)
      // We duplicate the raw expression in the outer iif — verbose but correct for PM.
      const rawExpr = `iif(${input.ha_id} > ${input.target_id}[0] * (1 + ${limit}), ${input.target_id}[0] + ${str} * (${input.ha_id} - ${input.target_id}[0]), ${input.target_id}[0])`;
      const clampedExpr = `iif(${rawExpr} > ${maxOut}, ${maxOut} + (${rawExpr} - ${maxOut}) * 0.20, ${rawExpr})`;
      await ctx.pjsr(`
        var PM = new PixelMath;
        PM.expression = "${clampedExpr.replace(/"/g, '\\"')}";
        PM.expression1 = "${input.target_id}[1]";
        PM.expression2 = "${input.target_id}[2]";
        PM.useSingleExpression = false;
        PM.use64BitWorkingImage = true;
        PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
        PM.createNewImage = false;
        PM.executeOn(ImageWindow.windowById('${input.target_id}').mainView);
      `);
      const stats = await getStats(ctx, input.target_id);
      // Check per-channel max to warn about potential burning
      const chStats = await ctx.pjsr(`
        var w = ImageWindow.windowById('${input.target_id}');
        var img = w.mainView.image;
        img.selectedChannel = 0; var rMax = img.maximum();
        img.resetChannelSelection();
        JSON.stringify({ rMax: rMax });
      `);
      let rMaxInfo = '';
      try {
        const ch = JSON.parse(chStats.outputs?.consoleOutput || '{}');
        rMaxInfo = ` R_max=${ch.rMax?.toFixed(4) || 'N/A'}`;
        if (ch.rMax > 0.92) rMaxInfo += ' ⚠️ R channel near clipping — reduce Ha strength or max_output';
      } catch {}
      return { type: 'text', text: `Ha injected into red channel (strength=${str}, limit=${limit}, max_output=${maxOut}).${rMaxInfo} ${statsLine(stats)}` };
    }
  },

  ha_inject_luminance: {
    category: 'ha_injection',
    definition: {
      name: 'ha_inject_luminance',
      description: 'Blend Ha into the luminance of the target image. Adds Ha detail where it exceeds the current luminance. More subtle than red channel injection.',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target RGB view ID' },
          ha_id: { type: 'string', description: 'Ha view ID' },
          strength: { type: 'number', description: 'Blend strength (0.0-0.50, recommend 0.15-0.30)' }
        },
        required: ['target_id', 'ha_id', 'strength']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const str = input.strength ?? 0.20;
      // Luminance overlay: Y_new = Y_old + strength * max(Ha - Y_old, 0)
      await ctx.pjsr(`
        var PM = new PixelMath;
        PM.expression = "$T + ${str} * max(${input.ha_id} - (0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2]), 0) * $T / max(0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2], 0.00001)";
        PM.useSingleExpression = true;
        PM.use64BitWorkingImage = true;
        PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
        PM.createNewImage = false;
        PM.executeOn(ImageWindow.windowById('${input.target_id}').mainView);
      `);
      return { type: 'text', text: `Ha luminance blended (strength=${str})` };
    }
  },

  // --- Narrowband Enhancement ---
  extract_pseudo_oiii: {
    category: 'narrowband',
    definition: {
      name: 'extract_pseudo_oiii',
      description: 'Extract pseudo-OIII emission from B channel by subtracting scaled R continuum. Creates a mono view of OIII signal. For emission objects (PNe, HII regions) where OIII data is in the broadband B filter. Use with dynamic_narrowband_blend for rich dual-zone color.',
      input_schema: {
        type: 'object',
        properties: {
          rgb_id: { type: 'string', description: 'Source RGB view ID' },
          continuum_factor: { type: 'number', description: 'R scaling factor for continuum (0.10-0.50, default 0.25). Higher = more aggressive continuum removal.' },
          output_id: { type: 'string', description: 'Output view ID (default: OIII_pseudo)' }
        },
        required: ['rgb_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await extractPseudoOIII(ctx, input.rgb_id, input.continuum_factor ?? 0.25, input.output_id ?? 'OIII_pseudo');
      return { type: 'text', text: `Pseudo-OIII extracted: ${result.viewId} (median=${result.median?.toFixed(6)}, max=${result.max?.toFixed(4)})` };
    }
  },

  continuum_subtract_ha: {
    category: 'narrowband',
    definition: {
      name: 'continuum_subtract_ha',
      description: 'Remove broadband continuum from Ha to isolate pure emission. Ha_pure = max(0, Ha - factor*R). Reduces star contamination and sharpens emission structures. Apply BEFORE Ha injection for cleaner results.',
      input_schema: {
        type: 'object',
        properties: {
          ha_id: { type: 'string', description: 'Ha view ID (mono)' },
          rgb_id: { type: 'string', description: 'RGB view ID (for R channel continuum reference)' },
          continuum_factor: { type: 'number', description: 'Scaling factor (0.20-0.40, default 0.28). Test in 0.02 increments.' }
        },
        required: ['ha_id', 'rgb_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await continuumSubtractHa(ctx, input.ha_id, input.rgb_id, input.continuum_factor ?? 0.28);
      return { type: 'text', text: `Ha continuum-subtracted (factor=${input.continuum_factor ?? 0.28}). median=${result.median?.toFixed(6)}, max=${result.max?.toFixed(4)}` };
    }
  },

  dynamic_narrowband_blend: {
    category: 'narrowband',
    definition: {
      name: 'dynamic_narrowband_blend',
      description: 'Inject Ha and OIII (real or pseudo) into RGB using dynamic weighting formula. Creates natural dual-zone color: Ha-dominant regions become red/pink, OIII-dominant regions become teal/blue, with smooth transitions. The community-proven formula f=(OIII*Ha)^(1-OIII*Ha) weights the green channel dynamically. Includes soft-clamp to prevent burning. Applied through a luminance mask to protect background from blue contamination (OIII noise residuals in B-R subtraction).',
      input_schema: {
        type: 'object',
        properties: {
          target_id: { type: 'string', description: 'Target RGB view ID (modified in place)' },
          ha_id: { type: 'string', description: 'Ha view ID (mono)' },
          oiii_id: { type: 'string', description: 'OIII view ID (real or pseudo, mono)' },
          ha_strength: { type: 'number', description: 'Ha injection into R (0.10-0.50, default 0.35)' },
          oiii_strength: { type: 'number', description: 'OIII injection into B (0.10-0.60, default 0.40)' },
          g_strength: { type: 'number', description: 'OIII contribution to G (0.10-0.40, default 0.30)' },
          max_output: { type: 'number', description: 'Soft-clamp per channel (0.80-0.95, default 0.90)' },
          mask_clip: { type: 'number', description: 'Luminance mask clip threshold — pixels below this value are excluded from the blend (protects background from blue contamination). Lower = more inclusive, higher = tighter mask. (0.01-0.10, default 0.04)' }
        },
        required: ['target_id', 'ha_id', 'oiii_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await dynamicNarrowbandBlend(ctx, input.target_id, input.ha_id, input.oiii_id, {
        ha_strength: input.ha_strength,
        oiii_strength: input.oiii_strength,
        g_strength: input.g_strength,
        max_output: input.max_output,
        mask_clip: input.mask_clip
      });
      let warn = '';
      if (result.rMax > 0.92) warn += ' ⚠️ R hot';
      if (result.bMax > 0.92) warn += ' ⚠️ B hot';
      return { type: 'text', text: `Narrowband blend applied. median=${result.median?.toFixed(6)}, R_max=${result.rMax?.toFixed(4)}, B_max=${result.bMax?.toFixed(4)}${warn}` };
    }
  },

  create_synthetic_luminance: {
    category: 'narrowband',
    definition: {
      name: 'create_synthetic_luminance',
      description: 'Create synthetic luminance from Ha + OIII blend. For emission objects, this gives better nebula contrast than broadband L. Creates a new mono view. Use as L source for PixelMath L enhancement.',
      input_schema: {
        type: 'object',
        properties: {
          ha_id: { type: 'string', description: 'Ha view ID (mono)' },
          oiii_id: { type: 'string', description: 'OIII view ID (real or pseudo, mono)' },
          ha_weight: { type: 'number', description: 'Ha contribution (0.0-1.0, default 0.50)' },
          oiii_weight: { type: 'number', description: 'OIII contribution (0.0-1.0, default 0.50)' },
          output_id: { type: 'string', description: 'Output view ID (default: SYNTH_L)' }
        },
        required: ['ha_id', 'oiii_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await createSyntheticLuminance(ctx, input.ha_id, input.oiii_id, input.ha_weight ?? 0.50, input.oiii_weight ?? 0.50, input.output_id ?? 'SYNTH_L');
      return { type: 'text', text: `Synthetic luminance: ${result.viewId} (median=${result.median?.toFixed(6)}, max=${result.max?.toFixed(4)})` };
    }
  },

  create_zone_masks: {
    category: 'narrowband',
    definition: {
      name: 'create_zone_masks',
      description: 'Create 3-zone masks for planetary nebulae: core (bright center), shell (main nebula body), halo (faint outer structure). Each zone gets a separate Gaussian-blurred mask for independent processing. Apply LHE with different amounts per zone, or enhance halo independently.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Source view to derive masks from' },
          core_clip: { type: 'number', description: 'Core threshold (default 0.40)' },
          shell_clip: { type: 'number', description: 'Shell threshold (default 0.15)' },
          halo_clip: { type: 'number', description: 'Halo threshold (default 0.04)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await createZoneMasks(ctx, input.view_id, {
        core_clip: input.core_clip,
        shell_clip: input.shell_clip,
        halo_clip: input.halo_clip
      });
      return { type: 'text', text: `Zone masks created: ${result.coreId} (>${result.thresholds.core}), ${result.shellId} (${result.thresholds.shell}-${result.thresholds.core}), ${result.haloId} (${result.thresholds.halo}-${result.thresholds.shell})` };
    }
  },

  continuous_clamp: {
    category: 'narrowband',
    definition: {
      name: 'continuous_clamp',
      description: 'Apply smooth brightness control that varies by brightness — bright cores compressed harder, faint regions barely affected. Uses a single smooth luminance mask with large blur. ZERO mask boundary artifacts.\n\nDefault mode is SOFT COMPRESSION (exponential saturation): values above the per-pixel knee are smoothly compressed, preserving relative brightness. A pixel at 0.90 and one at 0.85 remain distinguishable — gradients and detail are preserved. Hard mode (legacy) flattens everything above knee to a single value, destroying internal detail.\n\nCore (brightest) gets knee near min_clamp (default 0.80), shell (~0.5 brightness) near midpoint, background (faint) near max_clamp (default 0.95).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Target view to clamp (modified in place)' },
          min_clamp: { type: 'number', description: 'Knee level for brightest regions (default 0.80). Lower = harder compression on core.' },
          max_clamp: { type: 'number', description: 'Knee level for faintest regions (default 0.95). Higher = less effect on background.' },
          blur_sigma: { type: 'number', description: 'Gaussian blur sigma for luminance mask (default: auto = max(60, imageWidth/100)). Larger = smoother transitions.' },
          mode: { type: 'string', enum: ['soft', 'hard'], description: 'soft (default): exponential compression preserving detail. hard: legacy min() clamp that flattens to knee.' },
          headroom: { type: 'number', description: 'Soft mode only: how far above knee the output can reach (default 0.12). Higher = more dynamic range preserved above knee.' },
          rate: { type: 'number', description: 'Soft mode only: compression steepness (default 3.0). Higher = sharper rolloff at knee. 2.0 = gentle, 5.0 = aggressive.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await continuousClamp(ctx, input.view_id, {
        min_clamp: input.min_clamp,
        max_clamp: input.max_clamp,
        blur_sigma: input.blur_sigma,
        mode: input.mode,
        headroom: input.headroom,
        rate: input.rate
      });
      return { type: 'text', text: `Continuous clamp applied (${result.mode} mode): median=${result.median?.toFixed(6)}, max=${result.max?.toFixed(4)}, range=[${result.clampRange?.[0]}, ${result.clampRange?.[1]}], blur_sigma=${result.blur_sigma}${result.mode === 'soft' ? `, headroom=${result.headroom}, rate=${result.rate}` : ''}` };
    }
  },

  // --- Memory ---
  recall_memory: {
    category: 'memory',
    definition: {
      name: 'recall_memory',
      description: 'Read hierarchical memory from previous runs. Returns knowledge at 5 levels: universal rules, trait-level strategies (e.g. core_halo masking), type-level defaults (e.g. galaxy_spiral LHE), data-class parameters, and target-specific overrides. ALWAYS call this at the start.',
      input_schema: { type: 'object', properties: {} }
    },
    handler: async (_ctx, _store, brief, _input, agentName) => {
      // Try hierarchical memory first
      try {
        const { recallForBrief } = await import('../memory/hierarchical-memory.mjs');
        const result = recallForBrief(brief);
        const total = result.universal.length + result.trait.length + result.type.length +
          result.data_class.length + result.target.length;
        if (total > 0) {
          return { type: 'text', text: `## Hierarchical Memory (${total} entries across 5 levels)\n\n${result.summary}` };
        }
      } catch (e) {
        // Fall through to legacy
      }
      // Fallback: legacy flat memory
      const memDir = path.join(os.homedir(), '.pixinsight-mcp', 'agent-memory');
      const memFile = path.join(memDir, `${agentName}.json`);
      if (!fs.existsSync(memFile)) return { type: 'text', text: 'No memories yet. This is your first run.' };
      const entries = JSON.parse(fs.readFileSync(memFile, 'utf-8'));
      const summary = entries.map(e => `[${e.date || e.timestamp?.slice(0,10)}] **${e.title}**: ${e.content}`).join('\n\n');
      return { type: 'text', text: `## Legacy memories (${entries.length} entries)\n\n${summary}` };
    }
  },

  save_memory: {
    category: 'memory',
    definition: {
      name: 'save_memory',
      description: 'Save a lesson or insight to hierarchical memory. Specify the level: "universal" (applies to all), "trait" (applies to targets with a specific trait like core_halo), "type" (applies to a target classification), "data_class" (applies to similar data), "target" (applies to this specific target). Include param name and value for quantitative memories so the optimizer can track and promote them.',
      input_schema: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['universal', 'trait', 'type', 'data_class', 'target'], description: 'Memory hierarchy level' },
          key: { type: 'string', description: 'Scope key: trait name, classification, data class, or target name. Ignored for universal.' },
          title: { type: 'string', description: 'Short title' },
          content: { type: 'string', description: 'Detailed lesson' },
          param: { type: 'string', description: 'Parameter name if this is a quantitative memory (e.g. "lhe_large_amount")' },
          value: { description: 'Parameter value (e.g. 0.35)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Additional tags' }
        },
        required: ['title', 'content']
      }
    },
    handler: async (_ctx, _store, brief, input, agentName) => {
      try {
        const { saveEntry } = await import('../memory/hierarchical-memory.mjs');
        const level = input.level || 'target';
        const key = input.key || brief?.target?.name || agentName;
        const entry = saveEntry(level, key, {
          title: input.title,
          content: input.content,
          param: input.param,
          value: input.value,
          tags: input.tags || [],
          classification: brief?.target?.classification,
        }, brief);
        return { type: 'text', text: `Memory saved at ${level} level (key: ${key}): "${input.title}"` };
      } catch (e) {
        // Fallback: legacy save
        const memDir = path.join(os.homedir(), '.pixinsight-mcp', 'agent-memory');
        fs.mkdirSync(memDir, { recursive: true });
        const memFile = path.join(memDir, `${agentName}.json`);
        let entries = [];
        if (fs.existsSync(memFile)) entries = JSON.parse(fs.readFileSync(memFile, 'utf-8'));
        entries.push({ title: input.title, content: input.content, tags: input.tags || [], timestamp: new Date().toISOString() });
        fs.writeFileSync(memFile, JSON.stringify(entries, null, 2));
        return { type: 'text', text: `Memory saved (legacy): "${input.title}"` };
      }
    }
  },

  // --- Control ---
  finish: {
    category: 'control',
    definition: {
      name: 'finish',
      description: 'Signal that you are done processing. You MUST provide a variant_id from a previous save_variant call — this is the durable artifact that will be exported. The variant must exist on disk. Quality gates run automatically on the view_id — if any FAIL, finish is REJECTED. Save your final image as a variant BEFORE calling finish.',
      input_schema: {
        type: 'object',
        properties: {
          variant_id: { type: 'string', description: 'REQUIRED: variant_id from save_variant (e.g. "variant_21"). This is the artifact that will be exported.' },
          view_id: { type: 'string', description: 'View ID for quality gate checks (must still be open in PixInsight). If omitted, uses the view from the variant metadata.' },
          rationale: { type: 'string', description: 'Explain why this is your best result and what trade-offs you made' },
          params_summary: { type: 'object', description: 'Key parameters used in the winning approach' }
        },
        required: ['variant_id', 'rationale']
      }
    },
    handler: async (ctx, store, brief, input, agentName) => {
      // === VARIANT VALIDATION ===
      // The variant_id is the source of truth for export.
      const variantId = input.variant_id;
      let variantMeta = null;

      if (variantId && store) {
        variantMeta = store.getVariantById(agentName, variantId);
        if (!variantMeta) {
          return {
            type: 'text',
            text: `FINISH REJECTED: variant_id="${variantId}" not found on disk. ` +
              `Call save_variant first to save your final image, then use the returned variant_id.`
          };
        }
        // Verify the XISF file actually exists
        if (!fs.existsSync(variantMeta.xisfPath)) {
          return {
            type: 'text',
            text: `FINISH REJECTED: variant_id="${variantId}" metadata exists but XISF file is missing at ${variantMeta.xisfPath}. ` +
              `Re-save the variant with save_variant.`
          };
        }
      }

      // Resolve view_id for quality gate checks
      // Prefer explicit view_id, fall back to the variant's source view
      const viewId = input.view_id || variantMeta?.viewId;
      if (!viewId) {
        return {
          type: 'text',
          text: `FINISH REJECTED: no view_id provided and variant has no source viewId. ` +
            `Provide view_id for quality gate checks.`
        };
      }

      const stats = await getStats(ctx, viewId);

      // === BUDGET-AWARE GATE RELAXATION ===
      // In emergency budget, relax non-safety gates to allow finish
      const budget = brief?._budget || {};
      const isEmergency = (budget.turnsRemaining ?? 999) <= 10;

      // === QUALITY GATE ENFORCEMENT ===
      // Run automated quality checks — agent cannot bypass these
      const failures = [];
      const warnings = [];
      // B3a: collect the per-dimension metric objects from the gates below so the
      // promoted winner can be recorded as a cross-run champion at finish.
      let champStars = null, champCore = null, champDetail = null, champSat = null, champDust = null;
      if (isEmergency) {
        warnings.push(`EMERGENCY BUDGET: ${budget.turnsRemaining} turns remaining. Non-safety gates relaxed to allow finish.`);
      }

      // Gate 1: Star quality (FWHM + color + brightness)
      // FWHM and color are advisory (native PSF can exceed 6px).
      // Brightness is BLOCKING — dim stars are always a failure when the profile asks for prominent/balanced.
      try {
        const starResult = await checkStarQuality(ctx, viewId);
        champStars = starResult;
        const prominence = brief?.processingProfile?.stars?.prominence || 'balanced';
        const minContrast = prominence === 'prominent' ? 4.0 : prominence === 'subdued' ? 2.0 : 3.0;
        const brightnessOk = (starResult.starBgContrast || 0) >= minContrast;

        if (!brightnessOk) {
          const msg = `STARS TOO DIM: contrast=${(starResult.starBgContrast || 0).toFixed(1)}× vs background (limit: ${minContrast}× for ${prominence} stars), ` +
            `median peak=${(starResult.medianPeak || 0).toFixed(3)}, bg=${(starResult.bgMedian || 0).toFixed(4)}. ` +
            `FIX: increase star_protected_blend strength, use brighter stretch_stars params (lower setiMidtone or more iterations), or boost star layer with curves before blending.`;
          if (isEmergency) {
            warnings.push(`[RELAXED] ${msg}`);
          } else {
            failures.push(msg);
          }
        }
        // FWHM > 12px is blocking — but NOT for galaxies (galaxy knots/HII regions
        // are detected as "stars" with inflated FWHM, causing false positives)
        const isGalaxyTarget = (brief?.target?.classification || '').startsWith('galaxy');
        if ((starResult.medianFWHM || 0) > 12.0 && !isGalaxyTarget) {
          const fwhmMsg = `STARS SEVERELY BLOATED: FWHM=${(starResult.medianFWHM || 0).toFixed(1)}px (hard limit: 12px). ` +
            `Stars are unacceptably large. Re-stretch stars with higher setiMidtone (0.25+) or fewer iterations, ` +
            `apply stronger rolloff, or reduce star_protected_blend strength.`;
          if (isEmergency) {
            warnings.push(`[RELAXED] ${fwhmMsg}`);
          } else {
            failures.push(fwhmMsg);
          }
        }
        // For galaxies, FWHM is advisory (galaxy knots inflate the measurement)
        // For non-galaxies with moderate FWHM, also advisory
        if (!starResult.pass && brightnessOk) {
          const fwhmNote = isGalaxyTarget ? ' (advisory for galaxies — HII knots inflate FWHM)' : '';
          warnings.push(`STAR QUALITY WARNING: ${starResult.details}${fwhmNote}`);
        }
      } catch (e) {
        // If star check errors out (e.g. no stars in starless image), skip gracefully
        // This handles the case where finish is called on a starless view
      }

      // Gate 2: Ringing detection — category-aware (non-blocking for galaxies with natural radial profiles)
      try {
        const ringingResult = await checkRinging(ctx, viewId);
        const category = brief?.target?.classification || 'unknown';
        const morphologyConflict = ['galaxy_edge_on', 'galaxy_spiral', 'galaxy_cluster'].includes(category);
        if (!ringingResult.pass && !morphologyConflict) {
          warnings.push(`RINGING WARNING: ${ringingResult.details}`);
        }
      } catch (e) {
        // If ringing check fails to execute, warn but don't block
        warnings.push(`RINGING CHECK ERROR: ${e.message} — inspect manually`);
      }

      // Gate 3: Burn scan — HARD FAIL at 0.95 (actual clipping)
      // Gate 3b: Bright block fraction — HARD FAIL if too many blocks above 0.80
      // v13 showed aggressive clamping destroys core detail, so a FEW bright blocks are OK.
      // But when a large fraction of the image is above 0.80 (e.g. entire nebula shell),
      // detail is being lost across extended structure. Per-profile limit controls this.
      try {
        const burnResult = await scanBurntRegions(ctx, viewId); // threshold 0.95
        if (!burnResult.pass) {
          failures.push(`BURN SCAN FAILED: ${burnResult.details}`);
        }
        // Bright block fraction gate at 0.80
        const softBurn = await scanBurntRegions(ctx, viewId, { threshold: 0.80 });
        if (!softBurn.pass) {
          const totalBlocks = softBurn.totalBlocks || 1;
          const brightPct = (softBurn.burntBlockCount / totalBlocks) * 100;
          const maxBrightPct = brief?.processingProfile?.burn?.max_bright_block_pct ?? 3.0;
          if (brightPct > maxBrightPct) {
            const msg = `TOO MANY BRIGHT REGIONS: ${softBurn.burntBlockCount} blocks (${brightPct.toFixed(1)}%) above 0.80 (limit: ${maxBrightPct}%). ` +
              `Extended structure is losing detail. Apply continuous_clamp (min_clamp=0.75, max_clamp=0.90) to recover detail in bright areas.`;
            if (isEmergency) {
              warnings.push(`[RELAXED] ${msg}`);
            } else {
              failures.push(msg);
            }
          } else {
            warnings.push(`BRIGHT REGIONS: ${softBurn.burntBlockCount} block(s) (${brightPct.toFixed(1)}%) above 0.80, within limit (${maxBrightPct}%). Core may look bright — verify internal structure is still visible.`);
          }
        }
      } catch (e) {
        // Non-blocking if check fails
      }

      // Gate 3c: Core relative contrast — catches a PERCEPTUAL burn that the
      // clipping gates (3/3b) miss: a bright core that is not clipped (peak < 0.85)
      // but reads as a flat washed-out white zone because its structure is tiny
      // relative to its brightness. Only applies when there is a real extended
      // bright core (skips starfields and all-bright frames).
      try {
        const coreC = await measureCoreContrast(ctx, viewId, brief?.target?.classification, brief?.processingProfile?.core_burn);
        champCore = coreC;
        const frac = coreC.coreFraction || 0;
        const isExtendedCore = frac >= 0.003 && frac <= 0.20;
        if (isExtendedCore && !coreC.pass) {
          const msg = `CORE PERCEPTUALLY BURNT: ${coreC.details}`;
          if (isEmergency) {
            warnings.push(`[RELAXED] ${msg}`);
          } else {
            failures.push(msg);
          }
        } else if (isExtendedCore && coreC.coreRelContrast < 0.30) {
          warnings.push(`Core contrast moderate (relContrast=${coreC.coreRelContrast.toFixed(3)}, ratio=${(coreC.ratio||0).toFixed(2)}); structure could be more visible in the bright center.`);
        }
      } catch (e) {
        // Non-blocking if check fails
      }

      // Gate 3e: IFN / brown-dust presence (dust-dominated fields, e.g. reflection
      // nebulae embedded in molecular cloud). The median floor (Gate 5) is BLIND to
      // dust distribution — the user-approved iter03 (dust fills the frame) and the
      // regressed giga run (empty black field) had IDENTICAL median 0.0784. This gate
      // keys on dust COLOR (dustMeanSat) + dust PEAKS (fieldP95) instead, validated
      // on those two images. Profile-driven: only runs when the profile declares `ifn`.
      if (brief?.processingProfile?.ifn) {
        try {
          const dust = await measureDustCoverage(ctx, viewId, brief.processingProfile.ifn);
          champDust = dust;
          if (!dust.pass) {
            const msg = `IFN/DUST GATE: ${dust.details}`;
            if (isEmergency) warnings.push(`[RELAXED] ${msg}`);
            else failures.push(msg);
          } else if (dust.details && /advisory/.test(dust.details)) {
            warnings.push(`Dust: ${dust.details}`);
          }
        } catch (e) {
          // Non-blocking if check fails
        }
      }

      // Gate 3d: Background noise — final grain check. Aggressive LHE/stretch
      // amplifies pixel-scale noise; this requires a light denoise if too grainy.
      try {
        const noiseR = await measureBackgroundNoise(ctx, viewId);
        // measureBackgroundNoise now checks BOTH dark-sky (bgNoise) AND dust-band grain
        // (dustNoise) — the latter catches grain on lifted IFN that the dark-sky-only
        // metric was structurally blind to. noiseR.pass reflects both.
        if (!noiseR.pass) {
          const msg = `BACKGROUND TOO NOISY: ${noiseR.details}`;
          if (isEmergency) warnings.push(`[RELAXED] ${msg}`);
          else failures.push(msg);
        } else if ((noiseR.bgNoise || 0) > 0.015 || (noiseR.dustNoise || 0) > 0.030) {
          warnings.push(`Slight grain (bgNoise=${(noiseR.bgNoise||0).toFixed(4)}, dustNoise=${(noiseR.dustNoise||0).toFixed(4)}). A light final NXT pass could help.`);
        }
      } catch (e) {
        // Non-blocking if check fails
      }

      // Gate 4: Subject detail — HARD GATE for brightness and contrast
      try {
        const detailResult = await measureSubjectDetail(ctx, viewId);
        champDetail = detailResult;
        if (detailResult.subjectBrightness < 0.25) {
          failures.push(`SUBJECT TOO DIM: brightness=${detailResult.subjectBrightness.toFixed(3)} (minimum: 0.25). Subjects must be clearly visible and impactful. Stretch harder, apply shadow-lifting curves, boost through masks. For PNe: outer halo must be visible.`);
        } else if (detailResult.subjectBrightness < 0.30) {
          warnings.push(`Subjects could be brighter (brightness=${detailResult.subjectBrightness.toFixed(3)}, goal: >0.35). Consider shadow-lift curves or masked brightness boost.`);
        }
        // Contrast gate: adaptive for targets with faint outer structure (PNe, IFN)
        // Halo visibility requires brighter background which inherently lowers contrast
        const contrastGate = brief?.target?.fieldCharacteristics?.faintStructureGoal === 'outer_halo' ? 2.0 : 3.0;
        const contrastGoal = contrastGate * 1.5;
        if (detailResult.contrastRatio < contrastGate) {
          failures.push(`CONTRAST TOO LOW: ratio=${detailResult.contrastRatio.toFixed(1)}× (minimum: ${contrastGate}×). Subjects don't separate from background. Use masked curves/LHE to boost subjects selectively.`);
        } else if (detailResult.contrastRatio < contrastGoal) {
          warnings.push(`Moderate contrast (ratio=${detailResult.contrastRatio.toFixed(1)}×, goal: >${contrastGoal}×). Could improve with masked luminance boost.`);
        }
        if (detailResult.detailScore < 0.001) {
          failures.push(`DETAIL TOO LOW: score=${detailResult.detailScore.toFixed(6)} (minimum: 0.001). Subjects look like smooth blobs. Apply LHE (r=32-128) through luminance masks to bring out internal structure.`);
        } else if (detailResult.detailScore < 0.003) {
          warnings.push(`Low detail score (${detailResult.detailScore.toFixed(6)}, goal: >0.005). Fine-scale LHE (r=32, r=64) through tight masks can help.`);
        }
        // Check subject coverage — tiny subjects indicate under-stretched outer structure
        const totalBlocks = detailResult.raw?.totalBlocks || 1;
        const subjectCoverage = (detailResult.subjectCount || 0) / totalBlocks;
        if (subjectCoverage < 0.02) {
          warnings.push(`Subject covers only ${(subjectCoverage * 100).toFixed(1)}% of image — outer halo/faint structure may be invisible. Consider shadow-lifting curves through inverted mask.`);
        }
      } catch (e) {
        // Non-blocking
      }

      // Gate 5: Overall exposure — composite must not be absurdly dark
      // Uses the processing profile target if available
      const targetMedian = brief?.processingProfile?.stretch?.target_median || 0.15;
      const minMedian = targetMedian * 0.35; // e.g. 0.18 * 0.35 = 0.063
      if (stats.median < minMedian) {
        failures.push(`IMAGE TOO DARK: median=${stats.median.toFixed(4)} (minimum: ${minMedian.toFixed(4)}, based on target ${targetMedian}). The overall exposure is far below target. Stretch RGB harder before LRGB, apply brightness curves, or reduce background clipping.`);
      } else if (stats.median < targetMedian * 0.5) {
        warnings.push(`Image darker than target: median=${stats.median.toFixed(4)} vs target=${targetMedian}. May be OK for small subjects in large fields, but verify outer structure is visible.`);
      }

      // Gate 6: Per-channel peak check — detect Ha burning or single-channel clipping
      // In dark images (median < 0.10), any channel peaking above 0.92 looks visually burnt
      try {
        const chPeaks = await ctx.pjsr(`
          var w = ImageWindow.windowById('${viewId}');
          var img = w.mainView.image;
          if (img.isColor) {
            img.selectedChannel = 0; var rMax = img.maximum(); var rMed = img.median();
            img.selectedChannel = 1; var gMax = img.maximum(); var gMed = img.median();
            img.selectedChannel = 2; var bMax = img.maximum(); var bMed = img.median();
            img.resetChannelSelection();
            JSON.stringify({ R: { max: rMax, med: rMed }, G: { max: gMax, med: gMed }, B: { max: bMax, med: bMed } });
          } else {
            JSON.stringify({ mono: true });
          }
        `);
        const chData = JSON.parse(chPeaks.outputs?.consoleOutput || '{}');
        if (!chData.mono) {
          for (const [ch, d] of Object.entries(chData)) {
            // Dynamic threshold: in dark images (channel median < 0.10), peak above 0.92 = burnt
            const burnThreshold = d.med < 0.10 ? 0.92 : 0.95;
            if (d.max > burnThreshold) {
              warnings.push(`${ch} CHANNEL HOT: max=${d.max.toFixed(4)} (threshold: ${burnThreshold} for median=${d.med.toFixed(4)}). ${ch === 'R' ? 'Ha injection may be too strong — reduce ha_inject_red strength or max_output.' : 'Bright region in ' + ch + ' channel needs masking.'}`);
            }
          }
        }
      } catch (e) {
        // Non-blocking
      }

      // Gate 7: Saturation naturalness — compare against per-category limit
      try {
        const satResult = await checkSaturation(ctx, viewId);
        champSat = satResult;
        if (satResult.subjectPixelCount > 100) {
          const maxP90 = brief?.processingProfile?.saturation?.max_p90 ?? 0.65;
          if (satResult.p90S > maxP90 + 0.10) {
            const prov = brief?._provenance?.get(viewId);
            const repairHint = prov?.tool === 'lrgb_combine'
              ? ` REPAIR: restore_from_clone → lrgb_combine with saturation=${Math.max(0.20, (prov.params?.saturation ?? 0.80) - 0.20).toFixed(2)}. Do NOT desaturate the combined result.`
              : ' Reduce saturation at the source (curves, LRGB params, Ha injection).';
            const msg = `OVER-SATURATED: P90=${satResult.p90S.toFixed(3)} (limit: ${(maxP90 + 0.10).toFixed(2)}, profile max_p90=${maxP90.toFixed(2)}).${repairHint}`;
            if (isEmergency) {
              warnings.push(`[RELAXED] ${msg}`);
            } else {
              failures.push(msg);
            }
          } else if (satResult.p90S > maxP90) {
            warnings.push(`Saturation high: P90=${satResult.p90S.toFixed(3)} (profile limit: ${maxP90.toFixed(2)}). Consider reducing saturation slightly for more natural appearance.`);
          }
        }
      } catch (e) {
        warnings.push(`Saturation check error: ${e.message} — inspect manually`);
      }

      // Gate 8: Tonal presence — subject must be impactful, not merely safe
      // Adaptive threshold: small subjects (< 3% coverage) get relaxed gate (2.5×)
      // because global tonal curves to force 3× on tiny subjects destroy the core
      try {
        const category = brief?.target?.classification || 'unknown';
        const tonalResult = await checkTonalPresence(ctx, viewId, category);
        const subjectCoverage = (tonalResult.subjectPixelCount || 0) / ((tonalResult.subjectPixelCount || 1) + 1000);
        const isSmallSubject = category.startsWith('galaxy') && subjectCoverage < 0.03;
        const tonalThreshold = isSmallSubject ? 2.5 : 3.0;
        const effectivelySubdued = tonalResult.separation < tonalThreshold;
        if (effectivelySubdued) {
          if (tonalResult.roi_confidence === 'low') {
            warnings.push(`TONAL PRESENCE advisory: subject appears subdued (separation=${tonalResult.separation.toFixed(2)}×) but ROI confidence is low — manual inspection recommended.`);
          } else {
            const msg = `TONAL PRESENCE SUBDUED: subject/background separation=${tonalResult.separation.toFixed(2)}× (need >${tonalThreshold}×${isSmallSubject ? ' — relaxed for small galaxy' : ''}). ` +
              `Subject is too dim to be impactful. Apply subject-masked midtone lift through INVERTED core mask — protect the bright core, boost only the outer body and arms.`;
            if (isEmergency) {
              warnings.push(`[RELAXED] ${msg}`);
            } else {
              failures.push(msg);
            }
          }
        } else if (tonalResult.tonal_verdict === 'aggressive') {
          warnings.push(`Tonal presence aggressive (separation=${tonalResult.separation.toFixed(2)}×). Verify no burns in bright subject areas.`);
        }
      } catch (e) {
        // Non-blocking
      }

      // Gate 9: Highlight texture — any target with bright structure
      // Detects perceptual burn (bright zones with collapsed tonal variation)
      // Originally emission-only, extended to galaxies after NGC4490 core burn
      const category = brief?.target?.classification || 'unknown';
      const hasBrightCore = brief?.processingProfile?.characteristics?.has_bright_core;
      if (category.includes('emission') || category.startsWith('galaxy') || hasBrightCore ||
          brief?.target?.fieldCharacteristics?.structuralZones === 'multi_zone') {
        try {
          // Try to find a reference checkpoint for relative comparison
          // Look for the most recent variant tagged as pre-composition reference
          let refViewId = null;
          if (store) {
            const variants = store.listVariants(agentName);
            for (let i = variants.length - 1; i >= 0; i--) {
              const notes = (variants[i].params?.notes || '').toLowerCase();
              if (notes.includes('pre_comp') || notes.includes('pre_clamp') || notes.includes('reference') || notes.includes('pre_ha')) {
                // Open the variant XISF temporarily for measurement
                try {
                  const loadResult = await ctx.pjsr(`
                    var w = ImageWindow.open('${variants[i].xisfPath.replace(/'/g, "\\'")}');
                    if (w.length > 0) { w[0].show(); JSON.stringify({ id: w[0].mainView.id }); }
                    else JSON.stringify({ error: 'failed to open' });
                  `);
                  const loadData = JSON.parse(loadResult.outputs?.consoleOutput || '{}');
                  if (loadData.id) {
                    refViewId = loadData.id;
                    break;
                  }
                } catch {}
              }
            }
          }

          const htResult = await checkHighlightTexture(ctx, viewId, {
            referenceId: refViewId
          });

          // Clean up temporarily opened reference
          if (refViewId) {
            try { await ctx.pjsr(`var w = ImageWindow.windowById('${refViewId}'); if (!w.isNull) w.forceClose();`); } catch {}
          }

          if (!htResult.pass) {
            const msg = `HIGHLIGHT TEXTURE COLLAPSED: ${htResult.details}. ` +
              `Restore pre-operation checkpoint. If after clamp: raise knee, increase headroom, or skip clamp. ` +
              `If after detail tool: switch to shell_detail_enhance or reduce amounts. Do NOT clamp harder.`;
            if (isEmergency) {
              warnings.push(`[RELAXED] ${msg}`);
            } else {
              failures.push(msg);
            }
          } else if (htResult.verdict === 'degraded') {
            warnings.push(`HIGHLIGHT TEXTURE WARNING: ${htResult.details}`);
          }
        } catch (e) {
          // Non-blocking on error
          warnings.push(`Highlight texture check error: ${e.message}`);
        }
      }

      // Gate 10: L data must be incorporated — via lrgb_combine OR PixelMath L injection
      const hasL = !!(brief?.dataDescription?.channels?.L);
      const lrgbAvoided = brief?.processingProfile?.tools?.LRGB?.use === 'avoid';
      if (hasL && !lrgbAvoided) {
        // Check trace for L incorporation (lrgb_combine OR PixelMath referencing FILTER_L)
        let lUsed = false;
        if (store) {
          try {
            const tracePath = path.join(store.baseDir, 'trace.jsonl');
            if (fs.existsSync(tracePath)) {
              const traceContent = fs.readFileSync(tracePath, 'utf-8');
              lUsed = traceContent.includes('"tool":"lrgb_combine"') ||
                      (traceContent.includes('FILTER_L') && traceContent.includes('"tool":"run_pixelmath"'));
            }
          } catch {}
        }
        if (!lUsed) {
          const msg = `L DATA NOT USED: L channel is available but was never incorporated into the composition. ` +
            `The L channel represents the majority of integration time. Use lrgb_combine OR PixelMath L injection ` +
            `(e.g., CIE Y luminance replacement with FILTER_L).`;
          if (isEmergency) {
            warnings.push(`[RELAXED] ${msg}`);
          } else {
            failures.push(msg);
          }
        }
      }

      // Gate 11: Vision aesthetic critic — a FRESH independent judge on a competition
      // rubric. BLOCKS if score < profile.min_aesthetic (default 6.0); relaxed under
      // emergency budget. Infra failures (no verdict/render error) are advisory only.
      try {
        const minAesthetic = brief?.processingProfile?.min_aesthetic ?? 6.0;
        const crit = await critiqueAesthetic(ctx, viewId, { baseDir: store?.baseDir, label: `finish_${variantId || viewId}`, maxDim: 1500, model: 'opus' });
        if (crit.error) {
          warnings.push(`AESTHETIC CRITIC SKIPPED: ${crit.error} (advisory — inspect visually).`);
        } else {
          const flawText = crit.flaws.length ? ` Flaws: ${crit.flaws.join('; ')}.` : '';
          if (crit.aesthetic_score < minAesthetic) {
            const msg = `AESTHETIC TOO LOW: independent judge scored ${crit.aesthetic_score.toFixed(1)}/10 (min ${minAesthetic.toFixed(1)}).${flawText} FIX the flaws (often over-cooked/saturated look, blown core, crushed faint structure, or bloated/erased stars), re-save the variant, and finish again.`;
            if (isEmergency) warnings.push(`[RELAXED] ${msg}`);
            else failures.push(msg);
          } else {
            warnings.push(`Aesthetic critic: ${crit.aesthetic_score.toFixed(1)}/10 (min ${minAesthetic.toFixed(1)}).${flawText}`);
          }
        }
      } catch (e) {
        warnings.push(`AESTHETIC CRITIC ERROR: ${e.message} — inspect visually.`);
      }

      // Gate 12: Reference similarity — ACTIVE ONLY when brief.reference_path is set.
      // BLOCK on color_emd > 0.25 OR coverage_delta > 0.30; else advisory. Inert
      // (entire block skipped) when no reference file is provided.
      {
        const refPath = (brief?.reference_path || '').trim();
        if (refPath && fs.existsSync(refPath)) {
          try {
            const refCmp = await compareToReference(ctx, viewId, refPath);
            if (refCmp.error) {
              warnings.push(`Reference comparison error: ${refCmp.error} — inspect manually.`);
            } else {
              const cEmd = refCmp.color_emd ?? 0;
              const covD = refCmp.coverage_delta ?? 0;
              const blockColor = cEmd > 0.25;
              const blockCoverage = covD > 0.30;
              if (blockColor || blockCoverage) {
                const parts = [];
                if (blockColor) parts.push(`color_emd=${cEmd.toFixed(3)} > 0.25 (palette diverges from reference — adjust color balance / SCNR / saturation toward the reference)`);
                if (blockCoverage) parts.push(`coverage_delta=${covD.toFixed(3)} > 0.30 (reference shows substantially MORE faint nebulosity/IFN — stretch faint structure harder or reduce denoising)`);
                const msg = `REFERENCE MISMATCH: ${parts.join('; ')}. (${refCmp.details})`;
                if (isEmergency) warnings.push(`[RELAXED] ${msg}`);
                else failures.push(msg);
              } else {
                if (cEmd > 0.12) warnings.push(`Color drifting from reference (color_emd=${cEmd.toFixed(3)}, blocking at 0.25). Nudge color balance toward the reference palette.`);
                if (covD > 0.10) warnings.push(`Reference has more faint signal (coverage_delta=${covD.toFixed(3)}, blocking at 0.30). A bit more shadow-lift on faint structure would match it better.`);
                if (refCmp.geometry_ok && refCmp.ms_ssim != null && refCmp.ms_ssim < 0.70) warnings.push(`Structural similarity to reference is low (ms_ssim=${refCmp.ms_ssim.toFixed(3)}, goal >0.70).`);
                if (!refCmp.geometry_ok) warnings.push(`Reference geometry differs — per-pixel SSIM skipped; only color_emd and coverage_delta compared.`);
              }
            }
          } catch (e) {
            warnings.push(`Reference comparison failed: ${e.message} — inspect manually.`);
          }
        }
      }

      if (failures.length > 0) {
        return {
          type: 'text',
          text: `FINISH REJECTED — Quality gates failed:\n${failures.map(f => '  - ' + f).join('\n')}\n\n` +
            `You MUST fix these issues before calling finish again.\n` +
            `Use check_star_quality and check_ringing to verify fixes.\n` +
            `Image stats: median=${stats.median.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}`
        };
      }

      // Do NOT auto-blend stars here — the agent blends stars during composition.
      try {
        const starCheck = await checkStarQuality(ctx, viewId);
        if (starCheck.starsFound < 20) {
          warnings.push(`Very few stars detected (${starCheck.starsFound}). If the image is starless, the agent may have forgotten to blend stars during composition.`);
        }
      } catch (e) {
        // Non-fatal
      }

      // === WRITE FINAL SELECTION RECORD ===
      // This is the source of truth for export — artifact-based, not view-name-based.
      if (variantMeta && store) {
        const seq = brief?._budget?.turnsUsed || 0;
        store.writeFinalSelection({
          variant_id: variantId,
          variant_path: variantMeta.xisfPath,
          agent: agentName,
          notes: variantMeta.params?.notes || input.rationale?.slice(0, 200) || '',
          finish_seq: seq,
          view_id: viewId, // for reference only — NOT used for export
        });
        process.stderr.write(`[finish] Committed final selection: ${variantId} → ${variantMeta.xisfPath}\n`);

        // B3a: record the promoted winner as a cross-run per-dimension champion.
        try {
          const classif = brief?.target?.classification || '';
          const maxP90 = brief?.processingProfile?.saturation?.max_p90 ?? 0.65;
          const dimScores = scoreVariantDimensions({ detail: champDetail, core: champCore, saturation: champSat, stars: champStars, maxP90 });
          recordChampions(classif, store, { [variantId]: { dimensionScores: dimScores, xisfPath: variantMeta.xisfPath } });
        } catch (e) { /* non-fatal */ }
      }

      const finalStats = await getStats(ctx, viewId);
      const warnText = warnings.length > 0 ? `\nWarnings:\n${warnings.map(w => '  - ' + w).join('\n')}` : '';
      return {
        type: 'text',
        text: `Finished (quality gates PASSED). Final artifact: ${variantId} (${variantMeta?.xisfPath || 'N/A'})\n` +
          `Stats: median=${finalStats.median.toFixed(6)}, max=${(finalStats.max ?? 0).toFixed(4)}${warnText}\n` +
          `Rationale: ${input.rationale}`
      };
    }
  },

  // --- Star removal ---
  run_sxt: {
    category: 'star_removal',
    definition: {
      name: 'run_sxt',
      description: 'Run StarXTerminator to separate stars from the image. On LINEAR data: use stars=true, unscreen=false — creates a star image via subtraction. On NON-LINEAR (stretched) data: use stars=true, unscreen=true — creates screen-blend-compatible stars. WARNING for galaxies: SXT leaves residuals on HII regions, spiral knots. Consider skipping for large spirals.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to extract stars from (modified in-place to become starless)' },
          is_linear: { type: 'boolean', description: 'True if image is linear (pre-stretch). Determines unscreen mode.' },
          overlap: { type: 'number', description: 'Star overlap parameter (default 0.10)' }
        },
        required: ['view_id', 'is_linear']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const beforeIds = (await ctx.listImages()).map(i => i.id);
      const unscreen = input.is_linear ? 'false' : 'true';
      const r = await ctx.pjsr(`
        var P = new StarXTerminator;
        P.stars = true;
        P.unscreen = ${unscreen};
        P.overlap = ${input.overlap ?? 0.10};
        P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
        'OK';
      `);
      if (r.status === 'error') {
        return { type: 'text', text: `SXT failed: ${r.error?.message}` };
      }
      // Find the new stars image
      const afterImgs = await ctx.listImages();
      const newImgs = afterImgs.filter(i => !beforeIds.includes(i.id));
      const starsView = newImgs.find(i => i.id.includes('stars') || i.id.includes('star'));
      const starsId = starsView?.id || `${input.view_id}_stars`;
      return { type: 'text', text: `SXT complete. Starless: ${input.view_id}, Stars: ${starsId} (unscreen=${unscreen})` };
    }
  },

  // --- Readiness ---
  open_image: {
    category: 'readiness',
    definition: {
      name: 'open_image',
      description: 'Open an XISF/FITS image file in PixInsight. Returns the view ID assigned by PixInsight. Automatically closes any crop_mask windows that come with XISF files.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the image file' }
        },
        required: ['file_path']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const r = await ctx.send('open_image', '__internal__', { filePath: input.file_path });
      if (r.status === 'error') {
        return { type: 'text', text: `Failed to open: ${r.error?.message}` };
      }
      // Close crop masks
      const imgs = await ctx.listImages();
      for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
      }
      const after = await ctx.listImages();
      const summary = after.map(i => `${i.id}: ${i.width}x${i.height} color=${i.isColor}`).join('\n');
      return { type: 'text', text: `Opened. Current images:\n${summary}` };
    }
  },

  rename_view: {
    category: 'readiness',
    definition: {
      name: 'rename_view',
      description: 'Rename an image view to a shorter or more convenient ID. Long XISF names can break PixInsight processes — rename to something like FILTER_R, FILTER_G, etc.',
      input_schema: {
        type: 'object',
        properties: {
          old_id: { type: 'string', description: 'Current view ID' },
          new_id: { type: 'string', description: 'New view ID (keep short, no spaces)' }
        },
        required: ['old_id', 'new_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await ctx.pjsr(`var w = ImageWindow.windowById('${input.old_id}'); if (!w.isNull) w.mainView.id = '${input.new_id}'; else throw new Error('View not found: ${input.old_id}');`);
      return { type: 'text', text: `Renamed ${input.old_id} → ${input.new_id}` };
    }
  },

  get_image_dimensions: {
    category: 'readiness',
    definition: {
      name: 'get_image_dimensions',
      description: 'Get dimensions, channel count, and color status for one or more views. Essential to check before ChannelCombination — all channels must have identical dimensions.',
      input_schema: {
        type: 'object',
        properties: {
          view_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'View IDs to check'
          }
        },
        required: ['view_ids']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const ids = input.view_ids.map(id => `'${id}'`).join(',');
      const r = await ctx.pjsr(`
        var ids = [${ids}];
        var res = [];
        for (var i = 0; i < ids.length; i++) {
          var w = ImageWindow.windowById(ids[i]);
          if (!w.isNull) {
            var img = w.mainView.image;
            res.push({ id: ids[i], width: img.width, height: img.height, channels: img.numberOfChannels, isColor: img.isColor });
          } else {
            res.push({ id: ids[i], error: 'not found' });
          }
        }
        JSON.stringify(res);
      `);
      return { type: 'text', text: r.outputs?.consoleOutput || '[]' };
    }
  },

  align_to_reference: {
    category: 'readiness',
    definition: {
      name: 'align_to_reference',
      description: 'Align a target image to a reference image using StarAlignment. The target is replaced in-place with the aligned version. Use this when channel dimensions differ before ChannelCombination.',
      input_schema: {
        type: 'object',
        properties: {
          reference_id: { type: 'string', description: 'Reference view ID (will not be modified)' },
          target_id: { type: 'string', description: 'Target view ID (will be replaced with aligned version)' }
        },
        required: ['reference_id', 'target_id']
      }
    },
    handler: async (ctx, store, _brief, input) => {
      const tmpDir = path.join(store.baseDir, 'tmp_align');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpRef = path.join(tmpDir, `${input.reference_id}.xisf`);
      const tmpTgt = path.join(tmpDir, `${input.target_id}.xisf`);

      // Save reference and target to temp files (StarAlignment requires file paths)
      for (const [viewId, filePath] of [[input.reference_id, tmpRef], [input.target_id, tmpTgt]]) {
        const saveR = await ctx.pjsr(`
          var w = ImageWindow.windowById('${viewId}');
          if (w.isNull) throw new Error('View not found: ${viewId}');
          var p = '${filePath.replace(/'/g, "\\'")}';
          if (File.exists(p)) File.remove(p);
          w.saveAs(p, false, false, false, false);
          if (w.mainView.id !== '${viewId}') w.mainView.id = '${viewId}';
          'OK';
        `);
        if (saveR.status === 'error') return { type: 'text', text: `Failed to save ${viewId}: ${saveR.error?.message}` };
      }

      // Run StarAlignment
      const saResult = await ctx.pjsr(`
        var P = new StarAlignment;
        P.referenceImage = '${tmpRef.replace(/'/g, "\\'")}';
        P.referenceIsFile = true;
        P.targets = [[true, true, '${tmpTgt.replace(/'/g, "\\'")}']];
        P.outputDirectory = '${tmpDir.replace(/'/g, "\\'")}';
        P.outputPrefix = 'aligned_';
        P.outputPostfix = '';
        P.overwriteExistingFiles = true;
        P.onError = StarAlignment.prototype.Continue;
        P.useTriangles = true;
        P.polygonSides = 5;
        P.useBrightnessRelations = true;
        P.sensitivity = 0.50;
        P.noGUIMessages = true;
        P.distortionCorrection = false;
        P.generateDrizzleData = false;
        var ok = P.executeGlobal();
        'SA_result=' + ok;
      `);

      const saOk = (saResult.outputs?.consoleOutput || '').includes('true');
      if (!saOk) return { type: 'text', text: `StarAlignment failed: ${saResult.outputs?.consoleOutput || saResult.error?.message}` };

      // Find the aligned output file — must match THIS target specifically
      const expectedName = `aligned_${input.target_id}.xisf`;
      const alignedPath = path.join(tmpDir, expectedName);
      if (!fs.existsSync(alignedPath)) {
        // Fallback: look for any aligned file that was just created
        const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('aligned_'));
        if (files.length === 0) return { type: 'text', text: 'StarAlignment produced no output file' };
        // Sort by modification time, newest first
        files.sort((a, b) => fs.statSync(path.join(tmpDir, b)).mtimeMs - fs.statSync(path.join(tmpDir, a)).mtimeMs);
        // Use the most recently modified file
        const fallbackPath = path.join(tmpDir, files[0]);
        return { type: 'text', text: `Warning: Expected ${expectedName} not found. Using ${files[0]} instead. Aligned file: ${fallbackPath}` };
      }

      // Close old target, open aligned, rename
      await ctx.pjsr(`var w = ImageWindow.windowById('${input.target_id}'); if (!w.isNull) w.forceClose();`);
      await ctx.send('open_image', '__internal__', { filePath: alignedPath });

      // Close crop masks
      const imgs = await ctx.listImages();
      for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
      }

      // Find and rename the new view — look for the aligned file name specifically
      const newImgs = await ctx.listImages();
      const alignedBaseName = path.basename(alignedPath, '.xisf').replace(/[^a-zA-Z0-9_]/g, '_');
      const aligned = newImgs.find(i => i.id.includes('aligned') || i.id.includes(alignedBaseName));
      if (aligned && aligned.id !== input.target_id) {
        await ctx.pjsr(`var w = ImageWindow.windowById('${aligned.id}'); if (!w.isNull) w.mainView.id = '${input.target_id}';`);
      }
      // Fallback: if target_id still doesn't exist, find any new mono view that wasn't there before
      const targetExists = newImgs.some(i => i.id === input.target_id);
      if (!targetExists) {
        const beforeSet = new Set([input.reference_id, 'FILTER_L', 'FILTER_Ha', 'FILTER_G']);
        const candidate = newImgs.find(i => !i.isColor && !beforeSet.has(i.id));
        if (candidate) {
          await ctx.pjsr(`var w = ImageWindow.windowById('${candidate.id}'); if (!w.isNull) w.mainView.id = '${input.target_id}';`);
        }
      }

      // Verify
      const dimR = await ctx.pjsr(`
        var r = ImageWindow.windowById('${input.reference_id}');
        var t = ImageWindow.windowById('${input.target_id}');
        JSON.stringify({ ref: { w: r.mainView.image.width, h: r.mainView.image.height }, tgt: { w: t.mainView.image.width, h: t.mainView.image.height } });
      `);
      return { type: 'text', text: `Aligned ${input.target_id} to ${input.reference_id}. Aligned file on disk: ${alignedPath}. Dimensions: ${dimR.outputs?.consoleOutput}` };
    }
  },

  combine_channels: {
    category: 'readiness',
    definition: {
      name: 'combine_channels',
      description: 'Combine 3 mono views into a single RGB color image using ChannelCombination. All 3 views MUST have identical dimensions — align first if they differ. Returns the view ID of the combined image.',
      input_schema: {
        type: 'object',
        properties: {
          r_view_id: { type: 'string', description: 'Red channel view ID' },
          g_view_id: { type: 'string', description: 'Green channel view ID' },
          b_view_id: { type: 'string', description: 'Blue channel view ID' },
          output_id: { type: 'string', description: 'Desired output view ID (the combined image will be renamed to this)' }
        },
        required: ['r_view_id', 'g_view_id', 'b_view_id', 'output_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const beforeIds = (await ctx.listImages()).map(i => i.id);

      const r = await ctx.pjsr(`
        var P = new ChannelCombination;
        P.colorSpace = ChannelCombination.prototype.RGB;
        P.channels = [
          [true, '${input.r_view_id}'],
          [true, '${input.g_view_id}'],
          [true, '${input.b_view_id}']
        ];
        var ok = P.executeGlobal();
        'CC_result=' + ok;
      `);

      const ccOk = (r.outputs?.consoleOutput || '').includes('true');
      if (!ccOk) return { type: 'text', text: `ChannelCombination failed: ${r.outputs?.consoleOutput}. Check that all 3 views have identical dimensions.` };

      // Find the new color image
      const afterImgs = await ctx.listImages();
      const newImg = afterImgs.find(i => i.isColor && !beforeIds.includes(i.id));
      if (!newImg) {
        // Maybe it reused an existing window
        const anyColor = afterImgs.find(i => i.isColor);
        if (anyColor) {
          if (anyColor.id !== input.output_id) {
            await ctx.pjsr(`var w = ImageWindow.windowById('${anyColor.id}'); if (!w.isNull) w.mainView.id = '${input.output_id}';`);
          }
          return { type: 'text', text: `Combined into ${input.output_id} (${anyColor.width}x${anyColor.height})` };
        }
        return { type: 'text', text: 'ChannelCombination returned true but no color image found' };
      }

      if (newImg.id !== input.output_id) {
        await ctx.pjsr(`var w = ImageWindow.windowById('${newImg.id}'); if (!w.isNull) w.mainView.id = '${input.output_id}';`);
      }
      return { type: 'text', text: `Combined into ${input.output_id} (${newImg.width}x${newImg.height})` };
    }
  },

  // --- Quality Gates (automated, code-based — cannot be bypassed) ---
  check_star_quality: {
    category: 'quality_gate',
    definition: {
      name: 'check_star_quality',
      description: 'Automated quality gate: measures star FWHM and color diversity using StarDetector + pixel sampling. PASS: median FWHM < 6px AND color diversity > 0.05. FAIL: bloated or colorless stars. Run this on the final composite (with stars reintegrated).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID of the final image (must include stars)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await checkStarQuality(ctx, input.view_id);
      // Per-profile brightness threshold
      const prominence = brief?.processingProfile?.stars?.prominence || 'balanced';
      const minContrast = prominence === 'prominent' ? 4.0 : prominence === 'subdued' ? 2.0 : 3.0;
      const brightnessOk = (result.starBgContrast || 0) >= minContrast;
      const overallPass = result.pass && brightnessOk;
      const status = overallPass ? 'PASS' : 'FAIL';
      let text = `[STAR QUALITY GATE: ${status}] ${result.details}\n` +
        `  Median FWHM: ${result.medianFWHM?.toFixed(2) || 'N/A'}px (limit: 6.0)\n` +
        `  Color diversity: ${result.colorDiversity?.toFixed(3) || 'N/A'} (limit: 0.05)\n` +
        `  Stars found: ${result.starsFound || 0}, measured: ${result.starsMeasured || 0}\n` +
        `  Star brightness: median peak=${result.medianPeak?.toFixed(3) || 'N/A'}, ` +
        `contrast=${result.starBgContrast?.toFixed(1) || 'N/A'}× vs bg=${result.bgMedian?.toFixed(4) || 'N/A'} ` +
        `(limit: ${minContrast}× for ${prominence} stars)`;
      if (!brightnessOk) {
        text += `\n  FIX: Stars are too dim. Increase star_protected_blend strength, use brighter stretch_stars (lower setiMidtone or more iterations), or boost star layer brightness with curves before blending.`;
      }
      return { type: 'text', text };
    }
  },

  check_ringing: {
    category: 'quality_gate',
    definition: {
      name: 'check_ringing',
      description: 'Automated quality gate: detects concentric ring artifacts (HDRMT ringing) around the brightest region. Computes radial brightness profile (150 radii x 36 angles) and counts derivative oscillations. PASS: <= 1 oscillation. FAIL: >= 3 oscillations with amplitude > 0.01.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to check for ringing artifacts' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await checkRinging(ctx, input.view_id);
      const category = brief?.target?.classification || 'unknown';

      // Category-aware interpretation: edge-on galaxies have natural radial oscillations
      const morphologyConflict = ['galaxy_edge_on', 'galaxy_spiral'].includes(category);
      const blocking = !morphologyConflict; // only blocking for non-galaxy targets

      let status, interpretation;
      if (result.pass) {
        status = 'PASS';
        interpretation = '';
      } else if (morphologyConflict) {
        status = 'ADVISORY';
        interpretation = `\n  NOTE: ${category} targets have natural radial brightness oscillations (disk + dust lane). ` +
          `High oscillation count likely reflects STRUCTURE, not processing artifacts. ` +
          `This is NOT blocking for ${category}. Focus on edge overshoot and halo artifacts instead.`;
      } else {
        status = 'FAIL';
        interpretation = `\n  This indicates likely HDRMT or sharpening artifacts. Revert and reduce enhancement.`;
      }

      return {
        type: 'text',
        text: `[RINGING GATE: ${status}${morphologyConflict ? ' — morphology conflict' : ''}] ${result.details}\n` +
          `  Oscillations: ${result.oscillations} (limit: 1)\n` +
          `  Max amplitude: ${result.maxAmplitude?.toFixed(4) || 'N/A'}\n` +
          `  Brightest region center: [${result.center || 'N/A'}]` +
          `  Blocking: ${blocking}` +
          interpretation
      };
    }
  },

  check_sharpness: {
    category: 'quality_gate',
    definition: {
      name: 'check_sharpness',
      description: 'Measure image sharpness via Sobel gradient energy in subject ROI. Returns a numeric score (higher = sharper). Use this to compare candidates — it is a RELATIVE metric, not pass/fail.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to measure' },
          roi_x: { type: 'number', description: 'ROI x offset (optional, defaults to center 50%)' },
          roi_y: { type: 'number', description: 'ROI y offset' },
          roi_w: { type: 'number', description: 'ROI width' },
          roi_h: { type: 'number', description: 'ROI height' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const roi = (input.roi_x != null && input.roi_w != null)
        ? { x: input.roi_x, y: input.roi_y, w: input.roi_w, h: input.roi_h }
        : undefined;
      const result = await checkSharpness(ctx, input.view_id, roi);
      return {
        type: 'text',
        text: `[SHARPNESS] ${result.details}`
      };
    }
  },

  check_core_burning: {
    category: 'quality_gate',
    definition: {
      name: 'check_core_burning',
      description: 'Automated quality gate: checks if the brightest region (galaxy core) is burnt/clipped. Measures fraction of pixels > 0.98 in the core. PASS: < 2% burnt. FAIL: >= 2% burnt. Run this after EVERY HDRMT/LHE application and before finish.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to check' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await checkCoreBurning(ctx, input.view_id);
      const status = result.pass ? 'PASS' : 'FAIL';
      return {
        type: 'text',
        text: `[CORE BURNING GATE: ${status}] ${result.details}\n` +
          `  Burnt fraction: ${(result.burntFraction * 100)?.toFixed(1) || 'N/A'}% (limit: 2%)\n` +
          `  Peak value: ${result.peakValue?.toFixed(4) || 'N/A'}\n` +
          `  Core center: [${result.coreCenter || 'N/A'}]`
      };
    }
  },

  scan_burnt_regions: {
    category: 'quality_gate',
    definition: {
      name: 'scan_burnt_regions',
      description: 'Global burn scanner: tiles the ENTIRE image in 32x32 blocks and reports which areas have clipping (>5% pixels > 0.98). Catches burnt regions ANYWHERE — not just the brightest core. Use this for nebulae where large bright regions can clip. PASS: < 1% of blocks burnt. FAIL: >= 1% burnt.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to scan' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await scanBurntRegions(ctx, input.view_id);
      const status = result.pass ? 'PASS' : 'FAIL';
      return {
        type: 'text',
        text: `[BURN SCAN: ${status}] ${result.details}\n` +
          `  Burnt blocks: ${result.burntBlockCount || 0}/${result.totalBlocks || 0} (${((result.burntAreaFraction || 0) * 100).toFixed(1)}%, limit: 1%)`
      };
    }
  },

  check_saturation: {
    category: 'quality_gate',
    definition: {
      name: 'check_saturation',
      description: 'Automated quality gate: measures HSV saturation in subject pixels (above background). Returns median, P90, P99 saturation. Use AFTER every saturation boost, curves, Ha injection, hue_boost — ideally on starless composite BEFORE star blend. Compare P90 against processing profile max_p90 limit. Over-saturation makes images look synthetic.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to measure saturation on' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      try {
        const result = await checkSaturation(ctx, input.view_id);
        const maxP90 = brief?.processingProfile?.saturation?.max_p90 ?? 0.65;
        let text = result.details;

        // Add repair policy if saturation exceeds limit
        if (result.p90S > maxP90) {
          const provenance = brief?._provenance?.get(input.view_id);
          if (provenance && provenance.tool === 'lrgb_combine') {
            const origSat = provenance.params?.saturation ?? 0.80;
            const suggestedSat1 = Math.max(0.20, origSat - 0.20);
            const suggestedSat2 = Math.max(0.20, origSat - 0.30);
            text += `\n\n** REPAIR POLICY — UPSTREAM FIX REQUIRED **` +
              `\nSuspected source: lrgb_combine (saturation=${origSat})` +
              `\nP90=${result.p90S.toFixed(3)} exceeds limit ${maxP90.toFixed(2)}. LRGB combine amplified saturation.` +
              `\nREQUIRED ACTION: restore_from_clone → lrgb_combine with lower saturation param.` +
              `\n  Try: saturation=${suggestedSat1.toFixed(2)}, then saturation=${suggestedSat2.toFixed(2)}` +
              `\nPROHIBITED: Do NOT apply S-curve desaturation or downstream color correction.` +
              `\nPost-hoc desaturation destroys channel color gradients. Adjust the blend param instead.`;
          } else if (result.p90S > maxP90 + 0.10) {
            text += `\n\nWARNING: P90=${result.p90S.toFixed(3)} exceeds hard limit ${(maxP90 + 0.10).toFixed(2)}. Reduce saturation at the source — curves, LRGB params, or Ha injection strength.`;
          }
        }

        return { type: 'text', text };
      } catch (e) {
        return { type: 'text', text: `Saturation check error: ${e.message}` };
      }
    }
  },

  check_tonal_presence: {
    category: 'quality_gate',
    definition: {
      name: 'check_tonal_presence',
      description: 'Deterministic tonal critic: measures whether the subject is tonally impactful relative to background, or merely technically safe but subdued. Returns verdict: subdued (<3× separation), balanced (3-8×), aggressive (>8×). Use BEFORE star blend on composition candidates. Subdued = HARD FAIL if ROI confidence is high/medium.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to check (ideally starless composition)' },
          category: { type: 'string', description: 'Target classification (e.g. galaxy_spiral, planetary_nebula)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const category = input.category || brief?.target?.classification || 'unknown';
      const result = await checkTonalPresence(ctx, input.view_id, category);
      const status = result.pass ? (result.tonal_verdict === 'subdued' ? 'ADVISORY' : 'PASS') : 'FAIL';

      let guidance = '';
      if (result.tonal_verdict === 'subdued' && result.roi_confidence !== 'low') {
        guidance = '\n\nACTION REQUIRED: Subject is too dim relative to background.\n' +
          '  1. Restore pre-star checkpoint\n' +
          '  2. Apply ONE subject-masked midtone lift (run_curves through luminance mask)\n' +
          '  3. Re-blend stars after lifting\n' +
          '  Do NOT apply blind global brightness boost.';
      } else if (result.tonal_verdict === 'aggressive') {
        guidance = '\n\nNOTE: Very high separation — check for burns in subject bright areas with scan_burnt_regions.';
      }

      return {
        type: 'text',
        text: `[TONAL PRESENCE: ${status} — ${result.tonal_verdict.toUpperCase()}] ${result.details}\n` +
          `  Separation: ${result.separation?.toFixed(2)}× (subdued: <3, balanced: 3-8, aggressive: >8)\n` +
          `  Subject median: ${result.subject_median?.toFixed(4)}, Background median: ${result.background_median?.toFixed(4)}\n` +
          `  Core brightness: ${result.core_brightness?.toFixed(4)}, Faint visibility: ${result.faint_structure_visibility?.toFixed(3)}\n` +
          `  ROI confidence: ${result.roi_confidence}, mode: ${result.roi_mode}, subject pixels: ${result.subjectPixelCount}` +
          (result.category_metrics?.core_to_disk != null ? `\n  Core-to-disk ratio: ${result.category_metrics.core_to_disk.toFixed(2)}` : '') +
          guidance
      };
    }
  },

  check_star_layer_integrity: {
    category: 'quality_gate',
    definition: {
      name: 'check_star_layer_integrity',
      description: 'Pre-blend star layer validation: checks for clipping, color loss, and quality issues in the star layer. PRECONDITION for star_protected_blend — must be called before blending stars. FAIL: max >= 0.98 or any pixel > 0.995. WARN: >1% near-clipped or low color diversity.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Star layer view ID to validate' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await checkStarLayerIntegrity(ctx, input.view_id);

      // Detect unstretched star layer: median near zero AND most non-zero pixels are faint
      // A properly stretched star layer has bright star peaks spread across the range.
      // An unstretched one has median ~0 and only a handful of pixels above 0.1
      const stats = await getStats(ctx, input.view_id);
      const isUnstretched = (stats.median < 0.001) && (result.max_value > 0.1) &&
        (result.nonzero_pixel_count < 20000); // linear star layers have very few detectable pixels

      // Store result in brief for star_protected_blend precondition check
      if (brief) {
        if (!brief._starIntegrity) brief._starIntegrity = {};
        brief._starIntegrity[input.view_id] = {
          verdict: result.verdict,
          pass: result.pass,
          max_value: result.max_value,
          median: stats.median,
          nonzero_pixel_count: result.nonzero_pixel_count,
          unstretched: isUnstretched,
          seq: brief._budget?.turnsUsed || 0,
          turnsAgo: 0,
        };
      }

      let guidance = '';
      if (result.verdict === 'FAIL') {
        guidance = '\n\nFIX REQUIRED before star blend:\n' +
          '  Apply soft rolloff to star layer: run_pixelmath with expression:\n' +
          '    "iif($T > 0.65, 0.65 + ($T - 0.65) * 0.46, $T)" (compresses 0.65-1.0 → 0.65-0.81)\n' +
          '  Or simpler: "min($T, 0.95)" then re-check.\n' +
          '  Then call check_star_layer_integrity again to verify.';
      }
      if (isUnstretched) {
        guidance += '\n\nWARNING: Star layer appears UNSTRETCHED (median=' + stats.median.toFixed(6) +
          '). Stars will be invisible after blend.\n' +
          '  You MUST call stretch_stars on this layer before blending.\n' +
          '  star_protected_blend will REFUSE an unstretched star layer.';
      }

      return {
        type: 'text',
        text: `[STAR INTEGRITY: ${result.verdict}${isUnstretched ? ' — UNSTRETCHED' : ''}] ${result.details}\n` +
          `  Max value: ${result.max_value?.toFixed(4) || 'N/A'} (limit: <0.98)\n` +
          `  Median: ${stats.median?.toFixed(6) || 'N/A'} ${isUnstretched ? '⚠️ NEAR ZERO — unstretched!' : ''}\n` +
          `  Clipped >0.98: ${((result.clipped_fraction_98 || 0) * 100).toFixed(2)}%\n` +
          `  Clipped >0.995: ${((result.clipped_fraction_995 || 0) * 100).toFixed(2)}%\n` +
          `  Color diversity: ${result.color_diversity?.toFixed(4) || 'N/A'} (min: 0.05)\n` +
          `  Bright star chroma: ${result.bright_star_chroma?.toFixed(4) || 'N/A'}\n` +
          `  Non-zero pixels: ${result.nonzero_pixel_count || 0}` +
          guidance
      };
    }
  },

  check_bright_chroma: {
    category: 'quality_gate',
    definition: {
      name: 'check_bright_chroma',
      description: 'Measures color differentiation in bright subject pixels. Detects chroma collapse (core washout) that burn scans miss. Run BEFORE and AFTER star blend — if median chroma drops significantly, the blend washed out the core. Fix with restore_star_color or re-blend with tighter parameters.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to check' },
          brightness_threshold: { type: 'number', description: 'Luminance above which to measure chroma (default 0.50)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await checkBrightChroma(ctx, input.view_id, input.brightness_threshold ?? 0.50);
      const warn = result.medianChroma < 0.05 && result.brightPixelCount > 100;
      return {
        type: 'text',
        text: `[BRIGHT CHROMA${warn ? ' — WARNING: CHROMA COLLAPSE' : ''}] ${result.details}` +
          (warn ? '\n  Bright areas have near-zero color differentiation — core is visually washed out.' +
            '\n  Fix: use restore_star_color with the pre-star reference, or re-blend with tighter core protection.' : '')
      };
    }
  },

  measure_subject_detail: {
    category: 'measurement',
    definition: {
      name: 'measure_subject_detail',
      description: 'Measure subject brightness, detail resolution, and contrast ratio. HARD GATES: subjectBrightness >= 0.25 (goal: >0.35), detailScore >= 0.001 (goal: >0.005), contrastRatio >= 3× (goal: >5×). finish WILL REJECT if any hard gate fails. Use AFTER each processing step to verify improvement.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to measure' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await measureSubjectDetail(ctx, input.view_id);
      return {
        type: 'text',
        text: `[SUBJECT METRICS] ${result.details}\n` +
          `  Brightness: ${result.subjectBrightness?.toFixed(4) || 'N/A'} (HARD GATE: 0.25, goal: >0.35)\n` +
          `  Detail score: ${result.detailScore?.toFixed(6) || 'N/A'} (HARD GATE: 0.001, goal: >0.005)\n` +
          `  Contrast ratio: ${result.contrastRatio?.toFixed(1) || 'N/A'}× (HARD GATE: 3×, goal: >5×)\n` +
          `  Subject regions: ${result.subjectCount || 0} / Background median: ${result.backgroundMedian?.toFixed(4) || 'N/A'}`
      };
    }
  },

  check_core_contrast: {
    category: 'measurement',
    definition: {
      name: 'check_core_contrast',
      description: 'Measure RELATIVE local contrast in the BRIGHT CORE vs the surrounding shell — catches a PERCEPTUAL burn that the clipping gates miss: a bright core that is NOT clipped (peak < 0.85) but reads as a flat washed-out white blob because its structure is tiny relative to its brightness. HARD GATE (finish WILL REJECT for extended-core targets): coreRelContrast >= 0.22 (goal: >0.30). relContrast = mean|local gradient| / mean luminance, in the brightest ~top-40%-of-dynamic-range region. If it fails, recover local contrast in the center (HDRMT/LHE reaching the core — shrink the donut hole — and/or compress the core pedestal with continuous_clamp so existing structure shows). Use after core/HDR/curve steps to verify the bright center is not flat.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to measure' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const cb = brief?.processingProfile?.core_burn || {};
      const relHard = (typeof cb.rel_contrast_hard === 'number') ? cb.rel_contrast_hard : 0.22;
      const whiteHard = (typeof cb.white_hard === 'number') ? cb.white_hard : 0.15;
      const result = await measureCoreContrast(ctx, input.view_id, brief?.target?.classification, cb);
      return {
        type: 'text',
        text: `[CORE CONTRAST] ${result.details}\n` +
          `  Core relContrast: ${result.coreRelContrast?.toFixed(3) ?? 'N/A'} (HARD GATE: ${relHard}, goal: >0.30)\n` +
          `  Core white-clipped fraction: ${((result.coreWhiteFraction ?? 0)*100).toFixed(1)}% (HARD GATE: <${(whiteHard*100).toFixed(0)}%) | core saturation: ${typeof result.coreSat==='number' && result.coreSat>=0 ? result.coreSat.toFixed(3)+' (min 0.10)' : 'n/a (mono)'}\n` +
          `  Shell relContrast: ${result.shellRelContrast?.toFixed(3) ?? 'N/A'} | core/shell ratio: ${(result.ratio ?? 0).toFixed(2)} (diagnostic)\n` +
          `  Core mean lum: ${result.coreLum?.toFixed(3) ?? 'N/A'} | core fraction: ${((result.coreFraction ?? 0)*100).toFixed(2)}%\n` +
          `  ${result.pass ? 'PASS' : 'FAIL — bright core is perceptually flat/white-burnt/desaturated'}`
      };
    }
  },

  check_noise: {
    category: 'measurement',
    definition: {
      name: 'check_noise',
      description: 'Measure background high-frequency (pixel-scale) GRAIN — the noise that aggressive LHE/stretching amplifies. HARD GATE (finish WILL REJECT): bgNoise <= 0.022 (goal <= 0.015). Estimated as MAD of (pixel - mean of dist-2 neighbors) over the cleanest background patches. If it fails, apply ONE light NoiseXTerminator pass (denoise 0.20-0.30) — just enough to smooth grain without over-smoothing (the core-contrast gate still needs resolved detail). Use as a FINAL evaluation before finish.',
      input_schema: { type: 'object', properties: { view_id: { type: 'string', description: 'View ID to measure' } }, required: ['view_id'] }
    },
    handler: async (ctx, _store, _brief, input) => {
      const result = await measureBackgroundNoise(ctx, input.view_id);
      return {
        type: 'text',
        text: `[NOISE] ${result.details}\n  bgNoise (dark sky): ${result.bgNoise?.toFixed(4) ?? 'N/A'} (HARD GATE: 0.022) | dustNoise (lifted dust grain): ${result.dustNoise?.toFixed(4) ?? 'N/A'} (HARD GATE: 0.040)\n  ${result.pass ? 'PASS' : 'FAIL — apply a final NXT pass (denoise ~0.30, detail 0.10) AFTER lift_dust'}`
      };
    }
  },

  measure_dust_coverage: {
    category: 'measurement',
    definition: {
      name: 'measure_dust_coverage',
      description: 'Measure faint brown-IFN / DUST presence in the FIELD (everything below the bright core). Distinguishes a frame FILLED with dust from an EMPTY black field even when their medians are IDENTICAL — the median is blind to dust distribution. Reports dustCoverage (fraction of field that is faint dust), warmDustFraction (brown lean), dustMeanSat (dust color richness) and fieldP90/P95 (dust peak brightness). HARD GATE for reflection/dusty profiles (finish WILL REJECT): fails when the dust is BOTH greyed (dustMeanSat < min) AND crushed (fieldP95 < min). If it fails, use lift_dust (NOT a global additive lift). Calibrated on NGC 7023 iter03 (good) vs giga (bad).',
      input_schema: { type: 'object', properties: { view_id: { type: 'string', description: 'View ID to measure' } }, required: ['view_id'] }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await measureDustCoverage(ctx, input.view_id, brief?.processingProfile?.ifn);
      return {
        type: 'text',
        text: `[DUST/IFN] ${result.details}\n` +
          `  dustCoverage: ${((result.dustCoverage ?? 0)*100).toFixed(1)}% of field | warmDustFraction: ${((result.warmDustFraction ?? 0)*100).toFixed(1)}%\n` +
          `  dustMeanSat: ${(result.dustMeanSat ?? 0).toFixed(3)} | fieldP90: ${(result.fieldP90 ?? 0).toFixed(3)} | fieldP95: ${(result.fieldP95 ?? 0).toFixed(3)}\n` +
          `  ${result.pass ? 'PASS' : 'FAIL — dust greyed AND crushed; use lift_dust (selective), not a global lift'}`
      };
    }
  },

  lift_dust: {
    category: 'detail',
    definition: {
      name: 'lift_dust',
      description: 'SELECTIVE brown-IFN / dust recovery for reflection nebulae and dusty fields. Pass 1 is a hue-preserving brightness+contrast lift of the faint DUST band (just above background, below the core); pass 2 boosts its warm saturation (chroma expansion in the dust band only). Brightens the dust WITHOUT raising the background noise floor or touching the bright core. This is how you make the brown LDN-type dust fill the frame. CRITICAL: do NOT use a global additive lift ($T + k*(1-$T)) for this — it greys the whole field uniformly and FAILS the IFN/dust gate. Run measure_dust_coverage before and after to confirm dustMeanSat and fieldP95 rose. Params: lift_amount (0.3-0.9 dust brightness/contrast gain), sat_boost (0.2-0.6 dust warm color), core_taper_low/high (luminance band where the lift tapers off to protect the bright core).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to operate on' },
          lift_amount: { type: 'number', description: 'Dust brightness/contrast gain (default 0.6, range 0.3-1.2)' },
          sat_boost: { type: 'number', description: 'Dust warm-saturation boost (default 0.4, range 0-1)' },
          core_taper_low: { type: 'number', description: 'Luminance where lift begins tapering off (default 0.30)' },
          core_taper_high: { type: 'number', description: 'Luminance where lift is fully off, protecting the core (default 0.50)' },
          mask_view_id: { type: 'string', description: 'OPTIONAL outer-field mask (mono, same geometry): 1 = lift dust here, 0 = protect (the nebula). Confines the lift spatially so it never brightens/flattens the core. Build via create_luminance_mask(inverted) or create_zone_masks(halo).' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const amt = Math.max(0, Math.min(1.2, input.lift_amount ?? 0.6));
      const satk = Math.max(0, Math.min(1.0, input.sat_boost ?? 0.4));
      const cLo = input.core_taper_low ?? 0.30;
      const cHi = input.core_taper_high ?? 0.50;
      const mv = input.mask_view_id;
      const maskMul = mv ? ` * ${mv}[0]` : '';   // optional outer-field mask: confine the lift spatially, protect the nebula
      const code = `
        var w = ImageWindow.windowById('${input.view_id}');
        if (w.isNull) throw new Error('lift_dust: view not found: ${input.view_id}');
        if (!w.mainView.image.isColor) throw new Error('lift_dust: requires a color image');
        ${mv ? `var mw=ImageWindow.windowById('${mv}'); if(mw.isNull) throw new Error('lift_dust: mask ${mv} not found'); if(mw.mainView.image.width!==w.mainView.image.width||mw.mainView.image.height!==w.mainView.image.height) throw new Error('lift_dust: mask geometry mismatch');` : ''}
        var bg = w.mainView.image.median();
        // Pass 1: hue-preserving dust-band brightness+contrast gain. Anchored at the
        // background median (factor=1 at L=bg) so the noise floor is NOT lifted; gain
        // tapers to 1 above core_taper_high so the bright core is untouched.
        // PixelMath: definitions are statements in the EXPRESSION (semicolon-separated,
        // last statement is the output); P.symbols lists the NAMES; conditionals use iif().
        var P = new PixelMath;
        P.expression = [
          'L = 0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2]',
          'mask = (1 - max(0, min(1, (L - ${cLo})/(${cHi} - ${cLo}))))${maskMul}',
          'Lp = ' + bg + ' + (L - ' + bg + ')*(1 + ${amt}*mask)',
          'factor = iif(L > 0.0008, Lp/L, 1)',
          '$T * factor'
        ].join('; ');
        P.symbols = 'L, mask, Lp, factor';
        P.useSingleExpression = true;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(w.mainView);
        // Pass 2: warm dust saturation boost (chroma expansion, peaks in the dust band)
        var bg2 = w.mainView.image.median();
        var P2 = new PixelMath;
        P2.expression = [
          'L = 0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2]',
          'lo = ' + bg2 + '*1.05',
          // ramp reaches full just above background (lo + bg*0.55 ~= bg*1.6) so the
          // FAINT dust band (L ~ bg*1.3..0.3) is fully covered, not the mid-tones.
          'up = max(0, min(1, (L - lo)/(' + bg2 + '*0.55)))',
          'down = 1 - max(0, min(1, (L - ${cLo})/(${cHi} - ${cLo})))',
          'dmask = up*down${maskMul}',
          'L + (1 + ${satk}*dmask)*($T - L)'
        ].join('; ');
        P2.symbols = 'L, lo, up, down, dmask';
        P2.useSingleExpression = true;
        P2.use64BitWorkingImage = true;
        P2.truncate = true; P2.truncateLower = 0; P2.truncateUpper = 1;
        P2.createNewImage = false;
        P2.executeOn(w.mainView);
        var s = w.mainView.image;
        JSON.stringify({ median: s.median(), max: s.maximum() });
      `;
      const r = await ctx.pjsr(code);
      if (r.status === 'error') return { type: 'text', text: `lift_dust FAILED: ${r.error?.message || r.result}` };
      let st = {}; try { st = JSON.parse(r.result || '{}'); } catch {}
      return { type: 'text', text: `lift_dust applied (lift=${amt}, sat=${satk}, taper ${cLo}-${cHi}). New median=${(st.median ?? 0).toFixed(4)}, max=${(st.max ?? 0).toFixed(4)}. Re-run measure_dust_coverage to confirm dustMeanSat/fieldP95 rose.` };
    }
  },

  inject_l_ifn: {
    category: 'detail',
    definition: {
      name: 'inject_l_ifn',
      description: 'Inject the faint IFN/DUST STRUCTURE from the deep L channel into the combined RGB luminance, so the frame-filling dust that lives in L (the longest exposure) actually reaches the final. For reflection/dust targets where the IFN is in L but the shallower per-channel RGB barely shows it (lrgb_combine LinearFits L down and loses it). Adds L\'s above-background dust signal to the combined luminance through a FIELD mask (hue-preserving, tapered off in the bright core), then gently WARM-TINTS the injected dust so it reads brown. CORE PROTECTION: by default the injection tapers off above core_taper_low luminance; for a structured bright nebula whose mid-brightness parts overlap the dust luminance, ALSO pass mask_view_id = an OUTER-FIELD mask (an inverted, dilated bright-nebula/luminance mask: 1 in the dusty outskirts, 0 over the nebula) so the dust fills AROUND the nebula and never flattens its blue core. This is the lever for "brown dust filling the frame WITHOUT washing the center". Run measure_dust_coverage before and after. Params: l_view_id (default FILTER_L), strength (0.2-0.7), warm (0-0.3), core_taper_low/high, mask_view_id (optional outer-field mask).',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Combined RGB target view to inject into' },
          l_view_id: { type: 'string', description: 'L source view (default FILTER_L). Must match target geometry.' },
          strength: { type: 'number', description: 'Injection strength (default 0.4, range 0.2-0.7)' },
          warm: { type: 'number', description: 'Warm-tint amount on injected dust (default 0.12, range 0-0.3)' },
          core_taper_low: { type: 'number', description: 'Luminance where injection begins tapering off (default 0.22 — protects the bright nebula)' },
          core_taper_high: { type: 'number', description: 'Luminance where injection is fully off (default 0.38)' },
          mask_view_id: { type: 'string', description: 'OPTIONAL outer-field mask (mono, same geometry): 1 = fill dust here, 0 = protect (the nebula). Multiplies the luminance taper for hard spatial core protection. Build via create_luminance_mask(inverted) or create_zone_masks(halo).' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const lView = input.l_view_id || 'FILTER_L';
      const mv = input.mask_view_id;
      const str = Math.max(0, Math.min(1.0, input.strength ?? 0.4));
      const warm = Math.max(0, Math.min(0.4, input.warm ?? 0.12));
      const cLo = input.core_taper_low ?? 0.22;
      const cHi = input.core_taper_high ?? 0.38;
      // Guard: target color, L view present + same geometry (and mask if provided). Return L background median.
      const g = await ctx.pjsr(`
        var t=ImageWindow.windowById('${input.view_id}'); var l=ImageWindow.windowById('${lView}');
        if(t.isNull) 'ERR:target ${input.view_id} missing';
        else if(l.isNull) 'ERR:L view ${lView} missing';
        else if(!t.mainView.image.isColor) 'ERR:target is not a color image';
        else { var ti=t.mainView.image, li=l.mainView.image;
          if(ti.width!==li.width || ti.height!==li.height) 'ERR:geometry mismatch '+ti.width+'x'+ti.height+' vs '+li.width+'x'+li.height;
          ${mv ? `else { var mw=ImageWindow.windowById('${mv}'); if(mw.isNull) 'ERR:mask ${mv} missing'; else if(mw.mainView.image.width!==ti.width||mw.mainView.image.height!==ti.height) 'ERR:mask geometry mismatch'; else 'OK:'+li.median(); }` : `else 'OK:'+li.median();`} }
      `);
      const gv = (g.result || g.outputs?.consoleOutput || '').trim();
      if (gv.indexOf('ERR:') === 0) return { type: 'text', text: `inject_l_ifn FAILED: ${gv.slice(4)}` };
      const Lbg = parseFloat(gv.split(':')[1]) || 0;
      const maskMul = mv ? ` * ${mv}[0]` : '';   // spatial core protection (outer-field mask)
      // Shared symbol chain (definitions live in the expression per PixelMath; symbols lists names)
      const chain = `Lc = 0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2]; Ld = max(0, ${lView}[0] - ${Lbg}); mask = (1 - max(0, min(1, (Lc - ${cLo})/(${cHi} - ${cLo}))))${maskMul}`;
      const code = `
        var w=ImageWindow.windowById('${input.view_id}');
        // Pass 1: hue-preserving luminance injection of L's faint dust structure into the field
        var P=new PixelMath;
        P.expression='${chain}; Lnew = Lc + ${str}*mask*Ld; factor = iif(Lc > 0.0008, Lnew/Lc, 1); $T * factor';
        P.symbols='Lc, Ld, mask, Lnew, factor';
        P.useSingleExpression=true; P.use64BitWorkingImage=true;
        P.truncate=true; P.truncateLower=0; P.truncateUpper=1; P.createNewImage=false;
        P.executeOn(w.mainView);
        // Pass 2: warm tint on the injected dust (per-channel, ADDITIVE so it tints
        // faint/dark dust toward brown — multiplicative does nothing to near-black dust).
        // tint scales with injected L dust amount; the field mask keeps the bright blue
        // core untouched. Brown = R up, G up less, B down.
        var Q=new PixelMath;
        Q.expression='${chain}; tint = ${warm}*mask*min(1, Ld*3); $T + tint';
        Q.expression1='${chain}; tint = ${warm}*mask*min(1, Ld*3); $T + 0.35*tint';
        Q.expression2='${chain}; tint = ${warm}*mask*min(1, Ld*3); $T - 0.45*tint';
        Q.symbols='Lc, Ld, mask, tint';
        Q.useSingleExpression=false; Q.use64BitWorkingImage=true;
        Q.truncate=true; Q.truncateLower=0; Q.truncateUpper=1; Q.createNewImage=false;
        Q.executeOn(w.mainView);
        var s=w.mainView.image; JSON.stringify({median:s.median(), max:s.maximum()});
      `;
      const r = await ctx.pjsr(code);
      if (r.status === 'error') return { type: 'text', text: `inject_l_ifn FAILED: ${r.error?.message || r.result}` };
      let st = {}; try { st = JSON.parse(r.result || '{}'); } catch {}
      return { type: 'text', text: `inject_l_ifn applied (from ${lView}, strength=${str}, warm=${warm}, Lbg=${Lbg.toFixed(4)}). New median=${(st.median ?? 0).toFixed(4)}, max=${(st.max ?? 0).toFixed(4)}. Re-run measure_dust_coverage — dustCoverage/fieldP95 should rise.` };
    }
  },

  multi_scale_enhance: {
    category: 'detail',
    definition: {
      name: 'multi_scale_enhance',
      description: 'COMPOUND TOOL: applies 3-scale masked LHE + optional HDRMT in ONE call with before/after metrics. Much faster than individual LHE calls. Returns detail score improvement %. Use this INSTEAD of individual run_lhe calls for detail enhancement. Call multiple times with different params to bracket. If improvement < 5%, adjust mask (softer clipLow) or increase amounts.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to enhance' },
          mask_clip_low: { type: 'number', description: 'Mask clip low (0.04=soft/faint structure, 0.10=medium, 0.15=tight). Default 0.06' },
          mask_blur: { type: 'number', description: 'Mask blur sigma (3-10). Default 5' },
          mask_gamma: { type: 'number', description: 'Mask gamma (1.0-3.0, higher=protect brights more). Default 2.0' },
          lhe_fine_radius: { type: 'number', description: 'Fine LHE radius (16-32). Default 24' },
          lhe_fine_amount: { type: 'number', description: 'Fine LHE amount (0.10-0.40). Default 0.20' },
          lhe_mid_radius: { type: 'number', description: 'Mid LHE radius (35-64). Default 48' },
          lhe_mid_amount: { type: 'number', description: 'Mid LHE amount (0.15-0.50). Default 0.30' },
          lhe_large_radius: { type: 'number', description: 'Large LHE radius (80-150). Default 100' },
          lhe_large_amount: { type: 'number', description: 'Large LHE amount (0.20-0.50). Default 0.30' },
          lhe_slope_limit: { type: 'number', description: 'LHE slope limit (1.2-2.0). Default 1.5' },
          do_hdrmt: { type: 'boolean', description: 'Apply HDRMT after LHE. Default true' },
          hdrmt_layers: { type: 'number', description: 'HDRMT layers (4-7). Default 5' },
          hdrmt_median_transform: { type: 'boolean', description: 'Use median transform (prevents ringing in star fields). Default true' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      // POLICY BLOCK: emission nebulae must use shell_detail_enhance instead
      const classification = brief?.target?.classification || '';
      if (classification.includes('emission')) {
        return {
          type: 'text',
          text: `[BLOCKED] multi_scale_enhance is DISABLED for emission nebulae. ` +
            `LHE-driven brightness amplification causes destructive highlight compression on bright shells. ` +
            `Use shell_detail_enhance instead — it enhances texture without increasing peak brightness. ` +
            `Call: shell_detail_enhance(view_id="${input.view_id}", medium_amount=1.0, large_amount=0.5)`
        };
      }
      const result = await multiScaleEnhance(ctx, input.view_id, {
        maskClipLow: input.mask_clip_low,
        maskBlur: input.mask_blur,
        maskGamma: input.mask_gamma,
        lheFineRadius: input.lhe_fine_radius,
        lheFineAmount: input.lhe_fine_amount,
        lheMidRadius: input.lhe_mid_radius,
        lheMidAmount: input.lhe_mid_amount,
        lheLargeRadius: input.lhe_large_radius,
        lheLargeAmount: input.lhe_large_amount,
        lheSlopeLimit: input.lhe_slope_limit,
        doHDRMT: input.do_hdrmt,
        hdrmtLayers: input.hdrmt_layers,
        hdrmtMedianTransform: input.hdrmt_median_transform,
      });
      if (result.error) {
        return { type: 'text', text: `multi_scale_enhance FAILED: ${result.error}` };
      }
      return {
        type: 'text',
        text: `[MULTI-SCALE ENHANCE] ${result.details}\n` +
          `  Before: detail=${result.before.detailScore.toFixed(6)}, brightPx=${result.before.brightPixels}\n` +
          `  After:  detail=${result.after.detailScore.toFixed(6)}, brightPx=${result.after.brightPixels}\n` +
          `  Improvement: ${result.improvement > 0 ? '+' : ''}${result.improvement.toFixed(1)}%\n` +
          `  Params: LHE fine=${result.params.lhe.fine.r}/${result.params.lhe.fine.a} mid=${result.params.lhe.mid.r}/${result.params.lhe.mid.a} large=${result.params.lhe.large.r}/${result.params.lhe.large.a} | HDRMT=${result.params.hdrmt.applied ? result.params.hdrmt.layers + 'L' : 'off'}`
      };
    }
  },

  // --- Scoring (critics only) ---
  submit_scores: {
    category: 'scoring',
    definition: {
      name: 'submit_scores',
      description: 'Submit your quality assessment scores. Score each dimension 0-100. artifact_penalty: 0=clean, 100=severe artifacts.',
      input_schema: {
        type: 'object',
        properties: {
          detail_credibility: { type: 'number', description: 'Noise-free detail quality (0-100)' },
          background_quality: { type: 'number', description: 'Background smoothness and uniformity (0-100)' },
          color_naturalness: { type: 'number', description: 'Channel balance and color accuracy (0-100)' },
          star_integrity: { type: 'number', description: 'Star shape and rendering quality (0-100)' },
          tonal_balance: { type: 'number', description: 'Dynamic range utilization (0-100)' },
          subject_separation: { type: 'number', description: 'Subject vs background contrast (0-100)' },
          artifact_penalty: { type: 'number', description: 'Artifact severity (0=clean, 100=severe)' },
          aesthetic_coherence: { type: 'number', description: 'Overall visual harmony (0-100)' },
          verdict: { type: 'string', enum: ['accept', 'reject'], description: 'Accept or reject the image' },
          feedback: { type: 'string', description: 'Specific feedback for the doer agent (especially if rejecting)' }
        },
        required: ['detail_credibility', 'background_quality', 'color_naturalness', 'star_integrity',
          'tonal_balance', 'subject_separation', 'artifact_penalty', 'aesthetic_coherence', 'verdict']
      }
    },
    handler: async (_ctx, _store, _brief, input) => {
      // The orchestrator reads this from the finish result
      return { type: 'text', text: `Scores submitted. Verdict: ${input.verdict}` };
    }
  },

  // --- Highlight texture / shell-nebula tools ---

  check_highlight_texture: {
    category: 'quality_gate',
    definition: {
      name: 'check_highlight_texture',
      description: 'Detect perceptual burn — bright subject zones where internal tonal variation has collapsed into a featureless plateau. PRIMARY signal: relative texture retention vs a reference checkpoint (blocking). WITHOUT reference: advisory-only absolute heuristics. Clone BEFORE the operation, then call this AFTER with reference_id pointing to the clone.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Current image to assess' },
          reference_id: { type: 'string', description: 'Pre-operation clone/view for comparison. REQUIRED for blocking verdict. Without it, results are advisory only.' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await checkHighlightTexture(ctx, input.view_id, {
        referenceId: input.reference_id,
        roi: brief?._roi
      });
      const status = result.pass ? (result.verdict === 'preserved' ? 'PASS' : 'ADVISORY') : 'FAIL';
      let text = `[HIGHLIGHT TEXTURE: ${status}] ${result.details}\n`;
      if (result.current) {
        text += `  Current: localStdDev=${result.current.shellLocalStdDev?.toFixed(4)}, tonalSpan=${result.current.shellTonalSpan?.toFixed(3)}, gradient=${result.current.shellGradientEnergy?.toFixed(6)}\n`;
      }
      if (result.reference) {
        text += `  Reference: localStdDev=${result.reference.shellLocalStdDev?.toFixed(4)}, tonalSpan=${result.reference.shellTonalSpan?.toFixed(3)}, gradient=${result.reference.shellGradientEnergy?.toFixed(6)}\n`;
        text += `  Retention: texture=${((result.textureRetention ?? 1) * 100).toFixed(0)}%, span=${((result.spanRetention ?? 1) * 100).toFixed(0)}%, gradient=${((result.gradientRetention ?? 1) * 100).toFixed(0)}%`;
      }
      if (!result.pass) {
        text += `\n  FIX: Restore pre-operation checkpoint. If after clamp: raise knee, increase headroom, or skip clamp. If after detail tool: reduce amount or switch to shell_detail_enhance. If after Ha: reduce strength or max_output. Do NOT clamp harder.`;
      }
      return { type: 'text', text };
    }
  },

  shell_detail_enhance: {
    category: 'detail',
    definition: {
      name: 'shell_detail_enhance',
      description: 'EMISSION SHELL DETAIL TOOL: Enhances texture/filament detail in bright emission shells WITHOUT increasing peak brightness. Uses multi-scale high-pass decomposition with soft protection factor — brightness-neutral by design, no subsequent clamping needed. Use this INSTEAD of multi_scale_enhance on bright emission shells (LHE pushes brightness, causing the clamp→flatten cycle). Returns before/after shell texture metrics.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View to enhance (modified in place)' },
          mask_id: { type: 'string', description: 'Shell zone mask ID (auto-created if omitted)' },
          medium_sigma: { type: 'number', description: 'Filament-scale blur sigma (default 18, range 10-30)' },
          medium_amount: { type: 'number', description: 'Filament boost strength (default 1.0, range 0.3-2.5)' },
          large_sigma: { type: 'number', description: 'Regional tonal gradient sigma (default 55, range 35-80)' },
          large_amount: { type: 'number', description: 'Regional boost strength (default 0.5, range 0.0-1.5)' },
          protect_knee: { type: 'number', description: 'Luminance above which enhancement attenuates (default 0.80)' },
          protect_softness: { type: 'number', description: 'Attenuation rate — higher=steeper rolloff (default 4.0)' },
          auto_zone: { type: 'boolean', description: 'Auto-create adaptive shell zone mask (default true)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await shellDetailEnhance(ctx, input.view_id, {
        maskId: input.mask_id,
        mediumSigma: input.medium_sigma,
        mediumAmount: input.medium_amount,
        largeSigma: input.large_sigma,
        largeAmount: input.large_amount,
        protectKnee: input.protect_knee,
        protectSoftness: input.protect_softness,
        autoZone: input.auto_zone,
        roi: brief?._roi
      });
      if (result.error) return { type: 'text', text: `shell_detail_enhance error: ${result.error}` };
      return {
        type: 'text',
        text: `[SHELL DETAIL ENHANCE] ${result.details}\n` +
          `  Before: gradient=${result.before?.gradientEnergy?.toFixed(6)}, localStdDev=${result.before?.shellLocalStdDev?.toFixed(4)}\n` +
          `  After:  gradient=${result.after?.gradientEnergy?.toFixed(6)}, localStdDev=${result.after?.shellLocalStdDev?.toFixed(4)}\n` +
          `  Improvement: gradient=${result.improvement?.toFixed(1)}%, stddev=${result.stddevImprovement?.toFixed(1)}%\n` +
          `  Max after: ${result.maxAfter?.toFixed(4)}, protection engaged: ${result.protectionEngaged}\n` +
          `  Params: medium=${result.params?.mediumSigma}/${result.params?.mediumAmount} large=${result.params?.largeSigma}/${result.params?.largeAmount} knee=${result.params?.protectKnee}`
      };
    }
  },

  create_adaptive_zone_masks: {
    category: 'masks',
    definition: {
      name: 'create_adaptive_zone_masks',
      description: 'Create ROI-anchored adaptive zone masks from actual image statistics. Unlike fixed-threshold zone masks, these adapt to the stretch level and subject brightness. Creates 3 soft masks: hot_core (top ~10%), bright_shell (P25-P90), outer_nebula (background-P25). Best for shell emission nebulae where zones need independent processing.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'Source view for zone computation' },
          core_bias: { type: 'number', description: 'Shift core threshold: 0=wider core, 1=tighter core (default 0.5)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, brief, input) => {
      const result = await createAdaptiveZoneMasks(ctx, input.view_id, {
        roi: brief?._roi,
        coreBias: input.core_bias
      });
      return {
        type: 'text',
        text: `Adaptive zone masks created:\n` +
          `  Core: ${result.coreId} (${result.pixelCounts?.core} px, threshold=${result.thresholds?.core?.toFixed(3)})\n` +
          `  Shell: ${result.shellId} (${result.pixelCounts?.shell} px, range=${result.thresholds?.shellLow?.toFixed(3)}–${result.thresholds?.core?.toFixed(3)})\n` +
          `  Outer: ${result.outerId} (${result.pixelCounts?.outer} px, threshold=${result.thresholds?.outer?.toFixed(3)})\n` +
          `  ROI: center=(${result.roi?.cx},${result.roi?.cy}), radius=${result.roi?.radius}`
      };
    }
  }
};

// ============================================================================
// Tool set builder — agents get different subsets
// ============================================================================

const AGENT_TOOL_CATEGORIES = {
  readiness: ['measurement', 'readiness', 'image_mgmt', 'memory', 'control'],
  rgb_cleanliness: ['measurement', 'preview', 'image_mgmt', 'gradient', 'denoise', 'sharpen', 'stretch', 'calibration', 'star_removal', 'memory', 'artifacts', 'control'],
  luminance_detail: ['measurement', 'preview', 'image_mgmt', 'detail', 'masks', 'denoise', 'sharpen', 'stretch', 'gradient', 'calibration', 'readiness', 'star_removal', 'memory', 'artifacts', 'control'],
  star_policy: ['measurement', 'preview', 'image_mgmt', 'star_removal', 'stretch', 'curves', 'memory', 'artifacts', 'control'],
  ha_integration: ['measurement', 'preview', 'image_mgmt', 'gradient', 'denoise', 'sharpen', 'stretch', 'masks', 'ha_injection', 'narrowband', 'star_removal', 'memory', 'artifacts', 'control'],
  composition: ['measurement', 'preview', 'image_mgmt', 'curves', 'stars', 'lrgb', 'narrowband', 'masks', 'memory', 'artifacts', 'control'],
  aesthetic_critic: ['measurement', 'memory', 'control', 'scoring'],
  technical_critic: ['measurement', 'memory', 'control', 'scoring'],
  // Focused gradient sub-agent: flattens the background color gradient on the
  // LINEAR combined RGB (+ L) before SPCC/stretch. No 'control' (cannot finish/
  // export) and no 'stretch' (stays linear) — it just corrects and hands off.
  gradient_agent: ['measurement', 'preview', 'image_mgmt', 'gradient', 'memory'],
  // Focused core specialist (C-tier): improves ONLY the bright core of a finished
  // image (structure, no flat blob / no halo) through a core mask. Detail/clamp/zone
  // tools + masks + measurement + recall_champion/save_variant. No 'control' (cannot
  // finish/export), no 'stars' (no double star blend — the composer grafts only the
  // core back), no 'gradient'/'lrgb'/'ha' (not its job).
  core_specialist: ['measurement', 'preview', 'image_mgmt', 'detail', 'masks', 'narrowband', 'curves', 'stretch', 'denoise', 'memory', 'artifacts'],
};

/**
 * Build the tool set for an agent.
 * @param {string} agentName - Agent identifier (determines which tool categories are available)
 * @param {string[]} extraCategories - Additional categories to include
 * @returns {{ definitions: Array, handlers: Map }}
 */
export function buildToolSet(agentName, extraCategories = []) {
  // If agent not in the map, give ALL categories (collect unique category values)
  const allCategories = [...new Set(Object.values(TOOL_CATALOG).map(t => t.category))];
  const categories = new Set([
    ...(AGENT_TOOL_CATEGORIES[agentName] || allCategories),
    ...extraCategories
  ]);

  const definitions = [];
  const handlers = new Map();

  for (const [name, tool] of Object.entries(TOOL_CATALOG)) {
    if (categories.has(tool.category)) {
      definitions.push(tool.definition);
      handlers.set(name, tool.handler);
    }
  }

  return { definitions, handlers };
}
