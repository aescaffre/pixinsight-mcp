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
import { createStateMachine } from './state-machine.mjs';
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
const stateMachine = createStateMachine(200);

// Provenance: track last composition/processing tool per view
const viewProvenance = new Map();

// Expose state machine + provenance to tool handlers via brief
function syncBriefState() {
  if (!brief) return;
  brief._budget = stateMachine.getBudgetStatus();
  brief._provenance = viewProvenance;
  brief._stateMachine = stateMachine;
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
  const compositionTools = ['lrgb_combine', 'ha_inject_red', 'ha_inject_luminance', 'dynamic_narrowband_blend', 'star_screen_blend'];
  const viewId = args?.view_id || args?.rgb_id || args?.target_id || null;
  if (compositionTools.includes(name) && viewId) {
    viewProvenance.set(viewId, { tool: name, params: summarizeArgs(args), seq });
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

    // === REPAIR POLICY: detect gate failures that need structured repair ===
    let repairGuidance = '';
    if (['check_saturation', 'scan_burnt_regions', 'check_star_quality'].includes(name)) {
      const isFail = resultText.includes('FAIL') || resultText.includes('REJECTED');
      if (isFail && stateMachine.state !== 'repair') {
        const prov = viewProvenance.get(viewId || args?.view_id);
        const category = brief?.target?.classification || 'unknown';
        const policy = findRepairPolicy(name, { resultText }, prov, category);
        if (policy && !policy.advisory) {
          // Enter repair state
          stateMachine.enterRepair(policy);
          repairGuidance = '\n\n' + generateRepairGuidance(policy, prov);
        }
      }
    }

    // Budget + state status suffix
    const budget = stateMachine.getBudgetStatus();
    const budgetSuffix = `\n[Budget: ${budget.turnsRemaining}/${budget.maxTurns} turns — ${budget.status} | State: ${stateMachine.state}` +
      (budget.guidance.length > 0 ? ` | ${budget.guidance.join('; ')}` : '') + ']' +
      repairGuidance;

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
