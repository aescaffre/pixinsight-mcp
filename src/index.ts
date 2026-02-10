#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient } from "./bridge/client.js";
import { registerImageManagementTools } from "./tools/image-management.js";
import { registerProcessingTools } from "./tools/processing.js";
import { registerResearchTools } from "./tools/research.js";

async function main() {
  const server = new McpServer({
    name: "pixinsight-mcp",
    version: "0.1.0",
  });

  const bridge = new BridgeClient();

  // Ensure bridge directories exist on startup
  await bridge.ensureDirectories();

  // Register all tool categories
  registerImageManagementTools(server, bridge);
  registerProcessingTools(server, bridge);
  registerResearchTools(server);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error("PixInsight MCP Server started (stdio transport)");
  console.error(`Bridge directory: ${bridge.getConfig().bridgeDir}`);
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
