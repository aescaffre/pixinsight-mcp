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

- **MCP Server**: Working — 17 tools + PJSR watcher for interactive control
- **Pipeline Script**: Working — config-driven branching pipeline (`scripts/run-pipeline.mjs`)
- **Web Editor**: Working — visual config editor (`editor/`)
- **Recipes Catalog**: Not started

## Pipeline Script

`scripts/run-pipeline.mjs` is a Node.js script that drives PixInsight through a complete deep sky processing workflow. It supports HaRGB, HaLRGB, and LRGB configurations with branching (stars, Ha, luminance), checkpoints, and iterative tuning.

### Inspired By / References

The pipeline implements techniques from the PixInsight community:

| Technique | Inspired By | Implementation |
|-----------|-------------|----------------|
| **Star Stretch (Seti method)** | [Seti Astro](https://www.setiastro.com) (Bill Blanshan) — MTF-based star stretching that progressively lifts faint stars without bloating bright ones | `starMethod: "linear"` in star_stretch params. Applies N iterations of `MTF(m, x) = (1-m)*x / ((1-2m)*x + m)` via PixelMath on linear star residuals. |
| **Generalized Hyperbolic Stretch (GHS)** | [GHS Script](https://ghsastro.co.uk) by Mike Cranfield & Mark Shelley — PixInsight script at `src/scripts/GeneralisedHyperbolicStretch/` | Coefficients computed in Node.js (`computeGHSCoefficients`), applied via PixelMath piecewise expression. Fallback because GHS .dylib module is not installed. |
| **Non-linear star extraction** | PixInsight community technique — stretch pre-SXT image identically, then SXT with unscreen | `starMethod: "nonlinear"` (default). Avoids halo bloating from stretching linear star residuals. |
| **Screen blend star recombination** | Standard astrophotography technique: `1-(1-A)*(1-B)` | PixelMath `~(~$T*~(strength*stars))` |
| **Ha injection (3-part)** | Combination of community techniques for narrowband enhancement | Conditional R-channel injection + LRGBCombination luminance boost + high-frequency detail layer |
| **STF Auto-stretch** | PixInsight's built-in STF algorithm: `shadows = median - 2.8*MAD`, midtone transfer function | Replicated in `autoStretch()` for programmatic HT application |

### Running

```bash
# Full pipeline
node scripts/run-pipeline.mjs --config path/to/config.json

# Resume from checkpoint
node scripts/run-pipeline.mjs --config path/to/config.json --restart-from stretch
```

## Quick Links

- [Architecture & Design](docs/architecture.md)
- [Processing Recipes Catalog](docs/recipes-catalog.md)
- [PJSR Scripting Reference](docs/pjsr-reference.md)
- [PixInsight Processes Catalog](docs/processes.md)
- [Command Bridge Protocol](docs/bridge-protocol.md)
- [MCP Tools Catalog](docs/mcp-tools.md)
- [Implementation Roadmap](docs/roadmap.md)
- [Development Setup](docs/dev-setup.md)
- [Pipeline Skill Reference](.claude/skills/pixinsight-pipeline/SKILL.md)

## Astro ARO — Remote Observatory

This project is developed by the operator of [**Astro ARO**](https://astrolentejo.fr), a remote observatory located in the **Alentejo Dark Sky Reserve** (Portugal) — one of Europe's darkest sites at **Bortle 2-3**.

Seats are regularly available for remote observation. Visit the [Teams section](https://astrolentejo.fr) to see images taken from the observatory, and use the [Contact page](https://astrolentejo.fr) if you are interested in joining.

## License

MIT
