#!/usr/bin/env node
// ============================================================================
// Agentic Pipeline Orchestrator
// Entry point for autonomous astrophotography processing.
//
// Usage:
//   node agents/orchestrator.mjs --config /path/to/config.json [--intent "natural galaxy"]
//
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';

import { createBridgeContext } from './ops/bridge.mjs';
import { ArtifactStore } from './artifact-store.mjs';
import { generateBrief } from './classifier.mjs';
import { RGBCleanlinessAgent } from './doers/rgb-cleanliness.mjs';
import { LuminanceDetailAgent } from './doers/luminance-detail.mjs';
import { CompositionAgent } from './doers/composition.mjs';

const home = os.homedir();

// ============================================================================
// CLI argument parsing
// ============================================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1]) opts.configPath = args[++i];
    else if (args[i] === '--intent' && args[i + 1]) opts.intent = args[++i];
    else if (args[i] === '--style' && args[i + 1]) opts.style = args[++i];
    else if (args[i] === '--run-id' && args[i + 1]) opts.runId = args[++i];
    else if (args[i] === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

// ============================================================================
// Main orchestration flow
// ============================================================================
async function orchestrate() {
  const opts = parseArgs();

  // Load config
  const configPath = opts.configPath || path.join(home, '.pixinsight-mcp', 'pipeline-config.json');
  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  console.log(`\n========================================`);
  console.log(`  Agentic Pipeline Orchestrator`);
  console.log(`  Target: ${config.files?.targetName || config.name}`);
  console.log(`  Config: ${configPath}`);
  console.log(`========================================\n`);

  // Create bridge context
  const ctx = createBridgeContext({ log: console.log });

  // Verify PixInsight connection
  try {
    const imgs = await ctx.listImages();
    console.log(`PixInsight connected (${imgs.length} images open)`);
  } catch (err) {
    console.error(`Cannot reach PixInsight bridge: ${err.message}`);
    console.error(`Ensure the watcher is running in PixInsight.`);
    process.exit(1);
  }

  // --- Stage 0: Classification and brief generation ---
  console.log('\n--- Stage 0: Classification ---');
  const brief = generateBrief(config, {
    intent: opts.intent,
    style: opts.style
  });
  console.log(`  Target: ${brief.target.name}`);
  console.log(`  Classification: ${brief.target.classification}`);
  console.log(`  Workflow: ${brief.dataDescription.workflow}`);
  console.log(`  Style: ${brief.aestheticIntent.style}`);
  console.log(`  Priorities: ${brief.technicalPriorities.slice(0, 3).join(', ')}...`);

  // Create artifact store
  const store = new ArtifactStore(opts.runId);
  store.saveBrief(brief);
  console.log(`  Run ID: ${store.runId}`);
  console.log(`  Artifacts: ${store.baseDir}`);

  if (opts.dryRun) {
    console.log('\n--- DRY RUN: Classification complete, not running agents ---');
    console.log(JSON.stringify(brief, null, 2));
    return;
  }

  // --- Stage 1: Open and prepare input images ---
  console.log('\n--- Stage 1: Readiness ---');
  const F = config.files;

  // Open master files
  for (const [channel, filePath] of Object.entries({ R: F.R, G: F.G, B: F.B, Ha: F.Ha, L: F.L })) {
    if (!filePath?.trim()) continue;
    console.log(`  Opening ${channel}: ${path.basename(filePath)}`);
    const r = await ctx.send('open_image', '__internal__', { filePath });
    if (r.status === 'error') {
      console.error(`  FAILED to open ${channel}: ${r.error?.message}`);
      if (['R', 'G', 'B'].includes(channel)) process.exit(1);
    }
    // Close crop masks
    const imgs = await ctx.listImages();
    for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
    }
  }

  // Combine RGB channels
  console.log('  Combining RGB channels...');
  const targetName = F.targetName || 'Target';

  // Find channel view IDs
  const allImgs = await ctx.listImages();
  const findView = (filter) => {
    const patterns = [
      new RegExp(`FILTER[_-]${filter}`, 'i'),
      new RegExp(`[_-]${filter}[_-]`, 'i'),
      new RegExp(`[_-]${filter}$`, 'i')
    ];
    for (const img of allImgs) {
      for (const pat of patterns) {
        if (pat.test(img.id)) return img.id;
      }
    }
    return null;
  };

  const rView = findView('R');
  const gView = findView('G') || findView('V');
  const bView = findView('B');

  if (!rView || !gView || !bView) {
    console.error(`  Cannot identify RGB views: R=${rView}, G=${gView}, B=${bView}`);
    console.error(`  Available: ${allImgs.map(i => i.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`  R=${rView}, G=${gView}, B=${bView}`);

  // ChannelCombination
  await ctx.pjsr(`
    var P = new ChannelCombination;
    P.colorSpace = ChannelCombination.prototype.RGB;
    P.channels = [
      [true, '${rView}'],
      [true, '${gView}'],
      [true, '${bView}']
    ];
    P.executeGlobal();
  `);

  // Find the combined image
  const afterCombine = await ctx.listImages();
  const combined = afterCombine.find(i =>
    !i.id.includes('FILTER') && !i.id.includes('crop') && i.isColor
  );
  if (!combined) {
    console.error('  ChannelCombination failed — no color image found');
    process.exit(1);
  }

  // Rename to target name
  if (combined.id !== targetName) {
    await ctx.pjsr(`
      var w = ImageWindow.windowById('${combined.id}');
      if (!w.isNull) w.mainView.id = '${targetName}';
    `);
  }
  console.log(`  Combined: ${targetName} (${combined.width}x${combined.height})`);

  // Close individual channel windows
  for (const viewId of [rView, gView, bView]) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${viewId}');if(!w.isNull)w.forceClose();`);
  }

  // --- Stage 2: RGB Cleanliness Agent ---
  console.log('\n--- Stage 2: RGB Cleanliness Agent ---');
  const rgbAgent = new RGBCleanlinessAgent(store, brief);
  const rgbResult = await rgbAgent.run(ctx, { viewId: targetName });
  console.log(`  Winner: ${rgbResult.winnerId} (score=${rgbResult.winnerScore?.toFixed(1)})`);

  // --- Stage 3: Luminance Detail Agent ---
  console.log('\n--- Stage 3: Luminance Detail Agent ---');
  const lumAgent = new LuminanceDetailAgent(store, brief);
  const lumResult = await lumAgent.run(ctx, { viewId: targetName });
  console.log(`  Winner: ${lumResult.winnerId} (score=${lumResult.winnerScore?.toFixed(1)})`);

  // --- Stage 4: Composition Agent ---
  console.log('\n--- Stage 4: Composition Agent ---');
  const compAgent = new CompositionAgent(store, brief);
  const compResult = await compAgent.run(ctx, {
    viewId: targetName,
    starsViewId: null // Phase 1: no star separation yet
  });
  console.log(`  Winner: ${compResult.winnerId} (score=${compResult.winnerScore?.toFixed(1)})`);

  // --- Stage 5: Save final and generate dossier ---
  console.log('\n--- Stage 5: Finalize ---');

  // Save final image
  const outputDir = F.outputDir || path.join(home, 'Desktop');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const finalXisf = path.join(outputDir, `${targetName}_agentic.xisf`);
  const finalJpeg = path.join(outputDir, `${targetName}_agentic.jpg`);

  await ctx.pjsr(`
    var w = ImageWindow.windowById('${targetName}');
    if (!w.isNull) {
      var p = '${finalXisf.replace(/'/g, "\\'")}';
      if (File.exists(p)) File.remove(p);
      w.saveAs(p, false, false, false, false);
      if (w.mainView.id !== '${targetName}') w.mainView.id = '${targetName}';
    }
  `);
  console.log(`  Saved: ${finalXisf}`);

  // Save JPEG preview
  await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${targetName}');
    var img = srcW.mainView.image;
    var tmp = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, false, img.isColor, 'final_preview_tmp');
    tmp.mainView.beginProcess();
    tmp.mainView.image.assign(img);
    tmp.mainView.endProcess();
    var p = '${finalJpeg.replace(/'/g, "\\'")}';
    if (File.exists(p)) File.remove(p);
    tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
  `);
  console.log(`  Saved: ${finalJpeg}`);

  // Generate dossier
  const dossier = generateDossier(store, brief, { rgbResult, lumResult, compResult });
  const dossierPath = path.join(store.baseDir, '08_selection', 'dossier.md');
  fs.mkdirSync(path.dirname(dossierPath), { recursive: true });
  fs.writeFileSync(dossierPath, dossier);
  console.log(`  Dossier: ${dossierPath}`);

  // Finalize store
  store.finalize(compResult.winnerId);

  console.log(`\n========================================`);
  console.log(`  Processing complete!`);
  console.log(`  Final: ${finalXisf}`);
  console.log(`  Run: ${store.baseDir}`);
  console.log(`========================================\n`);
}

// ============================================================================
// Dossier generation
// ============================================================================
function generateDossier(store, brief, results) {
  const { rgbResult, lumResult, compResult } = results;

  const lines = [
    `# Processing Dossier — ${brief.target.name}`,
    '',
    `**Date**: ${new Date().toISOString().slice(0, 10)}`,
    `**Run ID**: ${store.runId}`,
    `**Classification**: ${brief.target.classification}`,
    `**Workflow**: ${brief.dataDescription.workflow}`,
    `**Style**: ${brief.aestheticIntent.style}`,
    '',
    '## 1. Processing Brief',
    '',
    `- **Target**: ${brief.target.name} (${brief.target.classification})`,
    `- **Priorities**: ${brief.technicalPriorities.join(' > ')}`,
    `- **Background target**: ${brief.aestheticIntent.backgroundTarget}`,
    `- **Detail emphasis**: ${brief.aestheticIntent.detailEmphasis}`,
    '',
    '## 2. RGB Cleanliness',
    '',
    `- **Winner**: ${rgbResult.winnerId}`,
    `- **Score**: ${rgbResult.winnerScore?.toFixed(1)} / 100`,
    `- **Iterations**: ${rgbResult.summary.iterations}`,
    `- **Time**: ${Math.round(rgbResult.summary.elapsedMs / 1000)}s`,
    '',
    '## 3. Luminance Detail',
    '',
    `- **Winner**: ${lumResult.winnerId}`,
    `- **Score**: ${lumResult.winnerScore?.toFixed(1)} / 100`,
    `- **Iterations**: ${lumResult.summary.iterations}`,
    `- **Time**: ${Math.round(lumResult.summary.elapsedMs / 1000)}s`,
    '',
    '## 4. Composition',
    '',
    `- **Winner**: ${compResult.winnerId}`,
    `- **Score**: ${compResult.winnerScore?.toFixed(1)} / 100`,
    `- **Iterations**: ${compResult.summary.iterations}`,
    `- **Time**: ${Math.round(compResult.summary.elapsedMs / 1000)}s`,
    '',
    '## 5. Known Compromises',
    '',
    '- Phase 1 MVP: no Ha integration, no star separation, no LRGB combine',
    '- Aesthetic/subject critics not yet implemented (stats-only scoring)',
    '- Parameter search spaces are conservative (bounded by project knowledge)',
    '',
    '## 6. Provenance',
    '',
    `Full provenance data in: \`${store.baseDir}/manifest.json\``,
    '',
    '---',
    '*Generated by Agentic Pipeline Orchestrator v0.1*'
  ];

  return lines.join('\n');
}

// ============================================================================
// Run
// ============================================================================
orchestrate().catch(err => {
  console.error('\nFATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
