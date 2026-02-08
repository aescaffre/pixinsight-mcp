# Architecture & Design

## Overview

The PixInsight MCP Server is a **stdio-based MCP server** (TypeScript) that bridges AI assistants with a running PixInsight instance. It has two core capabilities:

1. **PixInsight automation** — Execute any PixInsight process via a file-based command bridge
2. **Processing recipes catalog** — A searchable database of community-sourced processing workflows, indexed by astronomical object, that the AI uses to guide processing decisions

Since PixInsight has no native socket/HTTP API, communication happens through a **file-based command bridge**. The focus is on **post-processing** (after WBPP/pre-processing).

## Components

### 1. MCP Server (TypeScript)

- Built with `@modelcontextprotocol/sdk`
- Runs as a local child process spawned by the MCP host (Claude Desktop, etc.)
- Communicates with the host via **stdin/stdout** using JSON-RPC 2.0
- Registers tools that map to PixInsight processing operations
- Manages the recipes catalog (search, add, import, execute)
- Writes command files and reads result files from the bridge directory

### 2. Processing Recipes Catalog

- Local database of structured processing workflows (JSON files, later SQLite)
- Indexed by astronomical object (M42, NGC 7000, etc.), object type, filter set
- Every recipe has source attribution (blog URL, author, platform)
- Optional result image references
- Searchable and extensible — new recipes can be imported from URLs

### 3. PJSR Watcher Script

- A JavaScript script running inside PixInsight's scripting engine (PJSR)
- Polls a shared directory for incoming command JSON files
- Parses each command, instantiates the requested PixInsight process, sets parameters, and executes it
- Writes result JSON files (success/failure, output paths, metadata)
- Runs continuously while PixInsight is open

### 4. Bridge Directory

A shared filesystem directory (e.g., `~/.pixinsight-mcp/bridge/`) with this structure:

```
~/.pixinsight-mcp/
  bridge/
    commands/       # MCP server writes command JSON here
    results/        # Watcher script writes result JSON here
    logs/           # Watcher script writes execution logs
  catalog/
    recipes/        # Processing recipe JSON files
    index.json      # Object -> recipe lookup index
    sources.json    # Tracked source URLs
  config.json       # Global configuration
```

## High-Level Data Flow

### Workflow: Processing an Object

```
1. User: "I want to process M82, I have LRGB+Ha integrated masters from WBPP"

2. Claude calls: search_recipes({ object: "M82", filters: ["L","R","G","B","Ha"] })
   -> MCP server searches local catalog
   -> Returns matching recipes with sources and result images

3. Claude optionally calls: search_new_recipes({ object: "M82" })
   -> MCP server searches the web for new tutorials/workflows
   -> AI extracts structured recipes from found content
   -> New recipes added to catalog

4. Claude presents 2-3 options to the user with:
   - Recipe name and source (with link)
   - Result image (if available)
   - Summary of the approach

5. User picks a recipe

6. Claude executes the recipe step-by-step:
   For each step:
     a. Claude calls the appropriate MCP tool (remove_gradient, color_calibrate, etc.)
     b. MCP server writes command JSON to bridge/commands/
     c. PJSR watcher picks up command, executes in PixInsight
     d. Watcher writes result to bridge/results/
     e. MCP server reads result, returns to Claude
     f. Claude evaluates result and proceeds to next step
```

### Tool Call: Direct Command

```
1. User asks Claude: "Remove gradients from the luminance master"
2. Claude calls MCP tool: remove_gradient({ viewId: "L_master", polyDegree: 4 })
3. MCP Server:
   a. Generates a unique command ID (UUID)
   b. Writes command JSON to bridge/commands/{id}.json
   c. Polls bridge/results/{id}.json (with timeout)
4. PJSR Watcher (inside PixInsight):
   a. Detects new file in bridge/commands/
   b. Parses command, creates ABE process instance
   c. Sets parameters, calls executeOn(view)
   d. Writes result JSON to bridge/results/{id}.json
   e. Deletes the command file
5. MCP Server:
   a. Reads result JSON
   b. Returns result to Claude via MCP protocol
6. Claude presents the result to the user
```

## Why File-Based IPC?

We evaluated several communication strategies:

| Strategy | Pros | Cons | Verdict |
|---|---|---|---|
| **File bridge** | Works with stock PixInsight, reliable, simple | Polling latency (~500ms) | **Chosen** — best balance |
| Launch per command | No persistent watcher | PI startup is slow (seconds) | Too slow for workflows |
| PixInsight IPC (`--start-process`) | Native mechanism | Limited to few processes, parameter constraints | Supplement later |
| Custom PCL module (C++ socket server) | Full control, low latency | Requires C++ PI module development | Future enhancement |

The file bridge latency (~500ms) is negligible compared to actual image processing times (seconds to minutes).

## Scope: Post-WBPP Processing

We deliberately focus on **post-processing** — everything that happens after WBPP (WeightedBatchPreprocessing) produces integrated masters:

**In scope** (what the MCP server handles):
- Gradient removal (ABE/DBE)
- Color calibration (SPCC/PCC)
- Deconvolution
- Noise reduction
- Stretching (linear to non-linear)
- Ha/narrowband blending
- LRGB combination
- Star operations (removal, size reduction)
- Curves, saturation, sharpening
- Final adjustments

**Out of scope initially** (WBPP handles these):
- Calibration (bias, dark, flat)
- Debayer
- Registration / alignment
- Integration / stacking

The pre-processing tools (calibrate, register, integrate) remain in the MCP tools catalog for direct use, but recipes assume post-WBPP starting point.

## PixInsight Automation Mode

PixInsight should run in automation mode for best results:

```bash
/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight \
  -n --automation-mode
```

Automation mode:
- Suppresses all dialog boxes and warnings
- Disables graphical effects and animations
- Does not check for updates
- Ideal for unattended scripted operation

You can also assign a **slot** (1-256) for IPC addressing:

```bash
PixInsight --automation-mode -n=1
```

## Security Considerations

- The MCP server only has access to what the user configures (file paths, bridge directory)
- PixInsight runs with the user's permissions — no privilege escalation
- Command files are deleted after execution
- The bridge directory should be user-private (`chmod 700`)
- Recipe source URLs are stored for attribution — no content is scraped without user action

## Future Enhancements

- **WebSocket bridge**: A PCL C++ module inside PixInsight that opens a WebSocket server, eliminating file polling
- **Progress streaming**: Report real-time progress for long operations (MCP supports async Tasks as of spec 2025-11-25)
- **Image preview**: Return thumbnail previews of processed images as MCP resources
- **Process icon export**: Save/load PixInsight process icons for reproducibility
- **Shared online catalog**: Community-contributed recipe database with ratings and versioning
- **User portal**: Web interface for browsing, contributing, and curating recipes
