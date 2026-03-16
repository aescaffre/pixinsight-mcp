// ============================================================================
// Tool definitions and handlers: maps ops library to Claude API tool_use
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getStats, measureUniformity,
  savePreview,
  cloneImage, restoreFromClone, closeImage, purgeUndoHistory,
  runGC, runABE,
  setiStretch,
  createLumMask, applyMask, removeMask, closeMask,
} from '../ops/index.mjs';
import { checkHardConstraints, statsToScores, computeAggregate } from '../scoring.mjs';
import { jpegToContentBlock } from './vision.mjs';

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
      const textSummary = `Preview saved: ${input.label}\nStats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}`;

      // Return multi-content: text + image
      if (fs.existsSync(previewPath)) {
        return [
          { type: 'text', text: textSummary },
          jpegToContentBlock(previewPath)
        ];
      }
      return { type: 'text', text: textSummary + '\n(Preview file not created)' };
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
      const r = await ctx.send('run_process', '__internal__', {
        processId: 'NoiseXTerminator',
        viewId: input.view_id,
        params: { denoise: input.denoise, detail: input.detail ?? 0.15 }
      });
      if (r.status === 'error') {
        // Fallback: direct PJSR
        await ctx.pjsr(`
          var P = new NoiseXTerminator;
          P.denoise = ${input.denoise};
          P.detail = ${input.detail ?? 0.15};
          P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
        `);
      }
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
          // Use PixInsight's native API to copy the full astrometric solution
          tgtW.copyAstrometricSolution(srcW);
          info = 'Astrometric solution copied (hasAstro=' + tgtW.hasAstrometricSolution + ')';
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

  run_scnr: {
    category: 'calibration',
    definition: {
      name: 'run_scnr',
      description: 'Run SCNR (Subtractive Chromatic Noise Reduction) to remove green cast. Use amount=0.50-1.00.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          amount: { type: 'number', description: 'SCNR amount (0.0-1.0, default 0.80)' }
        },
        required: ['view_id']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await ctx.pjsr(`
        var P = new SCNR;
        P.amount = ${input.amount ?? 0.80};
        P.protectionMethod = SCNR.prototype.AverageNeutral;
        P.colorToRemove = SCNR.prototype.Green;
        P.preserveLightness = true;
        P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
      `);
      return { type: 'text', text: `SCNR complete (amount=${input.amount ?? 0.80})` };
    }
  },

  // --- Detail ---
  run_lhe: {
    category: 'detail',
    definition: {
      name: 'run_lhe',
      description: 'Run LocalHistogramEqualization for local contrast enhancement. ALWAYS use with a luminance mask to protect background. Multi-scale approach: large radius (64-128) for overall structure, then smaller (32-48) for fine detail.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID to process' },
          radius: { type: 'integer', description: 'Kernel radius in pixels (24-128)' },
          amount: { type: 'number', description: 'Effect strength (0.10-0.50, recommend 0.15-0.30)' },
          slope_limit: { type: 'number', description: 'Contrast slope limiter (1.1-2.5, default 1.5)' }
        },
        required: ['view_id', 'radius', 'amount']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      await ctx.pjsr(`
        var P = new LocalHistogramEqualization;
        P.radius = ${input.radius};
        P.slopeLimit = ${input.slope_limit ?? 1.5};
        P.amount = ${input.amount};
        P.circularKernel = true;
        P.executeOn(ImageWindow.windowById('${input.view_id}').mainView);
      `);
      const stats = await getStats(ctx, input.view_id);
      return { type: 'text', text: `LHE complete (r=${input.radius}, a=${input.amount}). Stats: median=${stats.median.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}` };
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
      return { type: 'text', text: `HDRMT complete (layers=${input.layers}, inverted=${inverted}). Stats: median=${stats.median.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}` };
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
      return { type: 'text', text: `Curves (${input.channel}) applied. Stats: median=${stats.median.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}` };
    }
  },

  run_pixelmath: {
    category: 'curves',
    definition: {
      name: 'run_pixelmath',
      description: 'Run an arbitrary PixelMath expression. CAUTION: pow() is not available — use exp(exponent*ln(base)) instead.',
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
      return { type: 'text', text: `PixelMath applied. Stats: median=${stats.median.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}` };
    }
  },

  // --- Stars ---
  star_screen_blend: {
    category: 'stars',
    definition: {
      name: 'star_screen_blend',
      description: 'Add stars back via screen blend: ~(~target * ~(stars * strength)). Screen blend avoids SXT residual rim artifacts that additive shows.',
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
    handler: async (ctx, _store, _brief, input) => {
      const str = input.strength ?? 0.85;
      await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "~(~${input.target_id} * ~(${input.stars_id} * ${str}))";
        P.useSingleExpression = true;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${input.target_id}').mainView);
      `);
      return { type: 'text', text: `Stars blended (screen, strength=${str})` };
    }
  },

  // --- Artifacts ---
  save_variant: {
    category: 'artifacts',
    definition: {
      name: 'save_variant',
      description: 'Save the current image as a named variant. Use this to checkpoint good results so you can compare later.',
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
      return { type: 'text', text: `Variant saved: ${result.artifactId}\nStats: median=${stats.median.toFixed(6)}, uniformity=${uni.score.toFixed(6)}` };
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
    handler: async (ctx, _store, _brief, input) => {
      const lightness = input.lightness ?? 0.55;
      const saturation = input.saturation ?? 0.80;

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

      // Step 2: LRGB combine via PixelMath (luminance replacement)
      // Formula: RGB * max(Y_blend, 0.00001) / max(Y_original, 0.00001)
      // where Y_blend = (1-lightness)*Y_original + lightness*L
      await ctx.pjsr(`
        var l = ${lightness};
        var PM = new PixelMath;
        PM.expression = "Y = 0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2]; Y_blend = (1-${lightness})*Y + ${lightness}*${input.l_id}; $T * max(Y_blend, 0.00001) / max(Y, 0.00001)";
        PM.symbols = "Y, Y_blend";
        PM.useSingleExpression = true;
        PM.use64BitWorkingImage = true;
        PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
        PM.createNewImage = false;
        PM.executeOn(ImageWindow.windowById('${input.rgb_id}').mainView);
      `);

      const stats = await getStats(ctx, input.rgb_id);
      return { type: 'text', text: `LRGB combined (lightness=${lightness}, saturation=${saturation}). Stats: median=${stats.median.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)}` };
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
          brightness_limit: { type: 'number', description: 'Only inject where Ha exceeds this fraction of red channel (0.0-0.50, default 0.25)' }
        },
        required: ['target_id', 'ha_id', 'strength']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const str = input.strength ?? 0.30;
      const limit = input.brightness_limit ?? 0.25;
      // Conditional R-channel boost: add Ha where it exceeds R by limit fraction
      await ctx.pjsr(`
        var PM = new PixelMath;
        PM.expression = "iif(${input.ha_id} > ${input.target_id}[0] * (1 + ${limit}), ${input.target_id}[0] + ${str} * (${input.ha_id} - ${input.target_id}[0]), ${input.target_id}[0])";
        PM.expression1 = "${input.target_id}[1]";
        PM.expression2 = "${input.target_id}[2]";
        PM.useSingleExpression = false;
        PM.use64BitWorkingImage = true;
        PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
        PM.createNewImage = false;
        PM.executeOn(ImageWindow.windowById('${input.target_id}').mainView);
      `);
      const stats = await getStats(ctx, input.target_id);
      return { type: 'text', text: `Ha injected into red channel (strength=${str}, limit=${limit}). Stats: median=${stats.median.toFixed(6)}` };
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

  // --- Memory ---
  recall_memory: {
    category: 'memory',
    definition: {
      name: 'recall_memory',
      description: 'Read your memory from previous runs. Returns all lessons, patterns, and notes you saved before. ALWAYS call this at the start of your work to avoid repeating past mistakes.',
      input_schema: { type: 'object', properties: {} }
    },
    handler: async (_ctx, _store, _brief, _input, agentName) => {
      const memDir = path.join(os.homedir(), '.pixinsight-mcp', 'agent-memory');
      const memFile = path.join(memDir, `${agentName}.json`);
      if (!fs.existsSync(memFile)) return { type: 'text', text: 'No memories yet. This is your first run.' };
      const entries = JSON.parse(fs.readFileSync(memFile, 'utf-8'));
      const summary = entries.map(e => `[${e.date}] **${e.title}**: ${e.content}`).join('\n\n');
      return { type: 'text', text: `## Your memories (${entries.length} entries)\n\n${summary}` };
    }
  },

  save_memory: {
    category: 'memory',
    definition: {
      name: 'save_memory',
      description: 'Save a lesson or insight for future runs. Use this when you discover something important: a gotcha, a parameter that worked well, a technique to avoid, or a pattern specific to a target type. Be specific and actionable.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the memory (e.g. "BXT strips WCS", "M81 needs SCNR 0.65")' },
          content: { type: 'string', description: 'Detailed lesson. Include what happened, why, and what to do differently.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for retrieval (e.g. ["galaxy", "spcc", "gotcha"])'
          }
        },
        required: ['title', 'content']
      }
    },
    handler: async (_ctx, _store, _brief, input, agentName) => {
      const memDir = path.join(os.homedir(), '.pixinsight-mcp', 'agent-memory');
      fs.mkdirSync(memDir, { recursive: true });
      const memFile = path.join(memDir, `${agentName}.json`);
      let entries = [];
      if (fs.existsSync(memFile)) entries = JSON.parse(fs.readFileSync(memFile, 'utf-8'));
      entries.push({
        title: input.title,
        content: input.content,
        tags: input.tags || [],
        date: new Date().toISOString().slice(0, 10),
        timestamp: new Date().toISOString()
      });
      fs.writeFileSync(memFile, JSON.stringify(entries, null, 2));
      return { type: 'text', text: `Memory saved: "${input.title}"` };
    }
  },

  // --- Control ---
  finish: {
    category: 'control',
    definition: {
      name: 'finish',
      description: 'Signal that you are done processing. Call this when satisfied with the result or when you want to submit your best work.',
      input_schema: {
        type: 'object',
        properties: {
          view_id: { type: 'string', description: 'View ID of your best result' },
          rationale: { type: 'string', description: 'Explain why this is your best result and what trade-offs you made' },
          params_summary: { type: 'object', description: 'Key parameters used in the winning approach' }
        },
        required: ['view_id', 'rationale']
      }
    },
    handler: async (ctx, _store, _brief, input) => {
      const stats = await getStats(ctx, input.view_id);
      return {
        type: 'text',
        text: `Finished. Best: ${input.view_id} (median=${stats.median.toFixed(6)}, max=${(stats.max ?? 0).toFixed(4)})\nRationale: ${input.rationale}`
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

      // Find the aligned output file
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('aligned_'));
      if (files.length === 0) return { type: 'text', text: 'StarAlignment produced no output file' };

      const alignedPath = path.join(tmpDir, files[0]);

      // Close old target, open aligned, rename
      await ctx.pjsr(`var w = ImageWindow.windowById('${input.target_id}'); if (!w.isNull) w.forceClose();`);
      await ctx.send('open_image', '__internal__', { filePath: alignedPath });

      // Close crop masks
      const imgs = await ctx.listImages();
      for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
      }

      // Find and rename the new view
      const newImgs = await ctx.listImages();
      const aligned = newImgs.find(i => i.id.includes('aligned') || (!i.isColor && i.id !== input.reference_id));
      if (aligned && aligned.id !== input.target_id) {
        await ctx.pjsr(`var w = ImageWindow.windowById('${aligned.id}'); if (!w.isNull) w.mainView.id = '${input.target_id}';`);
      }

      // Verify
      const dimR = await ctx.pjsr(`
        var r = ImageWindow.windowById('${input.reference_id}');
        var t = ImageWindow.windowById('${input.target_id}');
        JSON.stringify({ ref: { w: r.mainView.image.width, h: r.mainView.image.height }, tgt: { w: t.mainView.image.width, h: t.mainView.image.height } });
      `);
      return { type: 'text', text: `Aligned ${input.target_id} to ${input.reference_id}. Dimensions: ${dimR.outputs?.consoleOutput}` };
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
  ha_integration: ['measurement', 'preview', 'image_mgmt', 'gradient', 'denoise', 'sharpen', 'stretch', 'masks', 'ha_injection', 'star_removal', 'memory', 'artifacts', 'control'],
  composition: ['measurement', 'preview', 'image_mgmt', 'curves', 'stars', 'lrgb', 'memory', 'artifacts', 'control'],
  aesthetic_critic: ['measurement', 'memory', 'control', 'scoring'],
  technical_critic: ['measurement', 'memory', 'control', 'scoring'],
};

/**
 * Build the tool set for an agent.
 * @param {string} agentName - Agent identifier (determines which tool categories are available)
 * @param {string[]} extraCategories - Additional categories to include
 * @returns {{ definitions: Array, handlers: Map }}
 */
export function buildToolSet(agentName, extraCategories = []) {
  const categories = new Set([
    ...(AGENT_TOOL_CATEGORIES[agentName] || Object.keys(TOOL_CATALOG)),
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
