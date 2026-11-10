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
import { getStats, measureUniformity, measureLumTilt, subtractSkyPlane } from '../ops/stats.mjs';
import { ArtifactStore, getBestVariant } from '../artifact-store.mjs';
import { generateBrief } from '../classifier.mjs';
import { MaxAgent } from './engine-max.mjs';
import { buildToolSet, formatCriticalSummary } from './tools.mjs';
import { resolveAgentModels, parseModelFlags, fallbackFired, formatModelTable } from './agent-models.mjs';
import { generateDiagnosticViews } from './vision.mjs';
import { buildGigaOrchestratorPrompt } from './prompts/giga-orchestrator.mjs';
import { buildGradientAgentPrompt } from './prompts/gradient-agent.mjs';
import { buildCoreSpecialistPrompt } from './prompts/core-specialist.mjs';
import { composeCore, judgeAB, selectCoreCandidate, measureCoreCandidates } from './composer.mjs';
import { runDeterministicPrep } from './deterministic-prep.mjs';
import { recordOutcomes, extractLedgerGuidance, getChampions, repointChampions, ledgerKey } from '../ledger.mjs';
import { cleanOldRuns, collectProtectedRuns, cleanOrphanSwap, capPrepCache, capGradientCache } from './disk-hygiene.mjs';
import { writeRunArtifacts, mergeRunSummary, makeAgentRunRecord, formatAgentTable } from './run-artifacts.mjs';
import { getCritiqueUsage } from './aesthetic-critic.mjs';
import { buildResumePrompt, loadResumeInfo } from './resume-agent.mjs';
import { loadBaseRunAsPrep, gradientHash, hasGradientSolution, saveGradientSolution, replayGradientSolution } from './warmstart.mjs';

const home = os.homedir();

const writeRunSummary = mergeRunSummary;
let _currentStore = null;  // WI-25: for the FATAL handler

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

  if (minFree < 10) {
    console.error(`  FATAL: Less than 10 GB free (${minFree} GB) after orphan-swap cleanup — aborting to prevent data loss`);
    process.exit(1);
  } else if (minFree < 20) {
    console.log(`  WARNING: Low disk space (${minFree} GB < 20 GB). Free space soon (PI swap low-water mark is 14 GB).`);
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
  else if (args[i] === '--base-run') opts.baseRun = args[++i];   // B1 warm-start
  else if (args[i] === '--keep-runs') opts.keepRuns = parseInt(args[++i], 10);   // WI-24
  else if (args[i] === '--core-specialist') opts.coreSpecialist = true;   // C-tier phase 1
  else if (args[i] === '--post-pass-only' && args[i + 1]) { opts.postPassOnly = args[++i]; opts.coreSpecialist = true; }   // WI-27: run ONLY the core-specialist post-pass on an existing run
  else if (args[i] === '--dry-run') opts.dryRun = true;
  else if (args[i] === '--prep-only') opts.prepOnly = true;   // run prep (align/gradient/solve/SPCC/stretch), report, exit before the agents
  else if (args[i] === '--resume-agent' && args[i + 1]) opts.resumeAgent = args[++i];   // WI-07b
  else if (args[i] === '--approve') {   // WI-01: copy the final XISF to ~/.pixinsight-mcp/approved/<class>/ + register it
    opts.approve = true;
    if (args[i + 1] && !args[i + 1].startsWith('--')) opts.approveRunId = args[++i];
  }
}

if (!opts.configPath) {
  console.error('Usage: node agents/llm/giga-run.mjs --config /path/to/config.json [--intent "..."] [--base-run <runId>] [--resume-agent <runId>]');
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

  // Pre-flight: disk space check only — swap cleanup DISABLED (crashes PI)
  // WI-24: orphan swap (created before the live PI process started) is removed first, then disk is checked
  if (!opts.dryRun) {
    try { cleanOrphanSwap({ log: console.log }); } catch (e) { console.log(`  orphan swap cleanup skipped: ${e.message}`); }
  }
  checkDiskSpace();

  // Classification
  console.log('\n--- Classification ---');
  // WI-07b: --resume-agent reuses the saved brief of the crashed run
  const savedBrief = opts.resumeAgent ? new ArtifactStore(opts.resumeAgent).loadBrief() : null;
  if (opts.resumeAgent && !savedBrief) { console.error(`Cannot resume: no brief.json in run ${opts.resumeAgent}`); process.exit(1); }
  const brief = savedBrief || generateBrief(config, { intent: opts.intent });
  // WI-08: explicit per-agent model table (CLI > config.models > defaults)
  const AGENT_MODELS = resolveAgentModels(parseModelFlags(args), config);
  brief.models = { ...(brief.models || {}), critic: AGENT_MODELS.aesthetic_critic.model };
  console.log('\n--- Agent models ---');
  console.log(formatModelTable(AGENT_MODELS));
  console.log(`  Target: ${brief.target.name} (${brief.target.classification})`);
  console.log(`  Workflow: ${brief.dataDescription.workflow}`);
  console.log(`  Style: ${brief.aestheticIntent.style}`);

  if (opts.dryRun) {
    console.log('\n--- DRY RUN ---');
    console.log(JSON.stringify(brief, null, 2));
    try {
      const sp = buildGigaOrchestratorPrompt(brief, config);
      const tmpl = ['overview', 'center_crop', 'corner_crop', 'bg_stretch'].map((n, i) => `${i + 1}. <run dir>/diagnostics/prep/${n}.jpg`);
      console.log(`\n--- System prompt: ${sp.length} chars ---`);
      console.log(`--- Initial message ends with the diagnostics path list (appended by the agent engine; paths filled in at run time) ---\n### Preview images saved to disk\nUse the Read tool to view any of these images:\n${tmpl.join('\n')}${config.files?.L ? '\n(+ L diagnostics under <run dir>/diagnostics/prep_l/)' : ''}`);
    } catch (e) { console.log(`  system prompt render failed: ${e.message}`); }
    return;
  }

  // Bridge
  const ctx = createBridgeContext({ log: console.log });
  try {
    const imgs = await ctx.listImages();
    console.log(`\nPixInsight connected (${imgs.length} images open)`);
  } catch (err) {
    console.error(`Cannot reach PixInsight: ${err.message}`);
    process.exit(1);
  }


  // WI-27: --post-pass-only <runId>: run ONLY the core-specialist post-pass on an existing run (no prep, no cleanup, no export)
  if (opts.postPassOnly) {
    const store = new ArtifactStore(opts.postPassOnly);
    _currentStore = store;
    const ppBrief = store.loadBrief() || brief;
    ppBrief.runLabel = store.runId.split('_').pop().slice(0, 8);
    const fsel = store.readFinalSelection();
    if (!fsel || !fs.existsSync(fsel.variant_path)) { console.error(`No usable final-selection.json in ${store.runId}`); process.exit(1); }
    const agentRuns = [];
    const recordAgentPP = (name, res) => {
      try {
        agentRuns.push(makeAgentRunRecord(name, AGENT_MODELS[name]?.model, res));
        const cfg = AGENT_MODELS[name];
        store.recordAgentRun(name, { agent: name, requestedModel: cfg.model, effort: cfg.effort, fallbackModel: cfg.fallbackModel,
          actualModels: res?.actualModels || [], num_turns: res?.num_turns ?? res?.turnCount, duration_ms: res?.duration_ms ?? res?.elapsedMs, usage: res?.usage });
      } catch (e) { console.log(`  recordAgentRun skipped: ${e.message}`); }
    };
    const t0 = Date.now();
    const ppDir = path.join(store.baseDir, 'core_post_pass');   // never write next to the masters
    fs.mkdirSync(ppDir, { recursive: true });
    const pp = await runCorePostPass({ ctx, store, brief: ppBrief, AGENT_MODELS, recordAgent: recordAgentPP, finalSelection: fsel,
      outputDir: ppDir, targetName: config.files?.targetName || 'Target', exportSource: null });
    console.log(`\n--- post-pass-only done in ${Math.round((Date.now() - t0) / 1000)}s | final variant: ${pp.finalSelection.variant_id} | ${pp.exportSource || 'mega-winner kept'} ---`);
    return;
  }

  // Artifact store
  const store = new ArtifactStore(opts.resumeAgent || undefined);

  // WI-24: old-run cleanup (protects current run, base run, ledger champions, approved registry) + cache caps
  try {
    const protect = collectProtectedRuns({
      runId: store.runId, baseRun: opts.baseRun,
      ledgerPath: path.join(home, '.pixinsight-mcp', 'ledger.json'),
      approvedPath: path.join(__dirname, '..', 'calibration', 'approved-images.json'),
    });
    const keepRuns = Number.isFinite(opts.keepRuns) ? opts.keepRuns : 3;
    const del = cleanOldRuns({ runsDir: store.runsDir, keep: keepRuns, protect, log: console.log });
    if (del.length) console.log(`  runs: removed ${del.length} old run(s), ${(del.reduce((a, d) => a + d.bytes, 0) / 1024 ** 3).toFixed(2)} GB freed`);
    capPrepCache(path.join(home, '.pixinsight-mcp', 'prep-cache'), 4, console.log);
    capGradientCache(path.join(home, '.pixinsight-mcp', 'gradient-cache'), 4, console.log);
  } catch (e) { console.log(`  disk hygiene skipped: ${e.message}`); }

  // Add run label for internal version naming (last 8 chars of run ID)
  brief.runLabel = store.runId.split('_').pop().slice(0, 8);

  store.saveBrief(brief);
  // WI-08: run_meta first line of trace.jsonl + per-agent run recording
  try {
    const tp = path.join(store.baseDir, 'trace.jsonl');
    const toolStats = () => {
      const out = [];
      for (const agent of ['giga_orchestrator', 'gradient_agent', 'core_specialist']) {
        const ts = buildToolSet(agent);
        out.push({ agent, toolCount: ts.definitions.length, schemaChars: JSON.stringify(ts.definitions).length });
      }
      return out;
    };
    if (!fs.existsSync(tp)) fs.writeFileSync(tp, JSON.stringify({ type: 'run_meta', ts: Date.now(), runId: store.runId, models: AGENT_MODELS, tools: toolStats() }) + '\n');
  } catch (e) { console.log(`  run_meta write skipped: ${e.message}`); }
  const agentRuns = [];
  _currentStore = store;
  const recordAgent = (name, res) => {
    try {
      agentRuns.push(makeAgentRunRecord(name, AGENT_MODELS[name]?.model, res));
      const cfg = AGENT_MODELS[name];
      const info = {
        agent: name, requestedModel: cfg.model, effort: cfg.effort, fallbackModel: cfg.fallbackModel,
        actualModels: res?.actualModels || [], num_turns: res?.num_turns ?? res?.turnCount, duration_ms: res?.duration_ms ?? res?.elapsedMs, usage: res?.usage,
      };
      store.recordAgentRun(name, info);
      if (fallbackFired(cfg.model, info.actualModels)) {
        console.log(`  WARNING: ${name} requested "${cfg.model}" but actual models were [${info.actualModels.join(', ')}] — fallback may have fired`);
      }
    } catch (e) { console.log(`  recordAgentRun skipped: ${e.message}`); }
  };
  console.log(`  Run ID: ${store.runId}`);
  console.log(`  Run label: ${brief.runLabel}`);
  console.log(`  Artifacts: ${store.baseDir}`);

  let result, elapsed;
  if (opts.resumeAgent) {
    // ------------------------------------------------------------------
    // WI-07b: --resume-agent. PixInsight was restarted (all views are gone). Skip prep/gradient and
    // resume the SAME Claude session (identical cwd, same system prompt, same MCP state snapshot).
    // ------------------------------------------------------------------
    console.log(`\n--- RESUME-AGENT: run ${store.runId} ---`);
    if (!(await ctx.ping())) {
      console.error('PixInsight/watcher not responding (ping failed). Restart PixInsight + the watcher first, then re-run this command.');
      process.exit(1);
    }
    const info = loadResumeInfo(store, brief, config, buildGigaOrchestratorPrompt);
    console.log(`  session=${info.sessionId} state=${info.state} cwd=${info.cwd} systemPrompt=${info.promptSource}`);
    // The old MCP server is dead; remove the sentinel BEFORE spawning or engine-max would kill the new session.
    try { fs.unlinkSync(path.join(store.baseDir, 'CRASH.json')); } catch {}
    try { store.manifest.status = 'running'; delete store.manifest.failReason; store._saveManifest(); } catch {}
    const agent = new MaxAgent('giga_orchestrator', {
      systemPrompt: info.systemPrompt,
      agentName: 'giga_orchestrator',
      maxTurns: AGENT_MODELS.giga_orchestrator.maxTurns,
      model: AGENT_MODELS.giga_orchestrator.model,
      effort: AGENT_MODELS.giga_orchestrator.effort,
      fallbackModel: AGENT_MODELS.giga_orchestrator.fallbackModel,
      store,
      brief,
      extraArgs: ['--resume', info.sessionId],
      cwd: info.cwd,
      env: { PIX_RESUME: '1' },
    });
    const startTime = Date.now();
    result = await agent.run(buildResumePrompt(info.state));
    elapsed = Date.now() - startTime;
    recordAgent('giga_orchestrator', result);
  } else {
  // ================================================================
  // PHASE 1: DETERMINISTIC PREP (no LLM, pure code)
  // ================================================================
  // B1 warm-start: --base-run skips prep+gradient and loads a prior winner.
  let prepResult;
  let baseSelection = null;
  if (opts.baseRun) {
    console.log(`\n--- Phase 1 SKIPPED — warm-starting from base run ${opts.baseRun} ---`);
    const loaded = await loadBaseRunAsPrep(ctx, opts.baseRun, config.files?.targetName || 'Target', { config });
    prepResult = loaded.prepResult;
    baseSelection = loaded.selection;
    console.log(`  Loaded base winner: ${baseSelection.variant_id} (${baseSelection.variant_path})`);
    console.log(`  Active view: rgb  median=${prepResult.stats.rgb?.median?.toFixed(6)}`);
  } else {
  console.log('\n--- Phase 1: Deterministic Prep (no LLM) ---');
  prepResult = await runDeterministicPrep(ctx, config, {
    outputDir: path.join(store.baseDir, 'prep'),
    runDir: store.baseDir,
    log: console.log,
    brief: brief,
    // ----------------------------------------------------------------
    // Phase 1.5: AGENTIC GRADIENT CORRECTION (Claude Max sub-agent), with a
    // snapshot-replay cache keyed by a prep-input hash (B1): identical-input
    // reruns replay the prior post-gradient snapshot instead of re-spawning.
    // ----------------------------------------------------------------
    onAfterCombine: async ({ targetName, hasL }) => {
      let gHash = null;
      try {
        const rgbStats0 = await getStats(ctx, targetName);
        gHash = gradientHash(config.files, rgbStats0);
        if (hasGradientSolution(gHash, hasL)) {
          console.log(`\n--- Phase 1.5: Gradient solution CACHE HIT (${gHash.slice(0, 12)}) — replaying snapshot ---`);
          await replayGradientSolution(ctx, gHash, targetName, hasL);
          console.log('--- Gradient snapshot replayed — skipping sub-agent ---');
          try { console.log('  Windows after gradient phase: ' + (await ctx.listImages()).map(i => i.id).join(', ')); } catch { /* */ }
          return;
        }
      } catch (e) {
        console.log(`  Gradient cache lookup skipped: ${e.message}`);
      }

      console.log('\n--- Phase 1.5: Gradient Agent via Claude Max ---');
      const gradInitial = `## LINEAR DATA READY — your turn (gradient correction).

Working linear assets in PixInsight (DO NOT stretch them):
- **RGB (combined, linear)**: \`${targetName}\`${hasL ? `\n- **L (linear, mono)**: \`FILTER_L\`` : ''}

Flatten the background color gradient on ${hasL ? 'both views (RGB first, then L)' : 'the RGB view'}, following your instructions.
Start with \`recall_memory\`, then \`measure_color_gradient\` with linear=true on \`${targetName}\` to get the baseline.
Iterate correction scale until FLAT (score < 0.008) or until further scale costs faint signal.
The corrected views MUST stay under these exact IDs. Do NOT stretch, denoise, run SXT/SPCC, export, or finish.`;
      const gradAgent = new MaxAgent('gradient_agent', {
        systemPrompt: buildGradientAgentPrompt(brief),
        agentName: 'gradient_agent',
        maxTurns: AGENT_MODELS.gradient_agent.maxTurns,
        model: AGENT_MODELS.gradient_agent.model,
        effort: AGENT_MODELS.gradient_agent.effort,
        fallbackModel: AGENT_MODELS.gradient_agent.fallbackModel,
        store,
        brief,
      });
      const gradResult = await gradAgent.run(gradInitial);
      recordAgent('gradient_agent', gradResult);
      try {
        const tr = gradResult?.transcript;
        const gtext = Array.isArray(tr)
          ? tr.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n\n')
          : String(tr || '');
        fs.writeFileSync(path.join(store.baseDir, 'gradient-result.md'), `# Gradient agent result\n\n${gtext}\n`);
        const gm = gtext.match(/GRADIENT RESULT:[^\n]*/);
        fs.appendFileSync(path.join(store.baseDir, 'trace.jsonl'), JSON.stringify({ type: 'run_meta', ts: Date.now(), event: 'gradient_result', result: gm ? gm[0] : null, text: gtext.slice(0, 4000) }) + '\n');
      } catch (e) { console.log(`  gradient-result persist skipped: ${e.message}`); }
      console.log('--- Gradient Agent done — handing flattened linear views to prep phase 2 ---');
      // Safety net (M74 v4-v6): a linear luminance tilt the agent left in is amplified ~15x by the
      // stretch, and the main agent then "fixes" it on stretched data, cutting the envelope on one
      // side. A sky-plane fit (3 parameters, subject cells rejected) cannot remove the subject.
      // Respect a deliberate agent decision: if its GRADIENT RESULT says it left a view untouched with a reason
      // (M101 friend crop: zero corners made the reading false), the net must not override it.
      let gradText = '';
      try { gradText = fs.readFileSync(path.join(store.baseDir, 'gradient-result.md'), 'utf8'); } catch { /* */ }
      const agentDeclined = /tool=none/i.test(gradText);
      for (const vid of [targetName, ...(hasL ? ['FILTER_L'] : [])]) {
        try {
          const t = await measureLumTilt(ctx, vid);
          if (t.error) { console.log(`  Lum tilt ${vid}: ${t.error}`); continue; }
          console.log(`  Lum tilt ${vid}: ${t.verdict} ppStretched=${t.ppStretched.toFixed(4)} (${(100 * (t.relToSky ?? 0)).toFixed(2)}% of sky, ${t.direction})`);
          // ADVISORY ONLY (2026-11-08): an automatic plane subtraction overrode the gradient agent twice — M101 (zero
          // drizzle corners made the reading false) and M81 (the agent had tried the plane and rejected it with
          // evidence: it followed IFN/halo structure). The agent owns the decision; the pipeline only reports.
          if (t.ppStretched > 0.015) {
            console.log(`  Lum tilt ${vid}: residual VISIBLE tilt left by the gradient agent${agentDeclined ? ' (it declined deliberately)' : ''} — advisory, not corrected; see gradient-result.md`);
            fs.appendFileSync(path.join(store.baseDir, 'trace.jsonl'), JSON.stringify({ type: 'run_meta', ts: Date.now(), event: 'lum_tilt_residual', view: vid, ppStretched: t.ppStretched, agentDeclined }) + '\n');
          }
        } catch (e) { console.log(`  Lum tilt check ${vid} skipped: ${e.message}`); }
      }

      const gradFailed = !gradResult || gradResult.exitCode && gradResult.exitCode !== 0 || (gradResult.num_turns ?? gradResult.turns ?? 1) === 0;
      if (gradFailed) {
        // Do NOT cache an uncorrected snapshot as a "gradient solution" (M101 47c5c3f6, 2026-10-30:
        // the agent died in 5 s after a Claude model switch and the raw views were cached).
        console.log(`  WARNING: gradient agent failed (exit ${gradResult?.exitCode}, ${gradResult?.num_turns ?? 0} turns) — views NOT gradient-corrected; snapshot NOT cached.`);
      }
      if (gHash && !gradFailed) {
        try { console.log('  Windows after gradient phase: ' + (await ctx.listImages()).map(i => i.id).join(', ')); } catch { /* */ }
        try { await saveGradientSolution(ctx, gHash, targetName, hasL); console.log(`  Gradient solution cached: ${gHash.slice(0, 12)}`); }
        catch (e) { console.log(`  Gradient cache save skipped: ${e.message}`); }
      }
    },
  });
  }

  // Generate diagnostic views for the agent to start with
  const diagDir = path.join(store.baseDir, 'diagnostics', 'prep');
  // Detail baseline (prep-metrics.json) for the finish detail-gain advisory.
  if (prepResult.baselineDetail) {
    brief._baselineDetail = prepResult.baselineDetail;
    brief._hasL = !!prepResult.views.l;
    if (opts.baseRun) {
      try { fs.writeFileSync(path.join(store.baseDir, 'prep-metrics.json'), JSON.stringify({ baselineDetail: prepResult.baselineDetail, inventory: prepResult.inventory, baseRun: opts.baseRun }, null, 2)); } catch { /* */ }
    }
  }
  if (prepResult.inventory) brief._inventory = prepResult.inventory;
  const inventoryText = (() => {
    const v = prepResult.inventory; if (!v) return '';
    const z = v.zones;
    return `\n### Signal inventory (prep, deepest starless channel \`${v.view}\`, hard-stretched preview attached)\n- ${v.text}\n- Zones (px from the subject centre): core ${z.core[0]}-${z.core[1]}, disc ${z.disc[0]}-${z.disc[1]}, outer ${z.outer[0]}-${z.outer[1]}, sky ${z.sky[0]}-${z.sky[1]}.\n- The finish gates measure these same zones: what the data holds in the OUTER zone must read above the sky, and the core/disc contrast must not collapse relative to prep (lift the outer zone through a mask; never lift the whole disc).\n`;
  })();
  if (prepResult.narrowband) brief._nbPrep = { linearStarless: prepResult.narrowband.linearStarless || {}, prepParams: prepResult.narrowband.prepParams || {}, prepDir: prepResult.narrowbandPrepDir || path.join(store.baseDir, 'prep') };
  const baselineDetailText = (() => {
    const b = prepResult.baselineDetail;
    if (!b) return '';
    const fx = (v) => (typeof v === 'number' ? v.toExponential(3) : 'n/a');
    const maxGain = brief?.processingProfile?.detail?.max_gain;
    return `\n### Detail baseline (prep, before your processing):\n- RGB: detailCredible=${fx(b.rgb?.credible)} detailWeber=${fx(b.rgb?.weber)}${b.l ? `\n- L: detailCredible=${fx(b.l.credible)} detailWeber=${fx(b.l.weber)}` : ''}\n- Reference for gain = ${b.l ? 'max(RGB, L)' : 'RGB'}; detailCredible should rise modestly (profile detail.max_gain${maxGain != null ? ` = x${maxGain}, ADVISORY` : ' not set'}); detailRaw/detailCredible must stay < 2.5.\n`;
  })();
  const diagPaths = await generateDiagnosticViews(ctx, prepResult.views.rgb, diagDir);
  let lDiagPaths = [];
  if (prepResult.views.l) {
    const lDiagDir = path.join(store.baseDir, 'diagnostics', 'prep_l');
    lDiagPaths = await generateDiagnosticViews(ctx, prepResult.views.l, lDiagDir);
  }

  // ================================================================
  // PHASE 2+: Creative agent (LLM via Claude Max)
  // ================================================================
  if (opts.prepOnly) {
    console.log('\n--- PREP-ONLY: stopping before the creative agent ---');
    try { console.log('  Views: ' + (await ctx.listImages()).map(i => `${i.id} ${i.width}x${i.height}`).join(', ')); } catch { /* */ }
    process.exit(0);
  }
  console.log('\n--- Phase 2+: Creative Agent via Claude Max ---');

  // Build system prompt
  const systemPrompt = buildGigaOrchestratorPrompt(brief, config);

  // Build initial message with prep results + diagnostic views
  const viewsList = Object.entries(prepResult.views)
    .map(([k, v]) => {
      const med = prepResult.stats[k]?.median;
      const medStr = typeof med !== 'number' ? 'N/A' : (Math.abs(med) < 1e-3 ? med.toExponential(2) : med.toFixed(4));
      return `- **${k}**: \`${v}\` (median=${medStr})`;
    })
    .join('\n');

  // WI-09: L uniformity (route 5 of the L incorporation decision) and the applied prep recipe from the profile.
  let lUniformityLine = '';
  if (prepResult.views.l) {
    try { lUniformityLine = `- Background uniformity (L): ${(await measureUniformity(ctx, prepResult.views.l)).score.toFixed(6)} (> 0.02 means inject_luminance at a low weight, never RGB-only)\n`; } catch (e) { /* non-fatal */ }
  }
  const appliedBlock = (() => {
    const ap = Array.isArray(prepResult.applied) ? prepResult.applied : [];
    if (!ap.length) return '';
    const lines = ap.map(a => `- ${a.step} on \`${a.view}\`: ${JSON.stringify(a.params)}`);
    return `\n### Prep recipe already applied (do not repeat)\n${lines.join('\n')}\n`;
  })();
  const prepRecipe = (() => {
    const p = brief.processingProfile || {};
    const nxt = p.tools?.NXT;
    return `### Prep recipe applied (from the processing profile)\n- Stretch: target_median=${p.stretch?.target_median ?? 'n/a'}, headroom=${p.stretch?.headroom ?? 'n/a'}; linear NXT ${nxt?.denoise_linear ?? 'n/a'}, post-stretch NXT ${nxt?.denoise_post_stretch ?? 'n/a'}; SXT applied on linear data (stars delivered LINEAR).\n${appliedBlock}`;
  })();
  const dustNote = brief.processingProfile?.ifn
    ? '\n### Dust gate\nFinish Gate 3e will reject greyed/crushed dust — Branch B must run inject_l_ifn + lift_dust and verify with measure_dust_coverage.\n'
    : '';
  const initialText = `## DETERMINISTIC PREP COMPLETE — it has been done for you.

${prepRecipe}
### Working assets ready in PixInsight:
${viewsList}

### Current RGB stats:
- Median: ${prepResult.stats.rgb?.median?.toFixed(6) || 'N/A'}
- Max: ${(prepResult.stats.rgb?.max || 0).toFixed(4)}
- Background uniformity: ${(await measureUniformity(ctx, prepResult.views.rgb)).score.toFixed(6)}

${baselineDetailText}${inventoryText}
${prepResult.views.l ? `### Current L stats:
- Median: ${prepResult.stats.l?.median?.toFixed(6) || 'N/A'}
- Max: ${(prepResult.stats.l?.max || 0).toFixed(4)}
${lUniformityLine}- L is STARLESS, stretched from processing profile targets
` : ''}

${prepResult.narrowband ? `### NARROWBAND ${prepResult.narrowband.workflow} — mono channels (stretched, starless, unlinked):
- SII: \`${prepResult.views.s || 'n/a'}\` | Ha: \`${prepResult.views.ha}\` | OIII: \`${prepResult.views.o}\`
- Initial palette in \`${prepResult.views.rgb}\`: ${prepResult.narrowband.palette} (gains S=${prepResult.narrowband.gains?.s?.toFixed?.(2)} O=${prepResult.narrowband.gains?.o?.toFixed?.(2)})
- Initial palette balance: ${prepResult.narrowband.initialBalance}
- Gradient: ${JSON.stringify(prepResult.narrowband.gradient)}
${prepResult.narrowband.prepParams ? `- Prep applied: NXT linear ${JSON.stringify(prepResult.narrowband.prepParams.nxtLinear)}, NXT post-stretch ${JSON.stringify(prepResult.narrowband.prepParams.nxtPost)}, stretch target ${prepResult.narrowband.prepParams.stretchTarget}, hueShift ${JSON.stringify(prepResult.narrowband.prepParams.hueShift)}, scnr ${JSON.stringify(prepResult.narrowband.prepParams.scnr)}, hGain ${prepResult.narrowband.prepParams.hGain}${prepResult.narrowband.cacheHit ? ' (channels restored from NB cache)' : ''}
- Any NXT you apply is ON TOP of the prep's post-NXT above — lower it, or rebracket the channel from its linear starless snapshot with \`reload_narrowband_channel\` (channel S/H/O, nxt_post, stretch_target) if grain or smoothing looks wrong.
` : ''}${prepResult.narrowband.warmStart ? '- WARM START: FILTER_S/Ha/O re-opened from the base run prep; `rgb` is the base winner.\n' : ''}${brief.dataDescription?.starless ? '' : `- Linear NB star layers on disk (not open): ${Object.values(prepResult.narrowband.starLayers || {}).join(', ')}\n`}${brief.dataDescription?.starless ? '- **STARLESS deliverable** — do not blend stars, do not crop/resample.' : ''}` : (prepResult.views.ha ? `### Ha available: \`${prepResult.views.ha}\` (stretched, starless)` : '')}
${prepResult.views.stars ? `### Stars available: \`${prepResult.views.stars}\` (LINEAR, median=${(prepResult.stats.stars?.median ?? 0).toExponential(2)} — call stretch_stars, then check_star_layer_integrity, BEFORE any curves/rolloff/blend; stretch_stars refuses non-linear input so it is always safe to call first)` : ''}

### Diagnostic views saved on disk (RGB: overview / center_crop / corner_crop / bg_stretch; L in diagnostics/prep_l) — paths are listed at the end of this message. Read the overview and corner crop before branching (corner crop = coma/gradient check).
${dustNote}
### Cross-Run Promotion Ledger (what wins vs what never wins for this target class)
${(() => { try { return extractLedgerGuidance(ledgerKey(brief)); } catch (e) { return 'LEDGER: unavailable.'; } })()}
${(() => {
  try {
    const champs = getChampions(ledgerKey(brief));
    const dims = Object.keys(champs);
    if (!dims.length) return '';
    return `\n### Cross-Run Champions Available\nPrior runs of this target class produced best-of-breed images on: ${dims.map(d => `${d} (score ${(champs[d].score ?? 0).toFixed(3)})`).join(', ')}.\nUse recall_champion(<dimension>) to open one and graft its strong region (via blend_regions / star_protected_blend) for any dimension your current best is weak on.\n`;
  } catch (e) { return ''; }
})()}

${brief.target.classification.includes('emission') ? `
### TARGET-CLASS TOOL POLICY — READ THIS FIRST
**This is an emission nebula. The Branch A detail tool is \`shell_detail_enhance\`.**
\`multi_scale_enhance\` is BLOCKED for this target class — it will refuse with an error.
Reason: LHE amplifies brightness in bright shells, forcing clamping that destroys texture.
\`shell_detail_enhance\` enhances texture without increasing peak brightness.
Use \`create_adaptive_zone_masks\` for zone-based processing.
Use \`check_highlight_texture\` with reference checkpoints to verify texture preservation.
` : ''}
${opts.baseRun ? `## WARM-START — TOUCH-UP MODE.
The view \`rgb\` is a FINISHED, exported composition from a previous run (variant ${baseSelection?.variant_id}). You are NOT processing from scratch.
Previous selection notes: ${baseSelection?.notes ? JSON.stringify(baseSelection.notes) : 'none'}

### Touch-up request
${opts.intent ? opts.intent : 'No explicit instruction — make a conservative, single targeted improvement only.'}

RULES:
- Apply ONLY targeted, minimal touch-ups that serve the request. Do NOT re-stretch, re-combine, or rebuild from linear.
- Preserve existing tonal balance, star treatment, and color unless the request explicitly targets them.
- Measure first (get_stats / measure_* on \`rgb\`), make the smallest change that satisfies the intent, then save_variant and finish.
- Quality gates still apply — do not regress core contrast, noise, saturation, or star quality.
## Begin directly: measure \`rgb\`, then apply the touch-up.`
  : `## Intake and prep are done. Begin with the branch generation mission.
## Call recall_memory first, then start generating bracketed candidate sets.`}`;

  // WI-05: warm start has no branch phase - the MCP-side state machine begins in compose.
  if (opts.baseRun) brief.warmStart = { baseRun: opts.baseRun, intent: opts.intent || null };

  // Create MaxAgent
  console.log('\n--- Launching GIGA Agent via Claude Max ---');
  // Turn budget (2026-10-30): every run, 24 MP or 104 MP, used ~250-295 turns and reached the
  // emergency budget with the star gate still failing — size does not drive the turn count, the
  // agent spends whatever it has on branches. Uniform +20% for now; the real fix is a reserved
  // finish phase (TODO: state machine) so star repair happens before the emergency relaxation.
  const mainMaxTurns = Math.round(AGENT_MODELS.giga_orchestrator.maxTurns * 1.2);
  console.log(`  Turn budget: maxTurns=${mainMaxTurns} (base ${AGENT_MODELS.giga_orchestrator.maxTurns} x1.2)`);
  const agent = new MaxAgent('giga_orchestrator', {
    systemPrompt,
    agentName: 'giga_orchestrator',
    maxTurns: mainMaxTurns,
    // Wall clock scales with the turn budget (~9 s/turn observed; default 120 min cut a 540-turn run short).
    // 20 s/turn (was 15): per-step core metrics add ~8 s per image-changing step on 26 MP frames (M81 run 5 hit
    // the 135-min wall clock while still working, 2026-11-09).
    timeoutMs: Math.max(120, Math.ceil(mainMaxTurns * 20 / 60)) * 60 * 1000,
    model: AGENT_MODELS.giga_orchestrator.model,
    effort: AGENT_MODELS.giga_orchestrator.effort,
    fallbackModel: AGENT_MODELS.giga_orchestrator.fallbackModel,
    store,
    brief,
  });

  // Run
  const startTime = Date.now();
  const invPaths = (prepResult.inventory?.preview || []).slice(0, 2);   // hard-stretched deepest channel: overview + centre crop
  result = await agent.run(initialText, [...diagPaths, ...lDiagPaths, ...invPaths]);
  elapsed = Date.now() - startTime;
  recordAgent('giga_orchestrator', result);
  // Unattended-run nudge (2026-11-08, M74 v8): the agent ended its turn to ASK the user a question at turn 230/540
  // with no finish; nobody answers in a queued run, so the run fell back to a best-effort export. PixInsight still
  // holds every view: resume the SAME session (same cwd) and tell it to decide and continue to finish.
  // A timed-out agent (exit 143) reports no num_turns; count its tool calls in the session transcript instead,
  // so a resume gets only the REMAINING budget (M81 run 6 was given a fresh 540 after 304 turns, 2026-11-09).
  const sessionTurns = (sid) => {
    try {
      const slug = agent.cwd.replace(/[\/.]/g, '-');
      const f = path.join(os.homedir(), '.claude', 'projects', slug, `${sid}.jsonl`);
      let n = 0; for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (l.includes('"type":"assistant"')) n += (l.match(/"type":"tool_use"/g) || []).length; }
      return n;
    } catch { return 0; }
  };
  let usedTurns = result.turnCount || (result.sessionId ? sessionTurns(result.sessionId) : 0);
  for (let nudge = 1; nudge <= 2; nudge++) {
    if (result.crashError || result.timedOut || result.maxTurnsHit || store.readFinalSelection()) break;
    const left = mainMaxTurns - usedTurns;
    if (left < 40) break;
    const why = (result.exitCode === 143 || result.signal === 'SIGTERM') ? 'wall-clock timeout (exit 143) while working' : 'stopped without finish';
    console.log(`\n--- Agent ${why} (${usedTurns}/${mainMaxTurns} turns): unattended nudge ${nudge}/2, resuming session ${result.sessionId} ---`);
    try { fs.appendFileSync(path.join(store.baseDir, 'trace.jsonl'), JSON.stringify({ type: 'run_meta', ts: Date.now(), event: 'unattended_nudge', nudge, usedTurns }) + '\n'); } catch { /* */ }
    const again = new MaxAgent('giga_orchestrator', {
      systemPrompt, agentName: 'giga_orchestrator', maxTurns: left,
      timeoutMs: Math.max(60, Math.ceil(left * 20 / 60)) * 60 * 1000,
      model: AGENT_MODELS.giga_orchestrator.model, effort: AGENT_MODELS.giga_orchestrator.effort,
      fallbackModel: AGENT_MODELS.giga_orchestrator.fallbackModel, store, brief,
      extraArgs: ['--resume', result.sessionId], cwd: agent.cwd,
    });
    const t1 = Date.now();
    result = await again.run(`UNATTENDED RUN: nobody will answer questions — the user is not watching this session. Take the decision yourself: pick the option you recommended (or the most conservative one that keeps the image honest), note the decision in remaining_flaws, and continue the plan through to finish. ${left} turns remain. Do not end your turn without calling finish.`);
    elapsed += Date.now() - t1; usedTurns = result.turnCount ? usedTurns + result.turnCount : Math.max(usedTurns, sessionTurns(result.sessionId));
    recordAgent('giga_orchestrator', result);
  }
  }

  console.log(`\n--- GIGA Agent completed in ${Math.round(elapsed / 1000)}s ---`);

  // Do NOT clean swap files here — PI still has images open and needs its swap files.
  // Cleaning while PI is running causes crashes. Only clean on startup (before PI connects).

  const agentCut = result.timedOut ? 'AGENT TIMED OUT' : (result.maxTurnsHit ? 'MAX TURNS' : null);
  if (agentCut) {
    console.error(`\n${'!'.repeat(60)}\n!!! giga_orchestrator ${agentCut} - the agent did NOT finish normally.\n!!! Export will use the best available saved variant (see export source).\n${'!'.repeat(60)}\n`);
  }

  if (result.crashError) {
    writeRunSummary(store, { status: 'crashed', exitCode: result.exitCode ?? null, signal: result.signal ?? null, durationMs: elapsed });
    console.error(`CRASH: ${result.crashError.message}`);
    await writeRunArtifacts(store, 'crashed', { agentRuns, elapsedMs: elapsed, exitCode: result.exitCode ?? null, signal: result.signal ?? null, turns: result.turnCount || 0, failReason: result.crashError.message });
    console.error(`\nRestart PixInsight + the watcher (full PI quit if it was the RAM-fragmentation crash), then:\n  node agents/llm/giga-run.mjs --config ${configPath} --resume-agent ${store.runId}`);
    process.exit(77);
  }

  // ================================================================
  // EXPORT: Artifact-based (not view-name-based)
  // Source of truth: final-selection.json written by the finish tool
  // ================================================================
  const targetName = config.files?.targetName || 'Target';
  // An external output volume can disappear during a long run (M74 v12, 2026-11-10: /Volumes/Extension unmounted,
  // EACCES on mkdir killed the run after the agent had finished). Fall back to the run folder; never lose the result.
  let outputDir = config.files?.outputDir || path.join(home, 'Desktop');
  try { fs.mkdirSync(outputDir, { recursive: true }); fs.accessSync(outputDir, fs.constants.W_OK); }
  catch (e) {
    const fallback = path.join(store.baseDir || path.join(home, '.pixinsight-mcp', 'runs', store.runId), 'output');
    console.warn(`  [EXPORT] output folder ${outputDir} unavailable (${e.code || e.message}) — exporting to ${fallback}`);
    outputDir = fallback; fs.mkdirSync(outputDir, { recursive: true });
  }

  const xisfPath = path.join(outputDir, `${targetName}_giga.xisf`);
  const pngPath = path.join(outputDir, `${targetName}_giga.png`);

  // PRIMARY PATH: read final-selection.json (written by finish tool)
  let finalSelection = store.readFinalSelection();
  let exportSource = finalSelection ? 'final-selection.json' : null;

  // RECOVERY: if no final-selection.json, reconstruct from trace
  if (!finalSelection) {
    console.log('  No final-selection.json — attempting trace recovery...');
    try {
      const tracePath = path.join(store.baseDir, 'trace.jsonl');
      if (fs.existsSync(tracePath)) {
        const traceLines = fs.readFileSync(tracePath, 'utf-8').trim().split('\n');
        // Find last successful finish call
        for (let i = traceLines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(traceLines[i]);
            if (entry.tool === 'finish' && !entry.error && entry.resultSummary?.includes('PASSED')) {
              // New contract: finish has variant_id
              if (entry.args?.variant_id) {
                const variantMeta = store.getVariantById('giga_orchestrator', entry.args.variant_id);
                if (variantMeta) {
                  finalSelection = store.writeFinalSelection({
                    variant_id: entry.args.variant_id,
                    variant_path: variantMeta.xisfPath,
                    agent: 'giga_orchestrator',
                    notes: variantMeta.params?.notes || '',
                    finish_seq: entry.seq,
                    recovered: true,
                  });
                  exportSource = 'trace-recovery (variant_id)';
                  break;
                }
              }
              // LEGACY: old finish only had view_id — use last save_variant before this finish
              if (entry.args?.view_id) {
                const variants = store.listVariants('giga_orchestrator');
                if (variants.length > 0) {
                  const lastVariant = variants[variants.length - 1];
                  finalSelection = store.writeFinalSelection({
                    variant_id: lastVariant.variantId,
                    variant_path: lastVariant.xisfPath,
                    agent: 'giga_orchestrator',
                    notes: lastVariant.params?.notes || '',
                    finish_seq: entry.seq,
                    recovered: true,
                    legacy_view_id: entry.args.view_id,
                  });
                  exportSource = 'trace-recovery (legacy view_id → last variant)';
                  break;
                }
              }
            }
          } catch {} // skip malformed lines
        }
      }
    } catch (e) {
      console.log(`  Trace recovery error: ${e.message}`);
    }
  }

  // BEST-EFFORT FALLBACK (WI-07a): no final-selection and no PASSED finish in the trace ->
  // pick the best saved variant so export AND the core-specialist post-pass still run.
  if (!finalSelection) {
    try {
      const best = getBestVariant(store, 'giga_orchestrator');
      if (best) {
        finalSelection = store.writeFinalSelection({
          variant_id: best.variantId,
          variant_path: best.xisfPath,
          agent: 'giga_orchestrator',
          notes: 'RECOVERED best-effort (no passing finish)',
          recovered: true,
          gates_passed: false,
        });
        exportSource = 'best-variant fallback (no passing finish)';
        console.log(`  Best-variant fallback: ${best.variantId} (${best.xisfPath})`);
      }
    } catch (e) { console.log(`  Best-variant fallback error: ${e.message}`); }
  }
  if (agentCut && exportSource) exportSource += ` (${agentCut})`;
  const runStatus = result.timedOut ? 'timed_out' : result.maxTurnsHit ? 'max_turns'
    : (!finalSelection ? 'no_final_selection' : (finalSelection.recovered ? 'recovered' : 'finished'));
  writeRunSummary(store, {
    status: runStatus, exportSource: exportSource || null, exitCode: result.exitCode ?? null,
    signal: result.signal ?? null, durationMs: elapsed, turns: result.turnCount || 0,
    finalVariant: finalSelection?.variant_id || null, gatesPassed: finalSelection ? finalSelection.gates_passed !== false : false,
  });

  // === C-TIER PHASE 1: optional core-specialist post-pass (flagged --core-specialist) ===
  // Improves ONLY the core of the mega-winner via a short scoped specialist, grafts that
  // core back through a feathered mask (deterministic composer), and a strict no-regression
  // A/B exports whichever wins. The mega-agent path above is UNCHANGED; this can only
  // improve or tie. Any error falls back to the mega-winner.
  if (opts.coreSpecialist && finalSelection && fs.existsSync(finalSelection.variant_path)) {
    const pp = await runCorePostPass({ ctx, store, brief, AGENT_MODELS, recordAgent, finalSelection, outputDir, targetName, exportSource });
    finalSelection = pp.finalSelection; exportSource = pp.exportSource;
  }

  // Export from the artifact
  try {
    if (finalSelection && fs.existsSync(finalSelection.variant_path)) {
      console.log(`  Export source: ${exportSource}`);
      console.log(`  Final artifact: ${finalSelection.variant_id} → ${finalSelection.variant_path}`);

      // Open the saved XISF in PI, export as XISF + PNG
      const r = await ctx.pjsr(`
        var w = ImageWindow.open('${finalSelection.variant_path.replace(/'/g, "\\'")}');
        if (w.length === 0) throw new Error('Failed to open variant XISF');
        var win = w[0];
        win.show();

        var xp = '${xisfPath.replace(/'/g, "\\'")}';
        if (File.exists(xp)) File.remove(xp);
        win.saveAs(xp, false, false, false, false);

        var pp = '${pngPath.replace(/'/g, "\\'")}';
        if (File.exists(pp)) File.remove(pp);
        win.saveAs(pp, false, false, false, false);

        'Exported ' + win.mainView.id + ' median=' + win.mainView.image.median().toFixed(4) + ' max=' + win.mainView.image.maximum().toFixed(4);
      `);
      console.log(`  ${r.outputs?.consoleOutput || 'done'}`);
      console.log(`  Saved: ${xisfPath}`);
      console.log(`  Saved: ${pngPath}`);
      if (opts.approve) {
        try { approveExport({ brief, store, xisfPath, variantPath: finalSelection.variant_path, targetName, requestedRunId: opts.approveRunId }); }
        catch (e) { console.error(`  --approve failed (non-fatal): ${e.message}`); }
      }
    } else if (finalSelection) {
      console.error(`  Export error: variant XISF not found at ${finalSelection.variant_path}`);
    } else {
      console.error(`  Export error: no final selection found (no final-selection.json, trace recovery failed)`);
      console.error(`  Manual recovery: inspect variants in ${store.agentDir('giga_orchestrator')}`);
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

  // P3c: Record competitive-attempt outcomes to the cross-run promotion ledger
  // (loss-aware learning — prunes approaches that never win, fast-tracks winners)
  try {
    recordOutcomes(ledgerKey(brief), store);
  } catch (e) {
    console.log(`  Ledger recording skipped: ${e.message}`);
  }

  // WI-09: critical summary (flaws first) - printed before the paths and appended to trace-summary.md
  const criticalBlock = formatCriticalSummary(finalSelection);

  // WI-25: trace artifacts + run-summary.json + manifest finalize/fail (explicit; no finally, process.exit skips it)
  const { traceStats } = await writeRunArtifacts(store, runStatus, {
    agentRuns, exportSource, elapsedMs: elapsed, exitCode: result.exitCode ?? null, signal: result.signal ?? null,
    turns: result.turnCount || 0, finalSelection, criticalBlock,
    failReason: runStatus === 'crashed' ? 'run crashed' : undefined,
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(criticalBlock);
  console.log('-'.repeat(60));
  console.log(`  Run finished — review the flaws above; final judgment is yours.`);
  console.log(`  Final: ${pngPath}`);
  console.log(`  Run: ${store.baseDir}`);
  console.log(`  Duration: ${Math.round(elapsed / 1000)}s (${result.turnCount || 0} turns)`);
  console.log(`  Status: ${runStatus}${exportSource ? ` | export source: ${exportSource}` : ''}`);
  console.log(formatAgentTable(agentRuns, (() => { const { calls, ...usage } = getCritiqueUsage(store.baseDir); return { calls, usage }; })()));
  if (traceStats) console.log(traceStats);
  console.log(`${'='.repeat(60)}`);
}

async function runCorePostPass({ ctx, store, brief, AGENT_MODELS, recordAgent, finalSelection, outputDir, targetName, exportSource }) {
    try {
      console.log('\n--- C-tier: Core Specialist post-pass ---');
      const megaPath = finalSelection.variant_path;
      const escMega = megaPath.replace(/'/g, "\\'");
      await ctx.pjsr(`var ws=ImageWindow.windows;for(var i=0;i<ws.length;i++){ws[i].forceClose();} var a=ImageWindow.open('${escMega}'); var w=a[0]; for(var i=1;i<a.length;i++)a[i].forceClose(); w.mainView.id='CORE_WORK'; w.show(); 'ok';`);
      const coreAgent = new MaxAgent('core_specialist', {
        systemPrompt: buildCoreSpecialistPrompt(brief),
        agentName: 'core_specialist',
        maxTurns: AGENT_MODELS.core_specialist.maxTurns,
        model: AGENT_MODELS.core_specialist.model,
        effort: AGENT_MODELS.core_specialist.effort,
        fallbackModel: AGENT_MODELS.core_specialist.fallbackModel,
        store, brief,
      });
      recordAgent('core_specialist', await coreAgent.run(`## CORE SPECIALIST TASK\nThe finished run-winner is open as \`CORE_WORK\` (a clone). Its surroundings are already what we want — improve ONLY its core (structure, no flat blob, no halo, no white-burn), masked, per your instructions. Leave \`CORE_WORK\` as your BEST result before stopping (restore your best clone into it). Do NOT touch the field/dust/stars.`));
      const specPath = path.join(outputDir, `${targetName}_core_spec.xisf`);
      const mergedPath = path.join(outputDir, `${targetName}_merged.xisf`);
      const chk = await ctx.pjsr(`var w=ImageWindow.windowById('CORE_WORK'); if(w.isNull){'MISSING';}else{w.saveAs('${specPath.replace(/'/g, "\\'")}',false,false,false,false);'ok';}`);
      if (((chk.outputs?.consoleOutput || chk.result || '').trim()) === 'MISSING') {
        console.log('  Core specialist left no CORE_WORK view — keeping mega-winner.');
      } else {
        const profile = { ...(brief.processingProfile || {}), _classification: brief.target.classification };
        // Deterministic candidate selection: saved core_specialist variants + live CORE_WORK,
        // judged against the mega baseline with the judgeAB core win condition.
        let corePath = specPath;
        try {
          const cands = [{ path: specPath, label: 'CORE_WORK' }];
          for (const v of (store.listVariants('core_specialist') || [])) {
            if (v && v.xisfPath && fs.existsSync(v.xisfPath)) cands.push({ path: v.xisfPath, label: `variant ${v.variantId || '?'}` });
          }
          const [base] = await measureCoreCandidates(ctx, [{ path: megaPath, label: 'MEGA' }], profile, (m) => console.log(m));
          if (base && base.core) {
            const measured = await measureCoreCandidates(ctx, cands, profile, (m) => console.log(m));
            const sel = selectCoreCandidate(base.core, measured);
            console.log(`  [core-select] ${sel.reason}`);
            if (sel.chosen && sel.chosen.path) corePath = sel.chosen.path;
          } else {
            console.log('  [core-select] baseline measure failed — using CORE_WORK');
          }
        } catch (e) {
          console.log(`  [core-select] error (${e.message}) — using CORE_WORK`);
        }
        await composeCore(ctx, { megaPath, specPath: corePath, outPath: mergedPath, log: (m) => console.log(m) });
        const verdict = await judgeAB(ctx, { megaPath, mergedPath, profile, log: (m) => console.log(m) });
        if (verdict.winner === 'merged') {
          finalSelection = { ...finalSelection, variant_path: mergedPath, variant_id: `${finalSelection.variant_id || 'variant'}+core` };
          exportSource = 'core-specialist merge (A/B win)';
          console.log('  C-tier: MERGE wins the A/B — exporting the core-grafted result.');
          if (opts.postPassOnly) { try { store.writeFinalSelection({ ...finalSelection, merged_from: megaPath }); } catch (e) { console.log(`  final-selection repoint failed: ${e.message}`); } }
        } else {
          console.log('  C-tier: mega-winner kept (merge did not beat it).');
        }
      }
      await ctx.pjsr(`var ws=ImageWindow.windows;for(var i=0;i<ws.length;i++){ws[i].forceClose();} 'ok';`);
    } catch (e) {
      console.log(`  C-tier core-specialist post-pass error (keeping mega-winner): ${e.message}`);
    }
  return { finalSelection, exportSource };
}

/**
 * --approve: copy the exported final XISF to a durable per-class location and append an
 * 'approved' entry to agents/calibration/approved-images.json (so the back-test registry
 * does not rot when old runs are pruned). Also repoints this run's ledger champions.
 */
function approveExport({ brief, store, xisfPath, variantPath, targetName, requestedRunId }) {
  if (requestedRunId && requestedRunId !== store.runId && `run_${requestedRunId}` !== store.runId && !String(store.runId).includes(requestedRunId)) {
    console.log(`  --approve ${requestedRunId}: does not match current run ${store.runId} — not approving.`);
    return;
  }
  const classification = brief.target.classification;
  const runId = String(store.runId);
  const shortRun = runId.replace(/^run_\d{4}-\d{2}-\d{2}_/, '');
  const dir = path.join(home, '.pixinsight-mcp', 'approved', classification);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${String(targetName).replace(/[^A-Za-z0-9_.-]/g, '_')}_${shortRun}.xisf`);
  fs.copyFileSync(xisfPath, dest);
  const regPath = path.join(__dirname, '..', 'calibration', 'approved-images.json');
  const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf-8')) : { entries: [] };
  reg.entries = (reg.entries || []).filter(e => e.path !== dest);
  reg.entries.push({
    id: `${String(targetName).replace(/[^A-Za-z0-9_]/g, '_')}_${shortRun}`,
    path: dest,
    sourceVariantPath: variantPath,
    classification,
    narrowband: !!brief.dataDescription?.narrowband,
    starless: !!brief.dataDescription?.starless,
    verdict: 'approved',
    source: `giga-run --approve (${runId}), ${new Date().toISOString()}`,
    notes: ''
  });
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n');
  const n = repointChampions(ledgerKey(brief), runId, variantPath, dest);
  console.log(`  APPROVED: ${dest} (registry updated; ${n} champion(s) repointed)`);
}

main().catch(async err => {
  console.error('FATAL:', err);
  try { if (_currentStore) await writeRunArtifacts(_currentStore, 'crashed', { agentRuns: [], failReason: `FATAL: ${err && err.message}` }); } catch {}
  process.exit(1);
});
