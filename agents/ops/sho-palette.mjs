import { nativeOr } from './native-metrics.mjs';
// ============================================================================
// SHO / HOO narrowband palette operations (Hubble palette and variants)
//
// All functions work on STRETCHED, STARLESS mono channels (S, H, O) — the
// palette is built non-linearly so each channel can be stretched to its own
// level first (unlinked stretch = the first normalization step). The agent
// picks the palette, the balance gains and the hue shift; these ops only
// execute and measure.
//
// Palettes:
//   sho        — classic Hubble mapping R=S, G=H, B=O with per-channel gains
//                (Ha dominates → green; follow with sho_hue_shift for gold).
//   foraxx     — dynamic SHO (thecoldestnights, 2020): weights blend H/S/O by
//                signal, giving gold/blue tones directly with little green.
//   hue_screen — HSV hue-tint each channel and screen-blend (method of
//                Jürgen Bätz's NarrowbandHueCombination script, run headless).
//   hoo        — R=H, G=O·w+H·(1-w), B=O (bicolor).
//
// PixelMath has NO pow(): x^y is written exp(y*ln(max(x,eps))).
// ============================================================================

/** Sample a mono view on a stride grid and return robust percentiles. */
async function sampleMono(ctx, viewId, pcts = [0.5, 0.9, 0.99, 0.995]) {
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('sampleMono: view not found: ${viewId}');
    var img = w.mainView.image;
    var W = img.width, H = img.height;
    var sx = Math.max(1, Math.floor(W / 420)), sy = Math.max(1, Math.floor(H / 280));
    var v = [];
    for (var y = 0; y < H; y += sy) for (var x = 0; x < W; x += sx) v.push(img.sample(x, y, 0));
    v.sort(function (a, b) { return a - b; });
    var p = ${JSON.stringify(pcts)}, out = {};
    for (var i = 0; i < p.length; i++) out['p' + p[i]] = v[Math.min(v.length - 1, Math.floor(p[i] * v.length))];
    out.mad = (function () { var m = out['p0.5'], d = []; for (var i = 0; i < v.length; i++) d.push(Math.abs(v[i] - m)); d.sort(function (a, b) { return a - b; }); return d[Math.floor(d.length / 2)] * 1.4826; })();
    JSON.stringify(out);
  `);
  if (r.status === 'error') throw new Error('sampleMono failed: ' + (r.error?.message || 'unknown'));
  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

/** HSV (h in degrees, s, v) → [r,g,b] (same formula as NarrowbandHueCombination). */
function hsvToRgb(h, s, v) {
  const c = v * s, hh = ((h % 360) + 360) % 360 / 60, x = c * (1 - Math.abs(hh % 2 - 1)), m = v - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/**
 * Compute balance gains that bring S and O "signal span" (P99.5 − median) to a
 * fraction of H's, keeping each channel's background where it is.
 * Returns { s_gain, o_gain, stats } — advisory; the agent may override.
 */
export async function computeNarrowbandBalance(ctx, sId, hId, oId, opts = {}) {
  const sRatio = opts.s_ratio ?? 0.70;   // SII typically weaker — aim for 70% of H span
  const oRatio = opts.o_ratio ?? 0.85;   // OIII aim 85% of H span
  const st = {};
  for (const [k, id] of [['S', sId], ['H', hId], ['O', oId]]) if (id) st[k] = await sampleMono(ctx, id);
  const span = k => Math.max(1e-4, (st[k]?.['p0.995'] ?? 0) - (st[k]?.['p0.5'] ?? 0));
  const clampG = g => Math.max(0.5, Math.min(4.0, g));
  return {
    s_gain: st.S ? clampG(sRatio * span('H') / span('S')) : null,
    o_gain: st.O ? clampG(oRatio * span('H') / span('O')) : null,
    stats: st,
  };
}

/**
 * Build an RGB palette image from stretched starless S/H/O mono views.
 * opts: { palette, output_id, s_gain, o_gain, h_gain, auto_balance,
 *         hues: {S,H,O} (degrees, hue_screen), sat (hue_screen, default 0.9),
 *         hoo_o_weight }
 * Gains act on the signal above each channel's own background:
 *   X' = bgX + gain·(X − bgX)   — background level unchanged.
 */
export async function shoCombine(ctx, sId, hId, oId, opts = {}) {
  const palette = opts.palette || 'foraxx';
  const outId = opts.output_id || 'SHO';
  let sGain = opts.s_gain, oGain = opts.o_gain;
  const hGain = opts.h_gain ?? 1.0;
  let balance = null;
  if ((opts.auto_balance ?? true) && (sGain == null || oGain == null)) {
    balance = await computeNarrowbandBalance(ctx, palette === 'hoo' ? null : sId, hId, oId, opts);
    if (sGain == null) sGain = balance.s_gain ?? 1.0;
    if (oGain == null) oGain = balance.o_gain ?? 1.0;
  }
  sGain = sGain ?? 1.0; oGain = oGain ?? 1.0;

  // Balanced channel expressions (backgrounds measured inside PJSR).
  const S = `__sho_S`, H = `__sho_H`, O = `__sho_O`;
  const one = (x) => `~${x}`;
  const powE = (b, e) => `exp((${e})*ln(max(${b},0.00001)))`;
  let eR, eG, eB;
  if (palette === 'sho') {
    eR = S; eG = H; eB = O;
  } else if (palette === 'foraxx') {
    // R = (O^~O)·S + ~(O^~O)·H ;  G = ((O·H)^~(O·H))·H + ~((O·H)^~(O·H))·O ;  B = O
    const fo = powE(O, one(O));
    const fh = powE(`(${O}*${H})`, `~(${O}*${H})`);
    eR = `${fo}*${S} + (1-${fo})*${H}`;
    eG = `${fh}*${H} + (1-${fh})*${O}`;
    eB = O;
  } else if (palette === 'hue_screen') {
    const hues = Object.assign({ S: 0, H: 35, O: 195 }, opts.hues || {});
    const sat = opts.sat ?? 0.9;
    const cS = hsvToRgb(hues.S, sat, 1), cH = hsvToRgb(hues.H, sat, 1), cO = hsvToRgb(hues.O, sat, 1);
    // Tint only the signal ABOVE each channel's background (temps are background-
    // subtracted for this palette), then screen onto a neutral pedestal __BG__ —
    // screening three raw channels stacks their 0.1+ backgrounds into a brown cast.
    const ch = i => `~(~__BG__*~(${cH[i].toFixed(4)}*${H})*~(${cO[i].toFixed(4)}*${O})*~(${cS[i].toFixed(4)}*${S}))`;
    eR = ch(0); eG = ch(1); eB = ch(2);
  } else if (palette === 'hoo') {
    const w = opts.hoo_o_weight ?? 0.65;
    eR = H; eG = `${w}*${O} + ${1 - w}*${H}`; eB = O;
  } else {
    throw new Error(`shoCombine: unknown palette '${palette}' (sho|foraxx|hue_screen|hoo)`);
  }

  const needS = palette !== 'hoo';
  const r = await ctx.pjsr(`
    var ids = { S: '${needS ? sId : ''}', H: '${hId}', O: '${oId}' };
    var gains = { S: ${sGain}, H: ${hGain}, O: ${oGain} };
    var tmp = [], bgSum = 0, bgN = 0;
    for (var k in ids) {
      if (!ids[k]) continue;
      var src = ImageWindow.windowById(ids[k]);
      if (src.isNull) throw new Error('shoCombine: view not found: ' + ids[k]);
      var bg = src.mainView.image.median();
      bgSum += bg; bgN++;
      var old = ImageWindow.windowById('__sho_' + k); if (!old.isNull) old.forceClose();
      var PMb = new PixelMath;
      PMb.expression = ${palette === 'hue_screen'}
        ? gains[k] + '*(' + ids[k] + ' - ' + bg + ')/' + (1 - bg)
        : bg + ' + ' + gains[k] + '*(' + ids[k] + ' - ' + bg + ')';
      PMb.useSingleExpression = true; PMb.use64BitWorkingImage = true;
      PMb.truncate = true; PMb.truncateLower = 0; PMb.truncateUpper = 1;
      PMb.createNewImage = true; PMb.newImageId = '__sho_' + k;
      PMb.newImageColorSpace = PixelMath.prototype.Gray;
      PMb.executeOn(src.mainView);
      tmp.push('__sho_' + k);
    }
    var old2 = ImageWindow.windowById('${outId}'); if (!old2.isNull) old2.forceClose();
    var PM = new PixelMath;
    var BG = (bgSum / Math.max(1, bgN)).toFixed(6);
    PM.expression = "${eR}".replace(/__BG__/g, BG);
    PM.expression1 = "${eG}".replace(/__BG__/g, BG);
    PM.expression2 = "${eB}".replace(/__BG__/g, BG);
    PM.useSingleExpression = false; PM.use64BitWorkingImage = true;
    PM.truncate = true; PM.truncateLower = 0; PM.truncateUpper = 1;
    PM.createNewImage = true; PM.newImageId = '${outId}';
    PM.newImageColorSpace = PixelMath.prototype.RGB;
    PM.executeOn(ImageWindow.windowById('${hId}').mainView);
    for (var i = 0; i < tmp.length; i++) { var t = ImageWindow.windowById(tmp[i]); if (!t.isNull) t.forceClose(); }
    var out = ImageWindow.windowById('${outId}');
    out.show();
    var im = out.mainView.image, res = { median: im.median(), max: im.maximum(), ch: [] };
    for (var c = 0; c < 3; c++) { im.selectedChannel = c; res.ch.push({ med: im.median(), max: im.maximum() }); }
    im.resetSelections();
    JSON.stringify(res);
  `);
  if (r.status === 'error') throw new Error('shoCombine failed: ' + (r.error?.message || 'unknown'));
  const res = JSON.parse(r.outputs?.consoleOutput || '{}');
  return Object.assign(res, { viewId: outId, palette, s_gain: sGain, o_gain: oGain, h_gain: hGain, balance });
}

/**
 * Hubble-style hue shift with CurvesTransformation's hue→hue curve.
 * Folds the green band (Ha-dominated pixels) toward gold/orange while leaving
 * reds and cyan/blue untouched; optionally folds magenta toward red or blue.
 * PI hue scale: 0=red, 0.167=yellow, 0.333=green, 0.5=cyan, 0.667=blue, 0.833=magenta.
 * opts: { strength (0-1, default 0.85), green_target (default 0.12 = ~43° gold),
 *         cyan_keep (default 0.48), magenta: 'none'|'to_red'|'to_blue', magenta_strength }
 */
export async function shoHueShift(ctx, viewId, opts = {}) {
  const k = Math.max(0, Math.min(1, opts.strength ?? 0.85));
  const gT = opts.green_target ?? 0.12;
  const cyanKeep = opts.cyan_keep ?? 0.48;
  const lerp = (x, y) => +(x + k * (y - x)).toFixed(4);
  // Green band 0.20-0.42 compressed toward gT, smooth hand-off to cyan.
  const pts = [[0, 0], [0.06, 0.06], [0.16, lerp(0.16, gT - 0.01)], [0.25, lerp(0.25, gT + 0.005)],
    [0.33, lerp(0.33, gT + 0.02)], [0.40, lerp(0.40, gT + 0.06)], [cyanKeep, cyanKeep]];
  const m = opts.magenta || 'none';
  const mk = Math.max(0, Math.min(1, opts.magenta_strength ?? 0.6));
  if (m === 'to_blue') pts.push([0.70, 0.70], [0.83, +(0.83 + mk * (0.72 - 0.83)).toFixed(4)], [0.93, 0.93]);
  else if (m === 'to_red') pts.push([0.75, 0.75], [0.85, +(0.85 + mk * (0.97 - 0.85)).toFixed(4)], [0.95, +(0.95 + mk * (0.995 - 0.95)).toFixed(4)]);
  pts.push([1, 1]);
  // keep strictly increasing x and non-decreasing y
  for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1]) pts[i][1] = pts[i - 1][1];
  const r = await ctx.pjsr(`
    var P = new CurvesTransformation;
    P.H = ${JSON.stringify(pts)};
    P.Ht = CurvesTransformation.prototype.AkimaSubsplines;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    'ok';
  `);
  if (r.status === 'error') throw new Error('shoHueShift failed: ' + (r.error?.message || 'unknown'));
  return { curve: pts };
}

/**
 * Hue-selective saturation (ColorSaturation HS curve). boosts: {gold, red, cyan,
 * blue, green, magenta} in −1..+1 (0 = unchanged), applied at those hue anchors.
 */
export async function shoHueSaturation(ctx, viewId, boosts = {}) {
  const b = Object.assign({ red: 0, gold: 0, green: 0, cyan: 0, blue: 0, magenta: 0 }, boosts);
  const pts = [[0, b.red], [0.11, b.gold], [0.33, b.green], [0.50, b.cyan], [0.64, b.blue], [0.83, b.magenta], [1, b.red]];
  const r = await ctx.pjsr(`
    var P = new ColorSaturation;
    P.HS = ${JSON.stringify(pts)};
    P.HSt = ColorSaturation.prototype.AkimaSubsplines;
    P.hueShift = 0;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
    'ok';
  `);
  if (r.status === 'error') throw new Error('shoHueSaturation failed: ' + (r.error?.message || 'unknown'));
  return { curve: pts };
}

/**
 * PJSR helper: per-channel background level = median over the darkest 20% of a
 * 12×8 cell grid (cell medians by luminance). Unlike "pixels below the
 * luminance median" this has no channel selection bias (luminance is mostly G).
 */
const DARK_CELLS_JS = `
  function darkCellMedians(img) {
    var W = img.width, H = img.height, nx = 12, ny = 8, cells = [];
    for (var gy = 0; gy < ny; gy++) for (var gx = 0; gx < nx; gx++) {
      img.selectedRect = new Rect(Math.floor(gx*W/nx), Math.floor(gy*H/ny), Math.floor((gx+1)*W/nx), Math.floor((gy+1)*H/ny));
      var m = [];
      for (var c = 0; c < 3; c++) { img.selectedChannel = c; m.push(img.median()); }
      img.resetChannelSelection();
      cells.push({ l: 0.2126*m[0] + 0.7152*m[1] + 0.0722*m[2], m: m });
    }
    img.resetSelections();
    cells.sort(function (a, b) { return a.l - b.l; });
    var n = Math.max(3, Math.floor(cells.length * 0.2)), out = [0, 0, 0];
    for (var c = 0; c < 3; c++) { var v = []; for (var i = 0; i < n; i++) v.push(cells[i].m[c]); v.sort(function (a, b) { return a - b; }); out[c] = v[Math.floor(v.length / 2)]; }
    return out;
  }
`;

/**
 * Neutralize a palette image's background: measure per-channel sky level on the
 * darkest cells, then pull each channel down to the darkest channel's level with
 * a falloff toward highlights:  X' = X − d·((1−X)/(1−bg))^k, clipped at 0.
 * The sky becomes grey; nebula colors are barely touched (falloff k, default 2).
 * opts: { target ('min'|'mean'|number, default 'min'), falloff (default 2) }
 */
export async function neutralizePaletteBackground(ctx, viewId, opts = {}) {
  const k = opts.falloff ?? 2;
  const tgt = opts.target ?? 'min';
  const r = await ctx.pjsr(`
    ${DARK_CELLS_JS}
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('neutralizePaletteBackground: view not found: ${viewId}');
    var bg = darkCellMedians(w.mainView.image);
    var t = ${typeof tgt === 'number' ? tgt : (tgt === 'mean' ? '(bg[0]+bg[1]+bg[2])/3' : 'Math.min(bg[0],bg[1],bg[2])')};
    var ex = [];
    for (var c = 0; c < 3; c++) {
      var d = bg[c] - t;
      ex.push('max(0, $T - ' + d.toFixed(6) + '*exp(${k}*ln(max(0.000001, (1-$T)/' + (1 - bg[c]).toFixed(6) + '))))');
    }
    var P = new PixelMath; P.expression = ex[0]; P.expression1 = ex[1]; P.expression2 = ex[2];
    P.useSingleExpression = false; P.use64BitWorkingImage = true; P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
    P.createNewImage = false; P.executeOn(w.mainView);
    var after = darkCellMedians(w.mainView.image);
    JSON.stringify({ before: bg, after: after, target: t });
  `);
  if (r.status === 'error') throw new Error('neutralizePaletteBackground failed: ' + (r.error?.message || 'unknown'));
  return JSON.parse(r.outputs?.consoleOutput || '{}');
}

/**
 * Measure palette balance on subject pixels (luminance clearly above background):
 * fraction of pixels per hue family + median saturation per family. A Hubble-look
 * target is gold/orange-dominant with real cyan/blue, and little green or magenta.
 */
export async function measurePaletteBalancePjsr(ctx, viewId, opts = {}) {
  // opts.palette: 'hoo' switches the advice text (no foraxx/hue_screen/sho_hue_shift suggestions)
  const k = opts.sigma ?? 4;
  const r = await ctx.pjsr(`
    ${DARK_CELLS_JS}
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('measurePaletteBalance: view not found: ${viewId}');
    var img = w.mainView.image;
    if (!img.isColor) throw new Error('measurePaletteBalance: needs a color view');
    var W = img.width, H = img.height;
    var sx = Math.max(1, Math.floor(W / 400)), sy = Math.max(1, Math.floor(H / 270));
    var L = [], px = [];
    for (var y = 0; y < H; y += sy) for (var x = 0; x < W; x += sx) {
      var r = img.sample(x, y, 0), g = img.sample(x, y, 1), b = img.sample(x, y, 2);
      var l = 0.2126*r + 0.7152*g + 0.0722*b; L.push(l); px.push([r, g, b, l]);
    }
    var Ls = L.slice().sort(function (a, b) { return a - b; });
    var med = Ls[Math.floor(Ls.length / 2)];
    var d = []; for (var i = 0; i < Ls.length; i++) d.push(Math.abs(Ls[i] - med)); d.sort(function (a, b) { return a - b; });
    var thr = med + ${k} * 1.4826 * d[Math.floor(d.length / 2)];
    var fam = { red: [0,0], orange_gold: [0,0], yellow: [0,0], green: [0,0], cyan: [0,0], blue: [0,0], magenta: [0,0] };
    var bgR = 0, bgG = 0, bgB = 0, nb = 0, n = 0;
    for (var i = 0; i < px.length; i++) {
      var p = px[i];
      if (p[3] <= thr) { if (p[3] < med) { bgR += p[0]; bgG += p[1]; bgB += p[2]; nb++; } continue; }
      var mx = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]), c = mx - mn;
      var s = mx > 0 ? c / mx : 0, h = 0;
      if (c > 1e-6) {
        if (mx === p[0]) h = 60 * (((p[1] - p[2]) / c) % 6);
        else if (mx === p[1]) h = 60 * ((p[2] - p[0]) / c + 2);
        else h = 60 * ((p[0] - p[1]) / c + 4);
        if (h < 0) h += 360;
      }
      var f = (h < 18 || h >= 335) ? 'red' : h < 50 ? 'orange_gold' : h < 70 ? 'yellow' : h < 160 ? 'green' : h < 200 ? 'cyan' : h < 255 ? 'blue' : 'magenta';
      fam[f][0]++; fam[f][1] += s; n++;
    }
    var out = { subjectSamples: n, subjectFraction: n / px.length, families: {} };
    for (var f in fam) out.families[f] = { frac: n ? fam[f][0] / n : 0, meanSat: fam[f][0] ? fam[f][1] / fam[f][0] : 0 };
    out.bgRGB = darkCellMedians(img);
    JSON.stringify(out);
  `);
  if (r.status === 'error') throw new Error('measurePaletteBalance failed: ' + (r.error?.message || 'unknown'));
  const res = JSON.parse(r.outputs?.consoleOutput || '{}');
  const F = res.families || {};
  const pct = x => ((x || 0) * 100).toFixed(1) + '%';
  const warm = (F.red?.frac || 0) + (F.orange_gold?.frac || 0) + (F.yellow?.frac || 0);
  const cool = (F.cyan?.frac || 0) + (F.blue?.frac || 0);
  const notes = [];
  if (opts.palette === 'hoo') {
    // HOO (bicolor, no SII): the mapping cannot produce green/magenta; only OIII visibility is actionable.
    if (cool < 0.05) notes.push(`cyan/blue ${pct(cool)} — OIII not reading: raise o_gain or hoo_o_weight`);
  } else {
    if ((F.green?.frac || 0) > 0.10) notes.push(`green ${pct(F.green.frac)} of subject — Ha still reads green: increase sho_hue_shift strength or lower h_gain`);
    if ((F.magenta?.frac || 0) > 0.08) notes.push(`magenta ${pct(F.magenta.frac)} — fold magenta (sho_hue_shift magenta=to_red|to_blue) or lower s_gain/o_gain`);
    if (cool < 0.05) notes.push(`cyan/blue only ${pct(cool)} — OIII is not reading: raise o_gain or use foraxx/hue_screen`);
  }
  if (res.bgRGB) {
    const [br, bg, bb] = res.bgRGB, m = (br + bg + bb) / 3;
    if (m > 0 && Math.max(Math.abs(br - m), Math.abs(bg - m), Math.abs(bb - m)) / m > 0.08) notes.push(`background cast: RGB=${res.bgRGB.map(v => v.toFixed(4)).join('/')} — neutralize the background`);
  }
  res.warm = warm; res.cool = cool;
  res.summary = `subject ${pct(res.subjectFraction)} of frame | red ${pct(F.red?.frac)} gold ${pct(F.orange_gold?.frac)} yellow ${pct(F.yellow?.frac)} green ${pct(F.green?.frac)} cyan ${pct(F.cyan?.frac)} blue ${pct(F.blue?.frac)} magenta ${pct(F.magenta?.frac)} | warm ${pct(warm)} cool ${pct(cool)}` +
    (notes.length ? ' | ' + notes.join('; ') : ' | palette balanced');
  return res;
}

/**
 * Repair star residuals in STARLESS mono views — the comatic/halo WINGS that SXT
 * leaves beside aberrated edge stars (the core is removed, the wing 30-50px off
 * the star position is not, so the star layer alone cannot locate it).
 *
 *   B    = large-scale background (scale× median downsample → bicubic upsample)
 *   G    = view blurred (sigma 3) — noise-suppressed local level
 *   near = union of saved LINEAR star layers > threshold, dilated by `reach` px
 *   prot = 1 inside the nebula envelope: a very smooth (protect_scale× median)
 *          version of protect_view (Ha) above its sky level → never touched.
 *          Using Ha's envelope (not the channel's own B) also protects dark
 *          lanes and OIII-faint areas that sit inside the emission region.
 *   w    = near · (1−prot) · smoothstep(|G − B| from k1σ to k2σ), feathered
 *   X'   = X + w·(B − X)
 * Only background-region deviations near stars are flattened; nebula structure
 * is protected, and the spots end up under the RGB stars added later anyway.
 * opts: { threshold (6e-5), reach (px, default 40), scale (48), k1 (2), k2 (4),
 *         protect_view (default views[0]), protect_scale (128),
 *         protect_above (stretched units above median, default 0.015), feather (4), mask_id }
 */
export async function repairStarResiduals(ctx, viewIds, starLayerPaths, opts = {}) {
  const thr = opts.threshold ?? 6e-5;
  const reach = opts.reach ?? 40;
  const scale = opts.scale ?? 48;
  const k1 = opts.k1 ?? 2, k2 = opts.k2 ?? 4;
  const prot = opts.protect_above ?? 0.015;
  const protView = opts.protect_view || viewIds[0];
  const protScale = opts.protect_scale ?? 128;
  const feather = opts.feather ?? 4;
  const keepMask = !!opts.mask_id;
  const esc = p => p.replace(/'/g, "\\'");
  const r = await ctx.pjsr(`
    function pm(expr, target, newId) {
      var P = new PixelMath; P.expression = expr; P.useSingleExpression = true; P.use64BitWorkingImage = true;
      P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
      if (newId) { P.createNewImage = true; P.newImageId = newId; P.newImageColorSpace = PixelMath.prototype.Gray; } else P.createNewImage = false;
      P.executeOn(target.mainView);
    }
    function closeId(id) { var w = ImageWindow.windowById(id); if (!w.isNull) w.forceClose(); }
    function gauss(w, s) { var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = s; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(w.mainView); }
    var paths = ${JSON.stringify(starLayerPaths.map(esc))};
    var views = ${JSON.stringify(viewIds)};
    function smoothOf(srcImg, id, sc) {
      var W = srcImg.width, H = srcImg.height;
      var B = new ImageWindow(W, H, 1, 32, true, false, id);
      B.mainView.beginProcess(); B.mainView.image.assign(srcImg); B.mainView.endProcess();
      var IR = new IntegerResample; IR.zoomFactor = -sc; IR.downsamplingMode = IntegerResample.prototype.Median; IR.executeOn(B.mainView);
      var RS = new Resample; RS.mode = Resample.prototype.AbsolutePixels; RS.absoluteMode = Resample.prototype.ForceWidthAndHeight;
      RS.xSize = W; RS.ySize = H; RS.interpolation = Resample.prototype.BicubicSpline; RS.executeOn(B.mainView);
      return B;
    }
    ['__sr_near','__sr_B','__sr_G','__sr_w','__sr_prot','${opts.mask_id || '__sr_none'}'].forEach(closeId);
    var ref = ImageWindow.windowById(views[0]);
    // nebula envelope protection from a very smooth protect_view
    var pv = ImageWindow.windowById('${protView}').mainView.image;
    var pmed = pv.median();
    var PRT = smoothOf(pv, '__sr_prot', ${protScale});
    pm('min(1, max(0, ($T - ' + pmed + ') / ${prot}))', PRT);
    gauss(PRT, 40);
    // near-star zone: union of star layers, thresholded, grown by 'reach' px (blur + low threshold)
    pm('0', ref, '__sr_near');
    var near = ImageWindow.windowById('__sr_near');
    for (var i = 0; i < paths.length; i++) {
      var a = ImageWindow.open(paths[i]); var sw = null;
      for (var k = 0; k < a.length; k++) { if (a[k].mainView.id.indexOf('crop_mask') >= 0) a[k].forceClose(); else sw = a[k]; }
      sw.mainView.id = '__sr_star';
      pm('max(__sr_near, iif(__sr_star > ${thr}, 1, 0))', near);
      sw.forceClose();
    }
    gauss(near, ${reach} / 2);
    pm('iif($T > 0.02, 1, $T/0.02)', near);
    var out = [];
    for (var v = 0; v < views.length; v++) {
      var src = ImageWindow.windowById(views[v]);
      var img = src.mainView.image, W = img.width, H = img.height;
      var med = img.median(), sig = img.MAD() * 1.4826;
      var B = smoothOf(img, '__sr_B', ${scale});
      var G = new ImageWindow(W, H, 1, 32, true, false, '__sr_G');
      G.mainView.beginProcess(); G.mainView.image.assign(img); G.mainView.endProcess();
      gauss(G, 3);
      var gs = sig / 4;   // noise of G (sigma-3 Gaussian cuts white noise ~ 1/(2*sqrt(pi)*3) ≈ 1/10; /4 is conservative)
      var d1 = ${k1} * gs, d2 = ${k2} * gs;
      pm('__sr_near * (1 - __sr_prot) * min(1, max(0, (abs(__sr_G - __sr_B) - ' + d1 + ') / ' + (d2 - d1) + '))', src, '__sr_w');
      var Wt = ImageWindow.windowById('__sr_w');
      // grow slightly so the wing edges are covered, then feather
      var MT = new MorphologicalTransformation; MT.operator = MorphologicalTransformation.prototype.Dilation;
      MT.interlacingDistance = 1; MT.numberOfIterations = 2; MT.amount = 1.0; MT.structureSize = 5;
      MT.structureWayTable = [[[0,1,1,1,0, 1,1,1,1,1, 1,1,1,1,1, 1,1,1,1,1, 0,1,1,1,0]]];
      MT.executeOn(Wt.mainView);
      gauss(Wt, ${feather});
      var cov = Wt.mainView.image.mean();
      pm('$T + __sr_w * (__sr_B - $T)', src);
      out.push({ view: views[v], weightMean: cov, sigma: sig });
      B.forceClose(); G.forceClose();
      if (${keepMask} && v === views.length - 1) Wt.mainView.id = '${opts.mask_id || '__sr_none'}'; else Wt.forceClose();
    }
    near.forceClose(); PRT.forceClose();
    JSON.stringify(out);
  `);
  if (r.status === 'error') throw new Error('repairStarResiduals failed: ' + (r.error?.message || 'unknown'));
  return JSON.parse(r.outputs?.consoleOutput || '[]');
}

/**
 * Chroma-only smoothing: CIE Lab split → Gaussian blur on a and b → recombine.
 * Lightness (all luminance detail) is untouched. Removes the low-frequency color
 * mottle that weak, heavily gained channels (SII ×3-4) leave in palette images —
 * NXT's color mode does not reach that scale (30-80 px blotches at 0.5"/px).
 * opts: { sigma (default 8 px) }
 */
export async function chromaSmooth(ctx, viewId, opts = {}) {
  const sigma = opts.sigma ?? 8;
  const r = await ctx.pjsr(`
    var w = ImageWindow.windowById('${viewId}');
    if (w.isNull) throw new Error('chromaSmooth: view not found: ${viewId}');
    var CE = new ChannelExtraction; CE.colorSpace = ChannelExtraction.prototype.CIELab;
    CE.channels = [[true,'__cs_L'],[true,'__cs_a'],[true,'__cs_b']]; CE.sampleFormat = ChannelExtraction.prototype.f32;
    CE.executeOn(w.mainView);
    var ids = ['__cs_a','__cs_b'];
    for (var i = 0; i < 2; i++) { var C = new Convolution; C.mode = Convolution.prototype.Parametric; C.sigma = ${sigma}; C.shape = 2; C.aspectRatio = 1; C.rotationAngle = 0; C.executeOn(ImageWindow.windowById(ids[i]).mainView); }
    var CC = new ChannelCombination; CC.colorSpace = ChannelCombination.prototype.CIELab;
    CC.channels = [[true,'__cs_L'],[true,'__cs_a'],[true,'__cs_b']]; CC.executeOn(w.mainView);
    var x = ['__cs_L','__cs_a','__cs_b']; for (var i = 0; i < 3; i++) { var q = ImageWindow.windowById(x[i]); if (!q.isNull) q.forceClose(); }
    'ok';
  `);
  if (r.status === 'error') throw new Error('chromaSmooth failed: ' + (r.error?.message || 'unknown'));
  return { sigma };
}

/**
 * Reveal the faint outer nebulosity that the stretch + contrast curve crush to
 * black — USER-APPROVED on PACMAN ("really perfect", LIFT5, 2026-10-27).
 *
 * Mask (built from the view's own PRE-LIFT luminance, σ20):
 *   in-ramp  sky+in0 → sky+in1      (sky = darkest-cell luminance; PACMAN 0.0585)
 *   out-ramp out0 → out1            (halo ≤0.11 vs body ≥0.21 on PACMAN: 0.13 → 0.19)
 *   × Ha guard: smoothed Ha above its own sky + 0.0015 → +0.0145 (no sky-noise lift)
 *   feathered σ25. Zero over the body, so the body keeps its contrast.
 * Through the mask: lift curve → Hubble gold hue fold → hue saturation → LHE r250
 * (shapes in the faint cloud); then NXT 0.25 (whole view); then halo colour
 * (saturation curve + gold/red), which turns the lifted grey-brown into palette gold.
 * Also builds the BODY_EDGE mask from the same pre-lift luminance (for bodyEdgeContrast).
 * opts: { in0 (0.0035), in1 (0.0165), out0 (0.13), out1 (0.19), curve, lhe_amount (0.35),
 *         nxt (0.25), color (true), halo_mask_id ('HALO_MASK'), body_mask_id ('BODY_EDGE') }
 */
export async function liftFaintHalo(ctx, viewId, haId, opts = {}) {
  const o = Object.assign({ in0: 0.0035, in1: 0.0165, out0: 0.13, out1: 0.19, lhe_amount: 0.35, nxt: 0.25, color: true,
    halo_mask_id: 'HALO_MASK', body_mask_id: 'BODY_EDGE',
    curve: [[0,0],[0.06,0.066],[0.075,0.12],[0.10,0.17],[0.13,0.20],[0.2,0.25],[0.4,0.42],[1,1]] },
    // drop undefined keys: the tool handler forwards absent inputs as undefined, and Object.assign
    // would overwrite the defaults with them (→ "undefined"/NaN inside the PixelMath expression)
    Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)));
  const r = await ctx.pjsr(`
    ${DARK_CELLS_JS}
    function closeId(id){var w=ImageWindow.windowById(id);if(!w.isNull)w.forceClose();}
    function gauss(w,s){var C=new Convolution;C.mode=Convolution.prototype.Parametric;C.sigma=s;C.shape=2;C.aspectRatio=1;C.rotationAngle=0;C.executeOn(w.mainView);}
    function pm(expr,target,newId,sym){var P=new PixelMath;P.expression=expr;if(sym)P.symbols=sym;P.useSingleExpression=true;P.use64BitWorkingImage=true;P.truncate=true;P.truncateLower=0;P.truncateUpper=1;
      if(newId){P.createNewImage=true;P.newImageId=newId;P.newImageColorSpace=PixelMath.prototype.Gray;}else P.createNewImage=false;
      // PixelMath failures are silent (executeOn returns false, no image created) and surfaced later as
      // "executeOn(): Invalid argument type: View or Image object expected" — fail here with the expression instead.
      if(!P.executeOn(target.mainView) || (newId && ImageWindow.windowById(newId).isNull)) throw new Error('liftFaintHalo PixelMath failed on '+target.mainView.id+(newId?' -> '+newId:'')+': '+expr.substring(0,160));}
    function ss(v,a,b){ return 'min(1,max(0,('+v+'-'+a+')/'+(b-a)+'))'; }
    var V = ImageWindow.windowById('${viewId}'); if (V.isNull) throw new Error('liftFaintHalo: view not found: ${viewId}');
    var Hw = ImageWindow.windowById('${haId}'); if (Hw.isNull) throw new Error('liftFaintHalo: Ha view not found: ${haId}');
    ['__lh_lum','__lh_ha','${o.halo_mask_id}','${o.body_mask_id}'].forEach(closeId);
    var bg = darkCellMedians(V.mainView.image), sky = 0.2126*bg[0]+0.7152*bg[1]+0.0722*bg[2];
    // Ha sky from the darkest 20% of a 12x8 cell grid (NOT the global median: on a
    // field-filling nebula the median sits on faint halo, which made the guard start
    // too high and shrank the mask — PACMAN: global 0.120 vs true sky 0.1105).
    var hi = Hw.mainView.image, hsky = (function (img) { var W = img.width, H = img.height, v = [];
      for (var gy = 0; gy < 8; gy++) for (var gx = 0; gx < 12; gx++) { img.selectedRect = new Rect(Math.floor(gx*W/12), Math.floor(gy*H/8), Math.floor((gx+1)*W/12), Math.floor((gy+1)*H/8)); v.push(img.median()); }
      img.resetSelections(); v.sort(function (a, b) { return a - b; }); var n = Math.max(3, Math.floor(v.length * 0.2)); return v[Math.floor(n / 2)]; })(hi);
    pm('0.2126*${viewId}[0]+0.7152*${viewId}[1]+0.0722*${viewId}[2]', V, '__lh_lum');
    var Lw = ImageWindow.windowById('__lh_lum');
    // BODY_EDGE from pre-lift luminance (σ12): 0.11→0.16 in, 0.30→0.40 out
    pm('$T', Lw, '${o.body_mask_id}'); var BE = ImageWindow.windowById('${o.body_mask_id}'); gauss(BE, 12);
    pm('a='+ss('$T',0.11,0.16)+'; b='+ss('$T',0.30,0.40)+'; (a*a*(3-2*a))*(1-b*b*(3-2*b))', BE, null, 'a,b'); gauss(BE, 15);
    // HALO mask
    gauss(Lw, 20);
    pm('$T', Hw, '__lh_ha'); var Hs = ImageWindow.windowById('__lh_ha'); gauss(Hs, 20);
    pm('a='+ss('__lh_lum',sky+${o.in0},sky+${o.in1})+'; b='+ss('__lh_lum',${o.out0},${o.out1})+'; h='+ss('__lh_ha',hsky+0.0015,hsky+0.0145)+'; (a*a*(3-2*a))*(1-b*b*(3-2*b))*(h*h*(3-2*h))', Lw, '${o.halo_mask_id}', 'a,b,h');
    var M = ImageWindow.windowById('${o.halo_mask_id}'); gauss(M, 25);
    Lw.forceClose(); Hs.forceClose();
    // lift + (SHO: gold) + shapes through the halo mask
    V.mask = M; V.maskInverted = false;
    var C = new CurvesTransformation; C.K = ${JSON.stringify(o.curve)}; C.Kt = CurvesTransformation.prototype.AkimaSubsplines; C.executeOn(V.mainView);
    // SHO only: fold yellow/green toward Hubble gold. HOO (R=Ha, G/B=OIII) keeps its own red/teal hues.
    if (${o.palette === 'hoo' ? 'false' : 'true'}) { var HC = new CurvesTransformation; HC.H = [[0,0],[0.06,0.06],[0.16,0.11],[0.25,0.115],[0.33,0.13],[0.40,0.18],[0.50,0.50],[1,1]]; HC.Ht = CurvesTransformation.prototype.AkimaSubsplines; HC.executeOn(V.mainView); }
    if (${o.palette === 'hoo' ? 'false' : 'true'}) { var CS = new ColorSaturation; CS.HS = [[0,0.10],[0.11,0.25],[0.33,-0.2],[0.5,0.1],[0.64,0.1],[0.83,0],[1,0.10]]; CS.HSt = ColorSaturation.prototype.AkimaSubsplines; CS.executeOn(V.mainView); }
    if (${o.lhe_amount} > 0) { var P = new LocalHistogramEqualization; P.radius = 250; P.histogramBins = LocalHistogramEqualization.prototype.Bit12; P.slopeLimit = 2.0; P.amount = ${o.lhe_amount}; P.circularKernel = true; P.executeOn(V.mainView); }
    V.removeMask();
    if (${o.nxt} > 0) { var N = new NoiseXTerminator; N.denoise = ${o.nxt}; N.detail = 0.15; N.executeOn(V.mainView); }
    if (${o.color ? 'true' : 'false'}) {
      V.mask = M; V.maskInverted = false;
      var C2 = new CurvesTransformation; C2.S = [[0,0],[0.25,0.38],[0.6,0.75],[1,1]]; C2.St = CurvesTransformation.prototype.AkimaSubsplines; C2.executeOn(V.mainView);
      var CS2 = new ColorSaturation; CS2.HS = [[0,0.20],[0.11,0.30],[0.33,-0.25],[0.5,0.10],[0.64,0.15],[0.83,0],[1,0.20]]; CS2.HSt = ColorSaturation.prototype.AkimaSubsplines; CS2.executeOn(V.mainView);
      V.removeMask();
    }
    V.purge();
    JSON.stringify({ sky: sky, haSky: hsky, haloMaskMean: M.mainView.image.mean(), bodyMaskMean: BE.mainView.image.mean(), max: V.mainView.image.maximum() });
  `);
  if (r.status === 'error') throw new Error('liftFaintHalo failed: ' + (r.error?.message || 'unknown'));
  return Object.assign(JSON.parse(r.outputs?.consoleOutput || '{}'), { haloMaskId: o.halo_mask_id, bodyMaskId: o.body_mask_id });
}

/**
 * Restore the outer-body edge against a lifted halo: LHE r120 / 0.28 / slope 1.6
 * through the BODY_EDGE mask that liftFaintHalo built from the PRE-lift luminance
 * (USER-APPROVED PACMAN LIFT5). opts: { mask_id ('BODY_EDGE'), radius, amount, slope }
 */
export async function bodyEdgeContrast(ctx, viewId, opts = {}) {
  const maskId = opts.mask_id || 'BODY_EDGE';
  const r = await ctx.pjsr(`
    var V = ImageWindow.windowById('${viewId}'); var M = ImageWindow.windowById('${maskId}');
    if (V.isNull || M.isNull) throw new Error('bodyEdgeContrast: view or mask missing (${viewId}, ${maskId}) — run lift_faint_halo first');
    V.mask = M; V.maskInverted = false;
    var P = new LocalHistogramEqualization; P.radius = ${opts.radius ?? 120}; P.histogramBins = LocalHistogramEqualization.prototype.Bit12;
    P.slopeLimit = ${opts.slope ?? 1.6}; P.amount = ${opts.amount ?? 0.28}; P.circularKernel = true; P.executeOn(V.mainView);
    V.removeMask(); V.purge();
    'max=' + V.mainView.image.maximum().toFixed(3);
  `);
  if (r.status === 'error') throw new Error('bodyEdgeContrast failed: ' + (r.error?.message || 'unknown'));
  return { result: r.outputs?.consoleOutput };
}

/**
 * Tone DOWN the faint outer haze (the opposite of liftFaintHalo). USER-APPROVED on the
 * NGC6992 Veil (2026-11-03, "haze75"): the lifted grey-pink Ha/OIII fog around the arc was
 * "way too much"; compressing it toward the sky at strength 0.75 was kept as the final.
 * Mask = faint luminance (sky+haze_on, ramp haze_ramp) × (1 − grown bright-filament body:
 * lum > body_lo over body_ramp, σ body_grow, ×4, σ body_grow), feathered σ feather.
 * Per channel: X' = sky_c + (X − sky_c)·(1 − strength·mask). Filaments and the bright body
 * are untouched; the arc keeps a soft edge because the body band is protected.
 * Do NOT subtract a blurred/eroded "glow" layer instead: that dims the filament core and
 * leaves the outer haze (tried on the same image, rejected).
 * opts: { strength (0.75), haze_on (0.008), haze_ramp (0.03), body_lo (0.28), body_ramp (0.08),
 *         body_grow (40), feather (20), mask_id ('HAZE_MASK'), keep_mask (false) }
 */
export async function compressOuterHaze(ctx, viewId, opts = {}) {
  const o = Object.assign({ strength: 0.75, haze_on: 0.008, haze_ramp: 0.03, body_lo: 0.28, body_ramp: 0.08,
    body_grow: 40, feather: 20, mask_id: 'HAZE_MASK', keep_mask: false },
    Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)));
  if (!(o.strength >= 0 && o.strength <= 1)) throw new Error('compressOuterHaze: strength must be in [0,1]');
  const r = await ctx.pjsr(`
    ${DARK_CELLS_JS}
    function closeId(id){var w=ImageWindow.windowById(id);if(!w.isNull)w.forceClose();}
    function gauss(w,s){var C=new Convolution;C.mode=Convolution.prototype.Parametric;C.sigma=s;C.shape=2;C.aspectRatio=1;C.rotationAngle=0;C.executeOn(w.mainView);}
    function pm(expr,target,newId){var P=new PixelMath;P.expression=expr;P.useSingleExpression=true;P.truncate=true;P.truncateLower=0;P.truncateUpper=1;
      if(newId){P.createNewImage=true;P.newImageId=newId;P.newImageColorSpace=PixelMath.prototype.Gray;P.newImageSampleFormat=PixelMath.prototype.f32;}else P.createNewImage=false;
      if(!P.executeOn(target.mainView) || (newId && ImageWindow.windowById(newId).isNull)) throw new Error('compressOuterHaze PixelMath failed on '+target.mainView.id+': '+expr.substring(0,160));
      return ImageWindow.windowById(newId||target.mainView.id);}
    var V = ImageWindow.windowById('${viewId}'); if (V.isNull) throw new Error('compressOuterHaze: view not found: ${viewId}');
    if (V.mainView.image.numberOfChannels < 3) throw new Error('compressOuterHaze: colour view expected');
    ['__ch_lum','__ch_body','${o.mask_id}'].forEach(closeId);
    var sky = darkCellMedians(V.mainView.image), ls = 0.2126*sky[0]+0.7152*sky[1]+0.0722*sky[2];
    var L = pm('0.2126*${viewId}[0]+0.7152*${viewId}[1]+0.0722*${viewId}[2]', V, '__ch_lum'); gauss(L, 8);
    var B = pm('min(1,max(0,(__ch_lum-${o.body_lo})/${o.body_ramp}))', L, '__ch_body'); gauss(B, ${o.body_grow}); pm('min(1,$T*4)', B); gauss(B, ${o.body_grow});
    var M = pm('min(1,max(0,(__ch_lum-'+(ls+${o.haze_on})+')/${o.haze_ramp}))*(1-__ch_body)', L, '${o.mask_id}'); gauss(M, ${o.feather});
    var Q = new PixelMath; Q.useSingleExpression = false; Q.truncate = true; Q.truncateLower = 0; Q.truncateUpper = 1; Q.createNewImage = false;
    var e = []; for (var c = 0; c < 3; c++) e.push(sky[c]+'+($T['+c+']-'+sky[c]+')*(1-${o.strength}*${o.mask_id})');
    Q.expression = e[0]; Q.expression1 = e[1]; Q.expression2 = e[2];
    if (!Q.executeOn(V.mainView)) throw new Error('compressOuterHaze: compression PixelMath failed');
    var mm = M.mainView.image.mean();
    L.forceClose(); B.forceClose(); if (!${o.keep_mask ? 'true' : 'false'}) M.forceClose();
    V.purge();
    JSON.stringify({ sky: sky, skyLum: ls, hazeMaskMean: mm, median: V.mainView.image.median() });
  `);
  if (r.status === 'error') throw new Error('compressOuterHaze failed: ' + (r.error?.message || 'unknown'));
  return Object.assign(JSON.parse(r.outputs?.consoleOutput || '{}'), { strength: o.strength, maskId: o.keep_mask ? o.mask_id : null });
}


// Native-first wrapper (2026-11-10): Rust pixmetrics; the …Pjsr version above is the fallback.
export async function measurePaletteBalance(ctx, viewId, opts = {}) {
  return nativeOr(ctx, viewId, 'palette_balance', { opts }, () => measurePaletteBalancePjsr(ctx, viewId, opts));
}
