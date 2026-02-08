# PixInsight MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) Desktop server that enables AI assistants (Claude Desktop, Claude Code, VS Code) to control [PixInsight](https://pixinsight.com/) for astrophotography image processing.

## Vision

Use natural language to describe your astrophotography processing workflow, and let the AI orchestrate PixInsight's powerful processing engine to execute it.

```
You: "Calibrate all the light frames in /data/lights using the masters in /data/masters,
      then register and integrate them"

Claude: [calls calibrate_frames tool] -> [calls register_frames tool] -> [calls integrate_frames tool]
        -> PixInsight executes each step automatically
```

## Architecture

```
Claude Desktop / Claude Code / VS Code
    |  (stdio JSON-RPC)
    |
MCP Server (TypeScript, local process)
    |  (file-based command bridge)
    |
PixInsight (running in automation mode)
    └── Watcher script (PJSR) polls for commands, executes, writes results
```

## Status

**Phase: Knowledge Base / Design** — Not yet implemented.

See [docs/](docs/) for the full knowledge base and implementation plan.

## Quick Links

- [Architecture & Design](docs/architecture.md)
- [PJSR Scripting Reference](docs/pjsr-reference.md)
- [PixInsight Processes Catalog](docs/processes.md)
- [Command Bridge Protocol](docs/bridge-protocol.md)
- [MCP Tools Catalog](docs/mcp-tools.md)
- [Implementation Roadmap](docs/roadmap.md)
- [Development Setup](docs/dev-setup.md)

## License

MIT
