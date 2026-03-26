#!/usr/bin/env node
// Generate all 6 RGB channel permutations from 3 mono masters
// Usage: node scripts/channel-permutation-test.mjs <R_file> <V_file> <B_file> <output_dir>
import { createBridgeContext } from '../agents/ops/bridge.mjs';
import { setiStretch } from '../agents/ops/stretch.mjs';
import fs from 'fs';

const [rFile, vFile, bFile, outDir] = process.argv.slice(2);
if (!rFile || !vFile || !bFile || !outDir) {
  console.error('Usage: node scripts/channel-permutation-test.mjs <R_file> <V_file> <B_file> <output_dir>');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const ctx = createBridgeContext({ log: console.log });

// Close everything first
const existing = await ctx.listImages();
for (const img of existing) {
  await ctx.pjsr(`var w=ImageWindow.windowById('${img.id}');if(!w.isNull)w.forceClose();`).catch(() => {});
}

// Open the 3 channels
const channels = { R: rFile, V: vFile, B: bFile };
for (const [k, p] of Object.entries(channels)) {
  console.log(`Opening ${k}: ${p.split('/').pop()}`);
  await ctx.send('open_image', '__internal__', { filePath: p });
  const imgs = await ctx.listImages();
  for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
  }
}

// Rename to short IDs
const allImgs = await ctx.listImages();
for (const img of allImgs) {
  const id = img.id;
  if (id.includes('FILTER_R') || id.includes('_R_')) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${id}');if(!w.isNull)w.mainView.id='CH_R';`);
  } else if (id.includes('FILTER_V') || id.includes('_V_')) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${id}');if(!w.isNull)w.mainView.id='CH_V';`);
  } else if (id.includes('FILTER_B') || id.includes('_B_')) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${id}');if(!w.isNull)w.mainView.id='CH_B';`);
  }
}

// 6 permutations
const perms = [
  { name: 'RVB_default', r: 'CH_R', g: 'CH_V', b: 'CH_B' },
  { name: 'RBV', r: 'CH_R', g: 'CH_B', b: 'CH_V' },
  { name: 'VRB', r: 'CH_V', g: 'CH_R', b: 'CH_B' },
  { name: 'VBR', r: 'CH_V', g: 'CH_B', b: 'CH_R' },
  { name: 'BRV', r: 'CH_B', g: 'CH_R', b: 'CH_V' },
  { name: 'BVR', r: 'CH_B', g: 'CH_V', b: 'CH_R' },
];

for (const p of perms) {
  console.log(`\nCombining ${p.name} (R=${p.r}, G=${p.g}, B=${p.b})...`);
  const beforeIds = (await ctx.listImages()).map(i => i.id);

  await ctx.pjsr(`
    var P=new ChannelCombination;
    P.colorSpace=ChannelCombination.prototype.RGB;
    P.channels=[[true,'${p.r}'],[true,'${p.g}'],[true,'${p.b}']];
    P.executeGlobal();
  `);

  const after = await ctx.listImages();
  const newImg = after.find(i => i.isColor && !beforeIds.includes(i.id));
  if (!newImg) { console.log('  No color image produced!'); continue; }

  const viewId = 'perm_' + p.name;
  await ctx.pjsr(`var w=ImageWindow.windowById('${newImg.id}');if(!w.isNull)w.mainView.id='${viewId}';`);

  // Seti stretch then save JPG
  const jpgPath = `${outDir}/${p.name}.jpg`;
  await setiStretch(ctx, viewId, { targetMedian: 0.15 });
  await ctx.pjsr(`
    var w=ImageWindow.windowById('${viewId}');
    if(!w.isNull){
      w.saveAs('${jpgPath.replace(/'/g, "\\'")}',false,false,false,false);
      w.mainView.id='${viewId}';
    }
  `);
  console.log(`  Saved: ${jpgPath}`);

  // Close combined image
  await ctx.pjsr(`var w=ImageWindow.windowById('${viewId}');if(!w.isNull)w.forceClose();`);
}

// Cleanup
for (const id of ['CH_R', 'CH_V', 'CH_B']) {
  await ctx.pjsr(`var w=ImageWindow.windowById('${id}');if(!w.isNull)w.forceClose();`).catch(() => {});
}

console.log(`\nAll 6 permutations saved to ${outDir}`);
console.log('Open the folder and pick the one with correct colors!');
