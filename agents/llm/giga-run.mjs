#!/usr/bin/env node
// ============================================================================
// GIGA Pipeline Runner — Single mega-agent via Claude Max (claude -p subprocess)
// Uses the giga-orchestrator prompt with ALL tools available.
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

import { createBridgeContext } from '../ops/bridge.mjs';
import { getStats, measureUniformity } from '../ops/stats.mjs';
import { ArtifactStore } from '../artifact-store.mjs';
import { generateBrief } from '../classifier.mjs';
import { MaxAgent } from './engine-max.mjs';
import { buildToolSet } from './tools.mjs';
import { generateDiagnosticViews, buildImageMessage } from './vision.mjs';
import { buildGigaOrchestratorPrompt } from './prompts/giga-orchestrator.mjs';
import { runDeterministicPrep } from './deterministic-prep.mjs';

const home = os.homedir();

// ============================================================================
// Parse args
// ============================================================================
const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && args[i + 1]) opts.configPath = args[++i];
  else if (args[i] === '--intent') opts.intent = args[++i];
  else if (args[i] === '--dry-run') opts.dryRun = true;
}

if (!opts.configPath) {
  console.error('Usage: node agents/llm/giga-run.mjs --config /path/to/config.json [--intent "..."]');
  process.exit(1);
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  const configPath = path.resolve(opts.configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  console.log('='.repeat(60));
  console.log('  GIGA Pipeline — Single Mega-Agent via Claude Max');
  console.log('  Target:', config.files?.targetName || config.name);
  console.log('  Config:', configPath);
  console.log('='.repeat(60));

  // Bridge
  const ctx = createBridgeContext({ log: console.log });
  try {
    const imgs = await ctx.listImages();
    console.log(`\nPixInsight connected (${imgs.length} images open)`);
  } catch (err) {
    console.error(`Cannot reach PixInsight: ${err.message}`);
    process.exit(1);
  }

  // Classification
  console.log('\n--- Classification ---');
  const brief = generateBrief(config, { intent: opts.intent });
  console.log(`  Target: ${brief.target.name} (${brief.target.classification})`);
  console.log(`  Workflow: ${brief.dataDescription.workflow}`);
  console.log(`  Style: ${brief.aestheticIntent.style}`);

  if (opts.dryRun) {
    console.log('\n--- DRY RUN ---');
    console.log(JSON.stringify(brief, null, 2));
    return;
  }

  // Artifact store
  const store = new ArtifactStore();
  store.saveBrief(brief);
  console.log(`  Run ID: ${store.runId}`);
  console.log(`  Artifacts: ${store.baseDir}`);

  // ================================================================
  // PHASE 1: DETERMINISTIC PREP (no LLM, pure code)
  // ================================================================
  console.log('\n--- Phase 1: Deterministic Prep (no LLM) ---');
  const prepResult = await runDeterministicPrep(ctx, config, {
    outputDir: path.join(store.baseDir, 'prep'),
    runDir: store.baseDir,
    log: console.log,
  });

  // Generate diagnostic views for the agent to start with
  const diagDir = path.join(store.baseDir, 'diagnostics', 'prep');
  const diagPaths = await generateDiagnosticViews(ctx, prepResult.views.rgb, diagDir);
  let lDiagPaths = [];
  if (prepResult.views.l) {
    const lDiagDir = path.join(store.baseDir, 'diagnostics', 'prep_l');
    lDiagPaths = await generateDiagnosticViews(ctx, prepResult.views.l, lDiagDir);
  }

  // ================================================================
  // PHASE 2+: Creative agent (LLM via Claude Max)
  // ================================================================
  console.log('\n--- Phase 2+: Creative Agent via Claude Max ---');

  // Build system prompt
  const systemPrompt = buildGigaOrchestratorPrompt(brief, config);

  // Creative agent gets all tools EXCEPT readiness (prep already done)
  const creativeCategories = [
    'measurement', 'preview', 'image_mgmt', 'gradient',
    'denoise', 'sharpen', 'stretch',
    'masks', 'detail', 'curves', 'lrgb', 'ha_injection', 'stars',
    'artifacts', 'memory', 'control', 'scoring', 'quality_gate'
  ];
  const { definitions, handlers } = buildToolSet('giga_orchestrator', creativeCategories);
  console.log(`  Tools available: ${definitions.length}`);

  // Build initial message with prep results + diagnostic views
  const viewsList = Object.entries(prepResult.views)
    .map(([k, v]) => `- **${k}**: \`${v}\` (median=${prepResult.stats[k]?.median?.toFixed(4) || 'N/A'})`)
    .join('\n');

  const initialText = `## PHASE 1 COMPLETE — Deterministic prep has been done for you.

### Working assets ready in PixInsight:
${viewsList}

### Current RGB stats:
- Median: ${prepResult.stats.rgb?.median?.toFixed(6) || 'N/A'}
- Max: ${(prepResult.stats.rgb?.max || 0).toFixed(4)}
- Background uniformity: ${(await measureUniformity(ctx, prepResult.views.rgb)).score.toFixed(6)}

${prepResult.views.l ? `### Current L stats:
- Median: ${prepResult.stats.l?.median?.toFixed(6) || 'N/A'}
- Max: ${(prepResult.stats.l?.max || 0).toFixed(4)}
- L is STARLESS, stretched to target=0.25 with headroom=0.10
` : ''}

${prepResult.views.ha ? `### Ha available: \`${prepResult.views.ha}\` (stretched, starless)` : ''}
${prepResult.views.stars ? `### Stars available: \`${prepResult.views.stars}\` (stretched)` : ''}

### Diagnostic views attached (RGB overview, center crop, corner crop, background-stretched)

### Winning Parameters from Previous Runs
${extractWinningParams(brief.target.classification)}

## SKIP Phase 0 and Phase 1 — they are done.
## Begin at Phase 2: Branch Generation.
## Call recall_memory first, then start generating bracketed candidate sets.`;

  // Create MaxAgent
  console.log('\n--- Launching GIGA Agent via Claude Max ---');
  const agent = new MaxAgent('giga_orchestrator', {
    systemPrompt,
    agentName: 'giga_orchestrator',
    tools: { definitions, handlers },
    budget: { maxTurns: 200 }, // Large budget for the full pipeline
    store,
    brief,
    ctx,
  });

  // Run
  const startTime = Date.now();
  const result = await agent.run(initialText);
  const elapsed = Date.now() - startTime;

  console.log(`\n--- GIGA Agent completed in ${Math.round(elapsed / 1000)}s ---`);

  if (result.crashError) {
    console.error(`CRASH: ${result.crashError.message}`);
    process.exit(77);
  }

  // Save final image
  const targetName = config.files?.targetName || 'Target';
  const outputDir = config.files?.outputDir || path.join(home, 'Desktop');
  fs.mkdirSync(outputDir, { recursive: true });

  const xisfPath = path.join(outputDir, `${targetName}_giga.xisf`);
  const pngPath = path.join(outputDir, `${targetName}_giga.png`);

  // Find the best final image to save — prefer COMP_final, then any COMP_, then targetName
  // The agent often leaves targetName as starless and puts the final composition elsewhere
  try {
    const saveResult = await ctx.pjsr(`
      // Find the best final: prefer views with stars (higher max, name contains 'FINAL' or 'stars')
      var allColor = [];
      var ws = ImageWindow.windows;
      for (var i = 0; i < ws.length; i++) {
        if (ws[i].mainView.image.numberOfChannels === 3) {
          allColor.push({ id: ws[i].mainView.id, max: ws[i].mainView.image.maximum(), w: ws[i] });
        }
      }
      // Sort by priority: FINAL/stars names first, then by max value (stars push max higher)
      allColor.sort(function(a, b) {
        var aScore = 0, bScore = 0;
        if (a.id.indexOf('FINAL') >= 0) aScore += 100;
        if (a.id.indexOf('stars') >= 0 || a.id.indexOf('Stars') >= 0) aScore += 50;
        if (a.id.indexOf('COMP') >= 0) aScore += 10;
        if (b.id.indexOf('FINAL') >= 0) bScore += 100;
        if (b.id.indexOf('stars') >= 0 || b.id.indexOf('Stars') >= 0) bScore += 50;
        if (b.id.indexOf('COMP') >= 0) bScore += 10;
        if (aScore !== bScore) return bScore - aScore;
        return b.max - a.max; // Higher max = more likely to have stars
      });
      var best = allColor.length > 0 ? allColor[0].w : null;
      if (best) {
        best.saveAs('${xisfPath.replace(/'/g, "\\'")}', false, false, false, false);
        best.mainView.id = '${targetName}';
        best.saveAs('${pngPath.replace(/'/g, "\\'")}', false, false, false, false);
        best.mainView.id = '${targetName}';
        'Saved: ' + best.mainView.id;
      } else {
        'No color image found';
      }
    `);
    console.log(`  ${saveResult.outputs?.consoleOutput || 'done'}`);
    console.log(`  Saved: ${xisfPath}`);
    console.log(`  Saved: ${pngPath}`);
  } catch (e) {
    console.error(`  Save error: ${e.message}`);
  }

  // Run memory optimizer after each run
  try {
    const { optimizeMemory } = await import('../memory/hierarchical-memory.mjs');
    const optResult = optimizeMemory();
    if (optResult.promotions.length > 0) {
      console.log(`\n--- Memory Optimizer: ${optResult.promotions.length} promotion(s) ---`);
      optResult.promotions.forEach(p => console.log(`  ${p}`));
    }
    console.log(`  Memory: ${optResult.totalEntries} entries`);
  } catch (e) {
    console.log(`  Memory optimizer skipped: ${e.message}`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  GIGA Processing complete!`);
  console.log(`  Final: ${pngPath}`);
  console.log(`  Run: ${store.baseDir}`);
  console.log(`${'='.repeat(60)}`);
}

// ============================================================================
// Winning parameter extraction (same as orchestrator.mjs)
// ============================================================================
function extractWinningParams(classification) {
  const memDir = path.join(home, '.pixinsight-mcp', 'agent-memory');
  const results = [];

  // Check all agent memory files
  for (const agentFile of ['luminance_detail', 'composition', 'rgb_cleanliness', 'star_policy', 'ha_integration']) {
    const memFile = path.join(memDir, `${agentFile}.json`);
    if (!fs.existsSync(memFile)) continue;

    const entries = JSON.parse(fs.readFileSync(memFile, 'utf-8'));
    const winners = entries
      .filter(e => e.tags?.includes('winning_param') &&
                   (e.tags?.includes(classification) || e.title?.toLowerCase().includes(classification.replace('_', ' '))))
      .reverse();

    const seen = new Set();
    for (const w of winners) {
      const key = w.tags?.find(t => t !== classification && t !== 'winning_param') || w.title;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(`- [${agentFile}] **${w.title}**: ${w.content.split('\n')[0]}`);
      }
    }
  }

  return results.length > 0
    ? results.join('\n')
    : 'No winning parameters found for this classification. This is the first run.';
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
