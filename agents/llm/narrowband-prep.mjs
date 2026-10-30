// ============================================================================
// Narrowband (SHO / HOO) deterministic prep — no LLM involvement
//
// Mono S/H/O masters → aligned → per-channel linear processing → starless →
// UNLINKED per-channel stretch → initial palette composite.
//
// Differences from the broadband prep (deterministic-prep.mjs):
//   - No SPCC / BackgroundNeutralization: false-color palettes have no
//     photometric white point. Color is a creative decision made later.
//   - Every channel is processed and stretched on its own: unlinked stretch is
//     the first normalization step (SII/OIII are 3-10x weaker than Ha).
//   - Gradient correction is MEASURED per channel and only applied when the
//     background actually varies (narrowband backgrounds are often flat, and
//     GC on an Ha field with a frame-filling faint halo eats real signal).
//   - Stars are extracted from every channel; NB star layers are saved to disk
//     (linear) so RGB stars can be added later — the starless palette keeps
//     the full, uncropped master geometry for that reason.
//
// Returns the same shape as runDeterministicPrep:
//   { targetName, views: { rgb, s, ha, o, stars? }, stats, previews, narrowband }
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { CACHE_DIR, fileFingerprint, linkOrCopy, openXisfAs } from './prep-cache-util.mjs';
import { measureDetailBaseline } from '../ops/subject-metrics.mjs';
import { measureBaselineTexture, recordPsfField } from '../ops/quality-gates.mjs';
import { getStats } from '../ops/stats.mjs';
import { setiStretch } from '../ops/stretch.mjs';
import { shoCombine, shoHueShift, measurePaletteBalance, repairStarResiduals } from '../ops/sho-palette.mjs';
import { runGC, runSCNR } from '../ops/gradient.mjs';

const __filename = fileURLToPath(import.meta.url);
const SHO_PALETTE_PATH = path.join(path.dirname(__filename), '..', 'ops', 'sho-palette.mjs');

/** Channel-affecting nb options: ONLY these enter the cache key (palette/hGain/hueShift/scnr only drive the cheap composite). */
export const NB_CHANNEL_OPTION_KEYS = ['nxtLinear', 'nxtPost', 'bxtNonstellar', 'gradientEdgeSigma', 'repairStarResiduals', 'forceAlign', 'stretchTarget'];

/**
 * Cache key of the narrowband channel chain (pure; no PixInsight).
 * sha256(narrowband-prep.mjs + sho-palette.mjs + fingerprints of S/Ha(H)/O + starless flag
 *        + resolved stretch target/headroom + channel-affecting nb options).
 */
export function computeNbCacheKey(F, nb, target, headroom) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(__filename, 'utf-8'));
  try { hash.update(fs.readFileSync(SHO_PALETTE_PATH, 'utf-8')); } catch { hash.update('no-sho-palette'); }
  hash.update(`S:${fileFingerprint(F.S)}|Ha:${fileFingerprint(F.Ha || F.H)}|O:${fileFingerprint(F.O)}|`);
  hash.update(`starless:${F.starless !== false}|target:${target}|headroom:${headroom}|`);
  const opt = {};
  for (const k of NB_CHANNEL_OPTION_KEYS) opt[k] = nb?.[k] ?? null;
  hash.update(JSON.stringify(opt));
  return hash.digest('hex').slice(0, 24);
}

/** Resolve per-channel NXT strengths: scalar -> per-channel map, per-channel entries win. */
function nxtMap(scalar, perChannel, fallback) {
  const out = {};
  for (const k of ['H', 'S', 'O']) {
    out[k] = (perChannel && typeof perChannel[k] === 'number') ? perChannel[k]
      : (typeof scalar === 'number') ? scalar : fallback[k];
  }
  return out;
}

/** Which narrowband workflow a config describes, or null for broadband. */
export function detectNarrowbandWorkflow(F) {
  const has = k => !!(F?.[k] && String(F[k]).trim());
  const hasH = has('Ha') || has('H');
  if (has('R') || has('G') || has('B')) return null;
  if (hasH && has('S') && has('O')) return 'SHO';
  if (hasH && has('O')) return 'HOO';
  return null;
}

/** Background flatness of a mono view: 8x8 grid of cell medians in units of pixel sigma. */
export async function backgroundGrid(ctx, viewId) {
  const r = await ctx.pjsr(`
    var img = ImageWindow.windowById('${viewId}').mainView.image;
    var W = img.width, H = img.height, n = 8;
    var gm = img.median(), gs = Math.max(1e-9, img.MAD() * 1.4826), cells = [];
    for (var gy = 0; gy < n; gy++) for (var gx = 0; gx < n; gx++) {
      img.selectedRect = new Rect(Math.floor(gx*W/n), Math.floor(gy*H/n), Math.floor((gx+1)*W/n), Math.floor((gy+1)*H/n));
      cells.push((img.median() - gm) / gs);
    }
    img.resetSelections();
    // Edge ring only (the subject usually sits inside): spread of border cells.
    var edge = [];
    for (var i = 0; i < cells.length; i++) { var gx = i % n, gy = Math.floor(i / n); if (gx === 0 || gy === 0 || gx === n-1 || gy === n-1) edge.push(cells[i]); }
    edge.sort(function (a, b) { return a - b; });
    JSON.stringify({ edgeSpread: edge[edge.length-1] - edge[0], edgeMin: edge[0], edgeMax: edge[edge.length-1] });
  `);
  return JSON.parse(r.outputs?.consoleOutput || '{"edgeSpread":0}');
}

/** Resolve the effective nb options + stretch target/headroom (profile-driven; F.narrowband overrides). */
export function resolveNbOptions(F, brief, workflow) {
  const profNxt = brief?.processingProfile?.tools?.NXT || {};
  const nb = Object.assign({
    // Initial palette. Classic SHO + hue shift + partial SCNR won on PACMAN
    // (Foraxx: red/cyan, no gold; hue_screen: OIII lost under gold).
    palette: workflow === 'HOO' ? 'hoo' : 'sho',
    hGain: 0.85,
    hueShift: { strength: 1.0, green_target: 0.10, cyan_keep: 0.50 },
    scnr: { amount: 0.6, preserveLightness: true },
    stretchTarget: null,          // per-channel median after stretch (default: profile target)
    gradientEdgeSigma: 1.5,       // apply GC only if border-cell spread exceeds this (pixel sigmas)
    // NXT strengths come from brief.processingProfile.tools.NXT (narrowband_palette):
    // denoise_linear / denoise_post_stretch scalars plus optional *_per_channel {H,S,O}.
    // SII is usually the weakest channel (PACMAN: span/noise 4 vs Ha 18) and gets a
    // 3-4x palette gain, so it needs the most post-stretch NXT. files.narrowband.nxtPost
    // / nxtLinear remain config overrides.
    nxtLinear: nxtMap(profNxt.denoise_linear, profNxt.denoise_linear_per_channel, { H: 0.25, S: 0.35, O: 0.35 }),
    nxtPost: nxtMap(profNxt.denoise_post_stretch, profNxt.denoise_post_stretch_per_channel, { H: 0.30, S: 0.60, O: 0.45 }),
    repairStarResiduals: true,  // flatten SXT wing residuals outside the nebula envelope
    bxtNonstellar: 0.60,
  }, F.narrowband || {});

  const pStretch = brief?.processingProfile?.stretch || {};
  const target = nb.stretchTarget ?? pStretch.target_median ?? 0.12;
  const headroom = pStretch.headroom ?? 0.08;
  return { nb, target, headroom };
}

const esc = p => String(p).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Try the NB channel cache. Returns true on hit (views FILTER_S/Ha/O open + result populated). */
async function loadNbCache(ctx, cacheDir, masters, result, outputDir, starless, log) {
  const metaPath = path.join(cacheDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return false;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { return false; }
  for (const m of masters) {
    const f = meta.files?.[m.id];
    if (!f || !fs.existsSync(path.join(cacheDir, f))) { log(`  NB cache INVALID: missing ${m.id}`); return false; }
  }
  const sl = meta.result?.narrowband?.starLayers || {};
  for (const k of Object.keys(sl)) {
    if (!fs.existsSync(path.join(cacheDir, `stars_linear_${k}.xisf`))) { log(`  NB cache INVALID: missing star layer ${k}`); return false; }
  }
  log(`\n[NB-PREP] NB cache HIT: ${path.basename(cacheDir)} (cached ${meta.cachedAt})`);
  const live = await ctx.listImages();
  for (const img of live) {
    if (masters.some(m => m.id === img.id) || img.id === result.targetName || /^stars_[HSO]$/.test(img.id)) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${img.id}');if(!w.isNull)w.forceClose();`);
    }
  }
  for (const m of masters) {
    await openXisfAs(ctx, path.join(cacheDir, meta.files[m.id]), m.id);
    log(`  Loaded ${m.id} from cache`);
  }
  // Self-contained run: link the cached files into <runDir>/prep and repoint paths there.
  const nbMeta = meta.result.narrowband || {};
  const starLayers = {};
  for (const k of Object.keys(sl)) starLayers[k] = linkOrCopy(path.join(cacheDir, `stars_linear_${k}.xisf`), path.join(outputDir, `stars_linear_${k}.xisf`));
  const linearStarless = {};
  for (const k of Object.keys(nbMeta.linearStarless || {})) {
    const cf = path.join(cacheDir, `FILTER_${k}_linear_starless.xisf`);
    if (fs.existsSync(cf)) linearStarless[k] = linkOrCopy(cf, path.join(outputDir, `FILTER_${k}_linear_starless.xisf`));
  }
  for (const m of masters) linkOrCopy(path.join(cacheDir, meta.files[m.id]), path.join(outputDir, meta.files[m.id]));
  Object.assign(result.narrowband, nbMeta, { starLayers, linearStarless });
  result.stats = meta.result.stats || {};
  result.narrowband.cacheHit = true;
  if (!starless && starLayers.H) {
    await openXisfAs(ctx, starLayers.H, 'stars_H');
    result.views.stars = 'stars_H';
    result.stats.stars = await getStats(ctx, 'stars_H');
  }
  return true;
}

/** Save the stretched starless channels (+ linear snapshots, star layers by hard link) to the NB cache. */
async function saveNbCache(ctx, cacheDir, masters, result, workflow, log) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const files = {};
  for (const m of masters) {
    const fileName = `${m.id}.xisf`;
    const fp = path.join(cacheDir, fileName);
    await ctx.pjsr(`var w=ImageWindow.windowById('${m.id}');if(!w.isNull){w.saveAs('${esc(fp)}',false,false,false,false);w.mainView.id='${m.id}';}`);
    files[m.id] = fileName;
  }
  for (const [k, p] of Object.entries(result.narrowband.starLayers || {})) {
    if (fs.existsSync(p)) linkOrCopy(p, path.join(cacheDir, `stars_linear_${k}.xisf`));
  }
  for (const [k, p] of Object.entries(result.narrowband.linearStarless || {})) {
    if (fs.existsSync(p)) linkOrCopy(p, path.join(cacheDir, `FILTER_${k}_linear_starless.xisf`));
  }
  const nbSave = { workflow, starLayers: result.narrowband.starLayers, gradient: result.narrowband.gradient, residualRepair: result.narrowband.residualRepair, linearStarless: result.narrowband.linearStarless };
  const stats = Object.assign({}, result.stats); delete stats.stars; delete stats.rgb;
  fs.writeFileSync(path.join(cacheDir, 'meta.json'), JSON.stringify({
    cachedAt: new Date().toISOString(), workflow, files,
    result: { stats, narrowband: nbSave },
    prepSeconds: result.narrowband.prepSeconds,
  }, null, 2));
  log(`  NB cache saved: ${cacheDir}`);
}

export async function runNarrowbandPrep(ctx, config, opts = {}) {
  const log = opts.log || console.log;
  const F = config.files;
  const workflow = detectNarrowbandWorkflow(F);
  if (!workflow) throw new Error('runNarrowbandPrep: config has no S/H/O (or H/O) masters');
  const targetName = F.targetName || 'Target';
  const outputDir = opts.outputDir || '/tmp/prep';
  fs.mkdirSync(outputDir, { recursive: true });
  const starless = F.starless !== false;   // narrowband default: deliver starless
  const { nb, target, headroom } = resolveNbOptions(F, opts.brief, workflow);
  log(`[NB-PREP] Workflow ${workflow}, palette=${nb.palette}, starless=${starless}, stretch target=${target}, headroom=${headroom}`);

  async function pjsrOrDie(script, stepName) {
    const r = await ctx.pjsr(script);
    if (r.status === 'error') throw new Error(`[NB-PREP] ${stepName} FAILED: ${r.error?.message || 'unknown error'}`);
    return r;
  }

  // Fail fast if the RC-Astro modules are missing (fresh PI installs lose them).
  const mods = await ctx.pjsr(`var o=[];var n=['BlurXTerminator','NoiseXTerminator','StarXTerminator'];for(var i=0;i<n.length;i++){var ok=false;try{ok=(typeof eval(n[i])!=='undefined');}catch(e){}if(!ok)o.push(n[i]);}o.join(',');`);
  const missing = (mods.outputs?.consoleOutput || '').trim();
  if (missing) throw new Error(`[NB-PREP] PixInsight is missing ${missing} — in PixInsight: Process > Modules > Install Modules > Search > Install (RCAstroSuite), then quit PI cleanly once so it persists (PI only saves the module list on a clean exit — a crash loses it).`);

  const masters = [{ key: 'H', path: F.Ha || F.H, id: 'FILTER_Ha' }, { key: 'O', path: F.O, id: 'FILTER_O' }];
  if (workflow === 'SHO') masters.push({ key: 'S', path: F.S, id: 'FILTER_S' });
  const result = { targetName, views: {}, stats: {}, previews: {}, narrowband: { workflow, palette: nb.palette, starLayers: {}, gradient: {}, linearStarless: {} } };

  // Result cache: channel chain (align -> BXT/NXT -> SXT -> stretch -> NXT post -> repair).
  const prepT0 = Date.now();
  const cacheKey = computeNbCacheKey(F, nb, target, headroom);
  const cacheDir = path.join(CACHE_DIR, `${cacheKey}_nb`);
  const cacheHit = (!nb.noCache && !opts.noCache) ? await loadNbCache(ctx, cacheDir, masters, result, outputDir, starless, log) : false;
  if (!cacheHit) log(`[NB-PREP] NB cache MISS (${cacheKey}) — running full channel chain`);

  async function runChain() {
  // --------------------------------------------------------------------------
  // Open masters (H is the alignment reference)
  // --------------------------------------------------------------------------

  log('\n[NB-PREP] Opening masters...');
  for (const img of await ctx.listImages()) {
    if (masters.some(m => m.id === img.id) || img.id === targetName) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${img.id}');if(!w.isNull)w.forceClose();`);
    }
  }
  for (const m of masters) {
    const before = (await ctx.listImages()).map(i => i.id);
    await ctx.send('open_image', '__internal__', { filePath: m.path });
    const newViews = (await ctx.listImages()).filter(i => !before.includes(i.id));
    const isAux = id => /crop_mask|rejection_low|rejection_high/i.test(id);
    const main = newViews.find(i => /integration/i.test(i.id) && !isAux(i.id)) || newViews.find(i => !isAux(i.id)) || newViews[0];
    for (const v of newViews) if (!main || v.id !== main.id) await ctx.pjsr(`var w=ImageWindow.windowById('${v.id}');if(!w.isNull)w.forceClose();`);
    if (main && main.id !== m.id) await ctx.pjsr(`var w=ImageWindow.windowById('${main.id}');if(!w.isNull)w.mainView.id='${m.id}';`);
    log(`  ${m.key}: ${path.basename(m.path)} → ${m.id}`);
  }

  // --------------------------------------------------------------------------
  // Align to H when geometry differs
  // --------------------------------------------------------------------------
  const dimOf = async id => (await ctx.pjsr(`var w=ImageWindow.windowById('${id}');w.isNull?'missing':w.mainView.image.width+'x'+w.mainView.image.height;`)).outputs?.consoleOutput;
  const refDim = await dimOf('FILTER_Ha');
  for (const m of masters.filter(x => x.key !== 'H')) {
    const d = await dimOf(m.id);
    if (d === refDim && !nb.forceAlign) continue;
    log(`  Aligning ${m.key} (${d}) to H (${refDim})...`);
    const tmpDir = path.join(opts.runDir || '/tmp', 'tmp_align_nb');
    fs.mkdirSync(tmpDir, { recursive: true });
    const esc = p => p.replace(/'/g, "\\'");
    const ref = path.join(tmpDir, 'FILTER_Ha.xisf'), tgt = path.join(tmpDir, `${m.id}.xisf`);
    await ctx.pjsr(`var w=ImageWindow.windowById('FILTER_Ha');w.saveAs('${esc(ref)}',false,false,false,false);w.mainView.id='FILTER_Ha';`);
    await ctx.pjsr(`var w=ImageWindow.windowById('${m.id}');w.saveAs('${esc(tgt)}',false,false,false,false);w.mainView.id='${m.id}';`);
    await pjsrOrDie(`
      var P=new StarAlignment;
      P.referenceImage='${esc(ref)}';P.referenceIsFile=true;
      P.targets=[[true,true,'${esc(tgt)}']];
      P.outputDirectory='${esc(tmpDir)}';P.outputPrefix='aligned_';P.outputPostfix='';
      P.overwriteExistingFiles=true;P.onError=StarAlignment.prototype.Continue;
      P.useTriangles=true;P.polygonSides=5;P.sensitivity=0.50;P.noGUIMessages=true;
      P.distortionCorrection=true;P.generateDrizzleData=false;
      P.executeGlobal();
    `, `StarAlignment ${m.key}`);
    const aligned = path.join(tmpDir, `aligned_${m.id}.xisf`);
    if (!fs.existsSync(aligned)) throw new Error(`[NB-PREP] alignment of ${m.key} produced no file`);
    await ctx.pjsr(`var w=ImageWindow.windowById('${m.id}');if(!w.isNull)w.forceClose();`);
    const before = (await ctx.listImages()).map(i => i.id);
    await ctx.send('open_image', '__internal__', { filePath: aligned });
    for (const v of (await ctx.listImages()).filter(i => !before.includes(i.id))) {
      if (/crop_mask/.test(v.id)) await ctx.pjsr(`var w=ImageWindow.windowById('${v.id}');if(!w.isNull)w.forceClose();`);
      else await ctx.pjsr(`var w=ImageWindow.windowById('${v.id}');if(!w.isNull)w.mainView.id='${m.id}';`);
    }
  }

  // --------------------------------------------------------------------------
  // Per-channel linear processing
  // --------------------------------------------------------------------------
  for (const m of masters) {
    log(`\n[NB-PREP] Linear processing ${m.key} (${m.id})...`);

    const g0 = await backgroundGrid(ctx, m.id);
    if (g0.edgeSpread > nb.gradientEdgeSigma) {
      await runGC(ctx, m.id);
      const g1 = await backgroundGrid(ctx, m.id);
      log(`  Gradient: border spread ${g0.edgeSpread.toFixed(2)}σ → GC → ${g1.edgeSpread.toFixed(2)}σ`);
      result.narrowband.gradient[m.key] = { before: g0.edgeSpread, after: g1.edgeSpread, applied: true };
    } else {
      log(`  Gradient: border spread ${g0.edgeSpread.toFixed(2)}σ ≤ ${nb.gradientEdgeSigma}σ — flat, GC skipped (protects faint halo)`);
      result.narrowband.gradient[m.key] = { before: g0.edgeSpread, applied: false };
    }

    // WI-26 D: PSF field map of the LINEAR Ha master before/after the BXT correct-only pass (advisory)
    if (m.key === 'H') await recordPsfField(ctx, m.id, opts.brief, 'before_bxt_correct', log);
    await pjsrOrDie(`var P=new BlurXTerminator;P.correct_only=true;P.adjust_star_halos=0.00;P.AI_file='';P.device=0;P.executeOn(ImageWindow.windowById('${m.id}').mainView);`, `BXT correct ${m.key}`);
    if (m.key === 'H') await recordPsfField(ctx, m.id, opts.brief, 'after_bxt_correct', log);
    await pjsrOrDie(`var P=new BlurXTerminator;P.correct_only=false;P.sharpen_stars=0.25;P.sharpen_nonstellar=${nb.bxtNonstellar};P.adjust_star_halos=0.00;P.auto_nonstellar_psf=true;P.AI_file='';P.device=0;P.executeOn(ImageWindow.windowById('${m.id}').mainView);`, `BXT sharpen ${m.key}`);
    const dn = nb.nxtLinear?.[m.key] ?? 0.30;
    await pjsrOrDie(`var P=new NoiseXTerminator;P.denoise=${dn};P.detail=0.15;P.executeOn(ImageWindow.windowById('${m.id}').mainView);`, `NXT linear ${m.key}`);
    log(`  BXT correct + sharpen(${nb.bxtNonstellar}) + NXT(${dn}) done`);

    const before = (await ctx.listImages()).map(i => i.id);
    await pjsrOrDie(`var P=new StarXTerminator;P.stars=true;P.unscreen=false;P.overlap=0.20;P.AI_file='';P.device=0;P.executeOn(ImageWindow.windowById('${m.id}').mainView);`, `SXT ${m.key}`);
    const starV = (await ctx.listImages()).find(i => !before.includes(i.id));
    if (starV) {
      const starPath = path.join(outputDir, `stars_linear_${m.key}.xisf`);
      await ctx.pjsr(`var w=ImageWindow.windowById('${starV.id}');w.saveAs('${starPath.replace(/'/g, "\\'")}',false,false,false,false);w.mainView.id='stars_${m.key}';`);
      result.narrowband.starLayers[m.key] = starPath;
      if (!starless && m.key === 'H') {
        result.views.stars = `stars_${m.key}`;
        result.stats.stars = await getStats(ctx, result.views.stars);
        if ((result.stats.stars?.median ?? 0) >= 0.001) {
          process.stderr.write(`[NB-PREP] WARNING: star layer ${result.views.stars} median=${result.stats.stars.median.toExponential(2)} >= 0.001 — it may not be linear.\n`);
        }
      }
      else await ctx.pjsr(`var w=ImageWindow.windowById('stars_${m.key}');if(!w.isNull)w.forceClose();`);
      log(`  SXT: starless ${m.id}; linear stars saved → ${path.basename(starPath)}`);
    }
    // Linear starless snapshot (restore point for reload_narrowband_channel).
    const linPath = path.join(outputDir, `FILTER_${m.key}_linear_starless.xisf`);
    await pjsrOrDie(`var w=ImageWindow.windowById('${m.id}');w.saveAs('${esc(linPath)}',false,false,false,false);w.mainView.id='${m.id}';`, `linear snapshot ${m.key}`);
    result.narrowband.linearStarless[m.key] = linPath;
    await ctx.pjsr(`var w=ImageWindow.windowById('${m.id}');if(!w.isNull)w.purge();`);
  }

  // --------------------------------------------------------------------------
  // Unlinked per-channel stretch (first normalization step)
  // --------------------------------------------------------------------------
  log(`\n[NB-PREP] Unlinked Seti stretch per channel (target=${target})...`);
  for (const m of masters) {
    await setiStretch(ctx, m.id, { targetMedian: target, hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: headroom });
    result.stats[m.key.toLowerCase() === 'h' ? 'ha' : m.key.toLowerCase()] = await getStats(ctx, m.id);
    log(`  ${m.key}: median=${(await getStats(ctx, m.id)).median.toFixed(4)}`);
  }
  // Per-channel post-stretch denoise (before palette gains amplify the noise)
  for (const m of masters) {
    const dn = nb.nxtPost?.[m.key];
    if (!dn) continue;
    await pjsrOrDie(`var P=new NoiseXTerminator;P.denoise=${dn};P.detail=0.15;P.executeOn(ImageWindow.windowById('${m.id}').mainView);`, `NXT post ${m.key}`);
    log(`  NXT post-stretch ${m.key}: ${dn}`);
  }

  // Star-residual repair: SXT leaves comatic wings beside aberrated edge stars
  // (fast reducers on full-frame sensors). Only acts near stars OUTSIDE the Ha
  // envelope — the nebula / center is never touched.
  if (nb.repairStarResiduals && Object.keys(result.narrowband.starLayers).length) {
    const rep = await repairStarResiduals(ctx, masters.map(m => m.id), Object.values(result.narrowband.starLayers), { protect_view: 'FILTER_Ha' });
    log(`  Star-residual repair: ${rep.map(x => `${x.view} ${(x.weightMean * 100).toFixed(2)}%`).join(', ')} of pixels (outside nebula only)`);
    result.narrowband.residualRepair = rep;
  }

  }   // end runChain

  if (!cacheHit) {
    await runChain();
    result.narrowband.prepSeconds = Math.round((Date.now() - prepT0) / 1000);
    log(`  [NB-PREP] channel chain took ${result.narrowband.prepSeconds}s`);
    try { await saveNbCache(ctx, cacheDir, masters, result, workflow, log); }
    catch (e) { log(`  [NB-PREP] NB cache save skipped: ${e.message}`); }
    // Self-contained run dir: stretched channels alongside the snapshots.
    for (const m of masters) {
      const cf = path.join(cacheDir, `${m.id}.xisf`);
      if (fs.existsSync(cf)) { try { linkOrCopy(cf, path.join(outputDir, `${m.id}.xisf`)); } catch { /* */ } }
    }
  }
  result.narrowband.prepParams = {
    nxtLinear: nb.nxtLinear, nxtPost: nb.nxtPost, stretchTarget: target, headroom,
    hueShift: nb.hueShift, scnr: nb.scnr, hGain: nb.hGain, bxtNonstellar: nb.bxtNonstellar,
  };
  try { fs.writeFileSync(path.join(outputDir, 'nb-prep.json'), JSON.stringify({ narrowband: result.narrowband, stats: { s: result.stats.s, ha: result.stats.ha, o: result.stats.o } }, null, 2)); } catch { /* */ }
  if (opts.brief) opts.brief._nbPrep = { linearStarless: result.narrowband.linearStarless, prepParams: result.narrowband.prepParams, prepDir: outputDir };

  result.views.ha = 'FILTER_Ha';
  result.views.o = 'FILTER_O';
  if (workflow === 'SHO') result.views.s = 'FILTER_S';

  // --------------------------------------------------------------------------
  // Initial palette composite (the agent can rebuild with sho_combine)
  // --------------------------------------------------------------------------
  log(`\n[NB-PREP] Initial palette: ${nb.palette}`);
  const comb = await shoCombine(ctx, workflow === 'SHO' ? 'FILTER_S' : null, 'FILTER_Ha', 'FILTER_O', { palette: nb.palette, output_id: targetName, h_gain: nb.palette === 'sho' ? nb.hGain : undefined });
  if (nb.palette === 'sho') {
    if (nb.hueShift) await shoHueShift(ctx, targetName, nb.hueShift);
    if (nb.scnr) await runSCNR(ctx, targetName, nb.scnr);
    log(`  Hue shift ${JSON.stringify(nb.hueShift)} + SCNR ${JSON.stringify(nb.scnr)}`);
  }
  log(`  ${targetName}: median=${comb.median.toFixed(4)}, gains S=${comb.s_gain?.toFixed(2)} O=${comb.o_gain?.toFixed(2)}`);
  const bal = await measurePaletteBalance(ctx, targetName);
  log(`  Palette: ${bal.summary}`);
  result.narrowband.initialBalance = bal.summary;
  result.narrowband.gains = { s: comb.s_gain, o: comb.o_gain };
  result.views.rgb = targetName;
  result.stats.rgb = await getStats(ctx, targetName);

  const pv = path.join(outputDir, 'base_palette.jpg');
  await ctx.pjsr(`var w=ImageWindow.windowById('${targetName}');if(!w.isNull){w.saveAs('${pv.replace(/'/g, "\\'")}',false,false,false,false);w.mainView.id='${targetName}';}`);
  result.previews.rgb = pv;

  try {
    result.baselineDetail = await measureDetailBaseline(ctx, { rgb: targetName }, { runDir: opts.runDir, log });
    if (opts.brief) { opts.brief._baselineDetail = result.baselineDetail; opts.brief._hasL = false; }
  } catch (e) { log(`  [NB-PREP] baseline detail failed: ${e.message}`); }

  // WI-26 C: deterministic highlight-texture baseline (palette RGB + Ha); stores brief._roi/_baselineTexture
  result.baselineTexture = await measureBaselineTexture(ctx, { rgb: targetName, ha: 'FILTER_Ha' }, { runDir: opts.runDir || outputDir, brief: opts.brief, log });
  if (opts.brief?._psfPrep) {
    result.narrowband.psf = opts.brief._psfPrep;
    const pa = opts.brief._psfPrep.after_bxt_correct || opts.brief._psfPrep.before_bxt_correct;
    if (pa) log(`  PSF field (Ha): verdict=${pa.verdict ?? 'n/a'}${pa.crop_box ? `, crop_box x ${pa.crop_box.x0}-${pa.crop_box.x1} y ${pa.crop_box.y0}-${pa.crop_box.y1}` : ''} (advisory; user crop only)`);
  }

  log('\n[NB-PREP] === NARROWBAND PREP COMPLETE ===');
  return result;
}
