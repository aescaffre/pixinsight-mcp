#!/usr/bin/env node
// Subject crop-and-graft for small targets in wide fields (2026-10-30).
//
// Why: on a 104 MP frame where the galaxy covers ~1% (M101 at 459 mm), the agent's core/zone/HDR
// masks are frame-scaled, so their edges land inside the inner disk (round seam, milky haze).
// Processing a crop around the subject makes the masks subject-scaled; the processed crop is then
// grafted back into a full-frame result with a feathered, background-matched blend.
//
//   node scripts/subject-crop.mjs make  --config <cfg.json> [--size 4096] [--out <dir>]
//        -> crops every master to a box centred on the subject, writes <dir>/<name>_crop.json
//   node scripts/subject-crop.mjs graft --full <full.xisf> --crop <crop.xisf> --out <graft.xisf>
//        [--inner 0.30] [--outer 0.45]   (feather radii as fractions of the crop side)
//
// Both modes drive PixInsight through the bridge. Run them between pipeline runs, not during one.
import fs from 'node:fs';
import path from 'node:path';
import { createBridgeContext } from '../agents/ops/bridge.mjs';

const args = process.argv.slice(2);
const mode = args[0];
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function pj(ctx, label, code, timeout = 900000) {
  const r = await ctx.pjsr(code, { timeout });
  const out = r.outputs?.consoleOutput || r.error?.message || '';
  if (r.status === 'error') throw new Error(`${label}: ${out}`);
  return out;
}

async function make() {
  const cfgPath = opt('config'); const size = Number(opt('size', 4096));
  if (!cfgPath || !fs.existsSync(cfgPath)) throw new Error('--config <cfg.json> required');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  const F = cfg.files || cfg;
  const keys = ['L', 'R', 'G', 'B', 'Ha', 'S', 'O'].filter(k => typeof F[k] === 'string' && F[k] && fs.existsSync(F[k]));
  const refKey = keys.includes('L') ? 'L' : keys[0];
  const outDir = opt('out', path.join(path.dirname(F[refKey]), 'subject_crop'));
  fs.mkdirSync(outDir, { recursive: true });
  const ctx = await createBridgeContext();

  // 1. Subject centre on the reference master: brightest 256 px block median (robust to stars),
  //    refined by a brightness-weighted centroid of the 5x5 neighbouring blocks.
  const found = JSON.parse(await pj(ctx, 'locate', `
    var f = '${q(F[refKey])}';
    if (!File.exists(f)) throw new Error('missing ' + f);
    var a = ImageWindow.open(f); var w = a[0]; for (var i = 1; i < a.length; i++) a[i].forceClose();
    var img = w.mainView.image, B = 256, nx = Math.floor(img.width / B), ny = Math.floor(img.height / B), M = [];
    var gmed = img.median();
    for (var by = 0; by < ny; by++) { M.push([]); for (var bx = 0; bx < nx; bx++) {
      img.selectedRect = new Rect(bx * B, by * B, (bx + 1) * B, (by + 1) * B);
      M[by].push(img.median()); } }
    img.resetSelections();
    var best = -1, bx0 = 0, by0 = 0;
    for (var y = 1; y < ny - 1; y++) for (var x = 1; x < nx - 1; x++) if (M[y][x] > best) { best = M[y][x]; bx0 = x; by0 = y; }
    var sw = 0, sx = 0, sy = 0;
    for (var y = Math.max(0, by0 - 2); y <= Math.min(ny - 1, by0 + 2); y++) for (var x = Math.max(0, bx0 - 2); x <= Math.min(nx - 1, bx0 + 2); x++) {
      var v = Math.max(0, M[y][x] - gmed); sw += v; sx += v * (x + 0.5) * B; sy += v * (y + 0.5) * B; }
    var W = img.width, H = img.height; w.forceClose();
    JSON.stringify({ cx: Math.round(sw > 0 ? sx / sw : (bx0 + 0.5) * B), cy: Math.round(sw > 0 ? sy / sw : (by0 + 0.5) * B), W: W, H: H, peak: best, bg: gmed });
  `));
  const half = Math.floor(size / 2);
  const x0 = Math.max(0, Math.min(found.W - size, found.cx - half));
  const y0 = Math.max(0, Math.min(found.H - size, found.cy - half));
  const box = { x0, y0, x1: Math.min(found.W, x0 + size), y1: Math.min(found.H, y0 + size) };
  console.log(`subject centre (${found.cx}, ${found.cy}) in ${found.W}x${found.H}; crop box ${JSON.stringify(box)}`);

  // 2. Crop every master to the same pixel box (channel registration is redone by prep: forceAlign).
  const newFiles = { ...F };
  for (const k of keys) {
    const dst = path.join(outDir, `${k}_crop.xisf`);
    await pj(ctx, `crop ${k}`, `
      var a = ImageWindow.open('${q(F[k])}'); var w = a[0]; for (var i = 1; i < a.length; i++) a[i].forceClose();
      var src = w.mainView.image;
      var c = new ImageWindow(${box.x1 - box.x0}, ${box.y1 - box.y0}, src.numberOfChannels, 32, true, src.isColor, 'SC_${k}');
      c.mainView.beginProcess(UndoFlag.NoSwapFile);
      src.selectedRect = new Rect(${box.x0}, ${box.y0}, ${box.x1}, ${box.y1});
      c.mainView.image.assign(src); src.resetSelections();
      c.mainView.endProcess();
      c.keywords = w.keywords;   // keep FOCALLEN/XPIXSZ/RA/DEC for the plate-solve seed
      c.saveAs('${q(dst)}', false, false, false, false); c.forceClose(); w.forceClose(); 'ok';
    `);
    newFiles[k] = dst; console.log(`  ${k} -> ${dst}`);
  }
  const outCfg = JSON.parse(JSON.stringify(cfg));
  const OF = outCfg.files || outCfg;
  Object.assign(OF, newFiles);
  OF.targetName = (F.targetName || 'Target') + '_crop';
  OF.outputDir = path.join(path.dirname(F.outputDir || outDir), (path.basename(F.outputDir || 'agentic')) + '_crop');
  OF.forceAlign = true; OF.distortionCorrection = true; OF.autoCropBorder = true;
  OF.subjectCrop = { ...box, sourceW: found.W, sourceH: found.H, size };
  const outPath = path.join(outDir, `${path.basename(cfgPath, '.json')}_crop.json`);
  fs.writeFileSync(outPath, JSON.stringify(outCfg, null, 2));
  console.log(`config: ${outPath}`);
}

async function graft() {
  const full = opt('full'), crop = opt('crop'), out = opt('out');
  const inner = Number(opt('inner', 0.30)), outer = Number(opt('outer', 0.45));
  for (const [k, v] of [['full', full], ['crop', crop], ['out', out]]) if (!v) throw new Error(`--${k} required`);
  for (const f of [full, crop]) if (!fs.existsSync(f)) throw new Error('missing ' + f);
  const ctx = await createBridgeContext();
  const tmp = path.join(path.dirname(out), 'graft_tmp'); fs.mkdirSync(tmp, { recursive: true });

  // 1. Geometry. Preferred: --offset X,Y = position of crop pixel (0,0) in the full-frame result. Both
  // runs register every channel to their own R master, and the crop masters are a pixel box of the full
  // masters, so the mapping is a pure translation: (box.x0 + cropTrimLeft - fullTrimLeft, box.y0 +
  // cropTrimTop - fullTrimTop). StarAlignment is only a fallback: on a crop covering 1/6 of the field it
  // cannot match triangles of the brightest stars (M101, 2026-10-30).
  const offArg = opt('offset');
  if (offArg) {
    const [ox, oy] = offArg.split(',').map(Number);
    const res = await pj(ctx, 'blend-offset', `
      function op(f, id) { var a = ImageWindow.open(f); var w = a[0]; for (var i = 1; i < a.length; i++) a[i].forceClose(); w.mainView.id = id; return w; }
      var F = op('${q(full)}', 'GF_FULL'), C = op('${q(crop)}', 'GF_CROP');
      var fi = F.mainView.image, ci = C.mainView.image, ox = ${ox}, oy = ${oy};
      // alignment check: brightest star in the crop's central region vs the same spot in the full image
      var best = 0, bx = 0, by = 0;
      for (var y = 200; y < ci.height - 200; y += 3) for (var x = 200; x < ci.width - 200; x += 3) {
        var v = ci.sample(x, y, 1); var r = Math.sqrt((x - ci.width/2)*(x - ci.width/2) + (y - ci.height/2)*(y - ci.height/2));
        if (r > ci.width * 0.3 && v > best) { best = v; bx = x; by = y; } }
      var bf = 0, fx = 0, fy = 0;
      for (var dy = -12; dy <= 12; dy++) for (var dx = -12; dx <= 12; dx++) { var v = fi.sample(bx + ox + dx, by + oy + dy, 1); if (v > bf) { bf = v; fx = dx; fy = dy; } }
      var cx = ox + ci.width / 2, cy = oy + ci.height / 2, side = Math.min(ci.width, ci.height);
      var rIn = ${inner} * side, rOut = ${outer} * side;
      var off = [0, 0, 0];
      for (var c = 0; c < 3; c++) { var d = [];
        for (var y = Math.floor(cy - rOut); y < cy + rOut; y += 12) for (var x = Math.floor(cx - rOut); x < cx + rOut; x += 12) {
          var u = x - ox, v2 = y - oy; if (u < 0 || v2 < 0 || u >= ci.width || v2 >= ci.height) continue;
          var rr = Math.sqrt((x - cx)*(x - cx) + (y - cy)*(y - cy)); if (rr < rIn || rr > rOut) continue;
          var a = fi.sample(x, y, c), b = ci.sample(u, v2, c); if (a > 0.5 || b > 0.5) continue; d.push(a - b); }
        d.sort(function (p, q2) { return p - q2; }); off[c] = d.length ? d[Math.floor(d.length / 2)] : 0; }
      var dxs = '(x()-' + cx.toFixed(1) + ')', dys = '(y()-' + cy.toFixed(1) + ')';
      var K = 'k = max(0, min(1, (' + rOut.toFixed(1) + ' - sqrt(' + dxs + '*' + dxs + ' + ' + dys + '*' + dys + ')) / ' + (rOut - rIn).toFixed(1) + '))';
      var inside = '(x() >= ' + ox + ' && y() >= ' + oy + ' && x() < ' + (ox + ci.width) + ' && y() < ' + (oy + ci.height) + ')';
      function ex(c) { return K + '; iif(' + inside + ' && k > 0, $T*(1-k) + (pixel(GF_CROP, x()-' + ox + ', y()-' + oy + ', ' + c + ') + ' + off[c].toFixed(6) + ')*k, $T)'; }
      var P = new PixelMath; P.expression = ex(0); P.expression1 = ex(1); P.expression2 = ex(2);
      P.useSingleExpression = false; P.symbols = 'k'; P.createNewImage = false; P.rescale = false; P.truncate = true;
      P.executeOn(F.mainView);
      F.saveAs('${q(out)}', false, false, false, false);
      F.saveAs('${q(out.replace(/\.xisf$/, '.jpg'))}', false, false, false, false);
      C.forceClose(); F.forceClose();
      JSON.stringify({ offset: [ox, oy], starCheck: { cropStar: [bx, by], residualPx: [fx, fy], peakCrop: +best.toFixed(3), peakFull: +bf.toFixed(3) }, rIn: Math.round(rIn), rOut: Math.round(rOut), skyOffset: off.map(function (v) { return +v.toFixed(5); }) });
    `, 1800000);
    console.log('graft:', res, '->', out);
    return;
  }
  await pj(ctx, 'register', `
    var P = new StarAlignment;
    P.referenceImage = '${q(full)}'; P.referenceIsFile = true;
    P.targets = [[true, true, '${q(crop)}']];
    P.outputDirectory = '${q(tmp)}'; P.outputPrefix = 'reg_'; P.outputPostfix = ''; P.overwriteExistingFiles = true;
    P.onError = StarAlignment.Continue; P.useTriangles = true; P.polygonSides = 5; P.sensitivity = 0.5; P.noGUIMessages = true;
    P.distortionCorrection = true; P.generateDrizzleData = false;
    P.executeGlobal(); 'ok';
  `, 1800000);
  const reg = path.join(tmp, 'reg_' + path.basename(crop));
  if (!fs.existsSync(reg)) throw new Error('registration produced no file: ' + reg);

  // 2. Open both, compute the crop footprint centre/side in full coordinates, match the sky level
  //    in an annulus (per channel, robust medians), then feathered radial blend.
  const res = await pj(ctx, 'blend', `
    function op(f, id) { var a = ImageWindow.open(f); var w = a[0]; for (var i = 1; i < a.length; i++) a[i].forceClose(); w.mainView.id = id; return w; }
    var F = op('${q(full)}', 'GF_FULL'), C = op('${q(reg)}', 'GF_CROP');
    var fi = F.mainView.image, ci = C.mainView.image;
    // footprint of the registered crop (non-zero pixels), sampled every 16 px
    var x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (var y = 0; y < ci.height; y += 16) for (var x = 0; x < ci.width; x += 16) {
      if (ci.sample(x, y, 0) + ci.sample(x, y, 1) + ci.sample(x, y, 2) > 0) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; } }
    if (x1 < 0) throw new Error('registered crop is empty');
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, side = Math.min(x1 - x0, y1 - y0);
    var rIn = ${inner} * side, rOut = ${outer} * side;
    // per-channel sky offset in the annulus [rIn, rOut]: median of (full - crop) at sampled pixels
    var off = [0, 0, 0];
    for (var c = 0; c < 3; c++) { var d = [];
      for (var y = Math.floor(cy - rOut); y < cy + rOut; y += 12) for (var x = Math.floor(cx - rOut); x < cx + rOut; x += 12) {
        if (x < 0 || y < 0 || x >= fi.width || y >= fi.height) continue;
        var r = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)); if (r < rIn || r > rOut) continue;
        var a = fi.sample(x, y, c), b = ci.sample(x, y, c); if (b <= 0 || a > 0.5 || b > 0.5) continue; d.push(a - b); }
      d.sort(function (p, q) { return p - q; }); off[c] = d.length ? d[Math.floor(d.length / 2)] : 0; }
    var P = new PixelMath;
    var dx = '(x()-' + cx.toFixed(1) + ')', dy = '(y()-' + cy.toFixed(1) + ')';   // no pow()/^ in PixelMath
    var m = 'max(0, min(1, (' + rOut.toFixed(1) + ' - sqrt(' + dx + '*' + dx + ' + ' + dy + '*' + dy + ')) / ' + (rOut - rIn).toFixed(1) + '))';
    P.expression  = 'k = ' + m + '; iif(GF_CROP[0] + GF_CROP[1] + GF_CROP[2] > 0, $T*(1-k) + (GF_CROP[0] + ' + off[0].toFixed(6) + ')*k, $T)';
    P.expression1 = 'k = ' + m + '; iif(GF_CROP[0] + GF_CROP[1] + GF_CROP[2] > 0, $T*(1-k) + (GF_CROP[1] + ' + off[1].toFixed(6) + ')*k, $T)';
    P.expression2 = 'k = ' + m + '; iif(GF_CROP[0] + GF_CROP[1] + GF_CROP[2] > 0, $T*(1-k) + (GF_CROP[2] + ' + off[2].toFixed(6) + ')*k, $T)';
    P.useSingleExpression = false; P.symbols = 'k'; P.createNewImage = false; P.rescale = false; P.truncate = true;
    P.executeOn(F.mainView);
    F.saveAs('${q(out)}', false, false, false, false);
    C.forceClose(); F.forceClose();
    JSON.stringify({ cx: Math.round(cx), cy: Math.round(cy), side: side, rIn: Math.round(rIn), rOut: Math.round(rOut), skyOffset: off.map(function (v) { return +v.toFixed(5); }) });
  `, 1800000);
  console.log('graft:', res, '->', out);
}

(mode === 'make' ? make() : mode === 'graft' ? graft() : Promise.reject(new Error('mode: make | graft')))
  .then(() => process.exit(0)).catch(e => { console.error('subject-crop:', e.message); process.exit(1); });
