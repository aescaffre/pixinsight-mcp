# PixInsight Processes Catalog

Reference of the key PixInsight processes we plan to expose as MCP tools, organized by processing stage.

## Pre-Processing

### ImageCalibration
**Purpose**: Apply bias, dark, and flat correction to raw light frames.

```javascript
var P = new ImageCalibration;
P.targetFrames = [
    [true, "/path/to/light_001.xisf"],
    [true, "/path/to/light_002.xisf"]
];
P.enableCFA = true;                  // For OSC/DSLR cameras
P.masterBiasEnabled = true;
P.masterBias = "/path/to/master_bias.xisf";
P.masterDarkEnabled = true;
P.masterDark = "/path/to/master_dark.xisf";
P.masterFlatEnabled = true;
P.masterFlat = "/path/to/master_flat.xisf";
P.outputDirectory = "/path/to/calibrated/";
P.outputPrefix = "cal_";
P.executeGlobal();
```

### CosmeticCorrection
**Purpose**: Fix hot and cold pixels.

### Debayer (Demosaic)
**Purpose**: Convert Bayer-pattern CFA data to RGB.

```javascript
var P = new Debayer;
P.bayerPattern = Debayer.prototype.Auto;  // or RGGB, BGGR, etc.
P.debayerMethod = Debayer.prototype.VNG;  // VNG, PPG, AHD, etc.
P.executeOn(view);
```

## Registration / Alignment

### StarAlignment
**Purpose**: Align (register) frames to a reference frame.

```javascript
var P = new StarAlignment;
P.referenceImage = "/path/to/reference.xisf";
P.targets = [
    [true, true, "/path/to/light_001.xisf"],
    [true, true, "/path/to/light_002.xisf"]
];
P.outputDirectory = "/path/to/registered/";
P.outputPrefix = "reg_";
P.executeGlobal();
```

Key parameters:
- `referenceImage` — the frame to align against
- `distortionCorrection` — enable for wide-field
- `noiseReduction` — improve star detection in noisy data

### ImageSolver (Plate Solving)
**Purpose**: Determine astrometric solution (WCS coordinates) for an image.

## Integration / Stacking

### ImageIntegration
**Purpose**: Combine registered frames into a master stack.

```javascript
var P = new ImageIntegration;
P.images = [
    [true, "/path/to/reg_light_001.xisf", "", ""],
    [true, "/path/to/reg_light_002.xisf", "", ""]
];
P.combination = ImageIntegration.prototype.Average;
P.rejection = ImageIntegration.prototype.SigmaClip;
P.rejectionNormalization = ImageIntegration.prototype.Scale;
P.sigmaLow = 4.0;
P.sigmaHigh = 3.0;
P.generateRejectionMaps = true;
P.executeGlobal();
```

Key parameters:
- `combination` — Average, Median, Min, Max
- `rejection` — SigmaClip, WinsorizedSigmaClip, LinearFit, Percentile, etc.
- `normalization` — Additive, Multiplicative, AdditiveWithScaling
- `weightMode` — DontCare, ExposureTime, Noise, Signal, etc.

### DrizzleIntegration
**Purpose**: Sub-pixel resolution integration using drizzle data.

## Background / Gradient Removal

### AutomaticBackgroundExtractor (ABE)
**Purpose**: Automatic gradient and background removal.

```javascript
var P = new AutomaticBackgroundExtractor;
P.tolerance = 1.0;
P.deviation = 0.8;
P.polyDegree = 4;
P.executeOn(view);
```

### DynamicBackgroundExtraction (DBE)
**Purpose**: Interactive gradient removal with manually placed sample points.

> **Note**: DBE is interactive by nature. For MCP automation, ABE is preferred unless we implement a way to define sample points programmatically.

## Color Calibration

### SpectrophotometricColorCalibration (SPCC)
**Purpose**: Advanced color calibration using spectral data and plate-solved images.

```javascript
var P = new SpectrophotometricColorCalibration;
// Requires a plate-solved image
P.executeOn(view);
```

### PhotometricColorCalibration (PCC)
**Purpose**: Color calibration using photometric catalog data.

### ColorCalibration
**Purpose**: Basic white balance using reference background and white areas.

```javascript
var P = new ColorCalibration;
P.executeOn(view);
```

### SCNR (Subtractive Chromatic Noise Reduction)
**Purpose**: Remove green cast (common in narrowband/OSC data).

```javascript
var P = new SCNR;
P.colorToRemove = SCNR.prototype.Green;
P.amount = 1.0;
P.executeOn(view);
```

## Noise Reduction

### MultiscaleLinearTransform (MLT)
**Purpose**: Wavelet-based noise reduction (and sharpening).

### TGVDenoise
**Purpose**: Total Generalized Variation denoising.

### NoiseXTerminator (Third-party)
**Purpose**: AI-based noise reduction. Requires separate installation.

## Stretching / Tone Mapping

### HistogramTransformation
**Purpose**: Apply histogram stretch (linear to non-linear conversion).

```javascript
var P = new HistogramTransformation;
// H = [[shadows, darkClipping, midtones, highlightClipping, highlights], ...]
// One array per channel: R, G, B, combined, alpha
P.H = [
    [0, 0.5, 0.0, 0.5, 1.0],  // R
    [0, 0.5, 0.0, 0.5, 1.0],  // G
    [0, 0.5, 0.0, 0.5, 1.0],  // B
    [0.0, 0.5, 0.002, 0.5, 1.0],  // RGB/K (combined)
    [0, 0.5, 0.5, 0.5, 1.0]   // Alpha
];
P.executeOn(view);
```

### AutoHistogram
**Purpose**: Automatic histogram stretch.

### ScreenTransferFunction (STF)
**Purpose**: Auto-stretch preview (non-destructive). Useful for evaluating linear images.

```javascript
var P = new ScreenTransferFunction;
// Apply an auto-stretch to preview
P.executeOn(view);
```

### CurvesTransformation
**Purpose**: Curves-based tonal adjustment.

## Sharpening / Detail Enhancement

### UnsharpMask
**Purpose**: Sharpen image details.

### Deconvolution
**Purpose**: Restore detail by reversing optical blur (PSF deconvolution).

### LocalHistogramEqualization (LHE)
**Purpose**: Enhance local contrast.

## Star Operations

### StarNet / StarXTerminator (Third-party)
**Purpose**: Separate stars from nebulosity. Requires separate installation.

### MorphologicalTransformation
**Purpose**: Control star size (erosion/dilation).

## Pixel Math

### PixelMath
**Purpose**: Apply arbitrary mathematical expressions to pixel values. Extremely flexible.

```javascript
var P = new PixelMath;
P.expression = "$T * 0.5 + 0.1";  // Simple example
P.useSingleExpression = true;
P.createNewImage = false;          // Modify in place
P.executeOn(view);
```

Common uses:
- Combine narrowband channels: `expression = "Ha"`, `expression1 = "OIII"`, `expression2 = "SII"`
- HDR composition: `expression = "max($T, other_image)"`
- Mask creation: `expression = "iif($T > 0.5, 1, 0)"`
- Image math: `expression = "$T - background_model"`

## Utility Processes

### SubframeSelector
**Purpose**: Evaluate and rank subframes by quality (FWHM, eccentricity, noise, etc.).

### Blink
**Purpose**: Quickly review a set of images (visual inspection).

### WeightedBatchPreprocessing (WBPP)
**Purpose**: End-to-end automated preprocessing script (calibration through integration).

> **Note**: WBPP is a script, not a process. It wraps many of the above processes into a single automated pipeline. We may want to expose it as a high-level MCP tool.

## How to Get Full Parameter Lists

For any process, run this in PixInsight's Script Editor:

```javascript
var P = new ImageCalibration;  // Replace with any process name
for (var key in P) {
    if (typeof P[key] !== "function") {
        console.writeln(key + " = " + JSON.stringify(P[key]));
    }
}
```

Or drag a configured process instance to the Script Editor to see all parameters with their current values.
