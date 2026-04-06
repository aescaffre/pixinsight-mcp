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
import { buildToolSet } from './tools.mjs';
import { getStats, measureUniformity } from '../ops/index.mjs';
import { createStateMachine, checkBranchCompleteness } from './state-machine.mjs';
import { findRepairPolicy, checkRepairToolAccess, generateRepairGuidance } from './repair-policies.mjs';

// Parse arguments
const agentName = process.argv[2] || 'rgb_cleanliness';
const storeBaseDir = process.argv[3] || null;
const briefPath = process.argv[4] || null;

// Build tool set for this agent
const { definitions, handlers } = buildToolSet(agentName);

// Create bridge context
const ctx = createBridgeContext({ log: (msg) => process.stderr.write(`[mcp] ${msg}\n`) });

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
}

// === STATE MACHINE + TRACE + PROVENANCE ===
const TRACE_START = Date.now();
let traceSeq = 0;
const traceFile = storeBaseDir ? path.join(storeBaseDir, 'trace.jsonl') : null;

// State machine governs tool access per phase
const stateMachine = createStateMachine(250);

// Provenance: track last composition/processing tool per view
const viewProvenance = new Map();

// Expose state machine + provenance to tool handlers via brief
function syncBriefState() {
  if (!brief) return;
  brief._budget = stateMachine.getBudgetStatus();
  brief._provenance = viewProvenance;
  brief._stateMachine = stateMachine;
}

// Periodic swap cleanup — every 20 tool calls, clean stale swap files (>5min old)
const SWAP_DIR = '/var/folders/zs/l60syh197h32ptdrp2yfvzs00000gn/C';
function periodicSwapCleanup() {
  if (traceSeq % 20 !== 0 || traceSeq === 0) return;
  try {
    const files = fs.readdirSync(SWAP_DIR).filter(f => f.startsWith('~PI~') && f.endsWith('.swp'));
    const now = Date.now();
    const threshold = now - 10 * 60 * 1000; // 10 minutes — conservative to avoid hitting active files
    let freed = 0;
    for (const file of files) {
      const p = path.join(SWAP_DIR, file);
      try {
        const stat = fs.statSync(p);
        if (stat.mtimeMs < threshold) { fs.unlinkSync(p); freed += stat.size; }
      } catch {}
    }
    if (freed > 0) {
      process.stderr.write(`[mcp] Swap cleanup: freed ${(freed / 1024 / 1024).toFixed(0)}MB stale swap\n`);
    }
  } catch {}
}

function writeTraceEntry(entry) {
  if (!traceFile) return;
  try {
    fs.appendFileSync(traceFile, JSON.stringify(entry) + '\n');
  } catch {}
}

function summarizeArgs(args) {
  if (!args) return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 200) {
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
  const traceEntry = {
    seq,
    ts: callStart,
    relMs: callStart - TRACE_START,
    tool: name,
    args: summarizeArgs(args),
    viewId: args?.view_id || args?.source_id || args?.target_id || args?.rgb_id || args?.l_id || null,
  };

  // Sync state to brief
  syncBriefState();

  // Swap cleanup DISABLED — deleting swap files while PI is running causes crashes.
  // periodicSwapCleanup();

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
        const budget = stateMachine.getBudgetStatus();
        return { content: [{ type: 'text', text: `REPAIR POLICY VIOLATION: ${repairAccess.reason}\n[Budget: ${budget.turnsRemaining}/${budget.maxTurns} turns — ${budget.status} | State: ${stateMachine.state}]` }] };
      }
      // Tool is allowed by repair policy even if not in general state whitelist — proceed
    } else {
      traceEntry.durationMs = 0;
      traceEntry.error = `BLOCKED (state ${stateMachine.state}): ${access.reason}`;
      traceEntry.resultSummary = null;
      writeTraceEntry(traceEntry);
      const budget = stateMachine.getBudgetStatus();
      return { content: [{ type: 'text', text: `STATE POLICY: ${access.reason}\n[Budget: ${budget.turnsRemaining}/${budget.maxTurns} turns — ${budget.status} | State: ${stateMachine.state}]` }] };
    }
  }

  // Track provenance for composition tools
  const compositionTools = ['lrgb_combine', 'ha_inject_red', 'ha_inject_luminance', 'dynamic_narrowband_blend', 'star_screen_blend', 'star_protected_blend'];
  const viewId = args?.view_id || args?.rgb_id || args?.target_id || null;
  if (compositionTools.includes(name) && viewId) {
    viewProvenance.set(viewId, { tool: name, params: summarizeArgs(args), seq });
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
    writeTraceEntry(traceEntry);

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

    // === REPAIR POLICY: detect gate failures that need structured repair ===
    let repairGuidance = '';
    if (['check_saturation', 'scan_burnt_regions', 'check_star_quality', 'check_tonal_presence', 'check_highlight_texture'].includes(name)) {
      const isFail = resultText.includes('FAIL') || resultText.includes('REJECTED');
      if (isFail && stateMachine.state !== 'repair') {
        const prov = viewProvenance.get(viewId || args?.view_id);
        const category = brief?.target?.classification || 'unknown';
        const policy = findRepairPolicy(name, { resultText }, prov, category);
        if (policy && !policy.advisory) {
          // Enter repair state (only from compose)
          if (stateMachine.state === 'compose') {
            stateMachine.enterRepair(policy);
            repairGuidance = '\n\n' + generateRepairGuidance(policy, prov);
          }
        }
      }
    }

    // === BRANCH COMPLETENESS: blocking check on compose transition ===
    // Detect transition into compose (previous state was generate_candidates,
    // current state is compose — recordToolCall above may have triggered this).
    let branchWarnings = '';
    const justEnteredCompose = stateMachine.state === 'compose' && traceEntry.args && (
      name === 'lrgb_combine' || name === 'star_screen_blend' || name === 'star_protected_blend'
    );
    if (justEnteredCompose && store) {
      try {
        const variants = store.listVariants(agentName);
        const bcResult = checkBranchCompleteness(variants, brief);
        if (!bcResult.complete && bcResult.warnings.length > 0) {
          const budget = stateMachine.getBudgetStatus();
          const budgetAllowsBlock = budget.status !== 'converge' && budget.status !== 'critical';
          const overridden = stateMachine._branchCompletenessOverride;

          if (budgetAllowsBlock && !overridden) {
            // BLOCKING: force back to generate_candidates
            stateMachine.transitionTo('generate_candidates');
            branchWarnings = '\n[BRANCH COMPLETENESS — BLOCKED] Compose rejected: incomplete branches. ' +
              'You MUST go back and generate more variants before composing.\n' +
              bcResult.warnings.map(w => '  - ' + w).join('\n') +
              '\nReturn to generate_candidates and address the gaps above, then retry composition.';
          } else {
            // Advisory only (budget pressure or explicit override)
            const reason = overridden ? 'override active' : `budget ${budget.status}`;
            branchWarnings = `\n[BRANCH COMPLETENESS — advisory, ${reason}] ` + bcResult.warnings.join(' | ');
          }
        }
      } catch (_e) {
        // Non-blocking on error
      }
    }

    // Budget + state status suffix
    const budget = stateMachine.getBudgetStatus();
    const budgetSuffix = `\n[Budget: ${budget.turnsRemaining}/${budget.maxTurns} turns — ${budget.status} | State: ${stateMachine.state}` +
      (budget.guidance.length > 0 ? ` | ${budget.guidance.join('; ')}` : '') + ']' +
      repairGuidance + branchWarnings;

    // Normalize to MCP content format
    if (Array.isArray(result)) {
      const items = result.map(r => {
        if (r.type === 'image') {
          return { type: 'text', text: `[Image saved to disk — use the Read tool to view the preview file]` };
        }
        return { type: 'text', text: r.text || String(r) };
      });
      if (items.length > 0) {
        items[items.length - 1].text += budgetSuffix;
      }
      return { content: items };
    }
    if (result?.type === 'text') {
      return { content: [{ type: 'text', text: result.text + budgetSuffix }] };
    }
    return { content: [{ type: 'text', text: String(result) + budgetSuffix }] };
  } catch (err) {
    traceEntry.durationMs = Date.now() - callStart;
    traceEntry.resultSummary = null;
    traceEntry.error = err.message;
    writeTraceEntry(traceEntry);
    stateMachine.recordToolCall(name, args || {}, '');
    process.stderr.write(`[mcp] Tool error (${name}): ${err.message}\n`);
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
