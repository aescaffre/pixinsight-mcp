#!/usr/bin/env node
// Test all 6 RGB channel permutations for M27 to find correct filter mapping
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const cmdDir = path.join(process.env.HOME, '.pixinsight-mcp/bridge/commands');
const resultDir = path.join(process.env.HOME, '.pixinsight-mcp/bridge/results');
const outDir = '/Users/aescaffre/M27_MASTER/Claude/output/processed';

const FILES = {
  R: '/Users/aescaffre/M27_MASTER/Claude/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-R_mono_autocrop.xisf',
  V: '/Users/aescaffre/M27_MASTER/Claude/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-V_mono_autocrop.xisf',
  B: '/Users/aescaffre/M27_MASTER/Claude/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-B_mono_autocrop.xisf',
};

async function pjsr(code) {
  const id = randomUUID();
  const cmdFile = path.join(cmdDir, id + '.json');
  const resultFile = path.join(resultDir, id + '.json');
  fs.writeFileSync(cmdFile, JSON.stringify({ tool: 'run_script', id, parameters: { code } }));
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (fs.existsSync(resultFile)) {
      const res = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      try { fs.unlinkSync(resultFile); } catch(e) {}
      if (res.status === 'error') throw new Error(res.error?.message || res.message || JSON.stringify(res));
      return res.outputs?.consoleOutput || '';
    }
  }
  throw new Error('Timeout');
}

// 6 permutations: which file goes to which RGB channel
const PERMS = [
  { label: 'RVB_noswap',     R: 'R', G: 'V', B: 'B' },
  { label: 'RBV_swapGB',     R: 'R', G: 'B', B: 'V' },
  { label: 'VRB_swapRG',     R: 'V', G: 'R', B: 'B' },
  { label: 'BRV_Crescent',   R: 'B', G: 'R', B: 'V' },
  { label: 'BVR_swapRB',     R: 'B', G: 'V', B: 'R' },
  { label: 'VBR_cycleRVB',   R: 'V', G: 'B', B: 'R' },
];

(async () => {
  // Step 1: Close everything and open the 3 channel files
  console.log('Closing all images...');
  await pjsr("var ws=ImageWindow.windows;for(var i=0;i<ws.length;i++)ws[i].forceClose();'done';");

  console.log('Opening R, V, B masters...');
  for (const [label, filePath] of Object.entries(FILES)) {
    console.log(`  Opening ${label}...`);
    await pjsr(`var w=ImageWindow.open('${filePath.replace(/'/g, "\\'")}');if(w&&w.length>0)w[0].show();'ok';`);
  }

  // Get view IDs and close crop masks
  await pjsr("var ws=ImageWindow.windows;for(var i=0;i<ws.length;i++){if(ws[i].mainView.id.indexOf('crop_mask')>=0)ws[i].forceClose();}'done';");
  const ids = await pjsr("ImageWindow.windows.map(function(w){return w.mainView.id;}).join('|');");
  console.log('Open views:', ids);
  const views = ids.split('|').filter(Boolean);

  // Find view IDs by filter name
  const findView = (filter) => views.find(v => v.toUpperCase().indexOf('FILTER_' + filter) >= 0 || v.toUpperCase().indexOf('FILTER-' + filter) >= 0);
  const idR = findView('R');
  const idV = findView('V');
  const idB = findView('B');
  console.log(`Identified: R=${idR}, V=${idV}, B=${idB}`);

  const fileMap = { R: idR, V: idV, B: idB };

  // Step 2: For each permutation, create RGB composite + stretch via PixelMath MTF + save
  for (const perm of PERMS) {
    const rView = fileMap[perm.R];
    const gView = fileMap[perm.G];
    const bView = fileMap[perm.B];
    const testId = 'test_' + perm.label;

    console.log(`\n--- ${perm.label}: R=${perm.R}(${rView}), G=${perm.G}(${gView}), B=${perm.B}(${bView}) ---`);

    // Create RGB composite
    await pjsr(`
      var old = ImageWindow.windowById('${testId}');
      if (!old.isNull) old.forceClose();
      var srcW = ImageWindow.windowById('${rView}');
      var w = srcW.mainView.image.width;
      var h = srcW.mainView.image.height;
      var P = new PixelMath;
      P.expression = '${rView}';
      P.expression1 = '${gView}';
      P.expression2 = '${bView}';
      P.useSingleExpression = false;
      P.createNewImage = true;
      P.showNewImage = true;
      P.newImageId = '${testId}';
      P.newImageWidth = w;
      P.newImageHeight = h;
      P.newImageColorSpace = PixelMath.prototype.RGB;
      P.newImageSampleFormat = PixelMath.prototype.f32;
      P.executeGlobal();
      'ok';
    `);

    // Get stats per channel, then apply HT with proper 5-element array
    const stats = await pjsr(`
      var w = ImageWindow.windowById('${testId}');
      var img = w.mainView.image;
      var result = [];
      for (var c = 0; c < 3; c++) {
        var med = img.median(new Rect, c, c);
        var mad = img.MAD(med, new Rect, c, c);
        result.push(c + ':med=' + med.toFixed(8) + ',mad=' + mad.toFixed(8));
      }
      result.join('|');
    `);
    console.log(`  Stats: ${stats}`);

    // Apply auto-stretch using HT with proper 5-entry H array
    await pjsr(`
      var w = ImageWindow.windowById('${testId}');
      var img = w.mainView.image;
      var stfParms = [];
      for (var c = 0; c < 3; c++) {
        var med = img.median(new Rect, c, c);
        var mad = img.MAD(med, new Rect, c, c);
        var shadow = Math.max(0, med - 2.8 * mad);
        var targetMed = 0.25;
        var diff = med - shadow;
        var midtone;
        if (diff > 0) {
          midtone = targetMed * diff / ((2*targetMed - 1) * diff + targetMed);
          midtone = Math.min(1, Math.max(0, midtone));
        } else {
          midtone = 0.5;
        }
        stfParms.push([midtone, shadow, 1, 0, 1]);
      }
      // HT.H needs exactly 5 entries: R, G, B, RGB-combined, Alpha
      stfParms.push([0.5, 0, 1, 0, 1]);  // RGB combined (identity)
      stfParms.push([0.5, 0, 1, 0, 1]);  // Alpha (identity)
      var HT = new HistogramTransformation;
      HT.H = stfParms;
      HT.executeOn(w.mainView);
      // Check post-stretch stats
      var img2 = w.mainView.image;
      var postMed = img2.median();
      'HT applied, post-stretch median=' + postMed.toFixed(4);
    `);

    // Save JPEG
    const jpgPath = path.join(outDir, `channel_test_${perm.label}.jpg`);
    const saveResult = await pjsr(`
      var w = ImageWindow.windowById('${testId}');
      var p = '${jpgPath.replace(/'/g, "\\'")}';
      if (File.exists(p)) File.remove(p);
      w.saveAs(p, false, false, false, false);
      w.forceClose();
      'saved';
    `);
    console.log(`  Saved: ${jpgPath}`);
  }

  // Close original masters
  await pjsr("var ws=ImageWindow.windows;for(var i=0;i<ws.length;i++)ws[i].forceClose();'done';");
  console.log('\nDone! Check the channel_test_*.jpg files.');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
