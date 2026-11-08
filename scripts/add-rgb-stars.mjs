#!/usr/bin/env node
// ============================================================================
// add-rgb-stars.mjs — put true-colour RGB stars on a starless narrowband result.
// Recipe validated on PACMAN (NGC281, 2026-11-01; user picked the "color2" look):
//   1. giga-run --prep-only on an R/G/B-only config (align, gradient, solve, SPCC,
//      BXT, SXT) → linear star layer `${target}_stars` left open in PixInsight
//   2. stretch_stars (Seti, midtone 0.22, 5 iterations)
//   3. StarAlignment of the STRETCHED star layer onto the narrowband master
//      (registering the linear layer fails: too few detectable stars)
//   4. star colour: soft roll-off of the white cores (max → peak) + N saturation passes
//   5. ONE screen blend ~(~starless * ~stars) — the only star blend
//
// Usage:
//   node scripts/add-rgb-stars.mjs --rgb-config cfg.json --starless final.xisf \
//        --ref Ha_master.xisf --out out_basename [--sat-passes 2] [--peak 0.88] [--skip-prep] [--reuse-reg reg.xisf]
// Writes <out>.xisf and <out>.jpg; star intermediates go next to <out>.
// ============================================================================
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createBridgeContext } from '../agents/ops/bridge.mjs';
import { TOOL_CATALOG } from '../agents/llm/tools.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const cfgPath = arg('--rgb-config'), starless = arg('--starless'), ref = arg('--ref'), out = arg('--out');
const satPasses = +arg('--sat-passes', 2), peak = +arg('--peak', 0.88);
// --reuse-reg <file>: skip prep/stretch/registration and blend an already registered stretched star layer
const reuseReg = arg('--reuse-reg');
if (!cfgPath || !starless || !ref || !out) { console.error('usage: --rgb-config --starless --ref --out'); process.exit(2); }
const outDir = path.dirname(out);
if (/\s/.test(outDir)) throw new Error('output dir must not contain spaces (StarAlignment)');
fs.mkdirSync(outDir, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const target = cfg.files.targetName;
const log = (...a) => console.log(`[rgb-stars ${new Date().toTimeString().slice(0, 8)}]`, ...a);
const q = s => JSON.stringify(s);

if (!reuseReg && !args.includes('--skip-prep')) {
  log('RGB prep-only (align, gradient, solve, SPCC, BXT, SXT)...');
  const res = execFileSync(process.execPath, ['agents/llm/giga-run.mjs', '--config', cfgPath, '--prep-only'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (!/SPCC_OK/.test(res)) log('WARNING: SPCC did not report SPCC_OK — star colours may be uncalibrated');
  if (!new RegExp(`${target}_stars`).test(res)) throw new Error('prep did not leave a star layer open:\n' + res.slice(-1500));
}
const ctx = await createBridgeContext();
async function pj(code, label) { const r = await ctx.pjsr(code, { timeout: 3 * 3600 * 1000 }); if (r.status === 'error') throw new Error(`${label}: ${r.error?.message}`); return r.outputs?.consoleOutput; }

const linear = `${out}_stars_linear.xisf`, stretched = `${out}_stars_stretched.xisf`, reg = reuseReg || `${out}_stars_stretched_reg.xisf`;
if (!reuseReg) {
await pj(`var w = ImageWindow.windowById(${q(target)}); if (!w.isNull) w.forceClose();
  var s = ImageWindow.windowById(${q(target + '_stars')}); if (s.isNull) throw new Error('star layer not open');
  s.saveAs(${q(linear)}, false, false, false, false); s.mainView.id = "RGBST"; "ok";`, 'save linear stars');
const brief = { target: { classification: 'emission_nebula' }, processingProfile: { stars: {} } };
const st = await TOOL_CATALOG.stretch_stars.handler(ctx, null, brief, { view_id: 'RGBST', midtone: 0.22, iterations: 5 });
log('stretch:', st.text || JSON.stringify(st).slice(0, 200));
await pj(`var w = ImageWindow.windowById("RGBST"); w.saveAs(${q(stretched)}, false, false, false, false); w.forceClose();
  var S = new StarAlignment; S.referenceImage = ${q(ref)}; S.referenceIsFile = true;
  S.targets = [[true, true, ${q(stretched)}]]; S.mode = StarAlignment.RegisterMatch;
  S.distortionCorrection = true; S.useTriangles = true;
  S.outputDirectory = ${q(outDir)}; S.outputPostfix = "_reg"; S.overwriteExistingFiles = true;
  if (!S.executeGlobal()) throw new Error("StarAlignment failed"); "ok";`, 'register stars');
}
if (!fs.existsSync(reg)) throw new Error('registered star layer missing: ' + reg);
log(`registered → ${path.basename(reg)}; colour: peak ${peak}, ${satPasses} saturation pass(es); screen blend`);
const dims = await pj(`
  function op(p, id) { var a = ImageWindow.open(p); var w = a[0]; for (var i = 1; i < a.length; i++) a[i].forceClose(); w.mainView.id = id; return w; }
  var T = op(${q(starless)}, "SL_BASE"), S = op(${q(reg)}, "ST_COL");
  var t = T.mainView.image, s = S.mainView.image, dims = t.width + "x" + t.height;
  if (t.width != s.width || t.height != s.height) throw new Error("size mismatch " + t.width + "x" + t.height + " vs " + s.width + "x" + s.height);
  var P0 = new PixelMath; P0.expression = "iif($T>0.6, 0.6+($T-0.6)*${((peak - 0.6) / 0.4).toFixed(3)}, $T)"; P0.useSingleExpression = true; P0.executeOn(S.mainView);
  for (var i = 0; i < ${satPasses}; i++) { var C = new CurvesTransformation; C.S = [[0,0],[0.25,0.5],[0.6,0.88],[1,1]]; C.St = CurvesTransformation.AkimaSubsplines; C.executeOn(S.mainView); }
  var P = new PixelMath; P.expression = "~(~$T*~ST_COL)"; P.useSingleExpression = true; P.createNewImage = true; P.newImageId = "SL_STARS";
  P.newImageColorSpace = PixelMath.RGB; P.newImageSampleFormat = PixelMath.f32; P.executeOn(T.mainView);
  var W = ImageWindow.windowById("SL_STARS");
  W.saveAs(${q(out + '.xisf')}, false, false, false, false); W.saveAs(${q(out + '.jpg')}, false, false, false, false);
  W.forceClose(); S.forceClose(); T.forceClose(); dims;`, 'blend');
log(`DONE ${dims} → ${out}.xisf / .jpg`);
process.exit(0);
