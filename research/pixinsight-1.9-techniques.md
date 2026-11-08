# PixInsight 1.9.x: new tools and techniques for the current galaxy defects

Research date: 2026-11-08. Machine audited: PixInsight 1.9.5 build 1706 (module binaries dated 28 Sep 2026), macOS arm64, RC-Astro unified suite with BXT AI4 / NXT AI3.1 / SXT AI11 models.

## How to read the evidence tags

- **[PRIMARY]**: official PixInsight article, official tool documentation (online, or the local docs under `/Applications/PixInsight/doc/`), or the RC-Astro / GHS author pages.
- **[BINARY]**: a parameter identifier I read from the string table of the installed module (`strings` on `/Applications/PixInsight/bin/*-pxm.dylib`). The identifier exists, but which UI control it belongs to is my inference from neighbouring strings and from the docs. Before relying on one, check it once in the watcher with something like `var P = new MultiscaleAdaptiveStretch; console.writeln(P.targetBackground);`. Do **not** `for-in` over a process prototype (that crashes PI, per project memory).
- **[FORUM]**: community opinion from Cloudy Nights, AstroBin, blogs or magazines.
- **[SYNTHESIS]**: my own recipe, built from the sources above and aimed at this pipeline's defects. Not validated on M74 data.

---

## 1. Executive summary: top 10 items, ranked by expected impact

| # | Action | Defects | Effort | Evidence |
|---|---|---|---|---|
| 1 | **Use MultiscaleAdaptiveStretch (MAS) as the stretch for L and for RGB.** It is already installed (`MultiscaleAdaptiveStretch-pxm.dylib`). Its built-in dynamic-range compression and multiscale contrast recovery (a variant of MMT) give a compressed core with intact fine detail, without small-radius LHE or HDRMT. The official article says it avoids the composition mismatches seen in LRGB work. Use a Background Reference ROI because M74 fills much of the frame. | 1, 2, 3, LRGB mismatch | Low: new op wrapper | PRIMARY + BINARY |
| 2 | **Replace thresholded "lift through mask" with self-weighted lifts**: GHS-style intensity curves (SP at the faint-disc level, LP at sky), or "add back the smoothed large-scale component" (`$T + k*LS`). The image is its own continuous mask, so there is no plateau and no cliff. | 2 | Low (PixelMath) | PRIMARY (GHS docs, M27 halo tutorial) + SYNTHESIS |
| 3 | **Core dust lanes: move detail recovery to linear deconvolution plus ringing-free, larger-scale operators.** Use BXT nonstellar, MAS contrast recovery, MMT on layers 3-5 with `medianTransform=true` HDRMT (6-8 layers, 1 iteration, blended at 0.3-0.5). Add "dark structure" enhancement of lanes (DarkStructureEnhance algorithm). Ban LHE kernels below ~64 px on the core. | 1 | Medium | PRIMARY (docs) + FORUM + SYNTHESIS |
| 4 | **Kill low-frequency mottle before any local contrast step** with NXT frequency separation (`enableFrequencySeparation`, `denoiseLf`, `frequencyScale`) and colour separation (`enableColorSeparation`, `denoiseColor`, `denoiseLfColor`). The pipeline does not use these today. The "worm/cell" pattern is largely amplified mid- and low-frequency residual noise. | 1, 3, 4 | Low | PRIMARY (RC-Astro manual) + BINARY + FORUM |
| 5 | **MultiscaleGradientCorrection (MGC) + MARS DR2 for the mono-L tilt.** DR2 includes L (up to 18x deeper than one master) and covers the northern sky, so M74 at Dec +15.8 is covered. MGC models the gradient against an external reference, so a frame-filling galaxy is not mistaken for background. It needs an ImageSolver solution and SPFC flux metadata. The MARS `.xmars` file is **not installed** and needs a PixInsight account download. | 5 | Medium (data install + 2 new ops) | PRIMARY + BINARY |
| 6 | **Inter-arm gaps: dark-structure enhancement plus large-scale local-background subtraction** at roughly 2-4x arm width (MLT/MMT layers 5-7, i.e. 32-128 px), instead of global black point or small LHE. MAS contrast recovery with a smaller Scale separation (128-256 px) does the same thing during the stretch. | 3 | Medium | PRIMARY (DSE script, MAS docs) + SYNTHESIS |
| 7 | **Colour: keep SPCC's "average spiral galaxy" white reference.** The SPCC docs name M74 as the representative galaxy of that reference. Then saturate with chroma-only, lightness-masked tools: MAS Color Saturation with lightness mask, CurvesTransformation S, or the LabColorBoost script. Do NOT blur chroma; denoise chroma with NXT colour separation instead. | 4 | Low | PRIMARY |
| 8 | **MLDenoise (native, CoreML GPU on Apple Silicon)** as a second denoiser with a built-in brightness-dependent local-support mask (`maskClipLow`, `maskBackground`, `maskSmoothness`). Recommended on linear, colour-calibrated data. Its `.xmlm` model is **not installed**. Early forum reports call it slower than NXT and sometimes more artefacty, so A/B it against NXT. | 1, 3, 6 | Low-Medium | PRIMARY + BINARY + FORUM |
| 9 | **Install the native GHS process** (repository `https://www.ghsastro.co.uk/updates/`, native on arm64 since PI 1.9.4) to replace the PixelMath fallback. You get LP/HP protection, Lightness (CIE L\*) and Saturation colour modes, and 32-bit RTP. PJSR parameter names are unknown until it is installed (read them from the dylib, as done for MAS). | 2, 3 | Low | PRIMARY (GHS FAQ/docs) |
| 10 | **Consider upgrading to PI 1.9.6** (30 Oct 2026). It brings MultiscaleTGVDenoise (TGV with a Deep-Sky section and local support), MGC improvements (automatic scale factors, edge correction, zero pixels as no-data, batch/server modes), BlindSolver, and ImageAnalysis. Also use 1.9.5's **PJSR `Parallel`** (`Parallel.forImageRows()` and others) to speed the pipeline's pixel-loop measurements. Optional: **BXT ML5** (paid upgrade, needs unified module >= 2.6.5) handles extreme dynamic range and small faint galaxies better. | 1, 6, speed | Medium (manual install) | PRIMARY |

---

## 2. New in PixInsight 1.9.x

Release timeline [PRIMARY: pixinsight.net/dev article index]:

- 1.9.0: Dec 2024. MGC and MARS DR1. [secondary: ScopeTrader, 21 Dec 2024]
- 1.9.3: 28 Feb 2025. MAS shipped as an update on 30 Dec 2025, then MAS 1.1 on 27 Jan 2026.
- 1.9.4: 12 May 2026. Native arm64 and the V8 runtime.
- MLDenoise preview for arm64: 23 Jun 2026.
- MARS DR2: 21 Jun 2026.
- 1.9.5: 18 Sep 2026. Builds 1705 and 1706 followed on 26 and 28 Sep.
- MLDenoise model v42: 6 Oct 2026.
- 1.9.6 build 1713: 30 Oct 2026.

### 2.1 MultiscaleAdaptiveStretch (MAS): installed

- **What it is** [PRIMARY: local doc `doc/tools/MultiscaleAdaptiveStretch/MultiscaleAdaptiveStretch.html`; Peris, "The MultiscaleAdaptiveStretch Tool", 30 Dec 2025]. A delinearization tool, i.e. a replacement for STF->HT. It combines:
  - robust statistical shadows clipping;
  - an adaptive stretch of high-contrast structures (dynamic range compression);
  - optional multiscale contrast recovery, "using a variant of the MultiscaleMedianTransform algorithm";
  - optional HSV saturation boost with background chroma-noise protection.
- **Input**: linear, colour-calibrated (SPCC first), 32-bit float, grayscale or RGB.
- **Algorithm credits**: Vicent Peris, implemented by Roberto Sartori.
- **LRGB**: the article says the embedded compression avoids "composition mismatches seen in LRGB work". This relates directly to the pipeline's `feedback_lrgb_median_mismatch`.
- **Galaxies**: the docs recommend Contrast Recovery for galaxies, with Scale separation 512-1024 px so that galaxy arms count as protected structure.
- **Large objects**: when the target occupies a large part of the frame, enable Background Reference on a small dark ROI, and lower Contrast Recovery Intensity if it over-processes.
- **HDR targets**: disable Color Saturation, then run HDRMT, then a CurvesTransformation S curve.

| UI parameter | PJSR id [BINARY] | Range / default [PRIMARY doc] |
|---|---|---|
| Target Background | `targetBackground` | [0, 0.5], default 0.15. Use 0.10-0.20 normally, 0.25-0.40 for frame-filling objects (article). |
| Aggressiveness | `aggressiveness` | [0, 1], default 0.7. Shadows clip point; higher means more noise. |
| Dynamic range compression | `dynamicRangeCompression` | [0, 1], default 0.4. 0 means a pure MTF. 0.4-0.7 suits most targets. |
| Background Reference enable / ROI | `backgroundROIEnabled`, `backgroundROIX0`, `backgroundROIY0`, `backgroundROIWidth`, `backgroundROIHeight` | Defaults 0, 0, 100, 100 |
| Contrast Recovery (enable) | `contrastRecovery` | Recommended on for most images |
| Scale separation | `scaleSeparation` | Doc says "[8, 1024] px, default 1024", but also "default value of 7 (128 pixels)" and "increase to 9". **The stored value may be a dyadic layer index. Verify by reading the default in PJSR.** |
| Intensity (MAS 1.1) | `contrastRecoveryIntensity` | [0, 1], default 1.0. Lower it when it over-processes. If you raise it, lower Aggressiveness (article examples: 0.9 / 0.8 / 0.7). |
| Preview large-scale component | `previewLargeScale` | RTP only |
| Color Saturation (enable) | `saturationEnabled` | |
| Amount | `saturationAmount` | [0, 1], default 0.75. Start at 0.6-0.7, or 0.4 for a natural look (forum). |
| Boost | `saturationBoost` | [0, 1], default 0.5. Higher values favour low-saturation pixels. |
| Lightness mask | `saturationLightnessMask` | Limits the boost in dark areas (Starlust guide) |

- **Process id**: `MultiscaleAdaptiveStretch` [BINARY, module name]. ES5 sketch:

  ```js
  var P = new MultiscaleAdaptiveStretch; P.targetBackground = 0.12; P.aggressiveness = 0.6; P.dynamicRangeCompression = 0.55; P.contrastRecovery = true; P.contrastRecoveryIntensity = 0.7; P.backgroundROIEnabled = true; /*ROI*/ P.saturationEnabled = false; P.executeOn(view);
  ```

- **Caveat** [PRIMARY]: Contrast Recovery depends on image size, so do not tune it on small previews. In 1.9.5, the MAS RTP is 32-bit float, which fixes earlier posterization.
- **Context** [FORUM, AstroWhat]: Seti Astro's Statistical Stretch script is no longer updated because MAS supersedes it.

### 2.2 MLDenoise (MachineLearning module): installed, model NOT installed

- **What it is** [PRIMARY: "Technology Preview: MLDenoise for macOS ARM64", Conejero, 23 Jun 2026; "PixInsight 1.9.5 Lockhart Released", 18 Sep 2026]:
  - neural-network deep-sky noise reduction with tiled ONNX inference;
  - CPU or GPU backends: CUDA, or CoreML on macOS (automatic);
  - models are `.xmlm` files from the PixInsight distribution system, selected in Preferences (wrench);
  - recommended on **colour-calibrated linear** images.
- **Local Support**: an inverted brightness mask with sigma clip-low, a background level (default 0.25) and median smoothness (1-4 px typical). Real-time preview is in 32-bit since 1.9.5.
- **PJSR ids** [BINARY, `MachineLearning-pxm.dylib` 1.0.6]:
  - `modelPath`, `overlapPercent`, `precision` (`Precision_Fast` / `Precision_High`);
  - `noisePreview`, `maskPreview`, `maskClipLow`, `maskBackground`, `maskSmoothness`;
  - backend enum values `Backend_Auto` / `Backend_ONNX`;
  - the "Amount" control (default 0.90) and the "Use cache" / "Local Support" toggles exist in the UI strings, but I could **not** confirm their parameter ids.
- **Process id**: `MLDenoise` [BINARY].
- **Gotcha** [BINARY help text]: native `.mlpackage` CoreML is not in this build. It uses ONNX through the CoreML execution provider.
- **Reception** [FORUM: Cloudy Nights "PixInsight 1.9.5?" pp. 2-3, Sep-Oct 2026; AstroBin 1.9.5 thread]:
  - slower than NXT;
  - one user saw more artifacts, another found it better on chroma noise;
  - skipped-tile bug reported, then addressed by a model or tool update;
  - model v42 (6 Oct 2026) uses the same weights as v41 [PRIMARY].

### 2.3 MultiscaleGradientCorrection (MGC) + MARS: installed (in MultiscaleProcessing), MARS data NOT installed

- **What it is** [PRIMARY: MARS docs `doc/docs/MARS`; "MARS DR2", Peris, 21 Jun 2026]:
  - The MARS docs explain why sample-based gradient tools (DBE/ABE, even AI ones) are subjective guesses once extended objects are present.
  - MARS is a database of large-scale light from extended objects. MGC models the gradient "not only on sky background areas but also over the extended objects", fully automated.
  - DR2 covers broadband over the whole northern hemisphere, narrowband to +75 deg, and some southern sky to -15 deg.
  - Filters are RGB, Ha, OIII and **L**. L is up to 18x deeper than a single master.
- **Prerequisites** [BINARY error strings + Stirling Astrophoto guide, 1 Aug 2025]:
  - an astrometric solution;
  - SPFC flux metadata (`PCL:SPFC:ScaleFactors`, `PCL:SPFC:FWHMx`, `PCL:SPFC:FWHMy`); MGC errors out without them;
  - Gaia DR3/SP, which is present in `~/Downloads/gdr3sp-1.0.0-s-0[1-4].xpsd`, already used for SPCC.
  - Order: ImageSolver -> SPFC -> MGC -> SPCC.
- **PJSR ids** [BINARY]:
  - `useMARSDatabase`, `marsDatabaseFiles`, `grayMARSFilter`, `redMARSFilter`, `greenMARSFilter`, `blueMARSFilter`;
  - `referenceImageId`, `gradientScale`, `structureSeparation`, `modelSmoothness`;
  - `minFieldRatio`, `maxFieldRatio`, `enforceFieldLimits`;
  - `scaleFactorRK`, `scaleFactorG`, `scaleFactorB`, `showGradientModel`.
- **Recommended values**:
  - gradient scale: default 1024; 256 reached the corners for one author;
  - structure separation: default 3; 1-2 for edges, but then raise model smoothness;
  - model smoothness: default 1; 3-5 if the background is wavy.
  - [Stirling guide, secondary but detailed]
- **SPFC** is the `SpectrophotometricFluxCalibration` process (found in `ImageCalibration-pxm.dylib`). Its parameter ids are not extracted.
- **1.9.6 adds** [PRIMARY]: automatic scale factors, edge correction (off by default), zero pixels treated as no data, an "Allow MARS mosaics" option, and batch/server modes. SPFC gains batch and server modes.
- **Known issue** [FORUM, AstroBin "gradient correction issues with MARS DR2 and luminance frame"]:
  - on an L frame, "reprojected data outside reference region" led to a fallback correction;
  - using an RGB image as the reference for an L target fails ("Incompatible reference image color space");
  - MGC does not fix dust donuts (a flat problem).

### 2.4 Other 1.9.4-1.9.6 changes that matter for this pipeline [PRIMARY: release articles]

- **1.9.4**:
  - native arm64 and the V8 PJSR runtime (porting guide, 11 Mar 2026);
  - **ABE/SFS instances from 1.9.3 or earlier reference nonexistent enum constants**; recreate the instances. This matches project memory `project_abe_enum_broken_pi195`.
- **1.9.5**:
  - PJSR **`Thread`, `Parallel`, `Mutex`**, with `Parallel.run()`, `forRange()`, `map()`, `invoke()`, `forImageRows()`, `forBitmapRows()`. This can speed the pipeline's measurement pixel loops.
  - Legacy `#engine sm` is back on arm64, but as an interpreter only. The project rule stays: do not use it.
  - Faster ImageIntegration, LocalNormalization and DrizzleIntegration.
  - New ImageSolver option "Recursive surface splines".
  - MMT is faster thanks to new morphology routines.
  - Convolution and morphology now treat all four borders the same way.
  - 32-bit RTP for MLDenoise, MLT, MMT and MAS.
  - After installing: run Thread Performance Analysis (`performance -x`).
- **1.9.6** (30 Oct 2026, build 1713):
  - **MultiscaleTGVDenoise** (2nd-order TGV) with params Strength, Chrominance, Smoothness, Amount, a Deep-Sky Image section (on by default) and optional local support; TGVDenoise moves to the Obsolete module.
  - **ImageAnalysis** replaces SubframeSelector.
  - **BlindSolver** script, and ImageSolver 6.6.0 with a "Blind solver" parameter (Automatic/Always/Disabled).
  - ImageIntegration 1.8.0 adds Biweight location.
  - 12 processes get 32-bit RTP, including HT, Curves, AdaptiveStretch and ArcsinhStretch.
  - Geometry processes keep astrometric solutions.
  - Process Console gains `imgstat`, `imgcmp`, `imginfo`, `grep` and others, which help bridge diagnostics.
  - Requires macOS 15+. The core app needs a manual install.
  - Pyth4PI signatures are revoked.
- **CPD rules** [PRIMARY: "The CPD Program...", 30 Oct 2026; effective 12 Dec 2026]:
  - These bind certified developers, not end users.
  - Rule 5.9 says other programs may control PixInsight only through its documented command-line and IPC interface.
  - This pipeline's watcher-script IPC is a private user setup, but it is worth knowing in case it is ever distributed.

### 2.5 Already-installed, under-used processes and scripts (local docs) [PRIMARY]

- **MaskedStretch** (`IntensityTransformations`). Ids [BINARY]: `targetBackground`, `numberOfIterations`, `clippingFraction`, `backgroundReferenceViewId`, `backgroundLow`, `backgroundHigh`, mask type `MaskType_Intensity` / `MaskType_Value`. It is an iterative, self-masked stretch that keeps star and core profiles. Peris used 40 iterations in the NGC 7023 tutorial.
- **ArcsinhStretch**. Ids [BINARY]: `blackPoint`, `protectHighlights`, `previewClipped`. `stretch` and `useRGBWorkingSpace` are expected but not confirmed. It preserves colour ratios during the stretch, which helps knot colour.
- **GradientHDRCompression** (GradientDomain): Max/Min log10(gradient). The docs say the result "usually does not have a natural look" and needs blending.
- **MMT / MLT linear mask**. Ids [BINARY]: `linearMask`, `linearMaskAmpFactor`, `linearMaskSmoothness`, `linearMaskInverted`, `linearMaskPreview`, `deringingDark`, `deringingBright`, `toLuminance`, `toChrominance`, `noiseThresholding`, `softThresholding`.
- **HDRMT**. Ids [BINARY]: `smallScaleDeringing`, `largeScaleDeringing`, `outputDeringingMaps`, `midtonesBalanceMode`, `toIntensity`/`toLightness`/`toLuminanceOnly`, `preserveHue`, `lightnessMask`, `luminanceMask`.
- **Scripts** in `/Applications/PixInsight/src/scripts/`:
  - `misc/DarkStructureEnhance.js` v1.1 (Sonnenstein/Lehmkuhl): wavelet-based dark-structure mask, then darkening.
  - `misc/BackgroundEnhance.js`: faint-structure enhancement.
  - `misc/StarHaloReducer.js`
  - `Toolbox/LabColorBoost.js` v1.9 (2026): a\*/b\* curve boost with an L-derived shadow mask and blend.
  - `Toolbox/ImproveBrilliance.js` v2.6: multi-scale LHE on luminance with low amounts, then LRGBCombination.
  - `Toolbox/EnhanceNebula.js`
  - `Toolbox/RepairStarCores.js`
  - `CosmicPhotons/StarReduction/StarReduction.js` v2.1 (Cranfield/Blanshan; needs PI 1.9.4+): Transfer/Halo/Star/Lightness methods.
  - `LocalFuzzyHistogramHyperbolization` v1.11
  - `CorrectMagentaStars`
  - GraXpert script and process.
  - Scripts are GUI-driven. Use them as **algorithm references to port into PixelMath/PJSR ops**, not as callable APIs.
- **GraXpert native process** (`GraXpert-pxm.dylib`, by Joel Vallier). It drives the installed `/Applications/GraXpert.app` through its CLI and offers AI background extraction, sample-free BGE, AI deconvolution and AI denoise. Ids [BINARY, partial]: `backgroundExtraction`, `backgroundExtractionSampleFree`, `backgroundExtractionAIModel`, `correction`, `smoothing`, `deconvolution`, `deconvolutionMode`, `denoising`, `strength`, `replaceImage`, `disableGPU`, `batchSize`.

---

## 3. Techniques per defect

### Defect 1: "cooked" galaxy core (cell/worm pattern in dust lanes)

**Diagnosis.**
- [FORUM, AstroBin threads] "Worms are just enhanced noise". Stacking HDR, LHE and sharpening creates globule patterns, and running BXT before HDRMT/LHE makes them bite harder, "over-baking galaxy dust lanes".
- [SYNTHESIS] With L at high SNR in the core, the cells come from the operator scale matching the scale of the residual mid-frequency noise and NR mottle: LHE kernels of ~16-64 px, HDRMT with 3-5 layers.
- [PRIMARY: LHE doc] Smaller radius or higher contrast limit means a stronger and noisier result.

**Recipes**

1. **Compress the core during the stretch, not afterwards.** Run MAS on linear L with:
   - `dynamicRangeCompression` 0.5-0.7 and `contrastRecovery=true`;
   - `contrastRecoveryIntensity` 0.6-0.8, lowered if the core looks processed;
   - `scaleSeparation` large (512-1024 px equivalent);
   - a Background Reference ROI on dark sky.

   Why it helps: contrast recovery uses a median-transform variant (ringing-free) and keeps small structures' shape while the core is compressed. Then evaluate whether any HDRMT is still needed. [PRIMARY + SYNTHESIS]

2. **Get dust-lane detail from deconvolution in linear, then stop.**
   - BXT `sharpenNonstellar` moderate, `autoNonstellarPSF=true`, followed by NXT.
   - Do not add a second small-scale sharpener on the core. [FORUM consensus; RC-Astro: no NR before deconvolution]
   - BXT ML5 (paid) claims better extreme-dynamic-range handling, e.g. M42 and the Cat's Eye. [PRIMARY, 28 Aug 2026]

3. **If HDRMT is used**: `medianTransform=true` (MMT is ringing-free [PRIMARY: Conejero MMT tutorial]), `numberOfLayers` 6-8, `numberOfIterations` 1, `toLightness=true`, `preserveHue=true`, `deringing=true`, `luminanceMask=true`.
   - Blend the result at 30-50% through a soft core mask: `$T*(1-m*w) + HDR*m*w`.
   - Peris's M101 example uses 6 layers with a 5x5 B3 spline and a luminance mask (which prevents ringing across iterations). It then runs a second pass of 3 layers with 1 iteration only on near-saturated pixels. [PRIMARY: pixinsight.com/examples/HDRWT/M101]
   - Avoid 3-5 layers on the core: that is the cell scale.

4. **Lane contrast as a "dark structure" operation, not local histogram equalization.** This is the DarkStructureEnhance algorithm, ported:
   - `LS` = image with the first N wavelet/MMT layers removed (N ~ 4-6, i.e. lanes plus margin).
   - `D = max(0, LS - $T)` is a dark-structure map. It is positive only where the image is darker than its local surroundings, i.e. lanes and gaps.
   - Smooth D (remove MMT layer 1) and normalize it.
   - Apply `$T - k*D` with k 0.3-0.8 (or several gentle iterations), restricted to the galaxy by a soft mask.

   Why it helps: it darkens lanes in proportion to how dark they already are, adds no bright-side overshoot, and adds no texture to bright, smooth bulge areas. [PRIMARY script + SYNTHESIS]

5. **MMT sharpening instead of LHE for the remaining texture.**
   - Bias only layers 3-5 (4-16 px for typical sampling), e.g. +0.03 to +0.08.
   - `linearMask` or a lightness mask; `deringingDark`/`deringingBright` small.
   - Never bias layers 1-2 on the core. [PRIMARY: MMT ringing-free tutorial + SYNTHESIS]

6. **If LHE is kept**: `kernelRadius` 96-200, `contrastLimit` 1.3-1.8 (Peris used 1.7 in NGC 7023), `amount` 0.15-0.35, multiple scales at low amounts (ImproveBrilliance pattern), through an inverted star mask. [PRIMARY: LHE doc, NGC7023 tutorial, ImproveBrilliance doc]

7. **Pre-condition**: remove low-frequency mottle first with NXT frequency separation (Defect 6 below), so local contrast has no texture to grow.

8. **Gate idea** [SYNTHESIS, consistent with "calibrate gates against known-good"]:
   - Measure core energy in MMT/MLT layers 2-4 before and after each contrast op, normalized by layer-6+ energy.
   - Reject ops that raise the small/large ratio beyond a threshold calibrated on approved galaxy references.
   - Cell texture shows up as a jump in layers 2-4 without a matching rise in layer 5-6 (lane) energy.

### Defect 2: mask-shaped glow boundary (plateau + cliff on the faint outer disc)

**Diagnosis** [SYNTHESIS]. A lift applied as `$T + a*mask` or `mix(T, lifted, mask)`, with a mask that has a finite edge (RangeSelection threshold, binarized, or a small blur), creates an iso-mask contour. The outer disc gets a constant offset and then a step at the edge of the mask.

**Recipes**

1. **Intensity-domain lift (no spatial mask at all).** Use a GHS curve: `SP` = median level of the faint outer disc, `b` 6-12 (focused), `LP` = sky level (protects background contrast), `HP` ~ the bulge level.
   - It is a monotonic function of pixel value, so it cannot create a spatial cliff.
   - The GHS docs' later-stretch guidance is b ~3-5 with HP and LP.
   - Use the native GHS process (Lightness mode keeps colour) or the existing PixelMath fallback. [PRIMARY: GHS process docs]

2. **Self-weighted large-scale add-back** (the M27 faint-halo technique by J. M. Gomez, adapted):
   - `LS` = MMT/ATWT large-scale component of L (remove layers 1-5, keep the residual), minus the sky median.
   - Smooth it (the tutorial keeps only the 16-px layer and smooths before adding, "to avoid artifacts in nebula borders, around stars and background noise propagation").
   - `$T + k*max(0,LS)` with k 0.2-0.6, possibly twice, through a star mask.
   - The lift is proportional to the local large-scale signal, so it fades to exactly zero at sky with no plateau. [PRIMARY tutorial + SYNTHESIS]

3. **MAS with a Background Reference ROI** (dark sky corner), `targetBackground` 0.10-0.14 and `aggressiveness` 0.5-0.6.
   - Lower Aggressiveness preserves faint detail [PRIMARY tuning guide], and the faint disc is placed by the global curve.

4. **MaskedStretch** as the initial stretch (`numberOfIterations` 40-100, `targetBackground` 0.10-0.15, `backgroundReferenceViewId` = a dark-sky preview). It is iterative and self-masked, so the outer disc gets a smooth, continuous rendering. [PRIMARY: NGC7023 tutorial, BINARY ids]

5. **If a spatial mask is unavoidable**: build it as a **continuous function of a heavily smoothed stretched luminance**, e.g. `m = (LS_stretched)^gamma` with gamma 0.5-1.
   - Smooth with MMT/MLT residual at 32-64 px, then `exp(gamma*ln(x))` in PixelMath (no `pow()`).
   - No thresholds and no binarize.
   - Blurring a hard-edged mask with MLT "to avoid halos" is standard practice. [FORUM: chaoticnebula] But a mask that is never hard-edged is better.

6. **Gate** [SYNTHESIS]:
   - Take the azimuthally averaged radial profile of L along the galaxy's ellipse, from core to sky.
   - Fail if the first derivative changes sign, or if |d2/dr2| spikes beyond a calibrated multiple of its median outside the core.
   - A cliff is a derivative spike; a plateau is a near-zero derivative followed by a spike.

### Defect 3: inter-arm haze / poor arm separation

**Diagnosis** [SYNTHESIS]. Haze in the gaps can come from:
- a gradient model that subtracted part of the galaxy halo, so a raised floor compensates;
- scattered light from the bulge or seeing halo;
- LF noise-reduction smoothing;
- black points or stretches chosen globally for the sky, not for the disc.

**Recipes**

1. **Dark-structure enhancement at arm scale**: as in Defect 1 recipe 4, but with N ~ 6-7 layers (32-64 px), so that gaps relative to the surrounding arms are detected. Restrict it to the disc with a soft mask (Defect 2 recipe 5). [PRIMARY script + SYNTHESIS]

2. **Large-scale local-background subtraction** (equivalently, a large-scale unsharp mask):
   - `$T - k*(LS_big - LS_arm)`, or MLT/MMT positive bias on layers 5-7 (32-128 px), +0.05 to +0.15.
   - Use MMT, or MLT with `deringingDark`/`deringingBright`, to avoid halos.
   - Scale should be ~2-4x arm width; at M74 image scale, measure it.

3. **MAS contrast recovery at a smaller Scale separation** (128-256 px) puts arm/gap structure into the "recovered" band during the stretch. Inspect with `previewLargeScale`. [PRIMARY doc]

4. **LHE only at arm scale**: kernel ≈ arm spacing (150-300 px), contrastLimit ≤ 1.5, amount ≤ 0.3. [PRIMARY LHE doc + SYNTHESIS]

5. **Upstream check**: with MGC, the galaxy's large-scale halo is not part of the gradient model, because MARS knows where the extended light is. This should remove the incentive to lift the floor. [PRIMARY: MARS doc]

6. **Gate** [SYNTHESIS]: an arm/gap contrast ratio. Sample along the ellipse at 2-3 radii; take the robust max/min ratio of the azimuthal profile. Calibrate it on approved spiral references.

### Defect 4: colour (blue arms, natural knot colour, no "painted" look) in RGB-only colour data

1. **White reference.** SPCC's default "average spiral galaxy" is the mean spectrum of S0 to Sdm types, very close to an Sc galaxy, and the SPCC docs cite **M74** as the representative example. [PRIMARY: local `doc/docs/SPCC`] Keep that reference: blue arms and pink HII knots should emerge naturally if SPCC and background neutralization are right. Do not "fix" the colour with SCNR or hue shifts.
2. **Chroma noise without blurring.**
   - Use NXT with `enableColorSeparation=true`, `denoiseColor` 0.9-1.0, and with frequency separation `denoiseLfColor` ~1.0. "A high LF color setting will eliminate the colored patches/blotches" [PRIMARY: NXT 2/AI3 manual].
   - Suggested start values: 80-90% HF intensity, 90-100% HF colour, 50-70% LF intensity, 100% LF colour.
   - This replaces any chroma convolution, which is what causes the painted look: colour bleeding across knots.
3. **Stretch colour with the same function as L.**
   - Run MAS on both L and RGB with identical `targetBackground`, `aggressiveness` and `dynamicRangeCompression`, which gives consistent delinearization [PRIMARY: MAS article].
   - Alternatively, ArcsinhStretch on RGB preserves colour ratios.
4. **Saturation that respects luminance.** Options:
   - MAS `saturationEnabled` with `saturationAmount` 0.4-0.6, `saturationBoost` 0.5-0.7 (favours weakly saturated arm colour) and `saturationLightnessMask` on;
   - or CurvesTransformation S channel through a lightness mask;
   - or the LabColorBoost a\*/b\* approach (blend ~0.3-0.5, shadow-masked).
   - For HDR cores, the MAS docs say: saturation off, then HDRMT, then Curves S. [PRIMARY]
   - Project memory targets sat ~0.58 and P90 ~0.37, so keep amounts low.
5. **Hue-selective boost.** ColorSaturation (`IntensityTransformations`) applies a hue-dependent curve, e.g. lift blue/cyan for arms and magenta-red for HII. **PJSR parameter ids not confirmed.**
6. **LRGB.** If L injection is used, keep chroma from RGB at full resolution. LRGBCombination's own chrominance noise reduction is a wavelet blur, so leave it off and use NXT colour separation instead. [SYNTHESIS]

### Defect 5: gradients (mono L tilt, galaxy filling the frame)

1. **MGC + MARS DR2 (L filter)** on the linear L master:
   - Pipeline: ImageSolver, then SPFC (L filter), then MGC with `grayMARSFilter` = L and `gradientScale` 1024. Try 512 if residual tilt remains, and avoid 256 on a frame-filling galaxy (risk of over-correction).
   - Leave `structureSeparation` at 3 and `modelSmoothness` at 1-3. Set `showGradientModel=true` and log the model's statistics.
   - Do the same for R/G/B, then SPCC.
   - **Data install**: download MARS DR2 (`.xmars`, about 1.35 GB for DR1; DR2 size not checked) with a PixInsight account, and add it in MGC preferences.
   - The value format for `grayMARSFilter` (a filter-name string) is not verified.
2. **GraXpert AI background extraction** via the native GraXpert process (app installed) is the automated fallback when MARS coverage or reprojection fails. It is a second opinion, not ground truth: AI models are "subjective" per the MARS docs.
3. **If staying with GradientCorrection/ABE**: on a frame-filling galaxy, keep the model order low (a plane or degree-1 polynomial for a tilt), exclude the disc generously, and compare the model to an MGC model when available. ABE needs instances recreated on 1.9.4+.
4. **Gate**: the pipeline's `measure_color_gradient` / uniformity metrics, run on corner and edge sky only, plus "model must not correlate with the galaxy's large-scale luminance". [SYNTHESIS]

### Defect 6: stars, noise, automation

- **Stars**
  - BXT ML5 (28 Aug 2026; paid upgrade from AI4, which is installed) claims better star colour preservation, bright-star tiling fixes and handling of small faint background galaxies (relevant to SXT/BXT confusion). [PRIMARY]
  - The StarReduction script (Cranfield/Blanshan, v2.1) runs on stretched images with a starless view. Port its "Transfer" method in PixelMath rather than calling the GUI script. Note the project rule against erosion; StarReduction is not morphological erosion, but A/B it against the star-integrity gate.
  - MAS dynamic range compression keeps Gaussian star profiles, which could change how the star layer is stretched. **This conflicts with project memory "stars must be delivered linear"**: test it only as an option for the star-layer stretch step, never as a double stretch.
- **Noise**
  - NXT AI3 parameter ids [BINARY]: `denoise`, `iterations`, `enableColorSeparation`, `enableFrequencySeparation`, `denoiseColor`, `denoiseLf`, `denoiseLfColor`, `frequencyScale`.
  - The `linear` flag is gone; handling is automatic [PRIMARY].
  - Tune `frequencyScale` with `denoiseLf=0` first (the manual's examples use 4-7 px).
  - Other options: MLDenoise (above); MultiscaleTGVDenoise in 1.9.6; MMT/MLT noise reduction with `linearMask` (Conejero M81/M82: MLT 5 layers with a first-layer threshold of 3-5 sigma decreasing per layer, amount 0.5-0.7 with iterations).
- **Automation**
  - Use PJSR `Parallel` (1.9.5) for heavy measurement loops.
  - The 1.9.6 Process Console commands (`imgstat`, `imgcmp`) are cheap diagnostics.
  - The RC-Astro **stand-alone CLI 1.0.0** (13 Jul 2026) can run BXT/NXT/SXT from Node without PixInsight, which is useful for parallel A/B tests while PI is busy.

---

## 4. Third-party tools and scripts worth installing

| Tool | Status here | Scriptable from PJSR? | Notes |
|---|---|---|---|
| GHS process (Mike Cranfield), repo `https://www.ghsastro.co.uk/updates/` | Not installed | Yes. Native process, `GeneralizedHyperbolicStretch`. Read param ids from the dylib after install. | Native arm64 on 1.9.4+; the legacy script is not offered on 1.9.4+; 3.2.0 uses 32-bit RTP. [PRIMARY: GHS FAQ/news] |
| MARS DR2 `.xmars` + MGC | MGC installed, data missing | Yes (process ids above) | Needs a PixInsight account download |
| MLDenoise model `.xmlm` | Module installed, model missing | Yes (`MLDenoise`, `modelPath`) | Download from pixinsight.com/dist |
| BXT ML5 | AI4 installed | Same BXT process | Paid ($49.95 for permanent AI4 holders) [PRIMARY] |
| GraXpert app + PI process | Both installed | Process yes; it shells out to the app | 1.9.6 CPD rules restrict apps launched outside the signing system; watch for revocation |
| Seti Astro scripts (repo `raw.githubusercontent.com/setiastro/pixinsight-updates/main/`) | Unknown | GUI scripts; port the algorithms | Statistical Stretch discontinued in favour of MAS [FORUM: AstroWhat]; reports of SetiAstro scripts disappearing after 1.9.5 [secondary: Astromaniac Magazine] |
| RC-Astro stand-alone CLI | Not installed | Node child_process | Same core as the PI suite [PRIMARY] |
| PI 1.9.6 | 1.9.5 installed | n/a | MultiscaleTGVDenoise, MGC batch mode, BlindSolver; manual install, macOS 15+ |

---

## 5. What I could not verify

- PJSR ids for the MLDenoise Amount / Use cache / Local Support toggles, ColorSaturation, SPFC and GHS.
- The unit of MAS `scaleSeparation` (pixels or layer index).
- The value format of MGC `grayMARSFilter`.
- Any galaxy-specific MAS settings from the PixInsight team: the official examples are PNe, M45, B150 and M42.
- No primary source discusses "worm" artifacts specifically; that diagnosis is FORUM + SYNTHESIS.
- Cloudy Nights and Stargazers Lounge returned HTTP 403 to the fetcher, and the AstroBin pages rendered empty. Forum claims come from search-engine snippets.

## 6. Sources

**PixInsight official**
- Article index (all dates above): https://pixinsight.net/dev/index.php?articles/
- PixInsight 1.9.6 Lockhart Released (30 Oct 2026): https://pixinsight.net/dev/index.php?articles/pixinsight-1-9-6-lockhart-released.28/
- PixInsight 1.9.5 Lockhart Released (18 Sep 2026): https://pixinsight.net/dev/index.php?articles/pixinsight-1-9-5-lockhart-released.21/
- PixInsight 1.9.4 Lockhart Released (12 May 2026): https://pixinsight.net/dev/index.php?articles/pixinsight-1-9-4-lockhart-released.15/
- Technology Preview: MLDenoise for macOS ARM64 (23 Jun 2026): https://pixinsight.net/dev/index.php?articles/technology-preview-mldenoise-for-macos-arm64.19/
- MARS DR2 (21 Jun 2026): https://pixinsight.net/dev/index.php?articles/mars-dr2.18/
- The MultiscaleAdaptiveStretch Tool (30 Dec 2025): https://pixinsight.net/dev/index.php?ams/the-multiscaleadaptivestretch-tool.6/
- MultiscaleAdaptiveStretch Released (30 Dec 2025): https://pixinsight.net/dev/index.php?articles/multiscaleadaptivestretch-released.7/
- MAS Version 1.1 Released (27 Jan 2026): https://pixinsight.net/dev/index.php?articles/multiscaleadaptivestretch-version-1-1-released.11/
- Are we filling a gap with MAS? (5 Jan 2026): https://pixinsight.net/dev/index.php?articles/are-we-filling-a-gap-with-mas.10/
- The CPD Program (30 Oct 2026): https://pixinsight.net/dev/index.php?articles/the-cpd-program-what-we-have-found-and-why-the-rules-exist.29/

**Local official docs (PI 1.9.5 build 1706)**
- `/Applications/PixInsight/doc/tools/MultiscaleAdaptiveStretch/MultiscaleAdaptiveStretch.html`
- `/Applications/PixInsight/doc/docs/SPCC/` (M74 as the representative galaxy for the white reference)
- `/Applications/PixInsight/doc/docs/MARS/`
- `/Applications/PixInsight/doc/tools/GradientHDRCompression/`
- `/Applications/PixInsight/doc/tools/GraXpert/`
- `/Applications/PixInsight/doc/scripts/{LabColorBoost,ImproveBrilliance,StarReduction,LocalFuzzyHistogramHyperbolization,GraXpert}/`
- Script sources under `/Applications/PixInsight/src/scripts/`
- Module binaries `/Applications/PixInsight/bin/{MultiscaleAdaptiveStretch,MachineLearning,MultiscaleProcessing,IntensityTransformations,ArcsinhStretch,RCAstroSuite,GraXpert}-pxm.dylib` (parameter ids)

**PixInsight tutorials and examples**
- Multiscale Gradient Correction tutorial (Peris, 8 Apr 2020; the original manual method): https://pixinsight.com/tutorials/multiscale-gradient-correction/
- Dynamic Range and Local Contrast, NGC 7023 (Peris, undated): https://pixinsight.com/tutorials/NGC7023-HDR/
- Ringing-Free Sharpening with MMT (Conejero, adapted from an Oct 2011 forum post): https://www.pixinsight.com/tutorials/mmt-sharpening/
- HDRWT M101 example (Peris, undated): https://pixinsight.com/examples/HDRWT/M101/index.html
- Deconvolution and NR example, M81/M82 (Conejero, ~2011): https://www.pixinsight.com/examples/M81M82/index.html
- LHE documentation: https://pixinsight.com/doc/tools/LocalHistogramEqualization/LocalHistogramEqualization.html

**Third-party primary**
- RC-Astro news (BXT ML5 28 Aug 2026; unified suite 27 Jul 2026; CLI 1.0.0 13 Jul 2026): https://www.rc-astro.com/
- BlurXTerminator ML5: https://www.rc-astro.com/blurxterminator-ml5/
- NoiseXTerminator page (AI3 1 Feb 2025; module 2.3.4 30 Apr 2026): https://www.rc-astro.com/noisexterminator/
- NXT 2/AI3 PixInsight manual: https://www.rc-astro.com/noisexterminator-2-ai3-user-manual-pixinsight/
- GHS home and news (v3.2.0): https://www.ghsastro.co.uk/
- GHS process docs: https://www.ghsastro.co.uk/doc/tools/GeneralizedHyperbolicStretch/GeneralizedHyperbolicStretch.html
- GHS FAQ: https://ghsastro.co.uk/faq/
- M27 faint-halo tutorial (J. M. Gomez, undated): http://astromania.info/articles/M27Tutorial/index.html

**Secondary and forum**
- ScopeTrader, PixInsight 1.9.5 (23 Sep 2026): https://scopetrader.com/pixinsight-1.9.5-lockhart-update-brings-machine-learning-and-speed/
- ScopeTrader, 1.9 Lockhart (21 Dec 2024): https://scopetrader.com/pixinsight-1.9-lockhart/
- ScopeTrader, 1.9.3: https://scopetrader.com/pixinsight-1.9.3-lockhart-released/
- Stirling Astrophoto MGC guide (1 Aug 2025): https://stirlingastrophoto.com/posts/multiscale-gradient-correction/
- Starlust MAS guide: https://astroguide.starlust.de/html/MAS-MultiscaleAdaptiveStretch.html
- AstroBin, MGC + MARS DR2 on luminance: https://app.astrobin.com/forum/topic/245953/calibration/pixinsight-gradient-correction-issues-with-mars-dr2-and-luminance-frame
- Cloudy Nights "PixInsight 1.9.5?" (MLDenoise reception): https://www.cloudynights.com/forums/topic/1010795-pixinsight-195/page/2/
- AstroBin 1.9.5 upgrade thread: https://app.astrobin.com/forum/topic/256777/pleiades-astrophoto-pixinsight/pixinsight-lockhart-195-upgrade
- AstroWhat, Statistical Stretch (discontinued in favour of MAS): https://astrowhat.com/resources/statistical-stretch.223/
- Astromaniac Magazine (SetiAstro scripts after 1.9.5): https://www.astromaniacmagazine.com/articles/pixinsight-through-the-years-how-the-astrophotography-landscape-is-changing
- AstroBin threads on worms and over-baked dust lanes: https://app.astrobin.com/forum/topic/188929/noise-reduction/artifacts-or-low-snr-issue and https://ssr.app.astrobin.com/forum/topic/141080/russell-croman-astrophotography-noisexterminator/blotchy-images-after-noise-reduction
- Chaotic Nebula, mask blurring with MLT to avoid halos: https://chaoticnebula.com/pixinsight-sharpening/
