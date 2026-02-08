# Command Bridge Protocol

## Overview

The bridge protocol defines how the MCP server and the PJSR watcher script communicate through the filesystem. It uses JSON files in a shared directory.

## Directory Structure

```
~/.pixinsight-mcp/
  bridge/
    commands/     # MCP server writes here, watcher reads + deletes
    results/      # Watcher writes here, MCP server reads + deletes
    logs/         # Watcher writes execution logs
  config.json     # Bridge configuration
```

## Command File Format

Written by the MCP server to `bridge/commands/{id}.json`:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2025-01-15T10:30:00.000Z",
  "tool": "calibrate_frames",
  "process": "ImageCalibration",
  "parameters": {
    "targetFrames": [
      [true, "/data/lights/light_001.xisf"],
      [true, "/data/lights/light_002.xisf"]
    ],
    "masterBiasEnabled": true,
    "masterBias": "/data/masters/master_bias.xisf",
    "masterDarkEnabled": true,
    "masterDark": "/data/masters/master_dark.xisf",
    "masterFlatEnabled": true,
    "masterFlat": "/data/masters/master_flat.xisf",
    "outputDirectory": "/data/calibrated/",
    "outputPrefix": "cal_"
  },
  "executeMethod": "executeGlobal",
  "targetView": null
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `id` | string (UUID) | Unique command identifier |
| `timestamp` | string (ISO 8601) | When the command was created |
| `tool` | string | MCP tool name that originated this command |
| `process` | string | PixInsight process class name |
| `parameters` | object | Process parameters (keys match PJSR property names) |
| `executeMethod` | string | `"executeGlobal"` or `"executeOn"` |
| `targetView` | string \| null | View ID for `executeOn`, null for `executeGlobal` |

## Result File Format

Written by the PJSR watcher to `bridge/results/{id}.json`:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2025-01-15T10:30:05.000Z",
  "status": "success",
  "process": "ImageCalibration",
  "duration_ms": 4523,
  "outputs": {
    "files": [
      "/data/calibrated/cal_light_001.xisf",
      "/data/calibrated/cal_light_002.xisf"
    ],
    "imageWindows": ["cal_light_001", "cal_light_002"]
  },
  "message": "Calibrated 2 frames successfully"
}
```

### Error Result

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2025-01-15T10:30:02.000Z",
  "status": "error",
  "process": "ImageCalibration",
  "duration_ms": 150,
  "error": {
    "message": "Master bias file not found: /data/masters/master_bias.xisf",
    "type": "FileNotFound",
    "stack": "..."
  }
}
```

### Status Values

| Status | Meaning |
|---|---|
| `success` | Process completed successfully |
| `error` | Process failed with an error |
| `running` | Process is currently executing (for progress tracking) |

## Special Commands

Beyond direct process execution, some commands have special handling:

### `list_open_images`

```json
{
  "id": "...",
  "tool": "list_open_images",
  "process": "__internal__",
  "parameters": {}
}
```

Result:
```json
{
  "id": "...",
  "status": "success",
  "outputs": {
    "images": [
      {
        "id": "light_001",
        "filePath": "/data/lights/light_001.xisf",
        "width": 4656,
        "height": 3520,
        "channels": 3,
        "isColor": true,
        "bitDepth": 32
      }
    ]
  }
}
```

### `get_image_statistics`

```json
{
  "id": "...",
  "tool": "get_image_statistics",
  "process": "__internal__",
  "parameters": {
    "viewId": "light_001"
  }
}
```

### `run_script`

Execute an arbitrary PJSR script:

```json
{
  "id": "...",
  "tool": "run_script",
  "process": "__script__",
  "parameters": {
    "code": "console.writeln('Hello from PJSR');"
  }
}
```

## Polling & Timeouts

### MCP Server Side
- Poll `bridge/results/{id}.json` every **200ms**
- Default timeout: **300 seconds** (5 minutes) for image processing operations
- Extended timeout: **3600 seconds** (1 hour) for integration/stacking operations
- On timeout: return error to the MCP host

### PJSR Watcher Side
- Poll `bridge/commands/` every **500ms**
- Process commands in FIFO order (sorted by timestamp)
- Write result immediately after process completes (or fails)
- Delete command file after writing result

## Concurrency

- The watcher processes **one command at a time** (PixInsight is single-threaded for most operations)
- The MCP server should queue commands and wait for each to complete before sending the next
- Future enhancement: support parallel execution for independent operations on different images

## Configuration

`~/.pixinsight-mcp/config.json`:

```json
{
  "bridgeDir": "~/.pixinsight-mcp/bridge",
  "pollIntervalMs": 200,
  "defaultTimeoutMs": 300000,
  "pixinsightPath": "/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight",
  "automationMode": true
}
```
