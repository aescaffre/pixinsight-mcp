#!/usr/bin/env node
// ============================================================================
// CLI wrapper for calling PixInsight agent tools from bash.
// Usage: node scripts/pi-tool.mjs <toolName> [JSON args]
//
// Examples:
//   node scripts/pi-tool.mjs get_image_stats '{"view_id":"M81"}'
//   node scripts/pi-tool.mjs list_open_images '{}'
//   node scripts/pi-tool.mjs run_lhe '{"view_id":"FILTER_L","radius":128,"amount":0.35}'
//   node scripts/pi-tool.mjs pjsr '{"code":"var w=ImageWindow.windowById(\"M81\");w.mainView.image.median();"}'
// ============================================================================
import { createBridgeContext } from '../agents/ops/bridge.mjs';
import { getStats, measureUniformity } from '../agents/ops/stats.mjs';
import { savePreview } from '../agents/ops/preview.mjs';
import { createLumMask, applyMask, removeMask, closeMask } from '../agents/ops/masks.mjs';
import { setiStretch } from '../agents/ops/stretch.mjs';
import { cloneImage, restoreFromClone, closeImage, purgeUndoHistory } from '../agents/ops/image-mgmt.mjs';
import { checkStarQuality, checkRinging, checkSharpness } from '../agents/ops/quality-gates.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ctx = createBridgeContext({ log: (msg) => process.stderr.write(`[pi] ${msg}\n`) });

const toolName = process.argv[2];
const argsJson = process.argv[3] || '{}';

if (!toolName) {
  console.error('Usage: node scripts/pi-tool.mjs <toolName> [JSON args]');
  process.exit(1);
}

let args;
try { args = JSON.parse(argsJson); } catch (e) {
  console.error('Invalid JSON args:', e.message);
  process.exit(1);
}

// Variant storage directory
const VARIANT_DIR = path.join(os.homedir(), '.pixinsight-mcp', 'variants');
fs.mkdirSync(VARIANT_DIR, { recursive: true });

async function run() {
  switch (toolName) {
    // --- Raw PJSR ---
    case 'pjsr': {
      const r = await ctx.pjsr(args.code);
      console.log(JSON.stringify(r));
      break;
    }

    // --- Measurement ---
    case 'get_image_stats': {
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify(stats, null, 2));
      break;
    }
    case 'measure_uniformity': {
      const uni = await measureUniformity(ctx, args.view_id, args.sample_size || 200);
      console.log(JSON.stringify(uni, null, 2));
      break;
    }
    case 'list_open_images': {
      const imgs = await ctx.listImages();
      console.log(JSON.stringify(imgs, null, 2));
      break;
    }

    // --- Image management ---
    case 'clone_image': {
      await cloneImage(ctx, args.source_id, args.clone_id);
      console.log(JSON.stringify({ ok: true, msg: `Cloned ${args.source_id} → ${args.clone_id}` }));
      break;
    }
    case 'restore_from_clone': {
      await restoreFromClone(ctx, args.target_id, args.clone_id);
      console.log(JSON.stringify({ ok: true, msg: `Restored ${args.target_id} from ${args.clone_id}` }));
      break;
    }
    case 'close_image': {
      await closeImage(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, msg: `Closed ${args.view_id}` }));
      break;
    }
    case 'purge_undo': {
      await purgeUndoHistory(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true }));
      break;
    }

    // --- Masks ---
    case 'create_luminance_mask': {
      const result = await createLumMask(ctx, args.source_id, args.mask_id,
        args.blur ?? 5, args.clip_low ?? 0.10, args.gamma ?? 1.0);
      console.log(JSON.stringify({ ok: true, mask_id: result }));
      break;
    }
    case 'apply_mask': {
      await applyMask(ctx, args.target_id, args.mask_id, args.inverted || false);
      console.log(JSON.stringify({ ok: true }));
      break;
    }
    case 'remove_mask': {
      await removeMask(ctx, args.target_id);
      console.log(JSON.stringify({ ok: true }));
      break;
    }
    case 'close_mask': {
      await closeMask(ctx, args.mask_id);
      console.log(JSON.stringify({ ok: true }));
      break;
    }

    // --- LHE ---
    case 'run_lhe': {
      await ctx.pjsr(`
        var P = new LocalHistogramEqualization;
        P.radius = ${args.radius};
        P.slopeLimit = ${args.slope_limit ?? 1.5};
        P.amount = ${args.amount};
        P.circularKernel = true;
        P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
      `);
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- HDRMT ---
    case 'run_hdrmt': {
      const inverted = args.inverted ? 'true' : 'false';
      const toLightness = (args.to_lightness !== false) ? 'true' : 'false';
      const preserveHue = (args.preserve_hue !== false) ? 'true' : 'false';
      await ctx.pjsr(`
        var P = new HDRMultiscaleTransform;
        P.numberOfLayers = ${args.layers};
        P.numberOfIterations = ${args.iterations ?? 1};
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
        P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
      `);
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- NXT ---
    case 'run_nxt': {
      await ctx.pjsr(`
        var P = new NoiseXTerminator;
        P.denoise = ${args.denoise};
        P.detail = ${args.detail ?? 0.15};
        P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
      `);
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- Curves ---
    case 'run_curves': {
      const channelProp = { R: 'R', G: 'G', B: 'B', RGB: 'K', L: 'L', S: 'S' };
      const prop = channelProp[args.channel] || 'K';
      const pts = args.points.map(p => `[${p[0]},${p[1]}]`).join(',');
      await ctx.pjsr(`
        var P = new CurvesTransformation;
        P.${prop} = [${pts}];
        P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
      `);
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- PixelMath ---
    case 'run_pixelmath': {
      const useSingle = (args.single_expression !== false) ? 'true' : 'false';
      await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "${args.expression.replace(/"/g, '\\"')}";
        P.useSingleExpression = ${useSingle};
        ${args.symbols ? `P.symbols = "${args.symbols}";` : ''}
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
      `);
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- PixelMath with per-channel expressions ---
    case 'run_pixelmath_rgb': {
      await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "${args.expression_r.replace(/"/g, '\\"')}";
        P.expression1 = "${args.expression_g.replace(/"/g, '\\"')}";
        P.expression2 = "${args.expression_b.replace(/"/g, '\\"')}";
        P.useSingleExpression = false;
        ${args.symbols ? `P.symbols = "${args.symbols}";` : ''}
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${args.view_id}').mainView);
      `);
      const stats = await getStats(ctx, args.view_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- Star screen blend ---
    case 'star_screen_blend': {
      const str = args.strength ?? 0.85;
      await ctx.pjsr(`
        var P = new PixelMath;
        P.expression = "~(~${args.target_id} * ~(${args.stars_id} * ${str}))";
        P.useSingleExpression = true;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${args.target_id}').mainView);
      `);
      const stats = await getStats(ctx, args.target_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- Star stretch ---
    case 'stretch_stars': {
      const midtone = args.midtone ?? 0.20;
      const iterations = args.iterations ?? 5;
      const r = await ctx.pjsr(`
        var w = ImageWindow.windowById('${args.view_id}');
        if (w.isNull) throw new Error('View not found: ${args.view_id}');
        var v = w.mainView;
        var med = v.image.median();
        if (med > 0.00001) {
          var P = new PixelMath;
          P.expression = 'max(0, ($T - ' + med + ') / (1 - ' + med + '))';
          P.useSingleExpression = true;
          P.createNewImage = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(v);
        }
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
      `);
      console.log(JSON.stringify({ ok: true, result: r.outputs?.consoleOutput }));
      break;
    }

    // --- Seti stretch ---
    case 'seti_stretch': {
      const stats = await setiStretch(ctx, args.view_id, {
        targetMedian: args.target_median ?? 0.25,
        hdrCompress: args.hdr_compress ?? true,
        hdrAmount: args.hdr_amount ?? 0.25,
        hdrKnee: 0.35,
        hdrHeadroom: args.hdr_headroom ?? 0.05
      });
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- LRGB combine ---
    case 'lrgb_combine': {
      const lightness = args.lightness ?? 0.55;
      const saturation = args.saturation ?? 0.80;
      const tgt = args.rgb_id;
      // Step 1: LinearFit L to RGB luminance
      await ctx.pjsr(`
        var rgbW = ImageWindow.windowById('${args.rgb_id}');
        var lW = ImageWindow.windowById('${args.l_id}');
        if (rgbW.isNull) throw new Error('RGB not found: ${args.rgb_id}');
        if (lW.isNull) throw new Error('L not found: ${args.l_id}');
        var img = rgbW.mainView.image;
        var w = img.width, h = img.height;
        var lumRef = new ImageWindow(w, h, 1, 32, true, false, 'lrgb_lum_ref');
        lumRef.show();
        var PM = new PixelMath;
        PM.expression = '0.2126*${args.rgb_id}[0] + 0.7152*${args.rgb_id}[1] + 0.0722*${args.rgb_id}[2]';
        PM.useSingleExpression = true;
        PM.createNewImage = false;
        PM.executeOn(lumRef.mainView);
        var LF = new LinearFit;
        LF.referenceViewId = 'lrgb_lum_ref';
        LF.rejectHigh = 0.92;
        LF.executeOn(lW.mainView);
        lumRef.forceClose();
        'LinearFit done';
      `);
      // Step 2: Extract channels, clone L, run LRGBCombination
      await ctx.pjsr(`
        var CE = new ChannelExtraction;
        CE.channelEnabled = [true, true, true];
        CE.channelId = ['${tgt}_R', '${tgt}_G', '${tgt}_B'];
        CE.colorSpace = ChannelExtraction.prototype.RGB;
        CE.sampleFormat = ChannelExtraction.prototype.SameAsSource;
        CE.executeOn(ImageWindow.windowById('${tgt}').mainView);
      `);
      await ctx.pjsr(`
        var src = ImageWindow.windowById('${args.l_id}');
        var img = src.mainView.image;
        var dst = new ImageWindow(img.width, img.height, 1, 32, true, false, '${tgt}_L');
        dst.show();
        var PM = new PixelMath;
        PM.expression = '${args.l_id}';
        PM.useSingleExpression = true;
        PM.createNewImage = false;
        PM.executeOn(dst.mainView);
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
      // Cleanup
      await ctx.pjsr(`
        var ids = ['${tgt}_R','${tgt}_G','${tgt}_B','${tgt}_L'];
        for (var i = 0; i < ids.length; i++) {
          var w = ImageWindow.windowById(ids[i]);
          if (!w.isNull) w.forceClose();
        }
      `);
      const lrgbOut = r.outputs?.consoleOutput?.trim() || '';
      if (r.status === 'error' || lrgbOut.includes('LRGB_FAILED')) {
        // Fallback PixelMath
        await ctx.pjsr(`
          var PM = new PixelMath;
          PM.expression = "Yo = 0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2]; Yb = (1-${lightness})*Yo + ${lightness}*${args.l_id}; ratio = min(max(Yb, 0.00001) / max(Yo, 0.00001), 3.0); $T * ratio";
          PM.symbols = "Yo, Yb, ratio";
          PM.useSingleExpression = true;
          PM.use64BitWorkingImage = true;
          PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
          PM.createNewImage = false;
          PM.executeOn(ImageWindow.windowById('${args.rgb_id}').mainView);
        `);
      }
      const stats = await getStats(ctx, args.rgb_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- Ha injection ---
    case 'ha_inject_red': {
      const str = args.strength ?? 0.30;
      const limit = args.brightness_limit ?? 0.25;
      await ctx.pjsr(`
        var PM = new PixelMath;
        PM.expression = "iif(${args.ha_id} > ${args.target_id}[0] * (1 + ${limit}), ${args.target_id}[0] + ${str} * (${args.ha_id} - ${args.target_id}[0]), ${args.target_id}[0])";
        PM.expression1 = "${args.target_id}[1]";
        PM.expression2 = "${args.target_id}[2]";
        PM.useSingleExpression = false;
        PM.use64BitWorkingImage = true;
        PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
        PM.createNewImage = false;
        PM.executeOn(ImageWindow.windowById('${args.target_id}').mainView);
      `);
      const stats = await getStats(ctx, args.target_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }
    case 'ha_inject_luminance': {
      const str = args.strength ?? 0.20;
      await ctx.pjsr(`
        var PM = new PixelMath;
        PM.expression = "$T + ${str} * max(${args.ha_id} - (0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2]), 0) * $T / max(0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2], 0.00001)";
        PM.useSingleExpression = true;
        PM.use64BitWorkingImage = true;
        PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
        PM.createNewImage = false;
        PM.executeOn(ImageWindow.windowById('${args.target_id}').mainView);
      `);
      const stats = await getStats(ctx, args.target_id);
      console.log(JSON.stringify({ ok: true, stats }));
      break;
    }

    // --- Quality gates ---
    case 'check_star_quality': {
      const result = await checkStarQuality(ctx, args.view_id);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'check_ringing': {
      const result = await checkRinging(ctx, args.view_id);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'check_sharpness': {
      const result = await checkSharpness(ctx, args.view_id);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    // --- Save preview ---
    case 'save_preview': {
      const previewDir = path.join(os.homedir(), '.pixinsight-mcp', 'previews');
      fs.mkdirSync(previewDir, { recursive: true });
      const previewPath = path.join(previewDir, `${args.label}.jpg`);
      await ctx.pjsr(`
        var srcW = ImageWindow.windowById('${args.view_id}');
        if (srcW.isNull) throw new Error('View not found: ${args.view_id}');
        var img = srcW.mainView.image;
        var w = img.width, h = img.height;
        var scale = Math.min(1, 2048 / Math.max(w, h));
        var nw = Math.round(w * scale), nh = Math.round(h * scale);
        var tmp = new ImageWindow(nw, nh, img.numberOfChannels, 32, false, img.isColor, 'preview_tmp');
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
      console.log(JSON.stringify({ ok: true, path: previewPath }));
      break;
    }

    // --- Save variant (XISF to disk) ---
    case 'save_variant': {
      const variantPath = path.join(VARIANT_DIR, `${args.name}.xisf`);
      await ctx.pjsr(`
        var w = ImageWindow.windowById('${args.view_id}');
        if (w.isNull) throw new Error('View not found: ${args.view_id}');
        var p = '${variantPath.replace(/'/g, "\\'")}';
        if (File.exists(p)) File.remove(p);
        w.saveAs(p, false, false, false, false);
        'OK';
      `);
      const stats = await getStats(ctx, args.view_id);
      // Save metadata
      const metaPath = path.join(VARIANT_DIR, `${args.name}.json`);
      fs.writeFileSync(metaPath, JSON.stringify({ name: args.name, view_id: args.view_id, notes: args.notes || '', stats, timestamp: new Date().toISOString() }, null, 2));
      console.log(JSON.stringify({ ok: true, path: variantPath, stats }));
      break;
    }

    // --- Load variant ---
    case 'load_variant': {
      const variantPath = path.join(VARIANT_DIR, `${args.name}.xisf`);
      const targetId = args.target_id || args.name;
      const r = await ctx.pjsr(`
        var wins = ImageWindow.open('${variantPath.replace(/'/g, "\\'")}');
        if (!wins || wins.length === 0) throw new Error('Cannot open variant');
        var w = wins[0];
        w.mainView.id = '${targetId}';
        // Close crop masks
        var allW = ImageWindow.windows;
        for (var i = 0; i < allW.length; i++) {
          if (allW[i].mainView.id.indexOf('crop_mask') >= 0) allW[i].forceClose();
        }
        '${targetId}';
      `);
      console.log(JSON.stringify({ ok: true, view_id: targetId }));
      break;
    }

    // --- List variants ---
    case 'list_variants': {
      const files = fs.readdirSync(VARIANT_DIR).filter(f => f.endsWith('.json'));
      const variants = files.map(f => {
        const meta = JSON.parse(fs.readFileSync(path.join(VARIANT_DIR, f), 'utf-8'));
        return meta;
      });
      console.log(JSON.stringify(variants, null, 2));
      break;
    }

    default:
      console.error(`Unknown tool: ${toolName}`);
      process.exit(1);
  }
}

run().catch(e => { console.error('Error:', e.message); process.exit(1); });
