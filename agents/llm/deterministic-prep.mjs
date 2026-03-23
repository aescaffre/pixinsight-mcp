// ============================================================================
// Deterministic Prep — No LLM involvement
//
// Opens masters, aligns, combines RGB, runs the canonical linear sequence,
// produces stable working assets. Zero LLM turns spent on file hygiene.
// ============================================================================
import fs from 'fs';
import path from 'path';
import { getStats, measureUniformity } from '../ops/stats.mjs';
import { setiStretch } from '../ops/stretch.mjs';
import { runGC } from '../ops/gradient.mjs';
import { createLumMask } from '../ops/masks.mjs';
import { savePreview } from '../ops/preview.mjs';
import { cloneImage, closeImage, purgeUndoHistory } from '../ops/image-mgmt.mjs';

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

  const result = {
    targetName,
    views: {},
    stats: {},
    previews: {},
  };

  // ========================================================================
  // STEP 1: Open all masters
  // ========================================================================
  log('\n[PREP] Step 1: Opening masters...');

  const masters = [
    { key: 'R', path: F.R, id: 'FILTER_R' },
    { key: 'G', path: F.G, id: 'FILTER_G' },
    { key: 'B', path: F.B, id: 'FILTER_B' },
  ];
  if (hasL) masters.push({ key: 'L', path: F.L, id: 'FILTER_L' });
  if (hasHa) masters.push({ key: 'Ha', path: F.Ha, id: 'FILTER_Ha' });

  for (const m of masters) {
    if (!m.path?.trim()) continue;
    log(`  Opening ${m.key}: ${path.basename(m.path)}`);
    await ctx.send('open_image', '__internal__', { filePath: m.path });
    // Close crop masks
    const imgs = await ctx.listImages();
    for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
    }
  }

  // Rename views to short IDs
  log('  Renaming views...');
  const allImgs = await ctx.listImages();
  for (const m of masters) {
    if (!m.path?.trim()) continue;
    const baseName = path.basename(m.path, '.xisf').replace(/[^a-zA-Z0-9]/g, '_');
    const found = allImgs.find(i => i.id.includes(baseName) || i.id.includes(`FILTER_${m.key}`));
    if (found && found.id !== m.id) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${found.id}');if(!w.isNull)w.mainView.id='${m.id}';`);
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
    log('  WARNING: No color image found after combine!');
    const views = afterImgs.map(v => v.id + '(' + (v.isColor?'color':'mono') + ')').join(', ');
    log('  Views: ' + views);
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

  // BXT correct
  log('  BXT correct...');
  await ctx.pjsr(`
    var P=new BlurXTerminator;
    P.correct_only=true;P.adjust_star_halos=0.00;
    P.AI_file='';P.device=0;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `);

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
    // Close any crop masks from reopening the R master
    var ws2=ImageWindow.windows;
    for(var j=0;j<ws2.length;j++){
      if(ws2[j].mainView.id.indexOf('crop_mask')>=0) ws2[j].forceClose();
    }
    'WCS copied';
  `);

  // SPCC
  log('  SPCC...');
  const spccR = await ctx.pjsr(`
    var P=new SpectrophotometricColorCalibration;
    P.applyCalibration=true;P.narrowBandMode=false;P.narrowBandOptimizeStars=false;
    P.catalogId='GaiaDR3SP';P.autoLimitMagnitude=true;
    P.psfStructureLayers=5;P.psfMinSNR=40;P.psfChannelSearchTolerance=2;
    var ret=P.executeOn(ImageWindow.windowById('${targetName}').mainView);
    ret?'SPCC_OK':'SPCC_FAILED';
  `);
  log('  ' + (spccR.outputs?.consoleOutput || 'done'));

  // Background neutralization
  log('  Background neutralization...');
  await ctx.pjsr(`
    var P=new BackgroundNeutralization;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `).catch(() => log('  BN skipped'));

  // NXT linear
  log('  NXT linear (0.20)...');
  await ctx.pjsr(`
    var P=new NoiseXTerminator;
    P.denoise=0.20;P.detail=0.15;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `);

  // SXT — extract stars from linear RGB
  log('  SXT (linear)...');
  await ctx.pjsr(`
    var P=new StarXTerminator;
    P.stars=true;P.unscreen=false;P.overlap=0.20;
    P.AI_file='';P.device=0;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `);
  // Find star image
  const postSxt = await ctx.listImages();
  const starView = postSxt.find(i => i.id.includes('stars'));
  if (starView) {
    result.views.stars = starView.id;
    log(`  Stars extracted: ${starView.id}`);
  }

  // Seti stretch RGB
  log('  Seti stretch RGB (target=0.12, headroom=0.05)...');
  await setiStretch(ctx, targetName, { targetMedian: 0.12, hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: 0.05 });

  // NXT post-stretch
  log('  NXT post-stretch (0.25)...');
  await ctx.pjsr(`
    var P=new NoiseXTerminator;
    P.denoise=0.25;P.detail=0.15;
    P.executeOn(ImageWindow.windowById('${targetName}').mainView);
  `);

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

    // BXT correct
    log('  BXT correct on L...');
    await ctx.pjsr(`
      var P=new BlurXTerminator;
      P.correct_only=true;P.adjust_star_halos=0.00;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_L').mainView);
    `);

    // NXT linear on L
    log('  NXT linear on L (0.20)...');
    await ctx.pjsr(`
      var P=new NoiseXTerminator;
      P.denoise=0.20;P.detail=0.15;
      P.executeOn(ImageWindow.windowById('FILTER_L').mainView);
    `);

    // SXT on L (starless)
    log('  SXT on L (linear, starless)...');
    await ctx.pjsr(`
      var P=new StarXTerminator;
      P.stars=true;P.unscreen=false;P.overlap=0.20;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_L').mainView);
    `);
    // Close L stars (we only use RGB stars)
    const postLSxt = await ctx.listImages();
    const lStars = postLSxt.find(i => i.id.includes('FILTER_L') && i.id.includes('stars'));
    if (lStars) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${lStars.id}');if(!w.isNull)w.forceClose();`);
    }

    // Seti stretch L (brighter for IFN, with headroom for HDRMT)
    log('  Seti stretch L (target=0.25, headroom=0.10)...');
    await setiStretch(ctx, 'FILTER_L', { targetMedian: 0.25, hdrAmount: 0.25, hdrKnee: 0.35, hdrHeadroom: 0.10 });

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

    log('  BXT correct on Ha...');
    await ctx.pjsr(`
      var P=new BlurXTerminator;
      P.correct_only=true;P.adjust_star_halos=0.00;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
    `);

    log('  NXT linear on Ha (0.20)...');
    await ctx.pjsr(`
      var P=new NoiseXTerminator;
      P.denoise=0.20;P.detail=0.15;
      P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
    `);

    log('  SXT on Ha (linear)...');
    await ctx.pjsr(`
      var P=new StarXTerminator;
      P.stars=true;P.unscreen=false;P.overlap=0.20;P.AI_file='';P.device=0;
      P.executeOn(ImageWindow.windowById('FILTER_Ha').mainView);
    `);
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
