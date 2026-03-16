#!/usr/bin/env node
// ============================================================================
// LLM-Driven Agentic Pipeline Orchestrator
//
// Entry point for autonomous astrophotography processing using real
// Claude conversations with tool use and vision.
//
// Usage:
//   node agents/llm/orchestrator.mjs --config /path/to/config.json \
//     [--intent "natural galaxy"] [--model claude-sonnet-4-20250514]
//
// IMPORTANT — PixInsight bridge serialization:
//   There is a single PixInsight instance reachable via the file-based bridge
//   (~/.pixinsight-mcp/bridge/). All agents share that one bridge context.
//   Agents are run SEQUENTIALLY — never in parallel — to avoid command
//   collisions on the bridge. Even critic agents (which only measure, not
//   process) run after the doer completes, so there is always exactly one
//   caller at a time.
//
//   If parallel branches are added later (e.g. Ha + L concurrently), the
//   bridge must be wrapped in a serializing queue or each branch must get
//   its own PixInsight instance with a dedicated bridge directory.
//
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Load .env from project root (ANTHROPIC_API_KEY)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

import { createBridgeContext, BridgeCrashError } from '../ops/bridge.mjs';
import { getStats, measureUniformity } from '../ops/stats.mjs';
import { ArtifactStore } from '../artifact-store.mjs';
import { generateBrief } from '../classifier.mjs';
import { checkHardConstraints, statsToScores, computeAggregate } from '../scoring.mjs';
import { generateDossier } from '../dossier.mjs';
import { LLMAgent } from './engine.mjs';
import { buildToolSet } from './tools.mjs';
import { generateDiagnosticViews, buildImageMessage } from './vision.mjs';
import { buildReadinessPrompt } from './prompts/readiness.mjs';
import { buildRGBCleanlinessPrompt } from './prompts/rgb-cleanliness.mjs';
import { buildStarPolicyPrompt } from './prompts/star-policy.mjs';
import { buildHaIntegrationPrompt } from './prompts/ha-integration.mjs';
import { buildLuminanceDetailPrompt } from './prompts/luminance-detail.mjs';
import { buildCompositionPrompt } from './prompts/composition.mjs';
import { buildAestheticCriticPrompt } from './prompts/aesthetic-critic.mjs';
import { buildTechnicalCriticPrompt } from './prompts/technical-critic.mjs';

const home = os.homedir();

// ============================================================================
// Live status file — written after every significant event
// ============================================================================

/**
 * Write a live status markdown file that the user can `watch cat` during a run.
 * Overwrites the file each time with the full current state.
 *
 * @param {ArtifactStore} store
 * @param {string[]} statusLines - Array of markdown lines
 */
function updateLiveStatus(store, statusLines) {
  const statusPath = path.join(store.baseDir, 'live_status.md');
  fs.writeFileSync(statusPath, statusLines.join('\n') + '\n');
}

/**
 * Format elapsed time as human-readable string.
 */
function fmtTime(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

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
    else if (args[i] === '--model' && args[i + 1]) opts.model = args[++i];
    else if (args[i] === '--run-id' && args[i + 1]) opts.runId = args[++i];
    else if (args[i] === '--max-turns' && args[i + 1]) opts.maxTurns = parseInt(args[++i]);
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--skip-critics') opts.skipCritics = true;
    else if (args[i] === '--critic-model' && args[i + 1]) opts.criticModel = args[++i];
    else if (args[i] === '--resume') opts.resume = true;
  }
  return opts;
}

// ============================================================================
// Stage helpers
// ============================================================================

/**
 * Run a doer agent with critic as ADVISOR (not gatekeeper).
 * Single pass — no retries. Critic feedback is logged for provenance and next-run memory.
 * Returns advisorFeedback for feed-forward to downstream stages.
 */
async function runDoerWithCritics(ctx, store, brief, {
  doerName, doerPromptBuilder, targetViewId, model, criticModel, maxTurns, skipCritics, starsViewId, config,
  stageIndex, statusLines, promptOptions,
}) {
  console.log(`\n  --- ${doerName} ---`);

  // Build doer tools and prompt — pass promptOptions (including accumulated advisor feedback)
  const doerTools = buildToolSet(doerName);
  const systemPrompt = doerPromptBuilder(brief, config, promptOptions || {});

  // Generate diagnostic previews
  const diagDir = path.join(store.baseDir, 'diagnostics', doerName);
  const diagPaths = await generateDiagnosticViews(ctx, targetViewId, diagDir);

  // Build initial message
  const stats = await getStats(ctx, targetViewId);
  const uni = await measureUniformity(ctx, targetViewId);
  let initialText = `## Your task

Process the image view \`${targetViewId}\` according to the processing brief.

### Current image stats
- Median: ${stats.median.toFixed(6)} (${Math.round(stats.median * 65535)} ADU)
- MAD: ${stats.mad.toFixed(6)}
- Min: ${(stats.min ?? 0).toFixed(6)}, Max: ${(stats.max ?? 0).toFixed(4)}
- Background uniformity: ${uni.score.toFixed(6)} (${uni.score < 0.002 ? 'excellent' : uni.score < 0.005 ? 'acceptable' : 'poor'})`;

  if (stats.perChannel) {
    initialText += `\n- Per-channel medians: R=${stats.perChannel.R.median.toFixed(6)}, G=${stats.perChannel.G.median.toFixed(6)}, B=${stats.perChannel.B.median.toFixed(6)}`;
  }

  if (starsViewId) {
    initialText += `\n\n### Stars image available: \`${starsViewId}\``;
  }

  initialText += `\n\n### Diagnostic views attached
1. Overview — full image resized
2. Center 1:1 crop — subject detail quality
3. Corner 1:1 crop — background quality
4. Background-stretched — reveals faint gradients/structure`;

  const initialContent = buildImageMessage(initialText, diagPaths);

  // Update live status: doer starting
  const stageLabel = `Stage ${stageIndex}: ${doerName.replace(/_/g, ' ')}`;
  if (statusLines) {
    statusLines.push(`## ${stageLabel} — running`);
    updateLiveStatus(store, statusLines);
    statusLines.pop();
  }

  // Create and run the doer
  const doer = new LLMAgent(doerName, {
    systemPrompt,
    tools: doerTools,
    model,
    budget: { maxTurns: maxTurns || 20, maxWallClockMs: 30 * 60_000 },
    store,
    brief,
    ctx,
  });

  const doerResult = await doer.run(initialContent);

  // Check for PI crash
  if (doerResult.crashError) throw doerResult.crashError;

  let doerFinish = doerResult.finishResult;
  if (!doerFinish) {
    const variants = store.listVariants(doerName);
    if (variants.length > 0) {
      const lastVariant = variants[variants.length - 1];
      console.log(`  Using last saved variant: ${lastVariant.viewId}`);
      doerFinish = doerResult.finishResult = { type: 'finish', view_id: lastVariant.viewId, rationale: 'Budget exhausted — using last saved variant' };
    }
  }

  // Save transcript
  const transcriptDir = path.join(store.baseDir, 'transcripts');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(transcriptDir, `${doerName}.json`),
    JSON.stringify(doerResult.transcript, null, 2)
  );

  // Compute scores
  const finalViewId = doerFinish?.view_id || targetViewId;
  const finalStats = await getStats(ctx, finalViewId);
  const finalUni = await measureUniformity(ctx, finalViewId);
  const autoScores = statsToScores(finalStats, finalUni, brief);
  const autoAgg = computeAggregate(autoScores, brief.target.classification);

  const elapsed = doerResult?.elapsedMs || 0;
  const turns = doerResult?.turnCount || 0;
  const scoreStr = autoAgg.aggregate != null ? `, score ${autoAgg.aggregate.toFixed(1)}` : '';

  // --- Critic as ADVISOR (not gatekeeper) ---
  let advisorFeedback = '';
  if (!skipCritics) {
    console.log(`  --- Advisor reviewing ${doerName} result ---`);
    const criticDiagDir = path.join(store.baseDir, 'diagnostics', `${doerName}_advisor`);
    const criticDiagPaths = await generateDiagnosticViews(ctx, finalViewId, criticDiagDir);
    const criticImagePaths = criticDiagPaths.filter(p => !p.includes('bg_stretch'));

    const criticText = `## Review this image and provide improvement suggestions

Target: **${brief.target.name}** (${brief.target.classification})
Stats: median=${finalStats.median.toFixed(6)}, max=${(finalStats.max ?? 0).toFixed(4)}, uniformity=${finalUni.score.toFixed(6)}

You are an ADVISOR, not a gatekeeper. The pipeline will proceed regardless.
Provide 2-3 specific, actionable suggestions for improvement that the next run can use.
Do NOT reject — just advise.`;

    const criticContent = buildImageMessage(criticText, criticImagePaths);

    const advisor = new LLMAgent('aesthetic_critic', {
      systemPrompt: buildAestheticCriticPrompt(brief),
      tools: buildToolSet('aesthetic_critic'),
      model: criticModel || model,
      budget: { maxTurns: 3, maxWallClockMs: 2 * 60_000 },
      store, brief, ctx,
    });

    const advisorResult = await advisor.run(criticContent);
    if (!advisorResult.crashError) {
      advisorFeedback = advisorResult.finishResult?.feedback || '';
      if (advisorFeedback) {
        console.log(`  Advisor: ${advisorFeedback.slice(0, 200)}`);
        // Save to agent memory for next run
        const memDir = path.join(os.homedir(), '.pixinsight-mcp', 'agent-memory');
        fs.mkdirSync(memDir, { recursive: true });
        const memFile = path.join(memDir, `${doerName}.json`);
        let entries = [];
        if (fs.existsSync(memFile)) entries = JSON.parse(fs.readFileSync(memFile, 'utf-8'));
        entries.push({
          title: `Advisor feedback (${store.runId})`,
          content: advisorFeedback.slice(0, 500),
          tags: ['advisor', 'feedback'],
          date: new Date().toISOString().slice(0, 10),
          timestamp: new Date().toISOString()
        });
        fs.writeFileSync(memFile, JSON.stringify(entries, null, 2));
      }
      fs.writeFileSync(
        path.join(transcriptDir, `${doerName}_advisor.json`),
        JSON.stringify(advisorResult.transcript, null, 2)
      );
    }
  }

  // --- Advisor-driven refinement pass ---
  // If the advisor gave actionable feedback AND the doer is a creative agent (not glue-only),
  // send the feedback back to the doer for one focused refinement pass.
  let refinementResult = null;
  const creativeAgents = ['rgb_cleanliness', 'luminance_detail', 'composition'];
  if (advisorFeedback && creativeAgents.includes(doerName)) {
    console.log(`  --- Refinement pass: applying advisor feedback ---`);
    if (statusLines) {
      statusLines.push(`## ${stageLabel} — refinement pass`);
      updateLiveStatus(store, statusLines);
      statusLines.pop();
    }

    const refinementText = `## Refinement pass — apply advisor feedback

The advisor reviewed your work and has specific improvement suggestions:

${advisorFeedback}

You have the same tools available. The image is in the state you left it.
Apply the advisor's suggestions — focus on the TOP 1-2 most impactful changes.
Clone before experimenting. Show a preview after each change.
Call finish when done.`;

    const refinementDoer = new LLMAgent(doerName, {
      systemPrompt: doerPromptBuilder(brief, config, promptOptions || {}),
      tools: doerTools,
      model,
      budget: { maxTurns: 10, maxWallClockMs: 5 * 60_000 },
      store, brief, ctx,
    });

    refinementResult = await refinementDoer.run([{ type: 'text', text: refinementText }]);
    if (refinementResult.crashError) throw refinementResult.crashError;

    if (refinementResult.finishResult) {
      doerFinish = refinementResult.finishResult;
    }

    fs.writeFileSync(
      path.join(transcriptDir, `${doerName}_refinement.json`),
      JSON.stringify(refinementResult.transcript, null, 2)
    );

    console.log(`  Refinement: ${refinementResult.turnCount} turns, ${fmtTime(refinementResult.elapsedMs)}`);
  }

  const totalTurns = turns + (refinementResult?.turnCount || 0);
  const totalElapsed = elapsed + (refinementResult?.elapsedMs || 0);

  // Update live status
  if (statusLines) {
    statusLines.push(`## ${stageLabel} ✅ (${totalTurns} turns, ${fmtTime(totalElapsed)}${scoreStr}${refinementResult ? ' +refinement' : ''})`);
    if (advisorFeedback) {
      statusLines.push(`> Advisor: ${advisorFeedback.slice(0, 200)}`);
    }
    updateLiveStatus(store, statusLines);
  }

  return {
    winnerId: doerFinish?.view_id || targetViewId,
    winnerScore: autoAgg.aggregate,
    doerResult,
    attempts: 1,
    advisorFeedback,
  };
}

// ============================================================================
// Main orchestration flow
// ============================================================================
async function orchestrate() {
  const opts = parseArgs();

  const configPath = opts.configPath;
  if (!configPath || !fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath || '(none provided)'}`);
    console.error('Usage: node agents/llm/orchestrator.mjs --config /path/to/config.json');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  LLM-Driven Agentic Pipeline`);
  console.log(`  Target: ${config.files?.targetName || config.name}`);
  console.log(`  Config: ${configPath}`);
  console.log(`  Model: ${opts.model || 'claude-sonnet-4-20250514'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Bridge context
  const ctx = createBridgeContext({ log: console.log });

  // Verify PixInsight
  try {
    const imgs = await ctx.listImages();
    console.log(`PixInsight connected (${imgs.length} images open)`);
  } catch (err) {
    console.error(`Cannot reach PixInsight bridge: ${err.message}`);
    console.error('Ensure the watcher is running in PixInsight.');
    process.exit(1);
  }

  // --- Stage 0: Classification ---
  console.log('\n--- Stage 0: Classification ---');
  const brief = generateBrief(config, { intent: opts.intent, style: opts.style });
  console.log(`  Target: ${brief.target.name} (${brief.target.classification})`);
  console.log(`  Workflow: ${brief.dataDescription.workflow}`);
  console.log(`  Style: ${brief.aestheticIntent.style}`);

  // Auto-clean old runs to prevent disk full (keep only 2 most recent)
  const runsDir = path.join(home, '.pixinsight-mcp', 'runs');
  if (fs.existsSync(runsDir)) {
    const oldRuns = fs.readdirSync(runsDir).filter(d => d.startsWith('run_')).sort().reverse();
    if (oldRuns.length > 2) {
      for (const old of oldRuns.slice(2)) {
        console.log(`  Cleaning old run: ${old}`);
        fs.rmSync(path.join(runsDir, old), { recursive: true, force: true });
      }
      console.log(`  Cleaned ${oldRuns.length - 2} old run(s)`);
    }
  }

  const store = new ArtifactStore(opts.runId);
  store.saveBrief(brief);
  console.log(`  Run ID: ${store.runId}`);
  console.log(`  Artifacts: ${store.baseDir}`);

  if (opts.dryRun) {
    console.log('\n--- DRY RUN: Classification complete ---');
    console.log(JSON.stringify(brief, null, 2));
    return;
  }

  const F = config.files;
  const targetName = F.targetName || 'Target';
  const targetDisplayName = config.files?.targetName || config.name;

  // --- Resume logic ---
  let resumeFromStage = 0; // 0 = start from scratch
  let starsViewId = null;

  if (opts.resume) {
    const lastStage = store.getLastCompletedStage();
    if (!lastStage) {
      console.log('  No completed stages found — starting from scratch');
    } else {
      resumeFromStage = lastStage.stageIndex + 1;
      console.log(`  Resuming from stage ${resumeFromStage} (last completed: stage ${lastStage.stageIndex} — ${lastStage.agentName})`);

      // Wait for PixInsight to be ready
      console.log('  Waiting for PixInsight watcher...');
      for (let i = 0; i < 60; i++) {
        if (await ctx.ping(5000)) { console.log('  PixInsight ready!'); break; }
        if (i === 59) { console.error('  PixInsight not responding after 5 minutes. Exiting.'); process.exit(1); }
        await new Promise(r => setTimeout(r, 5000));
      }

      // Load the last completed stage's winner XISF into PixInsight
      const variants = store.listVariants(lastStage.agentName);
      if (variants.length > 0) {
        const lastVariant = variants[variants.length - 1];
        if (lastVariant.xisfPath && fs.existsSync(lastVariant.xisfPath)) {
          console.log(`  Loading last variant: ${lastVariant.xisfPath}`);
          await ctx.send('open_image', '__internal__', { filePath: lastVariant.xisfPath });
          // Close crop masks
          const imgs = await ctx.listImages();
          for (const cm of imgs.filter(i => i.id.includes('crop_mask'))) {
            await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
          }
          // Rename to target name
          const loaded = await ctx.listImages();
          const colorLoaded = loaded.find(i => i.isColor) || loaded[0];
          if (colorLoaded && colorLoaded.id !== targetName) {
            await ctx.pjsr(`var w = ImageWindow.windowById('${colorLoaded.id}'); if (!w.isNull) w.mainView.id = '${targetName}';`);
          }
          console.log(`  Restored: ${targetName}`);
        } else {
          console.log('  WARNING: No XISF found for last variant. Starting from scratch.');
          resumeFromStage = 0;
        }
      } else {
        // No variants saved, but check if PI still has the image open
        const currentImgs = await ctx.listImages();
        const targetInPI = currentImgs.find(i => i.id === lastStage.winnerId || i.isColor);
        if (targetInPI) {
          console.log(`  No saved variants, but PI still has ${targetInPI.id} open. Resuming.`);
          if (targetInPI.id !== targetName) {
            await ctx.pjsr(`var w = ImageWindow.windowById('${targetInPI.id}'); if (!w.isNull) w.mainView.id = '${targetName}';`);
          }
        } else {
          console.log('  WARNING: No variants and no images in PI. Starting from scratch.');
          resumeFromStage = 0;
        }
      }

      // Restore starsViewId if star_policy completed
      const starStage = (store.manifest.stageProgress || []).find(s => s.agentName === 'star_policy');
      if (starStage?.starsViewId) starsViewId = starStage.starsViewId;
    }
  }

  // --- Live status header ---
  const statusLines = [
    `# ${targetDisplayName} — Live Status`,
    `> Run: ${store.runId}  `,
    `> Started: ${new Date().toISOString()}  `,
    `> Model: ${opts.model || 'claude-sonnet-4-20250514'}`,
    resumeFromStage > 0 ? `> **RESUMED** from stage ${resumeFromStage}` : '',
    '',
  ].filter(Boolean);
  // Re-add completed stage lines from manifest
  if (resumeFromStage > 0) {
    for (const s of (store.manifest.stageProgress || [])) {
      statusLines.push(`## Stage ${s.stageIndex}: ${s.agentName.replace(/_/g, ' ')} ✅ (resumed)`);
    }
  }
  updateLiveStatus(store, statusLines);

  // --- Stage 1: Readiness Agent ---
  if (resumeFromStage <= 1) {
    console.log('\n--- Stage 1: Readiness Agent ---');
    statusLines.push('## Stage 1: Readiness — running');
    updateLiveStatus(store, statusLines);
    statusLines.pop();

    const readinessAgent = new LLMAgent('readiness', {
      systemPrompt: buildReadinessPrompt(brief, config),
      tools: buildToolSet('readiness'),
      model: opts.model,
      budget: { maxTurns: 25, maxWallClockMs: 15 * 60_000 },
      store,
      brief,
      ctx,
    });

    const readinessResult = await readinessAgent.run([{
      type: 'text',
      text: `Prepare the input masters for processing. The target view name should be \`${targetName}\`. Open the files, inspect them, handle any issues, and produce a combined RGB color image.`
    }]);

    if (readinessResult.crashError) {
      statusLines.push('## Stage 1: Readiness ❌ CRASHED');
      statusLines.push(`> Resume: \`--resume --run-id ${store.runId}\``);
      updateLiveStatus(store, statusLines);
      process.exit(77);
    }

    const transcriptDir0 = path.join(store.baseDir, 'transcripts');
    fs.mkdirSync(transcriptDir0, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir0, 'readiness.json'), JSON.stringify(readinessResult.transcript, null, 2));

    const allImgs = await ctx.listImages();
    const colorImg = allImgs.find(i => i.isColor);
    if (!colorImg) {
      console.error('  Readiness failed — no color image produced');
      statusLines.push('## Stage 1: Readiness ❌ FAILED — no color image produced');
      updateLiveStatus(store, statusLines);
      process.exit(1);
    }
    if (colorImg.id !== targetName) {
      await ctx.pjsr(`var w = ImageWindow.windowById('${colorImg.id}'); if (!w.isNull) w.mainView.id = '${targetName}';`);
    }
    console.log(`  Readiness complete: ${targetName} (${colorImg.width}x${colorImg.height})`);
    statusLines.push(`## Stage 1: Readiness ✅ (${readinessResult.turnCount} turns, ${fmtTime(readinessResult.elapsedMs)})`);
    updateLiveStatus(store, statusLines);
    store.recordStageCompletion(1, 'readiness', targetName, null);
  } else {
    console.log('\n--- Stage 1: Readiness — skipped (resumed) ---');
  }

  // Close individual channel windows to free memory (if they're still open)
  for (const id of ['FILTER_R', 'FILTER_G', 'FILTER_B', 'FILTER_Ha']) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${id}');if(!w.isNull)w.forceClose();`).catch(() => {});
  }

  // --- Crash-resilient stage runner ---
  function handleCrash(stageIndex, stageName, err) {
    console.error(`\n  CRASH at Stage ${stageIndex} (${stageName}): ${err.message}`);
    statusLines.push(`## ❌ Stage ${stageIndex}: ${stageName} — CRASHED`);
    statusLines.push(`> PixInsight crashed. Restart PI + watcher, then resume:`);
    statusLines.push(`> \`node agents/llm/orchestrator.mjs --config ${opts.configPath} --resume --run-id ${store.runId}\``);
    updateLiveStatus(store, statusLines);
    process.exit(77); // Distinct exit code for crash (vs 1 for errors)
  }

  // --- Feed-forward: accumulate advisor feedback from each stage ---
  // Each completed stage's advisor feedback is collected and injected into the next stage's prompt.
  const accumulatedFeedback = [];

  // --- Stage 2: RGB Cleanliness Agent ---
  let rgbResult;
  if (resumeFromStage <= 2) {
  console.log('\n--- Stage 2: RGB Cleanliness Agent ---');
  try {
  rgbResult = await runDoerWithCritics(ctx, store, brief, {
    doerName: 'rgb_cleanliness',
    doerPromptBuilder: buildRGBCleanlinessPrompt,
    targetViewId: targetName,
    model: opts.model,
    criticModel: opts.criticModel,
    maxTurns: opts.maxTurns || 30, // Phase A glue (~12 turns) + Phase B saturation iteration (~10-15 turns)
    skipCritics: opts.skipCritics,
    config,
    stageIndex: 2,
    statusLines,
    // No accumulated feedback yet — RGB is the first creative stage
  });
  } catch (err) { if (err?.isCrash) handleCrash(2, 'RGB Cleanliness', err); throw err; }
  console.log(`  Winner: ${rgbResult.winnerId} (score=${rgbResult.winnerScore?.toFixed(1) || 'N/A'}, attempts=${rgbResult.attempts})`);
  store.recordStageCompletion(2, 'rgb_cleanliness', rgbResult.winnerId, null, { score: rgbResult.winnerScore });

  // Feed-forward: collect advisor feedback for downstream stages
  if (rgbResult.advisorFeedback) {
    accumulatedFeedback.push(`**RGB Cleanliness advisor**: ${rgbResult.advisorFeedback}`);
  }

  // Early abort: if RGB cleanliness exhausted all attempts with a bad score, stop
  const RGB_EARLY_ABORT_THRESHOLD = 50;
  if (rgbResult.attempts > 2 && rgbResult.scorecard?.pass === false &&
      rgbResult.winnerScore != null && rgbResult.winnerScore < RGB_EARLY_ABORT_THRESHOLD) {
    const msg = `RGB Cleanliness failed all ${rgbResult.attempts} attempts with score ${rgbResult.winnerScore.toFixed(1)} (< ${RGB_EARLY_ABORT_THRESHOLD}). Aborting pipeline — fix input data before retrying.`;
    console.error(`\n  EARLY ABORT: ${msg}`);
    statusLines.push(`## ❌ PIPELINE ABORTED — RGB Cleanliness score too low (${rgbResult.winnerScore.toFixed(1)} < ${RGB_EARLY_ABORT_THRESHOLD})`);
    statusLines.push(`> All ${rgbResult.attempts} attempts were rejected by the critic.`);
    statusLines.push(`> Fix input data quality before retrying.`);
    updateLiveStatus(store, statusLines);
    process.exit(1);
  }

  } else { rgbResult = { winnerId: targetName, winnerScore: null, attempts: 0 }; }

  // --- Stage 3: Star Policy Agent ---
  let starResult;
  if (resumeFromStage <= 3) {
  console.log('\n--- Stage 3: Star Policy Agent ---');
  try {
  starResult = await runDoerWithCritics(ctx, store, brief, {
    doerName: 'star_policy',
    doerPromptBuilder: buildStarPolicyPrompt,
    targetViewId: rgbResult.winnerId || targetName,
    model: opts.model,
    criticModel: opts.criticModel,
    maxTurns: opts.maxTurns || 10, // Stars is all-glue, no creative iteration needed
    skipCritics: opts.skipCritics,
    stageIndex: 3,
    statusLines,
    promptOptions: {
      advisorFeedback: accumulatedFeedback.length > 0 ? accumulatedFeedback.join('\n\n') : undefined,
    },
  });
  } catch (err) { if (err?.isCrash) handleCrash(3, 'Star Policy', err); throw err; }
  console.log(`  Winner: ${starResult.winnerId} (attempts=${starResult.attempts})`);
  store.recordStageCompletion(3, 'star_policy', starResult.winnerId, null);
  if (starResult.advisorFeedback) {
    accumulatedFeedback.push(`**Star Policy advisor**: ${starResult.advisorFeedback}`);
  }
  // Check if stars were separated (look for a stars view)
  const postStarImgs = await ctx.listImages();
  const starsViewFound = postStarImgs.find(i => i.id.includes('stars') || i.id.includes('star'));
  if (starsViewFound) { starsViewId = starsViewFound.id; console.log(`  Stars image: ${starsViewId}`); }

  } else { starResult = { winnerId: targetName, attempts: 0 }; }

  // --- Stage 4: Ha Integration Agent (if Ha data available) ---
  const hasHa = !!(F.Ha?.trim());
  let haResult = null;
  if (hasHa && resumeFromStage <= 4) {
    console.log('\n--- Stage 4: Ha Integration Agent ---');
    try {
    haResult = await runDoerWithCritics(ctx, store, brief, {
      doerName: 'ha_integration',
      doerPromptBuilder: (b, c, opts) => buildHaIntegrationPrompt(b, c, opts),
      targetViewId: starResult.winnerId || targetName,
      model: opts.model,
      criticModel: opts.criticModel,
      maxTurns: opts.maxTurns || 15,
      skipCritics: opts.skipCritics,
      config,
      stageIndex: 4,
      statusLines,
      promptOptions: {
        advisorFeedback: accumulatedFeedback.length > 0 ? accumulatedFeedback.join('\n\n') : undefined,
      },
    });
    } catch (err) { if (err?.isCrash) handleCrash(4, 'Ha Integration', err); throw err; }
    console.log(`  Winner: ${haResult?.winnerId} (attempts=${haResult?.attempts})`);
    store.recordStageCompletion(4, 'ha_integration', haResult?.winnerId, null);
    if (haResult?.advisorFeedback) {
      accumulatedFeedback.push(`**Ha Integration advisor**: ${haResult.advisorFeedback}`);
    }
  } else if (!hasHa) {
    console.log('\n--- Stage 4: Ha Integration — skipped (no Ha data) ---');
    statusLines.push('## Stage 4: Ha Integration — skipped (no Ha data)');
    updateLiveStatus(store, statusLines);
  }

  const postHaViewId = haResult?.winnerId || starResult?.winnerId || targetName;

  // --- Stage 5: Luminance Detail Agent ---
  let lumResult;
  if (resumeFromStage <= 5) {
  console.log('\n--- Stage 5: Luminance Detail Agent ---');
  try {
  lumResult = await runDoerWithCritics(ctx, store, brief, {
    doerName: 'luminance_detail',
    doerPromptBuilder: buildLuminanceDetailPrompt,
    targetViewId: postHaViewId,
    model: opts.model,
    criticModel: opts.criticModel,
    maxTurns: opts.maxTurns || 35, // Phase A glue (~8-10 turns) + Phase B LHE/HDRMT iteration (~20-25 turns)
    skipCritics: opts.skipCritics,
    stageIndex: 5,
    statusLines,
    promptOptions: {
      advisorFeedback: accumulatedFeedback.length > 0 ? accumulatedFeedback.join('\n\n') : undefined,
    },
  });
  } catch (err) { if (err?.isCrash) handleCrash(5, 'Luminance Detail', err); throw err; }
  console.log(`  Winner: ${lumResult.winnerId} (score=${lumResult.winnerScore?.toFixed(1) || 'N/A'}, attempts=${lumResult.attempts})`);
  store.recordStageCompletion(5, 'luminance_detail', lumResult.winnerId, null, { score: lumResult.winnerScore });
  if (lumResult.advisorFeedback) {
    accumulatedFeedback.push(`**Luminance Detail advisor**: ${lumResult.advisorFeedback}`);
  }

  } else { lumResult = { winnerId: targetName, winnerScore: null, attempts: 0 }; }

  // --- Stage 6: Composition Agent ---
  let compResult;
  if (resumeFromStage <= 6) {
  console.log('\n--- Stage 6: Composition Agent ---');
  try {
  compResult = await runDoerWithCritics(ctx, store, brief, {
    doerName: 'composition',
    doerPromptBuilder: buildCompositionPrompt,
    targetViewId: lumResult.winnerId || targetName,
    model: 'claude-sonnet-4-20250514', // Composition needs strong tool-use reasoning for push-until-rejection
    criticModel: opts.criticModel,
    maxTurns: opts.maxTurns || 30, // Phase A glue (~4-5 turns) + Phase B contrast/saturation iteration (~20-25 turns)
    skipCritics: opts.skipCritics,
    starsViewId,
    stageIndex: 6,
    statusLines,
    promptOptions: {
      advisorFeedback: accumulatedFeedback.length > 0 ? accumulatedFeedback.join('\n\n') : undefined,
    },
  });
  } catch (err) { if (err?.isCrash) handleCrash(6, 'Composition', err); throw err; }
  console.log(`  Winner: ${compResult.winnerId} (score=${compResult.winnerScore?.toFixed(1) || 'N/A'}, attempts=${compResult.attempts})`);
  store.recordStageCompletion(6, 'composition', compResult.winnerId, null, { score: compResult.winnerScore });

  } else { compResult = { winnerId: targetName, winnerScore: null, attempts: 0 }; }

  // --- Stage 7: Technical Critic (final gate) ---
  console.log('\n--- Stage 7: Final Technical Review ---');
  const finalViewId = compResult.winnerId || targetName;

  if (!opts.skipCritics) {
    statusLines.push('## Stage 7: Final Technical Review — running');
    updateLiveStatus(store, statusLines);
    statusLines.pop();

    const techDiagDir = path.join(store.baseDir, 'diagnostics', 'final_technical');
    const techDiagPaths = await generateDiagnosticViews(ctx, finalViewId, techDiagDir);
    const finalStats = await getStats(ctx, finalViewId);
    const finalUni = await measureUniformity(ctx, finalViewId);

    const techText = `## Final Technical Review

Target: **${brief.target.name}** (${brief.target.classification})

This is the FINAL image before output. Your job is to verify it passes all hard constraints and flag any remaining technical issues.

### Stats
- Median: ${finalStats.median.toFixed(6)}, MAD: ${finalStats.mad.toFixed(6)}
- Max: ${(finalStats.max ?? 0).toFixed(4)}, Min: ${(finalStats.min ?? 0).toFixed(6)}
- Background uniformity: ${finalUni.score.toFixed(6)}`;

    const techCritic = new LLMAgent('technical_critic', {
      systemPrompt: buildTechnicalCriticPrompt(brief),
      tools: buildToolSet('technical_critic'),
      model: opts.criticModel || opts.model,
      budget: { maxTurns: 5, maxWallClockMs: 5 * 60_000 },
      store,
      brief,
      ctx,
    });

    const techImagePaths = techDiagPaths.filter(p => !p.includes('bg_stretch'));
    const techResult = await techCritic.run(buildImageMessage(techText, techImagePaths));
    const techVerdict = techResult.finishResult?.verdict || 'accept';
    console.log(`  Technical critic verdict: ${techVerdict}`);

    const transcriptDir = path.join(store.baseDir, 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(transcriptDir, 'final_technical_critic.json'),
      JSON.stringify(techResult.transcript, null, 2)
    );

    const techIcon = techVerdict === 'accept' ? '✅' : '⚠️';
    const techFeedback = techResult.finishResult?.feedback;
    statusLines.push(`## Stage 7: Final Technical Review ${techIcon} (${techResult.turnCount} turns, ${fmtTime(techResult.elapsedMs)})`);
    if (techVerdict === 'reject' && techFeedback) {
      statusLines.push(`### Technical critic flagged: "${techFeedback.slice(0, 300)}"`);
    }
    updateLiveStatus(store, statusLines);

    if (techVerdict === 'reject') {
      console.log(`  WARNING: Technical critic rejected final image. Proceeding anyway but flagging in dossier.`);
    }
  } else {
    statusLines.push('## Stage 7: Final Technical Review — skipped');
    updateLiveStatus(store, statusLines);
  }

  // --- Stage 6: Save final and generate dossier ---
  console.log('\n--- Stage 8: Finalize ---');
  statusLines.push('## Stage 8: Finalize — saving outputs');
  updateLiveStatus(store, statusLines);
  statusLines.pop();

  const outputDir = F.outputDir || path.join(home, 'Desktop');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const finalXisf = path.join(outputDir, `${targetName}_llm_agentic.xisf`);
  const finalJpeg = path.join(outputDir, `${targetName}_llm_agentic.jpg`);

  await ctx.pjsr(`
    var w = ImageWindow.windowById('${finalViewId}');
    if (!w.isNull) {
      var p = '${finalXisf.replace(/'/g, "\\'")}';
      if (File.exists(p)) File.remove(p);
      w.saveAs(p, false, false, false, false);
      if (w.mainView.id !== '${finalViewId}') w.mainView.id = '${finalViewId}';
    }
  `);
  console.log(`  Saved: ${finalXisf}`);

  await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${finalViewId}');
    var img = srcW.mainView.image;
    var tmp = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, false, img.isColor, 'final_llm_preview_tmp');
    tmp.mainView.beginProcess();
    tmp.mainView.image.assign(img);
    tmp.mainView.endProcess();
    var p = '${finalJpeg.replace(/'/g, "\\'")}';
    if (File.exists(p)) File.remove(p);
    tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
  `);
  console.log(`  Saved: ${finalJpeg}`);

  // Generate dossier with conversation summaries
  const agentResults = {
    rgb: {
      winnerId: rgbResult.winnerId,
      winnerScore: rgbResult.winnerScore,
      summary: {
        iterations: rgbResult.doerResult?.turnCount || 0,
        elapsedMs: rgbResult.doerResult?.elapsedMs || 0,
        state: 'completed',
        attempts: rgbResult.attempts,
      },
      winnerMetadata: { params: rgbResult.doerResult?.finishResult?.params_summary },
      transcript: rgbResult.doerResult?.transcript,
    },
    lum: {
      winnerId: lumResult.winnerId,
      winnerScore: lumResult.winnerScore,
      summary: {
        iterations: lumResult.doerResult?.turnCount || 0,
        elapsedMs: lumResult.doerResult?.elapsedMs || 0,
        state: 'completed',
        attempts: lumResult.attempts,
      },
      winnerMetadata: { params: lumResult.doerResult?.finishResult?.params_summary },
      transcript: lumResult.doerResult?.transcript,
    },
    comp: {
      winnerId: compResult.winnerId,
      winnerScore: compResult.winnerScore,
      summary: {
        iterations: compResult.doerResult?.turnCount || 0,
        elapsedMs: compResult.doerResult?.elapsedMs || 0,
        state: 'completed',
        attempts: compResult.attempts,
      },
      winnerMetadata: { params: compResult.doerResult?.finishResult?.params_summary },
      transcript: compResult.doerResult?.transcript,
    },
  };

  const dossier = generateDossier(store, brief, agentResults);
  const dossierDir = path.join(store.baseDir, '08_selection');
  fs.mkdirSync(dossierDir, { recursive: true });
  const dossierPath = path.join(dossierDir, 'dossier.md');
  fs.writeFileSync(dossierPath, dossier);
  console.log(`  Dossier: ${dossierPath}`);

  store.finalize(compResult.winnerId || 'unknown');

  // Final live status
  statusLines.push(`## Stage 8: Finalize ✅`);
  statusLines.push('');
  statusLines.push('---');
  statusLines.push(`**Processing complete** — ${new Date().toISOString()}`);
  statusLines.push(`- Final XISF: \`${finalXisf}\``);
  statusLines.push(`- Final JPEG: \`${finalJpeg}\``);
  statusLines.push(`- Dossier: \`${dossierPath}\``);
  updateLiveStatus(store, statusLines);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Processing complete!`);
  console.log(`  Final: ${finalXisf}`);
  console.log(`  Run: ${store.baseDir}`);
  console.log(`${'='.repeat(60)}\n`);
}

// ============================================================================
// Run
// ============================================================================
orchestrate().catch(err => {
  console.error('\nFATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
