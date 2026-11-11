# PixInsight MCP -- Autonomous Deep Sky Astrophotography Processing

An autonomous deep sky astrophotography processing pipeline that uses Claude (via Claude Code / Max subscription) to drive PixInsight through file-based IPC. The LLM acts as a processing director -- making creative decisions about stretching, detail enhancement, color saturation, and star management -- while code-enforced quality gates prevent common processing failures like ringing artifacts, core burning, and star destruction. Since v0.5.0 every gate measurement runs natively in **Rust** (`native/pixmetrics`, macOS and Windows): a full gate battery takes seconds instead of minutes, and results are identical to the PixInsight implementations.

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

Mono narrowband masters (S/H/O or H/O) are detected automatically and routed through a dedicated SHO/HOO prep and palette workflow (see "Narrowband (SHO / HOO)" below).

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
                        |  processing-profiles |
                        +---------+-----------+
                                  |
               +------------------+------------------+
               |                                     |
    +----------v-----------+           +-------------v-----------+
    | Phase 1: Deterministic|           | Phase 2+: Creative Agents|
    | Prep (no LLM)         |           | (Claude Max subprocesses)|
    | deterministic-prep.mjs|           | giga-run.mjs             |
    | narrowband-prep.mjs   |           |                          |
    |                       |           | gradient sub-agent       |
    | open, align, combine, |           | giga orchestrator        |
    | GC, BN, BXT, SPCC,   |           |   (85-96 MCP tools)      |
    | NXT, SXT, stretch     |           | optional core specialist |
    +-----------+-----------+           | aesthetic critic + gates |
                |                       +-------------+-------------+
                |                                     |
                +----> PixInsight (PJSR, V8) <--------+
                       via file-based bridge IPC
                       (~/.pixinsight-mcp/bridge/)
                                  |
                       view exported once per image state (XISF)
                                  |
                        +---------v-----------+
                        | pixmetrics (Rust)    |
                        | XISF reader + all    |
                        | gate measurements    |
                        | (PJSR fallback)      |
                        +---------------------+
```

### Two-Phase Design

**Phase 1: Deterministic Prep** (`agents/llm/deterministic-prep.mjs`) -- Zero LLM involvement. Opens calibrated masters, aligns channels via StarAlignment, combines RGB, runs the canonical linear processing sequence (gradient correction, BlurXTerminator correction, astrometric solution copy, SPCC color calibration, background neutralization, NoiseXTerminator, BlurXTerminator sharpening, StarXTerminator star extraction, Seti statistical stretch). Repeats for L and Ha channels if present. Every applied step is recorded in the prep result, and prep warns if the extracted star layer is not linear. This phase is deterministic and **cached**: a SHA-256 fingerprint of the script content plus input file headers (size + mtime + first/last 64KB) means identical inputs skip reprocessing entirely. When the config lists mono S/H/O masters and no R/G/B, prep is routed to `agents/llm/narrowband-prep.mjs` instead.

**Phase 2+: Creative Agents** (`agents/llm/giga-run.mjs`) -- Claude agents spawned as `claude -p` subprocesses (running on a Max subscription, zero API cost). A dedicated **gradient sub-agent** first flattens the background on the linear data; the **giga orchestrator** then receives the prepped working assets and a system prompt dynamically built from the target's classification and processing profile, with access to a fixed set of MCP tools that map to PixInsight operations (96 at most; data-aware, see The Tool Inventory). An optional **core specialist** post-pass (`--core-specialist`) and an **aesthetic critic** complete the roster. Each agent has an explicit model/effort/turn budget (`agents/llm/agent-models.mjs`).

### File-Based Bridge IPC

Node.js communicates with PixInsight's PJSR scripting engine through a file-based bridge at `~/.pixinsight-mcp/bridge/`. A watcher script (`pjsr/pixinsight-mcp-watcher.js`) runs inside PixInsight, polls for JSON command files, executes them via the PJSR engine, and writes result files. This is the only way to programmatically control PixInsight -- there is no socket or HTTP API. A round trip costs about **0.1 s** (v0.5.0: the watcher re-checks for commands every ~100 ms of wall time and the Node side polls every 100 ms; before, a bare `1+1` took 3.5 s because the idle loop was 25 x (sleep + UI events) and UI events are slow with large images open).

**The watcher runs on PixInsight's V8 runtime** (`#engine v8` on its first line, PixInsight >= 1.9.5). Without that directive a script runs on the legacy SpiderMonkey runtime, whose garbage collector aborted PixInsight 1.9.5 on Apple Silicon with large images open (explicit `gc()` or automatic collections alike). The V8 watcher ships a small compatibility layer for command snippets written in the legacy style: `processEvents`/`msleep`/`sleep` globals, `gc()` as a no-op, and a rewrite of `Process.prototype.CONST` to `Process.CONST` before eval. It also includes the V8 ImageSolver library (`MCP_WITH_SOLVER`) so prep can plate-solve when the masters carry no astrometric solution. The SpiderMonkey version is kept as `pjsr/pixinsight-mcp-watcher-sm-legacy.js` for reference only.

### Native Metrics in Rust (pixmetrics)

Every measurement behind the quality gates, stage checkpoints and per-step metrics runs in **`native/pixmetrics`**, a Rust binary, instead of PixInsight's JavaScript engine. Those measurements used to dominate run time: on M74 (3000x2000) one `run_quality_gates` battery took ~350 s and checks were 61% of a 2 h 50 min run.

**How it works**

1. `agents/ops/native-metrics.mjs` asks PixInsight for a cheap fingerprint of the view (dimensions, channel means, a 64-point sample grid). Only when the image changed does PixInsight write it as an uncompressed Float32 XISF (~0.3 s).
2. The binary reads it (~70 ms for 3000x2000x3) and computes the requested metrics **in parallel**, returning the same JSON keys as the JavaScript function it replaces.
3. **Batching**: a gate battery is wrapped in `nativeBatch()`: one export, one binary call for every metric the same battery asked for last time (self-learning list, so nothing has to be kept in sync with the gate code).
4. **Fallback**: every `measureX()` keeps its PixInsight implementation as `measureXPjsr()`. If the binary is missing, fails, or `PIXINSIGHT_MCP_NATIVE=0` is set, the old path runs unchanged.

**What it contains**: an XISF 1.0 reader (attachment / inline / embedded blocks; planar or interleaved; UInt8/16/32, Float32/64; zlib, LZ4, LZ4-HC and Zstandard compression, each with or without byte shuffling -- all 27 variants PixInsight writes are tested), PNG and JPEG input (for user reference images), and 42 metrics: burn scan, core contrast/texture/troughs/spectrum/amplification, nucleus colour, zone structure, arm/gap depth, envelope sectors and profiles, outer arms, faint disc, signal inventory, scale bands, disc mottle, background noise/floor, subject detail, dust coverage, subject ROI, chroma noise, saturation, ringing, shell/highlight texture, colour gradient, palette balance/purity, outer-zone colour, Ha knots, star quality/field/layer integrity, bright chroma, PSF field, tonal presence and the full reference comparison (palette, Lab EMD, grain, MS-SSIM).

**Identical results.** `scripts/native-parity.mjs` runs every metric both ways on images opened in PixInsight. On M74 every metric agrees to better than 1e-4 relative, most to 7-8 significant digits. Three PixInsight conventions had to be measured to get there (documented in `.claude/skills/pixinsight-pipeline/reference/pjsr-gotchas.md`):
- `Convolution` (Gaussian) truncates its kernel at 1% of the peak (radius 3.035 sigma) and reflects at the borders.
- `Image.median()` pools all channels and averages the two middle values; `MAD()` is unscaled.
- `Resample` (Mitchell-Netravali, default smoothness 1.5) is separable, maps output pixel t to source t x scale, with a kernel radius of floor(scale) + 1.5 pixels.

**Speed** (M74 3000x2000, same metrics):

| | PixInsight JS | Rust |
|---|---|---|
| 33 gate metrics, one by one | 290 s | 12 s |
| `disc_mottle` | 38 s | 0.5 s |
| `core_texture` | 36 s | 0.5 s |
| `compare_reference` (MS-SSIM), full image | > 27 min | 0.2 s |
| full `run_quality_gates` battery in a run | ~350 s | ~6 s |
| main agent, whole M74 run | 144 min (v11) | 12-24 min (v12-v16) |

**Platforms**: pure Rust with no C dependencies (miniz_oxide, lz4_flex, ruzstd, png, jpeg-decoder), so it builds natively on macOS (arm64, x86_64), Windows (x86_64) and Linux, and cross-compiles to Windows from macOS. Prebuilt binaries are attached to each GitHub release; CI (`.github/workflows/pixmetrics.yml`) builds and tests all four targets.

### The Claude Max Engine

The creative agents run via `claude -p` subprocess (`agents/llm/engine-max.mjs`). No API key is needed -- it uses the user's Claude Max subscription through Claude Code. The system prompt is passed via `--append-system-prompt-file` (falls back to `--append-system-prompt` on older CLIs), the initial message contains prep results and diagnostic views, and custom MCP tools are provided via an MCP server configuration (`agents/llm/mcp-agent-tools.mjs`). Claude Code handles the tool loop automatically.

- **Tool containment**: every agent is launched with `--disallowedTools Bash,Edit,Write,MultiEdit,NotebookEdit,Agent,Task,WebFetch,WebSearch,TodoWrite,KillShell,BashOutput` -- it can only call the pipeline's MCP tools (plus Read). A processing agent can no longer modify pipeline source, user memory or run ad-hoc PJSR from a shell.
- **Explicit models**: `agents/llm/agent-models.mjs` is the single table (giga_orchestrator, gradient_agent, core_specialist, aesthetic_critic) resolved as CLI `--model-<alias>` / `--effort-<alias>` > `config.models.<agent>` > defaults; `--fallback-model` is honoured and the run log warns when a fallback actually fired. `PIX_CLAUDE_BIN` overrides the claude binary.
- **Sessions**: each agent is pinned to a `--session-id`, recorded under `<run>/agents/<agent>.json`, so a crashed run can be re-attached with `claude --resume` (see "Robustness and Operations").

---

## The Tool Inventory

Up to 96 tools organized into categories (`agents/llm/tools.mjs`, `TOOL_CATALOG`). Since v0.5.0 the set is **data-aware**: palette-only tools (`sho_*`, palette balance, synthetic luminance) exist only when the data has SII or OIII, and Ha-specific ones only when there is Ha -- an LRGB run gets 85 tools, HaLRGB 88, SHO 96. There is **no free-form PixelMath** for the creative agents: they use a fixed toolset (`adjust_levels`, `blend_images`, `zone_mask`, `mask_ops`, `lift_outer_disc`, `soft_glow`, `restrain_red_hue`, ...), as world-class processors do. A selection:

| Category | Tools | Purpose |
|----------|-------|---------|
| measurement | get_image_stats, measure_uniformity, measure_color_gradient, measure_chroma_noise, measure_psf_field, measure_dust_coverage, check_noise | Pixel statistics, uniformity, color casts/banding, chroma noise, field-dependent PSF |
| preview | save_and_show_preview | Export diagnostic JPEGs (1:1 crops) for visual inspection |
| image_mgmt | clone_image, restore_from_clone, close_image, purge_undo, list_open_images | State management and memory control (new windows refused above 12 open) |
| gradient | run_gradient_correction, run_abe, run_per_channel_abe, run_scnr | Background flattening (masked per-channel ABE) and green cast removal |
| denoise / sharpen / stretch | run_nxt, run_bxt, seti_stretch, auto_stretch, stretch_stars | NoiseXTerminator, BlurXTerminator (correct + sharpen), statistical and star stretch |
| masks | create_luminance_mask, zone_mask, create_zone_masks, mask_ops, apply_mask, remove_mask, close_mask | Mask creation, inventory-driven geometric zones, mask arithmetic (range windows < 0.3 widened: no threshold masks) |
| detail | multi_scale_enhance, run_hdrmt, lift_outer_disc, lift_dust, inject_l_ifn | LocalHistogramEqualization + HDRMultiscaleTransform, self-weighted outer-disc lift |
| curves | run_curves, adjust_levels, blend_images, soft_glow, restrain_red_hue | Tonal and colour adjustments through fixed tools (no free PixelMath); saturation curves are guarded (max 3 raising S curves per view, low-end gain capped at x2.5) |
| lrgb | lrgb_combine, inject_luminance | LinearFit LRGB combination, PixelMath L injection for large median mismatch |
| ha_injection | ha_inject_red, ha_inject_luminance | Narrowband Ha blending into RGB (soft-clamp prevents burning) |
| narrowband | sho_combine, sho_hue_shift, measure_palette_balance, lift_faint_halo, body_edge_contrast, chroma_smooth, reload_narrowband_channel, lift_dust, inject_l_ifn, ... | SHO/HOO palettes, faint-halo and dust lifting, pseudo-OIII extraction |
| stars | star_protected_blend, check_star_layer_integrity | Luminance-protected star reintegration, star-layer precondition |
| quality_gate | scan_burnt_regions, check_star_quality, check_ringing, check_tonal_presence, check_background_floor, compare_to_reference, run_quality_gates | The gate battery, runnable read-only at any time |
| memory | recall_memory, save_memory | Hierarchical knowledge store access |
| scoring | compute_scores, submit_scores | Multi-dimensional image scoring (8 dimensions) |
| control | save_variant, list_variants, load_variant, begin_composition, finish | Candidate management and workflow control |

---

## Key Innovations

### Quality Gates as Code-Enforced Constraints

Quality gates (`agents/ops/quality-gates.mjs`, `agents/ops/subject-metrics.mjs`) measure the actual pixels -- natively in Rust, with the PixInsight implementation as fallback -- they are not prompt suggestions that the agent might ignore. The `finish` tool runs all gates automatically; only a result of "Finished (quality gates PASSED)" moves the state machine to finalize. `run_quality_gates` runs the same battery read-only at any time (results are persisted into the variant's metadata).

**One gate contract.** Every threshold lives in `agents/llm/gate-contract.mjs` (`BURN_CLIP` 0.95, `BRIGHT_BLOCK_LEVEL` 0.80, `NOISE_BG_HARD` 0.022, `SUBJECT_MIN` 0.25, `CONTRAST_GATE` 3.0 (2.0 for outer-halo targets), `TONAL` 3.0 (2.5 for small subjects), `STAR_CONTRAST` 4/3/2 by star prominence, `FWHM_HARD` 12, ...). `buildGateTable()` renders the same rows into the agent's system prompt, so the agent sees exactly what the finish handler will enforce.

**Per-profile calibrated overrides.** `agents/processing-profiles.json` may override a listed subset of thresholds per target class (`OVERRIDE_KEYS`: `noise.bg_hard`, `core_burn.*`, `background.min_level`, `stars.min_density_per_mpx`, `reference.*`, `burn.max_clip_blocks`, ...). An override is honoured **only** when its block carries a `_calibration` string naming the approved image it was back-tested on; uncalibrated overrides are ignored with a warning on stderr. Calibrated today: background floor 0.045 (galaxies), 0.032 (PNe), 0.050 (emission), 0.062 (reflection); PNe `core_burn.rel_contrast` 0.15.

**Approved-image registry and back-test harness.** `agents/calibration/approved-images.json` registers user-approved, rejected and superseded final images per class (PACMAN LIFT5, NGC 7023 iter03 / best-of-both, NGC 3628 v3, M97, NGC 4490 ...). Approved images are floors: a gate that rejects one is wrong by definition. `scripts/backtest-gates.mjs [--class X] [--id a,b] [--only gate,gate] [--critic] [--dry]` opens each registered image in PixInsight, runs the full battery and writes `agents/calibration/last-backtest.json`. Exit codes: `1` an approved image hit a blocking gate, `2` a rejected image passed every blocking gate, `3` PixInsight crashed mid-run, `0` otherwise. To add an approved image, run `giga-run ... --approve [<runId>]` on a finished run: the final XISF is copied to `~/.pixinsight-mcp/approved/<class>/` and an entry is appended (so pruning old runs never rots the registry).

The battery (blocking unless noted):

- **Burn**: a single PJSR scan feeds both the zero-tolerance clip gate (no 100×100 block with >3% pixels above 0.95) and the extended bright-block gate (0.80+, per-profile block limit). Every brightness-modifying tool also reports inline burn warnings.
- **Core contrast**: catches perceptual core burn (white, desaturated, flat cores); becomes advisory when the core is demonstrably structured.
- **Stars**: brightness contrast vs. background per prominence profile, FWHM (hard 12 px, galaxies exempt), color diversity; `star_retention` (stars per Mpx, advisory until calibrated).
- **Subject metrics**: brightness >= 0.25, contrast ratio, detail gain against the prep baseline (noise-floor corrected), tonal presence (ROI-based subject/background separation with star rejection).
- **Background floor** (`check_background_floor`): sky level and fraction of near-black 64 px blocks, blocking where `background.min_level` is calibrated. Prevents the crushed-sky look that used to pass.
- **Noise / dust**: dark-sky grain <= 0.022; IFN/dust gate for reflection nebulae (greyed, crushed or warm dust).
- **Saturation**: per-class P90 ceiling from the profile `look` block.
- **L usage**: when an L master exists, clone-chain provenance must prove it was really incorporated.
- **Palette balance** (SHO/HOO), **highlight texture** (emission), **ringing**, **over-denoising** (NXT above 0.25 flagged).
- **Reference comparison** (`compare_to_reference`): palette L1, chroma-only Lab EMD and background-cast delta against a reference image -- `files.referencePath`, or auto-picked: the latest approved registry image for the same target.
- **Galaxy colour and zones** (v0.4-v0.5, calibrated on the user's reference JPEGs and approved runs): `outer_zone` (outer disc not brown, outer arms present, outer blues not over-saturated, inner disc not dim), `palette_purity` (no lilac/teal disc on data without Ha), `core_amp` (no cooked bulge), `nucleus_colour` (not white, not orange), `core_structure`, `arm_gap_depth`, `edge_softness`, `envelope_clip`.
- **Per-run reference targets**: `files.referenceGates` makes the reference comparison blocking (palette L1, local-contrast ratio min/max, grain, dark-lane depth, background cast); individual keys can be listed in `advisory` to warn only.
- **Aesthetic critic**: advisory everywhere until >= 8 user-rated pairs agree with the judge for that class (`agents/llm/rate-critique.mjs` records ratings and reports agreement).

Non-safety gates relax to warnings only when the agent has <= 10 turns left. New gates ship advisory and are promoted only after the back-test harness passes.

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

The classifier (`agents/classifier.mjs`) maps target names to categories using a known-object lookup (100+ objects) with heuristic fallbacks, then generates a processing brief including classification, workflow detection (LRGB, HaLRGB, HaRGB, RGB, SHO, HOO), aesthetic intent, field characteristics and the reference image. **Zero hardcoded target text exists in the prompt** -- the same generic orchestrator prompt handles M81 and the Owl Nebula because all behavior is driven by taxonomy traits and the per-class profile.

**Processing profiles** (`agents/processing-profiles.json`) carry per-class defaults and gate blocks: `gradient`, `noise`, `reference`, `detail`, `core_burn`, `look`, `background`, `stretch`, `tools` (BXT correct_only / sharpen_nonstellar, read by prep), `stars`. A `narrowband_palette` profile is deep-merged over the base class for SHO/HOO runs.

### Hierarchical Memory with Auto-Promotion

Five levels of processing knowledge (`agents/memory/hierarchical-memory.mjs`), stored as JSON at `~/.pixinsight-mcp/agent-memory/hierarchical.json`:

1. **universal** -- applies to all targets (e.g., "NXT denoise > 0.25 destroys detail")
2. **trait** -- keyed by trait name (e.g., "core_halo" targets need HDRMT maskClipLow >= 0.35)
3. **type** -- keyed by classification (e.g., galaxy_spiral Seti stretch target = 0.12)
4. **data_class** -- keyed by workflow + subject scale (e.g., HaLRGB_large)
5. **target** -- keyed by target name (e.g., M81 specific Ha injection strength)

The `recallForBrief()` function gathers all relevant entries from all levels, matching on classification, all trait keys (structuralZones, signalType, colorZonation, etc.), data class fingerprint, and target name. The agent receives a formatted summary at the start of every run; broadband-era rules are excluded on narrowband runs.

The memory optimizer (`optimizeMemory()`) runs after every processing session and automatically promotes entries up the hierarchy: the same param+value winning in 3+ targets of a type is promoted to type level, confirmation across 2+ types sharing a trait promotes to trait level, and a type-level entry confirmed across all data classes becomes universal.

This means knowledge from processing M81 (galaxy_spiral with core_arms_ifn and high dynamic range) can inform processing of the Veil Nebula (supernova_remnant), because they share processing traits like bright cores and similar HDRMT masking requirements. Cross-run learning about winning parameters lives in the promotion ledger (`agents/ledger.mjs`).

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

After generation, a critic pass evaluates candidates per branch, identifies overdone boundaries, selects winners, and may trigger one narrow refinement round. The agent calls `begin_composition`; composition candidates (balanced, bold-IFN, bold-color, edge) combine branch winners, followed by a composition critic and art director decision targeting "near-edge but credible." A state machine (`agents/llm/state-machine.mjs`) restricts which tools are available in each phase, and a repair engine (`agents/llm/repair-policies.mjs`) tracks what modified each view, applies per-gate repair policies and enforces forbidden tools on a view in any state.

### Narrowband (SHO / HOO)

Mono S/H/O (or H/O) masters are detected from the config and routed to `agents/llm/narrowband-prep.mjs`: no SPCC or background neutralization, per-channel linear BXT/NXT/SXT, gradient correction only when the border spread warrants it, **unlinked** per-channel stretch, linear star layers saved to disk, and a hash-keyed cache. `agents/ops/sho-palette.mjs` provides the palette operations (sho / foraxx / hue_screen / hoo combination, hue shift, palette balance measurement, background neutralization, faint-halo lift, body-edge contrast, chroma smoothing, star-residual repair) exposed as agent tools. The orchestrator prompt gains a narrowband mode with a palette branch; branch completeness requires at least two palette variants.

### Prep Caching

Deterministic prep computes a cache key from a SHA-256 hash of the prep script content plus fingerprints of each input master file (file size + mtime + first/last 64KB content hash, `agents/llm/prep-cache-util.mjs`). Cache hits load pre-computed XISF files directly into PixInsight, skipping 10-15 minutes of linear processing. Cache is stored at `~/.pixinsight-mcp/prep-cache/` (capped to the 4 newest entries; the gradient sub-agent's solutions are cached the same way in `~/.pixinsight-mcp/gradient-cache/`).

### Scoring Model

An 8-dimension scoring model (`agents/scoring.mjs`) -- detail_credibility, background_quality, color_naturalness, star_integrity, tonal_balance, subject_separation, artifact_penalty, aesthetic_coherence -- each scored 0-100, with target-type-specific weight profiles (galaxy_spiral weights detail_credibility highest; star_cluster_open weights star_integrity highest).

---

## Robustness and Operations

PixInsight 1.9.5 can still abort under memory pressure, and its crash reports carry no symbols. The pipeline is built to survive that:

- **Crash forensics**: the watcher writes `~/.pixinsight-mcp/bridge/executing.json` (the command it is about to run) from inside PixInsight; the Node bridge writes `last-command.json` plus a rolling `command-log.jsonl` (last 30 commands) and deletes stale command files so a dead session's command is never replayed by the next watcher. SPCC captures the PixInsight console to `/tmp/spcc-prep-console.log` and prints the tail on failure. When the PixInsight process disappears, the MCP server writes `<run>/CRASH.json` (agent, tool, trace seq) and refuses every further tool call with a FATAL text; the parent polls `CRASH.json` and terminates the CLI.
- **Session resume**: the state machine, view provenance, star-integrity flags and trace sequence are snapshotted to `<run>/agent-state-<agent>.json`. After restarting PixInsight, `giga-run --config ... --resume-agent <runId>` re-attaches the same Claude session (`claude --resume`) with `PIX_RESUME=1` restoring the MCP state; the agent reloads its best saved variant and continues.
- **Relaunch script**: `scripts/pi-relaunch.sh [--kill]` starts PixInsight headlessly with the RC-Astro suite module (`-m`) and the watcher (`-r`), clears stale bridge files and waits (up to 180 s) for `watcher-state.json`. With `--kill` it terminates a stalled instance and removes its orphan swap files first.
- **Safer window handling**: `close_image` / `close_mask` detach a mask from every window before closing (force-closing an active mask crashed PI), `ctx.safeClose()` purges, drains events and settles before closing, no explicit `gc()` is ever called from Node, and a swap guard purges undo history periodically and whenever free disk is low.
- **Disk hygiene** (`agents/llm/disk-hygiene.mjs`): pre-flight removes orphan PixInsight swap files (created before the live PI process started -- never newer ones), aborts under 10 GB free and warns under 20 GB; runs beyond the newest 3 (`--keep-runs N`) are deleted by mtime unless they are younger than 24 h, hold a `CRASH.json`, or are referenced by the ledger champions or the approved-image registry; prep and gradient caches are capped at 4 entries. `scripts/clean-swap.mjs [--dry-run]` runs the swap cleanup standalone.
- **Run artifacts and budgets** (`agents/llm/run-artifacts.mjs`): `run-summary.json`, `trace.jsonl`, a Mermaid diagram and a trace summary are written on every exit path (finished, recovered, crashed, timed_out, max_turns). Every agent has a turn budget: an MCP-side call counter for the gradient and core agents, maxTurns ×1.2 for the giga agent with the CLI `--max-turns` as a 1.5× outer net; blocked calls consume budget.

---

## Processing Flow

```
DETERMINISTIC PREP (Phase 1, ~10-15 min first run, cached thereafter):
  orphan swap cleanup + disk space check (>= 20 GB recommended, < 10 GB aborts)
  --> cache key computation (script hash + input fingerprints)
  --> [cache hit: load XISF files, skip to Phase 2]
  --> close all open images
  --> open masters (with channel swap if configured)
  --> align to R via StarAlignment (forced with files.forceAlign), combine RGB
  --> gradient correction (GC or ABE), BXT correct_only, astrometric solution copied back
      (V8 ImageSolver fallback if the masters carry none)
  --> SPCC (console captured, one retry after regenerating the solution), background neutralization
  --> optional border auto-crop (files.autoCropBorder)
  --> NXT linear, BXT sharpen (profile tools.BXT), SXT star extraction (linear, stars=true only)
  --> Seti statistical stretch (profile stretch.target_median), NXT post-stretch
  --> [repeat for L and Ha if present], baseline texture/detail metrics recorded, save to cache

GRADIENT SUB-AGENT (linear data, cached solutions):
  ABE / GC bracketing until the color-gradient metric is flat; prep continues after it

CREATIVE AGENT (Phase 2+, ~30-60 min via Claude Max):
  Phase 0: recall_memory, inspect prep diagnostics, GATE TABLE from gate-contract
  Phase 2: Branch generation (4 branches x 4 candidates): A luminance detail (LHE, HDRMT, masks),
           B faint structure / IFN (shadow-lifting curves), C color / Ha injection, D stars (protected blend)
  Phase 3-4: Branch critic pass (score, compare, select winners), optional narrow refinement (1 round)
  Phase 5-7: begin_composition -> candidates (balanced, bold-IFN, bold-color, edge) -> composition critic
             -> art director decision (near-edge but credible)
  Phase 8: finish -> full quality-gate battery; REJECTED -> repair policies, try again
  Phase 9: Final polish + save_memory
  --> save final XISF + JPG, run-summary.json, trace artifacts; optional core-specialist post-pass
  --> run memory optimizer (auto-promote patterns), update ledger
```

---

## Results

Successfully processed with zero target-specific code changes between runs:

- **M81/M82** (Bode's Galaxy + Cigar Galaxy) -- spiral galaxy, HaLRGB, 5 channels. IFN visible in galactic cirrus, Ha emission highlighting HII regions in spiral arms, dust lanes resolved with HDRMT inverted, core structure preserved with headroom stretch.
- **M97 Owl Nebula** -- planetary nebula, LRGB. Internal shell structure resolved via fine-scale LHE, faint outer halo revealed through shadow-lifting, OIII/Ha zoned color preserved. First-attempt result described as "stunning" with zero target tuning.
- **Abell 2151 Hercules Cluster** -- galaxy cluster, LRGB. Dozens of tiny diverse galaxies sharpened with conservative SXT overlap, star color diversity preserved, varied galaxy morphologies and colors visible.
- **NGC 281 Pacman Nebula** -- SHO narrowband, starless. Hubble-palette gold/blue with revealed faint outer nebulosity. Together with NGC 7023, NGC 3628, M97 and NGC 4490 it anchors the approved-image registry used for gate calibration.

---

## Requirements

- **PixInsight 1.9.5+** (the watcher uses the V8 scripting runtime; earlier builds still run the legacy watcher but crash on Apple Silicon under GC) with the following third-party modules installed:
  - BlurXTerminator (BXT)
  - NoiseXTerminator (NXT)
  - StarXTerminator (SXT)
- **Node.js** v22+ (tested with v22.13.1)
- **pixmetrics** (recommended): the prebuilt binary from the GitHub release for your platform, placed at `native/pixmetrics/bin/<platform>-<arch>/` (e.g. `darwin-arm64`, `win32-x64`) or pointed to with `PIXMETRICS_BIN`; or build it with a [Rust toolchain](https://rustup.rs) (`npm run build:native`). Without it every gate still runs, through PixInsight, much more slowly.
- **Claude Code** with a **Max subscription** (the creative agent runs via `claude -p` subprocess -- no API key needed)
- **Calibrated master frames** -- WBPP-stacked, debayered XISF files (R, G, B, optionally L and Ha; or mono S/H/O for narrowband)
- **macOS or Windows** (and likely Linux):
  - **macOS**: primary platform, tested on Darwin/arm64.
  - **Windows**: the Node <-> PixInsight bridge was validated by a community tester; v0.4.0 fixes the portability issues they reported (Windows paths embedded in PJSR, Unix-only `ps`/`grep`/`awk` memory checks, hard-coded PixInsight install paths in the watcher).
  - **Linux**: same code paths as macOS (process checks via `ps`/`pgrep`); expected to work, untested.
  - `scripts/pi-relaunch.sh` is a macOS convenience script; on Windows/Linux start PixInsight yourself and run the watcher (Quick Start steps 2 and 3a).
  - On Windows, `scripts/windows/mcp-pause.bat`, `mcp-resume.bat` and `mcp-stop.bat` pause, resume and stop the watcher with a double click (no Node needed). They create or delete the `pause` / `shutdown` sentinel files in `%USERPROFILE%\.pixinsight-mcp\bridge`; while paused, commands stay queued and PixInsight stays usable. Add `/q` to skip the final key press when calling them from another script.
- At least 20 GB free disk space (checked at startup; under 10 GB the run aborts)

---

## Quick Start

```bash
# 1. Build the MCP server (from the repository folder)
npm install && npm run build

# 1b. Native metrics: build (needs Rust) or drop the release binary in native/pixmetrics/bin/<platform>-<arch>/
npm run build:native && npm run test:native

# 2. Point the watcher at your PixInsight install (writes pjsr/mcp-solver-paths.jsh for the ImageSolver
#    plate-solve fallback). Auto-detects /Applications/PixInsight (macOS), C:/Program Files/PixInsight (Windows),
#    /opt/PixInsight (Linux); override with PIXINSIGHT_DIR=<folder> or --pi-dir <folder>. Re-run after moving PixInsight.
node scripts/setup-watcher.mjs

# 3. Start PixInsight with the watcher. Either:
#    a) Script > Run Script... > pjsr/pixinsight-mcp-watcher.js   (first line: #engine v8)
#    b) macOS: headless relaunch with RC-Astro modules + watcher (runs step 2, clears stale bridge files, waits for the watcher):
scripts/pi-relaunch.sh            # add --kill to terminate a stalled PixInsight first

# 4. Verify bridge connectivity
node scripts/ping-watcher.mjs

# 5. Create a config JSON (see Config Format below) and run the GIGA pipeline
node agents/llm/giga-run.mjs --config /path/to/config.json

# 6. Optional: add a processing intent to guide aesthetic decisions
node agents/llm/giga-run.mjs --config /path/to/config.json --intent "push IFN hard, vivid galaxy colors"

# 7. Dry run (classification + brief only, no processing)
node agents/llm/giga-run.mjs --config /path/to/config.json --dry-run

# 8. After a PixInsight crash: restart PixInsight + watcher, then re-attach the same Claude session
node agents/llm/giga-run.mjs --config /path/to/config.json --resume-agent <runId>

# 9. Promote a finished run's final image to the approved-image registry
node agents/llm/giga-run.mjs --config /path/to/config.json --approve <runId>

# 10. Back-test the gates against every registered image (PixInsight running); 11. unit tests (no PixInsight)
node scripts/backtest-gates.mjs            # exit 1 = approved image rejected, 2 = rejected image passed
npm test                                   # prompt goldens under test/golden, UPDATE_GOLDEN=1 to refresh

# 12. Native vs PixInsight parity on a real image (PixInsight running)
node scripts/native-parity.mjs --image /path/to/view.xisf --inv <run>/prep-metrics.json [--ref ref.xisf]
```

Other useful flags: `--base-run <runId>` (warm start from a previous run), `--core-specialist` / `--post-pass-only <runId>`, `--keep-runs N`, `--model-giga opus`, `--effort-gradient medium`.

The legacy deterministic pipeline (no LLM) is still available: `node scripts/run-pipeline.mjs --config /path/to/config.json [--restart-from stretch]`.

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
    "channelSwap": "",
    "pixelScale": 0.0,
    "forceAlign": false,
    "distortionCorrection": false,
    "autoCropBorder": false,
    "referencePath": ""
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
- Leave channel keys as empty strings (not omitted) if that filter is not available. For narrowband, use `S`, `H`/`Ha`, `O` keys with no R/G/B.
- Use `channelSwap` (e.g., `"RB,GB"` for BRV filter wheel correction) if your filter labels are incorrect.
- The workflow (LRGB, HaLRGB, HaRGB, RGB, SHO, HOO) is auto-detected from which channels have file paths.
- Optional keys, mainly for borrowed or foreign datasets:
  - `pixelScale` -- arcsec/px seed for the plate-solve fallback (the seed is bracketed ×2/×0.5/×4/×0.25 if it fails).
  - `forceAlign` -- register every channel to R even when dimensions already match (fixes channel fringing); empty bands left by registration are trimmed automatically.
  - `distortionCorrection` -- enable StarAlignment distortion correction for drizzled or distorted sets.
  - `autoCropBorder` -- trim noisy low-coverage borders after SPCC.
  - `referencePath` -- a reference image for `compare_to_reference` / the reference gate; when absent, the latest approved registry image for the same target is used.
- Optional `models.<agent>` block (`{ "model", "effort", "fallbackModel" }` for giga_orchestrator, gradient_agent, core_specialist, aesthetic_critic); CLI `--model-<alias>` / `--effort-<alias>` win over config. Example: `"giga_orchestrator": { "model": "claude-fable-5-2", "effort": "xhigh" }`.
- Optional `files.referenceGates` (with `referencePath`): `{ "blocking": true, "max_palette_l1": 0.30, "max_lc_ratio": 1.3, "max_grain_ratio": 1.3, "max_dark_depth_delta": 0.08, "advisory": ["max_lc_ratio"], "note": "..." }` -- the run must reach your reference rendering.
- Optional `files.profileOverrides`: per-run gate thresholds merged over the class profile; each block needs a `_calibration` note (e.g. `"background": { "min_level": 0.085, "_calibration": "..." }`).

---

## Project Structure

```
agents/
  llm/
    giga-run.mjs               -- Main entry point (GIGA pipeline runner, --resume-agent, --approve)
    deterministic-prep.mjs      -- Phase 1: scripted linear processing with caching (broadband)
    narrowband-prep.mjs         -- Phase 1 for mono S/H/O masters (unlinked stretch, NB cache)
    prep-cache-util.mjs         -- Shared cache key / fingerprint helpers
    engine-max.mjs              -- Claude Max subprocess engine (claude -p, tool containment, crash poll)
    agent-models.mjs            -- Explicit per-agent model / effort / fallback / maxTurns table
    agent-state.mjs             -- CRASH.json sentinel + per-agent MCP state snapshots
    resume-agent.mjs            -- Helpers for --resume-agent (session re-attach)
    run-artifacts.mjs           -- run-summary.json, trace artifacts, manifest finalize/fail
    disk-hygiene.mjs            -- Old-run cleanup, orphan swap cleanup, cache caps
    gate-contract.mjs           -- Single source of gate thresholds + calibrated override rules
    rate-critique.mjs           -- CLI: record user ratings vs critic verdicts, agreement report
    tools.mjs                   -- MCP tool definitions and handlers (TOOL_CATALOG, data-aware toolset)
    state-machine.mjs, repair-policies.mjs -- Phase-gated tool availability, repair engine
    mcp-agent-tools.mjs         -- MCP server for agent tool access (swap guard, crash FATAL)
    aesthetic-critic.mjs, composer.mjs, warmstart.mjs, vision.mjs, trace-*.mjs
    prompts/                    -- giga-orchestrator (generic, trait-driven, gate table), gradient-agent, core-specialist
  legacy/
    llm/                        -- ARCHIVED API-provider engine (engine.mjs, orchestrator.mjs, 8 old stage prompts); not used by giga-run
  ops/
    bridge.mjs                  -- File-based IPC with PixInsight (command log, crash detection, safeClose)
    native-metrics.mjs          -- Bridge to pixmetrics: view export + fingerprint cache, nativeOr fallback, nativeBatch
    quality-gates.mjs           -- Star field, ringing, burn, background floor, chroma noise checks (PJSR)
    subject-metrics.mjs         -- Subject brightness/contrast/detail, tonal presence, texture baselines
    stats.mjs                   -- Image statistics, uniformity and color-gradient measurement
    stretch.mjs                 -- Seti statistical stretch (ported from PixInsight)
    gradient.mjs                -- Gradient correction (ABE, GC, masked per-channel ABE; PI 1.9.5 enums)
    masks.mjs                   -- Luminance/zone masks, mask_ops, geometry-checked apply
    narrowband-enhance.mjs      -- Emission-object tools (pseudo-OIII, continuum subtraction, zones)
    sho-palette.mjs             -- SHO / HOO palette operations and palette metrics
    preview.mjs, image-mgmt.mjs, checkpoint.mjs, index.mjs
  memory/
    hierarchical-memory.mjs     -- 5-level memory store with auto-promotion optimizer
  calibration/
    approved-images.json        -- Approved / rejected / superseded image registry (gate floors)
    last-backtest.json          -- Output of the last scripts/backtest-gates.mjs run
  classifier.mjs                -- Target classification, profile merge, reference auto-pick
  target-taxonomy.json          -- 12 categories with 7 trait dimensions each
  processing-profiles.json      -- Per-class defaults + calibrated gate blocks (+ narrowband_palette)
  scoring.mjs, ledger.mjs, artifact-store.mjs -- Scoring model, promotion ledger, per-run artifacts
native/
  pixmetrics/                   -- Rust: XISF reader + 42 gate metrics (src/metrics/{colour,core,zones,texture,stars}.rs), README
scripts/
  backtest-gates.mjs            -- Gate back-test harness against the approved-image registry
  native-parity.mjs             -- PixInsight vs Rust parity check, metric by metric
  pi-relaunch.sh                -- Headless PixInsight relaunch with RC-Astro module + watcher
  clean-swap.mjs, ping-watcher.mjs, relevel-legacy-universal.mjs
  run-pipeline.mjs              -- Legacy deterministic pipeline (~2000 lines)
pjsr/
  pixinsight-mcp-watcher.js     -- PixInsight-side watcher (V8 runtime, #engine v8)
  pixinsight-mcp-watcher-sm-legacy.js -- Legacy SpiderMonkey watcher (reference only)
test/
  *.test.mjs                    -- node --test suite (gates, state machine, crash/resume, prompts, ...)
  golden/                       -- Prompt snapshot goldens
.github/workflows/pixmetrics.yml -- CI: build + test pixmetrics on macOS (arm64, x64), Windows, Linux
src/                            -- MCP server TypeScript source (for IDE/tool integration)
editor/                         -- Web UI (server.mjs, index.html, default-config.json)
AGENTIC_PIPELINE_PLAN_2026-10-28.md -- The improvement plan behind the current architecture (work items WI-01..27)
.claude/skills/
  pixinsight-pipeline/          -- Processing knowledge base for Claude Code sessions
    SKILL.md, reference/        -- Overview, tuning guide, PJSR processes/gotchas, XTerminators, GHS, narrowband SHO
```

---

## Processing Techniques

| Technique | Origin | Implementation |
|-----------|--------|----------------|
| Seti Statistical Stretch | [Seti Astro](https://www.setiastro.com) v2.3 (Franklin Marek) | Ported to Node.js: blackpoint rescale, MTF, normalize, Hermite HDR compress |
| GHS Stretch | [GHS](https://ghsastro.co.uk) (Cranfield & Shelley) | PixelMath piecewise fallback (no .dylib) |
| Protected Star Blend | Screen blend + luminance attenuation | Screen reintegration with attenuation in bright cores and soft roll-off; stars delivered linear |
| Ha Injection | Community techniques | R-channel injection + luminance boost with brightness limiting |
| Inverted HDRMT | PixInsight community | Enhances local detail instead of compressing brights (donut masks on edge-on / PNe) |
| Intelligent Gradient Removal | Original | Dedicated sub-agent, ABE vs GC via color-gradient metric, masked per-channel mode |
| Unlinked Narrowband Stretch | Standard SHO practice | Per-channel stretch before palette combination; palette ops on stretched starless channels |
| Hierarchical Memory | Original | 5-level knowledge store with auto-promotion across targets |
| Bracket-Then-Critic | Adapted from photography bracketing | 4 candidates (weak/target/edge/overdone) per creative branch |
| Calibrated Gates | Original | Thresholds back-tested against user-approved images before they may block |

---

## Astro ARO -- Remote Observatory

This project is developed by a member of [**Astro ARO**](https://astrolentejo.fr), a remote observatory located in the **Alentejo Dark Sky Reserve** (Portugal) -- one of Europe's darkest sites at **Bortle 2-3**.

Seats are regularly available for remote observation. Visit the [Teams section](https://astrolentejo.fr/teams) for images from the observatory.

---

## License

MIT

---

## Changelog

### v0.5.0 -- 2026-11-11 -- Native Rust metrics, 0.1 s bridge, colour gates

- **pixmetrics (Rust)**: XISF reader (all compression codecs and sample formats) and 42 gate metrics computed natively; Node bridge with per-view export cache, batching per gate battery and automatic PixInsight fallback. Parity with the PixInsight implementations verified metric by metric (< 1e-4). Gate battery ~350 s -> ~6 s. Builds on macOS and Windows (and Linux); prebuilt binaries attached to the release; CI for all platforms.
- **Bridge latency 3.5 s -> 0.1 s per PixInsight call** (watcher idle loop and Node polling are now wall-clock based). On M74 the main agent went from 144 min to 12-24 min.
- **Fixed toolset, no free PixelMath for the creative agents**; data-aware tool list (palette/Ha tools only when the data has them; LRGB 85 tools).
- **New gates, calibrated on the user's reference images and approved runs**: brown/faint/over-saturated outer disc and dim inner disc (`outer_zone`), lilac/teal disc without Ha (`palette_purity`), cooked bulge (`core_amp`), white or orange nucleus (`nucleus_colour`), relative core-structure floor; per-run blocking reference targets with per-key advisory; upper local-contrast bound against the reference.
- **Guards inside tools**: max 3 saturation-raising curves per view, saturation gain on near-grey pixels capped at x2.5 (it turned a faint outer disc brown), `restrain_red_hue` refused without Ha, narrow mask range windows widened, export falls back to the run folder if the output volume disappears.
- **Community contributions**: two watcher bugs reported and fixed by Andrei Gusan (@andreigusan, PR #2): `run_pixelmath` combining three mono images now creates an RGB image (`newImageColorSpace` auto-detected; it silently produced a mono clone), and `remove_gradient` now applies the ABE correction to the target (it defaulted to `Correction_None` and only produced a model window). Thanks also to 4ndr3c0ut0 (PR #1) and Andrei Gusan for the independent V8 watcher ports, which v0.3.0 had already covered (including the V8 ImageSolver plate-solving that PR #1 left as a TODO).
- Earlier unreleased work also included: per-step core metrics, unattended nudge loop, prep core guard and colour-preserving core, Ha re-registration on the prep cache path, advisory post-gradient tilt check, empty-footprint handling in all zone metrics.

### v0.4.0 -- 2026-11-08 -- Signal inventory, reference-calibrated texture gates, Windows portability

- See the GitHub release notes for v0.4.0.

### 2026-10-28 / 2026-10-30 -- V8 watcher, calibrated gates, crash resilience, narrowband

- **Watcher moved to PixInsight's V8 runtime** (`#engine v8`). The legacy SpiderMonkey runtime's GC aborted PixInsight 1.9.5 on Apple Silicon; the V8 watcher adds compatibility shims (`Process.prototype.CONST` rewrite, legacy globals) and the ImageSolver library. Legacy watcher kept as `pjsr/pixinsight-mcp-watcher-sm-legacy.js`. `scripts/pi-relaunch.sh` relaunches PixInsight headlessly with the RC-Astro module and the watcher.
- **Gate contract + calibration registry.** All finish thresholds live in `agents/llm/gate-contract.mjs`; per-profile overrides only count when back-tested (`_calibration`). `agents/calibration/approved-images.json` + `scripts/backtest-gates.mjs` (exit 1/2/3) back-test the battery against user-approved and rejected images; `giga-run --approve` registers new ones. The classifier auto-picks a same-target approved image as the reference.
- **New and reworked gates**: `background_floor` (blocking where calibrated), `star_retention` (advisory), single-pass burn scan feeding both clip and bright-block gates, structured-core advisory for core contrast, L-usage provenance, SHO/HOO palette balance, chroma-only reference metrics, `run_quality_gates` read-only battery, one GATE TABLE rendered into the prompt.
- **Advisory diagnostics**: star-field metrics (FWHM, ellipticity, centre/edge), field-dependent PSF map, chroma noise, banding detection in the color-gradient metric, highlight-texture and detail baselines recorded by prep.
- **Crash containment and resume**: `CRASH.json` sentinel, FATAL tool responses, parent kills the CLI, per-agent state snapshots, `--resume-agent <runId>` re-attaches the same Claude session. Forensics: `executing.json`, `last-command.json`, `command-log.jsonl`, SPCC console capture, stale-command cleanup. Mask-aware `close_image`, `safeClose()`, no explicit `gc()` anywhere.
- **Sub-agent containment and explicit models**: every agent runs with `--disallowedTools` (MCP tools + Read only), a pinned session id, `--effort` / `--fallback-model`; `agents/llm/agent-models.mjs` is the single model table (`--model-<alias>`, `config.models`).
- **processing-profiles.json schema reworked**: per-class `gradient`, `noise`, `reference`, `detail`, `core_burn`, `look`, `background` blocks, BXT correct_only / sharpen_nonstellar read by prep, `narrowband_palette` overlay class; `learned_overrides` and the profile-learning step removed (cross-run learning lives in the ledger).
- **SHO / HOO narrowband workflow**: `narrowband-prep.mjs` (no SPCC, unlinked stretch, linear star layers, cache), `sho-palette.mjs` and 13 palette/narrowband agent tools, narrowband prompt mode, palette branch, warm-start support.
- **State machine + repair engine rewrite**: `begin_composition` sentinel, branch coverage advisory, REJECTED finish no longer advances, repair reachable from finalize, forbids enforced on a view in any state, blocked calls consume budget, turn budgets for every agent, window limit of 12.
- **Borrowed-dataset support in prep**: `files.pixelScale`, `forceAlign`, `distortionCorrection`, `autoCropBorder`, `referencePath`; V8 ImageSolver fallback with seed bracketing; SPCC retry after regenerating the astrometric solution; aligned windows renamed by returned id (PI 1.9.5 names them ImageNN).
- **ABE on PixInsight 1.9.5 fixed** (`run_abe` was a silent no-op because the 1.9.x enums changed); masked per-channel ABE; gradient prompt v2 caps the polynomial degree on faint/dust fields.
- **Mask tooling and previews**: `mask_ops` with statistics, geometry-checked `apply_mask`, PixelMath zone masks, 1:1 native-resolution crop previews (`region="subject"`).
- **Disk hygiene**: orphan swap cleanup before every run, old-run pruning by mtime with 24 h / crashed / referenced-run protection, prep and gradient cache caps, `scripts/clean-swap.mjs`.
- **Run artifacts, tests, docs**: `run-artifacts.mjs` writes summaries on every exit path; `test/` adds a `node --test` suite (gates, state machine, crash/resume, repair policies, disk hygiene, prompt goldens); legacy API-provider engine archived under `agents/legacy/llm/`; `AGENTIC_PIPELINE_PLAN_2026-10-28.md` documents the work items behind these changes; `CLAUDE.md` and the `.claude/skills/pixinsight-pipeline/` references updated (new `narrowband-sho.md`).
