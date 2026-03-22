#!/usr/bin/env node
// ============================================================================
// MCP Server exposing agent tools for Claude Code subprocess agents.
// This runs as a child process spawned by claude CLI via --mcp-config.
//
// Usage (via MCP config):
//   node agents/llm/mcp-agent-tools.mjs <agentName> <storeBaseDir> <briefPath>
//
// - agentName:    determines which tool subset to expose
// - storeBaseDir: artifact store base directory (for save_variant etc.)
// - briefPath:    path to brief.json
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
  // Reconstruct a minimal store-like object with the needed methods
  // ArtifactStore constructor creates dirs, so we create a wrapper that uses the existing dir
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

// Create MCP server
const server = new Server(
  { name: 'pixinsight-agent-tools', version: '2.0.0' },
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

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers.get(name);
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }

  try {
    const result = await handler(ctx, store, brief, args || {}, agentName);

    // Normalize to MCP content format
    if (Array.isArray(result)) {
      return {
        content: result.map(r => {
          if (r.type === 'image') {
            // In MCP mode, images can't be sent as base64 in tool results.
            // The save_and_show_preview handler already saves the JPEG to disk.
            // We return the file path so the agent can use Read to view it.
            return { type: 'text', text: `[Image saved to disk — use the Read tool to view the preview file]` };
          }
          return { type: 'text', text: r.text || String(r) };
        })
      };
    }
    if (result?.type === 'text') {
      return { content: [{ type: 'text', text: result.text }] };
    }
    return { content: [{ type: 'text', text: String(result) }] };
  } catch (err) {
    process.stderr.write(`[mcp] Tool error (${name}): ${err.message}\n`);
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
