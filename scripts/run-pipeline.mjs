import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';

const home = os.homedir();
const cmdDir = path.join(home, '.pixinsight-mcp/bridge/commands');
const resDir = path.join(home, '.pixinsight-mcp/bridge/results');

// ============================================================================
// CONFIG LOADING
// ============================================================================
const configArg = process.argv.indexOf('--config');
const CONFIG_PATH = configArg >= 0 && process.argv[configArg + 1]
  ? process.argv[configArg + 1]
  : path.join(home, '.pixinsight-mcp', 'pipeline-config.json');

const restartArg = process.argv.indexOf('--restart-from');
const RESTART_FROM = restartArg >= 0 ? process.argv[restartArg + 1] : null;
const CHECKPOINT_DIR = path.join(home, '.pixinsight-mcp', 'checkpoints');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'editor', 'default-config.json');

// Hardcoded fallback for backward compatibility (no config file at all)
const FALLBACK_FILES = {
  L: '',
  R: '',
  G: '',
  B: '',
  Ha: '',
  outputDir: '',
  targetName: 'RosettaNebula'
};

function loadConfig() {
  // Try explicit config path
  if (fs.existsSync(CONFIG_PATH)) {
    log('Loading config: ' + CONFIG_PATH);
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
  // Try default config from editor
  if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
    log('Loading default config: ' + DEFAULT_CONFIG_PATH);
    const cfg = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf-8'));
    // Fill in fallback file paths if empty
    for (const [k, v] of Object.entries(FALLBACK_FILES)) {
      if (!cfg.files[k]) cfg.files[k] = v;
    }
    return cfg;
  }
  // Pure fallback — build config from hardcoded values
  log('No config file found, using hardcoded defaults.');
  return {
    version: 2, name: 'RosettaNebula HaLRGB',
    files: { ...FALLBACK_FILES },
    branches: { main: { label: 'RGB', color: '#4a9eff' }, stars: { label: 'Stars', color: '#f5c542', forkAfter: 'sxt' }, ha: { label: 'H-alpha', color: '#e94560', forkAfter: 'combine_rgb' }, lum: { label: 'Luminance', color: '#c084fc', forkAfter: 'sxt' } },
    steps: [
      { id: 'combine_rgb', name: 'Combine RGB', branch: 'main', enabled: true, params: {} },
      { id: 'gc', name: 'GradientCorrection', branch: 'main', enabled: true, params: {} },
      { id: 'bxt_correct', name: 'BXT (correctOnly)', branch: 'main', enabled: true, params: { sharpenStars: 0.50, sharpenNonstellar: 0.75, adjustStarHalos: 0.00 } },
      { id: 'plate_solve', name: 'Plate Solve', branch: 'main', enabled: true, params: {} },
      { id: 'spcc', name: 'SPCC', branch: 'main', enabled: true, params: { whiteReferenceName: 'Average Spiral Galaxy', sensorQE: 'Sony IMX411/455/461/533/571', filterSet: 'Astronomik Deep Sky', narrowbandMode: false, generateGraphs: false } },
      { id: 'scnr', name: 'SCNR', branch: 'main', enabled: true, params: { amount: 1.0 } },
      { id: 'bxt_sharpen', name: 'BXT (sharpening)', branch: 'main', enabled: true, params: { sharpenStars: 0.25, sharpenNonstellar: 0.50, adjustStarHalos: -0.25 } },
      { id: 'nxt_pass1', name: 'NXT Pass 1', branch: 'main', enabled: true, params: { denoise: 0.30, detail: 0.15 } },
      { id: 'sxt', name: 'SXT', branch: 'main', enabled: true, params: { overlap: 0.20 } },
      { id: 'star_stretch', name: 'Star Stretch', branch: 'stars', enabled: true, params: { targetBg: 0.50 } },
      { id: 'star_saturate', name: 'Star Saturation', branch: 'stars', enabled: true, params: { starSaturationCurve: [[0,0],[0.35,0.55],[0.65,0.85],[1,1]] } },
      { id: 'ha_sxt', name: 'Ha SXT', branch: 'ha', enabled: true, params: { overlap: 0.20 } },
      { id: 'ha_stretch', name: 'Ha Stretch', branch: 'ha', enabled: true, params: { targetBg: 0.25 } },
      { id: 'ha_curves', name: 'Ha Curves', branch: 'ha', enabled: true, params: { haCurve: [[0,0],[0.15,0.10],[0.50,0.55],[0.85,0.92],[1,1]] } },
      { id: 'ha_ghs', name: 'Ha GHS', branch: 'ha', enabled: true, params: { haGHS: { D: 0.5, B: -1.0, LP: 0.02, HP: 0.95 } } },
      { id: 'ha_linearfit', name: 'Ha LinearFit', branch: 'ha', enabled: false, params: { linearFitRejectHigh: 0.92 } },
      { id: 'l_stretch', name: 'L Stretch', branch: 'lum', enabled: true, params: { targetBg: 0.25 } },
      { id: 'l_nxt', name: 'L NXT', branch: 'lum', enabled: true, params: { denoise: 0.50, detail: 0.15 } },
      { id: 'l_bxt', name: 'L BXT', branch: 'lum', enabled: false, params: { sharpenStars: 0.25, sharpenNonstellar: 0.50, adjustStarHalos: 0.00 } },
      { id: 'stretch', name: 'Stretch (HT+GHS)', branch: 'main', enabled: true, params: { targetBg: 0.25, ghsPasses: [{ label: 'Midtone boost', D: 0.8, B: -1.0, LP: 0.02, HP: 0.95 }, { label: 'Fine contrast', D: 0.5, B: -1.5, LP: 0.03, HP: 0.90 }] } },
      { id: 'nxt_pass2', name: 'NXT Pass 2', branch: 'main', enabled: true, params: { denoise: 0.60, detail: 0.15 } },
      { id: 'curves_main', name: 'Curves', branch: 'main', enabled: true, params: { contrastCurve: [[0,0],[0.10,0.06],[0.50,0.55],[0.90,0.95],[1,1]], saturationCurve: [[0,0],[0.50,0.62],[1,1]] } },
      { id: 'ha_inject', name: 'Ha Injection', branch: 'main', merges: ['ha'], enabled: true, params: { injectionStrength: 0.5 } },
      { id: 'lrgb_combine', name: 'LRGB Combine', branch: 'main', merges: ['lum'], enabled: true, params: { lightness: 0.50, saturation: 0.50 } },
      { id: 'lhe', name: 'LHE (Local Contrast)', branch: 'main', enabled: false, params: { radius: 64, amount: 0.70, slopeLimit: 2.0 } },
      { id: 'curves_final', name: 'Final Curves', branch: 'main', enabled: true, params: { lightnessCurve: [[0,0],[0.15,0.12],[0.50,0.52],[0.85,0.88],[1,1]], saturationCurve: [[0,0],[0.45,0.52],[1,1]] } },
      { id: 'star_add', name: 'Star Addition', branch: 'main', merges: ['stars'], enabled: true, params: { starStrength: 0.20 } }
    ]
  };
}

// ============================================================================
// CONFIG HELPERS
// ============================================================================
let CFG;

function getStep(id) { return CFG.steps.find(s => s.id === id); }
function isEnabled(id) { const s = getStep(id); return s ? s.enabled : true; }
function P(id) { const s = getStep(id); return s ? s.params : {}; }

// ============================================================================
// CHECKPOINT SYSTEM
// ============================================================================
const liveImages = {};

function shouldSkip(stepId) {
  if (!RESTART_FROM) return false;
  const steps = CFG.steps;
  const targetIdx = steps.findIndex(s => s.id === RESTART_FROM);
  const currentIdx = steps.findIndex(s => s.id === stepId);
  if (targetIdx < 0) return false;
  return currentIdx < targetIdx;
}

async function saveCheckpoint(stepId) {
  if (!fs.existsSync(CHECKPOINT_DIR)) fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  const manifest = { stepId, timestamp: new Date().toISOString(), images: {} };

  for (const [branch, viewId] of Object.entries(liveImages)) {
    const filename = `checkpoint_${stepId}_${branch}.xisf`;
    const filePath = path.join(CHECKPOINT_DIR, filename);
    log(`    [checkpoint] Saving ${branch} (${viewId}) -> ${filename}`);
    const r = await pjsr(`
      var w = ImageWindow.windowById('${viewId}');
      if (w.isNull) throw new Error('View not found: ${viewId}');
      var p = '${filePath.replace(/'/g, "\\'")}';
      if (File.exists(p)) File.remove(p);
      w.saveAs(p, false, false, false, false);
      // saveAs may rename view to match filename — rename back to original
      if (w.mainView.id !== '${viewId}') {
        w.mainView.id = '${viewId}';
      }
      'OK';
    `);
    if (r.status === 'error') {
      log('    [checkpoint] WARN: ' + r.error.message);
      continue;
    }
    manifest.images[branch] = { viewId, filename };
  }

  const manifestPath = path.join(CHECKPOINT_DIR, `checkpoint_${stepId}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log(`    [checkpoint] Saved checkpoint: ${stepId} (${Object.keys(manifest.images).length} images)`);
}

async function loadCheckpoint(stepId) {
  const manifestPath = path.join(CHECKPOINT_DIR, `checkpoint_${stepId}.json`);
  if (!fs.existsSync(manifestPath)) throw new Error('No checkpoint found for: ' + stepId);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  log('  Checkpoint timestamp: ' + manifest.timestamp);

  // Close all currently open images
  let imgs = await listImages();
  if (imgs.length > 0) {
    const ids = imgs.map(i => "'" + i.id + "'").join(',');
    await pjsr(`var ids=[${ids}]; for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(!w.isNull)w.forceClose();processEvents();}`);
  }

  // Clear liveImages
  for (const k of Object.keys(liveImages)) delete liveImages[k];

  // Open each checkpoint image
  for (const [branch, info] of Object.entries(manifest.images)) {
    const filePath = path.join(CHECKPOINT_DIR, info.filename);
    log(`  Loading ${branch}: ${info.filename} (viewId: ${info.viewId})`);
    const r = await send('open_image', '__internal__', { filePath });
    if (r.status === 'error') { log('  WARN: ' + r.error.message); continue; }

    // Close crop masks
    const allImgs = await listImages();
    for (const cm of allImgs.filter(i => i.id.indexOf('crop_mask') >= 0)) {
      await pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
    }

    // Rename view to original viewId if different
    const loadedId = r.outputs.id;
    if (loadedId !== info.viewId) {
      await pjsr(`
        var w = ImageWindow.windowById('${loadedId}');
        if (!w.isNull) { w.mainView.id = '${info.viewId}'; }
      `);
    }
    liveImages[branch] = info.viewId;
  }

  log('  Restored branches: ' + Object.keys(liveImages).join(', '));
}

// Auto-checkpoint after these heavy steps (always, unless config explicitly sets checkpoint: false)
const AUTO_CHECKPOINT_STEPS = new Set(['sxt', 'stretch', 'ha_inject', 'curves_main']);

async function maybeCheckpoint(id) {
  const step = getStep(id);
  const shouldCkpt = step?.checkpoint === true || (step?.checkpoint !== false && AUTO_CHECKPOINT_STEPS.has(id));
  if (shouldCkpt && isEnabled(id) && !shouldSkip(id)) await saveCheckpoint(id);
}

// ============================================================================
// MASK UTILITIES
// ============================================================================

// Create a mask from a grayscale view (blur + shadow clip for smooth transitions)
async function createMask(sourceViewId, maskId, blur = 5, clipLow = 0.10) {
  // Step 1: Query dimensions (PJSR Image.width/height don't pass cleanly to ImageWindow constructor)
  const dimR = await pjsr(`
    var srcW = ImageWindow.windowById('${sourceViewId}');
    if (srcW.isNull) throw new Error('Source not found: ${sourceViewId}. Windows: ' + ImageWindow.windows.map(function(w){return w.mainView.id;}).join(','));
    var img = srcW.mainView.image;
    JSON.stringify({ w: Math.round(img.width), h: Math.round(img.height), id: srcW.mainView.id });
  `);
  if (dimR.status === 'error') {
    log(`  [mask] WARN: ${maskId}: ${dimR.error.message}`);
    return null;
  }
  const rawOutput = dimR.outputs?.consoleOutput?.trim() || '{}';
  const dims = JSON.parse(rawOutput);
  if (!dims.w || !dims.h) {
    log(`  [mask] WARN: ${maskId}: invalid dimensions (raw=${rawOutput})`);
    return null;
  }

  // Step 2: Create mask with JS-interpolated literal dimensions
  const r = await pjsr(`
    var old = ImageWindow.windowById('${maskId}');
    if (!old.isNull) old.forceClose();
    var srcW = ImageWindow.windowById('${sourceViewId}');
    var maskW = new ImageWindow(${dims.w}, ${dims.h}, 1, 32, true, false, '${maskId}');
    maskW.mainView.beginProcess();
    maskW.mainView.image.assign(srcW.mainView.image);
    maskW.mainView.endProcess();
    ${blur > 0 ? `var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = ${blur}; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(maskW.mainView);` : ''}
    ${clipLow > 0 ? `var PM = new PixelMath; PM.expression = 'iif($T<${clipLow},0,($T-${clipLow})/${(1 - clipLow).toFixed(4)})'; PM.useSingleExpression = true; PM.createNewImage = false; PM.use64BitWorkingImage = true; PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1; PM.executeOn(maskW.mainView);` : ''}
    maskW.show();
    'OK';
  `);
  if (r.status === 'error') {
    log(`  [mask] WARN: ${maskId}: ${r.error.message}`);
    return null;
  }
  log(`  [mask] Created ${maskId} (blur=${blur}, clipLow=${clipLow}, ${dims.w}x${dims.h})`);
  return maskId;
}

// Create luminance mask from a COLOR view
async function createLumMask(sourceViewId, maskId, blur = 5, clipLow = 0.10, gamma = 1.0) {
  // Step 1: Query dimensions (PJSR Image.width/height don't pass cleanly to ImageWindow constructor)
  // NOTE: ImageWindow.windowById() always returns an object — use .isNull to check
  const dimR = await pjsr(`
    var srcW = ImageWindow.windowById('${sourceViewId}');
    if (srcW.isNull) throw new Error('Source not found: ${sourceViewId}. Windows: ' + ImageWindow.windows.map(function(w){return w.mainView.id;}).join(','));
    var img = srcW.mainView.image;
    JSON.stringify({ w: Math.round(img.width), h: Math.round(img.height), color: img.isColor, id: srcW.mainView.id });
  `);
  if (dimR.status === 'error') {
    log(`  [mask] WARN: ${maskId}: ${dimR.error.message}`);
    return null;
  }
  const rawOutput = dimR.outputs?.consoleOutput?.trim() || '{}';
  const dims = JSON.parse(rawOutput);
  if (!dims.w || !dims.h) {
    log(`  [mask] WARN: ${maskId}: invalid dimensions (raw=${rawOutput})`);
    return null;
  }

  // Step 2: Create mask with JS-interpolated literal dimensions (avoids PJSR type issues)
  const lumExpr = dims.color
    ? `0.2126*${sourceViewId}[0]+0.7152*${sourceViewId}[1]+0.0722*${sourceViewId}[2]`
    : sourceViewId;
  const r = await pjsr(`
    var old = ImageWindow.windowById('${maskId}');
    if (!old.isNull) old.forceClose();
    var mw = new ImageWindow(${dims.w}, ${dims.h}, 1, 32, true, false, '${maskId}');
    mw.show();
    var PM = new PixelMath;
    PM.expression = '${lumExpr}';
    PM.useSingleExpression = true;
    PM.createNewImage = false;
    PM.executeOn(mw.mainView);
    ${blur > 0 ? `var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = ${blur}; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(mw.mainView);` : ''}
    ${clipLow > 0 || gamma !== 1.0 ? `var PM2 = new PixelMath; PM2.expression = '${gamma !== 1.0 ? `iif($T<${clipLow},0,exp(${gamma.toFixed(4)}*ln(max(($T-${clipLow})/${(1 - clipLow).toFixed(4)},0.00001))))` : `iif($T<${clipLow},0,($T-${clipLow})/${(1 - clipLow).toFixed(4)})`}'; PM2.useSingleExpression = true; PM2.createNewImage = false; PM2.use64BitWorkingImage = true; PM2.truncate = true; PM2.truncateLower = 0; PM2.truncateUpper = 1; PM2.executeOn(mw.mainView);` : ''}
    'OK';
  `);
  if (r.status === 'error') {
    log(`  [mask] WARN: ${maskId}: ${r.error.message}`);
    return null;
  }
  log(`  [mask] Created luminance mask ${maskId} (blur=${blur}, clipLow=${clipLow}${gamma !== 1.0 ? ', gamma=' + gamma : ''}, ${dims.w}x${dims.h})`);
  return maskId;
}

async function applyMask(targetViewId, maskId, inverted = false) {
  await pjsr(`
    var tw = ImageWindow.windowById('${targetViewId}');
    var mw = ImageWindow.windowById('${maskId}');
    if (tw && mw) { tw.mask = mw; tw.maskVisible = false; tw.maskInverted = ${inverted}; }
  `);
  log(`  [mask] Applied ${maskId} to ${targetViewId}${inverted ? ' (inverted)' : ''}`);
}

async function removeMask(targetViewId) {
  await pjsr(`var tw = ImageWindow.windowById('${targetViewId}'); if (!tw.isNull) tw.removeMask();`);
}

async function closeMask(maskId) {
  await pjsr(`var mw = ImageWindow.windowById('${maskId}'); if (!mw.isNull) mw.forceClose();`);
}

// Purge undo history for a view to free memory (each undo = ~300MB for large images)
async function purgeUndoHistory(viewId) {
  await pjsr(`var w = ImageWindow.windowById('${viewId}'); if (!w.isNull) w.purge();`);
}

// Close a live image and remove from tracking
async function closeLiveImage(branch) {
  const viewId = liveImages[branch];
  if (!viewId) return;
  await pjsr(`var w = ImageWindow.windowById('${viewId}'); if (!w.isNull) w.forceClose();`);
  delete liveImages[branch];
}

// ============================================================================
// GRADIENT REMOVAL HELPERS
// ============================================================================

// Clone an open image to a new hidden window (in-memory, no disk I/O)
async function cloneImage(sourceId, cloneId) {
  const dimR = await pjsr(`
    var srcW = ImageWindow.windowById('${sourceId}');
    if (srcW.isNull) throw new Error('Clone source not found: ${sourceId}');
    var img = srcW.mainView.image;
    JSON.stringify({ w: img.width, h: img.height, ch: img.numberOfChannels, color: img.isColor });
  `);
  if (dimR.status === 'error') throw new Error('cloneImage: ' + dimR.error.message);
  const d = JSON.parse(dimR.outputs?.consoleOutput?.trim() || '{}');

  const r = await pjsr(`
    var old = ImageWindow.windowById('${cloneId}');
    if (!old.isNull) old.forceClose();
    var srcW = ImageWindow.windowById('${sourceId}');
    var clone = new ImageWindow(${d.w || 0}, ${d.h || 0}, ${d.ch || 3}, 32, true, ${d.color !== false}, '${cloneId}');
    clone.mainView.beginProcess();
    clone.mainView.image.assign(srcW.mainView.image);
    clone.mainView.endProcess();
    clone.hide();
    'OK';
  `);
  if (r.status === 'error') throw new Error('cloneImage: ' + r.error.message);
}

// Restore target from a clone (in-memory copy)
async function restoreFromClone(targetId, cloneId) {
  const r = await pjsr(`
    var srcW = ImageWindow.windowById('${targetId}');
    var clone = ImageWindow.windowById('${cloneId}');
    if (srcW.isNull) throw new Error('Restore target not found: ${targetId}');
    if (clone.isNull) throw new Error('Clone not found: ${cloneId}');
    srcW.mainView.beginProcess();
    srcW.mainView.image.assign(clone.mainView.image);
    srcW.mainView.endProcess();
    'OK';
  `);
  if (r.status === 'error') throw new Error('restoreFromClone: ' + r.error.message);
}

// Close an image window
async function closeImage(viewId) {
  await pjsr(`var w = ImageWindow.windowById('${viewId}'); if (!w.isNull) w.forceClose();`);
}

// Measure background uniformity: stddev of 4 corner medians (lower = more uniform)
// Returns { score, corners: [med1, med2, med3, med4], perChannel: [{r,g,b}, ...] }
async function measureUniformity(viewId, sampleSize = 200) {
  const r = await pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measureUniformity: not found: ${viewId}');
    var img = w.mainView.image;
    var sz = ${sampleSize};
    var corners = [
      [0, 0],
      [img.width - sz, 0],
      [0, img.height - sz],
      [img.width - sz, img.height - sz]
    ];
    var meds = [];
    var perCh = [];
    for (var i = 0; i < corners.length; i++) {
      var r = new Rect(corners[i][0], corners[i][1], corners[i][0] + sz, corners[i][1] + sz);
      img.selectedRect = r;
      if (img.isColor) {
        var chMeds = [];
        for (var c = 0; c < img.numberOfChannels; c++) {
          img.selectedChannel = c;
          chMeds.push(img.median());
        }
        img.resetChannelSelection();
        perCh.push(chMeds);
        meds.push((chMeds[0] + chMeds[1] + chMeds[2]) / 3);
      } else {
        var m = img.median();
        meds.push(m);
        perCh.push([m]);
      }
    }
    img.resetSelections();
    var mean = 0;
    for (var i = 0; i < meds.length; i++) mean += meds[i];
    mean /= meds.length;
    var variance = 0;
    for (var i = 0; i < meds.length; i++) variance += (meds[i] - mean) * (meds[i] - mean);
    var stddev = Math.sqrt(variance / meds.length);
    JSON.stringify({ score: stddev, corners: meds, perChannel: perCh, mean: mean });
  `);
  if (r.status === 'error') {
    log(`  [uniformity] WARN: ${r.error.message}`);
    return { score: 999, corners: [], perChannel: [], mean: 0 };
  }
  return JSON.parse(r.outputs?.consoleOutput?.trim() || '{"score":999}');
}

// Run GradientCorrection on a view (with cleanup of model images)
async function runGC(viewId) {
  const beforeIds = (await listImages()).map(i => i.id);
  const r = await pjsr(`
    var P = new GradientCorrection;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `);
  if (r.status === 'error') log('  [GC] WARN: ' + r.error.message);
  // Close any model images GC may produce
  const newImgs = await detectNewImages(beforeIds);
  if (newImgs.length > 0) {
    const closeIds = newImgs.map(i => "'" + i.id + "'").join(',');
    await pjsr(`var ids=[${closeIds}];for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(w&&!w.isNull)w.forceClose();processEvents();}`);
  }
}

// Run ABE on a view
async function runABE(viewId, opts = {}) {
  const polyDegree = opts.polyDegree ?? 4;
  const tolerance = opts.tolerance ?? 1.0;
  const deviation = opts.deviation ?? 0.8;
  const boxSeparation = opts.boxSeparation ?? 5;
  const beforeIds = (await listImages()).map(i => i.id);
  const r = await pjsr(`
    var P = new AutomaticBackgroundExtractor;
    P.tolerance = ${tolerance};
    P.deviation = ${deviation};
    P.unbalance = 1.800;
    P.minBoxFraction = 0.050;
    P.maxBackground = 1.0000;
    P.minBackground = 0.0000;
    P.useBezierSurface = false;
    P.polyDegree = ${polyDegree};
    P.boxSize = 5;
    P.boxSeparation = ${boxSeparation};
    P.modelImageSampleFormat = AutomaticBackgroundExtractor.prototype.f32;
    P.abeDownsample = 2.00;
    P.writeSampleBoxes = false;
    P.justTrySamples = false;
    P.targetCorrection = AutomaticBackgroundExtractor.prototype.Subtract;
    P.normalize = true;
    P.discardModel = true;
    P.replaceTarget = true;
    P.correctedImageId = '';
    P.correctedImageSampleFormat = AutomaticBackgroundExtractor.prototype.SameAsTarget;
    P.verbosity = 0;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `);
  if (r.status === 'error') log('  [ABE] WARN: ' + r.error.message);
  // Close any residual model images
  const newImgs = await detectNewImages(beforeIds);
  if (newImgs.length > 0) {
    const closeIds = newImgs.map(i => "'" + i.id + "'").join(',');
    await pjsr(`var ids=[${closeIds}];for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(w&&!w.isNull)w.forceClose();processEvents();}`);
  }
}

// ============================================================================
// PREVIEW EXPORT
// ============================================================================
const PREVIEW_DIR = path.join(home, '.pixinsight-mcp', 'previews');

// Steps that run on linear data (before stretch) — previews need auto-stretch
const LINEAR_STEPS = new Set([
  'align', 'combine_rgb', 'gc', 'abe', 'abe_deg2', 'bxt_correct', 'plate_solve', 'spcc', 'scnr',
  'bxt_sharpen', 'nxt_pass1', 'sxt', 'ha_gc', 'ha_bxt_correct', 'ha_nxt_linear', 'ha_bxt_sharpen',
  'ha_sxt', 'l_sxt', 'l_bxt_correct', 'l_nxt_linear', 'l_bxt_sharpen'
]);

async function savePreview(viewId, stepId) {
  const previewPath = path.join(PREVIEW_DIR, stepId + '.jpg');
  const isLinear = LINEAR_STEPS.has(stepId);
  log(`    [preview] Exporting ${stepId} (${isLinear ? 'linear→auto-stretch' : 'non-linear'})...`);

  try {
    // Clone to temp image, auto-stretch if linear, resize, save JPEG, close
    const r = await pjsr(`
      var srcW = ImageWindow.windowById('${viewId}');
      if (srcW.isNull) throw new Error('View not found: ${viewId}');
      var src = srcW.mainView;
      var img = src.image;
      var w = img.width, h = img.height;

      // Clone
      var tmp = new ImageWindow(w, h, img.numberOfChannels, 32, false, img.isColor, 'preview_tmp');
      tmp.mainView.beginProcess();
      tmp.mainView.image.assign(img);
      tmp.mainView.endProcess();

      // Auto-stretch for linear data
      ${isLinear ? `
      var meds = [], mads = [];
      var timg = tmp.mainView.image;
      if (timg.isColor) {
        for (var c = 0; c < timg.numberOfChannels; c++) {
          timg.selectedChannel = c;
          meds.push(timg.median());
          mads.push(timg.MAD());
        }
        timg.resetSelections();
      } else {
        meds = [timg.median()]; mads = [timg.MAD()];
      }
      var med = 0, mad = 0;
      for (var c = 0; c < meds.length; c++) { med += meds[c]; mad += mads[c]; }
      med /= meds.length; mad /= mads.length;
      var c0 = Math.max(0, med - 2.8 * mad);
      var x = (1 > c0) ? (med - c0) / (1 - c0) : 0.5;
      var tgt = 0.25;
      var m = (x <= 0 || x >= 1) ? 0.5 : x * (1 - tgt) / (x * (1 - 2*tgt) + tgt);
      var HT = new HistogramTransformation;
      HT.H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[c0,m,1,0,1],[0,0.5,1,0,1]];
      HT.executeOn(tmp.mainView);
      ` : ''}

      // Full resolution export (no resize)

      // Ensure preview dir exists
      var dir = '${PREVIEW_DIR}';
      if (!File.directoryExists(dir)) File.createDirectory(dir, true);

      // Save as JPEG
      var p = '${previewPath}';
      if (File.exists(p)) File.remove(p);
      tmp.saveAs(p, false, false, false, false);
      tmp.forceClose();
      'OK';
    `);
    if (r.status === 'error') log('    [preview] WARN: ' + r.error.message);
    else log('    [preview] Saved: ' + stepId + '.jpg');
  } catch (e) {
    log('    [preview] ERROR: ' + e.message);
  }
  await checkMemory(stepId);
}

// ============================================================================
// BRIDGE COMMUNICATION
// ============================================================================
function send(tool, proc, params, opts) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cmd = {
      id, timestamp: new Date().toISOString(), tool, process: proc,
      parameters: params,
      executeMethod: opts?.exec || 'executeGlobal',
      targetView: opts?.view || null
    };
    fs.writeFileSync(path.join(cmdDir, id + '.json'), JSON.stringify(cmd, null, 2));
    let att = 0;
    const poll = setInterval(() => {
      const rp = path.join(resDir, id + '.json');
      if (fs.existsSync(rp)) {
        try {
          const r = JSON.parse(fs.readFileSync(rp, 'utf-8'));
          if (r.status === 'running') return;
          clearInterval(poll);
          fs.unlinkSync(rp);
          resolve(r);
        } catch (e) { /* retry */ }
      }
      att++;
      if (att > 2400) { clearInterval(poll); reject(new Error('Timeout: ' + tool)); }
    }, 500);
  });
}

async function pjsr(code) {
  const r = await send('run_script', '__script__', { code });
  // Normalize: watcher returns {status:"success", outputs:{consoleOutput:"..."}}
  // Add r.result (="ok"/error) for callers using that convention,
  // but preserve r.outputs for callers accessing outputs.consoleOutput directly
  r.result = r.outputs?.consoleOutput;
  if (r.status !== 'error') r.status = 'ok';
  return r;
}
function log(msg) { console.log(msg); }

const MEM_WARN_MB = 4000;
const MEM_ABORT_MB = 8000;

async function checkMemory(stepId) {
  try {
    const { execSync } = await import('child_process');
    const out = execSync("ps aux | grep '[P]ixInsight.app' | awk '{s+=$6} END{print s}'").toString().trim();
    const memKB = parseInt(out, 10);
    if (!memKB) return;
    const memMB = Math.round(memKB / 1024);
    if (memMB > MEM_ABORT_MB) {
      log(`  [MEMORY] CRITICAL: PixInsight using ${memMB}MB — saving checkpoint and aborting`);
      await saveCheckpoint(stepId);
      log(`  [MEMORY] Restart PixInsight and re-run with: --restart-from ${stepId}`);
      process.exit(2);
    } else if (memMB > MEM_WARN_MB) {
      log(`  [MEMORY] WARNING: PixInsight using ${memMB}MB — purging undo history`);
      // Purge undo history on all live images + force GC
      for (const [branch, viewId] of Object.entries(liveImages)) {
        await purgeUndoHistory(viewId);
      }
      await pjsr('gc(); processEvents();');
      // Re-check
      const out2 = execSync("ps aux | grep '[P]ixInsight.app' | awk '{s+=$6} END{print s}'").toString().trim();
      const memMB2 = Math.round(parseInt(out2, 10) / 1024);
      log(`  [MEMORY] After purge: ${memMB2}MB`);
    } else {
      log(`  [memory] ${memMB}MB`);
    }
  } catch { /* ignore on non-macOS */ }
}

async function listImages() {
  const list = await send('list_open_images', '__internal__', {});
  return list.outputs?.images || [];
}

async function detectNewImages(beforeIds) {
  const imgs = await listImages();
  return imgs.filter(i => !beforeIds.includes(i.id));
}

async function getStats(viewId) {
  const r = await pjsr(`
    var v = ImageWindow.windowById('${viewId}').mainView;
    var img = v.image;
    var result = {};
    if (img.isColor) {
      var meds = [], mads = [];
      for (var c = 0; c < img.numberOfChannels; c++) {
        img.selectedChannel = c;
        meds.push(img.median());
        mads.push(img.MAD());
      }
      img.resetSelections();
      result.median = (meds[0] + meds[1] + meds[2]) / 3;
      result.mad = (mads[0] + mads[1] + mads[2]) / 3;
    } else {
      result.median = img.median();
      result.mad = img.MAD();
    }
    result.min = img.minimum();
    result.max = img.maximum();
    JSON.stringify(result);
  `);
  try { return JSON.parse(r.outputs?.consoleOutput || '{}'); }
  catch { return { median: 0.01, mad: 0.001 }; }
}

async function autoStretch(viewId, targetBg = 0.25) {
  const stats = await getStats(viewId);
  log(`    Stats: median=${stats.median.toFixed(6)}, MAD=${stats.mad.toFixed(6)}`);
  const c0 = Math.max(0, stats.median - 2.8 * stats.mad);
  const x = (1 > c0) ? (stats.median - c0) / (1 - c0) : 0.5;
  let m;
  if (x <= 0 || x >= 1) m = 0.5;
  else m = x * (1 - targetBg) / (x * (1 - 2 * targetBg) + targetBg);
  log(`    Auto-stretch: shadows=${c0.toFixed(6)}, midtone=${m.toFixed(6)}`);
  const r = await pjsr(`
    var P = new HistogramTransformation;
    P.H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[${c0},${m},1,0,1],[0,0.5,1,0,1]];
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `);
  if (r.status === 'error') log('    WARN: ' + r.error.message);
  else log('    Stretched OK.');
  return { stats, shadows: c0, midtone: m };
}

// ============================================================================
// Seti Statistical Stretch (faithful port of statisticalstretch.js v2.3)
// By Franklin Marek (SetiAstro) — CC BY-NC 4.0
// Handles both mono (L_work) and color (RGB) images with proper expressions.
// ============================================================================
async function setiStretch(viewId, opts = {}) {
  const targetMedian   = opts.targetMedian ?? 0.25;
  const blackpointSigma = opts.blackpointSigma ?? 5.0;
  const noBlackClip    = opts.noBlackClip ?? false;
  const normalize      = opts.normalize ?? false;
  const hdrCompress    = opts.hdrCompress ?? false;
  const hdrAmount      = opts.hdrAmount ?? 0.25;
  const hdrKnee        = opts.hdrKnee ?? 0.35;
  const hdrHeadroom    = opts.hdrHeadroom ?? 0;
  const maxIterations  = opts.iterations ?? 1;
  const convergenceThreshold = 0.001;

  // Detect if image is color
  const isColorR = await pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    w.mainView.image.isColor ? 'color' : 'mono';
  `);
  const isColor = (isColorR.outputs?.consoleOutput || '').includes('color');

  const st0 = await getStats(viewId);
  log(`    Seti stretch [${isColor ? 'color' : 'mono'}]: target=${targetMedian}, bpSigma=${blackpointSigma}, HDR=${hdrCompress}(amount=${hdrAmount},knee=${hdrKnee},headroom=${hdrHeadroom}), maxIter=${maxIterations}`);
  log(`    Initial: median=${st0.median.toFixed(6)} (${Math.round(st0.median*65535)} ADU), MAD=${st0.mad.toFixed(6)}, max=${(st0.max ?? 0).toFixed(4)}`);

  const T = targetMedian;
  const noClipFlag = noBlackClip ? '1' : '0';

  for (let iter = 0; iter < maxIterations; iter++) {
    let r;

    // Step 1: Blackpoint / rescale
    let bpExpr, bpSymbols;
    if (isColor) {
      // Color linked: luma-weighted blackpoint (Rec.709), applied uniformly to all channels
      bpExpr = [
        'cr=0.2126; cg=0.7152; cb=0.0722;',
        'Med = cr*med($T[0]) + cg*med($T[1]) + cb*med($T[2]);',
        `Sig = 1.4826*(cr*MAD($T[0]) + cg*MAD($T[1]) + cb*MAD($T[2]));`,
        'MinC = min(min($T[0]),min($T[1]),min($T[2]));',
        `BPraw = Med - ${blackpointSigma}*Sig;`,
        `BP = iif(${noClipFlag}, MinC, iif(BPraw < MinC, MinC, BPraw));`,
        'Rescaled = ($T - BP) / (1 - BP);',
        'Rescaled;'
      ].join('\\n');
      bpSymbols = 'cr,cg,cb,Med,Sig,MinC,BPraw,BP,Rescaled';
    } else {
      // Mono: straightforward per-channel
      bpExpr = [
        'Med = med($T);',
        'Sig = 1.4826*MAD($T);',
        `BPraw = Med - ${blackpointSigma}*Sig;`,
        `BP = iif(${noClipFlag}, min($T), iif(BPraw < min($T), min($T), BPraw));`,
        'Rescaled = ($T - BP) / (1 - BP);',
        'Rescaled;'
      ].join('\\n');
      bpSymbols = 'Med, Sig, BPraw, BP, Rescaled';
    }

    r = await pjsr(`
      var P = new PixelMath;
      P.expression = "${bpExpr}";
      P.useSingleExpression = true;
      P.symbols = "${bpSymbols}";
      P.use64BitWorkingImage = true;
      P.truncate = false;
      P.createNewImage = false;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    if (r.status === 'error') { log(`      WARN step1: ${r.error.message}`); break; }

    // Step 2: Midtones transfer (closed-form MTF mapping median → targetMedian)
    let mtfExpr, mtfSymbols;
    if (isColor) {
      // Color linked: use average of 3 channel medians as single median
      mtfExpr = `MedianColor = avg(Med($T[0]),Med($T[1]),Med($T[2]));\\n((MedianColor-1)*${T}*$T)/(MedianColor*(${T}+$T-1)-${T}*$T)`;
      mtfSymbols = 'L, MedianColor, S';
    } else {
      // Mono: use Med($T) directly
      mtfExpr = `((Med($T)-1)*${T}*$T)/(Med($T)*(${T}+$T-1)-${T}*$T)`;
      mtfSymbols = 'L, S';
    }

    r = await pjsr(`
      var P = new PixelMath;
      P.expression = "${mtfExpr}";
      P.useSingleExpression = true;
      P.symbols = "${mtfSymbols}";
      P.use64BitWorkingImage = true;
      P.truncate = false;
      P.createNewImage = false;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    if (r.status === 'error') { log(`      WARN step2: ${r.error.message}`); break; }

    // Step 3: Normalize or truncate
    if (normalize) {
      const normExpr = isColor
        ? 'Mcolor=max(max($T[0]),max($T[1]),max($T[2]));\\n$T/Mcolor;'
        : '$T/max($T)';
      r = await pjsr(`
        var P = new PixelMath;
        P.expression = "${normExpr}";
        P.useSingleExpression = true;
        P.symbols = "Mcolor";
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
      if (r.status === 'error') log(`      WARN step3: ${r.error.message}`);
    } else {
      r = await pjsr(`
        var P = new PixelMath;
        P.expression = "$T";
        P.useSingleExpression = true;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
    }

    // Step 4: Optional HDR compress (Hermite soft-knee)
    if (hdrCompress && hdrAmount > 0) {
      let hdrExpr, hdrSymbols;
      if (isColor) {
        // Color: compute luma Y, compress Y, scale RGB uniformly by Yc/Y
        hdrExpr = [
          `a = ${hdrAmount};`,
          `k = ${hdrKnee};`,
          'k = min(0.999999, max(0.1, k));',
          'R = $T[0]; G = $T[1]; B = $T[2];',
          'cr = 0.2126; cg = 0.7152; cb = 0.0722;',
          'Y = cr*R + cg*G + cb*B;',
          'hi = Y > k;',
          't = (Y - k)/(1 - k);',
          't = min(1, max(0, t));',
          't2 = t*t;',
          't3 = t2*t;',
          'h10 = (t3 - 2*t2 + t);',
          'h01 = (-2*t3 + 3*t2);',
          'h11 = (t3 - t2);',
          'm1 = min(5, max(1, 1 + 4*a));',
          `ep = ${(1 - hdrHeadroom).toFixed(4)};`,
          'f = h10*1 + h01*ep + h11*m1;',
          'Yc = k + (1 - k)*min(1, max(0, f));',
          's = iif(hi, iif(Y <= 1.0e-10, 1, Yc/Y), 1);',
          '$T * s;'
        ].join('\\n');
        hdrSymbols = 'a,k,x,hi,t,t2,t3,h10,h01,h11,m1,ep,f,y,R,G,B,cr,cg,cb,Y,Yc,s';
      } else {
        // Mono: compress pixel values directly
        hdrExpr = [
          `a = ${hdrAmount};`,
          `k = ${hdrKnee};`,
          'k = min(0.999999, max(0.1, k));',
          'x = $T;',
          'hi = x > k;',
          't = (x - k)/(1 - k);',
          't = min(1, max(0, t));',
          't2 = t*t;',
          't3 = t2*t;',
          'h10 = (t3 - 2*t2 + t);',
          'h01 = (-2*t3 + 3*t2);',
          'h11 = (t3 - t2);',
          'm1 = min(5, max(1, 1 + 4*a));',
          `ep = ${(1 - hdrHeadroom).toFixed(4)};`,
          'f = h10*1 + h01*ep + h11*m1;',
          'y = k + (1 - k)*min(1, max(0, f));',
          'iif(hi, y, x);'
        ].join('\\n');
        hdrSymbols = 'a,k,x,hi,t,t2,t3,h10,h01,h11,m1,ep,f,y';
      }

      r = await pjsr(`
        var P = new PixelMath;
        P.expression = "${hdrExpr}";
        P.useSingleExpression = true;
        P.symbols = "${hdrSymbols}";
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
      if (r.status === 'error') log(`      WARN step4 HDR: ${r.error.message}`);
    }

    // Check convergence
    const stIter = await getStats(viewId);
    const diff = Math.abs(stIter.median - targetMedian);
    log(`    Iter ${iter+1}: median=${stIter.median.toFixed(6)} (${Math.round(stIter.median*65535)} ADU), max=${(stIter.max ?? 0).toFixed(4)}, diff=${diff.toFixed(6)}`);

    if (diff < convergenceThreshold) {
      log(`    Converged after ${iter+1} iteration(s).`);
      break;
    }
  }

  const stFinal = await getStats(viewId);
  log(`    Final: median=${stFinal.median.toFixed(6)} (${Math.round(stFinal.median*65535)} ADU), max=${(stFinal.max ?? 0).toFixed(4)}`);
  return stFinal;
}

// ============================================================================
// GHS via PixelMath
// ============================================================================
function computeGHSCoefficients(orgD, B, SP, LP, HP) {
  const D = Math.exp(orgD) - 1.0;
  if (D === 0) return null;
  let a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,q0,qwp,qlp,q1,q;
  if (B === -1) {
    qlp = -Math.log(1+D*(SP-LP)); q0 = qlp - D*LP/(1+D*(SP-LP));
    qwp = Math.log(1+D*(HP-SP)); q1 = qwp + D*(1-HP)/(1+D*(HP-SP));
    q = 1/(q1-q0);
    a1=0; b1=D/(1+D*(SP-LP))*q;
    a2=-q0*q; b2=-q; c2=1+D*SP; d2=-D; e2=0;
    a3=-q0*q; b3=q; c3=1-D*SP; d3=D; e3=0;
    a4=(qwp-q0-D*HP/(1+D*(HP-SP)))*q; b4=q*D/(1+D*(HP-SP));
    return {type:'log',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  if (B === 0) {
    qlp = Math.exp(-D*(SP-LP)); q0 = qlp - D*LP*Math.exp(-D*(SP-LP));
    qwp = 2 - Math.exp(-D*(HP-SP)); q1 = qwp + D*(1-HP)*Math.exp(-D*(HP-SP));
    q = 1/(q1-q0);
    a1=0; b1=D*Math.exp(-D*(SP-LP))*q;
    a2=-q0*q; b2=q; c2=-D*SP; d2=D; e2=0;
    a3=(2-q0)*q; b3=-q; c3=D*SP; d3=-D; e3=0;
    a4=(qwp-q0-D*HP*Math.exp(-D*(HP-SP)))*q; b4=D*Math.exp(-D*(HP-SP))*q;
    return {type:'exp',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  if (B < 0) {
    const aB = -B;
    qlp = (1-Math.pow(1+D*aB*(SP-LP),(aB-1)/aB))/(aB-1);
    q0 = qlp - D*LP*Math.pow(1+D*aB*(SP-LP),-1/aB);
    qwp = (Math.pow(1+D*aB*(HP-SP),(aB-1)/aB)-1)/(aB-1);
    q1 = qwp + D*(1-HP)*Math.pow(1+D*aB*(HP-SP),-1/aB);
    q = 1/(q1-q0);
    a1=0; b1=D*Math.pow(1+D*aB*(SP-LP),-1/aB)*q;
    a2=(1/(aB-1)-q0)*q; b2=-q/(aB-1); c2=1+D*aB*SP; d2=-D*aB; e2=(aB-1)/aB;
    a3=(-1/(aB-1)-q0)*q; b3=q/(aB-1); c3=1-D*aB*SP; d3=D*aB; e3=(aB-1)/aB;
    a4=(qwp-q0-D*HP*Math.pow(1+D*aB*(HP-SP),-1/aB))*q; b4=D*Math.pow(1+D*aB*(HP-SP),-1/aB)*q;
    return {type:'pow',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  qlp = Math.pow(1+D*B*(SP-LP),-1/B); q0 = qlp - D*LP*Math.pow(1+D*B*(SP-LP),-(1+B)/B);
  qwp = 2 - Math.pow(1+D*B*(HP-SP),-1/B); q1 = qwp + D*(1-HP)*Math.pow(1+D*B*(HP-SP),-(1+B)/B);
  q = 1/(q1-q0);
  a1=0; b1=D*Math.pow(1+D*B*(SP-LP),-(1+B)/B)*q;
  a2=-q0*q; b2=q; c2=1+D*B*SP; d2=-D*B; e2=-1/B;
  a3=(2-q0)*q; b3=-q; c3=1-D*B*SP; d3=D*B; e3=-1/B;
  a4=(qwp-q0-D*HP*Math.pow(1+D*B*(HP-SP),-(B+1)/B))*q; b4=D*Math.pow(1+D*B*(HP-SP),-(B+1)/B)*q;
  return {type:'pow',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
}

function n(v) {
  const s = v.toFixed(12).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
  return v < 0 ? `(${s})` : s;
}

function buildGHSExpr(c) {
  let e1,e2,e3,e4;
  if (c.type === 'log') {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*ln(${n(c.c2)}+${n(c.d2)}*$T)`;
    e3=`${n(c.a3)}+${n(c.b3)}*ln(${n(c.c3)}+${n(c.d3)}*$T)`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  } else if (c.type === 'exp') {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*exp(${n(c.c2)}+${n(c.d2)}*$T)`;
    e3=`${n(c.a3)}+${n(c.b3)}*exp(${n(c.c3)}+${n(c.d3)}*$T)`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  } else {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*exp(${n(c.e2)}*ln(${n(c.c2)}+${n(c.d2)}*$T))`;
    e3=`${n(c.a3)}+${n(c.b3)}*exp(${n(c.e3)}*ln(${n(c.c3)}+${n(c.d3)}*$T))`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  }
  let result = e3;
  if (c.HP < 1.0) result = `iif($T<${n(c.HP)},${e3},${e4})`;
  if (c.LP < c.SP) result = `iif($T<${n(c.SP)},${e2},${result})`;
  if (c.LP > 0.0) result = `iif($T<${n(c.LP)},${e1},${result})`;
  return result;
}

function ghsCode(viewId, orgD, B, SP, LP, HP) {
  // Validate: HP must be > SP, LP must be < SP
  if (HP <= SP) {
    log(`    WARN: GHS skipped — HP (${HP}) must be > SP (${SP})`);
    return '/* HP<=SP, skipped */';
  }
  if (LP >= SP) {
    log(`    WARN: GHS skipped — LP (${LP}) must be < SP (${SP})`);
    return '/* LP>=SP, skipped */';
  }
  const c = computeGHSCoefficients(orgD, B, SP, LP, HP);
  if (!c) return '/* D=0 */';
  const expr = buildGHSExpr(c);
  // Safety check: if NaN leaked into the expression, skip
  if (expr.includes('NaN') || expr.includes('Infinity')) {
    log(`    WARN: GHS produced NaN/Infinity coefficients — skipped`);
    return '/* NaN coefficients, skipped */';
  }
  return `
    var P = new PixelMath; P.expression = '${expr}'; P.useSingleExpression = true;
    P.createNewImage = false; P.use64BitWorkingImage = true;
    P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `;
}

// ============================================================================
// SPCC FILTER CURVES (from PixInsight filters.xspd)
// Format: [wavelength_nm, transmission/QE]
// ============================================================================
const ASTRONOMIK_R = [[586,.003],[588,.006],[590,.01],[592,.014],[594,.031],[596,.064],[598,.315],[600,.579],[602,.774],[604,.893],[606,.946],[608,.95],[610,.927],[612,.903],[614,.917],[616,.936],[618,.955],[620,.97],[622,.964],[624,.958],[626,.952],[628,.958],[630,.961],[632,.957],[634,.953],[636,.957],[638,.964],[640,.972],[642,.972],[644,.966],[646,.959],[648,.952],[650,.948],[652,.953],[654,.958],[656,.964],[658,.969],[660,.956],[662,.943],[664,.929],[666,.916],[668,.903],[670,.903],[672,.91],[674,.917],[676,.924],[678,.88],[680,.831],[682,.783],[684,.602],[686,.371],[688,.151],[690,.081],[692,.04],[694,.03],[696,.02],[698,.015],[700,.011],[702,.008],[704,.004]];

const ASTRONOMIK_G = [[484,0],[486,.003],[488,.006],[490,.01],[492,.016],[494,.092],[496,.168],[498,.494],[500,.845],[502,.934],[504,.945],[506,.938],[508,.93],[510,.926],[512,.923],[514,.921],[516,.915],[518,.908],[520,.905],[522,.917],[524,.929],[526,.941],[528,.953],[530,.965],[532,.956],[534,.944],[536,.932],[538,.92],[540,.925],[542,.939],[544,.954],[546,.968],[548,.978],[550,.979],[552,.979],[554,.979],[556,.98],[558,.974],[560,.964],[562,.931],[564,.869],[566,.806],[568,.337],[570,.114],[572,.051],[574,.013],[576,.01],[578,.006],[580,.002],[582,0]];

const ASTRONOMIK_B = [[416,.004],[418,.013],[420,.033],[422,.053],[424,.202],[426,.698],[428,.867],[430,.953],[432,.953],[434,.951],[436,.945],[438,.951],[440,.958],[442,.962],[444,.96],[446,.965],[448,.967],[450,.96],[452,.951],[454,.947],[456,.949],[458,.96],[460,.967],[462,.965],[464,.965],[466,.966],[468,.966],[470,.967],[472,.962],[474,.96],[476,.958],[478,.961],[480,.963],[482,.967],[484,.969],[486,.962],[488,.959],[490,.959],[492,.957],[494,.954],[496,.952],[498,.949],[500,.947],[502,.938],[504,.929],[506,.925],[508,.916],[510,.889],[512,.539],[514,.151],[516,.042],[518,.017],[520,.005],[522,0]];

const SONY_IMX411_QE = [[402,.7219],[404,.7367],[406,.75],[408,.7618],[410,.7751],[412,.787],[414,.7944],[416,.8018],[418,.8112],[420,.8214],[422,.8343],[424,.8462],[426,.8536],[428,.8595],[430,.8639],[432,.8713],[434,.8757],[436,.8802],[438,.8861],[440,.8905],[442,.895],[444,.8994],[446,.9038],[448,.9068],[450,.9112],[452,.9142],[454,.9172],[456,.9168],[458,.9151],[460,.9134],[462,.9117],[464,.91],[466,.9083],[468,.9066],[470,.9049],[472,.9032],[474,.9015],[476,.8997],[478,.898],[480,.8963],[482,.8946],[484,.8929],[486,.8912],[488,.8876],[490,.8846],[492,.8877],[494,.8904],[496,.893],[498,.8964],[500,.8964],[502,.895],[504,.8945],[506,.8922],[508,.8899],[510,.8876],[512,.8853],[514,.883],[516,.8807],[518,.8784],[520,.8761],[522,.8743],[524,.8728],[526,.8698],[528,.8669],[530,.8624],[532,.858],[534,.855],[536,.8506],[538,.8476],[540,.8432],[542,.8402],[544,.8358],[546,.8328],[548,.8284],[550,.8254],[552,.821],[554,.8166],[556,.8136],[558,.8092],[560,.8062],[562,.8023],[564,.7983],[566,.7944],[568,.7899],[570,.787],[572,.7825],[574,.7781],[576,.7751],[578,.7707],[580,.7663],[582,.7618],[584,.7559],[586,.75],[588,.7441],[590,.7396],[592,.7337],[594,.7278],[596,.7219],[598,.716],[600,.7101],[602,.7056],[604,.6997],[606,.695],[608,.6905],[610,.6852],[612,.6808],[614,.6763],[616,.6719],[618,.6675],[620,.663],[622,.6583],[624,.6553],[626,.6509],[628,.6464],[630,.642],[632,.6376],[634,.6317],[636,.6272],[638,.6213],[640,.6154],[642,.6109],[644,.6036],[646,.5962],[648,.5902],[650,.5843],[652,.5799],[654,.574],[656,.5695],[658,.5636],[660,.5592],[662,.5545],[664,.5504],[666,.5462],[668,.542],[670,.5378],[672,.5328],[674,.5286],[676,.5244],[678,.5203],[680,.5163],[682,.5133],[684,.5089],[686,.5044],[688,.4985],[690,.4926],[692,.4867],[694,.4793],[696,.4719],[698,.4645],[700,.4586],[702,.4541],[704,.4497],[706,.4453],[708,.4408],[710,.4364],[712,.432],[714,.4275],[716,.4216],[718,.4186],[720,.4142],[722,.4127],[724,.4103],[726,.4078],[728,.4053],[730,.4024],[732,.3979],[734,.3935],[736,.3891],[738,.3831],[740,.3802],[742,.3772],[744,.3743],[746,.3713],[748,.3669],[750,.3624],[752,.3595],[754,.3559],[756,.3526],[758,.3494],[760,.3462],[762,.3429],[764,.3397],[766,.3364],[768,.3332],[770,.33],[772,.3267],[774,.3235],[776,.3203],[778,.317],[780,.3138],[782,.3106],[784,.3073],[786,.3041],[788,.3009],[790,.2976],[792,.2937],[794,.2905],[796,.2873],[798,.284],[800,.2808],[802,.2776],[804,.2743],[806,.2731],[808,.2703],[810,.2674],[812,.2646],[814,.2618],[816,.2589],[818,.2561],[820,.2533],[822,.2504],[824,.2476],[826,.2456],[828,.2439],[830,.2433],[832,.2427],[834,.2421],[836,.2416],[838,.2411],[840,.2382],[842,.2322],[844,.2278],[846,.2219],[848,.2175],[850,.2114],[852,.2069],[854,.2023],[856,.1978],[858,.1932],[860,.1918],[862,.1911],[864,.1904],[866,.1897],[868,.189],[870,.1883],[872,.1879],[874,.1834],[876,.179],[878,.1731],[880,.1672],[882,.1612],[884,.1568],[886,.1524],[888,.1479],[890,.1464],[892,.1464],[894,.1464],[896,.1464],[898,.1481],[900,.1494],[902,.1494],[904,.1494],[906,.1464],[908,.1435],[910,.1391],[912,.1346],[914,.1302],[916,.1257],[918,.1228],[920,.1183],[922,.1139],[924,.1109],[926,.1093],[928,.1085],[930,.108],[932,.108],[934,.108],[936,.108],[938,.108],[940,.1058],[942,.1039],[944,.1021],[946,.0998],[948,.0958],[950,.0918],[952,.0888],[954,.0828],[956,.0769],[958,.074],[960,.0714],[962,.0695],[964,.0677],[966,.0658],[968,.0651],[970,.0636],[972,.0626],[974,.0616],[976,.0606],[978,.0596],[980,.0586],[982,.0576],[984,.0567],[986,.0557],[988,.0547],[990,.0537],[992,.0527],[994,.0517],[996,.0507]];

// White reference spectrum: Average Spiral Galaxy (from SPCC GUI export)
const WHITE_REF_AVG_SPIRAL = "200.5,0.0715066,201.5,0.0689827,202.5,0.0720216,203.5,0.0685511,204.5,0.0712370,205.5,0.0680646,206.5,0.0683024,207.4,0.0729174,207.8,0.0702124,208.5,0.0727025,209.5,0.0688880,210.5,0.0690528,211.5,0.0697566,212.5,0.0705508,213.5,0.0654581,214.5,0.0676317,215.5,0.0699038,216.5,0.0674922,217.5,0.0668344,218.5,0.0661763,219.5,0.0690803,220.5,0.0670864,221.5,0.0635644,222.5,0.0619833,223.5,0.0668687,224.5,0.0640725,225.5,0.0614358,226.5,0.0628698,227.5,0.0649014,228.5,0.0673391,229.5,0.0638038,230.5,0.0643234,231.5,0.0614849,232.5,0.0493110,233.5,0.0574873,234.5,0.0555616,235.5,0.0609369,236.5,0.0557384,237.5,0.0578991,238.5,0.0536321,239.5,0.0575370,240.5,0.0555389,241.5,0.0571506,242.5,0.0615309,243.5,0.0595363,244.5,0.0634798,245.5,0.0628886,246.5,0.0622975,247.5,0.0600475,248.5,0.0608933,249.5,0.0580972,250.5,0.0653082,251.3,0.0576207,251.8,0.0588533,252.5,0.0566401,253.5,0.0582714,254.5,0.0575809,255.5,0.0633762,256.5,0.0610093,257.5,0.0652874,258.5,0.0642648,259.5,0.0632596,260.5,0.0609384,261.5,0.0600490,262.5,0.0636409,263.5,0.0682040,264.5,0.0754600,265.5,0.0806341,266.5,0.0699754,267.5,0.0739405,268.5,0.0755243,269.5,0.0697483,270.5,0.0736132,271.5,0.0678854,272.5,0.0663086,273.5,0.0709825,274.5,0.0602999,275.5,0.0630128,276.5,0.0669431,277.5,0.0701399,278.5,0.0641577,279.5,0.0511231,280.5,0.0550197,281.5,0.0692974,282.5,0.0753517,283.5,0.0723537,284.5,0.0679725,285.5,0.0634174,286.5,0.0742486,287.5,0.0783316,288.5,0.0771108,289.5,0.0801337,291,0.0914252,293,0.0862422,295,0.0838485,297,0.0858467,299,0.0865643,301,0.0875161,303,0.0893837,305,0.0905257,307,0.0935800,309,0.0934870,311,0.0982195,313,0.0953176,315,0.0961554,317,0.0995933,319,0.0924967,321,0.0978345,323,0.0907337,325,0.1054383,327,0.1143168,329,0.1135342,331,0.1106139,333,0.1119505,335,0.1099062,337,0.0967928,339,0.1022504,341,0.1039447,343,0.1063681,345,0.1091599,347,0.1109753,349,0.1181664,351,0.1232860,353,0.1163073,355,0.1267769,357,0.1035215,359,0.1042786,361,0.1176823,363,0.1219479,364,0.1250342,365,0.1363934,367,0.1407033,369,0.1288466,371,0.1379791,373,0.1127623,375,0.1318217,377,0.1528880,379,0.1670432,381,0.1727864,383,0.1243124,385,0.1639393,387,0.1724457,389,0.1520460,391,0.2043430,393,0.1427526,395,0.1870668,397,0.1244026,399,0.2329267,401,0.2556144,403,0.2542109,405,0.2491356,407,0.2379803,409,0.2541684,411,0.2279309,413,0.2533629,415,0.2557223,417,0.2584198,419,0.2560216,421,0.2587210,423,0.2498130,425,0.2609755,427,0.2495886,429,0.2412927,431,0.2182856,433,0.2579985,435,0.2483036,437,0.2928112,439,0.2713431,441,0.2828921,443,0.2975108,445,0.3012513,447,0.3161393,449,0.3221464,451,0.3585586,453,0.3219299,455,0.3334392,457,0.3568741,459,0.3412296,461,0.3498501,463,0.3424920,465,0.3478877,467,0.3611478,469,0.3560448,471,0.3456585,473,0.3587672,475,0.3690553,477,0.3657369,479,0.3671625,481,0.3666357,483,0.3761265,485,0.3466382,487,0.3121751,489,0.3651561,491,0.3688824,493,0.3627420,495,0.3786295,497,0.3733906,499,0.3510300,501,0.3338136,503,0.3540298,505,0.3527861,507,0.3680833,509,0.3507047,511,0.3597249,513,0.3486136,515,0.3372089,517,0.3152444,519,0.3257755,521,0.3499922,523,0.3744245,525,0.3907778,527,0.3490228,529,0.3972061,531,0.4203442,533,0.3740999,535,0.4084084,537,0.4070036,539,0.3993480,541,0.3942389,543,0.4010466,545,0.4128880,547,0.4055525,549,0.4094232,551,0.4053814,553,0.4201633,555,0.4269231,557,0.4193749,559,0.4105311,561,0.4257824,563,0.4239540,565,0.4310873,567,0.4218358,569,0.4360353,571,0.4229342,573,0.4583894,575,0.4425389,577,0.4481210,579,0.4320856,581,0.4507180,583,0.4645862,585,0.4513373,587,0.4516404,589,0.4033701,591,0.4466167,593,0.4513267,595,0.4524209,597,0.4613319,599,0.4546841,601,0.4499895,603,0.4631190,605,0.4724762,607,0.4724962,609,0.4569794,611,0.4599737,613,0.4363290,615,0.4488329,617,0.4267759,619,0.4545143,621,0.4514890,623,0.4384229,625,0.4256613,627,0.4470943,629,0.4565981,631,0.4458333,633,0.4533333,635,0.4546457,637,0.4535446,639,0.4638791,641,0.4561002,643,0.4617287,645,0.4594083,647,0.4597119,649,0.4517238,651,0.4686735,653,0.4686423,655,0.4544898,657,0.4255737,659,0.4640177,661,0.4711876,663,0.4679153,665,0.4689913,667,0.4592265,669,0.4668144,671,0.4498947,673,0.4629239,675,0.4559567,677,0.4596584,679,0.4549789,681,0.4586439,683,0.4653622,685,0.4543475,687,0.4632128,689,0.4711164,691,0.4709973,693,0.4685415,695,0.4696455,697,0.4769241,699,0.4760169,701,0.4701294,703,0.4815669,705,0.4850302,707,0.4707895,709,0.4570604,711,0.4465777,713,0.4382957,715,0.4379654,717,0.4446168,719,0.4350767,721,0.4466714,723,0.4579113,725,0.4625222,727,0.4669903,729,0.4615551,731,0.4763299,733,0.4793147,735,0.4857778,737,0.4997366,739,0.4915129,741,0.4926212,743,0.5062475,745,0.5072637,747,0.5170334,749,0.5173594,751,0.5244106,753,0.5344788,755,0.5397524,757,0.5387203,759,0.5280215,761,0.5191969,763,0.5085395,765,0.4984095,767,0.4749347,769,0.4878839,771,0.4798119,773,0.4821991,775,0.4799906,777,0.4870453,779,0.4928744,781,0.4934236,783,0.4904677,785,0.4849491,787,0.4947343,789,0.4890020,791,0.4789132,793,0.4822390,795,0.4795733,797,0.4973323,799,0.4988779,801,0.5054210,803,0.5087054,805,0.5103235,807,0.5187602,809,0.5151330,811,0.5223530,813,0.5396030,815,0.5475528,817,0.5543915,819,0.5380259,821,0.5321401,823,0.5366753,825,0.5372011,827,0.5440262,829,0.5390591,831,0.5212784,833,0.5187033,835,0.5197124,837,0.5241092,839,0.5070799,841,0.5253056,843,0.5003658,845,0.4896143,847,0.4910508,849,0.4964088,851,0.4753377,853,0.4986498,855,0.4604553,857,0.5174022,859,0.5105171,861,0.5175606,863,0.5322153,865,0.5335880,867,0.4811849,869,0.5241390,871,0.5458069,873,0.5508025,875,0.5423946,877,0.5580108,879,0.5677047,881,0.5580099,883,0.5649928,885,0.5629494,887,0.5384574,889,0.5523318,891,0.5614248,893,0.5521309,895,0.5550786,897,0.5583751,899,0.5597844,901,0.5394855,903,0.5638478,905,0.5862635,907,0.5877920,909,0.5774965,911,0.5866240,913,0.5989106,915,0.5958623,917,0.5964975,919,0.6041389,921,0.5797449,923,0.5607401,925,0.5640816,927,0.5704267,929,0.5642119,931,0.5694372,933,0.5716141,935,0.5705180,937,0.5618458,939,0.5736730,941,0.5630236,943,0.5796418,945,0.5720721,947,0.5873186,949,0.5896322,951,0.5794164,953,0.5828271,955,0.5692468,957,0.5808756,959,0.5949017,961,0.5875516,963,0.5923656,965,0.5824188,967,0.5838008,969,0.5948942,971,0.5865689,973,0.5818128,975,0.5807992,977,0.5851036,979,0.5775164,981,0.5938626,983,0.5885816,985,0.5943664,987,0.5911885,989,0.5916490,991,0.5868101,993,0.5919505,995,0.5945270,997,0.5960248,999,0.5950870,1003,0.5948938,1007,0.5888742,1013,0.6006343,1017,0.5958836,1022,0.6004154,1028,0.6050616,1032,0.5995678,1038,0.5984462,1043,0.6035475,1048,0.5973678,1052,0.5940806,1058,0.5854267,1063,0.5827191,1068,0.5788137,1072,0.5843356,1078,0.5830553,1082,0.5762549,1087,0.5766769,1092,0.5759526,1098,0.5726978,1102,0.5718654,1108,0.5658845,1113,0.5661672,1117,0.5637793,1122,0.5660178,1128,0.5608876,1133,0.5622964,1138,0.5603359,1143,0.5563605,1147,0.5652205,1153,0.5656560,1157,0.5607483,1162,0.5540304,1167,0.5556068,1173,0.5604768,1177,0.5492890,1183,0.5464411,1187,0.5385652,1192,0.5489344,1198,0.5331419,1203,0.5451093,1207,0.5419047,1212,0.5443417,1218,0.5477119,1223,0.5460783,1227,0.5435469,1232,0.5413216,1237,0.5419156,1243,0.5360791,1248,0.5363784,1253,0.5330056,1258,0.5330475,1262,0.5312735,1267,0.5282075,1272,0.5301258,1278,0.5318302,1283,0.5143390,1288,0.5259125,1292,0.5214670,1298,0.5287547,1302,0.5231621,1308,0.5267800,1313,0.5167545,1318,0.5170787,1323,0.5186867,1328,0.5111090,1332,0.5122823,1338,0.5085013,1343,0.5118057,1347,0.5086671,1352,0.5063367,1357,0.5007655,1363,0.5001648,1367,0.5036531,1373,0.5066053,1377,0.5064235,1382,0.5083958,1388,0.5053201,1393,0.4855558,1397,0.4835752,1402,0.4799809,1408,0.4854351,1412,0.4802711,1418,0.4867642,1423,0.4831264,1428,0.4768633,1433,0.4864127,1438,0.4916220,1442,0.4807589,1448,0.4908799,1452,0.4878666,1457,0.4919060,1462,0.4832121,1467,0.4817380,1472,0.4788120,1477,0.4832511,1483,0.4873623,1488,0.4833546,1492,0.4970729,1498,0.4941945,1503,0.4882672,1507,0.4906435,1512,0.5011545,1517,0.5042579,1522,0.5053326,1528,0.5103188,1533,0.5104235,1537,0.5109443,1543,0.5088747,1548,0.5114602,1552,0.5078479,1557,0.4955375,1562,0.5020681,1567,0.5009384,1572,0.5130484,1578,0.4843262,1583,0.4878957,1587,0.4869790,1593,0.5039261,1598,0.4961504,1605,0.5016433,1615,0.5109383,1625,0.5010374,1635,0.5166810,1645,0.4997573,1655,0.5132085,1665,0.5045445,1675,0.5038381,1685,0.4979366,1695,0.5024966,1705,0.4946397,1715,0.4900714,1725,0.4820987,1735,0.4704836,1745,0.4675962,1755,0.4610580,1765,0.4542064,1775,0.4442880,1785,0.4394009,1795,0.4305704,1805,0.4214249,1815,0.4154385,1825,0.4121445,1835,0.4087068,1845,0.4004347,1855,0.3981439,1865,0.3898276,1875,0.3819086,1885,0.3837946,1895,0.3719080,1905,0.3783857,1915,0.3734775,1925,0.3706359,1935,0.3625896,1945,0.3552610,1955,0.3559292,1965,0.3516581,1975,0.3442642,1985,0.3424439,1995,0.3401458,2005,0.3400624,2015,0.3370426,2025,0.3310865,2035,0.3294150,2045,0.3300824,2055,0.3263510,2065,0.3238343,2075,0.3226433,2085,0.3196882,2095,0.3156795,2105,0.3170735,2115,0.3129192,2125,0.3107151,2135,0.3111934,2145,0.3083829,2155,0.3053164,2165,0.3011248,2175,0.2987932,2185,0.2973707,2195,0.2953015,2205,0.2894185,2215,0.2910636,2225,0.2855524,2235,0.2835412,2245,0.2813240,2255,0.2794243,2265,0.2746838,2275,0.2752567,2285,0.2700351,2295,0.2315953,2305,0.2464873,2315,0.2460988,2325,0.2138361,2335,0.2290047,2345,0.2216595,2355,0.1997312,2365,0.2151513,2375,0.2079374,2385,0.1903472,2395,0.2020694,2405,0.1988067,2415,0.1834113,2425,0.1912983,2435,0.1873909,2445,0.1783537,2455,0.1759682,2465,0.1784857,2475,0.1715942,2485,0.1573562,2495,0.1568707,2505,0.1598265";

// Convert curve array [[w,v],[w,v],...] to flat CSV string "w1,v1,w2,v2,..."
// SPCC expects String (CSV) for ALL curve properties — Arrays cause "invalid argument type: String expected"
function curveToCSV(arr) {
  const parts = [];
  for (const p of arr) parts.push(p[0], p[1]);
  return parts.join(',');
}

// Format curve points to PJSR array literal: [[x,y],[x,y],...]
function curveToPJSR(points) {
  return '[' + points.map(p => '[' + p[0] + ',' + p[1] + ']').join(',') + ']';
}

// ============================================================================
// MAIN PIPELINE
// ============================================================================
async function run() {
  CFG = loadConfig();
  const F = CFG.files;
  const targetName = F.targetName || 'RosettaNebula';
  const hasL = !!(F.L && F.L.trim());
  const hasHa = !!(F.Ha && F.Ha.trim());
  const hasRGB = !!(F.R && F.R.trim() && F.G && F.G.trim() && F.B && F.B.trim());
  const lOnlyMode = !hasRGB && hasL;

  log('Pipeline: ' + (CFG.name || 'unnamed'));
  log('Target: ' + targetName);
  if (lOnlyMode) log('Mode: L-only (grayscale)');
  log('Steps: ' + CFG.steps.filter(s => s.enabled).map(s => s.name).join(' -> '));
  if (RESTART_FROM) log('Restarting from: ' + RESTART_FROM);

  let rgbW, rgbH;
  let idR, idG, idB, idHa, idL;

  if (RESTART_FROM) {
    // ==== RESTART: LOAD CHECKPOINT ====
    log('\n==== LOADING CHECKPOINT: ' + RESTART_FROM + ' ====');
    await loadCheckpoint(RESTART_FROM);

    // Query dimensions from main image
    const dimR = await pjsr(`
      var w = ImageWindow.windowById('${targetName}');
      if (!w) throw new Error('Main image not found after checkpoint load');
      JSON.stringify({ width: w.mainView.image.width, height: w.mainView.image.height });
    `);
    const dims = JSON.parse(dimR.outputs?.consoleOutput || '{}');
    rgbW = dims.width;
    rgbH = dims.height;
    log('  Image dimensions: ' + rgbW + 'x' + rgbH);
  } else {
    // ==== PHASE 0: SETUP ====
    log('\n==== PHASE 0: SETUP ====');

    // Clear previous preview images so the web UI shows only current run progress
    const prevFiles = fs.readdirSync(PREVIEW_DIR).filter(f => f.endsWith('.jpg'));
    if (prevFiles.length > 0) {
      for (const f of prevFiles) fs.unlinkSync(path.join(PREVIEW_DIR, f));
      log(`Cleared ${prevFiles.length} previous preview images.`);
    }

    log('Closing all open images...');
    let imgs = await listImages();
    if (imgs.length > 0) {
      const ids = imgs.map(i => "'" + i.id + "'").join(',');
      await pjsr(`var ids=[${ids}]; for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(!w.isNull)w.forceClose();processEvents();}`);
    }

    if (lOnlyMode) {
      // L-only mode: open only L file
      log('Opening L...');
      const rL = await send('open_image', '__internal__', { filePath: F.L });
      if (rL.status === 'error') { log('FATAL: ' + rL.error.message); process.exit(1); }
      log('  L: ' + rL.outputs.id + ' (' + rL.outputs.width + 'x' + rL.outputs.height + ')');

      // Close XISF crop masks
      imgs = await listImages();
      for (const cm of imgs.filter(i => i.id.indexOf('crop_mask') >= 0)) {
        await pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
      }

      imgs = await listImages();
      const findViewL = (f) => imgs.find(i => i.id.toUpperCase().indexOf(f) >= 0);
      const findViewLRe = (re) => imgs.find(i => re.test(i.id));
      const viewL = findViewL('FILTER_L') || findViewL('FILTER-L') || findViewLRe(/[_-]L[_-]/i) || findViewLRe(/[_-]L$/i) || findViewLRe(/integration[_-]?L/i) || imgs[0];
      if (!viewL) { log('FATAL: Could not identify L image'); process.exit(1); }
      idL = viewL.id;
      rgbW = viewL.width; rgbH = viewL.height;
      log('Identified: L=' + idL + ' (' + rgbW + 'x' + rgbH + ')');
    } else {
      // Standard RGB mode
      log('Opening R, G, B' + (hasHa ? ', Ha' : '') + (hasL ? ', L' : '') + '...');
      const rR = await send('open_image', '__internal__', { filePath: F.R });
      if (rR.status === 'error') { log('FATAL: ' + rR.error.message); process.exit(1); }
      log('  R: ' + rR.outputs.id + ' (' + rR.outputs.width + 'x' + rR.outputs.height + ')');
      const rG = await send('open_image', '__internal__', { filePath: F.G });
      log('  G: ' + rG.outputs.id);
      const rB = await send('open_image', '__internal__', { filePath: F.B });
      log('  B: ' + rB.outputs.id);
      let rHa;
      if (hasHa) {
        rHa = await send('open_image', '__internal__', { filePath: F.Ha });
        log('  Ha: ' + rHa.outputs.id + ' (' + rHa.outputs.width + 'x' + rHa.outputs.height + ') [linear, with stars]');
      }
      let rL;
      if (hasL) {
        rL = await send('open_image', '__internal__', { filePath: F.L });
        log('  L: ' + rL.outputs.id + ' (' + rL.outputs.width + 'x' + rL.outputs.height + ')');
      }

      // Close XISF crop masks
      imgs = await listImages();
      for (const cm of imgs.filter(i => i.id.indexOf('crop_mask') >= 0)) {
        await pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
      }

      imgs = await listImages();
      const findView = (f) => imgs.find(i => i.id.toUpperCase().indexOf(f) >= 0);
      const findViewRe = (re) => imgs.find(i => re.test(i.id));
      const viewR = findView('FILTER_R') || findView('FILTER-R') || findViewRe(/[_-]R[_-]/i) || findViewRe(/[_-]R$/i);
      const viewG = findView('FILTER_G') || findView('FILTER-G') || findView('FILTER_V') || findView('FILTER-V') || findViewRe(/[_-][VG][_-]/i) || findViewRe(/[_-][VG]$/i);
      const viewB = findView('FILTER_B') || findView('FILTER-B') || findViewRe(/[_-]B[_-]/i) || findViewRe(/[_-]B$/i);
      const viewHa = hasHa ? (findViewRe(/[_-]ha(?:lpha)?[_-]/i) || findViewRe(/[_-]ha(?:lpha)?$/i)) : null;
      const viewL2 = hasL ? (findView('FILTER_L') || findView('FILTER-L') || findViewRe(/[_-]L[_-]/i) || findViewRe(/[_-]L$/i)) : null;
      if (!viewR || !viewG || !viewB || (hasHa && !viewHa) || (hasL && !viewL2)) { log('FATAL: Missing images. Found: R=' + (viewR?.id||'?') + ' G=' + (viewG?.id||'?') + ' B=' + (viewB?.id||'?') + (hasHa ? ' Ha=' + (viewHa?.id||'?') : '') + (hasL ? ' L=' + (viewL2?.id||'?') : '')); process.exit(1); }
      idR = viewR.id; idG = viewG.id; idB = viewB.id;
      if (hasHa) idHa = viewHa.id;
      if (hasL) idL = viewL2.id;
      rgbW = viewR.width; rgbH = viewR.height;
      log('Identified: R=' + idR + ' G=' + idG + ' B=' + idB + (hasHa ? ' Ha=' + idHa : '') + (hasL ? ' L=' + idL : ''));
    }
  }

  let r;
  // ==== PHASE 0b: CHANNEL ALIGNMENT (StarAlignment) ====
  if (lOnlyMode && isEnabled('align')) {
    log('\n==== PHASE 0b: CHANNEL ALIGNMENT (SKIPPED — L-only mode) ====');
  } else if (isEnabled('align') && !shouldSkip('align')) {
    log('\n==== PHASE 0b: CHANNEL ALIGNMENT (StarAlignment) ====');
    const alignDir = path.join(F.outputDir, 'aligned');
    if (!fs.existsSync(alignDir)) fs.mkdirSync(alignDir, { recursive: true });
    log('  Reference: R (' + idR + ')');
    const toAlign = [
      { label: 'G', path: F.G },
      { label: 'B', path: F.B }
    ];
    if (hasHa) toAlign.push({ label: 'Ha', path: F.Ha });
    if (hasL) toAlign.push({ label: 'L', path: F.L });
    const targetsJs = toAlign.map(t => "[true,true,'" + t.path.replace(/'/g, "\\'") + "']").join(',');
    log('  Aligning ' + toAlign.map(t => t.label).join(', ') + ' to R...');
    r = await pjsr(`
      var P = new StarAlignment;
      P.referenceImage = '${F.R.replace(/'/g, "\\'")}';
      P.referenceIsFile = true;
      P.targets = [${targetsJs}];
      P.outputDirectory = '${alignDir.replace(/'/g, "\\'")}';
      P.outputSuffix = '_r';
      P.overwriteExistingFiles = true;
      P.onError = StarAlignment.prototype.Continue;
      P.executeGlobal();
    `);
    if (r.status === 'error') {
      log('  WARN: StarAlignment error: ' + r.error.message);
      log('  Continuing with unaligned files...');
    } else {
      log('  Alignment done.');
      // Close current unaligned views and re-open aligned files
      let imgs = await listImages();
      const allIds = imgs.map(i => "'" + i.id + "'").join(',');
      await pjsr(`var ids=[${allIds}]; for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(!w.isNull)w.forceClose();processEvents();}`);

      // Build aligned file paths (StarAlignment appends _a before extension)
      const alignedG = path.join(alignDir, path.basename(F.G, '.xisf') + '_r.xisf');
      const alignedB = path.join(alignDir, path.basename(F.B, '.xisf') + '_r.xisf');
      const alignedHa = hasHa ? path.join(alignDir, path.basename(F.Ha, '.xisf') + '_r.xisf') : null;
      const alignedL = hasL ? path.join(alignDir, path.basename(F.L, '.xisf') + '_r.xisf') : null;

      // Re-open: R (unaligned reference) + aligned G, B, Ha, L
      log('  Re-opening aligned files...');
      await send('open_image', '__internal__', { filePath: F.R });
      await send('open_image', '__internal__', { filePath: fs.existsSync(alignedG) ? alignedG : F.G });
      await send('open_image', '__internal__', { filePath: fs.existsSync(alignedB) ? alignedB : F.B });
      if (hasHa) await send('open_image', '__internal__', { filePath: fs.existsSync(alignedHa) ? alignedHa : F.Ha });
      if (hasL) await send('open_image', '__internal__', { filePath: fs.existsSync(alignedL) ? alignedL : F.L });

      // Close XISF crop masks
      imgs = await listImages();
      for (const cm of imgs.filter(i => i.id.indexOf('crop_mask') >= 0)) {
        await pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
      }

      // Re-detect view IDs
      imgs = await listImages();
      const findView2 = (f) => imgs.find(i => i.id.toUpperCase().indexOf(f) >= 0);
      const findViewRe2 = (re) => imgs.find(i => re.test(i.id));
      const vR = findView2('FILTER_R') || findView2('FILTER-R') || findViewRe2(/[_-]R[_-]/i) || findViewRe2(/[_-]R$/i);
      const vG = findView2('FILTER_G') || findView2('FILTER-G') || findView2('FILTER_V') || findView2('FILTER-V') || findViewRe2(/[_-][VG][_-]/i) || findViewRe2(/[_-][VG]$/i);
      const vB = findView2('FILTER_B') || findView2('FILTER-B') || findViewRe2(/[_-]B[_-]/i) || findViewRe2(/[_-]B$/i);
      const vHa = hasHa ? (findViewRe2(/[_-]ha(?:lpha)?[_-]/i) || findViewRe2(/[_-]ha(?:lpha)?$/i)) : null;
      const vL = hasL ? (findView2('FILTER_L') || findView2('FILTER-L') || findViewRe2(/[_-]L[_-]/i) || findViewRe2(/[_-]L$/i)) : null;
      if (vR) idR = vR.id;
      if (vG) idG = vG.id;
      if (vB) idB = vB.id;
      if (hasHa && vHa) idHa = vHa.id;
      if (hasL && vL) idL = vL.id;
      rgbW = vR?.width || rgbW; rgbH = vR?.height || rgbH;
      log('  Re-identified: R=' + idR + ' G=' + idG + ' B=' + idB + (hasHa ? ' Ha=' + idHa : '') + (hasL ? ' L=' + idL : ''));
    }
    await checkMemory('align');
  } else if (!isEnabled('align')) {
    log('\n==== PHASE 0b: CHANNEL ALIGNMENT (SKIPPED) ====');
  }

  // ==== PHASE 0c: PER-CHANNEL GRADIENT CORRECTION ====
  const gcP_pre = P('gc');
  if (isEnabled('gc') && gcP_pre.perChannel && !lOnlyMode && !RESTART_FROM) {
    log('\n==== PHASE 0c: PER-CHANNEL GRADIENT CORRECTION ====');
    const channels = [['R', idR], ['G', idG], ['B', idB]];
    if (hasL) channels.push(['L', idL]);
    for (const [label, id] of channels) {
      log('  Correcting ' + label + ' (' + id + ')...');
      const before = await measureUniformity(id);
      await cloneImage(id, id + '_gc_bak');
      await runGC(id);
      const after = await measureUniformity(id);
      if (after.score < before.score) {
        log('  ' + label + ': GC improved uniformity ' + before.score.toFixed(6) + ' -> ' + after.score.toFixed(6));
        await closeImage(id + '_gc_bak');
      } else {
        log('  ' + label + ': GC did NOT improve (' + before.score.toFixed(6) + ' -> ' + after.score.toFixed(6) + ') — reverting');
        await restoreFromClone(id, id + '_gc_bak');
        await closeImage(id + '_gc_bak');
      }
    }
    await checkMemory('gc_perchannel');
  }

  // ==== PHASE 1: COMBINE + ALIGN Ha ====
  if (lOnlyMode && !shouldSkip('combine_rgb')) {
    // L-only mode: clone L → targetName as grayscale working image
    await maybeCheckpoint('combine_rgb');
    log('\n==== PHASE 1: L-ONLY SETUP ====');
    log('  Cloning L -> ' + targetName + ' (grayscale)...');
    let r = await pjsr(`
      var P = new PixelMath; P.expression='${idL}'; P.useSingleExpression=true;
      P.createNewImage=true; P.showNewImage=true; P.newImageId='${targetName}';
      P.newImageWidth=${rgbW}; P.newImageHeight=${rgbH};
      P.newImageColorSpace=PixelMath.prototype.Gray; P.newImageSampleFormat=PixelMath.prototype.f32;
      P.executeGlobal();
    `);
    if (r.status === 'error') { log('FATAL: ' + r.error.message); process.exit(1); }

    // Copy astrometry if available
    await pjsr(`
      var s=ImageWindow.windowById('${idL}'), d=ImageWindow.windowById('${targetName}');
      if(s&&!s.isNull&&d&&!d.isNull&&s.hasAstrometricSolution) d.copyAstrometricSolution(s);
    `);

    log('  Closing original L...');
    await pjsr(`var w=ImageWindow.windowById('${idL}');if(!w.isNull)w.forceClose();`);
    liveImages.main = targetName;
    await savePreview(targetName, 'combine_rgb');
  } else if (isEnabled('combine_rgb') && !shouldSkip('combine_rgb')) {
    await maybeCheckpoint('combine_rgb');
    log('\n==== PHASE 1: COMBINE RGB' + (hasHa ? ' + ALIGN Ha' : '') + ' ====');

    let imgs = await listImages();

    if (hasHa) {
      const haView = imgs.find(i => i.id === idHa);
      const haW = haView?.width || 0;
      const haH = haView?.height || 0;
      if (haW && haH && (haW !== rgbW || haH !== rgbH)) {
        if (F.haAlignCrop) {
          const c = F.haAlignCrop;
          log('  Crop Ha (' + haW + 'x' + haH + ') -> (' + rgbW + 'x' + rgbH + ') using WBPPCROP...');
          await pjsr(`
            var P = new Crop;
            P.leftMargin = ${-c.left}; P.topMargin = ${-c.top};
            P.rightMargin = ${-c.right}; P.bottomMargin = ${-c.bottom};
            P.executeOn(ImageWindow.windowById('${idHa}').mainView);
          `);
        } else {
          log('  DynamicCrop Ha (' + haW + 'x' + haH + ') -> (' + rgbW + 'x' + rgbH + ')...');
          await pjsr(`
            var P = new DynamicCrop; P.centerX=0.5; P.centerY=0.5;
            P.width=${rgbW}/${haW}; P.height=${rgbH}/${haH};
            P.executeOn(ImageWindow.windowById('${idHa}').mainView);
          `);
        }
        log('    Done.');
      } else {
        log('  Ha already matches RGB dimensions.');
      }
    }

    if (hasL) {
      const lView = imgs.find(i => i.id === idL);
      const lW = lView?.width || 0;
      const lH = lView?.height || 0;
      if (lW && lH && (lW !== rgbW || lH !== rgbH)) {
        log('  DynamicCrop L (' + lW + 'x' + lH + ') -> (' + rgbW + 'x' + rgbH + ')...');
        await pjsr(`
          var P = new DynamicCrop; P.centerX=0.5; P.centerY=0.5;
          P.width=${rgbW}/${lW}; P.height=${rgbH}/${lH};
          P.executeOn(ImageWindow.windowById('${idL}').mainView);
        `);
        log('    Done.');
      } else {
        log('  L already matches RGB dimensions.');
      }
    }

    log('  Creating RGB composite (' + targetName + ')...');
    let r = await pjsr(`
      var P = new PixelMath;
      P.expression='${idR}'; P.expression1='${idG}'; P.expression2='${idB}';
      P.useSingleExpression=false; P.createNewImage=true; P.showNewImage=true;
      P.newImageId='${targetName}'; P.newImageWidth=${rgbW}; P.newImageHeight=${rgbH};
      P.newImageColorSpace=PixelMath.prototype.RGB; P.newImageSampleFormat=PixelMath.prototype.f32;
      P.executeGlobal();
    `);
    if (r.status === 'error') { log('FATAL: ' + r.error.message); process.exit(1); }

    log('  Copying astrometry + observation metadata from R...');
    r = await pjsr(`
      var s=ImageWindow.windowById('${idR}'), d=ImageWindow.windowById('${targetName}');
      var ok=false;
      if(s&&!s.isNull&&d&&!d.isNull&&s.hasAstrometricSolution){
        d.copyAstrometricSolution(s);
        ok=d.hasAstrometricSolution;
      }
      // Copy observation keywords needed for SPCC position reduction
      if(s&&!s.isNull&&d&&!d.isNull){
        var rKW=s.keywords, tKW=d.keywords;
        var copyNames=['DATE-OBS','DATE-END','OBSGEO-L','OBSGEO-B','OBSGEO-H',
                       'LONG-OBS','LAT-OBS','ALT-OBS','EXPTIME','TELESCOP','INSTRUME','OBJECT',
                       'FOCALLEN','XPIXSZ','YPIXSZ','RA','DEC','OBJCTRA','OBJCTDEC'];
        for(var k=0;k<copyNames.length;k++){
          var name=copyNames[k], exists=false;
          for(var j=0;j<tKW.length;j++){if(tKW[j].name===name){exists=true;break;}}
          if(!exists){for(var m=0;m<rKW.length;m++){if(rKW[m].name===name){tKW.push(new FITSKeyword(rKW[m].name,rKW[m].value,rKW[m].comment));break;}}}
        }
        d.keywords=tKW;
        // Copy XISF observation properties
        var obsProps=['Observation:Time:Start','Observation:Time:End',
          'Observation:Location:Longitude','Observation:Location:Latitude','Observation:Location:Elevation'];
        for(var p=0;p<obsProps.length;p++){
          try{var v=s.mainView.propertyValue(obsProps[p]);var t=s.mainView.propertyType(obsProps[p]);
            if(v!==undefined&&v!==null)d.mainView.setPropertyValue(obsProps[p],v,t);}catch(e){}
        }
      }
      ok ? 'WCS copied (has astrometry: '+d.hasAstrometricSolution+')' : 'WARN: No astrometric solution on R — SPCC may fail';
    `);
    log('  ' + (r.status === 'ok' ? r.result : 'WARN: ' + (r.error?.message || 'unknown')));

    if (hasHa) {
      log('  Cloning Ha -> Ha_work...');
      await pjsr(`
        var P=new PixelMath; P.expression='${idHa}'; P.useSingleExpression=true;
        P.createNewImage=true; P.showNewImage=true; P.newImageId='Ha_work';
        P.newImageWidth=${rgbW}; P.newImageHeight=${rgbH};
        P.newImageColorSpace=PixelMath.prototype.Gray; P.newImageSampleFormat=PixelMath.prototype.f32;
        P.executeGlobal();
      `);
    }

    if (hasL) {
      log('  Cloning L -> L_work...');
      await pjsr(`
        var P=new PixelMath; P.expression='${idL}'; P.useSingleExpression=true;
        P.createNewImage=true; P.showNewImage=true; P.newImageId='L_work';
        P.newImageWidth=${rgbW}; P.newImageHeight=${rgbH};
        P.newImageColorSpace=PixelMath.prototype.Gray; P.newImageSampleFormat=PixelMath.prototype.f32;
        P.executeGlobal();
      `);
    }

    log('  Closing original masters...');
    const closeIds = ["'" + idR + "'", "'" + idG + "'", "'" + idB + "'"];
    if (hasHa) closeIds.push("'" + idHa + "'");
    if (hasL) closeIds.push("'" + idL + "'");
    await pjsr(`
      var ids=[${closeIds.join(',')}];
      for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(!w.isNull)w.forceClose();processEvents();}
    `);
    liveImages.main = targetName;
    if (hasHa) liveImages.ha = 'Ha_work';
    if (hasL && !lOnlyMode) liveImages.lum = 'L_work';
    await savePreview(targetName, 'combine_rgb');

    // Edge crop is now deferred to AFTER SPCC (Phase 4b) to preserve WCS for plate solving.
    // DynamicCrop destroys TPS WCS, so we must do SPCC first with original dimensions.

  } else if (!isEnabled('combine_rgb')) {
    log('\n==== PHASE 1: COMBINE RGB (SKIPPED) ====');
  } else {
    log('\n==== PHASE 1: COMBINE RGB (RESTART SKIP) ====');
  }

  // ==== PHASE 2: GRADIENT REMOVAL (GC / ABE / auto-compare) ====
  if (isEnabled('gc') && !shouldSkip('gc')) {
    await maybeCheckpoint('gc');
    const gcP = P('gc');
    const gcMethod = gcP.method || 'gc';  // backward compatible: default to GC-only

    if (gcMethod === 'auto') {
      log('\n==== PHASE 2: GRADIENT REMOVAL (auto: comparing GC vs ABE) ====');
      const maxAttempts = gcP.maxAttempts ?? 3;
      const abePolyDeg = gcP.abePolyDegree ?? 3;
      const abeTol = gcP.abeTolerance ?? 1.0;

      // 1. Measure pre-correction baseline
      const baseline = await measureUniformity(targetName);
      log(`  Baseline uniformity: ${baseline.score.toFixed(6)} (corners: ${baseline.corners.map(c => c.toFixed(4)).join(', ')})`);

      // 2. Clone target for A/B testing
      await cloneImage(targetName, 'gc_backup');

      // 3. Try GradientCorrection
      log('  Trying GradientCorrection...');
      await runGC(targetName);
      const gcResult = await measureUniformity(targetName);
      await savePreview(targetName, 'gc');
      log(`  GC uniformity: ${gcResult.score.toFixed(6)} (corners: ${gcResult.corners.map(c => c.toFixed(4)).join(', ')})`);

      // 4. Restore and try ABE
      await restoreFromClone(targetName, 'gc_backup');
      log(`  Trying ABE (polyDegree=${abePolyDeg})...`);
      await runABE(targetName, { polyDegree: abePolyDeg, tolerance: abeTol });
      const abeResult = await measureUniformity(targetName);
      await savePreview(targetName, 'abe');
      log(`  ABE(deg${abePolyDeg}) uniformity: ${abeResult.score.toFixed(6)} (corners: ${abeResult.corners.map(c => c.toFixed(4)).join(', ')})`);

      // Track candidates
      const candidates = [
        { name: 'GC', score: gcResult.score, apply: async () => { await restoreFromClone(targetName, 'gc_backup'); await runGC(targetName); } },
        { name: `ABE(deg${abePolyDeg})`, score: abeResult.score, apply: async () => { await restoreFromClone(targetName, 'gc_backup'); await runABE(targetName, { polyDegree: abePolyDeg, tolerance: abeTol }); } }
      ];

      // 5. Try additional ABE degrees if we have attempts left
      if (maxAttempts >= 3 && abePolyDeg !== 2) {
        await restoreFromClone(targetName, 'gc_backup');
        log('  Trying ABE (polyDegree=2)...');
        await runABE(targetName, { polyDegree: 2, tolerance: abeTol });
        const abe2Result = await measureUniformity(targetName);
        await savePreview(targetName, 'abe_deg2');
        log(`  ABE(deg2) uniformity: ${abe2Result.score.toFixed(6)} (corners: ${abe2Result.corners.map(c => c.toFixed(4)).join(', ')})`);
        candidates.push({ name: 'ABE(deg2)', score: abe2Result.score, apply: async () => { await restoreFromClone(targetName, 'gc_backup'); await runABE(targetName, { polyDegree: 2, tolerance: abeTol }); } });
      }

      // 6. Pick the winner (lowest uniformity score = most uniform background)
      candidates.sort((a, b) => a.score - b.score);
      const winner = candidates[0];
      log(`  === Winner: ${winner.name} (uniformity=${winner.score.toFixed(6)}) ===`);
      log(`  Ranking: ${candidates.map(c => `${c.name}=${c.score.toFixed(6)}`).join(' > ')}`);

      // 7. Apply the winner
      await winner.apply();
      await closeImage('gc_backup');
      await savePreview(targetName, 'gc');  // final preview under standard name
      log(`  Applied ${winner.name}.`);

    } else if (gcMethod === 'abe') {
      // ABE-only mode
      const abePolyDeg = gcP.abePolyDegree ?? 4;
      const abeTol = gcP.abeTolerance ?? 1.0;
      log(`\n==== PHASE 2: ABE (polyDegree=${abePolyDeg}) ====`);
      await runABE(targetName, { polyDegree: abePolyDeg, tolerance: abeTol });
      log('  Done.');
      await savePreview(targetName, 'gc');

    } else {
      // GC-only mode (default, backward compatible)
      log('\n==== PHASE 2: GradientCorrection ====');
      await runGC(targetName);
      log('  Done.');
      await savePreview(targetName, 'gc');
    }
    await checkMemory('gc');
  } else if (!isEnabled('gc')) {
    log('\n==== PHASE 2: GRADIENT REMOVAL (SKIPPED) ====');
  }

  // ==== PHASE 3: BXT correctOnly ====
  if (isEnabled('bxt_correct') && !shouldSkip('bxt_correct')) {
    await maybeCheckpoint('bxt_correct');
    const bxtP = P('bxt_correct');
    log('\n==== PHASE 3: BXT (correctOnly) ====');
    r = await pjsr(`
      var P = new BlurXTerminator;
      P.sharpenStars=${bxtP.sharpenStars ?? 0.50}; P.adjustStarHalos=${bxtP.adjustStarHalos ?? 0.00};
      P.sharpenNonstellar=${bxtP.sharpenNonstellar ?? 0.75}; P.correctOnly=true;
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(targetName, 'bxt_correct');
  } else if (!isEnabled('bxt_correct')) {
    log('\n==== PHASE 3: BXT correctOnly (SKIPPED) ====');
  }

  // ==== PHASE 3b: PLATE SOLVE (re-copy astrometry from R master) ====
  // BXT strips the astrometric solution, so we re-open R, crop it to match target dimensions,
  // then copy the dimension-adjusted WCS. DynamicCrop auto-updates WCS reference pixel.
  if (isEnabled('plate_solve') && !shouldSkip('plate_solve')) {
    await maybeCheckpoint('plate_solve');
    log('\n==== PHASE 3b: Plate Solve (re-copy astrometry from R) ====');

    // Re-open R master to copy its astrometric solution (BXT strips it)
    const openR = await send('open_image', '__internal__', { filePath: CFG.files.R });
    if (openR.status === 'error') {
      log('  WARN: Could not open R master: ' + (openR.error?.message || 'unknown'));
    }
    const rViewId = openR.outputs?.id || null;

    if (rViewId) {
      // Close any crop masks from XISF
      const allImgsPS = await listImages();
      for (const im of allImgsPS) {
        if (im.id.includes('crop_mask') || im.id.includes('->')) {
          await pjsr(`var w=ImageWindow.windowById('${im.id}');if(!w.isNull)w.forceClose();`);
        }
      }

      r = await pjsr(`
        var R = ImageWindow.windowById('${rViewId}');
        var d = ImageWindow.windowById('${targetName}');
        var info = '';
        if (R.isNull || d.isNull) {
          info = 'WARN: R or target not found';
        } else if (!R.hasAstrometricSolution) {
          info = 'WARN: R master has no astrometric solution';
        } else {
          // Edge crop is now deferred to Phase 4b (after SPCC) to preserve WCS.
          // At this point, target dimensions should match R (both uncropped).
          var rw = R.mainView.image.width, rh = R.mainView.image.height;
          var dw = d.mainView.image.width, dh = d.mainView.image.height;
          if (rw !== dw || rh !== dh) {
            info = 'WARN: R (' + rw + 'x' + rh + ') vs target (' + dw + 'x' + dh + ') size mismatch. ';
          }
          // Now copy the (possibly cropped) WCS
          d.copyAstrometricSolution(R);
          // Re-copy observation keywords (BXT may have cleared them)
          var rKW = R.keywords, tKW = d.keywords;
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
          d.keywords = tKW;
          // Copy XISF observation properties
          var obsProps = ['Observation:Time:Start','Observation:Time:End',
            'Observation:Location:Longitude','Observation:Location:Latitude','Observation:Location:Elevation'];
          for (var p = 0; p < obsProps.length; p++) {
            try { var v = R.mainView.propertyValue(obsProps[p]); var t = R.mainView.propertyType(obsProps[p]);
              if (v !== undefined && v !== null) d.mainView.setPropertyValue(obsProps[p], v, t); } catch(e) {}
          }
          info += 'Astrometry re-copied (hasAstro=' + d.hasAstrometricSolution + ', keywords: ' + copied.join(',') + ')';
        }
        R.forceClose();
        info;
      `);
      log('  ' + (r.status === 'ok' ? r.result : 'WARN: Script error: ' + (r.error?.message || 'unknown')));
    }
  } else if (!isEnabled('plate_solve')) {
    log('\n==== PHASE 3b: Plate Solve (SKIPPED) ====');
  }

  // ==== PHASE 4: SPCC + SCNR ====
  if (lOnlyMode && isEnabled('spcc')) {
    log('\n==== PHASE 4: SPCC (SKIPPED — L-only mode) ====');
  } else if (isEnabled('spcc') && !shouldSkip('spcc')) {
    await maybeCheckpoint('spcc');
    const spccP = P('spcc');
    log('\n==== PHASE 4: SPCC ====');

    // Measure channel medians before SPCC
    r = await pjsr(`
      var img=ImageWindow.windowById('${targetName}').mainView.image;
      img.selectedChannel=0; var mr=img.median();
      img.selectedChannel=1; var mg=img.median();
      img.selectedChannel=2; var mb=img.median();
      img.resetChannelSelection();
      'pre-SPCC medians: R='+mr.toFixed(6)+' G='+mg.toFixed(6)+' B='+mb.toFixed(6);
    `);
    log('  ' + (r.status === 'ok' ? r.result : ''));

    // Write all SPCC data (curves + white reference spectrum) to temp file
    // PJSR names alone don't load curve data — must set both name AND data
    const spccData = {
      whiteRef: WHITE_REF_AVG_SPIRAL,
      red: curveToCSV(ASTRONOMIK_R),
      green: curveToCSV(ASTRONOMIK_G),
      blue: curveToCSV(ASTRONOMIK_B),
      qe: curveToCSV(SONY_IMX411_QE)
    };
    fs.writeFileSync('/tmp/spcc-curves.json', JSON.stringify(spccData));

    r = await pjsr(`
      var json = File.readLines('/tmp/spcc-curves.json').join('');
      var c = JSON.parse(json);
      var P = new SpectrophotometricColorCalibration;
      P.applyCalibration = true;
      P.narrowbandMode = ${spccP.narrowbandMode ? 'true' : 'false'};
      P.whiteReferenceSpectrum = c.whiteRef;
      P.whiteReferenceName = '${spccP.whiteReferenceName || 'Average Spiral Galaxy'}';
      P.redFilterTrCurve = c.red;
      P.redFilterName = 'Astronomik Deep Sky R';
      P.greenFilterTrCurve = c.green;
      P.greenFilterName = 'Astronomik Deep Sky G';
      P.blueFilterTrCurve = c.blue;
      P.blueFilterName = 'Astronomik Deep Sky B';
      P.deviceQECurve = c.qe;
      P.deviceQECurveName = '${spccP.sensorQE || 'Sony IMX411/455/461/533/571'}';
      P.neutralizeBackground = true;
      P.backgroundLow = -2.80;
      P.backgroundHigh = 2.00;
      P.catalogId = 'GaiaDR3SP';
      P.autoLimitMagnitude = true;
      P.limitMagnitude = 12.00;
      P.targetSourceCount = 8000;
      P.psfStructureLayers = 5;
      P.saturationThreshold = 0.75;
      P.saturationRelative = true;
      P.saturationShrinkFactor = 0.10;
      P.psfMinSNR = 10.00;
      P.psfAllowClusteredSources = true;
      P.psfType = SpectrophotometricColorCalibration.prototype.PSFType_Auto;
      P.psfGrowth = 1.25;
      P.psfMaxStars = 24576;
      P.psfSearchTolerance = 4.00;
      P.psfChannelSearchTolerance = 2.00;
      P.generateGraphs = ${spccP.generateGraphs ? 'true' : 'false'};
      var ret = P.executeOn(ImageWindow.windowById('${targetName}').mainView);
      ret ? 'SPCC applied successfully' : 'SPCC_FAILED';
    `);
    if (r.status === 'error') {
      log('  WARN: SPCC failed (exception) — ' + r.error.message);
    } else if (r.result === 'SPCC_FAILED') {
      log('  WARN: SPCC returned false — calibration not applied (check WCS/metadata)');
    } else {
      log('  Done. ' + r.result);
    }

    // Measure channel medians after SPCC to verify calibration took effect
    r = await pjsr(`
      var img=ImageWindow.windowById('${targetName}').mainView.image;
      img.selectedChannel=0; var mr=img.median();
      img.selectedChannel=1; var mg=img.median();
      img.selectedChannel=2; var mb=img.median();
      img.resetChannelSelection();
      'post-SPCC medians: R='+mr.toFixed(6)+' G='+mg.toFixed(6)+' B='+mb.toFixed(6);
    `);
    if (r.status === 'ok') {
      log('  ' + r.result);
      // User can compare pre/post SPCC medians in the log
    }
    await savePreview(targetName, 'spcc');
  } else if (!isEnabled('spcc')) {
    log('\n==== PHASE 4: SPCC (SKIPPED) ====');
  }

  if (lOnlyMode && isEnabled('scnr')) {
    log('  SCNR (SKIPPED — L-only mode)');
  } else if (isEnabled('scnr') && !shouldSkip('scnr')) {
    await maybeCheckpoint('scnr');
    const scnrP = P('scnr');
    log('  SCNR (green removal)...');
    r = await pjsr(`
      var P = new SCNR; P.colorToRemove = 1; P.amount = ${scnrP.amount ?? 1.0};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(targetName, 'scnr');
  }

  // ==== PHASE 4b: EDGE CROP (deferred from Phase 1 to preserve WCS for SPCC) ====
  // Skip on restart — checkpoint images are already cropped
  const cropEdge = P('combine_rgb').cropEdge ?? 0;
  if (cropEdge > 0 && !RESTART_FROM) {
    log(`\n==== PHASE 4b: EDGE CROP (${cropEdge}px from each edge) ====`);
    const imagesToCrop = [targetName];
    if (hasHa) imagesToCrop.push('Ha_work');
    if (hasL) imagesToCrop.push('L_work');
    for (const imgId of imagesToCrop) {
      r = await pjsr(`
        var w = ImageWindow.windowById('${imgId}');
        var img = w.mainView.image;
        var ow = Math.round(img.width), oh = Math.round(img.height);
        var P = new DynamicCrop;
        P.centerX = 0.5; P.centerY = 0.5;
        P.width = (ow - 2*${cropEdge}) / ow;
        P.height = (oh - 2*${cropEdge}) / oh;
        P.noGUIMessages = true;
        P.executeOn(w.mainView);
        var nw = Math.round(w.mainView.image.width), nh = Math.round(w.mainView.image.height);
        '${imgId}: ' + ow + 'x' + oh + ' -> ' + nw + 'x' + nh;
      `);
      log('  ' + (r.outputs?.consoleOutput?.trim() || r.error?.message || 'Done'));
    }
    await savePreview(targetName, 'crop_edge');
  }

  // ==== PHASE 5: BXT sharpening ====
  if (isEnabled('bxt_sharpen') && !shouldSkip('bxt_sharpen')) {
    await maybeCheckpoint('bxt_sharpen');
    const bxtP = P('bxt_sharpen');
    log('\n==== PHASE 5: BXT (sharpening) ====');
    r = await pjsr(`
      var P = new BlurXTerminator;
      P.sharpenStars=${bxtP.sharpenStars ?? 0.25}; P.adjustStarHalos=${bxtP.adjustStarHalos ?? -0.25};
      P.sharpenNonstellar=${bxtP.sharpenNonstellar ?? 0.50}; P.correctOnly=false;
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(targetName, 'bxt_sharpen');
  } else if (!isEnabled('bxt_sharpen')) {
    log('\n==== PHASE 5: BXT sharpening (SKIPPED) ====');
  }

  // ==== PHASE 6: NXT pass 1 ====
  if (isEnabled('nxt_pass1') && !shouldSkip('nxt_pass1')) {
    await maybeCheckpoint('nxt_pass1');
    const nxtP = P('nxt_pass1');
    log('\n==== PHASE 6: NXT pass 1 ====');
    r = await pjsr(`
      var P = new NoiseXTerminator; P.denoise=${nxtP.denoise ?? 0.30}; P.detail=${nxtP.detail ?? 0.15};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(targetName, 'nxt_pass1');
  } else if (!isEnabled('nxt_pass1')) {
    log('\n==== PHASE 6: NXT pass 1 (SKIPPED) ====');
  }

  // ==== PHASE 7: SXT ====
  let starsId = liveImages.stars || null;
  if (isEnabled('sxt') && !shouldSkip('sxt')) {
    await maybeCheckpoint('sxt');
    const sxtP = P('sxt');
    log('\n==== PHASE 7: SXT (star removal) ====');
    let beforeSxt = (await listImages()).map(i => i.id);
    r = await pjsr(`
      var P = new StarXTerminator; P.stars=true; P.overlap=${sxtP.overlap ?? 0.20};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    let newStarImgs = await detectNewImages(beforeSxt);
    starsId = newStarImgs.length > 0 ? newStarImgs[0].id : null;
    if (starsId) liveImages.stars = starsId;
    if (hasL && !lOnlyMode) liveImages.lum = 'L_work';
    log('  Stars: ' + (starsId || 'NOT DETECTED'));
    await savePreview(targetName, 'sxt');
  } else if (!isEnabled('sxt')) {
    log('\n==== PHASE 7: SXT (SKIPPED) ====');
    if (hasL && !lOnlyMode) liveImages.lum = 'L_work';
  }

  // ==== PHASE 7b+c: STAR PROCESSING BRANCH ====
  // Two methods available via star_stretch.params.starMethod:
  //   "linear" (Seti method) — keep linear stars, clip bg, stretch with MTF iterations, saturate
  //     Produces tight, point-like stars. Inspired by Seti Astro star stretch script.
  //     Reference: https://www.setiastro.com (Bill Blanshan / Seti Astro)
  //   "nonlinear" (default) — close linear stars, re-extract from stretched data with SXT unscreen
  //     Produces natural display-range stars but can be slightly bloated.
  const starMethod = (P('star_stretch').starMethod || 'nonlinear').toLowerCase();
  if (starsId && isEnabled('star_stretch') && !shouldSkip('star_stretch')) {
    if (starMethod === 'linear') {
      log('\n==== PHASE 7b: LINEAR STAR PROCESSING (Seti method) ====');
      const starP = P('star_stretch');
      const setiMidtone = starP.setiMidtone ?? 0.20;
      const setiIterations = starP.setiIterations ?? 5;

      // Step 1: Clip background pedestal from linear stars
      log(`  Clipping background pedestal...`);
      r = await pjsr(`
        var v = ImageWindow.windowById('${starsId}').mainView;
        var stats = v.computeOrFetchProperty('Median');
        var med = stats.at(0);
        if (med > 0.00001) {
          var P = new PixelMath;
          P.expression = 'max(0, ($T - ' + med + ') / (1 - ' + med + '))';
          P.useSingleExpression = true;
          P.createNewImage = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(v);
        }
        'Clipped: median was ' + med.toFixed(8);
      `);
      log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : r.result));

      // Step 2: Seti star stretch — MTF via PixelMath, N iterations
      // MTF(m, x) = (1-m)*x / ((1-2*m)*x + m)
      // This progressively lifts faint stars while constraining bright ones.
      const a = (1 - setiMidtone).toFixed(6);
      const b = (1 - 2 * setiMidtone).toFixed(6);
      const mtfExpr = `(${a}*$T)/((${b})*$T+${setiMidtone.toFixed(6)})`;
      log(`  Seti stretch: midtone=${setiMidtone}, ${setiIterations} iterations`);
      log(`    MTF expr: ${mtfExpr}`);
      r = await pjsr(`
        var v = ImageWindow.windowById('${starsId}').mainView;
        var mtfExpr = '${mtfExpr}';
        for (var i = 0; i < ${setiIterations}; i++) {
          var P = new PixelMath;
          P.expression = mtfExpr;
          P.useSingleExpression = true;
          P.createNewImage = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(v);
          processEvents();
        }
        'Done (' + ${setiIterations} + ' passes)';
      `);
      log('  Seti stretch: ' + (r.status === 'error' ? 'WARN: ' + r.error.message : r.result));

      // Step 3: Star saturation (if enabled)
      if (isEnabled('star_saturate')) {
        const satP = P('star_saturate');
        await pjsr(`
          var P=new CurvesTransformation;
          P.S=${curveToPJSR(satP.starSaturationCurve || [[0,0],[0.35,0.55],[0.65,0.85],[1,1]])};
          P.executeOn(ImageWindow.windowById('${starsId}').mainView);
        `);
        log('  Star saturation applied.');
      }

      liveImages.stars = starsId;
      await savePreview(starsId, 'star_stretch');
      log(`  Linear stars ready: ${starsId}`);
    } else {
      // Default: close linear stars, re-extract from non-linear data in Phase 8b
      log('\n==== PHASE 7b: CLOSING LINEAR STARS (will re-extract after stretch) ====');
      await pjsr(`var w=ImageWindow.windowById('${starsId}');if(!w.isNull)w.forceClose();`);
      log('  Closed ' + starsId + '. Non-linear extraction in Phase 8b.');
      starsId = null;
      delete liveImages.stars;
    }
  } else if (starsId && shouldSkip('star_stretch')) {
    // Resuming from checkpoint — stars already processed, just track them
    liveImages.stars = starsId;
    log('\n==== PHASE 7b: LINEAR STAR PROCESSING (RESTART SKIP — stars already processed) ====');
  }

  // ==== PHASE 7c1: Ha GRADIENT CORRECTION (Ha branch — linear) ====
  if (isEnabled('ha_gc') && !shouldSkip('ha_gc')) {
    await maybeCheckpoint('ha_gc');
    const haGcP = P('ha_gc');
    log('\n==== PHASE 7c1: Ha GC (gradient correction on linear Ha) ====');
    r = await pjsr(`
      var P = new GradientCorrection;
      P.executeOn(ImageWindow.windowById('Ha_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('Ha_work', 'ha_gc');
  } else if (!isEnabled('ha_gc')) {
    log('\n==== PHASE 7c1: Ha GC (SKIPPED) ====');
  }

  // ==== PHASE 7c2: Ha BXT CORRECT (Ha branch — optical correction only, linear) ====
  if (isEnabled('ha_bxt_correct') && !shouldSkip('ha_bxt_correct')) {
    await maybeCheckpoint('ha_bxt_correct');
    const haBxtCP = P('ha_bxt_correct');
    log('\n==== PHASE 7c2: Ha BXT (correctOnly on linear Ha) ====');
    r = await pjsr(`
      var P = new BlurXTerminator;
      P.correct_only = true;
      P.sharpen_stars = ${haBxtCP.sharpenStars ?? 0.50};
      P.sharpen_nonstellar = ${haBxtCP.sharpenNonstellar ?? 0.75};
      P.adjust_halos = ${haBxtCP.adjustStarHalos ?? 0.00};
      P.executeOn(ImageWindow.windowById('Ha_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('Ha_work', 'ha_bxt_correct');
  } else if (!isEnabled('ha_bxt_correct')) {
    log('\n==== PHASE 7c2: Ha BXT correct (SKIPPED) ====');
  }

  // ==== PHASE 7c3: Ha NXT LINEAR (Ha branch — denoise linear data) ====
  if (isEnabled('ha_nxt_linear') && !shouldSkip('ha_nxt_linear')) {
    await maybeCheckpoint('ha_nxt_linear');
    const haNxtLP = P('ha_nxt_linear');
    log(`\n==== PHASE 7c3: Ha NXT linear (denoise=${haNxtLP.denoise ?? 0.30}, detail=${haNxtLP.detail ?? 0.15}) ====`);
    r = await pjsr(`
      var P = new NoiseXTerminator; P.denoise=${haNxtLP.denoise ?? 0.30}; P.detail=${haNxtLP.detail ?? 0.15};
      P.executeOn(ImageWindow.windowById('Ha_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('Ha_work', 'ha_nxt_linear');
  } else if (!isEnabled('ha_nxt_linear')) {
    log('\n==== PHASE 7c3: Ha NXT linear (SKIPPED) ====');
  }

  // ==== PHASE 7c4: Ha BXT SHARPEN (Ha branch — sharpening, linear) ====
  if (isEnabled('ha_bxt_sharpen') && !shouldSkip('ha_bxt_sharpen')) {
    await maybeCheckpoint('ha_bxt_sharpen');
    const haBxtSP = P('ha_bxt_sharpen');
    log('\n==== PHASE 7c4: Ha BXT sharpen (sharpening on linear Ha) ====');
    r = await pjsr(`
      var P = new BlurXTerminator;
      P.correct_only = false;
      P.sharpen_stars = ${haBxtSP.sharpenStars ?? 0.25};
      P.sharpen_nonstellar = ${haBxtSP.sharpenNonstellar ?? 0.60};
      P.adjust_halos = ${haBxtSP.adjustStarHalos ?? 0.00};
      P.executeOn(ImageWindow.windowById('Ha_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('Ha_work', 'ha_bxt_sharpen');
  } else if (!isEnabled('ha_bxt_sharpen')) {
    log('\n==== PHASE 7c4: Ha BXT sharpen (SKIPPED) ====');
  }

  // ==== PHASE 7d: Ha SXT (Ha branch — star removal from linear Ha) ====
  if (isEnabled('ha_sxt') && !shouldSkip('ha_sxt')) {
    await maybeCheckpoint('ha_sxt');
    const haSxtP = P('ha_sxt');
    log('\n==== PHASE 7d: Ha SXT (star removal from Ha) ====');
    let beforeHaSxt = (await listImages()).map(i => i.id);
    r = await pjsr(`
      var P = new StarXTerminator; P.stars=true; P.overlap=${haSxtP.overlap ?? 0.20};
      P.executeOn(ImageWindow.windowById('Ha_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    // Close Ha star image (not needed)
    let haStarImgs = await detectNewImages(beforeHaSxt);
    if (haStarImgs.length > 0) {
      const closeIds = haStarImgs.map(i => "'" + i.id + "'").join(',');
      await pjsr(`var ids=[${closeIds}];for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(!w.isNull)w.forceClose();processEvents();}`);
      log('  Closed Ha star image(s).');
    }
    await savePreview('Ha_work', 'ha_sxt');
  } else if (!isEnabled('ha_sxt')) {
    log('\n==== PHASE 7d: Ha SXT (SKIPPED) ====');
  }

  // ==== PHASE 7e: Ha STRETCH (Ha branch — stretch linear Ha) ====
  if (isEnabled('ha_stretch') && !shouldSkip('ha_stretch')) {
    await maybeCheckpoint('ha_stretch');
    const haStrP = P('ha_stretch');
    const haStretchMethod = haStrP.stretchMethod ?? 'auto';
    log(`\n==== PHASE 7e: Ha STRETCH (method=${haStretchMethod}) ====`);
    if (haStretchMethod === 'seti') {
      log(`  Seti Statistical Stretch on Ha_work...`);
      await setiStretch('Ha_work', {
        targetMedian:    haStrP.targetBg ?? 0.15,
        blackpointSigma: haStrP.blackpointSigma ?? 5.0,
        noBlackClip:     haStrP.noBlackClip ?? false,
        normalize:       haStrP.normalize ?? false,
        hdrCompress:     haStrP.hdrCompress ?? false,
        hdrAmount:       haStrP.hdrAmount ?? 0.25,
        hdrKnee:         haStrP.hdrKnee ?? 0.35,
        hdrHeadroom:     haStrP.hdrHeadroom ?? 0,
        iterations:      haStrP.iterations ?? 1,
      });
    } else {
      await autoStretch('Ha_work', haStrP.targetBg ?? 0.25);
    }
    await savePreview('Ha_work', 'ha_stretch');
  } else if (!isEnabled('ha_stretch')) {
    log('\n==== PHASE 7e: Ha STRETCH (SKIPPED) ====');
  }

  // ==== PHASE 7e1: Ha NXT (Ha branch — denoise after stretch) ====
  if (isEnabled('ha_nxt') && !shouldSkip('ha_nxt')) {
    await maybeCheckpoint('ha_nxt');
    const haNxtP = P('ha_nxt');
    log(`\n==== PHASE 7e1: Ha NXT (denoise=${haNxtP.denoise ?? 0.50}, detail=${haNxtP.detail ?? 0.15}) ====`);
    r = await pjsr(`
      var P = new NoiseXTerminator; P.denoise=${haNxtP.denoise ?? 0.50}; P.detail=${haNxtP.detail ?? 0.15};
      P.executeOn(ImageWindow.windowById('Ha_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('Ha_work', 'ha_nxt');
  } else if (!isEnabled('ha_nxt')) {
    log('\n==== PHASE 7e1: Ha NXT (SKIPPED) ====');
  }

  // ==== PHASE 7d2: L BXT CORRECT (Lum branch — PSF correction on linear L) ====
  if (isEnabled('l_bxt_correct') && !shouldSkip('l_bxt_correct')) {
    const lBxtCP = P('l_bxt_correct');
    log('\n==== PHASE 7d2: L BXT CORRECT (linear) ====');
    r = await pjsr(`
      var P = new BlurXTerminator;
      P.sharpenStars = ${lBxtCP.sharpenStars ?? 0.50}; P.adjustStarHalos = ${lBxtCP.adjustStarHalos ?? 0.00};
      P.sharpenNonstellar = ${lBxtCP.sharpenNonstellar ?? 0.75}; P.correctOnly = true;
      P.executeOn(ImageWindow.windowById('L_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('L_work', 'l_bxt_correct');
  } else if (!isEnabled('l_bxt_correct')) {
    log('\n==== PHASE 7d2: L BXT CORRECT (SKIPPED) ====');
  }

  // ==== PHASE 7d3: L NXT LINEAR (Lum branch — denoise on linear L) ====
  if (isEnabled('l_nxt_linear') && !shouldSkip('l_nxt_linear')) {
    const lNxtLP = P('l_nxt_linear');
    log(`\n==== PHASE 7d3: L NXT LINEAR (denoise=${lNxtLP.denoise ?? 0.25}, detail=${lNxtLP.detail ?? 0.15}) ====`);
    r = await pjsr(`
      var P = new NoiseXTerminator;
      P.denoise = ${lNxtLP.denoise ?? 0.25}; P.detail = ${lNxtLP.detail ?? 0.15};
      P.executeOn(ImageWindow.windowById('L_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('L_work', 'l_nxt_linear');
  } else if (!isEnabled('l_nxt_linear')) {
    log('\n==== PHASE 7d3: L NXT LINEAR (SKIPPED) ====');
  }

  // ==== PHASE 7d4: L BXT SHARPEN (Lum branch — sharpening on linear L) ====
  if (isEnabled('l_bxt_sharpen') && !shouldSkip('l_bxt_sharpen')) {
    const lBxtSP = P('l_bxt_sharpen');
    log('\n==== PHASE 7d4: L BXT SHARPEN (linear) ====');
    r = await pjsr(`
      var P = new BlurXTerminator;
      P.sharpenStars = ${lBxtSP.sharpenStars ?? 0.25}; P.adjustStarHalos = ${lBxtSP.adjustStarHalos ?? 0.00};
      P.sharpenNonstellar = ${lBxtSP.sharpenNonstellar ?? 0.60}; P.correctOnly = false;
      P.executeOn(ImageWindow.windowById('L_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('L_work', 'l_bxt_sharpen');
  } else if (!isEnabled('l_bxt_sharpen')) {
    log('\n==== PHASE 7d4: L BXT SHARPEN (SKIPPED) ====');
  }

  // ==== PHASE 7e2: L SXT (Lum branch — star removal from linear L) ====
  if (lOnlyMode && isEnabled('l_sxt')) {
    log('\n==== PHASE 7e2: L SXT (SKIPPED — L-only mode, no separate L branch) ====');
  } else if (isEnabled('l_sxt') && !shouldSkip('l_sxt')) {
    await maybeCheckpoint('l_sxt');
    const lSxtP = P('l_sxt');
    log('\n==== PHASE 7e2: L SXT (star removal from L) ====');
    let beforeLSxt = (await listImages()).map(i => i.id);
    r = await pjsr(`
      var P = new StarXTerminator; P.stars=true; P.overlap=${lSxtP.overlap ?? 0.20};
      P.executeOn(ImageWindow.windowById('L_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    // Close L star image (not needed)
    let lStarImgs = await detectNewImages(beforeLSxt);
    if (lStarImgs.length > 0) {
      const closeIds = lStarImgs.map(i => "'" + i.id + "'").join(',');
      await pjsr(`var ids=[${closeIds}];for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(!w.isNull)w.forceClose();processEvents();}`);
      log('  Closed L star image(s).');
    }
    await savePreview('L_work', 'l_sxt');
  } else if (!isEnabled('l_sxt')) {
    log('\n==== PHASE 7e2: L SXT (SKIPPED) ====');
  }

  // ==== PHASE 7f: L STRETCH (Lum branch) ====
  // stretchMethod: "ht+ghs" (default) = HT auto-stretch then GHS refinement
  //                "ghs" = GHS-only from linear (no HT — preserves highlights)
  if (isEnabled('l_stretch') && !shouldSkip('l_stretch')) {
    await maybeCheckpoint('l_stretch');
    const lStrP = P('l_stretch');
    const stretchMethod = lStrP.stretchMethod || 'ht+ghs';
    log(`\n==== PHASE 7f: L STRETCH (method=${stretchMethod}) ====`);

    if (stretchMethod === 'hdr') {
      // HDR dual-stretch: blend a gentle stretch (good galaxies) with an aggressive stretch (IFN).
      // No single stretch can preserve both galaxy core detail AND faint IFN:
      //   - GHS preserves cores but crushes IFN against background
      //   - Auto-stretch reveals IFN but clips cores to 1.0
      // Solution: stretch linear L twice, blend using a luminance mask.
      //   1. Clone L_work → L_gentle: auto-stretch with high targetBg (gentle, galaxies intact)
      //   2. L_work: auto-stretch with low targetBg (aggressive, IFN visible, cores clipped)
      //   3. Luminance mask from L_gentle (galaxies white, background black)
      //   4. Blend: L_work = L_gentle * mask + L_work * (1-mask)
      // Result: galaxy cores from gentle stretch, IFN from aggressive stretch.
      const gentleBg = lStrP.gentleBg ?? 0.25;
      const aggressiveBg = lStrP.aggressiveBg ?? 0.08;
      const maskBlur = lStrP.hdrMaskBlur ?? 15;
      const maskClipLow = lStrP.hdrMaskClipLow ?? 0.10;
      const st0 = await getStats('L_work');
      log(`    Linear stats: median=${st0.median.toFixed(6)} (${Math.round(st0.median*65535)} ADU), MAD=${st0.mad.toFixed(6)}, max=${(st0.max ?? 0).toFixed(4)}`);
      log(`  HDR dual-stretch: gentle(bg=${gentleBg}) + aggressive(bg=${aggressiveBg})...`);

      // Step 1: Clone L_work to L_gentle (while still linear)
      r = await pjsr(`
        var srcW = ImageWindow.windowById('L_work');
        var img = srcW.mainView.image;
        var w = img.width, h = img.height;
        var gw = new ImageWindow(w, h, 1, 32, true, false, 'L_gentle');
        gw.mainView.beginProcess();
        gw.mainView.image.assign(img);
        gw.mainView.endProcess();
        gw.show();
        'Cloned L_work -> L_gentle (' + w + 'x' + h + ')';
      `);
      log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : r.result));

      // Step 2: Gentle stretch on L_gentle (high targetBg = less aggressive, cores preserved)
      log(`  Gentle stretch (targetBg=${gentleBg})...`);
      await autoStretch('L_gentle', gentleBg);
      const stGentle = await getStats('L_gentle');
      log(`    Gentle: median=${stGentle.median.toFixed(4)} (${Math.round(stGentle.median*65535)} ADU), max=${(stGentle.max ?? 0).toFixed(4)}`);
      await savePreview('L_gentle', 'l_hdr_gentle');

      // Step 3: Aggressive stretch on L_work (low targetBg = very aggressive, IFN visible)
      log(`  Aggressive stretch (targetBg=${aggressiveBg})...`);
      await autoStretch('L_work', aggressiveBg);
      const stAggr = await getStats('L_work');
      log(`    Aggressive: median=${stAggr.median.toFixed(4)} (${Math.round(stAggr.median*65535)} ADU), max=${(stAggr.max ?? 0).toFixed(4)}`);
      await savePreview('L_work', 'l_hdr_aggressive');

      // Step 4: Create luminance mask from L_gentle (galaxies=white, bg=black)
      const hdrMaskId = await createMask('L_gentle', 'mask_l_hdr', maskBlur, maskClipLow);
      if (hdrMaskId) {
        await savePreview(hdrMaskId, 'mask_l_hdr');
      }

      // Step 5: Blend — where mask is white (galaxies), use L_gentle; where black (bg/IFN), use L_work
      log('  Blending: galaxies from gentle, IFN from aggressive...');
      if (hdrMaskId) {
        r = await pjsr(`
          var P = new PixelMath;
          P.expression = 'L_gentle*mask_l_hdr + L_work*(1-mask_l_hdr)';
          P.useSingleExpression = true;
          P.createNewImage = false;
          P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(ImageWindow.windowById('L_work').mainView);
        `);
        log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Blended.'));
      } else {
        log('  WARN: No mask created — using aggressive stretch only');
      }

      // Cleanup
      await pjsr(`var w=ImageWindow.windowById('L_gentle');if(!w.isNull)w.forceClose();`);
      if (hdrMaskId) await closeMask(hdrMaskId);

      const stFinal = await getStats('L_work');
      log(`    Final L: median=${stFinal.median.toFixed(4)} (${Math.round(stFinal.median*65535)} ADU), max=${(stFinal.max ?? 0).toFixed(4)}`);
    } else if (stretchMethod === 'seti') {
      // Seti Statistical Stretch (faithful port of statisticalstretch.js v2.3)
      log(`  Seti Statistical Stretch on L_work...`);
      await setiStretch('L_work', {
        targetMedian:    lStrP.targetBg ?? 0.25,
        blackpointSigma: lStrP.blackpointSigma ?? 5.0,
        noBlackClip:     lStrP.noBlackClip ?? false,
        normalize:       lStrP.normalize ?? false,
        hdrCompress:     lStrP.hdrCompress ?? false,
        hdrAmount:       lStrP.hdrAmount ?? 0.25,
        hdrKnee:         lStrP.hdrKnee ?? 0.35,
        hdrHeadroom:     lStrP.hdrHeadroom ?? 0,
        iterations:      lStrP.iterations ?? 1,
      });
      await savePreview('L_work', 'l_stretch');
    } else if (stretchMethod === 'ghs') {
      // GHS-from-linear: 3-phase approach (friend's APOD method)
      // Phase 1: SP at shadows — lift faint signal, background to ~0.15-0.23
      // Phase 2: SP at midtones — stretch midrange, LP protects phase 1
      // Phase 3: SP at highlights — stretch bright end, LP protects phase 1+2
      // Then: highlight compression passes to tame galaxy cores
      const st0 = await getStats('L_work');
      log(`    Linear stats: median=${st0.median.toFixed(6)} (${Math.round(st0.median*65535)} ADU), MAD=${st0.mad.toFixed(6)}, max=${(st0.max ?? 0).toFixed(4)}`);
      // NO black clip for pure GHS mode — SP should sit at the natural background level
      // (the median ~0.003). Clipping would push median to ~0.00007 and defeat the GHS sweep.
      // LP=0 in phase 1 handles shadows naturally.
      // Apply GHS passes sequentially
      const lGhsPasses = lStrP.ghsPasses || [];
      log(`  GHS-from-linear: ${lGhsPasses.length} passes...`);
      for (let i = 0; i < lGhsPasses.length; i++) {
        const pass = lGhsPasses[i];
        const st = await getStats('L_work');
        const sp = pass.SP ?? st.median;
        log(`    [${i+1}/${lGhsPasses.length}] ${pass.label}`);
        log(`      Params: D=${pass.D}, B=${pass.B}, SP=${sp.toFixed(6)}, LP=${pass.LP}, HP=${pass.HP}`);
        log(`      Pre:  median=${st.median.toFixed(6)} (${Math.round(st.median*65535)} ADU), max=${(st.max ?? 0).toFixed(4)}`);
        const code = ghsCode('L_work', pass.D, pass.B, sp, pass.LP, pass.HP);
        if (code.startsWith('/*')) { log('      Skipped.'); continue; }
        r = await pjsr(code);
        if (r.status === 'error') { log('      WARN: ' + r.error.message); continue; }
        const stAfter = await getStats('L_work');
        log(`      Post: median=${stAfter.median.toFixed(6)} (${Math.round(stAfter.median*65535)} ADU), max=${(stAfter.max ?? 0).toFixed(4)}`);
        // Save per-pass preview for visual analysis
        await savePreview('L_work', `l_ghs_pass${i+1}`);
      }
    } else {
      // Hybrid: optional pre-GHS on linear → HT auto-stretch → post-GHS refinement
      // Pre-GHS compresses highlights on linear data so HT won't clip galaxy cores
      const preGhsPasses = lStrP.preGhsPasses || [];
      if (preGhsPasses.length > 0) {
        const stPre = await getStats('L_work');
        log(`  Pre-HT GHS: ${preGhsPasses.length} passes (compress highlights on linear data)...`);
        log(`    Linear: median=${stPre.median.toFixed(6)} (${Math.round(stPre.median*65535)} ADU), max=${(stPre.max ?? 0).toFixed(4)}`);
        for (let i = 0; i < preGhsPasses.length; i++) {
          const pass = preGhsPasses[i];
          const st = await getStats('L_work');
          const sp = pass.SP ?? st.median;
          log(`    [pre ${i+1}/${preGhsPasses.length}] ${pass.label} (D=${pass.D}, B=${pass.B}, SP=${sp.toFixed(4)}, LP=${pass.LP}, HP=${pass.HP})`);
          const preCode = ghsCode('L_work', pass.D, pass.B, sp, pass.LP, pass.HP);
          if (preCode.startsWith('/*')) { log('      Skipped.'); continue; }
          r = await pjsr(preCode);
          if (r.status === 'error') { log('      WARN: ' + r.error.message); continue; }
          const stA = await getStats('L_work');
          log(`      Post: median=${stA.median.toFixed(6)} (${Math.round(stA.median*65535)} ADU), max=${(stA.max ?? 0).toFixed(4)}`);
          await savePreview('L_work', `l_pre_ghs${i+1}`);
        }
      }
      // HT auto-stretch (lifts shadows/background into visible range)
      await autoStretch('L_work', lStrP.targetBg ?? 0.25);
      await savePreview('L_work', 'l_ht_stretch');
      // Post-stretch GHS refinement
      const lGhsPasses = lStrP.ghsPasses || [];
      if (lGhsPasses.length > 0) {
        log('  Post-HT GHS refinement...');
        for (let i = 0; i < lGhsPasses.length; i++) {
          const pass = lGhsPasses[i];
          const st = await getStats('L_work');
          const sp = pass.SP ?? st.median;
          log(`    [post ${i+1}/${lGhsPasses.length}] ${pass.label} (D=${pass.D}, SP=${sp.toFixed(4)})`);
          const htCode = ghsCode('L_work', pass.D, pass.B, sp, pass.LP, pass.HP);
          if (htCode.startsWith('/*')) { log('      Skipped.'); continue; }
          r = await pjsr(htCode);
          if (r.status === 'error') { log('      WARN: ' + r.error.message); continue; }
          const stA = await getStats('L_work');
          log(`      Post: median=${stA.median.toFixed(4)} (${Math.round(stA.median*65535)} ADU), max=${(stA.max ?? 0).toFixed(4)}`);
        }
      }
    }
    await savePreview('L_work', 'l_stretch');
  } else if (!isEnabled('l_stretch')) {
    log('\n==== PHASE 7f: L STRETCH (SKIPPED) ====');
  }

  // ==== PHASE 7g: L NXT (Lum branch) ====
  if (isEnabled('l_nxt') && !shouldSkip('l_nxt')) {
    await maybeCheckpoint('l_nxt');
    const lNxtP = P('l_nxt');
    log('\n==== PHASE 7g: L NXT ====');
    r = await pjsr(`
      var P = new NoiseXTerminator; P.denoise=${lNxtP.denoise ?? 0.50}; P.detail=${lNxtP.detail ?? 0.15};
      P.executeOn(ImageWindow.windowById('L_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('L_work', 'l_nxt');
  } else if (!isEnabled('l_nxt')) {
    log('\n==== PHASE 7g: L NXT (SKIPPED) ====');
  }

  // ==== PHASE 7h: L BXT (Lum branch — disabled by default) ====
  if (isEnabled('l_bxt') && !shouldSkip('l_bxt')) {
    await maybeCheckpoint('l_bxt');
    const lBxtP = P('l_bxt');
    log('\n==== PHASE 7h: L BXT ====');
    r = await pjsr(`
      var P = new BlurXTerminator;
      P.sharpenStars=${lBxtP.sharpenStars ?? 0.25}; P.adjustStarHalos=${lBxtP.adjustStarHalos ?? 0.00};
      P.sharpenNonstellar=${lBxtP.sharpenNonstellar ?? 0.50}; P.correctOnly=false;
      P.executeOn(ImageWindow.windowById('L_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('L_work', 'l_bxt');
  } else if (!isEnabled('l_bxt')) {
    log('\n==== PHASE 7h: L BXT (SKIPPED) ====');
  }

  // ==== PHASE 7h2: L LHE (Lum branch — local contrast enhancement before HDRMT) ====
  if (isEnabled('l_lhe') && !shouldSkip('l_lhe')) {
    const lLheP = P('l_lhe');
    const lLheRadius = lLheP.kernelRadius ?? 64;
    const lLheAmount = lLheP.amount ?? 0.25;
    const lLheSlope = lLheP.slopeLimit ?? 1.3;
    const lLheMaskGamma = lLheP.maskGamma ?? 2.0;
    log(`\n==== PHASE 7h2: L LHE (radius=${lLheRadius}, amount=${lLheAmount}, slope=${lLheSlope}, maskGamma=${lLheMaskGamma}) ====`);

    // Create luminance mask with gamma compression for galaxy cores
    const lLheMaskId = await createLumMask('L_work', 'mask_l_lhe', lLheP.maskBlur ?? 5, lLheP.maskClipLow ?? 0.08, lLheMaskGamma);
    if (lLheMaskId) {
      await applyMask('L_work', lLheMaskId, false);
    }

    r = await pjsr(`
      var P = new LocalHistogramEqualization;
      P.radius = ${lLheRadius};
      P.histogramBins = LocalHistogramEqualization.prototype.Bit12;
      P.slopeLimit = ${lLheSlope};
      P.amount = ${lLheAmount};
      P.circularKernel = true;
      P.executeOn(ImageWindow.windowById('L_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

    if (lLheMaskId) {
      await removeMask('L_work');
      await closeMask(lLheMaskId);
    }
    await savePreview('L_work', 'l_lhe');
  } else if (!isEnabled('l_lhe')) {
    log('\n==== PHASE 7h2: L LHE (SKIPPED) ====');
  }

  // ==== PHASE 7i: L HDRMT (Lum branch — galaxy detail in L before LRGB combine) ====
  if (isEnabled('l_hdrmt') && !shouldSkip('l_hdrmt')) {
    const lHdrmtP = P('l_hdrmt');
    const lNLayers = lHdrmtP.numberOfLayers ?? 6;
    const lNIter = lHdrmtP.numberOfIterations ?? 1;
    const lInverted = lHdrmtP.inverted ?? false;
    const lMedianXform = lHdrmtP.medianTransform ?? false;
    const lLumMask = lHdrmtP.luminanceMask ?? false;
    const lUseMask = lHdrmtP.useMask ?? true;  // external luminance mask (set false to skip)
    log(`\n==== PHASE 7i: L HDRMT (layers=${lNLayers}, iterations=${lNIter}, inverted=${lInverted}, median=${lMedianXform}, lumMask=${lLumMask}, extMask=${lUseMask}) ====`);

    // Create external luminance mask from L_work (unless useMask=false)
    let lHdrmtMaskId = null;
    if (lUseMask) {
      const lHdrmtClipLow = lHdrmtP.maskClipLow ?? 0.08;
      lHdrmtMaskId = await createLumMask('L_work', 'mask_l_hdrmt', lHdrmtP.maskBlur ?? 5, lHdrmtClipLow, lHdrmtP.maskGamma ?? 1.0);
      if (lHdrmtMaskId) {
        await applyMask('L_work', lHdrmtMaskId, false);
      }
    }

    r = await pjsr(`
      var P = new HDRMultiscaleTransform;
      P.numberOfLayers = ${lNLayers};
      P.numberOfIterations = ${lNIter};
      P.invertedIterations = ${lInverted};
      P.overdrive = 0;
      P.medianTransform = ${lMedianXform};
      P.toLightness = false;
      P.preserveHue = false;
      P.luminanceMask = ${lLumMask};
      P.executeOn(ImageWindow.windowById('L_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

    if (lHdrmtMaskId) {
      await removeMask('L_work');
      await closeMask(lHdrmtMaskId);
    }
    await savePreview('L_work', 'l_hdrmt');
  } else if (!isEnabled('l_hdrmt')) {
    log('\n==== PHASE 7i: L HDRMT (SKIPPED) ====');
  }

  // ==== PHASE 7j: L NXT FINAL (Lum branch — clean up noise from LHE/HDRMT) ====
  if (isEnabled('l_nxt_final') && !shouldSkip('l_nxt_final')) {
    const lNxtFP = P('l_nxt_final');
    log(`\n==== PHASE 7j: L NXT FINAL (denoise=${lNxtFP.denoise ?? 0.30}, detail=${lNxtFP.detail ?? 0.15}) ====`);
    r = await pjsr(`
      var P = new NoiseXTerminator;
      P.denoise = ${lNxtFP.denoise ?? 0.30};
      P.detail = ${lNxtFP.detail ?? 0.15};
      P.executeOn(ImageWindow.windowById('L_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('L_work', 'l_nxt_final');
  } else if (!isEnabled('l_nxt_final')) {
    log('\n==== PHASE 7j: L NXT FINAL (SKIPPED) ====');
  }

  // ==== PHASE 8: STRETCH ====
  // stretchMethod: "ht+ghs" (default) = HT auto-stretch then GHS refinement
  //                "ghs" = GHS-only from linear (no HT — preserves highlights)
  let mainHT = null;
  if (isEnabled('stretch') && !shouldSkip('stretch')) {
    await maybeCheckpoint('stretch');
    const strP = P('stretch');
    const stretchMethod = strP.stretchMethod || 'ht+ghs';
    log(`\n==== PHASE 8: STRETCH (method=${stretchMethod}) ====`);

    if (stretchMethod === 'seti') {
      // Seti Statistical Stretch for RGB (faithful port of statisticalstretch.js v2.3)
      log(`  Seti Statistical Stretch on ${targetName}...`);
      await setiStretch(targetName, {
        targetMedian:    strP.targetBg ?? 0.25,
        blackpointSigma: strP.blackpointSigma ?? 5.0,
        noBlackClip:     strP.noBlackClip ?? false,
        normalize:       strP.normalize ?? false,
        hdrCompress:     strP.hdrCompress ?? false,
        hdrAmount:       strP.hdrAmount ?? 0.25,
        hdrKnee:         strP.hdrKnee ?? 0.35,
        hdrHeadroom:     strP.hdrHeadroom ?? 0,
        iterations:      strP.iterations ?? 1,
      });
    } else if (stretchMethod === 'ghs') {
      // GHS-from-linear: same 3-phase approach as validated on L channel
      // useSingleExpression=true in ghsCode applies identically to all RGB channels → colour-preserving
      const st0 = await getStats(targetName);
      log(`    Linear stats: median=${st0.median.toFixed(6)} (${Math.round(st0.median*65535)} ADU), MAD=${st0.mad.toFixed(6)}, max=${(st0.max ?? 0).toFixed(4)}`);
      const rgbGhsPasses = strP.ghsPasses || [];
      log(`  GHS-from-linear: ${rgbGhsPasses.length} passes...`);
      for (let i = 0; i < rgbGhsPasses.length; i++) {
        const pass = rgbGhsPasses[i];
        const st = await getStats(targetName);
        const sp = pass.SP ?? st.median;
        log(`    [${i+1}/${rgbGhsPasses.length}] ${pass.label}`);
        log(`      Params: D=${pass.D}, B=${pass.B}, SP=${sp.toFixed(6)}, LP=${pass.LP}, HP=${pass.HP}`);
        log(`      Pre:  median=${st.median.toFixed(6)} (${Math.round(st.median*65535)} ADU), max=${(st.max ?? 0).toFixed(4)}`);
        const code = ghsCode(targetName, pass.D, pass.B, sp, pass.LP, pass.HP);
        if (code.startsWith('/*')) { log('      Skipped.'); continue; }
        r = await pjsr(code);
        if (r.status === 'error') { log('      WARN: ' + r.error.message); continue; }
        const stAfter = await getStats(targetName);
        log(`      Post: median=${stAfter.median.toFixed(6)} (${Math.round(stAfter.median*65535)} ADU), max=${(stAfter.max ?? 0).toFixed(4)}`);
        await savePreview(targetName, `rgb_ghs_pass${i+1}`);
      }
    } else {
      // Default: HT auto-stretch then GHS refinement
      log('  8a: AutoStretch (HT)...');
      mainHT = await autoStretch(targetName, strP.targetBg ?? 0.25);
      let postStats = await getStats(targetName);
      log('  Post-stretch median: ' + postStats.median.toFixed(4));

      const ghsPasses = strP.ghsPasses || [];
      if (ghsPasses.length > 0) {
        log('  8b: GHS refinement...');
        for (const pass of ghsPasses) {
          const st = await getStats(targetName);
          const sp = pass.SP ?? st.median;  // allow fixed SP override from config
          log(`    ${pass.label} (D=${pass.D}, SP=${sp.toFixed(4)})...`);
          const mainCode = ghsCode(targetName, pass.D, pass.B, sp, pass.LP, pass.HP);
          if (mainCode.startsWith('/*')) { log('      Skipped.'); continue; }
          r = await pjsr(mainCode);
          log('      ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
        }
      }
    }
    // 8c: Background neutralization — equalize per-channel shadows (RGB only)
    if (strP.neutralizeBg !== false && !lOnlyMode) {
      log('  8c: Background neutralization...');
      const bgR = await pjsr(`
        var w = ImageWindow.windowById('${targetName}');
        var img = w.mainView.image;
        var shadows = [];
        for (var c = 0; c < 3; c++) {
          img.selectedChannel = c;
          var med = img.median();
          var mad = img.MAD();
          shadows.push(Math.max(0, med - 2.8 * mad));
        }
        img.resetSelections();
        JSON.stringify(shadows);
      `);
      try {
        const shadows = JSON.parse(bgR.outputs?.consoleOutput || '[]');
        if (shadows.length === 3) {
          const minS = Math.min(...shadows);
          const strength = strP.neutralizeStrength ?? 0.7;
          const clipR = strength * (shadows[0] - minS);
          const clipG = strength * (shadows[1] - minS);
          const clipB = strength * (shadows[2] - minS);
          log(`    Shadows R=${shadows[0].toFixed(4)} G=${shadows[1].toFixed(4)} B=${shadows[2].toFixed(4)} → clip R-${clipR.toFixed(4)} G-${clipG.toFixed(4)} B-${clipB.toFixed(4)}`);
          if (clipR > 0.001 || clipG > 0.001 || clipB > 0.001) {
            await pjsr(`
              var P = new PixelMath;
              P.expression = 'max(0,$T-${clipR.toFixed(8)})';
              P.expression1 = 'max(0,$T-${clipG.toFixed(8)})';
              P.expression2 = 'max(0,$T-${clipB.toFixed(8)})';
              P.useSingleExpression = false; P.createNewImage = false;
              P.use64BitWorkingImage = true; P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
              P.executeOn(ImageWindow.windowById('${targetName}').mainView);
            `);
            log('    Neutralized.');
          } else {
            log('    Background already neutral.');
          }
        }
      } catch { log('    WARN: Could not parse shadow values.'); }
    }

    await savePreview(targetName, 'stretch');
  } else if (!isEnabled('stretch')) {
    log('\n==== PHASE 8: STRETCH (SKIPPED) ====');
  }

  // ==== PHASE 8b: NON-LINEAR STAR EXTRACTION ====
  // Extract stars from stretched data using SXT with unscreen.
  // Stars are at display brightness — no Seti stretch needed, no bloated halos.
  // SKIP if starMethod=linear (stars were already processed in Phase 7b).
  if (starMethod === 'linear' && starsId) {
    log('\n==== PHASE 8b: NON-LINEAR STAR EXTRACTION (SKIPPED — using linear Seti method) ====');
  } else if (isEnabled('star_stretch') && isEnabled('sxt') && mainHT && !shouldSkip('star_stretch')) {
    const checkpointFile = path.join(CHECKPOINT_DIR, 'checkpoint_sxt_main.xisf');
    if (fs.existsSync(checkpointFile)) {
      log('\n==== PHASE 8b: NON-LINEAR STAR EXTRACTION ====');

      // Open pre-SXT checkpoint (linear RGB with stars)
      const openR2 = await send('open_image', '__internal__', { filePath: checkpointFile });
      if (openR2.status !== 'error') {
        // Close crop masks
        const allImgs2 = await listImages();
        for (const cm of allImgs2.filter(i => i.id.indexOf('crop_mask') >= 0)) {
          await pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
        }

        const tempId = openR2.outputs.id;
        log(`  Loaded pre-SXT image: ${tempId}`);

        // Apply same HT stretch as main image
        log(`  Applying HT (shadows=${mainHT.shadows.toFixed(6)}, midtone=${mainHT.midtone.toFixed(6)})...`);
        await pjsr(`
          var P = new HistogramTransformation;
          P.H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[${mainHT.shadows},${mainHT.midtone},1,0,1],[0,0.5,1,0,1]];
          P.executeOn(ImageWindow.windowById('${tempId}').mainView);
        `);
        log('  HT applied.');

        // Apply same GHS refinement passes as main stretch
        const strP2 = P('stretch');
        const ghsPasses2 = strP2.ghsPasses || [];
        for (const pass of ghsPasses2) {
          const st = await getStats(tempId);
          log(`  GHS: ${pass.label} (D=${pass.D}, SP=${st.median.toFixed(4)})...`);
          r = await pjsr(ghsCode(tempId, pass.D, pass.B, st.median, pass.LP, pass.HP));
          log('    ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
        }

        // SXT with unscreen on the stretched image
        log('  SXT with unscreen...');
        let beforeSxt2 = (await listImages()).map(i => i.id);
        const sxtP2 = P('sxt');
        r = await pjsr(`
          var P = new StarXTerminator; P.stars=true; P.unscreen=true; P.overlap=${sxtP2.overlap ?? 0.10};
          P.executeOn(ImageWindow.windowById('${tempId}').mainView);
        `);
        log('  SXT: ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

        let newStarImgs2 = await detectNewImages(beforeSxt2);
        starsId = newStarImgs2.length > 0 ? newStarImgs2[0].id : null;

        // Close the temp starless (not needed)
        await pjsr(`var w=ImageWindow.windowById('${tempId}');if(!w.isNull)w.forceClose();`);

        if (starsId) {
          liveImages.stars = starsId;
          log(`  Non-linear stars: ${starsId}`);

          // Star saturation
          if (isEnabled('star_saturate')) {
            const starP2 = P('star_saturate');
            await pjsr(`
              var P=new CurvesTransformation;
              P.S=${curveToPJSR(starP2.starSaturationCurve || [[0,0],[0.35,0.55],[0.65,0.85],[1,1]])};
              P.executeOn(ImageWindow.windowById('${starsId}').mainView);
            `);
            log('  Star saturation applied.');
          }

          await savePreview(starsId, 'star_stretch');
        } else {
          log('  WARNING: No star image from SXT unscreen.');
        }
      } else {
        log('  WARN: Could not open checkpoint: ' + (openR2.error?.message || 'unknown'));
      }
      await checkMemory('star_extract_nl');
    } else {
      log('\n==== PHASE 8b: NON-LINEAR STAR EXTRACTION (no checkpoint) ====');
    }
  }

  // ==== PHASE 9: NXT pass 2 ====
  if (isEnabled('nxt_pass2') && !shouldSkip('nxt_pass2')) {
    await maybeCheckpoint('nxt_pass2');
    const nxtP = P('nxt_pass2');
    log('\n==== PHASE 9: NXT pass 2 ====');
    r = await pjsr(`
      var P = new NoiseXTerminator; P.denoise=${nxtP.denoise ?? 0.60}; P.detail=${nxtP.detail ?? 0.15};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(targetName, 'nxt_pass2');
  } else if (!isEnabled('nxt_pass2')) {
    log('\n==== PHASE 9: NXT pass 2 (SKIPPED) ====');
  }

  // ==== PHASE 9a: POST-STRETCH GRADIENT CORRECTION (optional — removes residual gradients visible after stretch) ====
  if (isEnabled('gc_post') && !shouldSkip('gc_post')) {
    const gcPostP = P('gc_post');
    const gcPostMethod = gcPostP.method || 'auto';
    log(`\n==== PHASE 9a: POST-STRETCH GRADIENT CORRECTION (method=${gcPostMethod}) ====`);

    if (gcPostMethod === 'auto') {
      // Compare GC vs ABE on non-linear data (same logic as Phase 2)
      const baseline = await measureUniformity(targetName);
      log(`  Baseline uniformity: ${baseline.score.toFixed(6)} (corners: ${baseline.corners.map(c => c.toFixed(4)).join(', ')})`);
      await cloneImage(targetName, 'gc_post_backup');

      log('  Trying GradientCorrection...');
      await runGC(targetName);
      const gcResult = await measureUniformity(targetName);
      await savePreview(targetName, 'gc_post_gc');
      log(`  GC uniformity: ${gcResult.score.toFixed(6)} (corners: ${gcResult.corners.map(c => c.toFixed(4)).join(', ')})`);

      await restoreFromClone(targetName, 'gc_post_backup');
      const abePolyDeg = gcPostP.abePolyDegree ?? 2;
      const abeTol = gcPostP.abeTolerance ?? 1.0;
      log(`  Trying ABE (polyDegree=${abePolyDeg})...`);
      await runABE(targetName, { polyDegree: abePolyDeg, tolerance: abeTol });
      const abeResult = await measureUniformity(targetName);
      await savePreview(targetName, 'gc_post_abe');
      log(`  ABE(deg${abePolyDeg}) uniformity: ${abeResult.score.toFixed(6)} (corners: ${abeResult.corners.map(c => c.toFixed(4)).join(', ')})`);

      const candidates = [
        { name: 'GC', score: gcResult.score, apply: async () => { await restoreFromClone(targetName, 'gc_post_backup'); await runGC(targetName); } },
        { name: `ABE(deg${abePolyDeg})`, score: abeResult.score, apply: async () => { await restoreFromClone(targetName, 'gc_post_backup'); await runABE(targetName, { polyDegree: abePolyDeg, tolerance: abeTol }); } }
      ];
      candidates.sort((a, b) => a.score - b.score);
      const winner = candidates[0];
      if (winner.score < baseline.score) {
        log(`  === Winner: ${winner.name} (uniformity=${winner.score.toFixed(6)}) ===`);
        await winner.apply();
        await closeImage('gc_post_backup');
        log(`  Applied ${winner.name}.`);
      } else {
        log(`  === No improvement over baseline (best=${winner.score.toFixed(6)} vs baseline=${baseline.score.toFixed(6)}) — skipping ===`);
        await restoreFromClone(targetName, 'gc_post_backup');
        await closeImage('gc_post_backup');
      }
    } else if (gcPostMethod === 'abe') {
      const abePolyDeg = gcPostP.abePolyDegree ?? 2;
      log(`  Running ABE (polyDegree=${abePolyDeg})...`);
      await runABE(targetName, { polyDegree: abePolyDeg, tolerance: gcPostP.abeTolerance ?? 1.0 });
      log('  Done.');
    } else {
      log('  Running GradientCorrection...');
      await runGC(targetName);
      log('  Done.');
    }
    await savePreview(targetName, 'gc_post');
    await checkMemory('gc_post');
  } else if (!isEnabled('gc_post')) {
    log('\n==== PHASE 9a: POST-STRETCH GC (SKIPPED) ====');
  }

  // ==== PHASE 9b: POST-STRETCH SCNR (optional — green removal after stretch) ====
  if (isEnabled('scnr_post') && !shouldSkip('scnr_post')) {
    const scnrPostP = P('scnr_post');
    const scnrPostAmt = scnrPostP.amount ?? 0.50;
    log(`\n==== PHASE 9b: SCNR POST-STRETCH (amount=${scnrPostAmt}) ====`);
    r = await pjsr(`
      var P = new SCNR;
      P.amount = ${scnrPostAmt};
      P.protectionMethod = SCNR.prototype.AverageNeutral;
      P.colorToRemove = SCNR.prototype.Green;
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(targetName, 'scnr_post');
  } else if (!isEnabled('scnr_post')) {
    log('\n==== PHASE 9b: SCNR POST-STRETCH (SKIPPED) ====');
  }

  // ==== PHASE 10: CURVES ====
  if (isEnabled('curves_main') && !shouldSkip('curves_main')) {
    await maybeCheckpoint('curves_main');
    const curP = P('curves_main');
    log('\n==== PHASE 10: CURVES (contrast + saturation) ====');

    log('  10a: Contrast S-curve...');
    await pjsr(`
      var P=new CurvesTransformation;
      P.K=${curveToPJSR(curP.contrastCurve || [[0,0],[0.10,0.06],[0.50,0.55],[0.90,0.95],[1,1]])};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);

    log('  10b: Saturation boost...');
    await pjsr(`
      var P=new CurvesTransformation;
      P.S=${curveToPJSR(curP.saturationCurve || [[0,0],[0.50,0.62],[1,1]])};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    await savePreview(targetName, 'curves_main');
  } else if (!isEnabled('curves_main')) {
    log('\n==== PHASE 10: CURVES (SKIPPED) ====');
  }

  // ==== PHASE 11a: Ha CURVES (Ha branch) ====
  if (isEnabled('ha_curves') && !shouldSkip('ha_curves')) {
    await maybeCheckpoint('ha_curves');
    const haP = P('ha_curves');
    log('\n==== PHASE 11a: Ha CURVES (Ha branch) ====');
    await pjsr(`
      var P=new CurvesTransformation;
      P.K=${curveToPJSR(haP.haCurve || [[0,0],[0.15,0.10],[0.50,0.55],[0.85,0.92],[1,1]])};
      P.executeOn(ImageWindow.windowById('Ha_work').mainView);
    `);
    log('  Done.');
    await savePreview('Ha_work', 'ha_curves');
  } else if (!isEnabled('ha_curves')) {
    log('\n==== PHASE 11a: Ha CURVES (SKIPPED) ====');
  }

  // ==== PHASE 11b: Ha GHS (Ha branch) ====
  if (isEnabled('ha_ghs') && !shouldSkip('ha_ghs')) {
    await maybeCheckpoint('ha_ghs');
    const haP = P('ha_ghs');
    log('\n==== PHASE 11b: Ha GHS (Ha branch) ====');
    const haGHS = haP.haGHS || { D: 0.5, B: -1.0, LP: 0.02, HP: 0.95 };
    const haSt = await getStats('Ha_work');
    r = await pjsr(ghsCode('Ha_work', haGHS.D, haGHS.B, haSt.median, haGHS.LP, haGHS.HP));
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview('Ha_work', 'ha_ghs');
  } else if (!isEnabled('ha_ghs')) {
    log('\n==== PHASE 11b: Ha GHS (SKIPPED) ====');
  }

  // ==== PHASE 11c: Ha LINEARFIT (Ha branch) ====
  if (isEnabled('ha_linearfit') && !shouldSkip('ha_linearfit')) {
    await maybeCheckpoint('ha_linearfit');
    const haP = P('ha_linearfit');
    log('\n==== PHASE 11c: Ha LINEARFIT (Ha branch) ====');
    await pjsr(`
      var P=new PixelMath; P.expression='${targetName}'; P.useSingleExpression=true;
      P.createNewImage=true; P.showNewImage=true; P.newImageId='R_temp';
      P.newImageWidth=${rgbW}; P.newImageHeight=${rgbH};
      P.newImageColorSpace=PixelMath.prototype.Gray; P.newImageSampleFormat=PixelMath.prototype.f32;
      P.executeGlobal();
    `);
    r = await pjsr(`
      var P=new LinearFit; P.referenceViewId='R_temp'; P.rejectLow=0.0; P.rejectHigh=${haP.linearFitRejectHigh ?? 0.92};
      P.executeOn(ImageWindow.windowById('Ha_work').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await pjsr(`var w=ImageWindow.windowById('R_temp');if(!w.isNull)w.forceClose();`);
    await savePreview('Ha_work', 'ha_linearfit');
  } else if (!isEnabled('ha_linearfit')) {
    log('\n==== PHASE 11c: Ha LINEARFIT (SKIPPED) ====');
  }

  // ==== PHASE 11d: Ha INJECTION (Main, merges Ha) ====
  if (isEnabled('ha_inject') && !shouldSkip('ha_inject')) {
    await maybeCheckpoint('ha_inject');
    const haP = P('ha_inject');
    const strength = haP.injectionStrength ?? 0.5;
    const lumBoost = haP.lumBoost ?? 0.0;
    const method = haP.method ?? 'conditional';
    const useMask = haP.useMask ?? false;
    log(`\n==== PHASE 11d: Ha INJECTION (method=${method}, strength=${strength}, lumBoost=${lumBoost}, mask=${useMask}) ====`);

    // Create and apply nebula mask from Ha (protects background during injection)
    let nebulaMaskId = null;
    if (useMask) {
      const maskClipLow = haP.maskClipLow ?? 0.12;
      nebulaMaskId = await createMask('Ha_work', 'mask_nebula', 8, maskClipLow);
      if (nebulaMaskId) {
        await applyMask(targetName, nebulaMaskId, false);  // white = nebula = process
        await savePreview(nebulaMaskId, 'mask_nebula');
      }
    }

    // Part 1: Ha into R channel (skip if lumOnly — preserves original RGB colors entirely)
    if (method !== 'lumOnly' && strength > 0) {
      let rExpr;
      const brightLimit = haP.haBrightnessLimit ?? 1.0; // 1.0 = no limit
      if (method === 'blend') {
        rExpr = `$T*(1-${strength})+Ha_work*${strength}`;
      } else {
        // Conditional — injects Ha where it exceeds threshold*R (lower threshold catches more filaments)
        const tf = haP.haThreshold ?? 0.5;
        if (brightLimit < 1.0) {
          // Ramp down injection in bright areas: full below limit, linearly fades to 0 at pixel=1.0
          rExpr = `$T+${strength}*max(0,Ha_work-${tf}*$T)*max(0,1-max(0,$T-${brightLimit})/(1-${brightLimit}))`;
          log(`  Brightness limit: ${brightLimit} (Ha injection fades in bright areas)`);
        } else {
          rExpr = `$T+${strength}*max(0,Ha_work-${tf}*$T)`;
        }
      }
      r = await pjsr(`
        var P=new PixelMath;
        P.expression='${rExpr}';
        P.expression1='$T'; P.expression2='$T';
        P.useSingleExpression=false; P.createNewImage=false;
        P.use64BitWorkingImage=true; P.truncate=true; P.truncateLower=0; P.truncateUpper=1;
        P.executeOn(ImageWindow.windowById('${targetName}').mainView);
      `);
      log('  R ' + method + ': ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    } else if (method === 'lumOnly') {
      log('  R channel: preserved (lumOnly mode)');
    }

    // Part 2: LRGB combine with Ha as luminance (adds structural detail to all channels)
    if (lumBoost > 0) {
      r = await pjsr(`
        var P=new LRGBCombination;
        P.channelL=[true,'Ha_work'];
        P.channelR=[false,'']; P.channelG=[false,'']; P.channelB=[false,''];
        P.lightness=${lumBoost}; P.saturation=0.50;
        P.noiseReduction=false;
        P.executeOn(ImageWindow.windowById('${targetName}').mainView);
      `);
      log('  Lum boost: ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    }

    // Part 3: Ha detail layer — adds high-frequency Ha structure to ALL channels
    // This preserves color balance while enhancing filamentary detail
    const detailStr = haP.detailLayer ?? 0;
    if (detailStr > 0) {
      // Create blurred copy of Ha, then compute detail = Ha - Blurred, apply to all channels
      r = await pjsr(`
        // Clone Ha_work to Ha_detail_tmp
        var srcW = ImageWindow.windowById('Ha_work');
        var img = srcW.mainView.image;
        var w = img.width, h = img.height;
        var tmpW = new ImageWindow(w, h, 1, 32, false, false, 'Ha_blur_tmp');
        tmpW.mainView.beginProcess();
        tmpW.mainView.image.assign(img);
        tmpW.mainView.endProcess();
        // Blur with large kernel to get low-frequency component
        var C = new Convolution;
        C.mode = Convolution.prototype.Parametric;
        C.sigma = 15; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0;
        C.executeOn(tmpW.mainView);
        tmpW.show();
      `);
      if (r.status !== 'error') {
        // Apply: each channel += detailStr * (Ha_work - Ha_blur_tmp)
        r = await pjsr(`
          var P = new PixelMath;
          P.expression = '$T+${detailStr}*(Ha_work-Ha_blur_tmp)';
          P.useSingleExpression = true; P.createNewImage = false;
          P.use64BitWorkingImage = true; P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(ImageWindow.windowById('${targetName}').mainView);
        `);
        log('  Ha detail layer (str=' + detailStr + '): ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
        // Clean up blur temp
        await pjsr(`var w=ImageWindow.windowById('Ha_blur_tmp');if(!w.isNull)w.forceClose();`);
      } else {
        log('  Ha detail layer: WARN: could not create blur temp');
      }
    }

    // Clean up nebula mask
    if (nebulaMaskId) {
      await removeMask(targetName);
      await closeMask(nebulaMaskId);
    }

    delete liveImages.ha;
    await savePreview(targetName, 'ha_inject');
  } else if (!isEnabled('ha_inject')) {
    log('\n==== PHASE 11d: Ha INJECTION (SKIPPED) ====');
  }

  // ==== PHASE 11e: LRGB COMBINE (Main, merges Lum) ====
  if (isEnabled('lrgb_combine') && !shouldSkip('lrgb_combine')) {
    await maybeCheckpoint('lrgb_combine');
    const lrgbP = P('lrgb_combine');
    log(`\n==== PHASE 11e: LRGB COMBINE (lightness=${lrgbP.lightness ?? 0.50}, saturation=${lrgbP.saturation ?? 0.50}) ====`);

    // Verify L_work exists (saveAs may have renamed it during checkpoint)
    const lCheck = await pjsr(`
      var w = ImageWindow.windowById('L_work');
      JSON.stringify({ exists: !w.isNull });
    `);
    const lExists = JSON.parse(lCheck.outputs?.consoleOutput?.trim() || '{}').exists;
    if (!lExists) {
      // Try to find it by listing all windows
      const allImgs = await listImages();
      const lCandidate = allImgs.find(i => i.id.indexOf('checkpoint') >= 0 && i.id.indexOf('lum') >= 0);
      if (lCandidate) {
        log(`  WARNING: L_work not found, found ${lCandidate.id} — renaming back to L_work`);
        await pjsr(`var w = ImageWindow.windowById('${lCandidate.id}'); if (!w.isNull) w.mainView.id = 'L_work';`);
        liveImages.lum = 'L_work';
      } else {
        log('  WARNING: L_work not found anywhere! LRGB combine will fail.');
      }
    }

    const lrgbLightness = lrgbP.lightness ?? 0.50;
    const lrgbSaturation = lrgbP.saturation ?? 0.50;

    // LinearFit L to RGB luminance — match L background/histogram to RGB before combining.
    // Without this, L's brighter background (e.g. 0.297 vs RGB 0.189) creates a "veil" effect.
    // skipLinearFit: when true, L keeps its native brightness — preserves faint structures like IFN
    if (lrgbP.skipLinearFit) {
      log('  LinearFit: SKIPPED (skipLinearFit=true — L keeps native brightness)');
      const lStats = await getStats('L_work');
      const rgbStats = await getStats(targetName);
      log(`  L_median=${lStats.median.toFixed(4)} RGB_median=${rgbStats.median.toFixed(4)}`);
    } else {
    log('  LinearFit: matching L_work to RGB luminance...');
    // Extract CIE Y luminance from RGB as reference
    const fitR = await pjsr(`
      // Create temporary luminance image from RGB
      var P = new PixelMath;
      P.expression = '0.2126*${targetName}[0]+0.7152*${targetName}[1]+0.0722*${targetName}[2]';
      P.useSingleExpression = true;
      P.createNewImage = true; P.showNewImage = true;
      P.newImageId = '__lrgb_ref_Y__';
      var tgt = ImageWindow.windowById('${targetName}');
      P.newImageWidth = tgt.mainView.image.width;
      P.newImageHeight = tgt.mainView.image.height;
      P.newImageColorSpace = PixelMath.prototype.Gray;
      P.newImageSampleFormat = PixelMath.prototype.f32;
      P.executeGlobal();
      // LinearFit L to this reference
      var LF = new LinearFit;
      LF.referenceViewId = '__lrgb_ref_Y__';
      LF.rejectHigh = ${lrgbP.linearFitRejectHigh ?? 0.92};
      LF.rejectLow = 0.00;
      var ret = LF.executeOn(ImageWindow.windowById('L_work').mainView);
      // Get stats after fit
      var L = ImageWindow.windowById('L_work').mainView.image;
      var R = ImageWindow.windowById('__lrgb_ref_Y__').mainView.image;
      var info = 'L_median=' + L.median().toFixed(4) + ' ref_Y_median=' + R.median().toFixed(4);
      // Clean up reference
      ImageWindow.windowById('__lrgb_ref_Y__').forceClose();
      info;
    `);
    log('  ' + (fitR.outputs?.consoleOutput?.trim() || fitR.error?.message || 'Done'));
    } // end else (LinearFit)

    r = await pjsr(`
      var P = new LRGBCombination;
      P.channelL = [true, 'L_work'];
      P.channelR = [false, '']; P.channelG = [false, '']; P.channelB = [false, ''];
      P.lightness = ${lrgbLightness};
      P.saturation = ${lrgbSaturation};
      P.noiseReduction = false;
      var ret = P.executeOn(ImageWindow.windowById('${targetName}').mainView);
      ret ? 'LRGB_OK' : 'LRGB_FAILED';
    `);
    const lrgbOut = r.outputs?.consoleOutput?.trim() || '';
    if (r.status === 'error' || lrgbOut.includes('LRGB_FAILED')) {
      log('  WARNING: LRGBCombination failed — using PixelMath luminance transfer fallback');
      // PixelMath fallback: transfer luminance from L_work to RGB via CIE Y ratio scaling
      const Y = `(0.2126*${targetName}[0]+0.7152*${targetName}[1]+0.0722*${targetName}[2])`;
      const Yblend = `(${Y}*(1-${lrgbLightness})+L_work*${lrgbLightness})`;
      const expr = `$T*max(${Yblend},0.00001)/max(${Y},0.00001)`;
      r = await pjsr(`
        var P = new PixelMath;
        P.expression = '${expr}';
        P.useSingleExpression = true;
        P.createNewImage = false; P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.executeOn(ImageWindow.windowById('${targetName}').mainView);
      `);
      log('  PixelMath L transfer: ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    } else {
      log('  Done.');
    }
    // Auto-histogram: bring background down to target after strong L blend
    const autoHistTarget = lrgbP.autoHistTarget;
    if (autoHistTarget && autoHistTarget > 0) {
      const preStats = await getStats(targetName);
      const med = preStats.median;
      const tgt = autoHistTarget;
      if (med > tgt) {
        // Compute MTF midtone that maps current median to target
        // MTF(m, x) = (m-1)*x / ((2m-1)*x - m), we want MTF(m, med) = tgt
        // Solving: m = med*(tgt-1) / (2*tgt*med - tgt - med)
        const m = med * (tgt - 1) / (2 * tgt * med - tgt - med);
        log(`  Auto-histogram: median=${med.toFixed(4)} → target=${tgt} (midtone=${m.toFixed(4)})`);
        const htExpr = `(${n(m - 1)}*$T)/((${n(2*m - 1)})*$T+(${n(-m)}))`;
        const htR = await pjsr(`
          var P = new PixelMath; P.expression = '${htExpr}'; P.useSingleExpression = true;
          P.createNewImage = false; P.use64BitWorkingImage = true;
          P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
          P.executeOn(ImageWindow.windowById('${targetName}').mainView);
        `);
        const postStats = await getStats(targetName);
        log(`  Auto-histogram: median now ${postStats.median.toFixed(4)} (was ${med.toFixed(4)})`);
      } else {
        log(`  Auto-histogram: median=${med.toFixed(4)} already below target=${tgt}, skipped`);
      }
    }
    // Close L_work — no longer needed after LRGB combine (frees ~90MB + undo history)
    await closeLiveImage('lum');
    // Purge undo history on main image to free memory before mask-heavy phases
    await purgeUndoHistory(targetName);
    await savePreview(targetName, 'lrgb_combine');
    await checkMemory('lrgb_combine');
  } else if (!isEnabled('lrgb_combine')) {
    log('\n==== PHASE 11e: LRGB COMBINE (SKIPPED) ====');
  }

  // ==== PHASE 11e2: SHADOW LIFT (IFN — targeted lightness curve to reveal faint structures) ====
  if (isEnabled('shadow_lift') && !shouldSkip('shadow_lift')) {
    const slP = P('shadow_lift');
    const slCurve = slP.lightnessCurve || [[0,0],[0.15,0.18],[0.50,0.50],[1,1]];
    log(`\n==== PHASE 11e2: SHADOW LIFT (IFN) ====`);
    log(`  Lightness curve: ${JSON.stringify(slCurve)}`);
    const preStats = await getStats(targetName);
    log(`  Pre: median=${preStats.median.toFixed(4)}`);
    // Apply lightness curve via CurvesTransformation on L channel (CIELab lightness)
    r = await pjsr(`
      var P = new CurvesTransformation;
      P.L = ${curveToPJSR(slCurve)};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    const postStats = await getStats(targetName);
    log(`  Post: median=${postStats.median.toFixed(4)}`);
    await savePreview(targetName, 'shadow_lift');
  }

  // ==== PHASE 11e3: LHE LARGE (structural tonal separation — arm vs interarm) ====
  if (isEnabled('lhe_large') && !shouldSkip('lhe_large')) {
    const lheLgP = P('lhe_large');
    const radiusLg = lheLgP.radius ?? 128;
    const amountLg = lheLgP.amount ?? 0.30;
    const slopeLimitLg = lheLgP.slopeLimit ?? 1.5;
    log(`\n==== PHASE 11e3: LHE LARGE (radius=${radiusLg}, amount=${amountLg}, slopeLimit=${slopeLimitLg}) ====`);

    let lheLgMaskId = null;
    const haOpenLg = await pjsr(`ImageWindow.windowById('Ha_work').isNull ? 'no' : 'yes';`);
    if (haOpenLg.outputs?.consoleOutput?.trim() === 'yes') {
      lheLgMaskId = await createMask('Ha_work', 'mask_lhe_large', lheLgP.maskBlur ?? 6, lheLgP.maskClipLow ?? 0.10);
    } else {
      lheLgMaskId = await createLumMask(targetName, 'mask_lhe_large', lheLgP.maskBlur ?? 6, lheLgP.maskClipLow ?? 0.10, lheLgP.maskGamma ?? 2.0);
    }
    if (lheLgMaskId) {
      await applyMask(targetName, lheLgMaskId, false);
    }

    r = await pjsr(`
      var P = new LocalHistogramEqualization;
      P.radius = ${radiusLg};
      P.histogramBins = LocalHistogramEqualization.prototype.Bit12;
      P.slopeLimit = ${slopeLimitLg};
      P.amount = ${amountLg};
      P.circularKernel = true;
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

    if (lheLgMaskId) {
      await removeMask(targetName);
      await closeMask(lheLgMaskId);
    }
    await savePreview(targetName, 'lhe_large');
  } else if (!isEnabled('lhe_large')) {
    log('\n==== PHASE 11e3: LHE LARGE (SKIPPED) ====');
  }

  // ==== PHASE 11f: LHE (Local Histogram Equalization — tonal separation) ====
  if (isEnabled('lhe') && !shouldSkip('lhe')) {
    const lheP = P('lhe');
    const radius = lheP.radius ?? 64;
    const amount = lheP.amount ?? 0.70;
    const slopeLimit = lheP.slopeLimit ?? 2.0;
    log(`\n==== PHASE 11f: LHE (radius=${radius}, amount=${amount}, slopeLimit=${slopeLimit}) ====`);

    // Create nebula mask from Ha (protects background, targets nebula structure)
    // Ha_work is still open (starless, stretched Ha) — perfect mask source
    let lheMaskId = null;
    const haStillOpen = await pjsr(`ImageWindow.windowById('Ha_work').isNull ? 'no' : 'yes';`);
    if (haStillOpen.outputs?.consoleOutput?.trim() === 'yes') {
      lheMaskId = await createMask('Ha_work', 'mask_lhe', lheP.maskBlur ?? 5, lheP.maskClipLow ?? 0.12);
    } else {
      // Fallback: luminance mask from main image
      lheMaskId = await createLumMask(targetName, 'mask_lhe', lheP.maskBlur ?? 5, lheP.maskClipLow ?? 0.12, lheP.maskGamma ?? 2.0);
    }
    if (lheMaskId) {
      await applyMask(targetName, lheMaskId, false);  // white = nebula = process
      await savePreview(lheMaskId, 'mask_lhe');
    }

    r = await pjsr(`
      var P = new LocalHistogramEqualization;
      P.radius = ${radius};
      P.histogramBins = LocalHistogramEqualization.prototype.Bit12;
      P.slopeLimit = ${slopeLimit};
      P.amount = ${amount};
      P.circularKernel = true;
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

    if (lheMaskId) {
      await removeMask(targetName);
      await closeMask(lheMaskId);
    }
    await purgeUndoHistory(targetName);
    await savePreview(targetName, 'lhe');
    await checkMemory('lhe');
  } else if (!isEnabled('lhe')) {
    log('\n==== PHASE 11f: LHE (SKIPPED) ====');
  }

  // ==== PHASE 11g: LHE FINE (smaller radius for micro-contrast / tonal separation) ====
  if (isEnabled('lhe_fine') && !shouldSkip('lhe_fine')) {
    const lheP2 = P('lhe_fine');
    const radius2 = lheP2.radius ?? 24;
    const amount2 = lheP2.amount ?? 0.50;
    const slopeLimit2 = lheP2.slopeLimit ?? 1.5;
    log(`\n==== PHASE 11g: LHE FINE (radius=${radius2}, amount=${amount2}, slopeLimit=${slopeLimit2}) ====`);

    // Reuse Ha nebula mask if available, else luminance mask
    let lheFMaskId = null;
    const haOpen2 = await pjsr(`ImageWindow.windowById('Ha_work').isNull ? 'no' : 'yes';`);
    if (haOpen2.outputs?.consoleOutput?.trim() === 'yes') {
      lheFMaskId = await createMask('Ha_work', 'mask_lhe_fine', lheP2.maskBlur ?? 3, lheP2.maskClipLow ?? 0.15);
    } else {
      lheFMaskId = await createLumMask(targetName, 'mask_lhe_fine', lheP2.maskBlur ?? 3, lheP2.maskClipLow ?? 0.15, lheP2.maskGamma ?? 1.5);
    }
    if (lheFMaskId) {
      await applyMask(targetName, lheFMaskId, false);
    }

    r = await pjsr(`
      var P = new LocalHistogramEqualization;
      P.radius = ${radius2};
      P.histogramBins = LocalHistogramEqualization.prototype.Bit12;
      P.slopeLimit = ${slopeLimit2};
      P.amount = ${amount2};
      P.circularKernel = true;
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

    if (lheFMaskId) {
      await removeMask(targetName);
      await closeMask(lheFMaskId);
    }
    await savePreview(targetName, 'lhe_fine');
  } else if (!isEnabled('lhe_fine')) {
    log('\n==== PHASE 11g: LHE FINE (SKIPPED) ====');
  }

  // ==== PHASE 11h: HDR MULTISCALE TRANSFORM (core micro-contrast) ====
  if (isEnabled('hdrmt') && !shouldSkip('hdrmt')) {
    const hdrmtP = P('hdrmt');
    const nLayers = hdrmtP.numberOfLayers ?? 6;
    const nIter = hdrmtP.numberOfIterations ?? 1;
    const toL = hdrmtP.toLightness !== false;
    const hdrmtClipLow = hdrmtP.maskClipLow ?? 0.10;
    log(`\n==== PHASE 11h: HDRMT (layers=${nLayers}, iterations=${nIter}, toLightness=${toL}) ====`);

    // Apply with nebula mask (protect background from HDRMT artifacts)
    let hdrmtMaskId = null;
    const haOpen3 = await pjsr(`ImageWindow.windowById('Ha_work').isNull ? 'no' : 'yes';`);
    if (haOpen3.outputs?.consoleOutput?.trim() === 'yes') {
      hdrmtMaskId = await createMask('Ha_work', 'mask_hdrmt', hdrmtP.maskBlur ?? 5, hdrmtClipLow);
    } else {
      hdrmtMaskId = await createLumMask(targetName, 'mask_hdrmt', hdrmtP.maskBlur ?? 5, hdrmtClipLow, hdrmtP.maskGamma ?? 1.5);
    }
    if (hdrmtMaskId) {
      await applyMask(targetName, hdrmtMaskId, false);
    }

    r = await pjsr(`
      var P = new HDRMultiscaleTransform;
      P.numberOfLayers = ${nLayers};
      P.numberOfIterations = ${nIter};
      P.invertedIterations = ${hdrmtP.inverted ?? false};
      P.overdrive = 0;
      P.medianTransform = ${hdrmtP.medianTransform ? 'true' : 'false'};
      P.toLightness = ${toL};
      P.preserveHue = ${hdrmtP.preserveHue ? 'true' : 'false'};
      P.luminanceMask = ${hdrmtP.luminanceMask ?? true};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

    if (hdrmtMaskId) {
      await removeMask(targetName);
      await closeMask(hdrmtMaskId);
    }
    await purgeUndoHistory(targetName);
    await savePreview(targetName, 'hdrmt');
    await checkMemory('hdrmt');
  } else if (!isEnabled('hdrmt')) {
    log('\n==== PHASE 11h: HDRMT (SKIPPED) ====');
  }

  // ==== PHASE 11h2: HDRMT FINE (fine-scale core detail — 3 layers, 1 iteration) ====
  if (isEnabled('hdrmt_fine') && !shouldSkip('hdrmt_fine')) {
    const hdrmtFP = P('hdrmt_fine');
    const nLayersF = hdrmtFP.numberOfLayers ?? 3;
    const nIterF = hdrmtFP.numberOfIterations ?? 1;
    const toL_F = hdrmtFP.toLightness !== false;
    const hdrmtFClipLow = hdrmtFP.maskClipLow ?? 0.30;
    log(`\n==== PHASE 11h2: HDRMT FINE (layers=${nLayersF}, iterations=${nIterF}, toLightness=${toL_F}) ====`);

    let hdrmtFMaskId = null;
    const haOpenF = await pjsr(`ImageWindow.windowById('Ha_work').isNull ? 'no' : 'yes';`);
    if (haOpenF.outputs?.consoleOutput?.trim() === 'yes') {
      hdrmtFMaskId = await createMask('Ha_work', 'mask_hdrmt_fine', hdrmtFP.maskBlur ?? 4, hdrmtFClipLow);
    } else {
      hdrmtFMaskId = await createLumMask(targetName, 'mask_hdrmt_fine', hdrmtFP.maskBlur ?? 4, hdrmtFClipLow, hdrmtFP.maskGamma ?? 2.0);
    }
    if (hdrmtFMaskId) {
      await applyMask(targetName, hdrmtFMaskId, false);
    }

    r = await pjsr(`
      var P = new HDRMultiscaleTransform;
      P.numberOfLayers = ${nLayersF};
      P.numberOfIterations = ${nIterF};
      P.invertedIterations = ${hdrmtFP.inverted ?? false};
      P.overdrive = 0;
      P.medianTransform = ${hdrmtFP.medianTransform ? 'true' : 'false'};
      P.toLightness = ${toL_F};
      P.preserveHue = ${hdrmtFP.preserveHue ? 'true' : 'false'};
      P.luminanceMask = ${hdrmtFP.luminanceMask ?? true};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

    if (hdrmtFMaskId) {
      await removeMask(targetName);
      await closeMask(hdrmtFMaskId);
    }
    await purgeUndoHistory(targetName);
    await savePreview(targetName, 'hdrmt_fine');
    await checkMemory('hdrmt_fine');
  } else if (!isEnabled('hdrmt_fine')) {
    log('\n==== PHASE 11h2: HDRMT FINE (SKIPPED) ====');
  }

  // ==== PHASE 11i: FINAL NXT (clean up noise amplified by LHE/HDRMT/curves) ====
  if (isEnabled('nxt_final') && !shouldSkip('nxt_final')) {
    const nxtFP = P('nxt_final');
    const nxtFDenoise = nxtFP.denoise ?? 0.35;
    const nxtFDetail = nxtFP.detail ?? 0.15;
    log(`\n==== PHASE 11i: NXT FINAL (denoise=${nxtFDenoise}, detail=${nxtFDetail}) ====`);
    r = await pjsr(`
      var P = new NoiseXTerminator;
      P.denoise = ${nxtFDenoise}; P.detail = ${nxtFDetail};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await purgeUndoHistory(targetName);
    await savePreview(targetName, 'nxt_final');
    await checkMemory('nxt_final');
  } else if (!isEnabled('nxt_final')) {
    log('\n==== PHASE 11i: NXT FINAL (SKIPPED) ====');
  }

  // ==== PHASE 12: FINAL CURVES ====
  if (isEnabled('curves_final') && !shouldSkip('curves_final')) {
    await maybeCheckpoint('curves_final');
    const curP = P('curves_final');
    log('\n==== PHASE 12: FINAL CURVES ====');
    log('  Gentle lightness/color refinement...');
    await pjsr(`
      var P=new CurvesTransformation;
      P.K=${curveToPJSR(curP.lightnessCurve || [[0,0],[0.15,0.12],[0.50,0.52],[0.85,0.88],[1,1]])};
      P.S=${curveToPJSR(curP.saturationCurve || [[0,0],[0.45,0.52],[1,1]])};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    // Per-channel boost (e.g., blue boost for pink/magenta tones)
    const chanBoost = curP.channelBoost;
    if (chanBoost) {
      const bR = chanBoost.R ?? 1.0, bG = chanBoost.G ?? 1.0, bB = chanBoost.B ?? 1.0;
      log(`  Channel boost: R×${bR} G×${bG} B×${bB}...`);
      await pjsr(`
        var P=new PixelMath;
        P.expression='$T*${bR}'; P.expression1='$T*${bG}'; P.expression2='$T*${bB}';
        P.useSingleExpression=false; P.createNewImage=false;
        P.use64BitWorkingImage=true; P.truncate=true; P.truncateLower=0; P.truncateUpper=1;
        P.executeOn(ImageWindow.windowById('${targetName}').mainView);
      `);
    }
    log('  Done.');
    await savePreview(targetName, 'curves_final');
  } else if (!isEnabled('curves_final')) {
    log('\n==== PHASE 12: FINAL CURVES (SKIPPED) ====');
  }

  // ==== PHASE 12a0: GALAXY BRIGHTEN (spatial mask + gamma boost) ====
  // Two-stage mask: (1) binary seed from bright pixels, (2) huge Gaussian blur to spread
  // spatially, (3) rescale amplification so the galaxy halo gets meaningful mask values.
  // This covers the full galaxy+halo while keeping background at zero.
  if (isEnabled('galaxy_brighten') && !shouldSkip('galaxy_brighten')) {
    const gbP = P('galaxy_brighten');
    const gbBoostGamma = gbP.boostGamma ?? 2.0;
    const gbClipLow = gbP.maskClipLow ?? 0.20;
    const gbBlur = gbP.maskBlur ?? 80;
    const gbRescale = gbP.maskRescale ?? 3.0;
    log(`\n==== PHASE 12a0: GALAXY BRIGHTEN (gamma=${gbBoostGamma}, maskClip=${gbClipLow}, blur=${gbBlur}, rescale=${gbRescale}) ====`);

    // Step 1: Create spatial mask — binary seed → huge blur → rescale amplification
    const dimR2 = await pjsr(`
      var srcW = ImageWindow.windowById('${targetName}');
      var img = srcW.mainView.image;
      JSON.stringify({ w: Math.round(img.width), h: Math.round(img.height), color: img.isColor });
    `);
    const dims2 = JSON.parse(dimR2.outputs?.consoleOutput?.trim() || '{}');
    const lumExpr2 = dims2.color
      ? `0.2126*${targetName}[0]+0.7152*${targetName}[1]+0.0722*${targetName}[2]`
      : targetName;

    await pjsr(`
      var old = ImageWindow.windowById('mask_galaxy_bright');
      if (!old.isNull) old.forceClose();
      var mw = new ImageWindow(${dims2.w}, ${dims2.h}, 1, 32, true, false, 'mask_galaxy_bright');
      mw.show();
      // Stage 1: Binary seed — bright pixels = 1, everything else = 0
      var PM = new PixelMath;
      PM.expression = 'iif(${lumExpr2}<${gbClipLow},0,1)';
      PM.useSingleExpression = true;
      PM.createNewImage = false;
      PM.executeOn(mw.mainView);
      // Stage 2: Large Gaussian blur — spreads seed spatially following galaxy shape
      var C = new Convolution;
      C.mode = Convolution.prototype.Parametric;
      C.sigma = ${gbBlur};
      C.shape = 2;
      C.aspectRatio = 1;
      C.rotationAngle = 0;
      C.executeOn(mw.mainView);
      // Stage 3: Rescale amplification — boosts mask so halo region gets meaningful values
      // e.g. rescale=3: halo at 0.15 → 0.45, background at 0.02 → 0.06 (still negligible)
      var PM2 = new PixelMath;
      PM2.expression = 'min(1, mask_galaxy_bright * ${gbRescale})';
      PM2.useSingleExpression = true;
      PM2.createNewImage = false;
      PM2.executeOn(mw.mainView);
      'OK';
    `);
    log(`  [mask] Created spatial mask mask_galaxy_bright (clipLow=${gbClipLow}, blur=${gbBlur}, rescale=${gbRescale})`);
    await applyMask(targetName, 'mask_galaxy_bright', false);
    await savePreview('mask_galaxy_bright', 'mask_galaxy_bright');

    // Step 2: Gamma boost via PixelMath (preserves color ratios)
    const preStats = await getStats(targetName);
    log(`  Pre: median=${preStats.median.toFixed(4)}`);
    const invGamma = (1.0 / gbBoostGamma).toFixed(6);
    log(`  Gamma: ${gbBoostGamma} (inv=${invGamma})`);
    log(`  Example: pixel 0.10 → ${Math.pow(0.10, 1/gbBoostGamma).toFixed(3)}, 0.25 → ${Math.pow(0.25, 1/gbBoostGamma).toFixed(3)}, 0.50 → ${Math.pow(0.50, 1/gbBoostGamma).toFixed(3)}`);

    const Y = '(0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2])';
    const Ynew = `exp(${invGamma}*ln(max(${Y},0.00001)))`;
    const scale = `(${Ynew})/max(${Y},0.00001)`;
    const exprR = `min($T[0]*${scale},1)`;
    const exprG = `min($T[1]*${scale},1)`;
    const exprB = `min($T[2]*${scale},1)`;

    r = await pjsr(`
      var PM = new PixelMath;
      PM.expression = '${exprR}';
      PM.expression1 = '${exprG}';
      PM.expression2 = '${exprB}';
      PM.useSingleExpression = false;
      PM.createNewImage = false;
      PM.use64BitWorkingImage = true;
      PM.truncate = true;
      PM.truncateLower = 0;
      PM.truncateUpper = 1;
      PM.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    const postStats = await getStats(targetName);
    log(`  Post: median=${postStats.median.toFixed(4)} (delta=${(postStats.median - preStats.median).toFixed(4)})`);

    // Clean up mask
    await removeMask(targetName);
    await closeMask('mask_galaxy_bright');
    await purgeUndoHistory(targetName);
    await savePreview(targetName, 'galaxy_brighten');
  } else if (!isEnabled('galaxy_brighten')) {
    log('\n==== PHASE 12a0: GALAXY BRIGHTEN (SKIPPED) ====');
  }

  // ==== PHASE 12a: GALAXY SATURATION (masked — boosts color in bright structures only) ====
  if (isEnabled('galaxy_saturate') && !shouldSkip('galaxy_saturate')) {
    const gsP = P('galaxy_saturate');
    const gsClipLow = gsP.maskClipLow ?? 0.12;
    const gsBlur = gsP.maskBlur ?? 8;
    const gsSatCurve = gsP.saturationCurve || [[0,0],[0.50,0.70],[1,1]];
    log(`\n==== PHASE 12a: GALAXY SATURATION (masked, clipLow=${gsClipLow}) ====`);

    // Create luminance mask — bright regions (galaxies) white, background black
    let gsMaskId = await createLumMask(targetName, 'mask_galaxy_sat', gsBlur, gsClipLow);
    if (gsMaskId) {
      await applyMask(targetName, gsMaskId, false); // white = galaxies = process
      await savePreview(gsMaskId, 'mask_galaxy_sat');
    }

    // Apply saturation curve through the mask
    log(`  Saturation curve: ${JSON.stringify(gsSatCurve)}`);
    r = await pjsr(`
      var P = new CurvesTransformation;
      P.S = ${curveToPJSR(gsSatCurve)};
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

    // Clean up mask
    await removeMask(targetName);
    await closeMask(gsMaskId);
    await purgeUndoHistory(targetName);
    await savePreview(targetName, 'galaxy_saturate');
  } else if (!isEnabled('galaxy_saturate')) {
    log('\n==== PHASE 12a: GALAXY SATURATION (SKIPPED) ====');
  }

  // ==== PHASE 12a2: HUE-SELECTIVE SATURATION BOOST ====
  if (isEnabled('hue_boost') && !shouldSkip('hue_boost')) {
    const hbP = P('hue_boost');
    const blueBoost = hbP.blueBoost ?? 1.0;
    const pinkBoost = hbP.pinkBoost ?? 1.0;
    const hbClipLow = hbP.maskClipLow ?? 0.10;
    const hbBlur = hbP.maskBlur ?? 8;
    log(`\n==== PHASE 12a2: HUE-SELECTIVE SATURATION (blue×${blueBoost}, pink×${pinkBoost}) ====`);

    // Create luminance mask (same as galaxy saturation — only process bright structures)
    let hbMaskId = await createLumMask(targetName, 'mask_hue_boost', hbBlur, hbClipLow);
    if (hbMaskId) {
      await applyMask(targetName, hbMaskId, false);
    }

    // PixelMath: selectively boost saturation for blue-ish and pink-ish pixels
    // Blue: B channel dominant (B > R*1.05 and B > G*1.05)
    // Pink: R and B both higher than G (R > G*1.1 and B > G*0.9)
    // Formula: lum + factor*(channel - lum)  where factor > 1 boosts saturation
    // factor = 1 + isBlue*(blueBoost-1) + isPink*(pinkBoost-1)
    const lum = '(0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2])';
    const isBlue = 'iif($T[2]>$T[0]*1.05&&$T[2]>$T[1]*1.05,1,0)';
    const isPink = 'iif($T[0]>$T[1]*1.1&&$T[2]>$T[1]*0.9&&$T[0]>0.08,1,0)';
    const factor = `(1+${isBlue}*${(blueBoost - 1).toFixed(4)}+${isPink}*${(pinkBoost - 1).toFixed(4)})`;
    const expr_R = `max(${lum}+${factor}*($T[0]-${lum}),0)`;
    const expr_G = `max(${lum}+${factor}*($T[1]-${lum}),0)`;
    const expr_B = `max(${lum}+${factor}*($T[2]-${lum}),0)`;

    log(`  Expressions: factor=${factor.substring(0, 60)}...`);

    r = await pjsr(`
      var PM = new PixelMath;
      PM.expression = '${expr_R}';
      PM.expression1 = '${expr_G}';
      PM.expression2 = '${expr_B}';
      PM.useSingleExpression = false;
      PM.createNewImage = false;
      PM.truncate = true;
      PM.truncateLower = 0;
      PM.truncateUpper = 1;
      PM.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

    if (hbMaskId) {
      await removeMask(targetName);
      await closeMask(hbMaskId);
    }
    await savePreview(targetName, 'hue_boost');
  } else if (!isEnabled('hue_boost')) {
    log('\n==== PHASE 12a2: HUE-SELECTIVE SATURATION (SKIPPED) ====');
  }

  // ==== PHASE 12_bg: BACKGROUND NEUTRALIZE ====
  // Forces deep background pixels toward neutral (R=G=B=Y) with smooth transition
  // Runs AFTER galaxy_saturate and hue_boost so nothing re-introduces color to background
  if (isEnabled('bg_neutralize') && !shouldSkip('bg_neutralize')) {
    const bnP = P('bg_neutralize');
    const bnThresh = bnP.threshold ?? 0.06;
    const bnTrans = bnP.transition ?? 0.04;
    log(`\n==== PHASE 12_bg: BACKGROUND NEUTRALIZE (threshold=${bnThresh}, transition=${bnTrans}) ====`);
    // Y = luminance, f = blend factor (0=neutralize, 1=keep original)
    // Dark pixels (Y < threshold-transition): fully neutralized to Y
    // Bright pixels (Y > threshold): keep original color
    const Y = '(0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2])';
    const f = `max(0,min(1,(${Y}-${bnThresh})/${bnTrans}))`;
    const exprR = `$T[0]*${f}+${Y}*(1-${f})`;
    const exprG = `$T[1]*${f}+${Y}*(1-${f})`;
    const exprB = `$T[2]*${f}+${Y}*(1-${f})`;
    log(`  Expressions built (Y threshold=${bnThresh}, transition width=${bnTrans})`);
    await pjsr(`
      var P=new PixelMath;
      P.expression='${exprR}';
      P.expression1='${exprG}';
      P.expression2='${exprB}';
      P.useSingleExpression=false;
      P.createNewImage=false;
      P.use64BitWorkingImage=true;
      P.truncate=true;P.truncateLower=0;P.truncateUpper=1;
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  Done.');
    await savePreview(targetName, 'bg_neutralize');
    await checkMemory('bg_neutralize');
  } else if (!isEnabled('bg_neutralize')) {
    log('\n==== PHASE 12_bg: BACKGROUND NEUTRALIZE (SKIPPED) ====');
  }

  // ==== PHASE 12b: STAR REDUCTION (remove smallest stars via threshold + morphological erosion) ====
  if (isEnabled('star_reduce') && starsId && !shouldSkip('star_reduce')) {
    const srP = P('star_reduce');
    const threshold = srP.threshold ?? 0.06;
    const erosionSize = srP.erosionSize ?? 3;
    const erosionAmount = srP.erosionAmount ?? 0.60;
    const iterations = srP.iterations ?? 1;
    log(`\n==== PHASE 12b: STAR REDUCTION (threshold=${threshold}, erosion=${erosionSize}px, amount=${erosionAmount}) ====`);

    // Step 1: Threshold — zero out faintest stars (where max channel < threshold)
    r = await pjsr(`
      var P = new PixelMath;
      P.expression = 'iif(max($T[0],$T[1],$T[2])<${threshold},0,$T)';
      P.useSingleExpression = true; P.createNewImage = false;
      P.use64BitWorkingImage = true; P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
      P.executeOn(ImageWindow.windowById('${starsId}').mainView);
    `);
    log('  Threshold: ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));

    // Step 2: Morphological erosion — shrink remaining small stars
    if (erosionAmount > 0) {
      r = await pjsr(`
        var P = new MorphologicalTransformation;
        P.operator = MorphologicalTransformation.prototype.Erosion;
        P.interlacingDistance = 1;
        P.numberOfIterations = ${iterations};
        P.amount = ${erosionAmount};
        P.selectionPoint = 0.50;
        P.structureSize = ${erosionSize};
        P.executeOn(ImageWindow.windowById('${starsId}').mainView);
      `);
      log('  Erosion: ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    }

    await savePreview(starsId, 'star_reduce');
  } else if (!isEnabled('star_reduce')) {
    log('\n==== PHASE 12b: STAR REDUCTION (SKIPPED) ====');
  }

  // ==== PHASE 13: STAR ADDITION (Main, merges Stars) ====
  if (isEnabled('star_add') && starsId && !shouldSkip('star_add')) {
    await maybeCheckpoint('star_add');
    const starP = P('star_add');
    const starStrength = starP.starStrength ?? 1.00;
    const useScreen = starP.screenBlend !== false;
    const blendLabel = useScreen ? 'screen blend' : 'addition';
    log(`\n==== PHASE 13: STAR ADDITION (${blendLabel}, strength=${starStrength}) ====`);
    const starExpr = useScreen
      ? `~(~$T*~(${starStrength}*${starsId}))` // screen blend: 1-(1-$T)*(1-s*stars)
      : `$T+${starStrength}*${starsId}`;        // simple addition
    r = await pjsr(`
      var P=new PixelMath; P.expression='${starExpr}';
      P.useSingleExpression=true; P.createNewImage=false;
      P.use64BitWorkingImage=true; P.truncate=true; P.truncateLower=0; P.truncateUpper=1;
      P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    // Close stars image — no longer needed (frees ~300MB + undo history)
    await closeLiveImage('stars');
    await purgeUndoHistory(targetName);
    await savePreview(targetName, 'star_add');
  } else if (isEnabled('star_add') && !shouldSkip('star_add') && !starsId) {
    log('\n==== PHASE 13: STAR ADDITION ====');
    log('  No stars to add.');
  } else if (!isEnabled('star_add')) {
    log('\n==== PHASE 13: STAR ADDITION (SKIPPED) ====');
  }

  // ==== PHASE 14: SAVE & CLEANUP ====
  log('\n==== PHASE 14: SAVE & CLEANUP ====');
  const outputDir = F.outputDir || '/tmp/pipeline-output';
  const suffix = lOnlyMode ? '_L' : (hasHa ? (hasL ? '_HaLRGB' : '_HaRGB') : (hasL ? '_LRGB' : '_RGB'));
  // Extract iteration number from config name (e.g., "Iteration 22" → "22", "v10" → "10")
  const iterMatch = (CFG.name || '').match(/(?:Iteration\s+|\bv)(\d+[a-z]?)/i);
  const iterNum = iterMatch ? iterMatch[1].padStart(2, '0') : null;
  // Primary output: iteration-numbered if available, otherwise timestamped
  const outputPath = iterNum
    ? `${outputDir}/iteration_${iterNum}.xisf`
    : `${outputDir}/${targetName}${suffix}.xisf`;
  // Also save a "latest" symlink copy
  const latestPath = `${outputDir}/${targetName}${suffix}.xisf`;
  var esc = s => s.replace(/'/g, "\\'");
  r = await pjsr(`
    var dir='${esc(outputDir)}';
    if(!File.directoryExists(dir)) File.createDirectory(dir,true);
    var w=ImageWindow.windowById('${targetName}');
    var p='${esc(outputPath)}';
    if(File.exists(p)) File.remove(p);
    w.saveAs(p,false,false,false,false);
    var latest='${esc(latestPath)}';
    if(latest!==p){if(File.exists(latest)) File.remove(latest);File.copyFile(latest, p);}
    var all=ImageWindow.windows;
    for(var i=all.length-1;i>=0;i--){
      if(all[i].mainView.id!=='${targetName}'){all[i].forceClose();}
      processEvents();
    }
    'Saved and cleaned up';
  `);
  log('  ' + (r.outputs?.consoleOutput || r.error?.message || 'Done.'));
  log('  XISF: ' + outputPath);

  // Save iteration-numbered JPG preview
  if (iterNum) {
    const iterJpg = `${outputDir}/iteration_${iterNum}.jpg`;
    const previewJpg = path.join(PREVIEW_DIR, 'star_add.jpg');
    try {
      if (fs.existsSync(previewJpg)) {
        fs.copyFileSync(previewJpg, iterJpg);
        log(`  JPG preview: iteration_${iterNum}.jpg`);
      }
    } catch (e) { log('  WARN: Could not copy JPG preview: ' + e.message); }
  }

  const finalStats = await getStats(targetName);
  log('\n========================================');
  log('  PIPELINE COMPLETE');
  log('========================================');
  log('  Steps: ' + CFG.steps.filter(s => s.enabled).map(s => s.name).join(' -> '));
  log('  Final median: ' + finalStats.median.toFixed(4));
  log('  Output: ' + outputPath);
  log('========================================');
}

run().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
