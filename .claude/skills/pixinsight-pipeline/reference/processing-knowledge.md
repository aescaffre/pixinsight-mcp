# Processing Knowledge & Lessons Learned

## User Equipment (for SPCC)
- Sensor QE: Sony IMX411/455/461/533/571
- Filters: Astronomik Deep Sky R, G, B
- White reference: Average Spiral Galaxy
- Narrowband filters mode: OFF

## Iterative Processing Approach
1. Process step by step, checking JPEG previews at key stages
2. Adjust parameters adaptively based on what we see
3. Key checkpoints: after gradient removal, after color calibration, after stretch, after curves
4. Document each iteration with `iteration_XX.md` summary
5. Name config iterations: "TargetName Workflow (Iteration N - brief description)"

## Lessons Learned (from 29 iterations on Bubble Nebula)

### Star Processing — Linear Seti Method (Recommended)
- **Linear Seti extraction is the best approach**: SXT on linear data (stars=true), clip background, Seti MTF stretch (5 iterations, midtone=0.20), strong saturation boost, simple addition at 100%
- Produces tight, point-like stars without bloating (validated on Bubble Nebula, iteration 30a)
- Inspired by [Seti Astro](https://www.setiastro.com) (Bill Blanshan)
- **Seti MTF formula**: `MTF(m, x) = (1-m)*x / ((1-2m)*x + m)` — applied N times via PixelMath
- **Saturation MUST be applied AFTER stretch** — the MTF desaturates stars significantly
- **Use very aggressive saturation curve**: `[[0,0],[0.10,0.55],[0.30,0.80],[0.55,0.95],[1,1]]` — moderate curves are not enough
- **Simple addition at 1.00 strength** (not screen blend) — matches natural star appearance
- **Do NOT use star erosion/threshold**: MorphologicalTransformation + threshold creates ugly ring artifacts. Learned iterations 26-28.
- **Non-linear extraction (legacy)**: SXT unscreen on stretched checkpoint. Works but produces slightly bloated stars compared to the Seti method. Not recommended.

### SXT Limitation on Galaxy Fields (M81/M82, 7 iterations)
- **SXT cannot cleanly separate stars from large spiral galaxies**: HII regions, OB associations, and spiral arm knots in galaxies like M81 look like point sources to SXT. These residuals end up in the star frame.
- **Seti stretch amplifies residuals exponentially**: The MTF is applied N times — small residuals become multicolored blobs. The effect compounds with both lower midtone values AND more iterations.
- **Safe limits for galaxy fields**: setiMidtone >= 0.20, setiIterations <= 7. Going to m=0.15/9 iterations was catastrophic (v5). Even m=0.18/8 iterations showed visible contamination (v6).
- **Screen blend is essential for galaxies**: `screenBlend: true` — straight addition makes SXT residual rims visible around galaxy structure.
- **Consider skipping star removal entirely** for targets dominated by large spiral galaxies — the user's manual processing (no SXT) produced dramatically better results than any SXT-based iteration.
- **Best v7 main image params** (ignoring star issues): GHS D=1.0+0.6, LHE amount=0.35/slopeLimit=1.5, LHE fine r=24/amount=0.25/slope=1.3, HDRMT 7 layers, LRGB lightness=0.45.

### Ha Injection
- Three-part injection (conditional R + lum boost + detail layer) gives richest results
- `injectionStrength=0.65` is a good balance — higher risks overwhelming the broadband signal
- `haThreshold=0.3` catches filaments without adding noise
- `detailLayer=0.55` adds filament structure without artifacts
- Always use nebula mask (Ha-derived) with clipLow=0.04, blur=8

### Local Contrast
- **LHE is powerful but dangerous**: amount > 0.5 starts looking artificial
- **One LHE pass is usually enough**: dual LHE (structural + micro) combined with HDRMT = over-processed "designed" look
- **slopeLimit 1.8** is a good balance; 2.0+ risks artifacts
- **Mask blur matters**: softer mask (blur=10) gives more natural transitions
- **HDRMT**: good in theory but combined with LHE it's too much. Use one or the other.

### Stretching
- HT auto-stretch (STF-based) is reliable and predictable
- GHS refinement after HT: 2 gentle passes with adaptive SP (= current median)
- `targetBg=0.15` gives good background level for emission nebulae
- Re-measure median after each GHS pass — image statistics change

### Color Calibration
- SPCC with custom filter curves can produce purple/magenta backgrounds
- Copy astrometry from R channel to RGB composite before SPCC
- SCNR at 35% is a safe default for green cast removal
- ImageSolver doesn't work via eval (needs #include) — copy astrometry instead

### Pipeline Stability
- PixInsight crashes under memory pressure — close images aggressively
- Checkpoint system is essential for crash recovery
- Preview export at every step is invaluable for debugging
- Memory warning at 8GB, abort consideration at 15GB

### Over-Processing Signs
- "Designed rather than observed" look
- Transitions too clean between nebula and background
- Inner rim/core has "illustrated" appearance
- Loss of grain/texture in faint regions
- Solution: reduce LHE amount, disable HDRMT, use gentler curves

## Galaxy Processing (NGC 891 and similar)

### LRGB Workflow (No Ha)
- Set `files.Ha` to `""` — pipeline auto-detects `hasHa=false` and skips all Ha operations
- Disable all Ha branch steps + `ha_inject`
- Enable luminance branch: `l_stretch`, `l_nxt`, `l_bxt` (sharpen galaxy structure in L)
- Enable `lrgb_combine`:
  - Edge-on galaxies (NGC 891): `lightness: 0.35, saturation: 0.70` — lightness=0.50 washes out color
  - Face-on spirals (M81/M82): `lightness: 0.50, saturation: 0.70` — larger galaxies benefit from more L contribution
- V (Visual) filter maps to G channel — already handled by view identification regex
- **LinearFit L to RGB luminance BEFORE combine** — without this, L's different background level creates a "veil" effect. Config: `linearFitRejectHigh: 0.92`
- **Per-channel GC** (`perChannel: true`): apply BEFORE channel combination to equalize per-channel gradients

### Galaxy-Specific Settings
- **SPCC**: `whiteReferenceName: "Average Spiral Galaxy"` — matches galaxy spectral profile
- **Stretch targetBg**: 0.10 — standard for galaxies (darker than nebulae at 0.25)
- **L stretch targetBg**: 0.10 — match main stretch bg level
- **L BXT**: Enable with `sharpenNonstellar: 0.50` — galaxy luminance benefits from structure sharpening
- **SCNR**: 0.30 for edge-on, 0.35 for spirals — edge-on galaxies have more natural green component
- **BXT halo reduction**: Set `adjustStarHalos: 0.00` — negative values cause ringing artifacts visible BEFORE SXT, especially on galaxy fields. Clean star extraction handles halos better.
- **Star Reduction**: DISABLE — creates ring artifacts visible after recombination.
  - M81/M82: disabled from v2 onward after user spotted artifacts
  - NGC 891: disabled — screen blend + clean extraction is better
  - No exceptions for galaxy fields; dense star field cases are better handled with gentle screen blend

### Per-Channel Gradient Correction (CRITICAL for LRGB)
- **Always use `perChannel: true`** for multi-channel datasets. Different filters/nights produce different gradients per channel — combined-image GC cannot fix per-channel color gradients.
- Phase 0c applies GradientCorrection to R, G, B, L individually BEFORE channel combination.
- M81/M82: R had 5x worse gradient than G (0.000010 vs 0.000003). Per-channel GC equalized all channels to 0.000002.
- Has baseline guard: reverts if GC makes uniformity worse for any channel.
- Post-stretch GC (`gc_post`): unreliable — corner-sampling metric breaks on non-linear data. Leave disabled.

### HDR Headroom (Preventing Core Clipping)
- **L channel headroom: 0.10** (max pixel ~0.935) — gives HDRMT 5-7% working room in bright cores.
- **RGB headroom: 0.05** (max pixel ~0.968) — less aggressive, preserves color fidelity.
- **0.15 over-compresses**: creates a "uniform patch" on galaxy cores where structure should be visible.
- Config params: `hdrHeadroom` in `l_stretch` and `stretch` step params.
- HDRMT cannot recover already-clipped data. If cores are pure white after stretch, HDRMT creates ringing artifacts. Headroom prevents this.

### Mask Gamma for LHE/HDRMT (CRITICAL)
- Luminance masks for LHE and HDRMT **MUST use gamma compression** to protect bright galaxy cores.
- **Without gamma**: bright cores saturate to 1.0 in the mask, so LHE/HDRMT apply at full strength uniformly across the core, flattening detail into a featureless patch.
- **With gamma**: the bright end is compressed smoothly (e.g., 0.9 -> 0.81, 0.5 -> 0.25), preserving gradual mask falloff through the core.
- Formula (PJSR has no `pow()`): `exp(gamma * ln(max(rescaled, 0.00001)))`
- **LHE maskGamma: 2.0** — stronger compression because LHE is more destructive on cores.
- **HDRMT maskGamma: 1.5** — lighter compression because HDRMT has its own built-in luminance mask.

### Hue-Selective Saturation (hue_boost step)
- Replace blanket `galaxy_saturate` with targeted `hue_boost` step for natural galaxy color.
- Boosts blue spiral arms (blueBoost: 1.30) and pink HII regions (pinkBoost: 1.25) while leaving golden galactic bulge tones at 1.0.
- PixelMath formula: `lum + factor * (channel - lum)` where `factor` depends on hue classification.
- Hue classification uses R/G/B ratios to identify blue-dominant, pink/magenta-dominant, and neutral pixels.
- Produces more natural color than a blanket saturation curve, which over-saturates the already-warm galactic bulge.

### Shadow Darkening
- Use a lightness curve targeting only true background, with a gentle transition.
- Validated curve points: `[0.05, 0.003], [0.10, 0.015], [0.15, 0.05]`
- **Too aggressive darkening** (e.g., mapping 0.22 -> 0.10) crushes galaxy mid-tones and kills the core-to-arm luminosity gradient. Keep the transition gentle.

### Channel Color Boost
- Fine-tune residual color cast after SPCC and per-channel GC.
- M81/M82 (Astronomik R/G/B + IMX411): G x 0.94, B x 1.12 compensates for golden/green cast from filter transmission curves.
- Per-channel GC fixes actual spatial gradients; channel boost fixes global residual color cast.
- Apply via PixelMath on individual channels.

### Detail Enhancement for Galaxies
- **HDRMT**: Essential for recovering galaxy core detail. Uses luminance mask (auto-created from main image when no Ha available).
  - Edge-on galaxies (NGC 891): 6 layers, 1 iteration
  - Face-on spirals (M81/M82): L channel: 6 layers, 3 iterations, maskClipLow=0.20. Main RGB: 7 layers, 3 iterations, maskClipLow=0.10
  - `toLightness: true` for color images (preserves color, processes only L* in CIELab)
  - **Always use maskGamma** (see section above) to prevent core flattening
- **LHE structural** (radius=64):
  - Edge-on galaxies: `amount: 0.25, slopeLimit: 1.3` (very conservative)
  - Face-on spirals: `amount: 0.35, slopeLimit: 1.5` (can tolerate more)
  - **Always use maskGamma: 2.0** to protect bright cores
- **LHE fine**: Generally disable for galaxies unless specific micro-contrast needed
- **NXT Final**: Always enable after LHE/HDRMT — **denoise=0.30** (not 0.40). Higher values over-smooth the detail that LHE/HDRMT just recovered.
- **GHS passes**: Gentle — D=0.6 midtone boost + D=0.3 fine contrast (B=-1.0/-1.5)
- Edge-on galaxies (NGC 891): dust lane revealed via careful stretching + gentle HDRMT + subtle LHE
- Face-on spirals (M81): GHS D=1.0+0.6, LHE amount=0.35, HDRMT 7 layers

### Galaxy vs Nebula Key Differences
| Setting | Nebula | Galaxy (edge-on) | Galaxy (face-on spiral) |
|---------|--------|------------------|------------------------|
| targetBg | 0.25 | 0.10 | 0.10 |
| LRGB lightness | 0.50 | 0.35 | 0.50 |
| LRGB saturation | 0.50 | 0.70 | 0.70 |
| LHE amount | 0.50 | 0.25 | 0.35 |
| LHE slopeLimit | 1.5 | 1.3 | 1.5 |
| LHE maskGamma | n/a (Ha mask) | 2.0 | 2.0 |
| HDRMT layers | off or cautious | 6 layers / 1 iter | 6-7 layers / 3 iter |
| HDRMT maskGamma | n/a | 1.5 | 1.5 |
| L BXT | usually off | enabled | enabled |
| SCNR | 0.35 | 0.30 | 0.35 |
| GHS passes | more aggressive | gentle (D: 0.4-0.7) | moderate (D: 1.0+0.6) |
| BXT adjustStarHalos | 0.00/-0.25 | 0.00 | 0.00 |
| Star Reduce | off | off | off |
| NXT Final | off | 0.30 | 0.30 |
| Per-channel GC | optional | recommended | **critical** |
| HDR headroom (L) | 0 | 0.10 | 0.10 |
| HDR headroom (RGB) | 0 | 0.05 | 0.05 |
| Saturation method | curves | curves | hue_boost (selective) |

## Quality Assessment Checklist
1. **Background**: Clean, dark, no gradients or color casts?
2. **Stars**: Natural shapes, no halos, good color variety?
3. **Nebula structure**: Visible filaments, dust lanes, density variations?
4. **Tonal range**: Good separation between bright core and faint outer regions?
5. **Color**: Natural emission colors, no over-saturation?
6. **Noise**: Controlled without smearing detail?
7. **Overall feel**: "Observed" not "processed"?

## Star contract (WI-04, 2026-10-28)
- One source per class: `processing-profiles.json` `stars.*` (prominence, stretch_midtone/iterations, screen_blend_strength, core_threshold_low/high, min_strength_fraction). The classifier derives `starProminence`/`starPresence` from it; the giga prompt renders a single STAR CONTRACT block; the finish gate reads `STAR_CONTRAST[prominence]` from gate-contract.mjs.
- `star_protected_blend` resolves thresholds agent > profile > default (0.60/0.82/0.10) and reports the source; `screen_blend_strength` is a cap for ANY class that defines it (galaxy_spiral 0.95 now; the user asked for MORE prominent galaxy stars). Clamps print `PROFILE CAP (<class>): ...` and are traced as `profileCaps`.
- PNe defaults 0.75/0.95/0.50 (M27 1a3cc341, M97 e8834489); emission 0.55/0.75/0.10 (NGC7635 6d0b2048, bc93d9d1); reflection 0.55/0.70/0.0.
- Prep stars are LINEAR (stats.stars.median ~1e-5..1e-4). The agent must call stretch_stars first; non-linear input is refused.

## Core contrast gate: relC advisory for structured cores (WI-17)
- `measureCoreContrast`: low relContrast (< rel_contrast_hard) is only a warning when the core is demonstrably structured (coreStructFrac >= 0.80, haloFrac <= 0.03, not white-burnt). White burn always blocks. Profile-supplied `min_struct_frac`/`max_halo_frac` remain blocking (do not re-introduce the f3a5a44 starvation).
- Built-in 0.80/0.03 calibrated in 7ae7ef8 (pass: iter03 97.5/0.3, best-of-both 95.7/0.5; fail: flat-core 45.7/12.3, blown-halo 81.9/6.1).
- Caveat: struct uses an absolute grad>0.012 test and can count noise on a 60 MP galaxy bulge. galaxy_* `core_burn.rel_contrast_hard` 0.10 is PROVISIONAL until backtest-gates.mjs runs on approved galaxy images.

## Detail metric (WI-18): credible, star-rejected, baseline-relative
- `measure_subject_detail` samples ALL subject blocks (stratified, <=50), rejects star windows (3x3 max > blockMedian+0.25 or any pixel > 0.85) and star-dominated blocks, and measures a self-calibrated noise floor (Sobel energy of the darkest background blocks, same kernel/stride).
- Outputs: `detailRaw` (= legacy `detailScore`, hard gate 0.001 unchanged), `detailCredible` (mean of max(0, E_block - E_noise); optimise this), `detailWeber` (E / blockMedian^2; used for gain), `noiseDominated` (raw/credible > 2.5 = grain, not structure).
- Prep baseline: `brief._baselineDetail = {rgb, l, max}` + `prep-metrics.json` in the run dir (copied on `--base-run`). Finish compares gain = weber(final or pre-star-blend starless) / baseline (`max` for LRGB, `rgb` for RGB-only; ratio, 1.28 = +28%) with profile `detail.max_gain` - ADVISORY, all values PROVISIONAL (galaxy_spiral 1.6, edge_on 2.0, emission 3.0, reflection 2.0, cluster 1.5). Promote to blocking only after the back-test harness measures the confirmed NGC3628 approved image (+28% must pass) and PACMAN LIFT5; M81 v11 (+76%) implies galaxy_spiral needs >= 1.9.
- `check_sharpness` now delegates to this measurement (ROI supported); the ledger 'detail' dimension uses detailCredible*100 + contrast*0.1.
- Not yet validated against live PixInsight data (PI was unavailable).

## Ledger and cross-run learning (WI-19)
- Ledger key = classification for broadband, `classification@workflow` for narrowband (e.g. `emission_nebula@SHO`); `ledgerKey(brief)` in agents/ledger.mjs.
- `save_variant` takes `stage` (base, branch_detail, branch_ifn, branch_color, branch_stars, branch_palette, branch_core, composition, final) and `approach` (token array). Only composition/final variants count as "tried"; runs without a final-selection record nothing.
- Champions carry `scoreVersion` (CHAMPION_SCORE_VERSION=2); mismatched champions are ignored and replaced. ifn_visibility uses measured dust (coverage*2 + meanSat + 0.25*min(fieldP95,0.5)) when available; weights are PROVISIONAL until back-tested on NGC7023 iter03 / best-of-both vs the regressed 4bbeec17 output (needs PixInsight).
- Removed: updateProcessingProfile / `learned_overrides` and the "Winning Parameters from Previous Runs" prompt block (recall_memory returns the same buckets). A passing finish saves numeric params_summary keys as hierarchical-memory entries tagged `auto`,`finish_params` (not `winning_param`).

### Star-field metric (WI-16, ADVISORY, provisional)
- `measureStarField` (agents/ops/quality-gates.mjs; attached as `starField` on `check_star_quality`): ES5 scan, no StarDetector. Hill-climbs to the peak, skips saturated plateaus (>0.98), rejects nebula knots (neighbours at +/-8 px, or +/-FWHM for bloated stars, >= 0.6x peak above the 6-8 FWHM annulus background), local-background half-max walk up to 31 px (the old r<=10 walk silently dropped bloated stars), second-moment ellipticity (SNR>20, blends rejected), 3x3-mean colour diversity, centre/edge split (centre = 0.55 x half-diagonal, override `gates.stars.center_radius_px`), absolute prominence (peak - localBg).
- `star_protected_blend` records `brief._starPeaks` from the linear star layer; finish re-measures those coordinates on the final view.
- BLOCKING gates are unchanged: whole-image `medianPeak/bgMedian` contrast and median FWHM (old walk). Note the contrast gate structurally conflicts with the 0.65 rolloff knee at target_median >= 0.20. Ellipticity 0.25, dark ring 5% of prominence, FWHM advisory 8 px are provisional until `scripts/backtest-gates.mjs` confirms them; the galaxy FWHM exemption stays until NGC891/M81 champions pass with knot rejection.
- The ledger champion record stores the measured star field (`rawMetrics.stars.starField`).

## PNe HDRMT (prompt consistency pass, WI-09)
The old "global unmasked inverted HDRMT (4 layers)" mandate for planetary nebulae is gone. Validated option (a TRY in the branch phase): luminance mask (clip_low=0.10, blur=10, gamma=2.0) -> donut `$T*(1-$T)*4` -> apply_mask -> run_hdrmt (inverted, 5 layers, 1 iteration) -> remove_mask -> check_ringing (0 oscillations) + measure_subject_detail. 7 layers is rejected. Keep only if detail rises and the 2x contrast gate still passes (M97 +173%; the M27 v10 winner used no HDRMT). Five rules replace the old v7-v12 failure list: no clamp = core burn; one global clamp = halo loss; HDRMT through a small-blur core zone mask = rings; clamp-before-stars then screen blend re-burns (clamp after the blend or use star_protected_blend); discrete zone-mask clamping = dark rims (use continuous_clamp).

## compare_to_reference metrics (WI-21)
- `bg_cast_delta`: dE on a*b* between the two images' dark-cell median RGB (Lab converted directly). `color_emd` is a deprecated alias (bg_cast_delta/100); the old residual-then-Lab version was ~0 by construction and never discriminated, so it no longer blocks.
- `palette_l1` (0..2): L1 distance of hue-family fractions over subject pixels with HSV saturation >= 0.08 (`sat_frac_*` reports the saturated fraction). ADVISORY above 0.35.
- `lab_emd`: chroma-only sliced-Wasserstein (24x24 a*b* histogram over [-60,60], 8 angles, own dark-cell bg subtracted, <=50k subject pixels). L* excluded on purpose so a differently stretched user PNG does not dominate. ADVISORY above 12. PROVISIONAL: promote only after backtest (pacman_lift5 vs itself ~0, vs pacman_iter01 above thresholds, ngc7023_best_of_both vs ngc7023_iter03 passing).
- `ms_ssim`: both images resampled to ~1500 px wide (MitchellNetravali); skipped when aspect ratios differ >1% (then `lum_cdf_dist`, a 9-decile subject luminance distance, is the geometry-free structure proxy). Peak extra PI windows: 2 (reference + temp target duplicate), all closed in finally.
- Finish Gate 12 blocks only on `coverage_delta` > 0.30.

## Prep BXT sharpen / Seti HDR are profile-driven (WI-23)
- `deterministic-prep.mjs` reads `processingProfile.tools.BXT` ({correct_only, sharpen_nonstellar}); the sharpen step (RGB, L, Ha) runs only when `correct_only === false`, strength default 0.70. `stretch.hdr_amount`/`hdr_knee` (default 0.25/0.35) feed `setiStretch`.
- All 13 classes ship `correct_only:false, sharpen_nonstellar:0.70`, hdr 0.25/0.35 = the baseline every approved image was produced with. PSF study (2026-10-28) found correct-only most faithful; lower per-class values must be back-tested on the approved image before shipping (see `_bxt_calibration`).
- Prep records `result.applied` [{step, view, params}]; giga-run prints it as "Prep recipe already applied (do not repeat)". Running `run_bxt` with correct_only=false afterwards is a double-sharpen.

## WI-26 advisory metrics (2026-10-28, all ADVISORY until backtest-gates calibrates them)
- **Banding (finish Gate 13)**: `measure_color_gradient` now also returns `band {axis,index,amp,channel,stepMax}` (per column/row MEAN chroma over background cells, least-squares line removed: a ramp = gradient, amp~0; a localized step = band) plus `cornerLumDelta`/`cornerChroma` (4-corner medians). Needs >= `min_bg_cells` (12) background cells else `insufficientBg`. Profile `gradient:{warn:0.012, block:0.020, band_block:null, min_bg_cells:12, blocking:false}`; warnings unless `blocking:true`. Fix a band on the FINAL image: `mask_ops` outer-field mask (inverted) then `run_per_channel_abe` poly_degree=1 with `mask_view_id` (ABE ignores an applied mask; the tool blends back via PixelMath), or redo the last lift_dust/inject_l_ifn with a gentler taper. Never re-run the linear gradient stage. Calibration images: ngc7023_best_of_both (green band at left) vs ngc7023_iter03 (clean).
- **Chroma noise / mottle**: `measure_chroma_noise` (6x6 patches, clean/dust bands; Ca=R-L, Cb=B-L; chromaNoise, chromaToLumNoise, mottle16, mottle48; no sigma^2/64 correction because NXT correlates noise). Profile `noise:{max_chroma_to_lum:null,max_mottle48:null}` - warnings only when set. Remedy: chroma_smooth sigma 6-8 through the halo/dust mask or lift less upstream; never global desaturation.
- **Highlight-texture baseline**: prep stores `brief._roi` + `brief._baselineTexture {rgb,l,ha}` (+ `baseline-texture.json`); star_protected_blend stashes `brief._preBlendTexture` of the STARLESS input. Finish no longer opens any variant XISF; retention thresholds come from profile `highlight_texture.min_retention/warn_retention`; baseline-relative failures are warnings unless `highlight_texture.blocking:true`.
- **PSF field map**: `measure_psf_field` (LINEAR data; 2x binned detection + full-res moments, one temp window closed in finally) gives per-cell FWHM/ellipticity/orientation/skew, L/R and T/B asymmetry, verdict (uniform | radial coma | asymmetric - check tilt/backfocus at ratio >= 1.5) and a `crop_box` suggestion for the USER's crop (never crop the starless deliverable). Prep records before/after BXT-correct maps (`brief._psfPrep`). Not a gate.


## Background-floor gate (2026-10-29, user-approved) and what the "crushed to black" measurements showed
- New finish gate `background_floor` (tool `check_background_floor`, metric `measureBackgroundFloor`: 64-px background blocks, sky level = median of their medians, black fraction = blocks < 0.015). Blocking where `processing-profiles.json` carries calibrated `background.min_level` / `max_black_fraction` (emission 0.050, galaxy 0.045, reflection 0.062, PNe 0.032; black <= 5%), advisory elsewhere.
- Measured facts: approved skies sit at 0.056-0.081 (M97 v8 0.106). The 2026-10-29 PACMAN rerun was genuinely darker (0.044) and fails the new gate; the galaxy reruns were NOT darker (NGC4490 v8 0.068, NGC3628 v8 0.079) — their "flat pale" look is LOW SATURATION (p90S 0.30 vs 0.46 for the accepted NGC4490 RGB), so a crushed-sky gate cannot catch it. Candidate next gate: a per-class saturation FLOOR (approved galaxies 0.37-0.46).
- `star_retention` (star density) stays ADVISORY: the detector threshold (bg + 5 MAD) adapts to each image's noise so counts are not comparable across processings, and `colorDiversity` reads 0 on the accepted NGC4490 RGB because its 30 brightest stars are saturated white. Fix the detector (fixed absolute threshold, exclude saturated stars) before calibrating.

## Borrowed / externally integrated masters (2026-10-29)
Config flags in `files`: `pixelScale` (arcsec/px seed for the plate-solve fallback; else derived from FOCALLEN/XPIXSZ), `forceAlign: true` (StarAlignment of every channel to R even when dimensions match — prep otherwise skips alignment and separately integrated channels keep red/cyan star fringes), `distortionCorrection: true` (StarAlignment distortion model). Prep's SPCC now runs with generateGraphs/StarMaps/TextFiles=false: the graph WebView failed on a 104 MP image and failed the whole process.
