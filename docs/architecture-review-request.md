# GIGA Agentic Pipeline — Architecture Review Request

## What This Is

An autonomous deep sky astrophotography processing pipeline. A Claude Opus 4.6 (1M context) agent drives PixInsight (professional astro image processing software) via MCP tools to transform raw astronomical data into publication-quality images. The agent makes ALL creative decisions — no hardcoded workflow, no human in the loop during processing.

## Architecture Overview

```
                    ┌──────────────────────────────────┐
                    │   giga-run.mjs (orchestrator)    │
                    │                                  │
                    │  1. Load config (target, files)   │
                    │  2. Classify target (taxonomy)    │
                    │  3. Build brief (profile+traits)  │
                    │  4. Run deterministic prep        │
                    │  5. Launch Claude Max agent       │
                    │  6. Export result + trace          │
                    └──────────────┬───────────────────┘
                                   │
                    ┌──────────────▼───────────────────┐
                    │   engine-max.mjs (subprocess)     │
                    │                                  │
                    │  Spawns: claude -p --output-format│
                    │    json --mcp-config tools.json   │
                    │  Model: Claude Opus 4.6 (1M ctx) │
                    │  Budget: 200 turns, 2hr timeout   │
                    │  Auth: Claude Max (OAuth, no API) │
                    └──────────────┬───────────────────┘
                                   │ MCP (stdio)
                    ┌──────────────▼───────────────────┐
                    │  mcp-agent-tools.mjs (MCP server) │
                    │                                  │
                    │  62 tools served via MCP protocol │
                    │  Trace collector (trace.jsonl)    │
                    │  Brief + Store passed to handlers │
                    └──────────────┬───────────────────┘
                                   │ File-based IPC
                    ┌──────────────▼───────────────────┐
                    │  PixInsight (PJSR watcher)        │
                    │                                  │
                    │  Polls ~/.pixinsight-mcp/bridge/  │
                    │  Executes PJSR commands (ES5)     │
                    │  Returns results via JSON files   │
                    └──────────────────────────────────┘
```

## The Model

**Claude Opus 4.6 with 1M context window**, running via Claude Max subscription (OAuth auth, zero API cost). The agent receives a ~30K token system prompt describing 9 processing phases, 4 creative branches, quality rules, and tool descriptions. It then autonomously calls tools for 150-250 turns over 25-35 minutes.

## Tool Inventory (62 tools)

### Measurement (7)
| Tool | Purpose |
|------|---------|
| `get_image_stats` | Image statistics: median, MAD, min, max, per-channel |
| `measure_uniformity` | Background uniformity via 4-corner median stddev |
| `measure_subject_detail` | Subject brightness, detail score, contrast ratio |
| `list_open_images` | List all open PixInsight image windows |
| `compute_scores` | Quality scores (0-100) and weighted aggregate |
| `check_constraints` | Hard constraints (clipping, background, balance) |
| `check_saturation` | HSV saturation percentiles (P90, P99) in subject pixels |

### Image Management (5)
| Tool | Purpose |
|------|---------|
| `clone_image` | Clone image to backup (for bracketing/revert) |
| `restore_from_clone` | Restore from backup |
| `close_image` | Close window to free memory |
| `purge_undo` | Purge undo history |
| `open_image` | Open XISF/FITS file |

### Processing (18)
| Tool | Purpose |
|------|---------|
| `run_gradient_correction` | GradientCorrection |
| `run_abe` | AutomaticBackgroundExtractor |
| `run_per_channel_abe` | Per-channel ABE (R/G/B independent) |
| `run_nxt` | NoiseXTerminator (denoise) |
| `run_bxt` | BlurXTerminator (correct/sharpen) |
| `run_scnr` | Green cast removal |
| `run_spcc` | SpectrophotometricColorCalibration |
| `run_background_neutralization` | Background level equalization |
| `seti_stretch` | Statistical stretch (main stretch tool) |
| `stretch_stars` | Stretch linear star images |
| `auto_stretch` | Quick STF-based stretch |
| `run_lhe` | LocalHistogramEqualization |
| `run_hdrmt` | HDRMultiscaleTransform |
| `run_curves` | CurvesTransformation |
| `run_pixelmath` | Arbitrary PixelMath expressions |
| `run_sxt` | StarXTerminator (star separation) |
| `lrgb_combine` | Luminance + RGB combination |
| `star_screen_blend` | Screen-blend stars back |

### Narrowband & Ha (6)
| Tool | Purpose |
|------|---------|
| `ha_inject_red` | Ha signal into red channel |
| `ha_inject_luminance` | Ha into luminance |
| `continuum_subtract_ha` | Remove broadband from Ha |
| `extract_pseudo_oiii` | Pseudo-OIII from B channel |
| `dynamic_narrowband_blend` | Ha + OIII dynamic blend |
| `create_synthetic_luminance` | Synthetic L from Ha+OIII |

### Masks (4)
| Tool | Purpose |
|------|---------|
| `create_luminance_mask` | Luminance mask with blur, clipLow, gamma |
| `apply_mask` | Apply mask to view |
| `remove_mask` | Remove mask |
| `close_mask` | Delete mask window |

### Compound & Detail (3)
| Tool | Purpose |
|------|---------|
| `multi_scale_enhance` | 3-scale LHE + optional HDRMT + before/after metrics |
| `continuous_clamp` | Smooth brightness clamping (no mask artifacts) |
| `create_zone_masks` | Core/shell/halo zone masks |

### Quality Gates (6)
| Tool | Purpose | Threshold |
|------|---------|-----------|
| `check_star_quality` | FWHM + color diversity | FWHM<8px, color>0.05, count>=50 |
| `check_ringing` | Radial profile oscillations | 0 oscillations (zero tolerance) |
| `check_sharpness` | Sobel gradient energy | Comparative only |
| `check_core_burning` | Core pixel clipping | <2% burnt in 128x128 |
| `scan_burnt_regions` | Global burn scan | ZERO 50x50 blocks >0.95 |
| `check_saturation` | HSV P90 in subject | Per-category max_p90 |

### Control & Memory (5)
| Tool | Purpose |
|------|---------|
| `finish` | Signal completion (runs all quality gates automatically) |
| `recall_memory` | Read memories from previous runs |
| `save_memory` | Save lessons/insights |
| `save_variant` | Save named checkpoint with metadata |
| `save_and_show_preview` | Export JPEG preview |

### Other (8)
| Tool | Purpose |
|------|---------|
| `rename_view` | Rename image view |
| `get_image_dimensions` | Dimensions and channel info |
| `combine_channels` | Combine mono → RGB |
| `run_plate_solve` | Astrometric solution |
| `copy_astrometric_solution` | Copy WCS between images |
| `load_variant` | Load a saved variant |
| `list_variants` | List available variants |
| `submit_scores` | Submit quality assessment |

## Agent Prompt Structure (9 Phases)

The system prompt (~30K tokens) defines this workflow:

### Phase 0 — Assessment
- `recall_memory` for prior knowledge
- Classify target, identify workflow (LRGB/HaLRGB/HaRGB/RGB)
- Read processing profile (per-category tool/param defaults)

### Phase 1 — Prep (already done before agent starts)
- Deterministic: open masters, align, combine RGB, GC, BXT, SPCC, NXT, SXT, stretch
- Produces: stretched starless RGB, stretched starless L, stretched star layer

### Phase 2 — Branch Generation (4 parallel branches)
- **Branch A — Luminance Detail**: multi_scale_enhance with varying params, HDRMT, mask tuning. Must produce 4 variants (weak/target/edge/overdone).
- **Branch B — IFN/Halo Reveal**: Shadow-lifting for faint structure. Same 4 variants.
- **Branch C — Color**: Saturation curves, Ha injection. 4 variants from restrained to overdone.
- **Branch D — Star Policy**: Star saturation, reduction level. 4 variants.

### Phase 3 — Critic
- Review all variants, pick winners per branch, identify overdone boundaries

### Phase 5 — Composition
- Combine branch winners: 3+ composition variants (COMP_balanced, COMP_boldcolor, COMP_edge)
- LRGB combine, brightness recovery, post-LRGB detail enhancement

### Phase 6-7 — Composition Critic + Art Direction
- Visual comparison, style decisions, pick final

### Phase 8 — Quality Gates + Finish
- Run all automated gates, fix failures, call `finish`

### Phase 9 — Memory
- Save winning params and lessons for future runs

## Classification System

### Target Taxonomy (13 categories)
Each category has trait definitions that drive processing decisions:

| Category | Signal | Structure | Saturation max_p90 |
|----------|--------|-----------|-------------------|
| galaxy_spiral | broadband | core_arms_ifn | 0.60 |
| galaxy_edge_on | broadband | core_halo | 0.55 |
| galaxy_elliptical | broadband | core_halo | 0.50 |
| galaxy_cluster | broadband | uniform | 0.60 |
| emission_nebula | ha_dominant | multi_zone | 0.75 |
| planetary_nebula | dual_narrowband | core_halo | 0.80 |
| reflection_nebula | broadband | uniform | 0.55 |
| dark_nebula | broadband | uniform | 0.55 |
| supernova_remnant | dual_narrowband | filamentary | 0.70 |
| star_cluster_globular | broadband | core_halo | 0.55 |
| star_cluster_open | broadband | uniform | 0.55 |
| mixed_field | broadband | multi_zone | 0.60 |

### Processing Profiles
Per-category JSON config with:
- Stretch targets (median, headroom)
- Per-tool recommendations (use/try/avoid + params)
- Saturation limits (rgb_initial, composition_target, max_p90)
- Star handling (blend strength, prominence)
- Processing notes

## Quality Gate System

Gates are **automated code-based checks** that run in PJSR (PixInsight's scripting engine). They measure pixels directly — the agent cannot argue with numbers.

**Enforcement at `finish`:**
When the agent calls `finish`, 7 gates run automatically:
1. Star quality (FWHM, color, count) — warning
2. Ringing detection (radial oscillations) — warning
3. Burn scan at 0.95 (zero tolerance) — **HARD FAIL**
4. Subject detail (brightness >= 0.25, contrast >= 3x, detail >= 0.001) — **HARD FAIL**
5. Overall exposure (median vs target) — **HARD FAIL**
6. Per-channel peak detection — warning
7. Saturation (P90 vs category max_p90 + 0.10) — **HARD FAIL**

If any HARD FAIL triggers, `finish` is rejected and the agent must fix the issue.

## Execution Trace System

Every tool call is logged to `trace.jsonl` with: sequence number, timestamp, tool name, args, view_id, duration, result summary, error. Post-run analysis generates:
- `trace-analysis.json` — structured: branches, quality gates, retries, dead-ends, winner
- `trace-diagram.mmd` — Mermaid flowchart of execution
- `trace-summary.md` — Markdown tables

## Complete Execution Trace — Best Run (NGC891, run 0df723d8, score 84.4)

This is the full tool call sequence from our best run. 243 tool calls, 35 minutes, 18.3M tokens.

```
TIME     DUR    TOOL                      VIEW               ARGS/PARAMS                               RESULT
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
=== PHASE 0: ASSESSMENT ===
   8.1s  0.0s   recall_memory                                                                         (no memories found)
   8.6s  1.0s   list_open_images                                                                      3 views
   9.7s  1.0s   measure_subject_detail    FILTER_L
  10.7s  2.5s   measure_subject_detail    NGC891
  71.8s  0.5s   rename_view

=== BRANCH A: L DETAIL (4 variants, 12x run_lhe) ===
  72.4s  1.0s   clone_image               FILTER_L           → L_baseline
  73.4s  1.0s   clone_image               NGC891             → RGB_baseline
  82.8s  3.0s   save_variant              FILTER_L           "L baseline"                              med=0.240
  85.8s  5.5s   save_variant              NGC891             "RGB baseline"                            med=0.080
  91.4s  2.5s   create_luminance_mask     FILTER_L

--- L_detail_weak: r48/0.25 r32/0.20 r24/0.15 slope=1.5 ---
 103.0s  0.5s   apply_mask                FILTER_L
 110.6s  8.0s   run_lhe                   FILTER_L           r=48 a=0.25
 121.8s  6.7s   run_lhe                   FILTER_L           r=32 a=0.2
 131.3s  6.7s   run_lhe                   FILTER_L           r=24 a=0.15
 141.3s  0.5s   remove_mask               FILTER_L
 145.3s  2.0s   run_curves                FILTER_L           shadow-darken                            med=0.087
 151.3s  1.0s   measure_subject_detail    FILTER_L
 152.3s  1.0s   scan_burnt_regions        FILTER_L                                                    FAIL (4 blocks)
 159.0s  7.5s   continuous_clamp          FILTER_L
 169.2s  1.5s   scan_burnt_regions        FILTER_L                                                    PASS
 177.0s  4.0s   save_variant              FILTER_L           "L_detail_weak"                          detail=0.026
 181.0s  0.5s   restore_from_clone        FILTER_L           → L_baseline

--- L_detail_target: r48/0.35 r32/0.30 r24/0.25 slope=1.8 ---
 185.3s  1.0s   apply_mask                FILTER_L
 189.4s  7.4s   run_lhe                   FILTER_L           r=48 a=0.35
 199.8s  6.4s   run_lhe                   FILTER_L           r=32 a=0.3
 209.0s  6.8s   run_lhe                   FILTER_L           r=24 a=0.25
 218.8s  0.5s   remove_mask               FILTER_L
 222.5s  1.0s   run_curves                FILTER_L           shadow-darken                            med=0.088
 226.9s  7.1s   continuous_clamp          FILTER_L
 238.0s  1.0s   scan_burnt_regions        FILTER_L                                                    PASS
 245.1s  3.0s   save_variant              FILTER_L           "L_detail_target"                        detail=0.028
 248.2s  1.0s   restore_from_clone        FILTER_L           → L_baseline

--- L_detail_edge: r48/0.40 r32/0.35 r24/0.30 slope=1.8 ---
 252.1s  0.5s   apply_mask                FILTER_L
 255.7s  7.2s   run_lhe                   FILTER_L           r=48 a=0.4
 266.1s  7.1s   run_lhe                   FILTER_L           r=32 a=0.35
 276.2s  6.5s   run_lhe                   FILTER_L           r=24 a=0.3
 285.6s  1.0s   remove_mask               FILTER_L
 289.4s  1.5s   run_curves                FILTER_L           shadow-darken                            med=0.088
 293.7s  8.1s   continuous_clamp          FILTER_L
 305.2s  1.5s   scan_burnt_regions        FILTER_L                                                    PASS
 313.9s  3.0s   save_variant              FILTER_L           "L_detail_edge"                          detail=0.029
 316.9s  1.0s   restore_from_clone        FILTER_L           → L_baseline

--- L_detail_overdone: r48/0.50 r32/0.45 r24/0.40 slope=2.0 ---
 320.9s  0.5s   apply_mask                FILTER_L
 324.9s  8.2s   run_lhe                   FILTER_L           r=48 a=0.5
 335.9s  7.1s   run_lhe                   FILTER_L           r=32 a=0.45
 346.0s  6.3s   run_lhe                   FILTER_L           r=24 a=0.4
 355.0s  0.5s   remove_mask               FILTER_L
 358.5s  1.5s   run_curves                FILTER_L           shadow-darken                            med=0.088
 362.7s  7.6s   continuous_clamp          FILTER_L
 373.0s  1.5s   scan_burnt_regions        FILTER_L                                                    PASS
 385.4s  3.5s   save_variant              FILTER_L           "L_detail_overdone"                      detail=0.032
 388.9s  1.0s   restore_from_clone        FILTER_L           → L_baseline

=== BRANCH C: COLOR (4 variants, saturation bracketing) ===
 412.9s  2.0s   create_luminance_mask     NGC891

--- color_restrained: S midpoint=0.65 ---
 420.5s  3.6s   run_curves                NGC891             S channel
 427.1s  0.5s   check_saturation          NGC891                                                      P90=0.331 ✓
 427.7s  2.0s   scan_burnt_regions        NGC891                                                      PASS
 435.2s  6.0s   save_variant              NGC891             "color_restrained"                       P90=0.331
 441.3s  1.0s   restore_from_clone        NGC891             → RGB_baseline

--- color_target: S 0.75 + 1x masked S 0.80 ---
 445.8s  3.6s   run_curves                NGC891             S global
 452.2s  0.5s   apply_mask                NGC891
 456.2s  4.1s   run_curves                NGC891             S masked
 462.8s  1.0s   remove_mask               NGC891
 466.5s  1.0s   check_saturation          NGC891                                                      P90=0.394 ✓
 471.7s  5.5s   save_variant              NGC891             "color_target"                           P90=0.394
 477.3s  0.5s   restore_from_clone        NGC891             → RGB_baseline

--- color_bold: S 0.75 + 2x masked S 0.85 ---
 481.1s  3.1s   run_curves                NGC891             S global
 487.2s  0.5s   apply_mask                NGC891
 490.6s  3.0s   run_curves                NGC891             S masked x1
 496.4s  3.6s   run_curves                NGC891             S masked x2
 502.7s  1.0s   remove_mask               NGC891
 506.1s  1.5s   check_saturation          NGC891                                                      P90=0.402 ✓
 512.3s  7.0s   save_variant              NGC891             "color_bold"                             P90=0.402
 519.4s  1.0s   restore_from_clone        NGC891             → RGB_baseline

--- color_overdone: S 0.85 + 3x masked S 0.90 ---
 523.9s  3.6s   run_curves                NGC891             S global
 530.1s  0.5s   apply_mask                NGC891
 533.6s  4.0s   run_curves                NGC891             S masked x1
 540.4s  3.6s   run_curves                NGC891             S masked x2
 546.8s  3.6s   run_curves                NGC891             S masked x3
 552.8s  1.0s   remove_mask               NGC891
 556.4s  1.5s   check_saturation          NGC891                                                      P90=0.466 ⚠ (overdone)
 565.1s  6.0s   save_variant              NGC891             "color_overdone"                         P90=0.466
 571.1s  0.5s   restore_from_clone        NGC891             → RGB_baseline

=== BRANCH D: STARS (4 variants) ===
 588.9s  1.5s   get_image_stats           NGC891_stars
 590.4s  1.0s   clone_image               NGC891_stars       → stars_baseline

--- stars_bright: 3x sat curve ---
 596.2s  2.5s   run_curves                NGC891_stars       S boost x1
 601.9s  2.5s   run_curves                NGC891_stars       S boost x2
 621.2s  2.5s   run_curves                NGC891_stars       S boost x3
 628.3s  6.5s   save_variant              NGC891_stars       "stars_bright"
 634.8s  0.5s   restore_from_clone        NGC891_stars       → stars_baseline

--- stars_target: 2x sat curve ---
 638.8s  1.5s   run_curves                NGC891_stars       S boost x1
 643.4s  2.5s   run_curves                NGC891_stars       S boost x2
 649.2s  5.0s   save_variant              NGC891_stars       "stars_target"
 654.2s  0.5s   restore_from_clone        NGC891_stars       → stars_baseline

--- stars_reduced: 2x sat + ^1.1 power law ---
 657.9s  2.0s   run_curves                NGC891_stars       S boost x1
 663.6s  2.0s   run_curves                NGC891_stars       S boost x2
 669.2s  3.0s   run_pixelmath             NGC891_stars       exp(1.1*ln(max($T,0.000001)))
 676.2s  5.5s   save_variant              NGC891_stars       "stars_reduced"
 681.7s  0.5s   restore_from_clone        NGC891_stars       → stars_baseline

--- stars_overreduced: 2x sat + ^1.5 power law ---
 685.5s  2.0s   run_curves                NGC891_stars       S boost x1
 690.8s  2.5s   run_curves                NGC891_stars       S boost x2
 696.4s  2.5s   run_pixelmath             NGC891_stars       exp(1.5*ln(max($T,0.000001)))
 702.8s  5.5s   save_variant              NGC891_stars       "stars_overreduced"

=== PHASE 3: CRITIC (variant review) ===
 727.3s  0.0s   list_variants
 732.0s  0.0s   load_variant              variant_05                                                  ERR
 738.6s  2.5s   load_variant
 744.1s  2.5s   save_and_show_preview     FILTER_L           "L_detail_edge"
 775.2s  2.5s   save_and_show_preview     FILTER_L1          "L_detail_overdone"
 844.0s  0.5s   restore_from_clone        FILTER_L           → L_detail_edge winner
 846.6s  2.0s   load_variant              (color_bold)
 854.3s  1.5s   get_image_stats           FILTER_L
 855.8s  1.5s   get_image_stats           NGC891

=== CLEANUP (prep for composition) ===
 877.1s  1.0s   restore_from_clone        NGC891             → load color_bold
 878.1s  1.0s   restore_from_clone        NGC891_stars       → load stars_target
 882-885         close_image x4 + close_mask x2              (cleanup intermediates)

=== PHASE 5: COMPOSITION (3 LRGB variants) ===
 897.1s  1.5s   clone_image               NGC891             → comp_backup

--- COMP_balanced: LRGB L=0.45 sat=0.80 ---
 902.0s 18.1s   lrgb_combine              NGC891             L=0.45 sat=0.8                           med=0.092
 934.3s  2.5s   run_curves                NGC891             RGB shadow-darken pass 1                 med=0.048
 941.1s  2.5s   run_curves                NGC891             RGB shadow-darken pass 2                 med=0.029
 949.8s  2.5s   run_curves                NGC891             RGB shadow-darken pass 3                 med=0.009
 956.0s  3.0s   run_pixelmath             NGC891             gamma 0.55 recovery                      med=0.075
 963.2s  2.0s   run_curves                NGC891             RGB shadow-darken pass 4                 med=0.025
 968.9s  2.5s   measure_subject_detail    NGC891
 971.4s  2.0s   scan_burnt_regions        NGC891                                                      PASS
 980.9s  3.0s   run_pixelmath             NGC891             gamma 0.92 (gentle)                      med=0.034
 986.7s  2.5s   measure_subject_detail    NGC891
 997.4s 22.7s   multi_scale_enhance       NGC891             clip=0.08 fine=0.25 mid=0.30            detail +16.1%
1023.9s  2.0s   scan_burnt_regions        NGC891                                                      FAIL (24 blocks)
1034.3s 10.6s   continuous_clamp          NGC891
1047.8s  1.5s   scan_burnt_regions        NGC891                                                      PASS
1053.8s  2.0s   star_screen_blend         NGC891             str=0.95
1059.8s  1.5s   scan_burnt_regions        NGC891                                                      PASS
1072.7s  5.5s   save_variant              NGC891             "COMP_balanced"

--- COMP_boldcolor: LRGB L=0.40 sat=0.90 ---
1078.3s  1.0s   restore_from_clone        NGC891             → comp_backup
1083.4s 18.6s   lrgb_combine              NGC891             L=0.4 sat=0.9
 (same shadow-darken + gamma 0.55 + gamma 0.92 + multi_scale_enhance + clamp + star blend)
1210.0s  6.0s   save_variant              NGC891             "COMP_boldcolor"

--- COMP_edge: LRGB L=0.50 sat=0.80, gamma 0.50 (stronger) ---
1216.1s  0.5s   restore_from_clone        NGC891             → comp_backup
1221.8s 20.6s   lrgb_combine              NGC891             L=0.5 sat=0.8
 (shadow-darken + gamma 0.50 + stronger multi_scale_enhance clip=0.06 + clamp + stars)
1357.7s  6.0s   save_variant              NGC891             "COMP_edge" ← WINNER

=== PHASE 6-7: COMPOSITION CRITIC + ART DIRECTION ===
1376.8s  4.5s   save_and_show_preview     NGC891             "COMP_edge"
1405.1s  1.0s   list_open_images
1410.5s  5.0s   save_and_show_preview     NGC8911            "COMP_balanced" (for comparison)
1447.9s  1.5s   get_image_stats           NGC891
1460.5s  0.5s   measure_uniformity        NGC891                                                      0.00053
1474.3s  1.5s   check_constraints         NGC891
1475.8s  1.5s   check_star_quality        NGC891                                                      PASS (FWHM=7.0, color=0.094)
1477.4s  3.0s   check_ringing             NGC891                                                      FAIL (89 osc — natural edge-on profile)
1480.4s  1.0s   check_sharpness           NGC891                                                      0.0079
1481.4s  1.0s   check_saturation          NGC891                                                      P90=0.917 ← WAY OVER

=== SATURATION FIX (downstream — this is the problem) ===
1557.4s  2.0s   create_luminance_mask     NGC891             (for star-protected desat)
1563.0s  1.0s   apply_mask                NGC891             inverted star mask
1568.2s  3.5s   run_curves                NGC891             S desat pass 1
1576.4s  1.0s   remove_mask               NGC891
1580.2s  1.0s   check_saturation          NGC891                                                      P90=0.917 (no change — wrong mask?)
1600.8s  3.6s   run_curves                NGC891             S desat pass 2 (stronger)
1608.0s  1.5s   check_saturation          NGC891                                                      P90=0.700
1617.6s  3.0s   run_curves                NGC891             S desat pass 3
1623.4s  1.0s   check_saturation          NGC891                                                      P90=0.572 ✓ (under 0.65)
1633.4s  5.0s   save_and_show_preview     NGC891             "COMP_edge_desat"
1638.4s  1.0s   check_star_quality        NGC891                                                      FAIL (color=0.005 — desat killed star color!)

=== STAR COLOR RECOVERY ===
1682.2s  2.0s   load_variant              (COMP_edge)        (restore to try different approach)
1695.7s  1.0s   restore_from_clone        NGC891             → reload
1701.3s  0.5s   apply_mask                NGC891             inverted star mask
1707.2s  3.6s   run_curves                NGC891             S desat (gentler)
1713.8s  0.5s   remove_mask               NGC891
1718.5s  0.5s   check_saturation          NGC891                                                      P90=0.700
1719.0s  1.5s   check_star_quality        NGC891                                                      FAIL (color=0.029)

1736.6s  0.5s   apply_mask                NGC891             inverted star mask (retry)
1741.0s  3.0s   run_curves                NGC891             S desat (tuned)
1746.7s  1.0s   remove_mask               NGC891
1751.3s  1.0s   check_saturation          NGC891                                                      P90=0.572
1758.1s  1.0s   apply_mask                NGC891             regular star mask (boost star color)
1767.8s  3.0s   run_curves                NGC891             S boost on stars
1773.5s  1.0s   remove_mask               NGC891
1779.5s  1.5s   check_star_quality        NGC891                                                      PASS (color=0.094 — recovered!)
1781.1s  0.5s   check_saturation          NGC891                                                      P90=0.572 ✓

=== PHASE 8: FINAL POLISH + QUALITY GATES ===
1790.0s  4.0s   save_and_show_preview     NGC891             "COMP_edge_final"
1794.0s  2.0s   scan_burnt_regions        NGC891                                                      PASS
1808.6s  2.5s   run_pixelmath             NGC891             min($T, 0.99) clamp
1844.7s  4.5s   save_and_show_preview     NGC891             "FINAL"
1869.5s  2.5s   run_curves                NGC891             S mild re-boost
1876.1s  2.5s   run_pixelmath             NGC891             min($T, 0.99) clamp
1882.9s  1.5s   check_saturation          NGC891                                                      P90=0.607 ✓
1884.4s  1.5s   check_star_quality        NGC891                                                      PASS
1893.0s  4.5s   save_and_show_preview     NGC891             "FINAL_v2"
1920.8s  7.0s   save_variant              NGC891             "FINAL"
1927.8s  2.0s   compute_scores            NGC891                                                      score=84.4
1942.9s  0.0s   save_memory               NGC891             (save recipe)

=== FINISH ===
2026.4s 13.6s   finish                    NGC891                                                      REJECTED (1 burnt block at [4450,850])
2053.1s  2.5s   run_pixelmath             NGC891             min($T, 0.949)
2059.4s  2.0s   scan_burnt_regions        NGC891                                                      PASS
2061.4s  1.0s   check_star_quality        NGC891                                                      PASS
2071.2s 16.1s   finish                    NGC891                                                      PASSED ✓ (score 84.4/100)
```

## Major Problems We're Trying to Solve

### Problem 1: Agent Ignores Compound Tool

We have `multi_scale_enhance` which does 3-scale LHE + HDRMT + before/after metrics in ONE call. The prompt says "ALWAYS use multi_scale_enhance, NEVER call run_lhe individually." But the agent consistently uses 12x individual `run_lhe` calls instead, wasting ~20 turns.

**What we've tried:** Explicit prompt instructions ("NEVER call run_lhe individually"), making multi_scale_enhance the PRIMARY listed tool. Agent still uses individual calls.

**What we're considering:** Making `run_lhe` return an error telling the agent to use `multi_scale_enhance` instead. Effectively deprecating the tool.

### Problem 2: Downstream Saturation Fix Instead of Upstream Parameter Iteration

When LRGB combine produces over-saturated results (P90 jumps from 0.40 pre-combine to 0.92 post-combine), the agent applies destructive post-hoc desaturation curves instead of going back and re-combining with a lower `saturation` parameter.

**The correct approach:** restore from backup → reduce LRGB `saturation` param (0.80 → 0.60 → 0.40) → re-combine → check → iterate until gate passes. This preserves original channel color information.

**What the agent does:** Keeps the over-saturated combine, then applies S-curve desaturation which destroys color gradients. Worse, the desaturation kills star color diversity (0.094 → 0.005), requiring additional star-color recovery passes.

**What we've tried:** Explicit prompt instructions ("FIX UPSTREAM, NEVER DOWNSTREAM"), feedback memory, saturation gate. The agent reads these but still defaults to downstream correction. In 5 runs, it has NEVER iterated on the LRGB `saturation` parameter.

### Problem 3: Agent Runs Out of Turns Without Calling Finish

In 3 out of 6 runs, the agent exhausted its 200-turn budget without ever calling `finish`. The `result` field is empty, and the exported image is whatever intermediate state was left. This happens because:
- The agent spends too many turns on individual operations (12x run_lhe when 4x multi_scale_enhance would suffice)
- The saturation fix loop (desaturate → check → star color broken → recover → check → repeat) consumes 30-40 turns
- The agent doesn't plan its turn budget

### Problem 4: Ringing Detector False Positives on Edge-On Galaxies

The `check_ringing` tool measures radial brightness oscillations around the brightest region. Edge-on galaxies naturally have an oscillating radial profile (disk → dust lane → disk), which the detector reads as "89 oscillations" — a massive false positive. This makes the agent afraid to use HDRMT and triggers unnecessary investigation/remediation loops.

### Problem 5: Memory-Driven Rigidity vs Generic Processing

When target-specific recipe memories exist (e.g., "NGC891: HDRMT rejected, use 12x individual LHE"), the agent follows them slavishly instead of experimenting. We've deleted all target-specific recipes and now rely purely on category-level processing profiles, but the agent still tends to repeat patterns from its system prompt rather than adapting to quality gate feedback.

### Problem 6: The Agent Can See But Can't Judge

The agent receives JPEG previews and can read them (multimodal). But its visual assessment is unreliable — it says "looks good" to obviously over-saturated images, doesn't notice ringing artifacts, and can't compare two similar variants meaningfully. The quality gates compensate for this with numerical checks, but there's a gap between what the gates measure and what a human would critique.

## Key Metrics (Last 6 Runs)

| Run | Score | Finish? | Turns | Tokens | Duration | Key Issue |
|-----|-------|---------|-------|--------|----------|-----------|
| 149528fd | 74.2 | Yes | 227 | ~13.6M | 37 min | Over-saturated (P90=0.912, gate broken) |
| 801928cf | — | No finish | 155 | 7.8M | 17 min | Saturation gate crash (PJSR bug) |
| aab0d1c4 | — | No finish | 155 | 7.8M | 17 min | Same PJSR bug, agent lost |
| 0df723d8 | **84.4** | Yes | 276 | 18.3M | 35 min | Best run, but downstream desat |
| 65b3f1cd | — | No finish | 165 | 7.8M | 16 min | Never reached composition |
| a4f55e33 | — | No finish | 219 | 11.4M | 25 min | Stuck in desat loop |

## Questions for Review

1. **Tool discipline:** How do you enforce that an agent uses compound tools instead of primitive equivalents? Prompt engineering hasn't worked. Should we deprecate the primitive?

2. **Upstream iteration:** The agent consistently applies downstream corrections instead of iterating on upstream parameters. Is there an architectural pattern for "when gate X fails after tool Y, the ONLY allowed action is to adjust Y's parameters and re-run Y"?

3. **Turn budget awareness:** The agent has no concept of its remaining turn budget. Should we inject remaining-turn-count into tool results? Implement a "budget warning" at 150/200 turns?

4. **False-positive gates:** The ringing detector false-positives on natural edge-on galaxy profiles. Should we make gates category-aware (different thresholds per target type)? Or should the gate return more granular data that the agent can interpret?

5. **General architecture:** Is the 9-phase prompted structure too rigid? Would a simpler "process until quality gates pass" loop be more robust? Or does the phase structure help prevent the agent from getting lost?
