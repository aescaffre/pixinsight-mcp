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
5. **Open PixInsight** — Start PixInsight with the PJSR watcher script loaded.
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
- [PJSR Gotchas](reference/pjsr-gotchas.md) — File I/O, eval quirks, crop masks, ECMAScript 5 constraints
- [Xterminator Tools](reference/xterminator-tools.md) — SXT, NXT, BXT parameter reference
- [GHS Stretch](reference/ghs-stretch.md) — GHS formula, PixelMath implementation, multi-pass strategy
- [Processing Knowledge](reference/processing-knowledge.md) — Equipment settings, quality assessment, lessons learned
