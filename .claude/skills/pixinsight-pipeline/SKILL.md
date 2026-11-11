---
name: pixinsight-pipeline
description: |
  Automated deep sky astrophotography processing with PixInsight. Use when processing
  astronomical images (nebulae, galaxies, star clusters) through the full pipeline:
  channel combination, calibration, stretching, Ha/narrowband injection, star handling,
  and final adjustments. Covers HaRGB, HaLRGB, and LRGB workflows. Drives PixInsight's
  PJSR scripting engine via Node.js file-based IPC bridge.
---

# PixInsight Deep Sky Pipeline

## Overview

Config-driven, branching pipeline that processes linear astronomical masters into
publication-quality deep sky images. The pipeline is a Node.js script (`scripts/run-pipeline.mjs`)
that sends PJSR commands to PixInsight via file-based IPC (`~/.pixinsight-mcp/bridge/`).

## Quick Start — New Target

1. **Prepare data** — Stack your subs in WBPP. Place linear masters (`.xisf`) in one folder.
2. **Create config** — Copy `editor/default-config.json`, or use the web editor (`node editor/server.mjs`).
3. **Set file paths** — Fill in `files.R`, `files.G`, `files.B`, `files.Ha`, `files.L` (if applicable), `files.outputDir`, `files.targetName`.
4. **Choose workflow**:
   - **HaRGB** (no luminance): disable `l_stretch`, `l_nxt`, `l_bxt`, `lrgb_combine`
   - **HaLRGB** (with luminance): enable lum branch steps + `lrgb_combine`
   - **LRGB** (no Ha): set `files.Ha` to `""`, disable `ha_sxt`, `ha_stretch`, `ha_curves`, `ha_ghs`, `ha_inject`. Pipeline auto-detects `hasHa` and skips Ha file opening/cloning.
   - **RGB only** (no Ha, no L): set `files.Ha` and `files.L` to `""`, disable Ha + lum branch steps
   - **SHO / HOO narrowband** (mono S/H/O, false-color Hubble palette): set `files.S`, `files.Ha`, `files.O` (no R/G/B), `"palette": "SHO"`, `"starless": true`. A starless run must also set `files.stars = { "rgbConfig": "<R/G/B-only config>", "ref"?: "<NB master>", "reuseReg"?: "<registered stretched star layer>" }`: after export, giga-run adds the RGB stars with `scripts/add-rgb-stars.mjs` (ONE screen blend) and writes `<target>_giga_RGBstars.xisf/.jpg`; without it the run refuses to start (opt out explicitly with `"deliverStarless": true`). Exit code 3 = stars step failed (starless export only).
     The agentic pipeline detects the workflow and runs `narrowband-prep.mjs`: no SPCC, unlinked per-channel stretch, star-residual repair, and classic SHO + hue shift + SCNR.
     See [Narrowband SHO](reference/narrowband-sho.md).
5. **Open PixInsight** — Start PixInsight, then run `pjsr/pixinsight-mcp-watcher.js` from Script > Script Editor. The watcher runs on PJSR's V8 runtime (`#engine v8`, PI >= 1.9.5): the console banner must print `Engine: V8 ...` (and `~/.pixinsight-mcp/bridge/watcher-state.json` reports `engine: "v8"`). Never add `#engine sm`: the legacy SpiderMonkey runtime's GC aborts PI 1.9.5 on arm64. ES2025 is allowed inside the watcher file; the command snippets sent from Node still use ES5 style by convention (V8 runs them fine; `Process.prototype.CONST` is rewritten to `Process.CONST` by the watcher).
6. **Run** — `node scripts/run-pipeline.mjs --config path/to/config.json`
7. **Iterate** — Review JPEG previews at each step. Adjust params in config. Re-run.

## Pipeline Architecture

### Branches
| Branch | Label | Color | Forks After | Merges At |
|--------|-------|-------|-------------|-----------|
| `main` | RGB | blue | — | — |
| `stars` | Stars | yellow | `sxt` | `star_add` |
| `ha` | H-alpha | red | `combine_rgb` | `ha_inject` |
| `lum` | Luminance | purple | `sxt` | `lrgb_combine` |

### Standard Processing Order

**Pre-combination (Phase 0):**
0a. `gc_per_channel` — Per-channel GradientCorrection on R, G, B, L individually (`perChannel: true`). CRITICAL for LRGB — different channels have different gradients.
0b. `align` — StarAlignment (align G, B to R reference)

**Linear (on combined RGB composite):**
1. `combine_rgb` — PixelMath R/G/B into RGB, copy astrometry
2. `gc` — AutomaticBackgroundExtraction or GradientCorrection on combined image
3. `bxt_correct` — BlurXTerminator correctOnly (fix aberrations before calibration)
4. `plate_solve` — ImageSolver astrometry (needed for SPCC)
5. `spcc` — SpectrophotometricColorCalibration
6. `scnr` — Green cast removal
7. `bxt_sharpen` — BlurXTerminator sharpening pass
8. `nxt_pass1` — NoiseXTerminator linear denoise (moderate: 0.30)
9. `sxt` — StarXTerminator on linear (stars=true, NO unscreen)

**Stars branch (non-linear extraction):**
10. `star_stretch` — Load pre-SXT checkpoint, apply same HT+GHS, SXT with unscreen=true
11. `star_saturate` — CurvesTransformation S channel boost

**Ha branch:**
12. `ha_sxt` — StarXTerminator on linear Ha
13. `ha_stretch` — HT auto-stretch
14. `ha_curves` — Custom transfer curve
15. `ha_ghs` — GHS midtone/highlight control

**Luminance branch (if L data):**
16. `l_stretch` — HT auto-stretch
17. `l_nxt` — NoiseXTerminator denoise
18. `l_bxt` — BlurXTerminator sharpening (optional)

**Main stretch:**
19. `stretch` — HT auto-stretch + GHS refinement passes

**Non-linear processing:**
20. `nxt_pass2` — Post-stretch denoise (stronger: 0.50)
21. `curves_main` — Contrast S-curve + saturation
22. `ha_inject` — Three-part Ha injection with nebula mask
23. `lrgb_combine` — LRGBCombination (if L data; LinearFit L to RGB luminance first)
24. `lhe` — Local Histogram Equalization (tonal separation, with lum mask + maskGamma)
25. `lhe_fine` — LHE with smaller radius for micro-contrast (optional)
26. `hdrmt` — HDRMultiscaleTransform (core detail in bright regions, with lum mask + maskGamma)
27. `nxt_final` — Light denoise after LHE/HDRMT (0.30 — cleans amplified noise without over-smoothing)
28. `hue_boost` — Hue-selective saturation (blue spiral arms, pink HII regions; galaxies only)
29. `shadow_darken` — Gentle background darkening via lightness curve (galaxies only)
30. `channel_boost` — Per-channel color correction (filter-specific residual cast)
31. `curves_final` — Gentle lightness/saturation refinement
32. `star_add` — Screen blend stars back

### Key Techniques

**Non-linear star extraction** — Avoids halo bloating. Load pre-SXT checkpoint, apply identical
stretch (HT+GHS), then SXT with `unscreen=true`. Screen blend to recombine: `~(~$T*~(strength*stars))`.

**Ha injection (three-part with nebula mask):**
1. Conditional R-channel: `R + strength * max(0, Ha - threshold*R)` — adds Ha where it exceeds existing R
2. Luminance boost: LRGBCombination with Ha as luminance — transfers structural detail to all channels
3. Detail layer: `$T + detailStr * (Ha - GaussianBlur(Ha, sigma=15))` — color-neutral filament enhancement

**GHS via PixelMath** — The GHS process module (.dylib) is not installed. Use the PixelMath
fallback with `exp(exponent*ln(base))` (no `pow()` in PixelMath). See [GHS reference](reference/ghs-stretch.md).

**Checkpoint system** — XISF checkpoints before heavy steps. `--restart-from <stepId>` to resume.

**Mask gamma compression** — Luminance masks for LHE/HDRMT on galaxies must use gamma compression
to prevent bright cores from saturating to 1.0 in the mask. Formula: `exp(gamma * ln(max(rescaled, 0.00001)))`.
LHE uses maskGamma=2.0, HDRMT uses maskGamma=1.5.

**Hue-selective saturation (hue_boost)** — Replaces blanket saturation for galaxy targets. Uses PixelMath
to classify pixels by hue (R/G/B ratios) and apply per-hue boost factors: blue spiral arms (1.30),
pink HII regions (1.25), golden bulge (1.0). Formula: `lum + factor * (channel - lum)`.

**Per-channel gradient correction** — Phase 0c applies GradientCorrection to R, G, B, L individually
before combination. Essential for LRGB where different filters/nights produce different gradient profiles.
Has baseline guard that reverts if GC makes any channel worse.

**HDR headroom** — Modified Seti Hermite HDR compress that caps maximum pixel value below 1.0.
Gives HDRMT working room in bright galaxy cores. L headroom=0.10, RGB headroom=0.05.

## Config Format

```json
{
  "version": 2,
  "name": "TargetName Workflow (Iteration N - description)",
  "files": {
    "sourceFolder": "/path/to/data",
    "L": "", "R": "path.xisf", "G": "path.xisf", "B": "path.xisf", "Ha": "path.xisf",
    "haAlignCrop": { "left": 0, "top": 0, "right": 0, "bottom": 0 },
    "outputDir": "/path/to/output", "targetName": "TargetName"
  },
  "branches": { ... },
  "steps": [
    { "id": "step_id", "name": "Display Name", "branch": "main",
      "enabled": true, "params": { ... } }
  ]
}
```

## Iteration Workflow

1. Run pipeline with current config
2. **IMMEDIATELY write `iteration_XX.md`** — this is the FIRST thing after the run completes, before any other analysis or conversation. DO NOT SKIP THIS STEP.
3. Review JPEG previews (exported at each step)
4. Identify what needs adjustment (too much/little contrast, color, noise, etc.)
5. Modify params in config JSON
6. Re-run (or `--restart-from` a checkpoint for speed)

### Mandatory Deliverables (every iteration, no exceptions)
- `iteration_XX.xisf` — Full-resolution XISF (saved by pipeline)
- `iteration_XX.jpg` — Full-resolution JPEG preview (saved by pipeline)
- `iteration_XX.md` — **MANDATORY** markdown write-up. Must include: config used, parameter change table vs previous iteration, results (final median), assessment, issues found, and credits/software. See existing `iteration_*.md` files for format. Write this IMMEDIATELY after the run — do not defer.

## Parameter Tuning Guide

### Core Parameters
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| Background brightness | `stretch.targetBg` | 0.10-0.25 | 0.10 for galaxies, 0.25 for nebulae |
| Ha strength | `ha_inject.injectionStrength` | 0.3-0.8 | Higher = more Ha in red channel |
| Ha structure | `ha_inject.detailLayer` | 0.3-0.7 | Higher = more filament detail |
| Ha luminance | `ha_inject.lumBoost` | 0.3-0.7 | Adds Ha brightness to all channels |
| Denoise (linear) | `nxt_pass1.denoise` | 0.2-0.5 | Don't over-denoise linear data |
| Denoise (non-linear) | `nxt_pass2.denoise` | 0.4-0.7 | Can be stronger post-stretch |
| Denoise (final) | `nxt_final.denoise` | 0.25-0.35 | 0.30 after LHE/HDRMT; 0.40 over-smooths recovered detail |
| Star sharpening | `bxt_sharpen.sharpenStars` | 0.1-0.5 | Subtle is better |
| Nebula sharpening | `bxt_sharpen.sharpenNonstellar` | 0.3-0.75 | Can be more aggressive |
| Halo reduction | `bxt_sharpen.adjustStarHalos` | -0.5 to 0 | 0.00 for galaxies (neg. causes ringing before SXT) |
| Seti midtone | `star_stretch.setiMidtone` | 0.15-0.25 | Lower = more aggressive stretch per iteration |
| Seti iterations | `star_stretch.setiIterations` | 3-7 | More = brighter faint stars |
| Star saturation | `star_saturate.starSaturationCurve` | curve points | Must be aggressive — Seti stretch desaturates |
| Star strength | `star_add.starStrength` | 1.0 | Use 1.0 with simple addition (screenBlend: false) |
| Green removal | `scnr.amount` | 0.2-0.5 | 0.35 is a good default |

### Gradient Correction
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| Per-channel mode | `gc.perChannel` | true/false | **Always true for LRGB** — fixes per-channel color gradients that combined-image GC cannot |
| GC method | `gc.method` | "auto"/"abe"/"gc" | "auto" compares ABE vs GC and picks best |
| ABE polynomial | `gc.polyDegree` | 2-4 | 2-3 for galaxies (higher eats signal) |

> Two gradient phases: (1) the procedural prep GC above; (2) the agentic gradient sub-agent (giga-run Phase 1.5) on LINEAR combined RGB/L: run_gradient_correction, then run_per_channel_abe poly_degree 1-2 (cap 2 on faint IFN/dust/halo fields), run_abe default 2; run_scnr is excluded for it (`AGENT_TOOL_EXCLUDES`). It ends with a `GRADIENT RESULT:` line, persisted to `<run>/gradient-result.md`. Cache hash is salted with `GRADIENT_PROMPT_VERSION` (now 2).

### LHE / HDRMT Masks
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| LHE tonal separation | `lhe.amount` | 0.25-0.50 | 0.25 edge-on, 0.35 face-on spirals, 0.50 nebulae |
| LHE contrast limit | `lhe.slopeLimit` | 1.3-2.0 | 1.3 edge-on, 1.5 face-on, 1.8 nebulae |
| LHE mask gamma | `lhe.maskGamma` | 1.5-2.5 | **2.0 for galaxies** — protects bright cores from flattening |
| HDRMT layers | `hdrmt.numberOfLayers` | 5-8 | 6 for L, 7 for RGB on spiral galaxies |
| HDRMT iterations | `hdrmt.numberOfIterations` | 1-4 | 3 for spirals, 1 for edge-on |
| HDRMT mask gamma | `hdrmt.maskGamma` | 1.0-2.0 | **1.5 for galaxies** — lighter than LHE (HDRMT has built-in lum mask) |
| HDRMT mask clip low | `hdrmt.maskClipLow` | 0.10-0.30 | 0.20 for L channel, 0.10 for main RGB |

### HDR Headroom
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| L headroom | `l_stretch.hdrHeadroom` | 0-0.15 | 0.10 for galaxies — prevents core clipping before HDRMT |
| RGB headroom | `stretch.hdrHeadroom` | 0-0.10 | 0.05 for galaxies — less aggressive for color fidelity |

### Hue-Selective Saturation (hue_boost)
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| Blue arm boost | `hue_boost.blueBoost` | 1.0-1.5 | 1.30 — enhances spiral arms |
| Pink HII boost | `hue_boost.pinkBoost` | 1.0-1.4 | 1.25 — enhances emission regions |
| Golden bulge | — | 1.0 (fixed) | Left untouched — already warm enough |

### Channel Color Correction
| What to adjust | Parameter | Range | Notes |
|----------------|-----------|-------|-------|
| G channel factor | `channel_boost.G` | 0.90-1.0 | 0.94 for Astronomik filters — reduces green cast |
| B channel factor | `channel_boost.B` | 1.0-1.15 | 1.12 for Astronomik filters — compensates blue deficit |

## Gate Calibration Harness (WI-01)
- Gate constants live in `agents/llm/gate-contract.mjs` (BURN_CLIP, NOISE_*_HARD, CONTRAST_GATE, ...); `gateThreshold(profile, key, default)` reads optional per-class overrides from `processing-profiles.json` and ignores any override whose enclosing object lacks a `_calibration` string. `buildGateTable(brief)` lists every gate with BLOCKING/WARNING/SKIPPED.
- The finish gate battery is `evaluateFinishGates(ctx, store, brief, viewId, agentName, opts)` in `agents/llm/tools.mjs`; the agent can call it read-only with the `run_quality_gates` tool (public in every state; aesthetic critic off by default).
- Gate 11 (aesthetic critic, RUBRIC_VERSION 2) is ADVISORY: the rubric is built per target by `buildCritiqueRubric(context)` (starless skips the STARS axis; narrowband judges palette balance, not natural colour; galaxies favour muted saturation). It blocks only if the profile sets `aesthetic_gate:{blocking:true,min_score,_calibration}` and the deliverable is neither starless nor narrowband; set that only after >=8 user-rated pairs per class. Every verdict is logged to `<run>/critiques/calibration.jsonl`; rate with `node agents/llm/rate-critique.mjs --run <id> --label <finish_variant_xx> --rate N` and check agreement with `--report` (Spearman rho per class).
- Registry of user-approved / rejected images: `agents/calibration/approved-images.json`. Run `node scripts/backtest-gates.mjs [--id a,b] [--class X] [--critic] [--dry]` BEFORE merging any threshold change; exit 1 = an approved image hit a blocking failure (the threshold is wrong), exit 2 = a rejected image passes every blocking gate. Output: `agents/calibration/last-backtest.json`.
- `giga-run.mjs --approve` copies the exported XISF to `~/.pixinsight-mcp/approved/<class>/` and appends an 'approved' registry entry (survives run pruning; ledger champions repoint to it).
- **Per-agent model flags (WI-08)**: `giga-run.mjs --model-<agent> <alias> --effort-<agent> <low|medium|high|xhigh|max>` with `<agent>` in `giga|gradient|core|critic`. Resolution: CLI > `config.models.<agent>` ({model,effort,fallbackModel,maxTurns}) > defaults in `agents/llm/agent-models.mjs` (giga/gradient/core = `inherit` + fallback sonnet; critic = `opus`). `inherit` omits `--model` (uses ~/.claude/settings.json). engine-max also passes `--effort`, `--fallback-model` and `--max-turns ceil(1.5*maxTurns)` (outer safety net). Requested vs actual models (`modelUsage`) are recorded in `manifest.json.agents.<name>`, in the `run_meta` first line of `trace.jsonl`, and on ledger champions; a WARNING is logged when the actual model family differs from the request (fallback fired). Example: `--dry-run --model-gradient sonnet` prints the resolved table.
- `npm test` runs `test/gate-contract.test.mjs`.
- Baseline 2026-10-28 (pacman_lift5, ngc7023_iter03, ngc7023_best_of_both): no blocking failures; iter03 median FWHM is exactly 12.0 (= the non-galaxy hard limit, zero margin).

## Natural-look intent and per-class `look` block (WI-03)
- `aestheticIntent.colorSaturation` is `'muted' | 'moderate' | 'vivid'`. Default: `moderate` for galaxies except `galaxy_cluster`, `vivid` otherwise; override with `config.aesthetic.colorSaturation` or `opts.colorSaturation`.
- `agents/processing-profiles.json` has a `look` block per class (`s_curve_midpoint`, `target_p90`, `max_p90`, `saturation_stages`, galaxies also `detail_gain_target/max`), all marked `_calibration: 'PROVISIONAL — back-test pending'` until `scripts/backtest-gates.mjs` confirms them on the approved images.
- Under `moderate`/`muted` the giga prompt renders Branch C as "NATURAL BROADBAND" (single S-curve bracket around `look.s_curve_midpoint`, P90 judged at composition); `vivid` text is unchanged (emission/SHO/PNe render is byte-identical).
- Gate 7 / `check_saturation`: warn above `look.target_p90`, FAIL above `look.max_p90` (classes without `look`: warn above `saturation.max_p90`, fail above +0.10). Helpers: `saturationThresholds(brief)`, `evaluateSaturationGate(p90S, brief)` in `agents/llm/tools.mjs`.
- Ledger `color_richness` for galaxy classes = `1-|P90-target|/target` (closeness to the profile target, not "more is better").
- `scripts/relevel-legacy-universal.mjs` (dry run by default, `--apply` backs up) moves target-specific legacy memory out of `universal`.

## Common Issues

- **Stars have halos**: Avoid star erosion/threshold — use clean non-linear extraction instead
- **Over-processed look**: Reduce LHE amount, disable LHE fine and HDRMT, use gentler curves
- **Magenta/purple background**: SPCC issue — check sensor QE and filter profiles
- **PixInsight crash**: Check memory (warn at 8GB). Close intermediate images aggressively.
- **ImageSolver not defined**: Known — `#include` doesn't work in eval. SPCC still works without plate solve if image has WCS.

## Star Method: Linear Seti Stretch (Recommended)

Inspired by [Seti Astro](https://www.setiastro.com) (Bill Blanshan). This is the recommended approach —
produces tight, point-like stars without bloating.

**How it works:**
1. SXT on linear data (`stars=true`, no unscreen) — extract stars before stretch
2. Clip background pedestal from linear star residuals
3. Stretch with N iterations of the Midtone Transfer Function (MTF):
   ```
   MTF(m, x) = (1-m)*x / ((1-2m)*x + m)
   ```
4. Apply strong saturation boost (CurvesTransformation S channel) — the MTF stretch
   desaturates stars, so aggressive saturation compensation is needed
5. Add stars back with simple PixelMath addition at 100% strength (`screenBlend: false`)

**Config params:**
```json
"star_stretch": { "starMethod": "linear", "setiMidtone": 0.20, "setiIterations": 5 }
"star_saturate": { "starSaturationCurve": [[0,0],[0.10,0.55],[0.30,0.80],[0.55,0.95],[1,1]] }
"star_add": { "starStrength": 1.00, "screenBlend": false }
```

**Key lessons:**
- `setiMidtone` 0.20 with 5 iterations is a good starting point
- Star saturation must be applied AFTER the Seti stretch (stretch desaturates)
- Use a very aggressive S-curve — linear stars have low inherent saturation
- Simple addition at 1.00 strength works well (not screen blend)
- Do NOT use star erosion/threshold — creates artifacts. Clean extraction is sufficient.

**Alternative `"nonlinear"` method** (legacy, not recommended): loads pre-SXT checkpoint, applies
identical HT+GHS stretch, then SXT with `unscreen=true`. Produces slightly bloated stars.

## Credits / Inspired By

| Technique | Source |
|-----------|--------|
| Star Stretch (Seti/MTF method) | [Seti Astro](https://www.setiastro.com) — Bill Blanshan |
| Generalized Hyperbolic Stretch | [GHS Script](https://ghsastro.co.uk) — Mike Cranfield & Mark Shelley. PI script at `src/scripts/GeneralisedHyperbolicStretch/` |
| Non-linear star extraction | PixInsight community technique |
| Screen blend recombination | Standard astrophotography: `1-(1-A)*(1-B)` |
| STF Auto-stretch | PixInsight built-in STF algorithm |
| Ha 3-part injection | Combination of community techniques for narrowband |

## Iteration Workflow — Required Artifacts

Every pipeline run MUST produce a complete set of artifacts in the target's `output/processed/` folder. This is the standard way of working — follow it for every target.

### Artifacts per iteration

| Artifact | File | Purpose |
|----------|------|---------|
| **XISF** | `iteration_XX.xisf` | Full-resolution output (auto-generated by pipeline) |
| **JPEG preview** | `iteration_XX.jpg` | Quick visual review (auto-generated by pipeline) |
| **Config JSON** | `TargetName_vXX.json` | Exact parameters used (created before run) |
| **Iteration notes** | `iteration_XX.md` | Analysis, metrics, assessment, next steps |
| **Pipeline diagram** | `pipeline_vXX.md` | Mermaid.js flowchart of the processing graph |
| **Step previews** | `~/.pixinsight-mcp/previews/*.jpg` | Per-step JPEG exports (auto-generated, cleared each run) |

### Iteration notes template

Write `iteration_XX.md` **IMMEDIATELY** after every pipeline run (before any other work). Include:

1. **Config**: which JSON file, one-line description
2. **Key Changes**: table of what changed from previous iteration, with rationale
3. **Results**: per-channel GC stats, stretch metrics (median, max), shadow darken pre/post, final median
4. **Assessment**: wins (what improved), problems (what's still wrong), diagnosis
5. **Next Steps**: specific parameter changes for the next iteration

### Pipeline diagram

Generate a Mermaid.js flowchart showing:
- All enabled steps as nodes with key parameters
- Branch architecture (main, stars, lum, ha) with fork/merge points
- Different colors per branch (main=blue, stars=gold, lum=purple, ha=red)
- Merge points highlighted (green)
- Disabled steps omitted

Update the diagram when the pipeline structure changes (new steps added/removed, branch changes).

### Config JSON versioning

- Name configs as `TargetName_vXX.json` (e.g., `M81_M82_LRGB_v39.json`)
- Keep only the latest "best" config and the immediately previous version in the project
- Archive iteration notes for reference, but configs older than N-2 can be cleaned up
- The config IS the reproducible recipe — it must fully specify every parameter

## Reference Files

- [PJSR Process Parameters](reference/pjsr-processes.md) — LHE, HDRMT, MorphologicalTransformation, LRGBCombination, Convolution, SCNR
- [PJSR Gotchas](reference/pjsr-gotchas.md) — V8 runtime (#engine v8) + breaking-changes checklist, File I/O, eval quirks, crop masks, ES5-style convention for command snippets
- [Xterminator Tools](reference/xterminator-tools.md) — SXT, NXT, BXT parameter reference
- [GHS Stretch](reference/ghs-stretch.md) — GHS formula, PixelMath implementation, multi-pass strategy
- [Narrowband SHO/HOO](reference/narrowband-sho.md) — palettes, hue shift, star-residual repair on aberrated fields, chroma mottle, validated PACMAN recipe
- [Processing Knowledge](reference/processing-knowledge.md) — Equipment settings, quality assessment, lessons learned

## Agent engine hygiene (WI-07a)
- Turn budget is enforced MCP-side for every agent (argv[5] = maxTurns). At 0 turns remaining only a per-agent whitelist runs (giga: finish/save_variant/...; core: restore_from_clone; gradient: measurements) and others get `BUDGET EXHAUSTED`. Blocked calls (state/repair/budget) consume a turn (`recordBlockedCall`).
- `claude -p` is spawned with stdin ignored (no 3 s stall) and the system prompt via `--append-system-prompt-file` (saved under `<run>/prompts/`).
- MaxAgent result carries `timedOut`, `maxTurnsHit`, `exitCode`, `signal`. giga-run writes `run-summary.json` status: finished | recovered | timed_out | max_turns | crashed.
- No passing finish -> `getBestVariant()` (gate-PASS > ledger dimension score > latest) writes final-selection.json with `recovered:true, gates_passed:false` so export and the core post-pass still run. Treat such output as unverified.

## Giga state machine (WI-05)
- States: assess -> generate_candidates -> compose -> finalize (+ repair, returns to the state it was entered from).
- Pure measurement tools (measure_dust_coverage, check_noise, measure_color_gradient, get_image_dimensions, measure_uniformity, list_open_images, save_memory, recall_memory, run_quality_gates) are public in every state.
- generate_candidates -> compose: call `begin_composition` (needs >=2 saved variants; required for starless SHO runs) or lrgb_combine / star_protected_blend. Branch coverage is ADVISORY only.
- A REJECTED `finish` keeps the agent in compose (masks, detail, HDRMT, L-IFN/dust tools remain available); only a PASSED finish enters finalize (terminal; finalize is a superset of compose).
- Blocked calls consume turn budget. `--base-run` warm starts begin directly in compose.

## L incorporation (WI-13)
- `inject_luminance {view_id, l_view_id=FILTER_L, weight 0.10-0.50 (0.20), mask_view_id?}` (category lrgb): CIE-Y ratio blend; returns the L/RGB median ratio, pre/post stats and p90S. Use when the ratio is > 2x (weight 0.20-0.30 for 2-3x, 0.15-0.20 for >3x); `lrgb_combine` prints an ADVISORY line above 2.0x. Galaxy weight cap 0.25 (profile `tools.LRGB.max_inject_weight`). Available in generate_candidates, compose and finalize.
- Finish Gate 10 (l_usage) is provenance-based: `brief._lUsage` gets {tool, viewId, seq} from lrgb_combine, inject_luminance, inject_l_ifn and from run_pixelmath referencing FILTER_L or a clone of it (`brief._lRoots`, recorded on clone_image). Both survive MCP restarts via the agent-state snapshot. trace.jsonl is a fallback only when `_lUsage` is undefined. An unrelated PixelMath plus get_image_stats(FILTER_L) no longer counts as L usage.

## Repair engine (WI-06)
- `finish` REJECTED results end with `GATES_JSON: {"viewId":..,"failedGates":[{gate,tool,failedMetrics,reason,verify,repairable,...}]}`. The MCP server parses it, engages the first repairable policy (`findRepairPolicy(g.tool, ...)`) on that view in ANY state, and appends the policy guidance.
- Active policy = forbids-only enforcement (`checkRepairForbids`: forbiddenTools + forbiddenPatterns, incl. `test(args, prov, ctx)` matchers). Blocked calls are traced as `repair_violation` and consume budget. Policies end on a verify-tool PASS, an accepted finish, or `maxRepairTurns` by seq.
- Provenance is `lastModifier` for every image-modifying tool (+ `lastComposition`, history of 5). Synthetic policy keys: `finish:core_contrast|noise|dust|palette|exposure|l_missing`.
- Trace entries carry `state`, `repair_policy`, `failedGates`; separate `event` lines (`repair_engaged|repair_violation|repair_cleared`); `analyzeTrace().reject_reasons` = {gate: count}.

## Masks, 1:1 crops and post-op metrics (WI-15)
- `mask_ops {mask_id, output_id?, invert, dilate_px, erode_px, blur_sigma, clip_low, clip_high, gamma, multiply_with}` (category masks, public in every state): shape a mono mask with PI processes only. `create_luminance_mask` gained `range:[lo,hi]` and `invert`; `create_zone_masks` gained `blur_sigma` (number or {core,shell,halo}) and is PixelMath-based (60 MP safe). Both report mean/coverage with EMPTY/FULL flags.
- `save_and_show_preview` accepts `region` (full | center | subject | corner_tl/tr/bl/br | {x,y,w,h}), `crop_size` (1024), `scale` (1.0): native-resolution crop saved as `<label>__<region>_1to1.jpg`, result gives the crop rect in full-image coordinates plus median/MAD inside the crop. Judge noise, star shape and mottle only on 1:1 crops (full frame is ~0.2x on 60 MP). Shared helper: `renderCropJpeg` in agents/llm/vision.mjs (also used by the aesthetic critic).
- Post-op lines (no opt-out): `run_nxt` -> bgNoise/dustNoise vs HARD 0.022/0.040 (skipped on linear data), `run_curves` S/RGB -> subject P90 saturation vs the finish thresholds, `run_bxt` (sharpen) -> medianFWHM/starsFound, `ha_inject_luminance` -> stats + R/G/B max with burn warning. A separate check is only needed after run_pixelmath or lrgb_combine.

## Giga prompt structure (WI-09)
`agents/llm/prompts/giga-orchestrator.mjs` no longer has Phase 0-9 scaffolding. Sections: RUNTIME STATES (mirrors `STATE_TOOLS`; `finish` is a probe, a REJECTED finish stays in compose), one GATE TABLE rendered from `gate-contract.buildGateTable(brief)` (every threshold in the prose refers to it; aesthetic row shows the real ADVISORY status), missions (intake, branches A-D, critic pass, composition, ranking, gradient+SCNR, validation, finalization). Rules:
- Branch B is "FAINT STRUCTURE REVEAL"; the dust contract is rendered from `profile.ifn` (Gate 3e fails only when greyed AND crushed AND warm). Order: run_scnr -> inject_l_ifn (outer-field mask via create_luminance_mask + mask_ops) -> lift_dust -> run_nxt -> measure_dust_coverage + check_noise. `hasDustField = hasIFN || !!profile.ifn`; taxonomy `hasDust` is data only (no consumer yet).
- L incorporation is a ratio-routed decision (medL/medRGB <= 2 and LRGB not avoided -> lrgb_combine; else inject_luminance weight 0.15-0.30, galaxies <= 0.25; PNe may use the additive PixelMath form or SYNTH_L). Both routes satisfy the L-usage gate.
- PNe: continuous clamp is mandatory pre-star; HDRMT is an optional TRY through a donut mask in the branch phase (M97 +173%, M27 winner used none); never global, never through small-blur zone masks.
- Ranking: run_quality_gates -> compare_to_reference (top 3, sequential, only if a reference is registered) -> vision_aesthetic_critic (top 2, flaws are fix-or-rebut, score not used for ranking) -> metrics tie-break. Previews are a named-artifact veto only.
- Finish rationale starts with `KNOWN FLAWS:`; `finish` takes optional `remaining_flaws[]` and persists gates/critic/reference/warnings into final-selection.json; giga-run prints a "Critical summary" block first and appends it to trace-summary.md.
- Tests: `test/prompt-render.test.mjs` (all `*_agentic.json` renders, size ratchet 41600 chars, golden snapshots, banned phrases) and `test/prompt-state-consistency.test.mjs` (backticked tools exist, are not internal/hidden, are allowed in the mapped state; `tool(name=value)` keys match input_schema). Lower the ratchet when the prompt shrinks.

## New advisory tools (WI-26)
`measure_color_gradient` (now with band + corner fields; use on the final image too), `measure_chroma_noise`, `measure_psf_field` (linear data), `run_per_channel_abe` accepts `mask_view_id`. Finish Gate 13 (banding) and chroma-noise warnings are advisory. Details: reference/processing-knowledge.md "WI-26 advisory metrics".
