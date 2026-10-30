// ============================================================================
// Deterministic Prep — No LLM involvement
//
// Opens masters, aligns, combines RGB, runs the canonical linear sequence,
// produces stable working assets. Zero LLM turns spent on file hygiene.
//
// CACHE SYSTEM: hashes (script content + input file fingerprints) to skip
// redundant processing. Same inputs + same code = same outputs.
// ============================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getStats, measureUniformity } from '../ops/stats.mjs';
import { setiStretch } from '../ops/stretch.mjs';
import { runGC } from '../ops/gradient.mjs';
import { createLumMask } from '../ops/masks.mjs';
import { savePreview } from '../ops/preview.mjs';
import { measureDetailBaseline } from '../ops/subject-metrics.mjs';
import { measureBaselineTexture, recordPsfField } from '../ops/quality-gates.mjs';
import { cloneImage, closeImage, purgeUndoHistory } from '../ops/image-mgmt.mjs';
import { detectNarrowbandWorkflow, runNarrowbandPrep } from './narrowband-prep.mjs';
import { CACHE_DIR, fileFingerprint } from './prep-cache-util.mjs';

const __filename = fileURLToPath(import.meta.url);
/**
 * Compute the cache key for a given config.
 * Combines: prep script hash + fingerprint of each input master.
 */
function computeCacheKey(config, brief) {
  const hash = crypto.createHash('sha256');
  // Hash this script's content
  hash.update(fs.readFileSync(__filename, 'utf-8'));
  // Hash each input file fingerprint
  const F = config.files;
  for (const key of ['R', 'G', 'B', 'L', 'Ha']) {
    const fp = fileFingerprint(F[key]);
    hash.update(`${key}:${fp}|`);
  }
  // Hash stretch parameters from processing profile (invalidate when profile changes)
  const pp = brief?.processingProfile;
  if (pp?.stretch) {
    hash.update(`stretch:${pp.stretch.target_median}:${pp.stretch.headroom}|`);
  }
  return hash.digest('hex').slice(0, 24);
}

/**
 * Try to load prep results from cache.
 * Returns the result object if cache hit, null if miss.
 */
async function loadFromCache(ctx, config, cacheKey, log) {
  const cacheDir = path.join(CACHE_DIR, cacheKey);
  const metaPath = path.join(cacheDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  log(`\n[PREP CACHE] Cache HIT: ${cacheKey}`);
  log(`  Cached at: ${meta.cachedAt}`);

  // Verify all cached XISF files exist
  for (const [viewId, fileName] of Object.entries(meta.files)) {
    const filePath = path.join(cacheDir, fileName);
    if (!fs.existsSync(filePath)) {
      log(`  Cache INVALID: missing ${fileName}`);
      return null;
    }
  }

  // Close all open images first
  const existingImgs = await ctx.listImages();
  for (const img of existingImgs) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${img.id}');if(!w.isNull)w.forceClose();`).catch(() => {});
  }

  // Load each cached XISF into PixInsight
  for (const [viewId, fileName] of Object.entries(meta.files)) {
    const filePath = path.join(cacheDir, fileName);
    log(`  Loading: ${viewId} from ${fileName}`);
    await ctx.send('open_image', '__internal__', { filePath });
    // Close crop masks
    const imgs = await ctx.listImages();
    for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
    }
    // Rename to expected view ID
    const allImgs = await ctx.listImages();
    const baseName = path.basename(filePath, '.xisf').replace(/[^a-zA-Z0-9_]/g, '_');
    const loaded = allImgs.find(i => i.id !== viewId && (i.id.includes(baseName) || !Object.values(meta.files).some(f => f.startsWith(i.id))));
    if (loaded && loaded.id !== viewId) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${loaded.id}');if(!w.isNull)w.mainView.id='${viewId}';`);
    }
  }

  log(`  All ${Object.keys(meta.files).length} views loaded from cache.\n`);
  return meta.result;
}

/**
 * Save prep results to cache.
 */
async function saveToCache(ctx, config, cacheKey, result, log) {
  const cacheDir = path.join(CACHE_DIR, cacheKey);
  fs.mkdirSync(cacheDir, { recursive: true });

  const files = {};

  // Save each working view as XISF
  for (const [key, viewId] of Object.entries(result.views)) {
    if (!viewId) continue;
    const fileName = `${viewId}.xisf`;
    const filePath = path.join(cacheDir, fileName);
    await ctx.pjsr(`
      var w=ImageWindow.windowById('${viewId}');
      if(!w.isNull){
        w.saveAs('${filePath.replace(/'/g, "\\'")}',false,false,false,false);
        w.mainView.id='${viewId}';
      }
    `);
    files[viewId] = fileName;
    log(`  Cached: ${viewId} → ${fileName}`);
  }

  // Write metadata
  const meta = {
    cacheKey,
    cachedAt: new Date().toISOString(),
    config: { targetName: config.files?.targetName, workflow: Object.keys(config.files).filter(k => typeof config.files[k] === 'string' && config.files[k].trim()).join('+') },
    files,
    result,
  };
  fs.writeFileSync(path.join(cacheDir, 'meta.json'), JSON.stringify(meta, null, 2));
  log(`  Cache saved: ${cacheDir}`);
}

/**
 * AUTOCROP — trim the pure-black alignment-fill border AND the low-coverage
 * feathered edge of full-frame stacks (noisy/bright hard-edged wedge). Measures
 * the box on RGB+L (20th-pct interior grid reference so the subject doesn't
 * inflate the noise floor), then DynamicCrops RGB+L to the same box.
 * MUST run AFTER SPCC: cropping drops the astrometric solution in this PI build.
 */
// PJSR snippet: clear the astrometric solution on window `w` BEFORE any DynamicCrop.
// In this PI build DynamicCrop on a WCS-bearing view pops a modal "astrometry will be
// lost on this view" confirmation that BLOCKS the headless pipeline (looks like a 20-min
// hang / run_script timeout until someone clicks it). SPCC has already consumed the WCS
// by the time we crop, so dropping it here is safe and removes the prompt.
const WCS_CLEAR = `
  try { if (w.hasAstrometricSolution) w.clearAstrometricSolution(); } catch(_e){}
`;

async function autoCropViews(ctx, { targetName, hasL, log }) {
  const measureIds = [targetName].concat(hasL ? ['FILTER_L'] : []);
  // Crop the narrowband channels with the SAME box, or they stay offset from RGB/L by the trim
  // (Ha was 148x444 px off on IC5146, 2026-10-30; one agent compensated by hand, one did not).
  const cropIds = measureIds.slice();
  try {
    const present = await ctx.pjsr(`['FILTER_Ha','FILTER_S','FILTER_O'].filter(function(id){ var w = ImageWindow.windowById(id); var t = ImageWindow.windowById('${targetName}'); return !w.isNull && !t.isNull && w.mainView.image.width === t.mainView.image.width && w.mainView.image.height === t.mainView.image.height; }).join(',')`);
    for (const id of String(present.outputs?.consoleOutput || '').split(',').filter(Boolean)) cropIds.push(id);
    if (cropIds.length > measureIds.length) log(`  autocrop also trims: ${cropIds.slice(measureIds.length).join(', ')}`);
  } catch { /* */ }
  const boxes = [];
  for (const id of measureIds) {
    const r = await ctx.pjsr(`
      var w=ImageWindow.windowById('${id}'); var img=w.mainView.image;
      var W=img.width, Hh=img.height, isC=img.isColor, thr=1e-4;
      function L(x,y){ if(isC) return 0.3*img.sample(x,y,0)+0.59*img.sample(x,y,1)+0.11*img.sample(x,y,2); return img.sample(x,y); }
      var top=0;        while(top<Hh){    img.selectedRect=new Rect(0,top,W,top+1);          if(img.maximum()>thr)break; top++; }
      var bottom=Hh-1;  while(bottom>top){ img.selectedRect=new Rect(0,bottom,W,bottom+1);    if(img.maximum()>thr)break; bottom--; }
      var left=0;       while(left<W){    img.selectedRect=new Rect(left,0,left+1,Hh);        if(img.maximum()>thr)break; left++; }
      var right=W-1;    while(right>left){ img.selectedRect=new Rect(right,0,right+1,Hh);      if(img.maximum()>thr)break; right--; }
      img.resetRectSelection();
      function stats(x0,y0,x1,y1){ var v=[]; var sx=Math.max(1,Math.floor((x1-x0)/100)), sy=Math.max(1,Math.floor((y1-y0)/100)); for(var y=y0;y<y1;y+=sy){ for(var x=x0;x<x1;x+=sx){ v.push(L(x,y)); } } if(v.length<3) return {med:0,mad:0}; v.sort(function(a,b){return a-b;}); var m=v[Math.floor(v.length/2)]; var d=[]; for(var i=0;i<v.length;i++) d.push(Math.abs(v[i]-m)); d.sort(function(a,b){return a-b;}); return {med:m, mad:d[Math.floor(d.length/2)]*1.4826}; }
      var gm=[], gd=[];
      for(var gy=0; gy<6; gy++){ for(var gx=0; gx<6; gx++){
        var px0=Math.floor(W*(0.20+gx*0.10)), py0=Math.floor(Hh*(0.20+gy*0.10));
        var st=stats(px0, py0, px0+Math.floor(W*0.06), py0+Math.floor(Hh*0.06));
        gm.push(st.med); gd.push(st.mad);
      } }
      gm.sort(function(a,b){return a-b;}); gd.sort(function(a,b){return a-b;});
      var bgMed=gm[Math.floor(gm.length*0.2)], bgMad=gd[Math.floor(gd.length*0.2)];
      var madThr=1.8*bgMad, medThr=bgMed+4*bgMad;
      var bandV=Math.max(6,Math.floor(Hh*0.006)), bandH2=Math.max(6,Math.floor(W*0.006));
      var capV=Math.floor(Hh*0.18), capH=Math.floor(W*0.18);
      while(top < capV){ var s=stats(left, top, right, top+bandV); if(s.mad<=madThr && s.med<=medThr) break; top+=bandV; }
      while((Hh-1-bottom) < capV){ var s=stats(left, bottom-bandV, right, bottom); if(s.mad<=madThr && s.med<=medThr) break; bottom-=bandV; }
      while(left < capH){ var s=stats(left, top, left+bandH2, bottom); if(s.mad<=madThr && s.med<=medThr) break; left+=bandH2; }
      while((W-1-right) < capH){ var s=stats(right-bandH2, top, right, bottom); if(s.mad<=madThr && s.med<=medThr) break; right-=bandH2; }
      JSON.stringify({W:W,H:Hh,left:left,top:top,right:right,bottom:bottom,intMad:bgMad,intMed:bgMed});
    `);
    const b = JSON.parse(r.outputs?.consoleOutput?.trim() || '{}');
    if (b.W) { boxes.push(b); log(`  ${id}: trim L${b.left} T${b.top} R${b.W-1-b.right} B${b.H-1-b.bottom} (intMAD=${(b.intMad||0).toFixed(4)})`); }
  }
  if (!boxes.length) return;
  const W = boxes[0].W, H = boxes[0].H, margin = 3;
  let left = Math.max(...boxes.map(b => b.left));
  let top = Math.max(...boxes.map(b => b.top));
  let right = Math.min(...boxes.map(b => b.right));
  let bottom = Math.min(...boxes.map(b => b.bottom));
  if (left > 0) left = Math.min(left + margin, W - 1);
  if (top > 0) top = Math.min(top + margin, H - 1);
  if (right < W - 1) right = Math.max(right - margin, 0);
  if (bottom < H - 1) bottom = Math.max(bottom - margin, 0);
  const cropW = right - left + 1, cropH = bottom - top + 1;
  if (cropW > 0 && cropH > 0 && (cropW < W || cropH < H)) {
    const cx = (left + right + 1) / 2 / W, cy = (top + bottom + 1) / 2 / H;
    const fw = cropW / W, fh = cropH / H;
    for (const id of cropIds) {
      const cr = await ctx.pjsr(`
        var w=ImageWindow.windowById('${id}');
        ${WCS_CLEAR}
        var _stillWcs = w.hasAstrometricSolution;
        var P=new DynamicCrop;
        P.centerX=${cx}; P.centerY=${cy}; P.width=${fw}; P.height=${fh};
        P.angle=0; P.scaleX=1; P.scaleY=1;
        P.executeOn(w.mainView);
        _stillWcs ? 'cropped_WCS_NOT_CLEARED' : 'cropped_clean';
      `);
      const tag = cr.outputs?.consoleOutput?.trim();
      if (tag === 'cropped_WCS_NOT_CLEARED') log(`  [WARN] ${id}: WCS not cleared before crop — a modal may have blocked. Check WCS_CLEAR API.`);
    }
    log(`  Cropped ${W}x${H} → ${cropW}x${cropH} (removed ${W-cropW}px W, ${H-cropH}px H)`);
  } else {
    log('  No border detected — full frame kept.');
  }
}

/**
 * Run deterministic prep on a config.
 * Returns { targetName, views: { rgb, l, ha, stars, starless_l }, stats, previews }
 *
 * @param {object} ctx - Bridge context
 * @param {object} config - Pipeline config
 * @param {object} opts - { outputDir, log }
 */
/**
 * Resolve BXT sharpen settings from the profile (WI-23). Sharpen runs only when
 * correct_only === false; strength falls back to 0.70 (the baseline all approved
 * images were produced with).
 */
export function resolveBxtOptions(brief) {
  const b = brief?.processingProfile?.tools?.BXT || {};
  const s = b.sharpen_nonstellar;
  return {
    correct_only: b.correct_only,
    sharpen_nonstellar: (typeof s === 'number' && isFinite(s)) ? s : 0.70,
  };
}

/** Number literal with at least 2 decimals (keeps the PJSR text identical to the legacy 0.70). */
function fmtNum(x) {
  const s = String(x);
  if (!s.includes('.')) return s + '.00';
  return /\.\d$/.test(s) ? s + '0' : s;
}

/** PJSR for the BXT sharpen step on a view, or null when the profile says correct-only. */
export function bxtSharpenPjsr(viewId, bxt) {
  if (!bxt || bxt.correct_only !== false) return null;
  return `
    var P=new BlurXTerminator;
    P.correct_only=false;P.sharpen_nonstellar=${fmtNum(bxt.sharpen_nonstellar)};P.adjust_star_halos=0.00;
    P.AI_file='';P.device=0;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `;
}

/** Seti HDR params from the profile stretch block. */
export function resolveHdrOptions(brief) {
  const s = brief?.processingProfile?.stretch || {};
  return { hdrAmount: s.hdr_amount ?? 0.25, hdrKnee: s.hdr_knee ?? 0.35 };
}

export async function runDeterministicPrep(ctx, config, opts = {}) {
  const log = opts.log || console.log;
  const F = config.files;
  // Mono narrowband masters (SHO / HOO) have their own prep: no SPCC, unlinked
  // per-channel stretch, palette composite. See narrowband-prep.mjs.
  if (detectNarrowbandWorkflow(F)) return runNarrowbandPrep(ctx, config, opts);
  const targetName = F.targetName || 'Target';
  const hasL = !!(F.L?.trim());
  const hasHa = !!(F.Ha?.trim());
  const outputDir = opts.outputDir || '/tmp/prep';
  fs.mkdirSync(outputDir, { recursive: true });

  // Extract stretch parameters from processing profile (via brief)
  const brief = opts.brief;
  const profileStretch = brief?.processingProfile?.stretch || {};
  const rgbTarget = profileStretch.target_median || 0.10;
  const headroom = profileStretch.headroom || 0.05;
  const lTarget = Math.min(0.30, rgbTarget * 3);  // L always brighter than RGB for LRGB
  const haTarget = rgbTarget * 1.5;
  log(`[PREP] Stretch targets from profile: RGB=${rgbTarget}, L=${lTarget.toFixed(2)}, Ha=${haTarget.toFixed(2)}, headroom=${headroom}`);

  // Linear/post-stretch NXT strengths from the profile (was hardcoded 0.30/0.25, which
  // IGNORED the profile and over-softened faint IFN before it could be stretched).
  // reflection_nebula -> 0.15/0.20: gentle linear pass preserves faint L dust; the
  // MANDATORY final NXT (creative agent, after lift_dust) cleans the amplified grain.
  const profileNxt = brief?.processingProfile?.tools?.NXT || {};
  const nxtLinear = (typeof profileNxt.denoise_linear === 'number') ? profileNxt.denoise_linear : 0.30;
  const nxtPost = (typeof profileNxt.denoise_post_stretch === 'number') ? profileNxt.denoise_post_stretch : 0.25;
  log(`[PREP] NXT from profile: linear=${nxtLinear}, post-stretch=${nxtPost}`);
  const bxt = resolveBxtOptions(brief);
  const hdrOpts = resolveHdrOptions(brief);
  log(`[PREP] BXT from profile: ${bxt.correct_only === false ? 'sharpen_nonstellar=' + bxt.sharpen_nonstellar : 'correct-only (no sharpen)'}; Seti HDR amount=${hdrOpts.hdrAmount} knee=${hdrOpts.hdrKnee}`);

  // ========================================================================
  // DISK SPACE CHECK — refuse to start if < 20 GB free
  // ========================================================================
  try {
    const dfOut = execSync('df -k /').toString();
    const lines = dfOut.trim().split('\n');
    const cols = lines[1].split(/\s+/);
    const availKB = parseInt(cols[3], 10);
    const availGB = availKB / 1024 / 1024;
    if (availGB < 5) {
      throw new Error(`Not enough disk space: ${availGB.toFixed(1)} GB free (minimum: 5 GB). Clean up ~/.pixinsight-mcp/runs/ or prep-cache.`);
    }
    log(`[PREP] Disk space: ${availGB.toFixed(1)} GB free`);
  } catch (e) {
    if (e.message.includes('Not enough disk space')) throw e;
    log(`[PREP] Disk space check skipped: ${e.message}`);
  }

  // ========================================================================
  // PHASE 1 CACHE — only the deterministic open/align/combine is cached.
  // Gradient correction (agentic, via opts.onAfterCombine) + SPCC/stretch/etc
  // run fresh every time, so gradient scale decisions can vary per run.
  // ========================================================================
  const cacheKey = computeCacheKey(config, brief);
  const phase1Key = cacheKey + '_p1';
  log(`\n[PREP] Cache key: ${cacheKey} (phase 1: ${phase1Key})`);

  let phase1FromCache = false;
  const p1cached = await loadFromCache(ctx, config, phase1Key, log);
  if (p1cached) {
    log('[PREP] === PHASE 1 LOADED FROM CACHE (open/align/combine skipped) ===');
    phase1FromCache = true;
    // The phase-1 cache stores only the combined RGB + linear L. Ha (if present)
    // is NOT cached, so on a cache hit FILTER_Ha would be missing and prep-B's Ha
    // processing fails with "null view". Re-open Ha from source here, mirroring
    // the Step-1 aux-window handling, and dimension-match it to the cached RGB.
    if (hasHa && F.Ha?.trim()) {
      log('[PREP] Cache hit: re-opening FILTER_Ha from source (not cached)...');
      try {
        const beforeHa = (await ctx.listImages()).map(i => i.id);
        await ctx.send('open_image', '__internal__', { filePath: F.Ha });
        const newHa = (await ctx.listImages()).filter(i => !beforeHa.includes(i.id));
        const isAux = (id) => /crop_mask|rejection_low|rejection_high/i.test(id);
        const mainHa = newHa.find(i => /integration/i.test(i.id) && !isAux(i.id)) || newHa.find(i => !isAux(i.id)) || newHa[0];
        for (const v of newHa) {
          if (mainHa && v.id === mainHa.id) continue;
          await ctx.pjsr(`var w=ImageWindow.windowById('${v.id}');if(!w.isNull)w.forceClose();`);
        }
        if (mainHa && mainHa.id !== 'FILTER_Ha') {
          await ctx.pjsr(`var w=ImageWindow.windowById('${mainHa.id}');if(!w.isNull)w.mainView.id='FILTER_Ha';`);
        }
        // Dimension-match Ha to the cached RGB (autocrop/align may have resized RGB)
        const dimR = await ctx.pjsr(`var a=ImageWindow.windowById('${targetName}'),b=ImageWindow.windowById('FILTER_Ha');(a.isNull||b.isNull)?'missing':JSON.stringify({rw:a.mainView.image.width,rh:a.mainView.image.height,hw:b.mainView.image.width,hh:b.mainView.image.height});`);
        const d = JSON.parse(dimR.outputs?.consoleOutput?.trim() || '{}');
        if (d.rw && (d.rw !== d.hw || d.rh !== d.hh)) {
          log(`  Ha ${d.hw}x${d.hh} != RGB ${d.rw}x${d.rh} — center-cropping Ha to match...`);
          await ctx.pjsr(`var w=ImageWindow.windowById('FILTER_Ha');${WCS_CLEAR}var P=new DynamicCrop;P.centerX=0.5;P.centerY=0.5;P.width=${d.rw}/w.mainView.image.width;P.height=${d.rh}/w.mainView.image.height;P.angle=0;P.scaleX=1;P.scaleY=1;P.executeOn(w.mainView);`);
        }
        log('  FILTER_Ha restored.');
      } catch (e) {
        log(`  WARN: failed to re-open Ha from cache path: ${e.message}`);
      }
    }
  } else {
    log('[PREP] Phase 1 cache MISS — running open/align/combine...');
  }

  // Helper: run PJSR and abort on error
  async function pjsrOrDie(script, stepName) {
    const r = await ctx.pjsr(script);
    if (r.status === 'error') {
      throw new Error(`[PREP] ${stepName} FAILED: ${r.error?.message || 'unknown error'}`);
    }
    return r;
  }

  const result = {
    targetName,
    views: {},
    stats: {},
    previews: {},
    applied: [],   // WI-23 provenance: {step, view, params}
  };
  const noteApplied = (step, view, params) => result.applied.push({ step, view, params });

  // ===== PHASE 1 (cacheable): open / align / combine RGB =====
  if (!phase1FromCache) {
  // ========================================================================
  // STEP 0: Close ALL open images — start clean
  // ========================================================================
  log('\n[PREP] Step 0: Closing all open images...');
  const existingImgs = await ctx.listImages();
  if (existingImgs.length > 0) {
    log(`  Closing ${existingImgs.length} stale image(s): ${existingImgs.map(i => i.id).join(', ')}`);
    for (const img of existingImgs) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${img.id}');if(!w.isNull)w.forceClose();`).catch(() => {});
    }
  }

  // ========================================================================
  // STEP 1: Open all masters (with channel swap if configured)
  // ========================================================================
  log('\n[PREP] Step 1: Opening masters...');

  // Apply channelSwap: remap which file goes to which RGB channel
  // e.g. "RB,GB" means: swap R↔B then swap G↔B → net effect: R→G, G→B, B→R (BRV)
  let rPath = F.R, gPath = F.G, bPath = F.B;
  if (F.channelSwap) {
    const swaps = F.channelSwap.split(',').map(s => s.trim());
    log(`  Applying channelSwap: ${F.channelSwap}`);
    for (const sw of swaps) {
      const s = sw.toUpperCase();
      if (s === 'RG' || s === 'GR') { const tmp = rPath; rPath = gPath; gPath = tmp; }
      else if (s === 'RB' || s === 'BR') { const tmp = rPath; rPath = bPath; bPath = tmp; }
      else if (s === 'GB' || s === 'BG') { const tmp = gPath; gPath = bPath; bPath = tmp; }
    }
    log(`  After swap: R=${path.basename(rPath)}, G=${path.basename(gPath)}, B=${path.basename(bPath)}`);
  }

  const masters = [
    { key: 'R', path: rPath, id: 'FILTER_R' },
    { key: 'G', path: gPath, id: 'FILTER_G' },
    { key: 'B', path: bPath, id: 'FILTER_B' },
  ];
  if (hasL) masters.push({ key: 'L', path: F.L, id: 'FILTER_L' });
  if (hasHa) masters.push({ key: 'Ha', path: F.Ha, id: 'FILTER_Ha' });

  for (const m of masters) {
    if (!m.path?.trim()) continue;
    log(`  Opening ${m.key}: ${path.basename(m.path)} → ${m.id}`);
    const beforeOpen = (await ctx.listImages()).map(i => i.id);
    await ctx.send('open_image', '__internal__', { filePath: m.path });
    // Identify all newly-opened views. XISF masters can bring sub-windows:
    // crop_mask (autocrop files) and/or rejection_low/rejection_high
    // (full-frame integrations). Keep the integration, close everything else.
    const afterOpen = await ctx.listImages();
    const newViews = afterOpen.filter(i => !beforeOpen.includes(i.id));
    const isAux = (id) => /crop_mask|rejection_low|rejection_high/i.test(id);
    const mainView = newViews.find(i => /integration/i.test(i.id) && !isAux(i.id))
      || newViews.find(i => !isAux(i.id))
      || newViews[0];
    for (const v of newViews) {
      if (mainView && v.id === mainView.id) continue;
      await ctx.pjsr(`var w=ImageWindow.windowById('${v.id}');if(!w.isNull)w.forceClose();`);
    }
    if (mainView && mainView.id !== m.id) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${mainView.id}');if(!w.isNull)w.mainView.id='${m.id}';`);
    }
  }

  // ========================================================================
  // STEP 2: Check dimensions and align
  // ========================================================================
  log('\n[PREP] Step 2: Checking dimensions...');

  const dimScript = masters.filter(m => m.path?.trim()).map(m =>
    `var w_${m.key}=ImageWindow.windowById('${m.id}'); var d_${m.key}=w_${m.key}.isNull?'missing':w_${m.key}.mainView.image.width+'x'+w_${m.key}.mainView.image.height;`
  ).join(' ') + ' JSON.stringify({' + masters.filter(m => m.path?.trim()).map(m => `${m.key}:d_${m.key}`).join(',') + '});';

  const dimR = await ctx.pjsr(dimScript);
  const dims = JSON.parse(dimR.outputs?.consoleOutput || '{}');
  log(`  Dimensions: ${JSON.stringify(dims)}`);

  const refDim = dims.R;
  // Skip alignment for pre-stretched Ha (user provides it already aligned/cropped)
  const haIsStretched = !!(F.haIsStretched);
  // config.files.forceAlign: register every channel to R even when dimensions match (borrowed
  // masters integrated separately showed red/cyan star fringes on M101, 2026-10-29).
  const forceAlign = !!F.forceAlign;
  const needsAlign = masters.filter(m => m.path?.trim() && (forceAlign || dims[m.key] !== refDim) && dims[m.key] !== 'missing' && m.key !== 'R' && !(m.key === 'Ha' && haIsStretched));
  if (forceAlign) log('  forceAlign: registering all channels to R (distortion correction ' + (F.distortionCorrection ? 'on' : 'off') + ')');

  if (needsAlign.length > 0) {
    log(`  Aligning ${needsAlign.map(m => m.key).join(', ')} to R...`);
    for (const m of needsAlign) {
      log(`    Aligning ${m.key}...`);
      // Use the align_to_reference tool handler logic but inline
      const tmpDir = path.join(opts.runDir || '/tmp', 'tmp_align');
      fs.mkdirSync(tmpDir, { recursive: true });

      const tmpRef = path.join(tmpDir, 'FILTER_R.xisf');
      const tmpTgt = path.join(tmpDir, `${m.id}.xisf`);

      // Save ref and target
      await ctx.pjsr(`var w=ImageWindow.windowById('FILTER_R');w.saveAs('${tmpRef.replace(/'/g, "\\'")}',false,false,false,false);if(w.mainView.id!=='FILTER_R')w.mainView.id='FILTER_R';'ok';`);
      await ctx.pjsr(`var w=ImageWindow.windowById('${m.id}');w.saveAs('${tmpTgt.replace(/'/g, "\\'")}',false,false,false,false);if(w.mainView.id!=='${m.id}')w.mainView.id='${m.id}';'ok';`);

      // StarAlignment
      await ctx.pjsr(`
        var P=new StarAlignment;
        P.referenceImage='${tmpRef.replace(/'/g, "\\'")}';P.referenceIsFile=true;
        P.targets=[[true,true,'${tmpTgt.replace(/'/g, "\\'")}']];
        P.outputDirectory='${tmpDir.replace(/'/g, "\\'")}';P.outputPrefix='aligned_';P.outputPostfix='';
        P.overwriteExistingFiles=true;P.onError=StarAlignment.prototype.Continue;
        P.useTriangles=true;P.polygonSides=5;P.sensitivity=0.50;P.noGUIMessages=true;
        P.distortionCorrection=${F.distortionCorrection ? 'true' : 'false'};P.generateDrizzleData=false;   // config.files.distortionCorrection: true for borrowed/drizzled sets with field distortion (channel fringing on M101, 2026-10-29)
        P.executeGlobal();
      `);

      // Open the correct aligned file
      const alignedPath = path.join(tmpDir, `aligned_${m.id}.xisf`);
      if (fs.existsSync(alignedPath)) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${m.id}');if(!w.isNull)w.forceClose();`);
        const opened = await ctx.send('open_image', '__internal__', { filePath: alignedPath });
        // Rename the window the open call returned (PI 1.9.5 names aligned files 'ImageNN',
        // so searching ids for 'aligned' found nothing and the combine then saw ImageNN views, 2026-10-29).
        const imgs2 = await ctx.listImages();
        for (const cm of imgs2.filter(i => i.id.includes('crop_mask'))) {
          await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
        }
        const openedId = opened.outputs?.id || imgs2.find(i => i.id.includes('aligned'))?.id;
        if (openedId && openedId !== m.id) {
          await ctx.pjsr(`var w=ImageWindow.windowById('${openedId}');if(!w.isNull)w.mainView.id='${m.id}';`);
        }
        const chk = await ctx.pjsr(`ImageWindow.windowById('${m.id}').isNull ? 'MISSING' : 'OK'`);
        if ((chk.outputs?.consoleOutput || '') !== 'OK') throw new Error(`alignment of ${m.key}: window '${m.id}' missing after rename (opened id: ${openedId})`);
        log(`    ${m.key} aligned OK (${openedId} -> ${m.id})`);
      } else {
        log(`    WARNING: aligned file not found for ${m.key}`);
      }
    }
  } else {
    log('  All dimensions match — no alignment needed');
  }

  // ========================================================================
  // STEP 3: Combine RGB
  // ========================================================================
  log('\n[PREP] Step 3: Combining RGB...');
  const beforeIds = (await ctx.listImages()).map(i => i.id);
  const combineR = await ctx.pjsr(`
    var P=new ChannelCombination;
    P.colorSpace=ChannelCombination.prototype.RGB;
    P.channels=[[true,'FILTER_R'],[true,'FILTER_G'],[true,'FILTER_B']];
    P.executeGlobal();
    'CC_done';
  `);
  // Find new color image (wasn't in beforeIds)
  const afterImgs = await ctx.listImages();
  const newColor = afterImgs.find(i => i.isColor && !beforeIds.includes(i.id)) || afterImgs.find(i => i.isColor);
  if (newColor) {
    if (newColor.id !== targetName) {
      await ctx.pjsr(`ImageWindow.windowById('${newColor.id}').mainView.id='${targetName}';`);
    }
    log(`  Combined → ${targetName} (${newColor.width}x${newColor.height})`);
  } else {
    const views = afterImgs.map(v => v.id + '(' + (v.isColor?'color':'mono') + ')').join(', ');
    throw new Error(`ChannelCombination produced no color image. Views: ${views}`);
  }

  // Close individual channels
  for (const id of ['FILTER_R', 'FILTER_G', 'FILTER_B']) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${id}');if(!w.isNull)w.forceClose();`).catch(() => {});
  }

    // ====================================================================
    // WCS copy (RELIABLE PATH) — copy R's astrometric solution onto the combined
    // RGB NOW, while geometry still matches R (both full-frame, pre-autocrop). The
    // subsequent DynamicCrop (Step 3b) carries the solution through the crop, and
    // the phase-1 cache then stores a WCS-bearing image. This makes SPCC reliable
    // instead of depending on the intermittent post-autocrop plate-solve fallback
    // (which fails when the cropped combined no longer matches the full-frame R).
    // ====================================================================
    const earlyWcs = await ctx.pjsr(`
      var srcArr = ImageWindow.open('${F.R.replace(/'/g, "\\'")}');
      var src = null;
      if (srcArr && srcArr.length) {
        for (var k=0;k<srcArr.length;k++){ var sid=srcArr[k].mainView.id; if(sid.indexOf('integration')>=0 && sid.indexOf('rejection')<0 && !src) src=srcArr[k]; }
        if(!src) src=srcArr[0];
      }
      var tgt=ImageWindow.windowById('${targetName}');
      var ok=false;
      if(src && !src.isNull && !tgt.isNull){
        var si=src.mainView.image, ti=tgt.mainView.image;
        if(si.width===ti.width && si.height===ti.height && src.hasAstrometricSolution){
          tgt.mainView.beginProcess();
          tgt.keywords=src.keywords;
          tgt.copyAstrometricSolution(src);
          // Old masters (PI 1.8.9 era) carry the solution as XISF properties only, no WCS
          // keywords; SPCC on 1.9.5 then reports "no valid astrometric solution". Regenerate.
          try { tgt.updateAstrometryMetadata(); } catch (e) {}
          try { tgt.regenerateAstrometricSolution(); } catch (e) {}
          tgt.mainView.endProcess();
          ok = tgt.hasAstrometricSolution;
        }
      }
      if (srcArr) { for (var k=0;k<srcArr.length;k++){ if(!srcArr[k].isNull) srcArr[k].forceClose(); } }
      var ws2=ImageWindow.windows;
      for(var j=0;j<ws2.length;j++){ if(ws2[j].mainView.id.indexOf('crop_mask')>=0) ws2[j].forceClose(); }
      ok ? 'WCS_EARLY_OK' : 'WCS_EARLY_SKIP';
    `);
    log('  WCS from R → combined (pre-autocrop): ' + ((earlyWcs.outputs?.consoleOutput || '').includes('WCS_EARLY_OK') ? 'copied' : 'skipped (no WCS / geometry)'));

    // AUTOCROP MOVED to AFTER SPCC (prep-B). Cropping (DynamicCrop AND Crop) DROPS
    // the astrometric solution in this PI build (verified 2026-06-23), so SPCC must
    // run on the full-frame combined while its WCS is still valid. The combined +
    // L stay full-frame through gradient/BXT/SPCC; autoCropViews() trims them right
    // after SPCC. Bonus: a full-frame combined matches R, so the prep-B WCS copy
    // works without depending on the flaky plate-solve. (autoCropViews defined at
    // module scope; called post-SPCC; gated on F.autoCropBorder.)

    // ====================================================================
    // Save PHASE 1 cache: linear combined RGB (+ linear L). NO gradient yet.
    // ====================================================================
    const p1result = { targetName, views: { rgb: targetName } };
    if (hasL) p1result.views.l = 'FILTER_L';
    log('\n[PREP] Saving phase 1 cache (linear combined RGB + L)...');
    try { await saveToCache(ctx, config, phase1Key, p1result, log); }
    catch (e) { log(`  Phase 1 cache save failed (non-fatal): ${e.message}`); }
  } // ===== end PHASE 1 =====

  // ========================================================================
  // GRADIENT CORRECTION — agentic (onAfterCombine hook) or default.
  // Runs on the LINEAR combined RGB (+ L) BEFORE SPCC/stretch, where gradients
  // bias color calibration and get amplified by the stretch.
  // ========================================================================
  if (opts.onAfterCombine) {
    log('\n[PREP] === Gradient phase: handing linear views to agent ===');
    await opts.onAfterCombine({ ctx, targetName, hasL, hasHa, rgbTarget });
  } else {
    log('\n[PREP] Default gradient correction (GC on RGB, GC on L)...');
    await runGC(ctx, targetName);
    if (hasL) await runGC(ctx, 'FILTER_L');
  }

  // ========================================================================
  // STEP 4: Linear processing on RGB (gradient already corrected above)
  // ========================================================================
  log('\n[PREP] Step 4: Linear processing on RGB...');

  // Background neutralization — always once, after gradient correction, before
  // SPCC (SPCC wants a neutral background reference). Runs in both the agentic
  // and default gradient paths.
  log('  Background neutralization...');
  await ctx.pjsr(`
    var P=new BackgroundNeutralization;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `).catch(() => log('  BN skipped'));

  // WI-26 D: field-dependent PSF map on LINEAR data, before the BXT correct-only pass (advisory)
  await recordPsfField(ctx, targetName, brief, 'before_bxt_correct', log);

  // BXT correct
  log('  BXT correct...');
  await pjsrOrDie(`
    var P=new BlurXTerminator;
    P.correct_only=true;P.adjust_star_halos=0.00;
    P.AI_file='';P.device=0;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `, 'BXT correct on RGB');
  noteApplied('BXT correct', targetName, { correct_only: true });
  await recordPsfField(ctx, targetName, brief, 'after_bxt_correct', log);

  // Ensure WCS astrometric solution for SPCC.
  // FAST PATH: the WCS was copied onto the combined pre-autocrop (and carried
  // through DynamicCrop), or restored from cache — so it's usually already here.
  // Only if absent do we 1) copy from R (works when geometry matches), 2) plate solve.
  const preWcs = await ctx.pjsr(`var w=ImageWindow.windowById('${targetName}'); (!w.isNull && w.hasAstrometricSolution) ? 'HAS_WCS' : 'NO_WCS';`);
  let hasWCS = (preWcs.outputs?.consoleOutput || '').includes('HAS_WCS');
  if (hasWCS) {
    log('  WCS already present on combined (carried through autocrop / cache) — SPCC ready.');
  } else {
  log('  Copy WCS from R master...');
  const wcsResult = await ctx.pjsr(`
    var srcArr = ImageWindow.open('${F.R.replace(/'/g, "\\'")}');   // may be [integration, rejection_low/high]
    var src = null;
    if (srcArr && srcArr.length) {
      for (var k=0;k<srcArr.length;k++){ var sid=srcArr[k].mainView.id; if(sid.indexOf('integration')>=0 && sid.indexOf('rejection')<0 && !src) src=srcArr[k]; }
      if(!src) src=srcArr[0];
    }
    var tgt=ImageWindow.windowById('${targetName}');
    var hasWCS = false;
    if(src && !src.isNull && !tgt.isNull){
      var si=src.mainView.image, ti=tgt.mainView.image;
      // Geometry must match for the astrometric solution to be valid on the target.
      if(si.width===ti.width && si.height===ti.height){
        tgt.mainView.beginProcess();
        tgt.keywords=src.keywords;
        if(src.hasAstrometricSolution){
          tgt.copyAstrometricSolution(src);
          try { tgt.updateAstrometryMetadata(); } catch (e) {}
          try { tgt.regenerateAstrometricSolution(); } catch (e) {}
          hasWCS = tgt.hasAstrometricSolution;
        }
        tgt.mainView.endProcess();
      }
    }
    if (srcArr) { for (var k=0;k<srcArr.length;k++){ if(!srcArr[k].isNull) srcArr[k].forceClose(); } }
    var ws2=ImageWindow.windows;
    for(var j=0;j<ws2.length;j++){ if(ws2[j].mainView.id.indexOf('crop_mask')>=0) ws2[j].forceClose(); }
    hasWCS ? 'WCS_COPIED' : 'NO_WCS';
  `);
  hasWCS = (wcsResult.outputs?.consoleOutput || '').includes('WCS_COPIED');
  log('  ' + (hasWCS ? 'WCS copied from R master' : 'No WCS in R master — will plate solve'));
  }

  if (!hasWCS) {
    // Fallback only when masters lack a WCS. ImageSolver is a SCRIPT object, NOT
    // a process: must use Init()/SolveImage() (not executeOn), read pixel scale
    // from FITS keywords (XPIXSZ — NOT a hardcoded 1.88), persist via
    // metadata.SaveProperties/SaveKeywords, and check hasAstrometricSolution.
    log('  No WCS in masters — plate solving with ImageSolver (V8 script library)...');
    // ImageSolver is a SCRIPT library compiled into the watcher only when MCP_WITH_SOLVER is
    // defined (pjsr/pixinsight-mcp-watcher.js). V8 edition (ImageSolver 6.5.0):
    // initialize(window) + solveImage(window); solveImage throws on failure and persists the
    // solution itself. SEED SCALE: initialize() loads the user's last ImageSolver settings
    // (their own 1520 mm scope) over the file's keywords, so a borrowed 459 mm dataset got a
    // 4x wrong seed and never aligned (M101, 2026-10-29). We derive the seed from FOCALLEN/XPIXSZ
    // (or config.files.pixelScale, arcsec/px) and bracket x2 / x0.5 / x4 / x0.25 if it fails.
    const pixelScaleHint = Number(F.pixelScale) > 0 ? Number(F.pixelScale) : 0;
    const solveR = await ctx.pjsr(`
      var w = ImageWindow.windowById('${targetName}');
      var out = 'SOLVE_FAILED';
      if (typeof ImageSolver === 'undefined') {
        out = 'SOLVER_UNAVAILABLE';
      } else {
        function kwOf(win, n) { for (var i = 0; i < win.keywords.length; i++) if (win.keywords[i].name === n) return parseFloat(String(win.keywords[i].value).replace(/'/g, '')); return NaN; }
        function kw(n) { return kwOf(w, n); }
        // The combined image has no RA/DEC/FOCALLEN keywords when the masters carry no WCS, and then
        // ImageSolver.initialize() falls back to its SAVED settings, i.e. the centre of the LAST target it
        // solved (IC5146 got M101's coordinates on 2026-10-30 and failed). Read the seed from the R master.
        var mRA = kw('RA'), mDEC = kw('DEC'), mFL = kw('FOCALLEN'), mPX = kw('XPIXSZ');
        if (!(mRA >= 0) || !(mDEC > -91)) {
          var mf = '${(F.R || F.L || '').replace(/'/g, "\\'")}';
          if (mf && File.exists(mf)) {
            var ma = ImageWindow.open(mf); var mw = ma[0];
            mRA = kwOf(mw, 'RA'); mDEC = kwOf(mw, 'DEC'); if (!(mFL > 0)) mFL = kwOf(mw, 'FOCALLEN'); if (!(mPX > 0)) mPX = kwOf(mw, 'XPIXSZ');
            for (var mi = 0; mi < ma.length; mi++) ma[mi].forceClose();
          }
        }
        var hint = ${pixelScaleHint};
        var fl = mFL, px = mPX;
        var base = hint > 0 ? hint : ((fl > 0 && px > 0) ? 206.265 * px / fl : 0);
        var seeds = base > 0 ? [base, base * 2, base * 0.5, base * 4, base * 0.25] : [];
        var err = '', tried = [];
        for (var k = 0; k < seeds.length && !w.hasAstrometricSolution; k++) {
          var P = new ImageSolver;
          try {
            P.initialize(w);
            try { P.metadata.useFocal = false; P.metadata.resolution = seeds[k] / 3600; } catch (e) {}
            if (mRA >= 0 && mDEC > -91) { try { P.metadata.ra = mRA; P.metadata.dec = mDEC; } catch (e) {} }
            try { P.solverCfg.catalogMode = 2; P.solverCfg.autoMagnitude = true; P.solverCfg.tryExhaustiveInitialAlignment = true; } catch (e) {}
            try { P.solverCfg.showStars = false; P.solverCfg.generateErrorImg = false; P.solverCfg.showDistortion = false; P.solverCfg.showSimplifiedSurfaces = false; } catch (e) {}
            P.solveImage(w);
          } catch (e) { err = String(e); }
          tried.push(seeds[k].toFixed(3));
        }
        if (!seeds.length) {
          try { var P0 = new ImageSolver; P0.initialize(w); P0.solveImage(w); } catch (e) { err = String(e); }
          tried.push('header-only');
        }
        out = (w.hasAstrometricSolution ? 'SOLVED' : 'SOLVE_FAILED') + ' seeds=' + tried.join('/') + ' centre=' + (mRA >= 0 ? mRA.toFixed(3) + ',' + mDEC.toFixed(3) : 'saved-settings') + (err && !w.hasAstrometricSolution ? ' ' + err : '');
      }
      out;
    `);
    const solved = (solveR.outputs?.consoleOutput || '').includes('SOLVED');
    const solveOut = (solveR.outputs?.consoleOutput || solveR.error?.message || '').split('\n')[0];
    log('  Plate solve: ' + (solved ? 'SUCCESS' : (solveOut.includes('SOLVER_UNAVAILABLE')
      ? 'SOLVER_UNAVAILABLE (define MCP_WITH_SOLVER in the watcher to enable the fallback) — SPCC may not work'
      : 'FAILED (' + solveOut + ') — SPCC may not work')));
  }

  // SPCC with equipment-specific filters + QE from equipment.json
  const equipPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../equipment.json');
  let equipConfig = {};
  if (fs.existsSync(equipPath)) {
    equipConfig = JSON.parse(fs.readFileSync(equipPath, 'utf-8')).spcc || {};
  }
  const filterSet = equipConfig.filterSet || 'Astronomik Deep Sky';
  const sensorQE = equipConfig.sensorQE || 'Sony IMX411/455/461/533/571';
  const whiteRef = equipConfig.whiteReference || 'Average Spiral Galaxy';
  log(`  SPCC (${filterSet} + ${sensorQE})...`);

  // Write curve data to temp file (too large for inline PJSR)
  const spccCurvesModule = await import('../../scripts/spcc-curves.mjs');
  const spccDataPath = '/tmp/spcc-curves-prep.json';
  const spccLogPath = '/tmp/spcc-prep-console.log';
  fs.writeFileSync(spccDataPath, JSON.stringify(spccCurvesModule.default));

  const spccR = await ctx.pjsr(`
    var json=File.readLines('${spccDataPath}').join('');
    var c=JSON.parse(json);
    var P=new SpectrophotometricColorCalibration;
    P.applyCalibration=true;
    P.narrowbandMode=false;
    P.whiteReferenceSpectrum=c.whiteRef;
    P.whiteReferenceName='${whiteRef}';
    P.redFilterTrCurve=c.red;
    P.redFilterName='${filterSet} R';
    P.greenFilterTrCurve=c.green;
    P.greenFilterName='${filterSet} G';
    P.blueFilterTrCurve=c.blue;
    P.blueFilterName='${filterSet} B';
    P.deviceQECurve=c.qe;
    P.deviceQECurveName='${sensorQE}';
    P.catalogId='GaiaDR3SP';
    P.autoLimitMagnitude=true;
    P.psfStructureLayers=5;
    P.psfMinSNR=20;
    P.psfChannelSearchTolerance=2;
    P.psfAllowClusteredSources=true;
    // No graphs/star maps: SPCC renders them in a WebView, which failed with
    // 'LoadWebViewContent(): API function error (0x40240000)' on M101 (2026-10-29) and failed the process.
    P.generateGraphs=false;P.generateStarMaps=false;P.generateTextFiles=false;
    // Capture the PI console so a failure reports its real cause (catalog, stars, WCS, network).
    var logFile='${spccLogPath}';
    var ret=false, err='';
    try { console.beginLog(logFile); } catch(e) {}
    try { ret=P.executeOn(ImageWindow.windowById('${targetName}').mainView); } catch(e) { err=String(e); }
    if (!ret) {
      // Retry once after regenerating the astrometric metadata (properties-only solutions).
      try { var tw=ImageWindow.windowById('${targetName}'); tw.mainView.beginProcess(); try { tw.updateAstrometryMetadata(); } catch(e1) {} try { tw.regenerateAstrometricSolution(); } catch(e2) {} tw.mainView.endProcess(); } catch(e3) {}
      try { console.writeln('SPCC retry after astrometry regeneration'); ret=P.executeOn(ImageWindow.windowById('${targetName}').mainView); } catch(e) { err=String(e); }
    }
    try { console.endLog(); } catch(e) {}
    var tail='';
    try { var ls=File.readLines(logFile); tail=ls.slice(Math.max(0,ls.length-25)).join('\\n'); } catch(e) {}
    (ret?'SPCC_OK':'SPCC_FAILED') + (err?' exception='+err:'') + '\\n' + tail;
  `);
  const spccOut = spccR.outputs?.consoleOutput || '';
  const spccOk = spccOut.includes('SPCC_OK');
  log('  ' + (spccOk ? 'SPCC_OK' : spccOut.split('\n')[0]));
  noteApplied('SPCC', targetName, { ok: spccOk });
  if (!spccOk) {
    // Fall through — the agent can run run_spcc / manual color calibration, and
    // BackgroundNeutralization below provides basic balance.
    const tail = spccOut.split('\n').slice(1).filter(l => l.trim()).slice(-12);
    log('  WARNING: SPCC failed. Falling back to background neutralization only. PI console tail:');
    for (const l of tail) log('    | ' + l.replace(/\x1b\[[0-9;]*m/g, ''));
    log('  The agent can run run_spcc or manual color calibration later if needed.');
  }

  // AUTOCROP (moved here, post-SPCC): SPCC needed a valid WCS on the full-frame
  // combined; cropping drops the solution. Now trim the black + low-coverage edges
  // off RGB + L (both still linear, pre-NXT/SXT/stretch — keeps them aligned).
  if (F.autoCropBorder || F.forceAlign) {   // forced registration leaves empty bands along the edges: always trim them
    log('\n[PREP] Auto-trimming black + low-coverage edges (post-SPCC)...');
    await autoCropViews(ctx, { targetName, hasL, log });
  }

  // NXT linear (from profile — gentle for dust profiles to preserve faint IFN)
  log(`  NXT linear (${nxtLinear})...`);
  await pjsrOrDie(`
    var P=new NoiseXTerminator;
    P.denoise=${nxtLinear};P.detail=0.15;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `, 'NXT linear on RGB');
  noteApplied('NXT linear', targetName, { denoise: nxtLinear, detail: 0.15 });

  // BXT sharpen (aggressive nonstellar for small galaxy detail)
  const bxtRgbPjsr = bxtSharpenPjsr(targetName, bxt);
  if (bxtRgbPjsr) {
    log(`  BXT sharpen (nonstellar=${bxt.sharpen_nonstellar})...`);
    await pjsrOrDie(bxtRgbPjsr, 'BXT sharpen on RGB');
    noteApplied('BXT sharpen', targetName, { correct_only: false, sharpen_nonstellar: bxt.sharpen_nonstellar, adjust_star_halos: 0 });
  } else {
    log('  BXT sharpen skipped (profile correct_only)');
  }

  // SXT — extract stars from linear RGB
  log('  SXT (linear)...');
  await pjsrOrDie(`
    var P=new StarXTerminator;
    P.stars=true;P.unscreen=false;P.overlap=0.20;
    P.AI_file='';P.device=0;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `, 'SXT on RGB');
  noteApplied('SXT linear', targetName, { stars: true, unscreen: false, overlap: 0.20 });
  // Find star image
  const postSxt = await ctx.listImages();
  const starView = postSxt.find(i => i.id.includes('stars'));
  if (starView) {
    result.views.stars = starView.id;
    log(`  Stars extracted: ${starView.id}`);
  }

  // Seti stretch RGB (target from processing profile)
  log(`  Seti stretch RGB (target=${rgbTarget}, headroom=${headroom})...`);
  await setiStretch(ctx, targetName, { targetMedian: rgbTarget, hdrAmount: hdrOpts.hdrAmount, hdrKnee: hdrOpts.hdrKnee, hdrHeadroom: headroom });
  noteApplied('SetiStretch', targetName, { targetMedian: rgbTarget, hdrAmount: hdrOpts.hdrAmount, hdrKnee: hdrOpts.hdrKnee, hdrHeadroom: headroom });

  // NXT post-stretch (from profile)
  log(`  NXT post-stretch (${nxtPost})...`);
  await pjsrOrDie(`
    var P=new NoiseXTerminator;
    P.denoise=${nxtPost};P.detail=0.15;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `, 'NXT post-stretch on RGB');
  noteApplied('NXT post-stretch', targetName, { denoise: nxtPost, detail: 0.15 });

  result.views.rgb = targetName;
  result.stats.rgb = await getStats(ctx, targetName);
  log(`  RGB done: median=${result.stats.rgb.median.toFixed(4)}, max=${(result.stats.rgb.max||0).toFixed(4)}`);

  // Save preview (use saveAs then restore view ID — saveAs changes it)
  const rgbPreview = path.join(outputDir, 'base_rgb.jpg');
  await ctx.pjsr(`
    var w=ImageWindow.windowById('${targetName}');
    if(!w.isNull){
      w.saveAs('${rgbPreview.replace(/'/g, "\\'")}',false,false,false,false);
      w.mainView.id='${targetName}';
    }
  `);
  result.previews.rgb = rgbPreview;

  // ========================================================================
  // STEP 5: Linear processing on L (if present)
  // ========================================================================
  if (hasL) {
    log('\n[PREP] Step 5: Linear processing on L (gradient already corrected above)...');

    // BXT correct
    log('  BXT correct on L...');
    await pjsrOrDie(`
      var P=new BlurXTerminator;
      P.correct_only=true;P.adjust_star_halos=0.00;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_L').mainView);
    `, 'BXT correct on L');

    // NXT linear on L (from profile — gentle to preserve the faint L IFN, which is
    // this target's main dust signal; the final NXT cleans amplified grain later)
    log(`  NXT linear on L (${nxtLinear})...`);
    await pjsrOrDie(`
      var P=new NoiseXTerminator;
      P.denoise=${nxtLinear};P.detail=0.15;
      P.executeOn(ImageWindow.windowById('FILTER_L').mainView);
    `, 'NXT linear on L');
    noteApplied('NXT linear', 'FILTER_L', { denoise: nxtLinear, detail: 0.15 });

    // BXT sharpen on L (aggressive nonstellar)
    const bxtLPjsr = bxtSharpenPjsr('FILTER_L', bxt);
    if (bxtLPjsr) {
      log(`  BXT sharpen on L (nonstellar=${bxt.sharpen_nonstellar})...`);
      await pjsrOrDie(bxtLPjsr, 'BXT sharpen on L');
      noteApplied('BXT sharpen', 'FILTER_L', { correct_only: false, sharpen_nonstellar: bxt.sharpen_nonstellar, adjust_star_halos: 0 });
    } else {
      log('  BXT sharpen on L skipped (profile correct_only)');
    }

    // SXT on L (starless)
    log('  SXT on L (linear, starless)...');
    await pjsrOrDie(`
      var P=new StarXTerminator;
      P.stars=true;P.unscreen=false;P.overlap=0.20;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_L').mainView);
    `, 'SXT on L');
    noteApplied('SXT linear', 'FILTER_L', { stars: true, unscreen: false, overlap: 0.20 });
    // Close L stars (we only use RGB stars)
    const postLSxt = await ctx.listImages();
    const lStars = postLSxt.find(i => i.id.includes('FILTER_L') && i.id.includes('stars'));
    if (lStars) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${lStars.id}');if(!w.isNull)w.forceClose();`);
    }

    // Seti stretch L (brighter to extract faint detail, with headroom for HDRMT)
    log(`  Seti stretch L (target=${lTarget.toFixed(2)}, headroom=${Math.max(headroom, 0.05).toFixed(2)})...`);
    await setiStretch(ctx, 'FILTER_L', { targetMedian: lTarget, hdrAmount: hdrOpts.hdrAmount, hdrKnee: hdrOpts.hdrKnee, hdrHeadroom: Math.max(headroom, 0.05) });
    noteApplied('SetiStretch', 'FILTER_L', { targetMedian: lTarget, hdrAmount: hdrOpts.hdrAmount, hdrKnee: hdrOpts.hdrKnee, hdrHeadroom: Math.max(headroom, 0.05) });

    result.views.l = 'FILTER_L';
    result.stats.l = await getStats(ctx, 'FILTER_L');
    log(`  L done: median=${result.stats.l.median.toFixed(4)}, max=${(result.stats.l.max||0).toFixed(4)}`);

    // Save preview
    const lPreview = path.join(outputDir, 'base_l.jpg');
    await ctx.pjsr(`
      var w=ImageWindow.windowById('FILTER_L');
      if(!w.isNull){
        w.saveAs('${lPreview.replace(/'/g, "\\'")}',false,false,false,false);
        w.mainView.id='FILTER_L';
      }
    `);
    result.previews.l = lPreview;
  }

  // ========================================================================
  // STEP 6: Linear processing on Ha (if present)
  // ========================================================================
  if (hasHa) {
    const haIsStretched = !!(F.haIsStretched);

    if (haIsStretched && F.haIsStarless) {
      // Ha is already stretched AND starless — crop to match RGB if needed, then use as-is
      log('\n[PREP] Step 6: Ha already stretched + starless...');

      // Check if Ha needs cropping to match RGB dimensions
      const haDimR = await ctx.pjsr(`var w=ImageWindow.windowById('FILTER_Ha');w.isNull?'missing':w.mainView.image.width+'x'+w.mainView.image.height;`);
      const haDim = haDimR.outputs?.consoleOutput;
      const rgbDimR = await ctx.pjsr(`var w=ImageWindow.windowById('${targetName}');w.isNull?'missing':w.mainView.image.width+'x'+w.mainView.image.height;`);
      const rgbDim = rgbDimR.outputs?.consoleOutput;

      if (haDim !== rgbDim && haDim !== 'missing' && rgbDim !== 'missing') {
        log(`  Ha (${haDim}) differs from RGB (${rgbDim}) — center-cropping Ha to match...`);
        const [rgbW, rgbH] = rgbDim.split('x').map(Number);
        await ctx.pjsr(`
          var w = ImageWindow.windowById('FILTER_Ha');
          var img = w.mainView.image;
          var dx = Math.floor((img.width - ${rgbW}) / 2);
          var dy = Math.floor((img.height - ${rgbH}) / 2);
          if (dx > 0 || dy > 0) {
            ${WCS_CLEAR}
            var P = new DynamicCrop;
            P.centerX = 0.5; P.centerY = 0.5;
            P.width = ${rgbW} / img.width;
            P.height = ${rgbH} / img.height;
            P.executeOn(w.mainView);
          }
          'Cropped to ' + w.mainView.image.width + 'x' + w.mainView.image.height;
        `);
        log(`  Ha cropped to match RGB`);
      } else {
        log(`  Ha dimensions match RGB — no crop needed`);
      }

    } else if (haIsStretched) {
      // Ha is already stretched (non-linear) — skip linear processing, just SXT
      log('\n[PREP] Step 6: Ha already stretched — star removal only...');

      log('  SXT on Ha (non-linear, unscreen)...');
      await pjsrOrDie(`
        var P=new StarXTerminator;
        P.stars=true;P.unscreen=true;P.overlap=0.20;P.AI_file='';P.device=0;
        P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
      `, 'SXT on Ha');
      const postHaSxt = await ctx.listImages();
      const haStars = postHaSxt.find(i => i.id.includes('FILTER_Ha') && i.id.includes('stars'));
      if (haStars) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${haStars.id}');if(!w.isNull)w.forceClose();`);
      }

    } else {
      // Ha is linear — full processing
      log('\n[PREP] Step 6: Linear processing on Ha...');

      log('  GC on Ha...');
      await runGC(ctx, 'FILTER_Ha');

      // Background neutralization skipped for mono Ha — only meaningful on color images

      log('  BXT correct on Ha...');
      await pjsrOrDie(`
        var P=new BlurXTerminator;
        P.correct_only=true;P.adjust_star_halos=0.00;P.AI_file='';P.device=0;
        P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
      `, 'BXT correct on Ha');
      noteApplied('BXT correct', 'FILTER_Ha', { correct_only: true });

      log('  NXT linear on Ha (0.20)...');
      await pjsrOrDie(`
        var P=new NoiseXTerminator;
        P.denoise=0.20;P.detail=0.15;
        P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
      `, 'NXT linear on Ha');
      noteApplied('NXT linear', 'FILTER_Ha', { denoise: 0.20, detail: 0.15 });

      const bxtHaPjsr = bxtSharpenPjsr('FILTER_Ha', bxt);
      if (bxtHaPjsr) {
        log(`  BXT sharpen on Ha (nonstellar=${bxt.sharpen_nonstellar})...`);
        await pjsrOrDie(bxtHaPjsr, 'BXT sharpen on Ha');
        noteApplied('BXT sharpen', 'FILTER_Ha', { correct_only: false, sharpen_nonstellar: bxt.sharpen_nonstellar, adjust_star_halos: 0 });
      } else {
        log('  BXT sharpen on Ha skipped (profile correct_only)');
      }

      log('  SXT on Ha (linear)...');
      await pjsrOrDie(`
        var P=new StarXTerminator;
        P.stars=true;P.unscreen=false;P.overlap=0.20;P.AI_file='';P.device=0;
        P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
      `, 'SXT on Ha');
      noteApplied('SXT linear', 'FILTER_Ha', { stars: true, unscreen: false, overlap: 0.20 });
      const postHaSxt = await ctx.listImages();
      const haStars = postHaSxt.find(i => i.id.includes('FILTER_Ha') && i.id.includes('stars'));
      if (haStars) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${haStars.id}');if(!w.isNull)w.forceClose();`);
      }

      log(`  Seti stretch Ha (target=${haTarget.toFixed(2)}, headroom=${headroom})...`);
      await setiStretch(ctx, 'FILTER_Ha', { targetMedian: haTarget, hdrAmount: hdrOpts.hdrAmount, hdrKnee: hdrOpts.hdrKnee, hdrHeadroom: headroom });
      noteApplied('SetiStretch', 'FILTER_Ha', { targetMedian: haTarget, hdrAmount: hdrOpts.hdrAmount, hdrKnee: hdrOpts.hdrKnee, hdrHeadroom: headroom });
    }

    result.views.ha = 'FILTER_Ha';
    result.stats.ha = await getStats(ctx, 'FILTER_Ha');
    log(`  Ha done: median=${result.stats.ha.median.toFixed(4)}`);
  }

  // ========================================================================
  // STEP 7: Star layer — deliver LINEAR to agent
  // ========================================================================
  // DO NOT stretch stars here. The agent's stretch_stars tool is designed for
  // linear input and handles pedestal clipping + MTF iterations properly.
  // Previous mtf(0.01,$T) was wildly aggressive and caused double-stretch
  // bloat when the agent stretched again (FWHM 13.5px on M81).
  if (result.views.stars) {
    log('\n[PREP] Step 7: Star layer kept LINEAR (agent will stretch via stretch_stars tool)');
    result.stats.stars = await getStats(ctx, result.views.stars);
    if ((result.stats.stars?.median ?? 0) >= 0.001) {
      process.stderr.write(`[PREP] WARNING: star layer median=${result.stats.stars.median.toExponential(2)} >= 0.001 — it may not be linear; stretch_stars may refuse it.\n`);
    }
  }

  // Detail baseline for the finish detail-gain advisory (best effort, never fatal).
  try {
    log('\n[PREP] Measuring detail baseline (credible/weber) on final prep views...');
    result.baselineDetail = await measureDetailBaseline(ctx, { rgb: result.views.rgb, l: result.views.l }, { runDir: opts.runDir, log });
    if (brief) { brief._baselineDetail = result.baselineDetail; brief._hasL = !!result.views.l; }
  } catch (e) { log(`  [PREP] baseline detail failed: ${e.message}`); }

  // WI-26 C: deterministic highlight-texture baseline on the SXT-starless stretched RGB / L / Ha
  // (one locateSubjectROI; stores brief._roi + brief._baselineTexture, writes baseline-texture.json).
  result.baselineTexture = await measureBaselineTexture(ctx, { rgb: result.views.rgb, l: result.views.l, ha: result.views.ha }, { runDir: opts.runDir, brief, log });

  // Note: only PHASE 1 (open/align/combine) is cached — see above. The gradient
  // phase and everything after it run fresh each time and are not cached.

  // ========================================================================
  // Summary
  // ========================================================================
  log('\n[PREP] === DETERMINISTIC PREP COMPLETE ===');
  log(`  RGB: ${result.views.rgb} (median=${result.stats.rgb?.median.toFixed(4)})`);
  if (result.views.l) log(`  L: ${result.views.l} (median=${result.stats.l?.median.toFixed(4)})`);
  if (result.views.ha) log(`  Ha: ${result.views.ha} (median=${result.stats.ha?.median.toFixed(4)})`);
  if (result.views.stars) log(`  Stars: ${result.views.stars}`);
  if (brief?._psfPrep) {
    result.psf = brief._psfPrep;
    const pa = brief._psfPrep.after_bxt_correct || brief._psfPrep.before_bxt_correct;
    if (pa) log(`  PSF field: verdict=${pa.verdict ?? 'n/a'}${pa.crop_box ? `, crop_box x ${pa.crop_box.x0}-${pa.crop_box.x1} y ${pa.crop_box.y0}-${pa.crop_box.y1}` : ''} (advisory; crop box is for the user's crop, never the starless deliverable)`);
  }
  log('  All working assets ready for creative agents.\n');

  return result;
}
