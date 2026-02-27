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
