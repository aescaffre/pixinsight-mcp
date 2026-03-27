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
import { cloneImage, closeImage, purgeUndoHistory } from '../ops/image-mgmt.mjs';

const __filename = fileURLToPath(import.meta.url);
const CACHE_DIR = path.join(os.homedir(), '.pixinsight-mcp', 'prep-cache');

/**
 * Compute a fingerprint for a file using size + first/last 64KB.
 * Fast enough for multi-GB XISF files.
 */
function fileFingerprint(filePath) {
  if (!filePath?.trim() || !fs.existsSync(filePath)) return 'missing';
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash('sha256');
  hash.update(`${stat.size}:${stat.mtimeMs}:`);
  const fd = fs.openSync(filePath, 'r');
  const chunk = 65536;
  const buf = Buffer.alloc(chunk);
  // First 64KB
  const readHead = fs.readSync(fd, buf, 0, chunk, 0);
  hash.update(buf.subarray(0, readHead));
  // Last 64KB
  if (stat.size > chunk) {
    const readTail = fs.readSync(fd, buf, 0, chunk, stat.size - chunk);
    hash.update(buf.subarray(0, readTail));
  }
  fs.closeSync(fd);
  return hash.digest('hex').slice(0, 16);
}

/**
 * Compute the cache key for a given config.
 * Combines: prep script hash + fingerprint of each input master.
 */
function computeCacheKey(config) {
  const hash = crypto.createHash('sha256');
  // Hash this script's content
  hash.update(fs.readFileSync(__filename, 'utf-8'));
  // Hash each input file fingerprint
  const F = config.files;
  for (const key of ['R', 'G', 'B', 'L', 'Ha']) {
    const fp = fileFingerprint(F[key]);
    hash.update(`${key}:${fp}|`);
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
    config: { targetName: config.files?.targetName, workflow: Object.keys(config.files).filter(k => config.files[k]?.trim()).join('+') },
    files,
    result,
  };
  fs.writeFileSync(path.join(cacheDir, 'meta.json'), JSON.stringify(meta, null, 2));
  log(`  Cache saved: ${cacheDir}`);
}

/**
 * Run deterministic prep on a config.
 * Returns { targetName, views: { rgb, l, ha, stars, starless_l }, stats, previews }
 *
 * @param {object} ctx - Bridge context
 * @param {object} config - Pipeline config
 * @param {object} opts - { outputDir, log }
 */
export async function runDeterministicPrep(ctx, config, opts = {}) {
  const log = opts.log || console.log;
  const F = config.files;
  const targetName = F.targetName || 'Target';
  const hasL = !!(F.L?.trim());
  const hasHa = !!(F.Ha?.trim());
  const outputDir = opts.outputDir || '/tmp/prep';
  fs.mkdirSync(outputDir, { recursive: true });

  // ========================================================================
  // DISK SPACE CHECK — refuse to start if < 20 GB free
  // ========================================================================
  try {
    const dfOut = execSync('df -k /').toString();
    const lines = dfOut.trim().split('\n');
    const cols = lines[1].split(/\s+/);
    const availKB = parseInt(cols[3], 10);
    const availGB = availKB / 1024 / 1024;
    if (availGB < 15) {
      throw new Error(`Not enough disk space: ${availGB.toFixed(1)} GB free (minimum: 15 GB). Clean up ~/.pixinsight-mcp/runs/ or prep-cache.`);
    }
    log(`[PREP] Disk space: ${availGB.toFixed(1)} GB free`);
  } catch (e) {
    if (e.message.includes('Not enough disk space')) throw e;
    log(`[PREP] Disk space check skipped: ${e.message}`);
  }

  // ========================================================================
  // CACHE CHECK — skip all processing if inputs haven't changed
  // ========================================================================
  const cacheKey = computeCacheKey(config);
  log(`\n[PREP] Cache key: ${cacheKey}`);

  const cached = await loadFromCache(ctx, config, cacheKey, log);
  if (cached) {
    log('[PREP] === LOADED FROM CACHE (skipped all processing) ===');
    // Re-gather live stats from the loaded views
    cached.stats = {};
    if (cached.views.rgb) cached.stats.rgb = await getStats(ctx, cached.views.rgb);
    if (cached.views.l) cached.stats.l = await getStats(ctx, cached.views.l);
    if (cached.views.ha) cached.stats.ha = await getStats(ctx, cached.views.ha);
    log(`  RGB: ${cached.views.rgb} (median=${cached.stats.rgb?.median?.toFixed(4) || 'N/A'})`);
    if (cached.views.l) log(`  L: ${cached.views.l} (median=${cached.stats.l?.median?.toFixed(4) || 'N/A'})`);
    if (cached.views.ha) log(`  Ha: ${cached.views.ha} (median=${cached.stats.ha?.median?.toFixed(4) || 'N/A'})`);
    if (cached.views.stars) log(`  Stars: ${cached.views.stars}`);
    return cached;
  }
  log('[PREP] Cache MISS — running full prep...');

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
  };

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
    // Close crop masks and rename immediately (before opening next file)
    const afterOpen = await ctx.listImages();
    for (const cm of afterOpen.filter(i => i.id.includes('crop_mask'))) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
    }
    // Find the newly opened view (wasn't in beforeOpen) and rename to target ID
    const newView = afterOpen.find(i => !beforeOpen.includes(i.id) && !i.id.includes('crop_mask'));
    if (newView && newView.id !== m.id) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${newView.id}');if(!w.isNull)w.mainView.id='${m.id}';`);
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
  const needsAlign = masters.filter(m => m.path?.trim() && dims[m.key] !== refDim && dims[m.key] !== 'missing' && m.key !== 'R');

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
        P.distortionCorrection=false;P.generateDrizzleData=false;
        P.executeGlobal();
      `);

      // Open the correct aligned file
      const alignedPath = path.join(tmpDir, `aligned_${m.id}.xisf`);
      if (fs.existsSync(alignedPath)) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${m.id}');if(!w.isNull)w.forceClose();`);
        await ctx.send('open_image', '__internal__', { filePath: alignedPath });
        // Find and rename
        const imgs2 = await ctx.listImages();
        for (const cm of imgs2.filter(i => i.id.includes('crop_mask'))) {
          await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
        }
        const aligned = imgs2.find(i => i.id.includes('aligned'));
        if (aligned && aligned.id !== m.id) {
          await ctx.pjsr(`var w=ImageWindow.windowById('${aligned.id}');if(!w.isNull)w.mainView.id='${m.id}';`);
        }
        log(`    ${m.key} aligned OK`);
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

  // ========================================================================
  // STEP 4: Linear processing on RGB
  // ========================================================================
  log('\n[PREP] Step 4: Linear processing on RGB...');

  // GC
  log('  GC...');
  await runGC(ctx, targetName);

  // Background neutralization (immediately after GC, before BXT)
  log('  Background neutralization...');
  await ctx.pjsr(`
    var P=new BackgroundNeutralization;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `).catch(() => log('  BN skipped'));

  // BXT correct
  log('  BXT correct...');
  await pjsrOrDie(`
    var P=new BlurXTerminator;
    P.correct_only=true;P.adjust_star_halos=0.00;
    P.AI_file='';P.device=0;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `, 'BXT correct on RGB');

  // Copy WCS back from R master for SPCC
  log('  Copy WCS from R master...');
  await ctx.pjsr(`
    var src=ImageWindow.open('${F.R.replace(/'/g, "\\'")}')[0];
    var tgt=ImageWindow.windowById('${targetName}');
    if(!src.isNull&&!tgt.isNull){
      tgt.mainView.beginProcess();
      tgt.keywords=src.keywords;
      if(src.astrometricSolution)tgt.copyAstrometricSolution(src,false);
      tgt.mainView.endProcess();
    }
    if(!src.isNull)src.forceClose();
    var ws2=ImageWindow.windows;
    for(var j=0;j<ws2.length;j++){
      if(ws2[j].mainView.id.indexOf('crop_mask')>=0) ws2[j].forceClose();
    }
    'WCS copied';
  `);

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
    var ret=P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    ret?'SPCC_OK':'SPCC_FAILED';
  `);
  const spccOut = spccR.outputs?.consoleOutput || '';
  log('  ' + spccOut);
  if (!spccOut.includes('SPCC_OK')) {
    throw new Error('SPCC failed — color calibration is required. Check WCS/astrometric solution on the target image. Previous images may need to be closed first.');
  }

  // NXT linear (balanced — reduce noise while preserving faint detail)
  log('  NXT linear (0.30)...');
  await pjsrOrDie(`
    var P=new NoiseXTerminator;
    P.denoise=0.30;P.detail=0.15;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `, 'NXT linear on RGB');

  // BXT sharpen (aggressive nonstellar for small galaxy detail)
  log('  BXT sharpen (nonstellar=0.70)...');
  await pjsrOrDie(`
    var P=new BlurXTerminator;
    P.correct_only=false;P.sharpen_nonstellar=0.70;P.adjust_star_halos=0.00;
    P.AI_file='';P.device=0;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `, 'BXT sharpen on RGB');

  // SXT — extract stars from linear RGB
  log('  SXT (linear)...');
  await pjsrOrDie(`
    var P=new StarXTerminator;
    P.stars=true;P.unscreen=false;P.overlap=0.20;
    P.AI_file='';P.device=0;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `, 'SXT on RGB');
  // Find star image
  const postSxt = await ctx.listImages();
  const starView = postSxt.find(i => i.id.includes('stars'));
  if (starView) {
    result.views.stars = starView.id;
    log(`  Stars extracted: ${starView.id}`);
  }

  // Seti stretch RGB (darker background for cleaner result — L provides detail via LRGB)
  log('  Seti stretch RGB (target=0.10, headroom=0.05)...');
  await setiStretch(ctx, targetName, { targetMedian: 0.10, hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: 0.05 });

  // NXT post-stretch
  log('  NXT post-stretch (0.25)...');
  await pjsrOrDie(`
    var P=new NoiseXTerminator;
    P.denoise=0.25;P.detail=0.15;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `, 'NXT post-stretch on RGB');

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
    log('\n[PREP] Step 5: Linear processing on L...');

    // GC
    log('  GC on L...');
    await runGC(ctx, 'FILTER_L');

    // Background neutralization on L
    log('  Background neutralization on L...');
    await ctx.pjsr(`
      var P=new BackgroundNeutralization;
      P.executeOn(ImageWindow.windowById('FILTER_L').mainView);
    `).catch(() => log('  BN on L skipped'));

    // BXT correct
    log('  BXT correct on L...');
    await pjsrOrDie(`
      var P=new BlurXTerminator;
      P.correct_only=true;P.adjust_star_halos=0.00;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_L').mainView);
    `, 'BXT correct on L');

    // NXT linear on L (balanced)
    log('  NXT linear on L (0.30)...');
    await pjsrOrDie(`
      var P=new NoiseXTerminator;
      P.denoise=0.30;P.detail=0.15;
      P.executeOn(ImageWindow.windowById('FILTER_L').mainView);
    `, 'NXT linear on L');

    // BXT sharpen on L (aggressive nonstellar)
    log('  BXT sharpen on L (nonstellar=0.70)...');
    await pjsrOrDie(`
      var P=new BlurXTerminator;
      P.correct_only=false;P.sharpen_nonstellar=0.70;P.adjust_star_halos=0.00;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_L').mainView);
    `, 'BXT sharpen on L');

    // SXT on L (starless)
    log('  SXT on L (linear, starless)...');
    await pjsrOrDie(`
      var P=new StarXTerminator;
      P.stars=true;P.unscreen=false;P.overlap=0.20;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_L').mainView);
    `, 'SXT on L');
    // Close L stars (we only use RGB stars)
    const postLSxt = await ctx.listImages();
    const lStars = postLSxt.find(i => i.id.includes('FILTER_L') && i.id.includes('stars'));
    if (lStars) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${lStars.id}');if(!w.isNull)w.forceClose();`);
    }

    // Seti stretch L (brighter to extract faint detail, with headroom for HDRMT)
    log('  Seti stretch L (target=0.30, headroom=0.10)...');
    await setiStretch(ctx, 'FILTER_L', { targetMedian: 0.30, hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: 0.10 });

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
    log('\n[PREP] Step 6: Linear processing on Ha...');

    log('  GC on Ha...');
    await runGC(ctx, 'FILTER_Ha');

    // Background neutralization on Ha
    log('  Background neutralization on Ha...');
    await ctx.pjsr(`
      var P=new BackgroundNeutralization;
      P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
    `).catch(() => log('  BN on Ha skipped'));

    log('  BXT correct on Ha...');
    await pjsrOrDie(`
      var P=new BlurXTerminator;
      P.correct_only=true;P.adjust_star_halos=0.00;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
    `, 'BXT correct on Ha');

    log('  NXT linear on Ha (0.20)...');
    await pjsrOrDie(`
      var P=new NoiseXTerminator;
      P.denoise=0.20;P.detail=0.15;
      P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
    `, 'NXT linear on Ha');

    log('  BXT sharpen on Ha (nonstellar=0.70)...');
    await pjsrOrDie(`
      var P=new BlurXTerminator;
      P.correct_only=false;P.sharpen_nonstellar=0.70;P.adjust_star_halos=0.00;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
    `, 'BXT sharpen on Ha');

    log('  SXT on Ha (linear)...');
    await pjsrOrDie(`
      var P=new StarXTerminator;
      P.stars=true;P.unscreen=false;P.overlap=0.20;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
    `, 'SXT on Ha');
    const postHaSxt = await ctx.listImages();
    const haStars = postHaSxt.find(i => i.id.includes('FILTER_Ha') && i.id.includes('stars'));
    if (haStars) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${haStars.id}');if(!w.isNull)w.forceClose();`);
    }

    log('  Seti stretch Ha (target=0.15)...');
    await setiStretch(ctx, 'FILTER_Ha', { targetMedian: 0.15, hdrAmount: 0.25, hdrKnee: 0.35 });

    result.views.ha = 'FILTER_Ha';
    result.stats.ha = await getStats(ctx, 'FILTER_Ha');
    log(`  Ha done: median=${result.stats.ha.median.toFixed(4)}`);
  }

  // ========================================================================
  // STEP 7: Stretch stars
  // ========================================================================
  if (result.views.stars) {
    log('\n[PREP] Step 7: Stretching star layer...');
    // stretch_stars clips background and applies MTF
    await ctx.pjsr(`
      var starsId='${result.views.stars}';
      var w=ImageWindow.windowById(starsId);
      if(!w.isNull){
        var img=w.mainView.image;
        var med=img.median();
        if(med<0.01){
          // Clip background pedestal
          var PM=new PixelMath;
          PM.expression='max($T-0.0001,0)';
          PM.useSingleExpression=true;PM.createNewImage=false;
          PM.executeOn(w.mainView);
          // MTF stretch
          var PM2=new PixelMath;
          PM2.expression='mtf(0.01,$T)';
          PM2.useSingleExpression=true;PM2.createNewImage=false;
          PM2.executeOn(w.mainView);
        }
      }
      'stars stretched';
    `);
    log('  Stars stretched');
  }

  // ========================================================================
  // Save to cache
  // ========================================================================
  log('\n[PREP] Saving to cache...');
  try {
    await saveToCache(ctx, config, cacheKey, result, log);
  } catch (e) {
    log(`  Cache save failed (non-fatal): ${e.message}`);
  }

  // ========================================================================
  // Summary
  // ========================================================================
  log('\n[PREP] === DETERMINISTIC PREP COMPLETE ===');
  log(`  RGB: ${result.views.rgb} (median=${result.stats.rgb?.median.toFixed(4)})`);
  if (result.views.l) log(`  L: ${result.views.l} (median=${result.stats.l?.median.toFixed(4)})`);
  if (result.views.ha) log(`  Ha: ${result.views.ha} (median=${result.stats.ha?.median.toFixed(4)})`);
  if (result.views.stars) log(`  Stars: ${result.views.stars}`);
  log('  All working assets ready for creative agents.\n');

  return result;
}
