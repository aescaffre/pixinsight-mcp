# PJSR Process Parameter Reference

## LocalHistogramEqualization (LHE)
CLAHE-style local contrast enhancement. Great for tonal separation within nebulae.

### Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `radius` | int | 64 | Kernel radius in pixels (larger = more global) |
| `histogramBins` | enum | Bit08 | `LocalHistogramEqualization.prototype.Bit08/Bit10/Bit12` |
| `slopeLimit` | float | 2.0 | Contrast limit (higher = more aggressive) |
| `amount` | float | 0.70 | Blend with original (0=none, 1=full) |
| `circularKernel` | bool | true | Use circular kernel (vs square) |

### Usage
```javascript
var P = new LocalHistogramEqualization;
P.radius = 64;
P.histogramBins = LocalHistogramEqualization.prototype.Bit12;
P.slopeLimit = 2.0;
P.amount = 0.70;
P.circularKernel = true;
P.executeOn(ImageWindow.windowById('MyImage').mainView);
```

### Tips
- Use with nebula mask (Ha-derived) or luminance mask to protect background
- Large radius (64px) for structural tonal separation
- Small radius (24px) for micro-contrast / fine detail
- `slopeLimit` 1.5-2.0 is safe; higher risks artifacts
- `amount` > 0.5 starts looking artificial — use restraint
- Softer mask blur (10px) gives more natural transitions
- **Galaxy fields: apply maskGamma=2.0** to the luminance mask before use — without gamma, bright galaxy cores saturate to 1.0 in the mask and LHE applies uniformly, flattening core detail. See "Mask Gamma Compression" section below.

## HDRMultiscaleTransform (HDRMT)
Reveals detail in bright regions without blowing highlights. For nebula cores.

### Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `numberOfLayers` | int | 6 | Number of wavelet layers |
| `numberOfIterations` | int | 1 | Processing iterations |
| `invertedIterations` | **bool** | **false** | Inverted iterations — MUST be boolean, not integer |
| `overdrive` | float | 0 | Overdrive amount |
| `medianTransform` | bool | false | Use median instead of mean |
| `toLightness` | bool | true | Apply to CIE L* only (preserves color) |
| `preserveHue` | bool | false | Preserve hue |
| `luminanceMask` | bool | true | Built-in luminance mask |

### Usage
```javascript
var P = new HDRMultiscaleTransform;
P.numberOfLayers = 6;
P.numberOfIterations = 1;
P.invertedIterations = false;  // MUST be boolean false, NOT integer 0
P.overdrive = 0;
P.medianTransform = false;
P.toLightness = true;
P.preserveHue = false;
P.luminanceMask = true;
P.executeOn(ImageWindow.windowById('MyImage').mainView);
```

### Tips
- Always use with nebula mask or luminance mask for background protection
- `toLightness = true` prevents color shifts
- Built-in `luminanceMask` protects dark areas automatically
- Start gentle, increase `numberOfLayers` for broader scales
- Combined with LHE can easily over-process — use one or the other, not both at full strength
- **Galaxy fields: apply maskGamma=1.5** to the luminance mask before use — lighter than LHE gamma because HDRMT already has a built-in luminance mask. See "Mask Gamma Compression" section below.
- **HDRMT cannot recover already-clipped data** — if cores are pure white after stretch, HDRMT creates ringing artifacts. Use `hdrHeadroom` in the stretch step (0.10 for L, 0.05 for RGB) to keep cores below 1.0.

## MorphologicalTransformation
Morphological operations for star size control.

### Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `operator` | enum | Erosion | `.prototype.Erosion/Dilation/Opening/Closing/Median/Selection/Midpoint` |
| `interlacingDistance` | int | 1 | Interlacing distance |
| `numberOfIterations` | int | 1 | Number of iterations |
| `amount` | float | 1.0 | Blend with original (0=none, 1=full) |
| `selectionPoint` | float | 0.50 | Selection point for Selection operator |
| `structureSize` | int | 3 | Kernel size (3, 5, 7...) |

### CRITICAL: Do NOT use structureWayTable
The `structureWayTable` parameter is extremely finicky. Both flat arrays and nested arrays
cause errors in practice. Just use `structureSize` with the default kernel:
```javascript
var P = new MorphologicalTransformation;
P.operator = MorphologicalTransformation.prototype.Erosion;
P.structureSize = 3;  // Use default 3x3 kernel — DO NOT set structureWayTable
P.amount = 0.65;
P.numberOfIterations = 1;
P.executeOn(ImageWindow.windowById('stars').mainView);
```

### WARNING: Star erosion creates artifacts
Morphological erosion on star images creates ring-like artifacts around star cores
when screen-blended back. The non-linear star extraction approach (SXT with unscreen)
produces much cleaner results without any erosion needed.

## LRGBCombination
Combines luminance with RGB color data. Used for Ha luminance boost and L channel combination.

### Usage (Ha as luminance)
```javascript
var P = new LRGBCombination;
P.channelL = [true, 'Ha_work'];       // use Ha as luminance
P.channelR = [false, ''];              // don't replace R
P.channelG = [false, ''];
P.channelB = [false, ''];
P.lightness = 0.55;                    // how much luminance to apply
P.saturation = 0.50;                   // saturation preservation
P.noiseReduction = false;
P.executeOn(ImageWindow.windowById('target').mainView);
```

## Convolution (Gaussian blur)
Used for mask smoothing and Ha detail layer extraction.

### Usage
```javascript
var C = new Convolution;
C.mode = Convolution.prototype.Parametric;
C.sigma = 15;           // Gaussian sigma in pixels
C.shape = 2;            // Gaussian shape
C.aspectRatio = 1;
C.rotationAngle = 0;
C.executeOn(ImageWindow.windowById('mask').mainView);
```

## AutomaticBackgroundExtractor (ABE)
Removes background gradients from light pollution, sky glow, or vignetting.

### Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tolerance` | float | 1.000 | Global sample rejection tolerance (sigma). Lower = more aggressive rejection |
| `deviation` | float | 0.800 | Local rejection deviation (sigma). Protects against noise/small stars |
| `unbalance` | float | 1.800 | Shadows relaxation. Higher includes more dark pixels in model |
| `minBoxFraction` | float | 0.050 | Minimum valid pixel fraction per sample box |
| `maxBackground` | float | 1.000 | Upper brightness limit for background pixels |
| `minBackground` | float | 0.000 | Lower brightness limit for background pixels |
| `useBezierSurface` | bool | false | Bezier instead of polynomial (handles complex gradients) |
| `polyDegree` | int | 4 | Polynomial degree 1-6. **Use 2-3 for galaxies** (higher eats flux) |
| `boxSize` | int | 5 | Background sample box size |
| `boxSeparation` | int | 5 | Distance between sample boxes. Increase to 8-10 for large galaxies |
| `modelImageSampleFormat` | enum | f32 | `.prototype.f32` or `.f64` |
| `abeDownsample` | float | 2.00 | Downsampling factor (1-8) for model resolution |
| `writeSampleBoxes` | bool | false | Generate sample visualization image |
| `justTrySamples` | bool | false | Stop after sample extraction (testing) |
| `targetCorrection` | enum | **None** | **MUST set explicitly**: `.prototype.Subtract` or `.Divide` |
| `normalize` | bool | true | Restore original mean color balance after correction |
| `discardModel` | bool | true | Discard background model after correction |
| `replaceTarget` | bool | true | Modify image in-place |
| `correctedImageId` | string | '' | ID for new image (when replaceTarget=false) |
| `correctedImageSampleFormat` | enum | SameAsTarget | `.prototype.SameAsTarget` / `.f32` / `.f64` |
| `verbosity` | int | 0 | Console output level |

### Usage
```javascript
var P = new AutomaticBackgroundExtractor;
P.tolerance = 1.000;
P.deviation = 0.800;
P.unbalance = 1.800;
P.minBoxFraction = 0.050;
P.maxBackground = 1.0000;
P.minBackground = 0.0000;
P.useBezierSurface = false;
P.polyDegree = 3;       // 2-3 for galaxies, 4 for nebulae
P.boxSize = 5;
P.boxSeparation = 5;
P.modelImageSampleFormat = AutomaticBackgroundExtractor.prototype.f32;
P.abeDownsample = 2.00;
P.writeSampleBoxes = false;
P.justTrySamples = false;
P.targetCorrection = AutomaticBackgroundExtractor.prototype.Subtract;  // REQUIRED
P.normalize = true;
P.discardModel = true;
P.replaceTarget = true;
P.correctedImageId = '';
P.correctedImageSampleFormat = AutomaticBackgroundExtractor.prototype.SameAsTarget;
P.verbosity = 0;
P.executeOn(ImageWindow.windowById('MyImage').mainView);
```

### Tips
- **MUST set `targetCorrection`** — defaults to None which does nothing
- `Subtract` for additive gradients (light pollution, sky glow)
- `Divide` for multiplicative effects (vignetting)
- For galaxies: `polyDegree=2-3`, increase `boxSeparation=8-10`
- Inspect model with `discardModel=false` to verify it doesn't contain galaxy signal
- Always apply on LINEAR data, before color calibration
- May create temporary model windows — close them immediately

## GradientCorrection
Newer PixInsight process (~March 2024). Simpler than ABE with good structure protection.

### Usage
```javascript
var P = new GradientCorrection;
P.executeOn(ImageWindow.windowById('MyImage').mainView);
```

### Tips
- Works well with defaults for most cases
- Good built-in structure protection (better than ABE for galaxies in default mode)
- Subtractive only (no vignetting/Divide mode)
- May create model windows — use `detectNewImages()` pattern to close them
- To discover all PJSR params: `for (var k in P) if (typeof P[k]!='function') console.writeln(k+'='+P[k]);`

### ABE vs GC Comparison
| | ABE | GradientCorrection |
|---|-----|---------------------|
| Ease of use | Many params | Defaults work |
| Galaxy safety | Risk if polyDegree too high | Good protection |
| Vignetting | Yes (Divide mode) | No |
| Fine control | Excellent | Limited |
| Pipeline default | Use for specific needs | **Default choice** |
| Auto mode | Pipeline compares both and picks best | |

## SCNR (SubtractiveChromaticNoiseReduction)
Green cast removal.

### Usage
```javascript
var P = new SCNR;
P.amount = 0.35;
P.protectionMethod = SCNR.prototype.AverageNeutral;
P.executeOn(view);
```

## Per-Channel Gradient Correction (Phase 0c)
Applies GradientCorrection to each channel (R, G, B, L) individually BEFORE channel combination.
Fixes per-channel color gradients that combined-image GC cannot address.

### Why It Matters
Different filters, different nights, and different sky conditions create different gradient profiles per channel.
M81/M82 example: R had 5x worse gradient than G (0.000010 vs 0.000003). Combined-image GC sees an
average gradient and creates color casts in the areas where individual channels diverge. Per-channel GC
equalized all channels to 0.000002.

### Implementation
```javascript
// For each channel file (R, G, B, L):
var channelWin = ImageWindow.open(channelPath)[0];
var P = new GradientCorrection;
// Measure baseline uniformity (stddev of 4 corner medians, 200x200 px)
var baselineUniformity = measureUniformity(channelWin);
P.executeOn(channelWin.mainView);
var newUniformity = measureUniformity(channelWin);
// Baseline guard: revert if GC made it worse
if (newUniformity > baselineUniformity) {
    // Undo — GC degraded this channel
    channelWin.undo();
}
channelWin.saveAs(outputPath);
channelWin.forceClose();
```

### Tips
- **Always use for LRGB datasets** — per-channel GC is the single most impactful pre-processing step
- Has baseline guard: reverts if GC makes uniformity worse for any channel
- Post-stretch GC (`gc_post`) is unreliable — corner-sampling metric breaks on non-linear data. Leave disabled.
- Uniformity metric: standard deviation of 4 corner medians (200x200 px sample boxes)

## Mask Gamma Compression
Gamma-compresses luminance masks so that bright galaxy cores are not saturated to 1.0.
Without gamma, LHE/HDRMT apply at full strength uniformly across the core, destroying detail.

### Formula
PJSR has no `pow()` function. Use the `exp(exponent * ln(base))` pattern:
```javascript
// Apply gamma compression to a luminance mask
// gamma=2.0 for LHE masks, 1.5 for HDRMT masks
var expr = 'exp(' + gamma + '*ln(max($T, 0.00001)))';
var PM = new PixelMath;
PM.expression = expr;
PM.useSingleExpression = true;
PM.createNewImage = false;
PM.executeOn(maskWindow.mainView);
```

### Effect at gamma=2.0
| Input (mask value) | Output | Effect |
|--------------------|--------|--------|
| 1.00 (core) | 1.00 | Full protection (unchanged) |
| 0.90 (bright core) | 0.81 | Reduced protection — LHE/HDRMT applies partially |
| 0.70 (mid-bright) | 0.49 | Significant processing allowed |
| 0.50 (midtone) | 0.25 | Most processing applied |
| 0.20 (faint) | 0.04 | Nearly full processing |

### Tips
- **LHE maskGamma: 2.0** — stronger compression because LHE is more destructive on bright cores
- **HDRMT maskGamma: 1.5** — lighter because HDRMT has its own built-in luminance mask
- Always rescale mask to [0,1] range before applying gamma
- The `max($T, 0.00001)` prevents `ln(0)` which would produce NaN

## Hue-Selective Saturation (hue_boost step)
Targeted saturation enhancement for galaxy images. Boosts blue spiral arms and pink HII regions
while leaving golden/warm galactic bulge tones untouched. More natural than blanket saturation curves.

### PixelMath Implementation
```javascript
// Per-channel saturation boost based on hue classification
// lum = CIE luminance: 0.2126*R + 0.7152*G + 0.0722*B
// For blue-dominant pixels (B > R && B > G): factor = blueBoost
// For pink/magenta pixels (R > G && B > G*0.8): factor = pinkBoost
// For golden/neutral: factor = 1.0 (no change)
// Formula per channel: lum + factor * (channel - lum)

var lum = '0.2126*$T[0] + 0.7152*$T[1] + 0.0722*$T[2]';
// Blue detection: B channel dominant
var isBlue = '($T[2] > $T[0] && $T[2] > $T[1])';
// Pink detection: R dominant, B close to or above G
var isPink = '($T[0] > $T[1] && $T[2] > $T[1]*0.8)';

var factor = 'iif(' + isBlue + ', ' + blueBoost + ', iif(' + isPink + ', ' + pinkBoost + ', 1.0))';
var exprR = lum + ' + ' + factor + ' * ($T[0] - (' + lum + '))';
var exprG = lum + ' + ' + factor + ' * ($T[1] - (' + lum + '))';
var exprB = lum + ' + ' + factor + ' * ($T[2] - (' + lum + '))';

var PM = new PixelMath;
PM.expression = exprR;
PM.expression1 = exprG;
PM.expression2 = exprB;
PM.useSingleExpression = false;
PM.createNewImage = false;
PM.executeOn(targetView);
```

### Recommended Values
| Parameter | Value | Target |
|-----------|-------|--------|
| `blueBoost` | 1.30 | Blue spiral arms, reflection nebulosity |
| `pinkBoost` | 1.25 | HII regions, emission knots |
| Golden/warm | 1.00 | Galactic bulge (left untouched) |

### Tips
- Use AFTER curves and LRGB combine, BEFORE final curves
- Produces more natural color than blanket saturation which over-saturates the already-warm galactic bulge
- The `iif()` function is available in PixelMath (ternary conditional)
- Test with small boost values first (1.10-1.15) and increase
