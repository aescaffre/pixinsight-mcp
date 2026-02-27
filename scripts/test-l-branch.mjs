#!/usr/bin/env node
/**
 * test-l-branch.mjs — Standalone L branch test harness
 *
 * Opens raw L master and processes it through configurable steps,
 * matching the user's manual flow: GC → BXT correct → NXT → BXT sharpen → SXT → Seti stretch → HDRMT
 * Exports JPEG preview after each step for quick comparison.
 *
 * Usage:
 *   node scripts/test-l-branch.mjs [--preset <name>] [--l-file <path>] [--output-dir <path>]
 *
 * Presets:
 *   user-manual  — exact user manual settings (target=0.12, inverted HDRMT 6L/1i, no mask)
 *   gentle       — target=0.10, headroom=0.05, inverted HDRMT 6L/1i
 *   moderate     — target=0.15, headroom=0.05, inverted HDRMT 6L/1i
 *   all          — runs all presets sequentially for comparison
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

const home = os.homedir();
const cmdDir = path.join(home, '.pixinsight-mcp/bridge/commands');
const resDir = path.join(home, '.pixinsight-mcp/bridge/results');

// Default L file
const DEFAULT_L = '/Users/aescaffre/Bodes Galaxy/M81 M82/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-L_mono_autocrop.xisf';
const DEFAULT_OUTPUT = path.join(home, '.pixinsight-mcp/previews/l_test');

// Parse args
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : null;
}
const presetName = getArg('preset') || 'user-manual';
const lFile = getArg('l-file') || DEFAULT_L;
const outputDir = getArg('output-dir') || DEFAULT_OUTPUT;

// ============================================================================
// PRESETS — each defines L branch processing parameters
// ============================================================================
const PRESETS = {
  'user-manual': {
    label: 'User manual (target=0.12, inverted HDRMT, no mask)',
    // Linear processing (before stretch)
    bxtCorrect: { sharpenStars: 0.50, sharpenNonstellar: 0.75, adjustStarHalos: 0.00 },
    nxtLinear: { denoise: 0.25, detail: 0.15 },
    bxtSharpen: { sharpenStars: 0.25, sharpenNonstellar: 0.60, adjustStarHalos: 0.00 },
    sxt: { overlap: 0.10 },
    // Stretch
    stretch: { targetMedian: 0.12, blackpointSigma: 5.0, hdrCompress: true,
               hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: 0, normalize: false },
    // Post-stretch
    nxt: { denoise: 0.35, detail: 0.15 },
    bxtPost: null,  // skip post-stretch BXT (user doesn't do this)
    hdrmt: { numberOfLayers: 6, numberOfIterations: 1, inverted: true,
             medianTransform: false, luminanceMask: false, useMask: false },
  },
  'gentle': {
    label: 'Gentle (target=0.10, headroom=0.05, inverted HDRMT)',
    bxtCorrect: { sharpenStars: 0.50, sharpenNonstellar: 0.75, adjustStarHalos: 0.00 },
    nxtLinear: { denoise: 0.25, detail: 0.15 },
    bxtSharpen: { sharpenStars: 0.25, sharpenNonstellar: 0.60, adjustStarHalos: 0.00 },
    sxt: { overlap: 0.10 },
    stretch: { targetMedian: 0.10, blackpointSigma: 5.0, hdrCompress: true,
               hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: 0.05, normalize: false },
    nxt: { denoise: 0.35, detail: 0.15 },
    bxtPost: null,
    hdrmt: { numberOfLayers: 6, numberOfIterations: 1, inverted: true,
             medianTransform: false, luminanceMask: false, useMask: false },
  },
  'moderate': {
    label: 'Moderate (target=0.15, headroom=0.05, inverted HDRMT)',
    bxtCorrect: { sharpenStars: 0.50, sharpenNonstellar: 0.75, adjustStarHalos: 0.00 },
    nxtLinear: { denoise: 0.25, detail: 0.15 },
    bxtSharpen: { sharpenStars: 0.25, sharpenNonstellar: 0.60, adjustStarHalos: 0.00 },
    sxt: { overlap: 0.10 },
    stretch: { targetMedian: 0.15, blackpointSigma: 5.0, hdrCompress: true,
               hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: 0.05, normalize: false },
    nxt: { denoise: 0.35, detail: 0.15 },
    bxtPost: null,
    hdrmt: { numberOfLayers: 6, numberOfIterations: 1, inverted: true,
             medianTransform: false, luminanceMask: false, useMask: false },
  },
  'headroom-test': {
    label: 'Headroom test (target=0.12, headroom=0.10, inverted HDRMT)',
    bxtCorrect: { sharpenStars: 0.50, sharpenNonstellar: 0.75, adjustStarHalos: 0.00 },
    nxtLinear: { denoise: 0.25, detail: 0.15 },
    bxtSharpen: { sharpenStars: 0.25, sharpenNonstellar: 0.60, adjustStarHalos: 0.00 },
    sxt: { overlap: 0.10 },
    stretch: { targetMedian: 0.12, blackpointSigma: 5.0, hdrCompress: true,
               hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: 0.10, normalize: false },
    nxt: { denoise: 0.35, detail: 0.15 },
    bxtPost: null,
    hdrmt: { numberOfLayers: 6, numberOfIterations: 1, inverted: true,
             medianTransform: false, luminanceMask: false, useMask: false },
  },
  'mild-headroom': {
    label: 'Mild headroom (target=0.12, headroom=0.05, inverted HDRMT 6L/1i)',
    bxtCorrect: { sharpenStars: 0.50, sharpenNonstellar: 0.75, adjustStarHalos: 0.00 },
    nxtLinear: { denoise: 0.25, detail: 0.15 },
    bxtSharpen: { sharpenStars: 0.25, sharpenNonstellar: 0.60, adjustStarHalos: 0.00 },
    sxt: { overlap: 0.10 },
    stretch: { targetMedian: 0.12, blackpointSigma: 5.0, hdrCompress: true,
               hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: 0.05, normalize: false },
    nxt: { denoise: 0.35, detail: 0.15 },
    bxtPost: null,
    hdrmt: { numberOfLayers: 6, numberOfIterations: 1, inverted: true,
             medianTransform: false, luminanceMask: false, useMask: false },
  },
  'enhanced': {
    label: 'Enhanced (headroom=0.05, inverted HDRMT 6L/2i — more detail)',
    bxtCorrect: { sharpenStars: 0.50, sharpenNonstellar: 0.75, adjustStarHalos: 0.00 },
    nxtLinear: { denoise: 0.25, detail: 0.15 },
    bxtSharpen: { sharpenStars: 0.25, sharpenNonstellar: 0.60, adjustStarHalos: 0.00 },
    sxt: { overlap: 0.10 },
    stretch: { targetMedian: 0.12, blackpointSigma: 5.0, hdrCompress: true,
               hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: 0.05, normalize: false },
    nxt: { denoise: 0.35, detail: 0.15 },
    bxtPost: null,
    hdrmt: { numberOfLayers: 6, numberOfIterations: 2, inverted: true,
             medianTransform: false, luminanceMask: false, useMask: false },
  },
  'full': {
    label: 'Full (headroom=0.05, inverted HDRMT 6L/1i + LHE — beyond reference)',
    bxtCorrect: { sharpenStars: 0.50, sharpenNonstellar: 0.75, adjustStarHalos: 0.00 },
    nxtLinear: { denoise: 0.25, detail: 0.15 },
    bxtSharpen: { sharpenStars: 0.25, sharpenNonstellar: 0.60, adjustStarHalos: 0.00 },
    sxt: { overlap: 0.10 },
    stretch: { targetMedian: 0.12, blackpointSigma: 5.0, hdrCompress: true,
               hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: 0.05, normalize: false },
    nxt: { denoise: 0.35, detail: 0.15 },
    bxtPost: null,
    lhe: { kernelRadius: 64, amount: 0.25, slopeLimit: 1.3, maskGamma: 2.0 },
    hdrmt: { numberOfLayers: 6, numberOfIterations: 1, inverted: true,
             medianTransform: false, luminanceMask: false, useMask: false },
    nxtFinal: { denoise: 0.30, detail: 0.15 },
  },
};

// ============================================================================
// BRIDGE COMMUNICATION (copied from run-pipeline.mjs)
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
  r.result = r.outputs?.consoleOutput;
  if (r.status !== 'error') r.status = 'ok';
  return r;
}

function log(msg) { console.log(msg); }

// ============================================================================
// HELPERS
// ============================================================================
async function getStats(viewId) {
  const r = await pjsr(`
    var v = ImageWindow.windowById('${viewId}').mainView;
    var img = v.image;
    var result = {};
    result.median = img.median();
    result.mad = img.MAD();
    result.min = img.minimum();
    result.max = img.maximum();
    JSON.stringify(result);
  `);
  try { return JSON.parse(r.outputs?.consoleOutput || '{}'); }
  catch { return { median: 0.01, mad: 0.001, min: 0, max: 0 }; }
}

async function savePreview(viewId, stepId, isLinear = false) {
  const previewPath = path.join(outputDir, stepId + '.jpg');
  log(`    [preview] Exporting ${stepId}...`);
  const r = await pjsr(`
    var srcW = ImageWindow.windowById('${viewId}');
    if (!srcW || srcW.isNull) throw new Error('View not found: ${viewId}');
    var src = srcW.mainView;
    var img = src.image;
    var w = img.width, h = img.height;
    var tmp = new ImageWindow(w, h, img.numberOfChannels, 32, false, img.isColor, 'preview_tmp');
    tmp.mainView.beginProcess();
    tmp.mainView.image.assign(img);
    tmp.mainView.endProcess();
    ${isLinear ? `
    var med = tmp.mainView.image.median();
    var mad = tmp.mainView.image.MAD();
    var c0 = Math.max(0, med - 2.8 * mad);
    var x = (1 > c0) ? (med - c0) / (1 - c0) : 0.5;
    var tgt = 0.25;
    var m = (x <= 0 || x >= 1) ? 0.5 : x * (1 - tgt) / (x * (1 - 2*tgt) + tgt);
    var HT = new HistogramTransformation;
    HT.H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[c0,m,1,0,1],[0,0.5,1,0,1]];
    HT.executeOn(tmp.mainView);
    ` : ''}
    var dir = '${outputDir}';
    if (!File.directoryExists(dir)) File.createDirectory(dir, true);
    var p = '${previewPath}';
    if (File.exists(p)) File.remove(p);
    tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
    'OK';
  `);
  if (r.status === 'error') log('    [preview] WARN: ' + r.error.message);
  else log(`    [preview] Saved: ${stepId}.jpg`);
}

// ============================================================================
// SETI STRETCH (from run-pipeline.mjs, mono-only version)
// ============================================================================
async function setiStretch(viewId, opts = {}) {
  const targetMedian = opts.targetMedian ?? 0.25;
  const blackpointSigma = opts.blackpointSigma ?? 5.0;
  const noBlackClip = opts.noBlackClip ?? false;
  const normalize = opts.normalize ?? false;
  const hdrCompress = opts.hdrCompress ?? false;
  const hdrAmount = opts.hdrAmount ?? 0.25;
  const hdrKnee = opts.hdrKnee ?? 0.35;
  const hdrHeadroom = opts.hdrHeadroom ?? 0;
  const maxIterations = opts.iterations ?? 5;
  const T = targetMedian;
  const noClipFlag = noBlackClip ? '1' : '0';

  const st0 = await getStats(viewId);
  log(`    Seti stretch: target=${targetMedian}, bpSigma=${blackpointSigma}, HDR=${hdrCompress}(amount=${hdrAmount},knee=${hdrKnee},headroom=${hdrHeadroom})`);
  log(`    Initial: median=${st0.median.toFixed(6)} (${Math.round(st0.median * 65535)} ADU), max=${(st0.max ?? 0).toFixed(4)}`);

  for (let iter = 0; iter < maxIterations; iter++) {
    let r;

    // Step 1: Blackpoint rescale (mono)
    const bpExpr = [
      'Med = med($T);',
      'Sig = 1.4826*MAD($T);',
      `BPraw = Med - ${blackpointSigma}*Sig;`,
      `BP = iif(${noClipFlag}, min($T), iif(BPraw < min($T), min($T), BPraw));`,
      'Rescaled = ($T - BP) / (1 - BP);',
      'Rescaled;'
    ].join('\\n');

    r = await pjsr(`
      var P = new PixelMath;
      P.expression = "${bpExpr}";
      P.useSingleExpression = true;
      P.symbols = "Med, Sig, BPraw, BP, Rescaled";
      P.use64BitWorkingImage = true;
      P.truncate = false;
      P.createNewImage = false;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    if (r.status === 'error') { log(`      WARN step1: ${r.error.message}`); break; }

    // Step 2: MTF mapping median → targetMedian (mono)
    const mtfExpr = `((Med($T)-1)*${T}*$T)/(Med($T)*(${T}+$T-1)-${T}*$T)`;
    r = await pjsr(`
      var P = new PixelMath;
      P.expression = "${mtfExpr}";
      P.useSingleExpression = true;
      P.symbols = "L, S";
      P.use64BitWorkingImage = true;
      P.truncate = false;
      P.createNewImage = false;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    if (r.status === 'error') { log(`      WARN step2: ${r.error.message}`); break; }

    // Step 3: Normalize or truncate
    if (normalize) {
      r = await pjsr(`
        var P = new PixelMath;
        P.expression = "$T/max($T)";
        P.useSingleExpression = true;
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
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

    // Step 4: HDR compress (Hermite, mono)
    if (hdrCompress && hdrAmount > 0) {
      const hdrExpr = [
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

      r = await pjsr(`
        var P = new PixelMath;
        P.expression = "${hdrExpr}";
        P.useSingleExpression = true;
        P.symbols = "a,k,x,hi,t,t2,t3,h10,h01,h11,m1,ep,f,y";
        P.use64BitWorkingImage = true;
        P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
        P.createNewImage = false;
        P.executeOn(ImageWindow.windowById('${viewId}').mainView);
      `);
      if (r.status === 'error') log(`      WARN step4 HDR: ${r.error.message}`);
    }

    const stIter = await getStats(viewId);
    const diff = Math.abs(stIter.median - targetMedian);
    log(`    Iter ${iter + 1}: median=${stIter.median.toFixed(6)}, max=${(stIter.max ?? 0).toFixed(4)}, diff=${diff.toFixed(6)}`);
    if (diff < 0.001) { log(`    Converged after ${iter + 1} iteration(s).`); break; }
  }

  const stFinal = await getStats(viewId);
  log(`    Final: median=${stFinal.median.toFixed(6)}, max=${(stFinal.max ?? 0).toFixed(4)}`);
  return stFinal;
}

// ============================================================================
// MAIN — L BRANCH TEST
// ============================================================================
async function runPreset(preset, tag) {
  log(`\n${'='.repeat(60)}`);
  log(`  L BRANCH TEST: ${preset.label}`);
  log(`  Tag: ${tag}`);
  log(`${'='.repeat(60)}\n`);

  // Step 0: Close everything, open raw L
  log('== SETUP ==');
  await pjsr(`
    var wins = ImageWindow.windows;
    for (var i = 0; i < wins.length; i++) wins[i].forceClose();
  `);

  const r0 = await pjsr(`
    var w = ImageWindow.open('${lFile.replace(/'/g, "\\'")}');
    if (!w || w.length === 0) throw new Error('Failed to open L file');
    var id = w[0].mainView.id;
    var img = w[0].mainView.image;
    JSON.stringify({ id: id, w: img.width, h: img.height });
  `);
  if (r0.status === 'error') { log('FATAL: ' + r0.error.message); return; }
  const info = JSON.parse(r0.outputs?.consoleOutput || '{}');
  log(`  Opened: ${info.id} (${info.w}x${info.h})`);
  const srcId = info.id;

  // Clone to L_test
  const viewId = 'L_test';
  await pjsr(`
    var src = ImageWindow.windowById('${srcId}');
    var img = src.mainView.image;
    var dst = new ImageWindow(img.width, img.height, 1, 32, true, false, '${viewId}');
    dst.mainView.beginProcess();
    dst.mainView.image.assign(img);
    dst.mainView.endProcess();
    dst.show();
    src.forceClose();
    'OK';
  `);

  const st0 = await getStats(viewId);
  log(`  L_test: median=${st0.median.toFixed(6)}, max=${(st0.max ?? 0).toFixed(4)}`);
  await savePreview(viewId, `${tag}_00_raw`, true);

  // Step 1: GradientCorrection
  log('\n== GC ==');
  let r = await pjsr(`
    var P = new GradientCorrection;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `);
  log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
  await savePreview(viewId, `${tag}_01_gc`, true);

  // Step 2: BXT correct only (linear)
  if (preset.bxtCorrect) {
    log('\n== BXT CORRECT (linear) ==');
    const bp = preset.bxtCorrect;
    r = await pjsr(`
      var P = new BlurXTerminator;
      P.sharpenStars = ${bp.sharpenStars}; P.adjustStarHalos = ${bp.adjustStarHalos};
      P.sharpenNonstellar = ${bp.sharpenNonstellar}; P.correctOnly = true;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(viewId, `${tag}_02_bxt_correct`, true);
  }

  // Step 3: NXT linear denoise
  if (preset.nxtLinear) {
    log('\n== NXT LINEAR ==');
    r = await pjsr(`
      var P = new NoiseXTerminator;
      P.denoise = ${preset.nxtLinear.denoise}; P.detail = ${preset.nxtLinear.detail};
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(viewId, `${tag}_03_nxt_linear`, true);
  }

  // Step 4: BXT sharpen (linear)
  if (preset.bxtSharpen) {
    log('\n== BXT SHARPEN (linear) ==');
    const bp = preset.bxtSharpen;
    r = await pjsr(`
      var P = new BlurXTerminator;
      P.sharpenStars = ${bp.sharpenStars}; P.adjustStarHalos = ${bp.adjustStarHalos};
      P.sharpenNonstellar = ${bp.sharpenNonstellar}; P.correctOnly = false;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(viewId, `${tag}_04_bxt_sharpen`, true);
  }

  // Step 5: SXT (star removal)
  if (preset.sxt) {
    log('\n== SXT ==');
    r = await pjsr(`
      var P = new StarXTerminator;
      P.stars = true; P.overlap = ${preset.sxt.overlap};
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    // Close star residual images
    await pjsr(`
      var wins = ImageWindow.windows;
      for (var i = 0; i < wins.length; i++) {
        var id = wins[i].mainView.id;
        if (id !== '${viewId}' && id.indexOf('star') >= 0) wins[i].forceClose();
      }
    `);
    await savePreview(viewId, `${tag}_05_sxt`, true);
  }

  // Step 6: Seti Stretch
  log('\n== SETI STRETCH ==');
  const strP = preset.stretch;
  await setiStretch(viewId, {
    targetMedian: strP.targetMedian,
    blackpointSigma: strP.blackpointSigma,
    hdrCompress: strP.hdrCompress,
    hdrAmount: strP.hdrAmount,
    hdrKnee: strP.hdrKnee,
    hdrHeadroom: strP.hdrHeadroom,
    normalize: strP.normalize,
    iterations: 5,
  });
  await savePreview(viewId, `${tag}_06_stretch`, false);

  // Step 7: NXT post-stretch
  if (preset.nxt) {
    log('\n== NXT POST-STRETCH ==');
    r = await pjsr(`
      var P = new NoiseXTerminator;
      P.denoise = ${preset.nxt.denoise}; P.detail = ${preset.nxt.detail};
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(viewId, `${tag}_07_nxt`, false);
  }

  // Step 8: BXT post-stretch (optional)
  if (preset.bxtPost) {
    log('\n== BXT POST-STRETCH ==');
    const bp = preset.bxtPost;
    r = await pjsr(`
      var P = new BlurXTerminator;
      P.sharpenStars = ${bp.sharpenStars}; P.adjustStarHalos = ${bp.adjustStarHalos};
      P.sharpenNonstellar = ${bp.sharpenNonstellar}; P.correctOnly = false;
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(viewId, `${tag}_08_bxt_post`, false);
  }

  // Step 9a: LHE (optional, before HDRMT for tonal separation)
  if (preset.lhe) {
    const lp = preset.lhe;
    log(`\n== LHE (radius=${lp.kernelRadius}, amount=${lp.amount}, slope=${lp.slopeLimit}, maskGamma=${lp.maskGamma}) ==`);

    // Create luminance mask with gamma compression for galaxy cores
    const gamma = lp.maskGamma || 2.0;
    r = await pjsr(`
      var src = ImageWindow.windowById('${viewId}').mainView.image;
      var w2 = src.width, h2 = src.height;
      var mask = new ImageWindow(w2, h2, 1, 32, true, false, 'L_lhe_mask');
      mask.mainView.beginProcess();
      mask.mainView.image.assign(src);
      mask.mainView.endProcess();
      // Rescale to [0,1]
      var P = new PixelMath;
      P.expression = "mn = min($T); mx = max($T); rescaled = iif(mx > mn, ($T - mn)/(mx - mn), 0.5); exp(${gamma}*ln(max(rescaled, 0.00001)))";
      P.useSingleExpression = true;
      P.symbols = "mn, mx, rescaled";
      P.use64BitWorkingImage = true; P.truncate = true; P.createNewImage = false;
      P.executeOn(mask.mainView);
      mask.show();
      'OK';
    `);
    if (r.status !== 'error') {
      // Apply mask and run LHE
      r = await pjsr(`
        var w = ImageWindow.windowById('${viewId}');
        var mask = ImageWindow.windowById('L_lhe_mask');
        w.maskVisible = false;
        w.maskInverted = false;
        w.mask = mask;
        var P = new LocalHistogramEqualization;
        P.radius = ${lp.kernelRadius};
        P.amount = ${lp.amount};
        P.slopeConstraint = ${lp.slopeLimit};
        P.circularKernel = true;
        P.histogramBins = LocalHistogramEqualization.prototype.Bit12;
        P.executeOn(w.mainView);
        w.removeMask();
        mask.forceClose();
        'OK';
      `);
      log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    } else {
      log('  WARN mask creation: ' + r.error.message);
    }
    await savePreview(viewId, `${tag}_09a_lhe`, false);
  }

  // Step 9b: HDRMT
  if (preset.hdrmt) {
    const hp = preset.hdrmt;
    log(`\n== HDRMT (layers=${hp.numberOfLayers}, iter=${hp.numberOfIterations}, inverted=${hp.inverted}) ==`);
    r = await pjsr(`
      var P = new HDRMultiscaleTransform;
      P.numberOfLayers = ${hp.numberOfLayers};
      P.numberOfIterations = ${hp.numberOfIterations};
      P.invertedIterations = ${hp.inverted ?? false};
      P.overdrive = 0;
      P.medianTransform = ${hp.medianTransform ?? false};
      P.toLightness = false;
      P.preserveHue = false;
      P.luminanceMask = ${hp.luminanceMask ?? false};
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(viewId, `${tag}_09_hdrmt`, false);
  }

  // Step 10: NXT final (optional, clean up noise amplified by LHE/HDRMT)
  if (preset.nxtFinal) {
    log('\n== NXT FINAL ==');
    r = await pjsr(`
      var P = new NoiseXTerminator;
      P.denoise = ${preset.nxtFinal.denoise}; P.detail = ${preset.nxtFinal.detail};
      P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    `);
    log('  ' + (r.status === 'error' ? 'WARN: ' + r.error.message : 'Done.'));
    await savePreview(viewId, `${tag}_10_nxt_final`, false);
  }

  // Final stats
  const stFinal = await getStats(viewId);
  log(`\n== FINAL: median=${stFinal.median.toFixed(4)}, max=${(stFinal.max ?? 0).toFixed(4)} ==`);

  // Cleanup
  await pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (!w.isNull) w.forceClose();
  `);

  log(`\nPresets saved to: ${outputDir}/${tag}_*.jpg`);
  return stFinal;
}

// ============================================================================
// ENTRY POINT
// ============================================================================
async function main() {
  log('L Branch Test Harness');
  log(`L file: ${lFile}`);
  log(`Output: ${outputDir}`);

  // Ensure output dir exists
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  if (presetName === 'all') {
    for (const [name, preset] of Object.entries(PRESETS)) {
      await runPreset(preset, name);
    }
    log('\n========================================');
    log('  ALL PRESETS COMPLETE');
    log(`  Compare: ${outputDir}/`);
    log('========================================');
  } else {
    const preset = PRESETS[presetName];
    if (!preset) {
      log(`Unknown preset: ${presetName}. Available: ${Object.keys(PRESETS).join(', ')}, all`);
      process.exit(1);
    }
    await runPreset(preset, presetName);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
