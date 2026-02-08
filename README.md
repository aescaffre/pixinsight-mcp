# PixInsight MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) Desktop server that enables AI assistants (Claude Desktop, Claude Code, VS Code) to control [PixInsight](https://pixinsight.com/) for astrophotography image processing — powered by a community-built catalog of processing recipes.

## Vision

**Two pillars:**

1. **AI-driven PixInsight automation** — Use natural language to execute post-processing workflows in PixInsight, starting after WBPP (pre-processing).

2. **Processing recipes catalog** — A growing, searchable database of processing workflows indexed by astronomical object. Each recipe references its source (blog posts, AstroBin, WebAstro, forums...) and, when available, the resulting image. The AI uses this catalog to suggest proven approaches for your target.

### Example Flow

```
You: "I want to process M82 and M81. I have 9h each of R, G, B,
      50h of L and 35h of Ha. Data is already integrated via WBPP."

Claude:
  1. Searches the recipe catalog for M82/M81 workflows
  2. Searches online for new approaches (blogs, AstroBin, forums)
  3. Presents 2-3 recipes with source links and result images
  4. You pick one
  5. Claude pilots PixInsight step-by-step through the workflow
```

## Architecture

```
Claude Desktop / Claude Code / VS Code
    |  (stdio JSON-RPC)
    |
MCP Server (TypeScript, local process)
    |            |
    |            +-- Processing Recipes Catalog (local JSON/SQLite)
    |            |     indexed by object, tags, filter set
    |            |     sources: blogs, AstroBin, WebAstro, forums
    |            |
    |            +-- Web search (discover new recipes)
    |
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
- [Processing Recipes Catalog](docs/recipes-catalog.md)
- [PJSR Scripting Reference](docs/pjsr-reference.md)
- [PixInsight Processes Catalog](docs/processes.md)
- [Command Bridge Protocol](docs/bridge-protocol.md)
- [MCP Tools Catalog](docs/mcp-tools.md)
- [Implementation Roadmap](docs/roadmap.md)
- [Development Setup](docs/dev-setup.md)

## License

MIT
