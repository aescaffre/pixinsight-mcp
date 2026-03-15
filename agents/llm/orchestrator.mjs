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

import { createBridgeContext } from '../ops/bridge.mjs';
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
  }
  return opts;
}

// ============================================================================
// Stage helpers
// ============================================================================

/**
 * Run a doer agent with optional critic review loop.
 */
async function runDoerWithCritics(ctx, store, brief, {
  doerName, doerPromptBuilder, targetViewId, model, criticModel, maxTurns, skipCritics, starsViewId, config,
  stageIndex, statusLines,
}) {
  const maxRejections = 2;
  let attempt = 0;
  let criticFeedback = null;

  while (attempt <= maxRejections) {
    attempt++;
    console.log(`\n  --- ${doerName} (attempt ${attempt}/${maxRejections + 1}) ---`);

    // Build doer tools and prompt
    const doerTools = buildToolSet(doerName);
    const systemPrompt = doerPromptBuilder(brief, config);

    // Generate diagnostic previews
    const diagDir = path.join(store.baseDir, 'diagnostics', `${doerName}_attempt_${attempt}`);
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

    if (criticFeedback) {
      initialText += `\n\n### CRITIC FEEDBACK FROM PREVIOUS ATTEMPT\nThe critic rejected your previous result with this feedback:\n\n${criticFeedback}\n\nPlease address these specific issues in this attempt.`;
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
      statusLines.push(`## ${stageLabel} — running (attempt ${attempt}/${maxRejections + 1})`);
      updateLiveStatus(store, statusLines);
      // Remove the "running" line so we can replace it with the final one
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
    const doerFinish = doerResult.finishResult;

    if (!doerFinish) {
      console.log(`  WARNING: ${doerName} did not call finish. Checking for saved variants...`);
      // If the agent saved variants but didn't call finish, use the last variant's view
      const variants = store.listVariants(doerName);
      if (variants.length > 0) {
        const lastVariant = variants[variants.length - 1];
        console.log(`  Using last saved variant: ${lastVariant.viewId}`);
        doerResult.finishResult = { type: 'finish', view_id: lastVariant.viewId, rationale: 'Budget exhausted — using last saved variant' };
      }
    }

    // Save transcript
    const transcriptDir = path.join(store.baseDir, 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(transcriptDir, `${doerName}_attempt_${attempt}.json`),
      JSON.stringify(doerResult.transcript, null, 2)
    );

    // Skip critics if requested
    if (skipCritics) {
      console.log(`  Skipping critics (--skip-critics)`);
      const elapsed = doerResult?.elapsedMs || 0;
      const turns = doerResult?.turnCount || 0;
      if (statusLines) {
        statusLines.push(`## ${stageLabel} ✅ (${turns} turns, ${fmtTime(elapsed)}, no critic)`);
        updateLiveStatus(store, statusLines);
      }
      return {
        winnerId: doerFinish?.view_id || targetViewId,
        winnerScore: null,
        doerResult,
        criticResults: [],
        attempts: attempt,
      };
    }

    // --- Critic review ---
    console.log(`\n  --- Aesthetic Critic reviewing ${doerName} result ---`);

    // Generate fresh preview for critic (they should see the current state, not doer's working state)
    const criticDiagDir = path.join(store.baseDir, 'diagnostics', `${doerName}_critic_${attempt}`);
    const criticViewId = doerFinish?.view_id || targetViewId;
    const criticDiagPaths = await generateDiagnosticViews(ctx, criticViewId, criticDiagDir);

    const criticStats = await getStats(ctx, criticViewId);
    const criticUni = await measureUniformity(ctx, criticViewId);

    const criticText = `## Image to evaluate

Target: **${brief.target.name}** (${brief.target.classification})

### Stats
- Median: ${criticStats.median.toFixed(6)}, MAD: ${criticStats.mad.toFixed(6)}
- Max: ${(criticStats.max ?? 0).toFixed(4)}, Min: ${(criticStats.min ?? 0).toFixed(6)}
- Background uniformity: ${criticUni.score.toFixed(6)}

### Diagnostic views
1. Overview
2. Center 1:1 crop
3. Corner 1:1 crop
4. Background-stretched view`;

    const criticContent = buildImageMessage(criticText, criticDiagPaths);

    // Update live status: critic running
    if (statusLines) {
      statusLines.push(`## ${stageLabel} — critic reviewing (attempt ${attempt})`);
      updateLiveStatus(store, statusLines);
      statusLines.pop();
    }

    // Run aesthetic critic (uses critic model — can be Gemini Flash for cost savings)
    const aestheticCritic = new LLMAgent('aesthetic_critic', {
      systemPrompt: buildAestheticCriticPrompt(brief),
      tools: buildToolSet('aesthetic_critic'),
      model: criticModel || model,
      budget: { maxTurns: 5, maxWallClockMs: 5 * 60_000 },
      store,
      brief,
      ctx,
    });

    const aestheticResult = await aestheticCritic.run(criticContent);

    // Save critic transcript
    fs.writeFileSync(
      path.join(transcriptDir, `${doerName}_aesthetic_critic_${attempt}.json`),
      JSON.stringify(aestheticResult.transcript, null, 2)
    );

    // Extract verdict
    const criticFinish = aestheticResult.finishResult;
    const verdict = criticFinish?.verdict || 'accept';
    const feedback = criticFinish?.feedback || '';

    console.log(`  Aesthetic critic verdict: ${verdict}`);
    if (feedback) console.log(`  Feedback: ${feedback.slice(0, 200)}`);

    // Also compute stats-based scores
    const autoScores = statsToScores(criticStats, criticUni, brief);
    const autoAgg = computeAggregate(autoScores, brief.target.classification);

    // Save scorecard
    const scorecard = {
      critic: 'aesthetic_critic',
      candidateId: `${doerName}_attempt_${attempt}`,
      timestamp: new Date().toISOString(),
      pass: verdict === 'accept',
      criticScores: criticFinish || {},
      autoScores,
      autoAggregate: autoAgg.aggregate,
      feedback,
    };
    store.saveScorecard(doerName, `aesthetic_critic_${attempt}`, scorecard);

    if (verdict === 'accept' || attempt > maxRejections) {
      if (attempt > maxRejections && verdict !== 'accept') {
        console.log(`  Max rejections reached. Accepting current result despite critic rejection.`);
      }
      // Update live status: stage complete
      const elapsed = doerResult?.elapsedMs || 0;
      const turns = doerResult?.turnCount || 0;
      const scoreStr = autoAgg.aggregate != null ? `, score ${autoAgg.aggregate.toFixed(1)}` : '';
      if (statusLines) {
        const icon = verdict === 'accept' ? '✅' : '⚠️';
        statusLines.push(`## ${stageLabel} ${icon} (${turns} turns, ${fmtTime(elapsed)}${scoreStr}, ${attempt} attempt${attempt > 1 ? 's' : ''})`);
        updateLiveStatus(store, statusLines);
      }
      return {
        winnerId: doerFinish?.view_id || targetViewId,
        winnerScore: autoAgg.aggregate,
        doerResult,
        criticResults: [aestheticResult],
        scorecard,
        attempts: attempt,
      };
    }

    // Critic rejected — feed feedback back
    criticFeedback = feedback || 'The critic rejected your result. Please try a different approach.';
    console.log(`  Rejected — feeding feedback to doer for retry...`);

    // Update live status: rejection with feedback
    if (statusLines) {
      const shortFeedback = feedback ? feedback.slice(0, 300) : 'no details';
      statusLines.push(`### ${stageLabel} — critic rejected attempt ${attempt}: "${shortFeedback}"`);
      updateLiveStatus(store, statusLines);
    }
  }
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

  const store = new ArtifactStore(opts.runId);
  store.saveBrief(brief);
  console.log(`  Run ID: ${store.runId}`);
  console.log(`  Artifacts: ${store.baseDir}`);

  if (opts.dryRun) {
    console.log('\n--- DRY RUN: Classification complete ---');
    console.log(JSON.stringify(brief, null, 2));
    return;
  }

  // --- Live status header ---
  const targetDisplayName = config.files?.targetName || config.name;
  const statusLines = [
    `# ${targetDisplayName} — Live Status`,
    `> Run: ${store.runId}  `,
    `> Started: ${new Date().toISOString()}  `,
    `> Model: ${opts.model || 'claude-sonnet-4-20250514'}`,
    '',
  ];
  updateLiveStatus(store, statusLines);

  // --- Stage 1: Readiness Agent ---
  // The readiness agent opens masters, inspects them, aligns if needed, and combines RGB.
  // It decides what to do based on what it sees — no hardcoded workflow.
  console.log('\n--- Stage 1: Readiness Agent ---');
  const F = config.files;
  const targetName = F.targetName || 'Target';

  statusLines.push('## Stage 1: Readiness — running');
  updateLiveStatus(store, statusLines);
  statusLines.pop();

  const readinessAgent = new LLMAgent('readiness', {
    systemPrompt: buildReadinessPrompt(brief, config),
    tools: buildToolSet('readiness'),
    model: opts.model,
    budget: { maxTurns: 15, maxWallClockMs: 15 * 60_000 },
    store,
    brief,
    ctx,
  });

  const readinessResult = await readinessAgent.run([{
    type: 'text',
    text: `Prepare the input masters for processing. The target view name should be \`${targetName}\`. Open the files, inspect them, handle any issues, and produce a combined RGB color image.`
  }]);

  // Save transcript
  const transcriptDir0 = path.join(store.baseDir, 'transcripts');
  fs.mkdirSync(transcriptDir0, { recursive: true });
  fs.writeFileSync(
    path.join(transcriptDir0, 'readiness.json'),
    JSON.stringify(readinessResult.transcript, null, 2)
  );

  // Verify we have a combined color image
  const allImgs = await ctx.listImages();
  const colorImg = allImgs.find(i => i.isColor);
  if (!colorImg) {
    console.error('  Readiness failed — no color image produced');
    console.error('  Available:', allImgs.map(i => `${i.id}(color=${i.isColor})`).join(', '));
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

  // --- Stage 2: RGB Cleanliness Agent ---
  console.log('\n--- Stage 2: RGB Cleanliness Agent ---');
  const rgbResult = await runDoerWithCritics(ctx, store, brief, {
    doerName: 'rgb_cleanliness',
    doerPromptBuilder: buildRGBCleanlinessPrompt,
    targetViewId: targetName,
    model: opts.model,
    criticModel: opts.criticModel,
    maxTurns: opts.maxTurns || 25, // RGB needs more turns: memory + GC + BXT + WCS + SPCC + NXT + stretch + NXT + saturation
    skipCritics: opts.skipCritics,
    config,
    stageIndex: 2,
    statusLines,
  });
  console.log(`  Winner: ${rgbResult.winnerId} (score=${rgbResult.winnerScore?.toFixed(1) || 'N/A'}, attempts=${rgbResult.attempts})`);

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

  // --- Stage 3: Star Policy Agent ---
  // Decides whether to separate stars (SXT) or keep them. Binary decision.
  console.log('\n--- Stage 3: Star Policy Agent ---');
  const starResult = await runDoerWithCritics(ctx, store, brief, {
    doerName: 'star_policy',
    doerPromptBuilder: buildStarPolicyPrompt,
    targetViewId: rgbResult.winnerId || targetName,
    model: opts.model,
    criticModel: opts.criticModel,
    maxTurns: opts.maxTurns || 10, // Stars is a quick decision
    skipCritics: opts.skipCritics,
    stageIndex: 3,
    statusLines,
  });
  console.log(`  Winner: ${starResult.winnerId} (attempts=${starResult.attempts})`);
  // Check if stars were separated (look for a stars view)
  const postStarImgs = await ctx.listImages();
  const starsView = postStarImgs.find(i => i.id.includes('stars') || i.id.includes('star'));
  const starsViewId = starsView?.id || null;
  if (starsViewId) console.log(`  Stars image: ${starsViewId}`);

  // --- Stage 4: Ha Integration Agent (if Ha data available) ---
  const hasHa = !!(F.Ha?.trim());
  let haResult = null;
  if (hasHa) {
    console.log('\n--- Stage 4: Ha Integration Agent ---');
    haResult = await runDoerWithCritics(ctx, store, brief, {
      doerName: 'ha_integration',
      doerPromptBuilder: (b) => buildHaIntegrationPrompt(b, config),
      targetViewId: starResult.winnerId || targetName,
      model: opts.model,
      criticModel: opts.criticModel,
      maxTurns: opts.maxTurns || 15,
      skipCritics: opts.skipCritics,
      config,
      stageIndex: 4,
      statusLines,
    });
    console.log(`  Winner: ${haResult?.winnerId} (attempts=${haResult?.attempts})`);
  } else {
    console.log('\n--- Stage 4: Ha Integration — skipped (no Ha data) ---');
    statusLines.push('## Stage 4: Ha Integration — skipped (no Ha data)');
    updateLiveStatus(store, statusLines);
  }

  const postHaViewId = haResult?.winnerId || starResult.winnerId || targetName;

  // --- Stage 5: Luminance Detail Agent ---
  console.log('\n--- Stage 5: Luminance Detail Agent ---');
  const lumResult = await runDoerWithCritics(ctx, store, brief, {
    doerName: 'luminance_detail',
    doerPromptBuilder: buildLuminanceDetailPrompt,
    targetViewId: postHaViewId,
    model: opts.model,
    criticModel: opts.criticModel,
    maxTurns: opts.maxTurns,
    skipCritics: opts.skipCritics,
    stageIndex: 5,
    statusLines,
  });
  console.log(`  Winner: ${lumResult.winnerId} (score=${lumResult.winnerScore?.toFixed(1) || 'N/A'}, attempts=${lumResult.attempts})`);

  // --- Stage 6: Composition Agent ---
  console.log('\n--- Stage 6: Composition Agent ---');
  const compResult = await runDoerWithCritics(ctx, store, brief, {
    doerName: 'composition',
    doerPromptBuilder: buildCompositionPrompt,
    targetViewId: lumResult.winnerId || targetName,
    model: opts.model,
    criticModel: opts.criticModel,
    maxTurns: opts.maxTurns,
    skipCritics: opts.skipCritics,
    starsViewId,
    stageIndex: 6,
    statusLines,
  });
  console.log(`  Winner: ${compResult.winnerId} (score=${compResult.winnerScore?.toFixed(1) || 'N/A'}, attempts=${compResult.attempts})`);

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

    const techResult = await techCritic.run(buildImageMessage(techText, techDiagPaths));
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
