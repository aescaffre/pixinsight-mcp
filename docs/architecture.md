# Architecture & Design

## Overview

The PixInsight MCP Server is a **stdio-based MCP server** (TypeScript) that bridges AI assistants with a running PixInsight instance. Since PixInsight has no native socket/HTTP API, communication happens through a **file-based command bridge**.

## Components

### 1. MCP Server (TypeScript)

- Built with `@modelcontextprotocol/sdk`
- Runs as a local child process spawned by the MCP host (Claude Desktop, etc.)
- Communicates with the host via **stdin/stdout** using JSON-RPC 2.0
- Registers tools that map to PixInsight processing operations
- Writes command files and reads result files from the bridge directory

### 2. PJSR Watcher Script

- A JavaScript script running inside PixInsight's scripting engine (PJSR)
- Polls a shared directory for incoming command JSON files
- Parses each command, instantiates the requested PixInsight process, sets parameters, and executes it
- Writes result JSON files (success/failure, output paths, metadata)
- Runs continuously while PixInsight is open

### 3. Bridge Directory

A shared filesystem directory (e.g., `~/.pixinsight-mcp/bridge/`) with this structure:

```
~/.pixinsight-mcp/bridge/
  commands/       # MCP server writes command JSON here
  results/        # Watcher script writes result JSON here
  logs/           # Watcher script writes execution logs
```

## Data Flow

```
1. User asks Claude: "Calibrate my light frames"
2. Claude calls MCP tool: calibrate_frames({ lights: "/data/lights", ... })
3. MCP Server:
   a. Generates a unique command ID (UUID)
   b. Writes command JSON to bridge/commands/{id}.json
   c. Polls bridge/results/{id}.json (with timeout)
4. PJSR Watcher (inside PixInsight):
   a. Detects new file in bridge/commands/
   b. Parses command, creates ImageCalibration process instance
   c. Sets parameters, calls executeGlobal()
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

## Future Enhancements

- **WebSocket bridge**: A PCL C++ module inside PixInsight that opens a WebSocket server, eliminating file polling
- **Progress streaming**: Report real-time progress for long operations (MCP supports async Tasks as of spec 2025-11-25)
- **Image preview**: Return thumbnail previews of processed images as MCP resources
- **Process icon export**: Save/load PixInsight process icons for reproducibility
