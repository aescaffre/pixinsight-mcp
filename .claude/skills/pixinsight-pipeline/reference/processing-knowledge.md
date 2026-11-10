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

## Galaxy grain at 1:1 (2026-10-31, Abell2151 96508fc1)
- Run passed every gate yet the user rejected it: galaxy halos ~2x grainier than the approved v9 output when zoomed.
- Causes: noisy L injected repeatedly (lrgb_combine + inject_luminance 0.20-0.25) and LHE/MSE run after the last NXT. A post-hoc NXT only removed ~8% of it.
- Rules: NXT goes after every local-contrast/sharpening step; if L is used, denoise L first and inject at <=0.15.
- `compare_to_reference` reports `grain_halo_ratio` / `grain_sky_ratio` (both images resampled to the same width); gate with `referenceGates.max_grain_ratio` (1.25 was used).

## Prep signal inventory + data-anchored galaxy gates (2026-11-07, M74)
- **Prep signal inventory** (`measureSignalInventory`, deterministic-prep, after the detail baseline). It runs on the deepest starless view (prep L, else RGB). It records into `prep-metrics.json` `inventory` and `brief._inventory`:
  - the subject centre;
  - the detection radius `rDet`: the last 25 px annulus whose arm-scale structure (p90-p10 of the sigma-8 luminance) stands >= 3 sigma above the sky's own texture;
  - the zones: core 0-0.08 rDet, disc 0.35-0.55, outer 0.8-1.0, sky +150..+250;
  - the prep core/disc index;
  - a hard-stretched preview (`diagnostics/inventory/`), scaled so the outer zone's p90 lands near 0.45. The overview and centre crop are attached to the agent's first message, with an "inventory" block of text.
- **Do not use the annulus median level for detection.** Averaged over thousands of pixels, any residual gradient reads as >5 sigma (M74: level said 1150 px, structure 750 px; the hand measurement on the linear master was about 750).
- **Finish gates** (galaxy_spiral profile):
  - `outer_arms.min_net_contrast` 0.04: outer-zone (p90-p10) minus sky-zone spread. M74 v3 0.018 (user: arms not visible), v4 0.080.
  - `core_preservation.min_ratio_vs_prep` 0.75: final core/disc index divided by the prep index. v3 0.86, v4 0.58 (whole disc lifted, flat and hazy).
  - Both are calibrated on M74 only, because the approved NGC4490/NGC3628 runs predate the inventory. Back-test when the next approved galaxy has a prep inventory.
- **The fine/blob and mottle gates now use the PREP disc radius** (`baselineDetail.scale.rDisc`). Lifting faint outskirts grows the final image's own radius and coarsens the bands. The change was small on M74 (v4 1.27 -> 1.24, still passing), so v4's softness is NOT captured by fine/blob. It shows up as a core/disc collapse.
- **Lesson:** a single "outer arms visible" gate makes the agent lift the whole disc. Pair it with a core-preservation gate.

## Operation -> metric impact matrix (2026-11-07, perturbation study)
- **Method:** one operation applied to M74 v3 final, with every metric measured. One image, one strength per operation: the signs are reliable, the magnitudes approximate. Script: session scratchpad `impact.mjs`.

| op | sat | fine/blob | mottle | core | outer | sky | separation | grain | chroma noise |
|---|---|---|---|---|---|---|---|---|---|
| K midtone lift | -9 | +4 | -9 | -12 | +33 | +37 | -4 | +35 | +34 |
| K S-curve | +20 | -2 | +9 | +15 | -15 | -22 | +18 | -19 | -14 |
| L masked outer lift | -17 | +5 | +2 | 0 | +230 | 0 | -9 | +2 | +12 |
| S or c saturation | +33 | 0 | 0 | -1 | 0 | 0 | 0 | 0 | +35 |
| NXT 0.30 | -1 | -2 | 0 | 0 | +1 | 0 | -1 | -10 | -31 |
| chroma smooth | -5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | -81 |
| USM | 0 | +9 | +3 | 0 | -1 | 0 | +7 | +50 | +4 |
| LHE r64 | -7 | +3 | +12 | -9 | +30 | +7 | -1 | +18 | +2 |
| HDRMT 5L | +11 | +5 | +57 | -24 | -4 | 0 | -12 | +14 | 0 |
| sky black point | +9 | 0 | 0 | 0 | +2 | -22 | +21 | +2 | +2 |

- **Order by blast radius:**
  1. global tone (7-8 metrics);
  2. local contrast (LHE/HDRMT, 5-6 metrics; HDRMT is the main source of mottle and core loss);
  3. masked outer lift (targeted, but it lowers saturation by 17%);
  4. sharpen and NR, as one stage (USM +50% grain);
  5. colour (S/c, chroma smooth, SCNR touch only saturation and chroma noise).
- **The saturation floor must be judged AFTER the tonal and local-contrast stages,** which move it by -17% to +20%. That explains v4's 9 UNDER-SATURATED failures.
- **Separation (tonal) is cheaply gamed by the sky black point** (+21%, sky -22%). Keep the sky-level gate next to it.

## Staged checkpoints + v5 loophole gates (2026-11-07)
- **`stage_checkpoint` tool** (tools.mjs `METRIC_STAGES`/`measureStage`), for tone -> local_contrast -> detail_noise -> colour:
  - It measures one stage's gates and records them in `brief._stageLocks`.
  - A finish failure on a gate that passed at its checkpoint gets a `[DRIFT: ...]` suffix naming the stage.
  - The order is advisory (agentic, not a hard-coded workflow). The prompt carries a STAGED METRIC ORDER section.
- **New galaxy_spiral gates.** Each was back-tested on the user references and the approved NGC4490/NGC3628:
  - `core_preservation.min_core_structure` 0.06: std(g1-g6)/level within 0.2 rDet. Refs 0.062-0.089, NGC4490 0.127, NGC3628 0.065, M74 v3 0.065; v5 0.053 (bright, featureless) fails.
  - `saturation.min_arm_p50` 0.10: arms = pixels above the 60th luminance percentile of their annulus. Refs 0.10-0.14, NGC4490 0.356, NGC3628 0.208. It replaces the subject-median floor when an inventory exists, because v5 met that floor by tinting the inter-arm gaps.
  - Inter-arm gap saturation in the refs is 0.06-0.13, so the bluish inter-arm haze is a HUE problem, not saturation. Not gated.
  - `texture_scale.min_ratio_vs_prep` 1.0: the final fine/blob must not fall below the prep L ratio. M74 v3 1.14, v4 0.96, v5 0.98.
  - The `max_fine_blob` 1.40 cap was removed. It came from Ha references, punished v3's knots (which the user liked), and pushed v4/v5 to soften.
- **Prompt size ratchet raised to 44100** (documented in the test).

## Envelope clip gate + gradient on stretched data (2026-11-08, M74 v6)
- **v6 (a47c7078) result:** core structure improved (0.072 vs v5 0.053) and detail is x1.04 of prep, but critic 6.3 (v5 7.0).
  - A one-sided "mask-like edge": the right sector of the outer glow is x0.004 of what prep L holds there. v4 had it at 0.11 and v5 at 0.06.
  - The HII knots are posterised flat periwinkle patches. The agent built a hand-made multi-scale LRGB PixelMath compositor with hard-coded sky constants and 100-250 px colour blurs.
- **Root cause of the edge:** the main agent ran `run_gradient_correction` on the STRETCHED L (`L_G`, `L_SG`) with the galaxy in frame, and the model absorbed the faint envelope on one side.
  - The agent did it because the stretch amplifies a 0.34% linear sky tilt (sector spread / sky on the linear L) into a visible ~5% gradient.
  - The gradient agent judged L "already flat" from absolute corner stddev (3.2e-5, about 1.3% of the 0.0025 linear sky).
  - ABE degree 1 on linear L barely changes the envelope but only partly removes the tilt.
- **New measurements:**
  - `measureEnvelopeSectors` (8 directions, glow excess in [0.9, 1.05] rDet over that sector's own sky ring) and `compareEnvelopeSectors`, final vs prep. The prep values are stored in `inventory.prepEnvelope`.
  - galaxy_spiral `envelope.min_sector_ratio` 0.3, evaluated only when the median glow is >= 0.005.
  - GC/ABE/per-channel-ABE on a stretched view now return an immediate envelope-by-direction verdict.
- **Not yet addressed:**
  - A relative (sky-normalised) L flatness criterion for the gradient agent.
  - A metric for posterised/flat knot colour.
  - The agent never calls `stage_checkpoint` (0 calls in v6).

### Linear L sky tilt must be judged in STRETCHED units (2026-11-08, M74 v4-v6 "brown one-sided edge")
- measure_color_gradient refuses mono views and measure_uniformity is an absolute 4-corner stddev: the M74
  linear L had a plane tilt of 1.8 % of sky across the full frame (corner stddev 3.2e-5 → "flat"), which the
  auto-stretch (target 0.10) turns into a 0.043 ramp (FLAT < 0.008, VISIBLE > 0.015).
- Consequence: the main agent saw the ramp after the stretch, ran GradientCorrection on the stretched L with the
  galaxy in frame, the model ate the envelope on one side; the RGB colour stayed there without luminance → muddy
  brown, "mask-like edge" (envelope_clip gate: right sector ×0.004 of prep).
- Fix: `measure_lum_tilt` (robust sky-plane fit on a 12x8 grid of cell medians, subject cells rejected as positive
  residuals, plane corners pushed through the auto-stretch MTF) and `subtract_sky_plane` (zero-mean 3-parameter
  plane, linear only; a plane cannot follow the subject). Gradient agent prompt v3 uses them for L. A pipeline
  safety net after the gradient agent subtracts the plane if ppStretched > 0.015 remains (trace event lum_tilt_autofix).
  On the cached M74 L: 0.0435 → 0.00006.

### Automatic stage checkpoints (2026-11-08)
- The agent never called stage_checkpoint (v6: 0 calls). Now the first main-agent call of a later-stage tool
  (LHE/HDRMT/MSE → local_contrast, NXT → detail_noise, S-curve/chroma_smooth/SCNR → colour, star blend → stars)
  on the working colour image measures every earlier unrecorded stage BEFORE the op and appends the report.
  ~35 s per stage; 108 s for three stages on M74 3000x2000.

### Cooked core and mask-shaped glow edge (2026-11-08, M74 v7; calibrated on 5 user reference JPEGs)
- Calibrate texture gates on the USER'S REFERENCE images (user: "work out on the jpegs, that's much better").
  Scales are fractions of rDet so JPEGs of any size compare; measureSignalInventory runs on a JPEG for centre/rDet
  (fails on multi-galaxy fields: the Leo Triplet picked a star).
- COOKED CORE = inverted core texture spectrum. measureCoreSpectrum: std(g_u-g_2u)/std(g_4u-g_8u), r<0.22 rDet,
  u=rDet/300. Natural cores have more structure at large scales: refs 0.68-0.86, NGC4490 0.68, v3 0.81, v5 1.03,
  v6 1.12; v7 1.69 (cells/worms). Gate core_cooked max 1.2. Blind metrics (all tried): trough depth p2/p5,
  coreWeber, structure-tensor coherence, kurtosis/sparsity, spot density, centre/ring concentration (the M74
  reference itself has a flat core, 1.12 vs v7 1.10), old ringing/detail-ratio/struct-halo checks.
- MASK-LIKE EDGE = the glow fades faster at its end than inside. edgeSteepening on measureSectorProfiles:
  sector-median profile, excess over far sky normalised at 0.6 rDet; log-slope 0.2->0.03 over 0.6->0.2.
  Refs 0.94-1.48, prep 0.46-0.53, v3 0.96, v5 1.50, v6 2.35, v7 4.59. Gate edge_softness max 2.5 (median of 8
  sectors must be a TRUE median: upper-middle element moved refs by up to +1.1). Fix = feather the outer lift
  past rDet (large mask blur / radial taper), never a plateau.
- The core_structure FLOOR (0.06) alone rewarded over-driving local contrast (v7 sat at 0.059 then cooked it);
  the spectrum cap now brackets it.

### Inter-arm haze = filled gaps, not hue; knot hue is Ha-limited (2026-11-08, M74; 5 user reference galaxies)
- Knot hue (bright compact disc features, sat > 0.10): our M74 versions are ~95 % BLUE (hue ~220°), 0-4 % violet:
  not lilac. Refs: 10-78 % pink-red, from their Ha masters. Pink knots need Ha data (user has none yet): NOT gated.
- Gap colour (p<=35 % of each annulus): our sat 0.04-0.08, slightly blue; refs 0.006-0.28 sat, neutral to bluer: inside range, NOT gated.
- Gap DEPTH separates: measureArmGapDepth median (p80-p20)/(p80-sky) over annuli 0.30-0.85 rDet (sigma 2u,
  star pixels skipped). Refs 0.38-0.88 (M74 ref 0.63), v3 0.45, v5 0.39, v6 0.33, v7 0.31 (each version filled the
  gaps more). Gate arm_gap_depth min 0.36 (tone stage).

### MultiscaleAdaptiveStretch A/B on M74 prep (2026-11-08)
- MAS (installed native process; ids targetBackground, aggressiveness, dynamicRangeCompression, contrastRecovery,
  scaleSeparation px 8-1024, contrastRecoveryIntensity, backgroundROI*, saturation*) runs from PJSR; prep option
  stretch.method "mas" (+ stretch.mas overrides), auto darkest-128px-block background ROI.
- At aggressiveness 0.7 / DRC 0.4 / contrast recovery 256 px vs SetiStretch: core structure L -34 %, RGB -28 %;
  core/disc index 2.32 vs 2.89 (flatter core); L gap depth 0.44 vs 0.47; edge/spectrum both natural. Visually the
  L core is flatter/hazier. DRC squeezes the galaxy core toward the disc: good for M42-type HDR, bad when the core
  must stay defined. Default stays Seti; untested: DRC 0.1-0.2, scaleSeparation 64.
- NXT frequency/colour separation ids (from the RC-Astro binary): enableFrequencySeparation, denoiseLf,
  frequencyScale, enableColorSeparation, denoiseColor, denoiseLfColor — exposed in run_nxt.

### M101 friend-data test (2026-11-08): what the M74-tuned pipeline missed
- EMPTY FOOTPRINT: drizzled L had zero corners. (1) the L tilt read 31 % of sky (corners = 0) and the post-gradient
  safety net subtracted a plane that CREATED a 14 % ramp, overriding a gradient agent that had correctly declined;
  (2) the signal inventory read sky = 0, so rDet = frame edge (2325 px instead of 1125) and the outer-zone / edge /
  arm-saturation gates measured empty sky. Fix: measureLumTilt drops empty cells (refuses < 60 % valid / < 12 sky);
  the net respects tool=none; all zone/sky/profile/gap measurements skip pixels within ~3 sigma of an empty pixel
  (EMPTY_PJSR helper); inventory sky blocks exclude zero blocks.
- FALSE REPAIR: check_saturation's static line "finish gate FAILS above 0.85" matched /FAIL/ -> every saturation
  check opened a repair; Ha injection was walked down 0.4 -> 0.3. Reworded + \bFAIL\b.
- HA KNOTS LOST: a global "cool hue shift" (chasing the reference's blue-violet palette) + chroma/brightness push
  turned the pink HII knots blue-white; the palette gate could not see it (tiny pixel share). New gate ha_knots:
  prep finds HII knots in the starless Ha (g1-g8 band-pass > max(p99.5, 6 sigma) within 1.1 rDet); finish measures
  the pink-red share (hue >= 290 or < 35, sat >= 0.10) at those pixels. Old results 0.079/0.107, variant_12 0.005,
  prep RGB without Ha 0.015 -> min 0.04. Armed only when Ha data exists.
- POST-GRADIENT TILT NET IS ADVISORY (2026-11-08): it auto-subtracted a sky plane twice against a correct gradient-agent
  decision (M101: zero corners; M81: the agent tried the plane, saw it follow IFN/halo structure at the bottom-right
  and widen the clean-corner spread, and reverted). It now only logs `lum_tilt_residual`. The agent owns the call.

### M81 HaLRGB full frame (run 8d9f420c, 2026-11-08)
- Inventory OK on a two-galaxy field: centre = M81 (brightest block), rDet 1450, M82 in the frame; Ha knots 10781 px.
  The hard-stretched L preview shows the IFN filaments clearly (data holds them).
- Result vs March (KEEP_SUPER, 30 March giga): M82 best of the three (crisp lanes, red Ha filaments, no posterised
  patches), arms crisp with pink-red knots on a clean dark sky; BUT the M81 nucleus is a flat white oval: the only
  failing finish gate (check_core_contrast relC 0.086 < 0.10). One finish call; the agent burned the rest of the
  540-turn budget on the core; the core specialist merge did not beat it -> best-variant fallback export.
- measureScaleBands used a pure-JS separable blur: with the M81+M82+IFN bright area the kernel reached ~240 px over
  16 MP and ran > 20 min single-threaded. Replaced by native Convolution (5 s; ratio 1.450 vs 1.482 on M74 v3).
- Next for bright cores: compress the core during the stretch (DRC) / large-scale contrast recovery, not more clamping.
- M81 run 2 (93ea1fea, core guard: prep core 0.2 % white instead of 14.4 %): passed ALL gates incl. core relC 0.170,
  but by COOKING the core (crunchy mottled bulge, near-black lanes; M82 lanes over-darkened); critic 5.2, worse
  than run 1. The core_cooked spectrum read 0.81 (inside the reference range): calibrated on M74-size cores, it does
  not transfer to a large bulge (rDet 1450, u = 4.8 px). LESSON (2nd time after M74 v7): a FLOOR on core contrast
  drives over-processing. Proposed: core relC gate advisory unless white-clipped; block white-clipping only;
  recalibrate the cooked-core metric on bulge-dominated galaxies.

### Core gates redesigned (2026-11-09 night, after M81 runs 1/2 — user: "this is deceptive")
- Calibration set (Python then PJSR): M74 prep + v3-v9, M81 run 1 (burnt white oval), run 2 (cooked bulge), KEEP_SUPER,
  30 March, 5 user refs, approved NGC4490. Candidate metrics that did NOT separate: peak brightness (refs 0.86-0.94),
  plateau area ratios, trough depth, core spectrum on a large bulge.
- WHAT SEPARATES:
  * cooked bulge = core fine-texture AMPLIFICATION vs prep (std of (g_s-g_4s)/(g_4s-sky), s = rDet/600, /300, r<0.22 rDet):
    M81 run 2 x9.3/x5.5; everything else x0.86-1.9 -> gate core_amp max 3.0 (measureCoreAmp; prep baseline stored in
    inventory.prepCoreAmp from the prep RGB).
  * burnt nucleus = WHITE nucleus: median HSV saturation of nucleus pixels > 0.9 x p99.9: refs 0.066-0.176, NGC4490 0.067,
    M74 0.11-0.21; M81 runs 0.014/0.019 -> gate nucleus_colour min 0.04 (measureNucleus).
  * M74 v7's cooked core = large flattened top; still caught by core_cooked (spectrum).
- core relC floor -> advisory for galaxy_spiral (core_burn.rel_contrast_blocking=false): it drove cooking twice.
- ROOT CAUSE IS PREP: M81's prep nucleus is already white (sat 0.010-0.024; M74 prep 0.061). MTF-type stretches bleach
  bright cores. Core guard ranks candidates by (no white clip) > (nucleus sat >= 0.04) > relC and now includes
  "colour core" candidates: Seti+HDR luminance, then the LINEAR R:G:B ratios rebuilt at that luminance where L > 0.35
  (full weight > 0.65) — ArcsinhStretch's colour-preservation principle applied only to the bright core.
- M81 run 3 (0bc9cb35) findings: (1) core_structure FLOOR 0.06 (M74-calibrated) unreachable on a smooth bulge (prep
  0.0028) without cooking (agent hit x10 core texture for 0.059, rejected it) -> floor = min(0.06, 3 x prep), M74
  unchanged (3 x 0.0195 = 0.059). Third time a floor drove cooking: every "minimum structure/contrast" gate must be
  relative to what the prep data holds. (2) PREP BUG: on a phase-1 cache hit, Ha was re-opened and centre-cropped
  WITHOUT registration (~150 px / 0.39 deg off -> false red blob by the nucleus, Ha-knot gate meaningless). Now
  StarAlignment onto the cached L/RGB; if it fails Ha is dropped. Earlier cached Ha runs (M81 2026-11-08 runs 1/2 used
  the cache) carried a misregistered Ha.
- Per-step metrics in action (run 3): the agent got 3 COOKED CORE warnings and backed off; composition held x0.98-1.14
  of prep core texture with nucleus saturation 0.24-0.26 (run 2 ended x9.3 / 0.019).
- Colour-core strength (2026-11-09 night): full colour preservation over-saturated the M81 nucleus (0.244 final / 0.253
  prep) AND turned M82's bright centre into an orange-red patch (the blend acts on every bright area, not just the
  subject nucleus) — runs 3/4. Core guard now tries strengths 0.5/0.3/1.0 and prefers the nucleus inside the refs' band
  0.06-0.18 closest to 0.12 (M81: 0.5 -> 0.140, 0.3 -> 0.090). Finish adds max_nucleus_sat 0.22.
- Run 4 (dff987b2, Ha aligned normally, relative core floor): finished with all gates (proper finish) but critic 5.2:
  orange nucleus, orange M82 centre, M81 inner disc HDR-flattened to featureless tan ("airbrushed"). The strong HDR
  knee (amount 0.5) trades inner-disc contrast for an unclipped nucleus; next lever: restrict the HDR knee / colour
  core to the nucleus zone instead of the whole bright range.

### M74 v10 (2026-11-10, run b505768f): fixed toolset, colour went wrong — critic 4.9 vs v9 6.2
- The fixed tools ran correctly; the agent misused them: `restrain_red_hue` 0.55 + SCNR 0.35 on LRGB data with NO Ha (stripped the warm tones),
  7 stacked saturation-raising S curves on the final view (lilac/magenta knots, 12% of the disc), and an arm mask made with
  `mask_ops` clip 0.44-0.56 after a 3 px blur (near-binary) blended at weight 1 (bright inner disc ending in a dark moat).
- Fixes: `restrain_red_hue` refused when the run has no Ha (and no narrowband); max 3 raising S curves per view (4th refused:
  go back to a checkpoint and apply ONE curve); `mask_ops` range windows < 0.3 are widened; new finish/colour-stage gate
  `palette_purity` (galaxy_spiral, no-Ha runs only): disc lilac (HSV 250-335°) <= 5%, teal (165-195°) <= 10% of disc pixels.
  Calibration M74 v3-v9 lilac <= 0.021, teal <= 0.046; v4 teal 0.148 (user: cyan haze); v10 lilac 0.120. PJSR ~1 s.

### M74 v10-v12 "brown dome" (2026-11-10): low-end saturation boost on the faint outer disc
- Traced variant by variant (run 91923ff9): the outer zone (0.6-1.0 rDet) was neutral at prep (warm 0.000) and after
  detail work (0.057); ONE S curve [[0.03,0.12],[0.06,0.2],[0.12,0.3]] (x4 on near-grey) took it to 0.505 warm, median
  saturation 0.022 -> 0.064. The faint outer disc has only noise-level chroma (R-B +0.002); boosting it creates false
  colour. The disc looked "cold" only by contrast with the brown around it (v9's disc is MORE cyan than v12's).
- Fixes: run_curves S caps the gain y/x at x2.5 for x < 0.06; new gate outer_zone (galaxy_spiral, native metric):
  outer warm share <= 0.15, outer/inner excess >= 0.04. Calibration: user refs warm 0.020-0.110, rel 0.021-0.128;
  v9 (user best) 0.005 / 0.064; v3/v5/v10/v11/v12 warm 0.31-0.51; v11/v12 rel 0.031-0.033.
- The existing edge_steepening gate did NOT see the "dome" (v11 0.92, v12 0.66): the dome was colour, not a profile cliff.

### M74 v16 violet-blue outer arm (2026-11-10)
- User: "the blue right hand outer arm is really terrible". Traced: sho_hue_saturation (an SHO palette tool) with
  magenta -0.8 / blue +0.3, then an "outer_blue" boost: outer blue p90 saturation 0.20 -> 0.375, vivid share 0 -> 5.5%.
- Fixes: palette-only tools hidden for broadband data (dataToolExcludes: no S/O -> no sho_*, no Ha either -> no
  continuum/dynamic/pseudo-OIII); gate outer_zone blue p90 S <= 0.30 and vivid (S > 0.35) <= 2% (refs 0.158-0.272 / <= 1.1%).
