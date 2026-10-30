#!/usr/bin/env node
// ============================================================================
// MCP Server exposing agent tools for Claude Code subprocess agents.
// Implements: state machine, repair policies, provenance, budget governance.
//
// Usage (via MCP config):
//   node agents/llm/mcp-agent-tools.mjs <agentName> <storeBaseDir> <briefPath>
// ============================================================================
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createBridgeContext } from '../ops/bridge.mjs';
import { ArtifactStore } from '../artifact-store.mjs';
import { buildToolSet, isLDerived } from './tools.mjs';
import { getStats, measureUniformity } from '../ops/index.mjs';
import { createStateMachine, createCounterBudget, checkBudgetExhausted, checkBranchCompleteness } from './state-machine.mjs';
import { checkRepairToolAccess, createRepairTracker } from './repair-policies.mjs';
import { FATAL_TEXT, writeCrashFile, isCrashed, countTraceLines, saveAgentState, restoreAgentState } from './agent-state.mjs';

// Parse arguments
const agentName = process.argv[2] || 'giga_orchestrator';
const storeBaseDir = process.argv[3] || null;
const briefPath = process.argv[4] || null;
// WI-08: argv[5]=agent maxTurns (turn gate, WI-07a), argv[6]=requested model ('' = inherit)
export const AGENT_MAX_TURNS = parseInt(process.argv[5], 10) || null;
export const AGENT_MODEL = process.argv[6] || 'inherit';

// Build tool set for this agent
const { definitions, handlers } = buildToolSet(agentName);

// Create bridge context
// WI-07b: crash sentinel at the producer. The bridge calls onCrash when the PI process is gone; CRASH.json is
// the cross-process signal read by every CallTool (this MCP) and by engine-max (parent) which SIGTERMs the CLI.
let _lastTool = null, _lastSeq = null;
const ctx = createBridgeContext({
  log: (msg) => process.stderr.write(`[mcp] ${msg}\n`),
  onCrash: (err) => {
    writeCrashFile(storeBaseDir, { agent: agentName, tool: _lastTool, seq: _lastSeq, message: err.message });
    process.stderr.write(`[mcp] PIXINSIGHT CRASH detected -> CRASH.json (${err.message})\n`);
  },
});

// === SWAP GUARD ===
// Zone-separated runs (core clone + dust clone + masks + many variants + undo history)
// can balloon PI swap to tens of GB and choke the disk mid-run. PI's per-window UNDO
// history is the largest reclaimable chunk and this pipeline never uses PI undo (it
// rolls back via clone_image/restore_from_clone), so purging it is safe. Purge undo on
// all views + gc PROACTIVELY every N tool calls, and IMMEDIATELY when free disk is low.
// This does NOT close views or alter image data — only frees undo swap.
let _swapCalls = 0, _lastPurge = 0;
const SWAP_PERIODIC = 8;     // purge every N tool calls
const SWAP_LOW_GB = 14;      // ...and immediately below this much free disk
async function swapGuard() {
  _swapCalls++;
  let freeGB = 999;
  try { const s = fs.statfsSync('/'); freeGB = (s.bavail * s.bsize) / 1e9; } catch {}
  const low = freeGB < SWAP_LOW_GB;
  if (!low && (_swapCalls - _lastPurge) < SWAP_PERIODIC) return;
  try {
    const r = await ctx.pjsr(`var ws=ImageWindow.windows;var n=0;for(var i=0;i<ws.length;i++){try{ws[i].purge();n++;}catch(e){}}processEvents();"purged "+n;`);
    _lastPurge = _swapCalls;
    process.stderr.write(`[mcp][swap-guard] freeGB=${freeGB.toFixed(1)}${low ? ' (LOW)' : ' (periodic)'} -> ${(r.result || r.outputs?.consoleOutput || '').trim()}\n`);
  } catch (e) { process.stderr.write(`[mcp][swap-guard] purge failed: ${e.message}\n`); }
}

// Load store if base dir provided
let store = null;
if (storeBaseDir && fs.existsSync(storeBaseDir)) {
  const manifestPath = path.join(storeBaseDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    store = new ArtifactStore(manifest.runId);
  }
}

// Load brief if path provided
let brief = null;
if (briefPath && fs.existsSync(briefPath)) {
  brief = JSON.parse(fs.readFileSync(briefPath, 'utf-8'));
  brief._lUsage = [];   // WI-13: Gate 10 provenance ({tool, viewId, seq}); restored by restoreAgentState on resume
  brief._lRoots = [];   // views cloned (transitively) from FILTER_L
}

// === STATE MACHINE + TRACE + PROVENANCE ===
const TRACE_START = Date.now();
const traceFile = storeBaseDir ? path.join(storeBaseDir, 'trace.jsonl') : null;
// WI-07b: seq stays monotonic across MCP restarts (trace-mermaid compares seq numerically)
let traceSeq = countTraceLines(traceFile);

// State machine governs tool access per phase — but ONLY for the giga_orchestrator,
// which has the branch/compose/finish flow it was designed for. Focused sub-agents
// (e.g. gradient_agent) are not part of that flow; gating them blocks their core
// tools (per-channel ABE, save_memory) in irrelevant states. Give them a permissive
// stub so every stateMachine.* call site keeps working without per-site guards.
const maxTurns = parseInt(process.argv[5], 10) || 250;
const stateMachine = (agentName === 'giga_orchestrator')
  ? createStateMachine(maxTurns, { warmStart: !!brief?.warmStart })
  : createCounterBudget(maxTurns);

// Provenance + repair engine state (WI-06): lastModifier per view (history of 5, lastComposition kept),
// active repair policies per view, forbids-only enforcement in ANY state.
const repairTracker = createRepairTracker();
const viewProvenance = repairTracker.prov;

// WI-07b: on a resumed agent (PIX_RESUME=1) restore state/provenance/starIntegrity/traceSeq (turnsUsed reset to 0)
if (process.env.PIX_RESUME === '1' && storeBaseDir) {
  const r = restoreAgentState(storeBaseDir, agentName, { stateMachine, provenance: viewProvenance, brief });
  if (r.restored) {
    traceSeq = Math.max(traceSeq, r.traceSeq || 0);
    // 'assess' blocks load_variant/list_variants; after a restart the agent must be able to reload its work
    if (agentName === 'giga_orchestrator' && stateMachine.state === 'assess') stateMachine.state = 'generate_candidates';
  }
  else if (stateMachine && 'state' in stateMachine && agentName === 'giga_orchestrator') stateMachine.state = 'compose';  // permissive when no/invalid snapshot
  process.stderr.write(`[mcp] PIX_RESUME: ${r.restored ? 'state restored -> ' + stateMachine.state : 'not restored (' + r.reason + ') -> ' + stateMachine.state}\n`);
}

function persistAgentState() {
  if (!storeBaseDir) return;
  let counters = {};
  try { counters = { [agentName]: store ? store.maxVariantOnDisk(agentName) : 0 }; } catch {}
  saveAgentState(storeBaseDir, agentName, { stateMachine, provenance: viewProvenance, starIntegrity: brief?._starIntegrity, traceSeq, variantCounters: counters, lUsage: brief?._lUsage, lRoots: brief?._lRoots });
}

// Expose state machine + provenance to tool handlers via brief
function syncBriefState() {
  if (!brief) return;
  brief._budget = stateMachine.getBudgetStatus();
  brief._provenance = viewProvenance;
  brief._stateMachine = stateMachine;
}

// (WI-24: mtime-based periodicSwapCleanup removed — unsafe; orphan swap is cleaned once at giga-run startup.)

function writeTraceEntry(entry) {
  if (!traceFile) return;
  try {
    // WI-25: every entry carries agent/pid/model/state (seq is monotonic: traceSeq starts at the existing line count)
    const full = {
      ...entry,
      agent: entry.agent || agentName,
      pid: entry.pid || process.pid,
      model: entry.model !== undefined ? entry.model : (process.argv[6] || null),
      state: entry.state !== undefined ? entry.state : (stateMachine ? stateMachine.state : null),
    };
    fs.appendFileSync(traceFile, JSON.stringify(full) + '\n');
  } catch {}
}

function summarizeArgs(args) {
  if (!args) return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'expression' && typeof v === 'string') {
      out[k] = v.length > 400 ? v.slice(0, 400) + '...[truncated]' : v;   // WI-13: keep traces auditable
    } else if (typeof v === 'string' && v.length > 200) {
      out[k] = v.slice(0, 100) + '...[truncated]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Create MCP server
const server = new Server(
  { name: 'pixinsight-agent-tools', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: definitions.map(d => ({
    name: d.name,
    description: d.description,
    inputSchema: d.input_schema,
  }))
}));

// Call tool (with state machine + trace + provenance + budget)
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers.get(name);
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }

  const seq = traceSeq++;
  const callStart = Date.now();
  _lastTool = name; _lastSeq = seq;

  // WI-07b: FATAL gate at the very top (catches crashes swallowed by swapGuard / handler try-catch blocks)
  if (isCrashed(ctx, storeBaseDir)) {
    writeTraceEntry({ seq, ts: callStart, relMs: callStart - TRACE_START, tool: name, args: summarizeArgs(args), error: FATAL_TEXT, resultSummary: null, state: stateMachine.state });
    return { content: [{ type: 'text', text: FATAL_TEXT }] };
  }
  const traceEntry = {
    seq,
    ts: callStart,
    relMs: callStart - TRACE_START,
    tool: name,
    args: summarizeArgs(args),
    viewId: args?.view_id || args?.source_id || args?.target_id || args?.rgb_id || args?.l_id || null,
  };

  // WI-06: repair engine bookkeeping. Policies expire by seq (blocked calls count).
  const modViewId = args?.view_id || args?.rgb_id || args?.target_id || null;
  for (const ev of repairTracker.expire(seq)) {
    writeTraceEntry({ seq, ts: Date.now(), tool: name, ...ev });
    if (stateMachine.state === 'repair' && typeof stateMachine.exitRepair === 'function') stateMachine.exitRepair();
  }
  traceEntry.state = stateMachine.state;
  traceEntry.repair_policy = repairTracker.policyIdFor(modViewId) || repairTracker.policyIdFor(traceEntry.viewId) || null;

  // WI-06: forbids-only enforcement on a view with an active policy, regardless of state
  const forbidView = repairTracker.policyIdFor(modViewId) ? modViewId : traceEntry.viewId;
  const forbids = repairTracker.checkForbids(name, args || {}, forbidView);
  if (!forbids.allowed) {
    traceEntry.durationMs = 0;
    traceEntry.error = `BLOCKED (repair policy): ${forbids.reason}`;
    traceEntry.resultSummary = null;
    traceEntry.repair_violation = { policy: forbids.policy, reason: forbids.reason };
    writeTraceEntry(traceEntry);
    writeTraceEntry({ seq, ts: Date.now(), tool: name, event: 'repair_violation', policy: forbids.policy, viewId: forbidView, reason: forbids.reason });
    stateMachine.recordBlockedCall();
    const budget = stateMachine.getBudgetStatus();
    return { content: [{ type: 'text', text: `REPAIR POLICY VIOLATION (${forbids.policy}): ${forbids.reason}\n[Budget: ${budget.turnsRemaining}/${budget.maxTurns} turns \u2014 ${budget.status} | State: ${stateMachine.state}]` }] };
  }

  // Sync state to brief
  syncBriefState();

  // Swap guard: purge PI undo history (safe — never used by this pipeline) to keep swap
  // bounded. Replaces the old file-deletion approach which crashed PI. See swapGuard().
  await swapGuard();

  // === STATE MACHINE: check tool access ===
  const access = stateMachine.checkToolAccess(name);
  if (!access.allowed) {
    // In repair state, check repair-specific tool access
    if (stateMachine.state === 'repair' && stateMachine.repairPolicy) {
      const repairAccess = checkRepairToolAccess(name, args || {}, stateMachine.repairPolicy);
      if (!repairAccess.allowed) {
        traceEntry.durationMs = 0;
        traceEntry.error = `BLOCKED (repair policy): ${repairAccess.reason}`;
        traceEntry.resultSummary = null;
        writeTraceEntry(traceEntry);
        stateMachine.recordBlockedCall();
        const budget = stateMachine.getBudgetStatus();
        return { content: [{ type: 'text', text: `REPAIR POLICY VIOLATION: ${repairAccess.reason}\n[Budget: ${budget.turnsRemaining}/${budget.maxTurns} turns — ${budget.status} | State: ${stateMachine.state}]` }] };
      }
      // Tool is allowed by repair policy even if not in general state whitelist — proceed
    } else {
      traceEntry.durationMs = 0;
      traceEntry.error = `BLOCKED (state ${stateMachine.state}): ${access.reason}`;
      traceEntry.resultSummary = null;
      writeTraceEntry(traceEntry);
      stateMachine.recordBlockedCall();
      const budget = stateMachine.getBudgetStatus();
      const leaveHint = `\nTo leave a state: assess -> generate_candidates: clone_image; generate_candidates -> compose: call begin_composition (or lrgb_combine / star_protected_blend); compose -> finalize: a PASSED finish.`;
      return { content: [{ type: 'text', text: `STATE POLICY: ${access.reason}${leaveHint}\n[Budget: ${budget.turnsRemaining}/${budget.maxTurns} turns — ${budget.status} | State: ${stateMachine.state}]` }] };
    }
  }

  // === BUDGET EXHAUSTION GATE (WI-07a) ===
  const exhausted = checkBudgetExhausted(agentName, name, stateMachine.getBudgetStatus());
  if (exhausted) {
    traceEntry.durationMs = 0;
    traceEntry.error = 'BLOCKED (budget exhausted)';
    traceEntry.resultSummary = null;
    writeTraceEntry(traceEntry);
    stateMachine.recordBlockedCall();
    return { content: [{ type: 'text', text: exhausted }] };
  }

  // Provenance (WI-06): every image-modifying tool records lastModifier {tool, params, seq} + history of 5;
  // composition tools also keep lastComposition. Recorded before the handler (matches the old behaviour).
  const viewId = modViewId;
  repairTracker.recordModifier(name, summarizeArgs(args), seq, viewId);

  // WI-13: clone chain rooted at FILTER_L (Gate 10 provenance)
  if (name === 'clone_image' && brief && args?.source_id && args?.clone_id && isLDerived(args.source_id, brief)) {
    if (!brief._lRoots.includes(args.clone_id)) brief._lRoots.push(args.clone_id);
  }

  // Invalidate star integrity when a star-modifying tool touches a tracked view
  const STAR_MODIFYING_TOOLS = new Set(['run_pixelmath', 'run_curves', 'stretch_stars', 'run_nxt', 'run_bxt']);
  if (STAR_MODIFYING_TOOLS.has(name) && viewId && brief?._starIntegrity?.[viewId]) {
    delete brief._starIntegrity[viewId];
    process.stderr.write(`[mcp] Star integrity invalidated for ${viewId} (modified by ${name})\n`);
  }

  // Age star integrity records (increment turnsAgo for all tracked entries)
  if (brief?._starIntegrity) {
    for (const key of Object.keys(brief._starIntegrity)) {
      brief._starIntegrity[key].turnsAgo = (brief._starIntegrity[key].turnsAgo || 0) + 1;
    }
  }

  // === BRANCH COVERAGE (advisory, WI-05): computed BEFORE the composition handler runs ===
  // Never blocks, never reverts the transition, never skipped silently except for warm starts.
  let branchWarnings = '';
  const isComposeSentinel = name === 'lrgb_combine' || name === 'star_screen_blend' || name === 'star_protected_blend' || name === 'begin_composition';
  if (isComposeSentinel && store && stateMachine.state === 'generate_candidates' && !brief?.warmStart) {
    try {
      const variants = store.listVariants(agentName);
      const bcResult = checkBranchCompleteness(variants, brief);
      if (!bcResult.complete && bcResult.warnings.length > 0) {
        branchWarnings = '\n[BRANCH COVERAGE \u2014 advisory] ' + bcResult.warnings.join(' | ');
      }
    } catch (_e) { /* non-blocking */ }
  }

  try {
    const result = await handler(ctx, store, brief, args || {}, agentName);
    traceEntry.durationMs = Date.now() - callStart;

    // Extract result summary text
    let resultText = '';
    if (Array.isArray(result)) {
      resultText = result.filter(r => r.type === 'text').map(r => r.text).join(' ');
    } else if (result?.type === 'text') {
      resultText = result.text;
    } else {
      resultText = String(result);
    }
    traceEntry.resultSummary = resultText.slice(0, 500);
    traceEntry.error = null;
    if (!Array.isArray(result) && Array.isArray(result?.profileCaps)) traceEntry.profileCaps = result.profileCaps;

    // === REPAIR ENGINE (WI-06): exit on verify PASS / accepted finish, engage on trigger failures ===
    const category = brief?.target?.classification || 'unknown';
    const rep = repairTracker.onResult({ name, args: args || {}, resultText, seq, viewId: viewId || args?.view_id || null, category });
    if (rep.failedGates?.length) {
      traceEntry.failedGates = rep.failedGates.map(g => ({
        gate: g.gate, tool: g.tool, failedMetrics: g.failedMetrics || [], reason: (g.reason || '').slice(0, 200),
        tonal_verdict: g.tonal_verdict || null, p90S: g.p90S ?? null, repairable: g.repairable !== false,
      }));
    }
    writeTraceEntry(traceEntry);
    for (const ev of rep.events) writeTraceEntry({ seq, ts: Date.now(), tool: name, ...ev });

    // Record tool call in state machine (may trigger state transition)
    stateMachine.recordToolCall(name, args || {}, resultText);

    // === POST-CALL: track star integrity results ===
    if (name === 'check_star_layer_integrity' && brief) {
      // The tool handler already stores in brief._starIntegrity, but we also
      // reset turnsAgo to 0 since the check was just run this turn
      const starViewId = args?.view_id;
      if (starViewId && brief._starIntegrity?.[starViewId]) {
        brief._starIntegrity[starViewId].turnsAgo = 0;
      }
    }

    // Repair guidance + state-machine repair state (kept for compose/finalize; enforcement does not depend on it)
    let repairGuidance = rep.guidance || '';
    if (rep.engaged && !String(rep.engaged.policy).startsWith('finish_') && typeof stateMachine.enterRepair === 'function' && (stateMachine.state === 'compose' || stateMachine.state === 'finalize')) {
      try { stateMachine.enterRepair(repairTracker.active.get(rep.engaged.viewId).policy); } catch (_e) { /* non-fatal */ }
    }
    if (stateMachine.state === 'repair' && repairTracker.active.size === 0 && typeof stateMachine.exitRepair === 'function') {
      stateMachine.exitRepair();
    }

    // Budget + state status suffix
    const budget = stateMachine.getBudgetStatus();
    const budgetSuffix = `\n[Budget: ${budget.turnsRemaining}/${budget.maxTurns} turns — ${budget.status} | State: ${stateMachine.state}` +
      ((budget.guidance?.length || 0) > 0 ? ` | ${budget.guidance.join('; ')}` : '') + ']' +
      repairGuidance + branchWarnings;

    persistAgentState();
    // Post-call crash check (a handler may have swallowed a BridgeCrashError)
    const crashNote = isCrashed(ctx, storeBaseDir) ? `\n${FATAL_TEXT}` : '';

    // Normalize to MCP content format
    if (Array.isArray(result)) {
      const items = result.map(r => {
        if (r.type === 'image') {
          return { type: 'text', text: `[Image saved to disk — use the Read tool to view the preview file]` };
        }
        return { type: 'text', text: r.text || String(r) };
      });
      if (items.length > 0) {
        items[items.length - 1].text += budgetSuffix + crashNote;
      }
      return { content: items };
    }
    if (result?.type === 'text') {
      return { content: [{ type: 'text', text: result.text + budgetSuffix + crashNote }] };
    }
    return { content: [{ type: 'text', text: String(result) + budgetSuffix + crashNote }] };
  } catch (err) {
    traceEntry.durationMs = Date.now() - callStart;
    traceEntry.resultSummary = null;
    traceEntry.error = err.message;
    writeTraceEntry(traceEntry);
    stateMachine.recordToolCall(name, args || {}, '');
    process.stderr.write(`[mcp] Tool error (${name}): ${err.message}\n`);
    persistAgentState();
    if (err.isCrash || isCrashed(ctx, storeBaseDir)) {
      if (store) { try { store.fail(err.message); } catch {} }
      return { content: [{ type: 'text', text: `${FATAL_TEXT}\n${err.message}` }] };
    }
    const budget = stateMachine.getBudgetStatus();
    return { content: [{ type: 'text', text: `Error: ${err.message}\n[Budget: ${budget.turnsRemaining}/${budget.maxTurns} turns — ${budget.status} | State: ${stateMachine.state}]` }] };
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);

// Auto-exit when parent process disconnects (stdin closes)
process.stdin.on('end', () => {
  process.stderr.write('[mcp] stdin closed — parent exited. Shutting down.\n');
  process.exit(0);
});
process.stdin.on('error', () => {
  process.exit(0);
});
