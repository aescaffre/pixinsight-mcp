# PixInsight MCP -- Autonomous Deep Sky Astrophotography Processing

An autonomous deep sky astrophotography processing pipeline that uses Claude (via Claude Code / Max subscription) to drive PixInsight through file-based IPC. The LLM acts as a processing director -- making creative decisions about stretching, detail enhancement, color saturation, and star management -- while code-enforced quality gates prevent common processing failures like ringing artifacts, core burning, and star destruction.

**Status**: Work in progress. Actively developed and used for production processing.

> **Note on `scripts/run-pipeline.mjs`**: The original fully-scripted pipeline in `scripts/run-pipeline.mjs` was the first approach — a deterministic, config-driven processing chain with no LLM involvement. It is now **superseded by the GIGA agentic pipeline** (`agents/llm/giga-run.mjs`) which uses Claude as a creative processing director. The scripted pipeline remains in the repo for reference but is no longer actively maintained. All new development targets the agentic architecture.

---

## What It Does

You provide calibrated, stacked master frames (post-WBPP) and a minimal JSON config. The pipeline classifies your target, recalls processing knowledge from prior runs, executes deterministic linear prep, then hands control to a Claude agent that generates bracketed candidate sets across four creative branches, self-critiques, and composes a final image -- all while code-enforced quality gates prevent the agent from producing ringing artifacts, burnt cores, or destroyed stars.

```
You: config.json with M81 HaLRGB file paths + "push IFN hard, vivid galaxy colors"

Pipeline:
  1. Classifies M81 as galaxy_spiral (core_arms_ifn, broadband, high dynamic range)
  2. Recalls memory: "Seti target 0.12 for L, HDRMT inverted 6L/1i, Ha strength 0.25"
  3. Deterministic prep: align, combine, GC, BXT, SPCC, NXT, SXT, stretch (~12 min, cached)
  4. Creative agent generates 16 candidates across 4 branches:
     - Luminance detail: LHE + HDRMT from weak to overdone
     - IFN/faint structure: shadow-lifting curves from subtle to aggressive
     - Color: saturation curves + Ha injection from restrained to overdone
     - Stars: stretch + color saturation from bright to over-reduced
  5. Critic pass selects branch winners, identifies overdone boundaries
  6. Composes 4 final candidates (balanced, bold-IFN, bold-color, edge)
  7. Art director picks near-edge-but-credible winner
  8. Quality gates pass -> saves final XISF + JPG -> saves memory for next target
```

---

## Architecture Overview

```
                        +---------------------+
                        |   Config JSON        |
                        |  (target, channels,  |
                        |   aesthetic prefs)    |
                        +---------+-----------+
                                  |
                        +---------v-----------+
                        |  Classifier          |
                        |  agents/classifier   |
                        |  target-taxonomy.json|
                        +---------+-----------+
                                  |
               +------------------+------------------+
               |                                     |
    +----------v-----------+           +-------------v-----------+
    | Phase 1: Deterministic|           | Phase 2+: Creative Agent |
    | Prep (no LLM)         |           | (Claude Max subprocess)  |
    | deterministic-prep.mjs|           | giga-run.mjs             |
    |                       |           |                          |
    | open, align, combine, |           | 53 MCP tools             |
    | GC, BN, BXT, SPCC,   |           | bracket-then-critic      |
    | NXT, SXT, stretch     |           | 4 branches x 4 candidates|
    +-----------+-----------+           | quality gates             |
                |                       +-------------+-------------+
                |                                     |
                +----> PixInsight (PJSR) <------------+
                       via file-based bridge IPC
                       (~/.pixinsight-mcp/bridge/)
```

### Two-Phase Design

**Phase 1: Deterministic Prep** (`agents/llm/deterministic-prep.mjs`) -- Zero LLM involvement. Opens calibrated masters, aligns channels via StarAlignment, combines RGB, runs the canonical linear processing sequence (gradient correction, BlurXTerminator correction, astrometric solution copy, SPCC color calibration, background neutralization, NoiseXTerminator, BlurXTerminator sharpening, StarXTerminator star extraction, Seti statistical stretch). Repeats for L and Ha channels if present. This phase is deterministic and **cached**: a SHA-256 fingerprint of the script content plus input file headers (size + mtime + first/last 64KB) means identical inputs skip reprocessing entirely.

**Phase 2+: Creative Agent** (`agents/llm/giga-run.mjs`) -- A single Claude agent spawned as a `claude -p` subprocess (running on a Max subscription, zero API cost) receives the prepped working assets and a system prompt dynamically built from the target's classification and processing traits. The agent has access to 53 MCP tools that map to PixInsight operations and drives the creative processing through a structured bracket-then-critic workflow.

### File-Based Bridge IPC

Node.js communicates with PixInsight's PJSR scripting engine through a file-based bridge at `~/.pixinsight-mcp/bridge/`. A watcher script (`pjsr/pixinsight-mcp-watcher.js`, ECMAScript 5) runs inside PixInsight, polls for JSON command files, executes them via the PJSR engine, and writes result files. This is the only way to programmatically control PixInsight -- there is no socket or HTTP API. Bridge latency is approximately 2 seconds per tool call.

### The Claude Max Engine

The creative agent runs via `claude -p` subprocess (`agents/llm/engine-max.mjs`). No API key is needed -- it uses the user's Claude Max subscription through Claude Code. The system prompt is passed via `--append-system-prompt`, the initial message contains prep results and diagnostic views, and custom MCP tools are provided via an MCP server configuration. Claude Code handles the tool loop automatically. Budget is set to 200 turns for the full pipeline.

---

## The Tool Inventory

60 tools organized into categories (`agents/llm/tools.mjs`):

| Category | Tools | Purpose |
|----------|-------|---------|
| measurement | get_image_stats, measure_uniformity | Read pixel statistics, background uniformity |
| preview | save_and_show_preview | Export diagnostic JPEGs for visual inspection |
| image_mgmt | clone_image, restore_from_clone, close_image, purge_undo | State management and memory control |
| gradient | run_gradient_correction, run_abe, run_per_channel_abe, run_scnr | Background flattening and green cast removal |
| denoise | run_nxt | NoiseXTerminator |
| sharpen | run_bxt | BlurXTerminator (correct + sharpen modes) |
| stretch | seti_stretch, auto_stretch, stretch_stars | Statistical stretch, quick inspection, star stretch |
| masks | create_luminance_mask, apply_mask, remove_mask, close_mask | Mask creation, application, cleanup |
| detail | run_lhe, run_hdrmt | LocalHistogramEqualization, HDRMultiscaleTransform |
| curves | run_curves, run_pixelmath | Tonal and color adjustments, arbitrary expressions |
| lrgb | lrgb_combine | Luminance-RGB combination with LinearFit |
| ha_injection | ha_inject_red, ha_inject_luminance | Narrowband Ha blending into RGB (soft-clamp prevents burning) |
| narrowband | extract_pseudo_oiii, continuum_subtract_ha, dynamic_narrowband_blend, create_synthetic_luminance, create_zone_masks | Emission-line extraction from broadband, dual-zone color, zone-based HDR |
| stars | star_screen_blend | Star reintegration via screen blend |
| quality_gate | check_star_quality, check_ringing, check_core_burning, check_sharpness, scan_burnt_regions | Zero-tolerance burn scan (100×100 blocks), star quality, ringing detection |
| memory | recall_memory, save_memory | Hierarchical knowledge store access |
| scoring | compute_scores, submit_scores | Multi-dimensional image scoring (8 dimensions) |
| control | save_variant, list_variants, load_variant, finish | Candidate management and workflow control |

---

## Key Innovations

### Quality Gates as Code-Enforced Constraints

Quality gates (`agents/ops/quality-gates.mjs`) execute actual PJSR pixel analysis inside PixInsight -- they are not prompt suggestions that the agent might ignore. The `finish` tool runs all gates automatically; the agent cannot complete processing until every gate passes.

- **Zero-tolerance burn scan**: Tiles the image in 100×100px blocks (large enough that individual stars can't false-positive). If ANY block has >3% pixels above 0.93 luminance, the image fails. Zero burnt blocks allowed — the agent literally cannot finish with a blown-out core, regardless of how small the subject is relative to the frame. Every brightness-modifying tool also reports inline burn warnings (`⚠️ BURN WARNING: max=X`).
- **Star quality**: Detects stars via local-maximum scanning on a 16px grid, refines positions in 5x5 windows, measures FWHM via half-maximum radius in 4 directions (must be < 6px), and color diversity via normalized channel spread (must be > 0.05). Minimum 50 detected stars required.
- **Subject metrics**: Subject brightness ≥ 0.25 (hard gate), contrast ratio ≥ 2× for PNe / 3× for others, detail score ≥ 0.001.
- **Ringing detection**: Radial brightness profile around brightest region, counts derivative sign changes.
- **Over-denoising**: NXT denoise values above 0.25 are flagged; the prompt enforces a 0.15 maximum for final passes.

### Target Taxonomy and Classifier

A 12-category taxonomy (`agents/target-taxonomy.json`) defines processing-relevant traits for every deep sky object type:

| Category | Examples | Key Traits |
|----------|----------|------------|
| galaxy_spiral | M31, M51, M81 | core_arms_ifn, broadband, high DR, IFN goal |
| galaxy_edge_on | NGC 891, NGC 4565 | core_halo, dust lanes, IFN goal |
| galaxy_elliptical | M87, M49 | core_halo, smooth profile, outer halo goal |
| galaxy_cluster | Abell 2151, Stephan's Quintet | tiny_multiple, diverse color, background galaxies |
| emission_nebula | M42, NGC 7000 | ha_dominant, multi_zone, filaments goal |
| planetary_nebula | M27, M57, M97 | dual_narrowband, core_halo, shells/knots |
| reflection_nebula | M45, NGC 7023 | broadband, scattered light, outer halo |
| dark_nebula | Barnard 33, LDN 1622 | silhouette against star field, subtle texture |
| supernova_remnant | NGC 6960, Simeis 147 | filamentary structure, dual narrowband |
| star_cluster_globular | M13, M3 | stars_are_subject, core resolution challenge |
| star_cluster_open | NGC 884, NGC 869 | stars_are_subject, color diversity |
| mixed_field | Rho Ophiuchi, Cygnus Wall | multi_zone, competing priorities |

Each category carries 7 trait dimensions (signalType, structuralZones, colorZonation, starRelationship, faintStructureGoal, subjectScale, dynamicRange) plus boolean flags and free-text processing notes.

The classifier (`agents/classifier.mjs`) maps target names to categories using a known-object lookup (100+ objects) with heuristic fallbacks, then generates a processing brief including classification, workflow detection (LRGB, HaLRGB, HaRGB, RGB), aesthetic intent, and field characteristics. **Zero hardcoded target text exists in the prompt** -- the same generic orchestrator prompt handles M81 and the Owl Nebula because all behavior is driven by taxonomy traits and processing notes.

### Hierarchical Memory with Auto-Promotion

Five levels of processing knowledge (`agents/memory/hierarchical-memory.mjs`), stored as JSON at `~/.pixinsight-mcp/agent-memory/hierarchical.json`:

1. **universal** -- applies to all targets (e.g., "NXT denoise > 0.25 destroys detail")
2. **trait** -- keyed by trait name (e.g., "core_halo" targets need HDRMT maskClipLow >= 0.35)
3. **type** -- keyed by classification (e.g., galaxy_spiral Seti stretch target = 0.12)
4. **data_class** -- keyed by workflow + subject scale (e.g., HaLRGB_large)
5. **target** -- keyed by target name (e.g., M81 specific Ha injection strength)

The `recallForBrief()` function gathers all relevant entries from all levels, matching on classification, all trait keys (structuralZones, signalType, colorZonation, etc.), data class fingerprint, and target name. The agent receives a formatted summary at the start of every run.

The memory optimizer (`optimizeMemory()`) runs after every processing session and automatically promotes entries up the hierarchy:
- Same param+value wins in 3+ targets of the same type --> promote to type level
- Same param+value confirmed across 2+ types sharing a trait --> promote to trait level
- Type-level entry confirmed across all data classes --> promote to universal

This means knowledge from processing M81 (galaxy_spiral with core_arms_ifn and high dynamic range) can inform processing of the Veil Nebula (supernova_remnant), because they share processing traits like bright cores and similar HDRMT masking requirements.

### Bracket-Then-Critic Workflow

The creative agent follows a structured 7-phase workflow defined in `agents/llm/prompts/giga-orchestrator.mjs`. For each of four branches, the agent must generate exactly four candidates at increasing intensity:

- **weak / restrained** -- clearly too conservative
- **target / bold** -- the intended sweet spot
- **edge** -- pushing limits, may show first artifacts
- **overdone** -- intentionally too strong, marking the rejection boundary

If the agent cannot produce an overdone candidate, it has not searched enough of the parameter space. This is enforced in the prompt as a hard requirement: "NEVER call finish after producing only one acceptable result."

The four branches address conflicting goals that cannot be optimized simultaneously:
- **Branch A -- Luminance Detail**: LHE multi-scale + HDRMT inverted (when L channel present)
- **Branch B -- Faint Structure / IFN**: Shadow-lifting curves through inverted luminance masks
- **Branch C -- Color Richness**: Two-stage saturation curves + hue-selective boosts + Ha injection
- **Branch D -- Star Policy**: Stretch, color saturation, and reduction decisions on the extracted star layer

After generation, a critic pass evaluates candidates per branch, identifies overdone boundaries, selects winners, and may trigger one narrow refinement round. Composition candidates (balanced, bold-IFN, bold-color, edge) combine branch winners, followed by a composition critic and art director decision targeting "near-edge but credible."

### Prep Caching

Deterministic prep computes a cache key from a SHA-256 hash of the prep script content plus fingerprints of each input master file (file size + mtime + first/last 64KB content hash). Cache hits load pre-computed XISF files directly into PixInsight, skipping 10-15 minutes of linear processing. Cache is stored at `~/.pixinsight-mcp/prep-cache/`.

### Scoring Model

An 8-dimension scoring model (`agents/scoring.mjs`) with target-type-specific weight profiles:
- detail_credibility, background_quality, color_naturalness, star_integrity
- tonal_balance, subject_separation, artifact_penalty, aesthetic_coherence

Each dimension scored 0-100. Weight profiles vary by target type (galaxy_spiral weights detail_credibility highest; star_cluster_open weights star_integrity highest).

---

## Processing Flow

```
DETERMINISTIC PREP (Phase 1, ~10-15 min first run, cached thereafter):
  disk space check (>= 20 GB required)
  --> cache key computation (script hash + input fingerprints)
  --> [cache hit: load XISF files, skip to Phase 2]
  --> close all open images
  --> open masters (with channel swap if configured)
  --> check dimensions, align to R reference via StarAlignment
  --> combine RGB channels
  --> gradient correction (GC or ABE, auto-selected)
  --> BXT correct_only (deconvolution)
  --> copy astrometric solution back (BXT strips WCS)
  --> SPCC color calibration
  --> background neutralization
  --> NXT linear denoise (0.20)
  --> BXT sharpen
  --> SXT star extraction (linear mode, stars=true only)
  --> Seti statistical stretch (target=0.12, headroom=0.05)
  --> NXT post-stretch denoise (0.25)
  --> [repeat GC, BXT, NXT, SXT, stretch for L and Ha if present]
  --> save to cache

CREATIVE AGENT (Phase 2+, ~30-60 min via Claude Max):
  Phase 0: recall_memory, inspect prep diagnostics
  Phase 2: Branch generation (4 branches x 4 candidates = 16 candidates)
    Branch A -- Luminance detail (LHE, HDRMT, masks)
    Branch B -- Faint structure / IFN (shadow-lifting curves, inverted masks)
    Branch C -- Color / Ha injection (saturation curves, narrowband blending)
    Branch D -- Stars (stretch, color saturation, screen blend params)
  Phase 3: Branch critic pass (score, compare, select winners)
  Phase 4: Optional narrow refinement (1 round max)
  Phase 5: Composition candidates (balanced, bold-IFN, bold-color, edge)
  Phase 6: Composition critic pass
  Phase 7: Art director decision (near-edge but credible)
  Phase 7.5: Final gradient correction
  Phase 8: Quality gates (star quality, ringing, core burning)
  Phase 9: Final polish + save_memory
  --> save final XISF + JPG
  --> run memory optimizer (auto-promote patterns)
```

---

## Results

Successfully processed with zero target-specific code changes between runs:

- **M81/M82** (Bode's Galaxy + Cigar Galaxy) -- spiral galaxy, HaLRGB, 5 channels. IFN visible in galactic cirrus, Ha emission highlighting HII regions in spiral arms, dust lanes resolved with HDRMT inverted, core structure preserved with headroom stretch.
- **M97 Owl Nebula** -- planetary nebula, LRGB. Internal shell structure resolved via fine-scale LHE, faint outer halo revealed through shadow-lifting, OIII/Ha zoned color preserved. First-attempt result described as "stunning" with zero target tuning.
- **Abell 2151 Hercules Cluster** -- galaxy cluster, LRGB. Dozens of tiny diverse galaxies sharpened with conservative SXT overlap, star color diversity preserved, varied galaxy morphologies and colors visible.

---

## Requirements

- **PixInsight** (tested with 1.8.9+) with the following third-party modules installed:
  - BlurXTerminator (BXT)
  - NoiseXTerminator (NXT)
  - StarXTerminator (SXT)
- **Node.js** v22+ (tested with v22.13.1)
- **Claude Code** with a **Max subscription** (the creative agent runs via `claude -p` subprocess -- no API key needed)
- **Calibrated master frames** -- WBPP-stacked, debayered XISF files (R, G, B, optionally L and Ha)
- **macOS** (tested on Darwin/arm64; Linux may work but is untested)
- At least 20 GB free disk space (checked at startup)

---

## Quick Start

```bash
# 1. Build the MCP server
export PATH="/Users/aescaffre/.local/node-v22.13.1-darwin-arm64/bin:$PATH"
cd /Users/aescaffre/pixinsight-mcp && npm run build

# 2. Start PixInsight and load the watcher script:
#    Script > Run Script... > pjsr/pixinsight-mcp-watcher.js

# 3. Verify bridge connectivity
node scripts/ping-watcher.mjs

# 4. Create a config JSON (see Config Format below) and run the GIGA pipeline
node agents/llm/giga-run.mjs --config /path/to/config.json

# 5. Optional: add a processing intent to guide aesthetic decisions
node agents/llm/giga-run.mjs --config /path/to/config.json --intent "push IFN hard, vivid galaxy colors"

# 6. Dry run (classification + brief only, no processing)
node agents/llm/giga-run.mjs --config /path/to/config.json --dry-run
```

The legacy deterministic pipeline (no LLM) is still available:
```bash
node scripts/run-pipeline.mjs --config /path/to/config.json
node scripts/run-pipeline.mjs --config /path/to/config.json --restart-from stretch
```

---

## Config Format

```json
{
  "files": {
    "targetName": "M81",
    "R": "/absolute/path/to/masterLight_R.xisf",
    "G": "/absolute/path/to/masterLight_G.xisf",
    "B": "/absolute/path/to/masterLight_B.xisf",
    "L": "/absolute/path/to/masterLight_L.xisf",
    "Ha": "/absolute/path/to/masterLight_Ha.xisf",
    "outputDir": "/absolute/path/to/output/",
    "channelSwap": ""
  },
  "aestheticPreferences": {
    "noiseLevel": "very_clean",
    "glow": "moderate",
    "starPresence": "prominent"
  }
}
```

**Important notes**:
- All file paths **must be absolute**. The pipeline does not resolve relative paths or prepend any base directory.
- Leave channel keys as empty strings (not omitted) if that filter is not available.
- Use `channelSwap` (e.g., `"RB,GB"` for BRV filter wheel correction) if your filter labels are incorrect.
- The workflow (LRGB, HaLRGB, HaRGB, RGB) is auto-detected from which channels have file paths.

---

## Project Structure

```
agents/
  llm/
    giga-run.mjs               -- Main entry point (GIGA pipeline runner)
    deterministic-prep.mjs      -- Phase 1: scripted linear processing with caching
    engine-max.mjs              -- Claude Max subprocess engine (claude -p)
    tools.mjs                   -- 53 MCP tool definitions and handlers
    vision.mjs                  -- Diagnostic view generation and image messaging
    mcp-agent-tools.mjs         -- MCP server for agent tool access
    prompts/
      giga-orchestrator.mjs     -- System prompt builder (generic, trait-driven)
  ops/
    bridge.mjs                  -- File-based IPC with PixInsight
    quality-gates.mjs           -- Star quality, ringing, core burning checks (PJSR)
    stats.mjs                   -- Image statistics and uniformity measurement
    stretch.mjs                 -- Seti statistical stretch (ported from PixInsight)
    gradient.mjs                -- Gradient correction (ABE, GC, per-channel)
    masks.mjs                   -- Luminance mask creation and management
    preview.mjs                 -- JPEG preview export
    image-mgmt.mjs              -- Clone, close, purge operations
    checkpoint.mjs              -- Checkpoint save/restore
    index.mjs                   -- Ops module aggregator
  memory/
    hierarchical-memory.mjs     -- 5-level memory store with auto-promotion optimizer
  classifier.mjs                -- Target classification and processing brief generation
  target-taxonomy.json          -- 12 categories with 7 trait dimensions each
  scoring.mjs                   -- 8-dimension scoring model with per-type weight profiles
  artifact-store.mjs            -- Per-run artifact management
  processing-profiles.json      -- Default processing parameters per target type
scripts/
  run-pipeline.mjs              -- Legacy deterministic pipeline (~2000 lines)
  ping-watcher.mjs              -- Bridge connectivity test
pjsr/
  pixinsight-mcp-watcher.js     -- PixInsight-side watcher (ECMAScript 5)
src/
  -- MCP server TypeScript source (for IDE/tool integration)
editor/
  server.mjs                    -- Web UI backend for config editing
  index.html                    -- Web UI frontend
  default-config.json           -- Default pipeline configuration
.claude/skills/
  pixinsight-pipeline/          -- Processing knowledge base for Claude Code sessions
    SKILL.md                    -- Pipeline overview and parameter tuning guide
    reference/                  -- PJSR processes, gotchas, tools, stretch formulas
```

---

## Processing Techniques

| Technique | Origin | Implementation |
|-----------|--------|----------------|
| Seti Statistical Stretch | [Seti Astro](https://www.setiastro.com) v2.3 (Franklin Marek) | Ported to Node.js: blackpoint rescale, MTF, normalize, Hermite HDR compress |
| GHS Stretch | [GHS](https://ghsastro.co.uk) (Cranfield & Shelley) | PixelMath piecewise fallback (no .dylib) |
| Screen Blend Stars | Standard technique | `~(~$T * ~(strength * stars))` -- halo-free recombination |
| Ha Injection | Community techniques | R-channel injection + luminance boost with brightness limiting |
| Inverted HDRMT | PixInsight community | Enhances local detail instead of compressing brights |
| Intelligent Gradient Removal | Original | ABE vs GC comparison via corner uniformity metric, per-channel mode |
| Hierarchical Memory | Original | 5-level knowledge store with auto-promotion across targets |
| Bracket-Then-Critic | Adapted from photography bracketing | 4 candidates (weak/target/edge/overdone) per creative branch |

---

## Astro ARO -- Remote Observatory

This project is developed by a member of [**Astro ARO**](https://astrolentejo.fr), a remote observatory located in the **Alentejo Dark Sky Reserve** (Portugal) -- one of Europe's darkest sites at **Bortle 2-3**.

Seats are regularly available for remote observation. Visit the [Teams section](https://astrolentejo.fr/teams) for images from the observatory.

---

## License

MIT
