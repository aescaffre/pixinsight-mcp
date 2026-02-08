# Implementation Roadmap

## Phase 0 — Project Setup
- [x] Create knowledge base documentation
- [x] Create GitHub repository
- [x] Define recipes catalog schema and design
- [ ] Initialize TypeScript project (`package.json`, `tsconfig.json`)
- [ ] Install MCP SDK (`@modelcontextprotocol/sdk`)
- [ ] Set up build tooling (esbuild or tsc)
- [ ] Create bridge + catalog directory structure helper

## Phase 1 — Proof of Concept (Bridge)
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
- [ ] Configure Claude Desktop / Claude Code to use the MCP server
- [ ] Test: ask Claude "What images are open in PixInsight?" -> get answer
- [ ] Document the setup process

## Phase 2 — Image Management + First Processing Tools
**Goal**: Open/save images and run basic post-processing operations.

- [ ] `open_image` tool
- [ ] `save_image` tool
- [ ] `close_image` tool
- [ ] `get_image_statistics` tool
- [ ] `run_pixelmath` tool (flexible escape hatch)
- [ ] `remove_gradient` tool (ABE)
- [ ] `stretch_image` tool (HistogramTransformation / AutoHistogram)

## Phase 3 — Recipes Catalog (Core)
**Goal**: Searchable recipe catalog with source attribution.

### Catalog Infrastructure
- [ ] Define recipe JSON schema (with validation)
- [ ] Implement local catalog storage (JSON files in ~/.pixinsight-mcp/catalog/)
- [ ] Build object-name index (supports common names, NGC/IC/Messier aliases)
- [ ] Implement `search_recipes` tool
- [ ] Implement `get_recipe` tool
- [ ] Implement `add_recipe` tool

### Seed Recipes
- [ ] Manually create 5-10 seed recipes for popular objects (M42, M31, M81/M82, NGC 7000, IC 1805)
- [ ] Each with full source attribution and step details
- [ ] Validate recipes by executing them

## Phase 4 — Recipe Import + Discovery
**Goal**: AI can find and import new recipes from the web.

- [ ] Implement `import_recipe_from_url` tool (AI extracts recipe from blog/forum)
- [ ] Implement `search_new_recipes` tool (web search -> extract -> catalog)
- [ ] Source URL deduplication
- [ ] Recipe versioning (updates to existing recipes)
- [ ] Handle multiple sources for the same object
- [ ] `rate_recipe` tool

## Phase 5 — Recipe Execution Engine
**Goal**: Claude can execute a full recipe on user's data, step by step.

- [ ] Implement `execute_recipe` tool
- [ ] Channel mapping (recipe channels -> user's actual view IDs)
- [ ] Interactive mode (pause between steps, show result, ask to continue)
- [ ] Adaptive parameters (adjust based on image statistics)
- [ ] Resume from a specific step
- [ ] Full post-processing tools:
  - [ ] `color_calibrate` tool (SPCC/PCC)
  - [ ] `remove_green_cast` tool (SCNR)
  - [ ] `apply_curves` tool (CurvesTransformation)
  - [ ] `denoise` tool (MLT)
  - [ ] `sharpen` tool (UnsharpMask)
  - [ ] `deconvolve` tool (Deconvolution)
  - [ ] `combine_lrgb` tool (LRGBCombination)
  - [ ] `blend_narrowband` tool (PixelMath-based Ha/SII/OIII blending)

## Phase 6 — Pre-Processing Tools (Direct Use)
**Goal**: Full calibration-to-integration for users who want to go beyond WBPP.

- [ ] `calibrate_frames` tool (ImageCalibration)
- [ ] `debayer` tool (Debayer)
- [ ] `register_frames` tool (StarAlignment)
- [ ] `integrate_frames` tool (ImageIntegration)
- [ ] `evaluate_subframes` tool (SubframeSelector)

## Phase 7 — Advanced Features
- [ ] `plate_solve` tool (ImageSolver)
- [ ] `extract_channels` / `combine_channels` tools
- [ ] `run_script` tool (arbitrary PJSR execution)
- [ ] Progress reporting for long operations
- [ ] Image thumbnail preview as MCP resources
- [ ] Migrate catalog to SQLite for performance

## Phase 8 — Polish & Distribution
- [ ] Error messages with actionable guidance
- [ ] Comprehensive logging
- [ ] npm package for easy installation
- [ ] Claude Desktop configuration generator
- [ ] User documentation / tutorial
- [ ] Example workflows (narrowband LRGB, broadband LRGB, SHO palette, mosaic)

## Phase 9 — Community & Portal (Future)
- [ ] Shared online recipe catalog (API-backed)
- [ ] User contributions (submit recipes)
- [ ] Recipe ratings and reviews
- [ ] Web portal for browsing recipes
- [ ] Result image gallery per object
- [ ] Processing discussions / tips

## Milestones

| Milestone | Description | Target |
|---|---|---|
| **M1** | First successful MCP tool call reaching PixInsight | Phase 1 |
| **M2** | First recipe-guided processing session | Phase 5 |
| **M3** | Full post-processing workflow from WBPP output to final image | Phase 5 |
| **M4** | Catalog with 50+ recipes across 20+ objects | Phase 4 |
| **M5** | Published and installable by other users | Phase 8 |
| **M6** | Community recipe portal live | Phase 9 |
