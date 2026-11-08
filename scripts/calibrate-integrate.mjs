#!/usr/bin/env node
// ============================================================================
// calibrate-integrate.mjs — headless "WBPP-lite" for mono data, driven through
// the PixInsight bridge (the WBPP script itself cannot be driven headless).
//
// Mirrors the settings of the user's WBPP runs (PACMAN, 2026-11-01 log):
//   ImageCalibration: master dark (exposure-matched, no bias, no dark
//     optimisation), master flat per filter, f32 output
//   CosmeticCorrection: auto hot/cold detection (stands in for WBPP's LDD/LPS)
//   Screening: frames with < 50 detected stars are rejected; failed registrations retried
//   StarAlignment: RegisterMatch on one reference frame for ALL filters
//     (so every master shares the same geometry)
//   LocalNormalization: per filter, reference = best frame of that filter
//   ImageIntegration: Average, PSFSignalWeight, LocalNormalization,
//     Winsorized sigma clipping 4.5/3.5 (ESD for >= 40 frames)
//   Common autocrop of all masters to the area every filter covers.
//
// Usage:
//   node scripts/calibrate-integrate.mjs --plan plan.json [--stage all|calibrate|register|integrate|crop]
// plan.json:
//   { "outDir": "/Volumes/.../NGC6992/output", "target": "NGC6992",
//     "filters": { "H": { "lights": ["dir1","dir2"], "dark": "...", "flat": "..." }, ... },
//     "referenceFilter": "H" }
// ============================================================================
import fs from 'fs';
import path from 'path';
import { createBridgeContext } from '../agents/ops/bridge.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const plan = JSON.parse(fs.readFileSync(arg('--plan'), 'utf8'));
const stage = arg('--stage', 'all');
const log = (...a) => console.log(`[cal ${new Date().toTimeString().slice(0, 8)}]`, ...a);
const q = s => JSON.stringify(s);
const OUT = plan.outDir;
if (/\s/.test(OUT)) throw new Error('outDir must not contain spaces (StarAlignment)');
const dirs = { cal: path.join(OUT, 'calibrated'), reg: path.join(OUT, 'registered'), master: path.join(OUT, 'master') };
Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));
const state = path.join(OUT, 'cal-state.json');
const st = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {};
const save = () => fs.writeFileSync(state, JSON.stringify(st, null, 1));

const ctx = await createBridgeContext();
async function pj(code, timeout = 6 * 3600 * 1000, label = '') {
  const r = await ctx.pjsr(code, { timeout });
  if (r.status === 'error') throw new Error(`${label}: ${r.error?.message}`);
  return r.outputs?.consoleOutput;
}
const listFits = dirsIn => dirsIn.flatMap(d => fs.readdirSync(d).filter(f => /\.(fits?|xisf)$/i.test(f) && !f.startsWith('._')).map(f => path.join(d, f))).sort();
const filesIn = (d, re) => fs.existsSync(d) ? fs.readdirSync(d).filter(f => re.test(f) && !f.startsWith('._')).map(f => path.join(d, f)).sort() : [];

// ---------------------------------------------------------------- calibrate
async function calibrate(k, f) {
  const lights = listFits(f.lights);
  const cdir = path.join(dirs.cal, k); fs.mkdirSync(cdir, { recursive: true });
  log(`${k}: calibrating ${lights.length} lights (dark ${path.basename(f.dark)}, flat ${path.basename(f.flat)})`);
  const BATCH = 40;   // keep each bridge command bounded
  for (let i = 0; i < lights.length; i += BATCH) {
    const batch = lights.slice(i, i + BATCH);
    await pj(`
      var P = new ImageCalibration;
      P.targetFrames = ${q(batch.map(p => [true, p]))};
      P.enableCFA = false;
      P.masterBiasEnabled = false;
      P.masterDarkEnabled = true; P.masterDarkPath = ${q(f.dark)};
      P.masterFlatEnabled = true; P.masterFlatPath = ${q(f.flat)};
      P.calibrateFlat = false; P.optimizeDarks = false;
      P.evaluateNoise = true;
      P.outputDirectory = ${q(cdir)}; P.outputExtension = ".xisf"; P.outputPostfix = "_c";
      P.outputSampleFormat = ImageCalibration.f32; P.overwriteExistingFiles = true;
      P.executeGlobal(); "ok";`, undefined, `calibrate ${k}`);
    log(`  ${k}: ${Math.min(i + BATCH, lights.length)}/${lights.length}`);
  }
  const cc = filesIn(cdir, /_c\.xisf$/);
  await pj(`
    var C = new CosmeticCorrection;
    C.targetFrames = ${q(cc.map(p => [true, p]))};
    C.useAutoDetect = true; C.hotAutoCheck = true; C.hotAutoValue = 3.0; C.coldAutoCheck = true; C.coldAutoValue = 3.0;
    C.useMasterDark = false; C.useDefectList = false;
    C.outputDir = ${q(cdir)}; C.outputExtension = ".xisf"; C.postfix = "_cc"; C.overwrite = true;
    C.executeGlobal(); "ok";`, undefined, `cosmetic ${k}`);
  // calibrated-only intermediates are not needed once _cc exists
  for (const p of cc) { const ccp = p.replace(/_c\.xisf$/, '_c_cc.xisf'); if (fs.existsSync(ccp)) fs.unlinkSync(p); }
  st[k] = { ...(st[k] || {}), calibrated: filesIn(cdir, /_cc\.xisf$/).length }; save();
}

// ------------------------------------------------- measure (reference choice)
// SubframeSelector measurement; returns [{path, psfSignal, fwhm, stars}] — the column
// layout of P.measurements is discovered by name from the process's table description.
async function measure(paths) {
  const out = await pj(`
    var P = new SubframeSelector;
    P.routine = SubframeSelector.MeasureSubframes;
    P.nonInteractive = true;
    P.subframes = ${q(paths.map(p => [true, p, '', '']))};
    P.fileCache = false;
    P.executeGlobal();
    var rows = P.measurements, res = [];
    for (var i = 0; i < rows.length; i++) res.push(rows[i]);
    JSON.stringify(res);`, undefined, 'measure');
  return JSON.parse(out);
}
// Column indexes of SubframeSelector.measurements (PI 1.9.x): 0 index, 1 enabled, 2 locked,
// 3 path, 4 weight, 5 fwhm, 6 eccentricity, 7 psfSignalWeight, 8 psfSNR, 9 psfScale,
// 10 psfScaleSNR, 11 psfFlux, 12 psfFluxPower, 13 psfTotalMeanFlux, 14 psfTotalMeanPowerFlux,
// 15 psfCount, 16 MStar, 17 NStar, 18 snrWeight, 19 median, 20 medianMeanDev, 21 noise,
// 22 noiseRatio, 23 stars, ...  Verified at runtime: path must be a string at [3].
async function bestFrame(paths, sampleEvery = 1) {
  const sample = paths.filter((_, i) => i % sampleEvery === 0);
  const rows = await measure(sample);
  if (!rows.length || typeof rows[0][3] !== 'string') throw new Error('unexpected SubframeSelector measurement layout: ' + JSON.stringify(rows[0]).slice(0, 300));
  // [21] = detected stars. Cloudy/dewed frames (NGC6992: 51/118 H) measure absurd FWHM (<1 px) and
  // can still win on PSF signal; rank only frames with a real star field and a plausible FWHM.
  const starry = rows.filter(r => r[21] >= 50 && r[5] >= 1.5);
  if (starry.length) rows.splice(0, rows.length, ...starry);
  rows.sort((a, b) => b[7] - a[7]);   // highest PSF signal weight
  log(`  best frame ${path.basename(rows[0][3])}: psfSignal=${(+rows[0][7]).toFixed(3)} fwhm=${(+rows[0][5]).toFixed(2)} stars=${rows[0][21]} (of ${rows.length} usable)`);
  return rows[0][3];
}

// ------------------------------------------------------------------ register
async function register() {
  const refK = plan.referenceFilter || Object.keys(plan.filters)[0];
  const refCands = filesIn(path.join(dirs.cal, refK), /_cc\.xisf$/);
  if (!st.reference) { log(`choosing registration reference among ${refK} frames`); st.reference = await bestFrame(refCands, Math.max(1, Math.floor(refCands.length / 30))); save(); }
  for (const k of Object.keys(plan.filters)) {
    let src = filesIn(path.join(dirs.cal, k), /_cc\.xisf$/);
    // Screening (WBPP-style approval, minimal): drop frames without a real star field (clouds, dew).
    const meas = await measure(src);
    const empty = meas.filter(r => r[21] < 50).map(r => r[3]);
    if (empty.length) log(`  ${k}: ${empty.length}/${src.length} frames rejected (< 50 stars: clouds/dew)`);
    src = src.filter(p => !empty.includes(p));
    st[k] = { ...(st[k] || {}), rejectedEmpty: empty.length }; save();
    const rdir = path.join(dirs.reg, k); fs.mkdirSync(rdir, { recursive: true });
    log(`${k}: registering ${src.length} frames`);
    await pj(`
      var S = new StarAlignment;
      S.referenceImage = ${q(st.reference)}; S.referenceIsFile = true;
      S.targets = ${q(src.map(p => [true, true, p]))};
      S.mode = StarAlignment.RegisterMatch;
      S.structureLayers = 5; S.sensitivity = 0.5; S.useTriangles = false; S.distortionCorrection = true;
      S.pixelInterpolation = StarAlignment.Auto; S.clampingThreshold = 0.30;
      S.generateDrizzleData = false;
      S.outputDirectory = ${q(rdir)}; S.outputExtension = ".xisf"; S.outputPostfix = "_r"; S.overwriteExistingFiles = true;
      S.executeGlobal(); "ok";`, undefined, `register ${k}`);
    // Retry failures with triangle matching + higher sensitivity, no distortion model
    // (NGC6992: recovered 11/12 H and 26/27 O good frames the first pass dropped).
    const done = new Set(filesIn(rdir, /_r\.xisf$/).map(p => path.basename(p).replace(/_r\.xisf$/, '.xisf')));
    const retry = src.filter(p => !done.has(path.basename(p)));
    if (retry.length) {
      log(`  ${k}: retrying ${retry.length} failed frames (triangles, sensitivity 0.75)`);
      await pj(`
        var S = new StarAlignment; S.referenceImage = ${q(st.reference)}; S.referenceIsFile = true;
        S.targets = ${q(retry.map(p => [true, true, p]))}; S.mode = StarAlignment.RegisterMatch;
        S.structureLayers = 5; S.sensitivity = 0.75; S.useTriangles = true; S.distortionCorrection = false;
        S.pixelInterpolation = StarAlignment.Auto; S.clampingThreshold = 0.30;
        S.outputDirectory = ${q(rdir)}; S.outputExtension = ".xisf"; S.outputPostfix = "_r"; S.overwriteExistingFiles = true;
        S.executeGlobal(); "ok";`, undefined, `register retry ${k}`);
    }
    const n = filesIn(rdir, /_r\.xisf$/).length;
    log(`  ${k}: ${n}/${src.length} registered`);
    st[k] = { ...(st[k] || {}), registered: n }; save();
  }
}

// ----------------------------------------------------------------- integrate
async function integrate() {
  for (const k of Object.keys(plan.filters)) {
    const rdir = path.join(dirs.reg, k);
    const regs = filesIn(rdir, /_r\.xisf$/);
    if (regs.length < 3) throw new Error(`${k}: only ${regs.length} registered frames`);
    log(`${k}: local normalization reference`);
    const lnRef = await bestFrame(regs, Math.max(1, Math.floor(regs.length / 20)));
    log(`${k}: LocalNormalization on ${regs.length} frames`);
    await pj(`
      var L = new LocalNormalization;
      L.referencePathOrViewId = ${q(lnRef)}; L.referenceIsView = false;
      L.targetItems = ${q(regs.map(p => [true, p]))};
      L.scale = 1024; L.noScale = false; L.globalLocationNormalization = false;
      L.rejection = true; L.referenceRejectionThreshold = 3.0; L.targetRejectionThreshold = 3.2; L.hotPixelFilterRadius = 2;
      L.generateNormalizedImages = LocalNormalization.GenerateNormalizedImages_ViewExecutionOnly;
      L.generateNormalizationData = true; L.outputDirectory = ${q(rdir)}; L.overwriteExistingFiles = true;
      L.executeGlobal(); "ok";`, undefined, `LN ${k}`);
    const useESD = regs.length >= 40;
    const exp = plan.filters[k].exposure || '';
    const master = path.join(dirs.master, `masterLight_${plan.target}_${exp}FILTER-${k}_mono.xisf`);
    log(`${k}: ImageIntegration of ${regs.length} frames (${useESD ? 'ESD' : 'Winsorized 4.5/3.5'}, PSF signal weights, LN)`);
    await pj(`
      var I = new ImageIntegration;
      I.images = ${q(regs.map(p => [true, p, '', p.replace(/\.xisf$/, '.xnml')]))};
      I.combination = ImageIntegration.Average;
      I.weightMode = ImageIntegration.PSFSignalWeight; I.minWeight = 0.05;
      I.normalization = ImageIntegration.LocalNormalization;
      I.rejection = ${useESD ? 'ImageIntegration.Rejection_ESD' : 'ImageIntegration.WinsorizedSigmaClip'};
      I.rejectionNormalization = ImageIntegration.LocalRejectionNormalization;
      I.sigmaLow = 4.5; I.sigmaHigh = 3.5; I.esdOutliersFraction = 0.30; I.esdAlpha = 0.05; I.esdLowRelaxation = 1.0;
      I.clipLow = true; I.clipHigh = true; I.generateRejectionMaps = false; I.generateDrizzleData = false;
      I.evaluateSNR = true; I.subtractPedestals = false; I.truncateOnOutOfRange = false;
      I.executeGlobal();
      var w = ImageWindow.windowById("integration");
      w.saveAs(${q(master)}, false, false, false, false); w.forceClose();
      var all = ImageWindow.windows; for (var i = 0; i < all.length; i++) if (/^(rejection|slope|integration)/.test(all[i].mainView.id)) all[i].forceClose();
      "ok";`, undefined, `integrate ${k}`);
    log(`  ${k}: master → ${master}`);
    st[k] = { ...(st[k] || {}), master }; save();
  }
}

// ---------------------------------------------------------------------- crop
// Common crop: rows/cols where every master has data (> 0) on >= 99% of the line.
async function crop() {
  const keys = Object.keys(plan.filters);
  const masters = keys.map(k => st[k]?.master).filter(Boolean);
  const out = await pj(`
    var paths = ${q(masters)}, ws = [];
    for (var i = 0; i < paths.length; i++) { var a = ImageWindow.open(paths[i]); for (var j = 1; j < a.length; j++) a[j].forceClose(); ws.push(a[0]); }
    var W = ws[0].mainView.image.width, H = ws[0].mainView.image.height;
    function good(img, isRow, idx) {
      var n = isRow ? W : H, step = 8, ok = 0, tot = 0;
      for (var t = 0; t < n; t += step) { tot++; var v = isRow ? img.sample(t, idx) : img.sample(idx, t); if (v > 0) ok++; }
      return ok / tot >= 0.99;
    }
    function allGood(isRow, idx) { for (var i = 0; i < ws.length; i++) if (!good(ws[i].mainView.image, isRow, idx)) return false; return true; }
    var y0 = 0; while (y0 < H / 3 && !allGood(true, y0)) y0++;
    var y1 = H - 1; while (y1 > 2 * H / 3 && !allGood(true, y1)) y1--;
    var x0 = 0; while (x0 < W / 3 && !allGood(false, x0)) x0++;
    var x1 = W - 1; while (x1 > 2 * W / 3 && !allGood(false, x1)) x1--;
    var m = 8; x0 += m; y0 += m; x1 -= m; y1 -= m;
    var outp = [];
    for (var i = 0; i < ws.length; i++) {
      var C = new Crop; C.mode = Crop.AbsolutePixels; C.leftMargin = -x0; C.topMargin = -y0; C.rightMargin = -(W - 1 - x1); C.bottomMargin = -(H - 1 - y1);
      C.executeOn(ws[i].mainView);
      var p = paths[i].replace(/\\.xisf$/, "_autocrop.xisf"); ws[i].saveAs(p, false, false, false, false); ws[i].forceClose(); outp.push(p);
    }
    JSON.stringify({ box: [x0, y0, x1, y1], W: W, H: H, out: outp });`, undefined, 'crop');
  const r = JSON.parse(out);
  log(`common crop x ${r.box[0]}-${r.box[2]} y ${r.box[1]}-${r.box[3]} of ${r.W}x${r.H}`);
  keys.forEach((k, i) => { st[k].autocrop = r.out[i]; }); save();
}

try {
  if (stage === 'all' || stage === 'calibrate') for (const [k, f] of Object.entries(plan.filters)) if (!st[k]?.calibrated || stage === 'calibrate') await calibrate(k, f);
  if (stage === 'all' || stage === 'register') await register();
  if (stage === 'all' || stage === 'integrate') await integrate();
  if (stage === 'all' || stage === 'crop') await crop();
  log('DONE', JSON.stringify(Object.fromEntries(Object.entries(st).filter(([k]) => k !== 'reference').map(([k, v]) => [k, v.autocrop || v.master]))));
  process.exit(0);
} catch (e) { log('FATAL', e.message); process.exit(1); }
