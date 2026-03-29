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

import { execSync } from 'child_process';

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
// P2a: PixInsight swap file management
// ============================================================================
function cleanPISwapFiles() {
  // DISABLED — deleting swap files while PI is running crashes it.
  // Swap files are managed by PixInsight itself. If disk is full,
  // close images in PI manually or restart PI before running the pipeline.
  try {
    const findResult = execSync(
      "find /var/folders -name '~PI~*.swp' -type f 2>/dev/null || true",
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    const files = findResult ? findResult.split('\n').filter(Boolean) : [];
    let totalBytes = 0;
    for (const f of files) {
      try { totalBytes += fs.statSync(f).size; } catch {}
    }
    const totalGB = totalBytes / (1024 ** 3);
    if (files.length > 0) console.log(`  PI swap: ${files.length} file(s), ${totalGB.toFixed(2)} GB (not cleaning — PI may be using them)`);
    else console.log('  PI swap: no swap files found');
    return { cleaned: false, totalBytes, fileCount: files.length };
  } catch (err) {
    return { cleaned: false, totalBytes: 0, fileCount: 0 };
  }
}

// ============================================================================
// P2b: Automatic disk space monitoring
// ============================================================================
function checkDiskSpace() {
  console.log('\n--- Pre-flight: Disk Space Check ---');

  function getFreeGB(mountPoint) {
    try {
      // df -g gives output in GB on macOS
      const output = execSync(`df -g '${mountPoint}' 2>/dev/null`, { encoding: 'utf-8' });
      const lines = output.trim().split('\n');
      if (lines.length < 2) return null;
      // Columns: Filesystem 1G-blocks Used Available Capacity Mounted
      const cols = lines[1].split(/\s+/);
      return parseInt(cols[3], 10); // Available column in GB
    } catch {
      return null;
    }
  }

  const rootFreeGB = getFreeGB('/');
  const varFreeGB = getFreeGB('/var');

  if (rootFreeGB !== null) console.log(`  / (data): ${rootFreeGB} GB free`);
  if (varFreeGB !== null) console.log(`  /var (swap): ${varFreeGB} GB free`);

  const minFree = Math.min(rootFreeGB ?? Infinity, varFreeGB ?? Infinity);

  if (minFree < 8) {
    console.log('  WARNING: Low disk space (<8 GB) — auto-cleaning STALE PI swap files...');
    // Only safe at startup before PI has loaded working images
    cleanPISwapFiles();

    // Re-check after cleaning
    const rootAfter = getFreeGB('/');
    const varAfter = getFreeGB('/var');
    const minAfter = Math.min(rootAfter ?? Infinity, varAfter ?? Infinity);

    if (rootAfter !== null) console.log(`  / (data) after cleanup: ${rootAfter} GB free`);
    if (varAfter !== null) console.log(`  /var (swap) after cleanup: ${varAfter} GB free`);

    if (minAfter < 5) {
      console.error('  FATAL: Less than 5 GB free after cleanup — aborting to prevent data loss');
      process.exit(1);
    }
  }

  return { rootFreeGB, varFreeGB };
}

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

  // Pre-flight: disk space check and PI swap cleanup
  checkDiskSpace();
  cleanPISwapFiles();

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

  // Add run label for internal version naming (last 8 chars of run ID)
  brief.runLabel = store.runId.split('_').pop().slice(0, 8);

  store.saveBrief(brief);
  console.log(`  Run ID: ${store.runId}`);
  console.log(`  Run label: ${brief.runLabel}`);
  console.log(`  Artifacts: ${store.baseDir}`);

  // ================================================================
  // PHASE 1: DETERMINISTIC PREP (no LLM, pure code)
  // ================================================================
  console.log('\n--- Phase 1: Deterministic Prep (no LLM) ---');
  const prepResult = await runDeterministicPrep(ctx, config, {
    outputDir: path.join(store.baseDir, 'prep'),
    runDir: store.baseDir,
    log: console.log,
    brief: brief,
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
- L is STARLESS, stretched from processing profile targets
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

  // Do NOT clean swap files here — PI still has images open and needs its swap files.
  // Cleaning while PI is running causes crashes. Only clean on startup (before PI connects).

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

  // Robust export: use the view_id from the agent's finish call, fall back to parsing last output
  let finishViewId = result.finishResult?.view_id || null;
  let viewIdSource = finishViewId ? 'finishResult' : null;

  // If finishResult didn't yield a view_id, try to parse the agent's last output text
  if (!finishViewId) {
    const lastText = result.transcript?.[result.transcript.length - 1]?.content || '';
    console.log(`  [DEBUG] finishResult: ${JSON.stringify(result.finishResult)}`);
    console.log(`  [DEBUG] Last transcript text (first 500): ${lastText.slice(0, 500)}`);

    // Try multiple patterns on the agent's last output
    const patterns = [
      /Finished\b[^.]*\.\s*Best:\s*(\w+)/,        // Exact tool output
      /\bBest:\s*[`'"]?(\w+)[`'"]?/i,              // "Best: VIEW_ID"
      /\bwinner[:\s]+[`'"]?(\w+)[`'"]?/i,          // "winner: VIEW_ID"
      /\bfinal(?:ized?)?\s+(?:image|result|view|output)\s+(?:is\s+)?[`'"]*(\w+)/i,
      /\bview[_\s]?id[:\s]+[`'"]*(\w+)/i,          // "view_id: X"
      /\b(COMP_\w+)\b/,                            // COMP_ prefixed names
      /\b(FINAL_\w+)\b/,                           // FINAL_ prefixed names
      /\b([A-Za-z]\w*_FINAL)\b/,                   // _FINAL suffixed names
    ];

    for (const pat of patterns) {
      const m = lastText.match(pat);
      if (m) {
        finishViewId = m[1];
        viewIdSource = `transcript-regex(${pat.source.slice(0, 30)})`;
        break;
      }
    }
  }

  if (finishViewId) {
    console.log(`  Agent finished with view: ${finishViewId} (source: ${viewIdSource})`);
  } else {
    console.log(`  No view_id from agent finish or transcript — will use heuristic`);
  }

  try {
    // Save to /tmp first (reliable), then copy to output dir
    const tmpXisf = `/tmp/${targetName}_export.xisf`;
    const tmpPng = `/tmp/${targetName}_export.png`;

    // Sanitize agent view_id for safe PJSR injection (strip non-alphanumeric/underscore)
    const safeAgentViewId = finishViewId ? finishViewId.replace(/[^a-zA-Z0-9_]/g, '') : '';

    const saveResult = await ctx.pjsr(`
      var best = null;
      var bestId = '';
      var bestMedian = 0;

      // First: try the exact view the agent's finish tool specified
      var agentId = '${safeAgentViewId}';
      if (agentId) {
        var w = ImageWindow.windowById(agentId);
        if (!w.isNull && w.mainView.image.numberOfChannels === 3 && w.mainView.image.median() > 0.01) {
          best = w;
          bestId = agentId;
          bestMedian = w.mainView.image.median();
        }
      }

      // Fallback: heuristic name scoring if agent view not found
      if (!best) {
        var candidates = [];
        var ws = ImageWindow.windows;
        for (var i = 0; i < ws.length; i++) {
          var img = ws[i].mainView.image;
          if (img.numberOfChannels === 3 && img.median() > 0.01) {
            var id = ws[i].mainView.id;
            var score = 0;
            // Prefer processed views over baselines
            if (id.indexOf('FINAL') >= 0 || id.indexOf('final') >= 0) score += 200;
            if (id.indexOf('COMP') >= 0 || id.indexOf('comp') >= 0) score += 100;
            if (id.indexOf('work') >= 0 || id.indexOf('detail') >= 0) score += 50;
            // Penalize baselines and backups
            if (id.indexOf('baseline') >= 0 || id.indexOf('backup') >= 0) score -= 100;
            if (id === '${targetName}') score += 10; // original target name = mild preference
            candidates.push({ id: id, score: score, median: img.median(), w: ws[i] });
          }
        }
        candidates.sort(function(a, b) {
          if (a.score !== b.score) return b.score - a.score;
          return 0; // Don't sort by median — processed views may be darker
        });

        if (candidates.length === 0) throw new Error('No color image found for export');
        best = candidates[0].w;
        bestId = candidates[0].id;
        bestMedian = candidates[0].median;
      }

      // Stars: do NOT blend here — the agent already blends stars during composition,
      // and the finish handler also auto-blends. Adding stars a third time washes out
      // nebula detail and makes the core look flat/monotone.
      var starView = null; // kept for reporting only

      // Save to /tmp (reliable path, no network drives)
      best.saveAs('${tmpXisf}', false, false, false, false);
      best.mainView.id = bestId;
      best.saveAs('${tmpPng}', false, false, false, false);
      best.mainView.id = bestId;
      'Exported ' + bestId + ' (med=' + bestMedian.toFixed(4) + ', agent_requested=' + agentId + ', stars=' + (starView ? 'blended' : 'already present or not found') + ')';
    `);
    console.log(`  ${saveResult.outputs?.consoleOutput || 'done'}`);

    // Copy from /tmp to output dir
    const fsCopy = await import('fs');
    if (fsCopy.default.existsSync(tmpXisf)) {
      fsCopy.default.copyFileSync(tmpXisf, xisfPath);
      console.log(`  Saved: ${xisfPath}`);
    }
    if (fsCopy.default.existsSync(tmpPng)) {
      fsCopy.default.copyFileSync(tmpPng, pngPath);
      console.log(`  Saved: ${pngPath}`);
    }
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

  // P3b: Update processing profile with learned parameters from this run
  try {
    updateProcessingProfile(brief.target.classification, store);
  } catch (e) {
    console.log(`  Profile learning skipped: ${e.message}`);
  }

  // Token usage summary
  // claude CLI reports: input_tokens (non-cached) + cache_read + cache_creation + output_tokens
  // Real input cost = input_tokens + cache_read + cache_creation
  const usage = result.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const totalInput = inputTokens + cacheRead + cacheCreation;
  const totalTokens = totalInput + outputTokens;

  // Generate execution trace diagram
  let traceStats = '';
  try {
    const tracePath = path.join(store.baseDir, 'trace.jsonl');
    if (fs.existsSync(tracePath)) {
      const { analyzeTrace } = await import('./trace-analyzer.mjs');
      const { generateMermaidDiagram, generateTraceSummary } = await import('./trace-mermaid.mjs');

      const analysis = analyzeTrace(tracePath);
      const mermaid = generateMermaidDiagram(analysis);
      const summary = generateTraceSummary(analysis);

      fs.writeFileSync(path.join(store.baseDir, 'trace-analysis.json'), JSON.stringify(analysis, null, 2));
      fs.writeFileSync(path.join(store.baseDir, 'trace-diagram.mmd'), mermaid);
      fs.writeFileSync(path.join(store.baseDir, 'trace-summary.md'), summary);

      const deadEnds = Object.values(analysis.branches).filter(b => b.outcome === 'dead-end').length;
      const gateFails = analysis.qualityGates.filter(g => !g.pass).length;
      traceStats = `  Trace: ${analysis.totalCalls} tool calls, ${Object.keys(analysis.branches).length} branches (${deadEnds} dead-ends), ${analysis.qualityGates.length} quality checks (${gateFails} failures)`;
      console.log(`\n--- Execution Trace ---`);
      console.log(traceStats);
      console.log(`  Diagram: ${path.join(store.baseDir, 'trace-diagram.mmd')}`);
      console.log(`  Summary: ${path.join(store.baseDir, 'trace-summary.md')}`);
    }
  } catch (e) {
    console.log(`  Trace generation skipped: ${e.message}`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  GIGA Processing complete!`);
  console.log(`  Final: ${pngPath}`);
  console.log(`  Run: ${store.baseDir}`);
  console.log(`  Duration: ${Math.round(elapsed / 1000)}s (${result.turnCount || 0} turns)`);
  console.log(`  Tokens: ${totalTokens.toLocaleString()} total`);
  console.log(`    Input: ${totalInput.toLocaleString()} (${inputTokens.toLocaleString()} fresh + ${cacheRead.toLocaleString()} cache-read + ${cacheCreation.toLocaleString()} cache-write)`);
  console.log(`    Output: ${outputTokens.toLocaleString()}`);
  if (traceStats) console.log(traceStats);
  console.log(`${'='.repeat(60)}`);
}

// ============================================================================
// P3b: Processing profile learning — update learned_overrides from winning params
// ============================================================================
function updateProcessingProfile(classification, store) {
  const profilePath = path.join(__dirname, '../../agents/processing-profiles.json');
  if (!fs.existsSync(profilePath)) {
    console.log('  Profile learning: no processing-profiles.json found');
    return;
  }

  const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
  const profile = profiles[classification];
  if (!profile) {
    console.log(`  Profile learning: no profile for "${classification}"`);
    return;
  }

  // Strategy 1: Extract from artifact store winner variant metadata
  const learned = {};
  const manifest = store.manifest;
  const winnerAgents = Object.keys(manifest.agents || {});

  for (const agentName of winnerAgents) {
    try {
      const winner = store.getWinner(agentName);
      if (!winner?.params) continue;
      const p = winner.params;

      if (p.ha_strength !== undefined) learned.ha_strength = p.ha_strength;
      if (p.oiii_strength !== undefined) learned.oiii_strength = p.oiii_strength;
      if (p.lhe_amounts) learned.lhe_amounts = p.lhe_amounts;
      if (p.star_power !== undefined) learned.star_power = p.star_power;
      if (p.composition_method) learned.composition_method = p.composition_method;
      if (p.screen_blend_strength !== undefined) learned.screen_blend_strength = p.screen_blend_strength;
      if (p.lrgb_lightness !== undefined) learned.lrgb_lightness = p.lrgb_lightness;
      if (p.lrgb_saturation !== undefined) learned.lrgb_saturation = p.lrgb_saturation;
      if (p.saturation_midpoint !== undefined) learned.saturation_midpoint = p.saturation_midpoint;
      if (p.hdrmt_layers !== undefined) learned.hdrmt_layers = p.hdrmt_layers;
      if (p.hdrmt_iterations !== undefined) learned.hdrmt_iterations = p.hdrmt_iterations;
    } catch { /* skip unreadable winner */ }
  }

  // Strategy 2: Parse agent memory for winning_param entries from this run
  if (Object.keys(learned).length === 0) {
    const memDir = path.join(home, '.pixinsight-mcp', 'agent-memory');
    const gigaMemFile = path.join(memDir, 'giga_orchestrator.json');
    if (fs.existsSync(gigaMemFile)) {
      const entries = JSON.parse(fs.readFileSync(gigaMemFile, 'utf-8'));
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recentWinners = entries.filter(e =>
        e.tags?.includes('winning_param') &&
        (e.timestamp || e.date || '') >= oneHourAgo
      );

      for (const entry of recentWinners) {
        const content = entry.content || '';
        const title = (entry.title || '').toLowerCase();

        const haMatch = content.match(/ha[_ ]?(?:inject(?:ion)?|strength)[=: ]*(\d+\.?\d*)/i);
        if (haMatch) learned.ha_strength = parseFloat(haMatch[1]);

        const oiiiMatch = content.match(/oiii[_ ]?strength[=: ]*(\d+\.?\d*)/i);
        if (oiiiMatch) learned.oiii_strength = parseFloat(oiiiMatch[1]);

        const lheMatches = content.match(/(?:lhe|amount)[=: ]*(\d+\.?\d*)/gi);
        if (lheMatches) {
          learned.lhe_amounts = lheMatches.map(m => parseFloat(m.match(/(\d+\.?\d*)/)[1]));
        }

        const starMatch = content.match(/star[_ ]?(?:power|reduction|factor)[=: ]*(\d+\.?\d*)/i);
        if (starMatch) learned.star_power = parseFloat(starMatch[1]);

        if (title.includes('composition') || title.includes('comp')) {
          const methodMatch = content.match(/(rgb[_ ]?only|lrgb|pixelmath[_ ]?l|synth(?:etic)?[_ ]?l)/i);
          if (methodMatch) learned.composition_method = methodMatch[1].toLowerCase().replace(/\s+/g, '_');
        }

        const blendMatch = content.match(/(?:screen[_ ]?)?blend[_ ]?strength[=: ]*(\d+\.?\d*)/i);
        if (blendMatch) learned.screen_blend_strength = parseFloat(blendMatch[1]);

        const lightnessMatch = content.match(/lightness[=: ]*(\d+\.?\d*)/i);
        if (lightnessMatch) learned.lrgb_lightness = parseFloat(lightnessMatch[1]);

        const satMatch = content.match(/(?:lrgb[_ ])?saturation[=: ]*(\d+\.?\d*)/i);
        if (satMatch) learned.lrgb_saturation = parseFloat(satMatch[1]);
      }
    }
  }

  if (Object.keys(learned).length > 0) {
    profile.learned_overrides = { ...profile.learned_overrides, ...learned };
    profile.learned_overrides._lastUpdated = new Date().toISOString();
    profile.learned_overrides._runId = store.runId;
    fs.writeFileSync(profilePath, JSON.stringify(profiles, null, 2) + '\n');
    console.log(`  Profile learning: updated "${classification}" with ${Object.keys(learned).length} param(s): ${Object.keys(learned).join(', ')}`);
  } else {
    console.log('  Profile learning: no extractable params from this run');
  }
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
