# Implementation Roadmap

## Phase 0 — Project Setup
- [x] Create knowledge base documentation
- [x] Create GitHub repository
- [ ] Initialize TypeScript project (`package.json`, `tsconfig.json`)
- [ ] Install MCP SDK (`@modelcontextprotocol/sdk`)
- [ ] Set up build tooling (esbuild or tsc)
- [ ] Create bridge directory structure helper

## Phase 1 — Proof of Concept
**Goal**: One working end-to-end tool through the full stack.

### MCP Server
- [ ] Scaffold MCP server with stdio transport
- [ ] Implement `list_open_images` tool
- [ ] Implement command file writer (JSON to bridge/commands/)
- [ ] Implement result file poller (bridge/results/ -> response)
- [ ] Add timeout handling

### PJSR Watcher
- [ ] Write the watcher script (`pixinsight-mcp-watcher.js`)
- [ ] Implement command file reader / JSON parser
- [ ] Implement `list_open_images` handler (query ImageWindow.windows)
- [ ] Implement result file writer
- [ ] Add error handling and logging
- [ ] Test watcher inside PixInsight Script Editor

### Integration
- [ ] Configure Claude Desktop to use the MCP server
- [ ] Test: ask Claude "What images are open in PixInsight?" -> get answer
- [ ] Document the setup process

## Phase 2 — Core Image Operations
**Goal**: Basic image I/O and inspection.

- [ ] `open_image` tool
- [ ] `save_image` tool
- [ ] `close_image` tool
- [ ] `get_image_statistics` tool
- [ ] `run_pixelmath` tool (flexible escape hatch)

## Phase 3 — Pre-Processing Pipeline
**Goal**: Full calibration-to-integration workflow.

- [ ] `calibrate_frames` tool (ImageCalibration)
- [ ] `debayer` tool (Debayer)
- [ ] `register_frames` tool (StarAlignment)
- [ ] `integrate_frames` tool (ImageIntegration)
- [ ] Test: complete preprocessing pipeline via Claude

## Phase 4 — Post-Processing
**Goal**: Gradient removal, color calibration, stretching.

- [ ] `remove_gradient` tool (ABE)
- [ ] `color_calibrate` tool (SPCC/PCC)
- [ ] `remove_green_cast` tool (SCNR)
- [ ] `stretch_image` tool (HistogramTransformation / AutoHistogram)
- [ ] `apply_curves` tool (CurvesTransformation)
- [ ] `denoise` tool (MLT)
- [ ] `sharpen` tool (UnsharpMask)

## Phase 5 — Advanced Features
- [ ] `plate_solve` tool (ImageSolver)
- [ ] `extract_channels` / `combine_channels` tools
- [ ] `evaluate_subframes` tool (SubframeSelector)
- [ ] `run_script` tool (arbitrary PJSR execution)
- [ ] Progress reporting for long operations
- [ ] Image thumbnail preview as MCP resources

## Phase 6 — Polish & Distribution
- [ ] Error messages with actionable guidance
- [ ] Comprehensive logging
- [ ] npm package for easy installation
- [ ] Claude Desktop configuration generator
- [ ] User documentation / tutorial
- [ ] Example workflows (narrowband, broadband, mosaic)

## Milestones

| Milestone | Description | Target |
|---|---|---|
| **M1** | First successful MCP tool call reaching PixInsight | Phase 1 |
| **M2** | Full preprocessing pipeline via natural language | Phase 3 |
| **M3** | Complete processing from lights to final image | Phase 4 |
| **M4** | Published and installable by other users | Phase 6 |
