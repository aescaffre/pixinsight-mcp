# MCP Tools Catalog

The tools the MCP server will expose to AI assistants. Organized by processing stage, from highest to lowest priority.

## Phase 1 — Core Tools (MVP)

### `list_open_images`
List all currently open image windows in PixInsight.

**Parameters**: none

**Returns**: Array of `{ id, filePath, width, height, channels, isColor, bitDepth }`

---

### `open_image`
Open an image file in PixInsight.

**Parameters**:
- `filePath` (string, required) — absolute path to FITS/XISF/TIFF file

**Returns**: `{ id, width, height, channels }`

---

### `save_image`
Save an open image to disk.

**Parameters**:
- `viewId` (string, required) — the view ID of the image to save
- `filePath` (string, required) — output path (format determined by extension: .xisf, .fits, .tiff, .png)
- `overwrite` (boolean, default: false)

---

### `close_image`
Close an open image window.

**Parameters**:
- `viewId` (string, required)

---

### `get_image_statistics`
Get statistics for an open image (mean, median, stddev, min, max, per channel).

**Parameters**:
- `viewId` (string, required)

**Returns**: Per-channel statistics

---

### `run_pixelmath`
Execute a PixelMath expression.

**Parameters**:
- `expression` (string, required) — the math expression (e.g., `"$T * 0.5"`)
- `expression1` (string, optional) — green channel expression (if different)
- `expression2` (string, optional) — blue channel expression (if different)
- `targetViewId` (string, optional) — apply to this view (in-place)
- `createNewImage` (boolean, default: false)
- `newImageId` (string, optional) — ID for the new image if creating one

---

## Phase 2 — Pre-Processing Pipeline

### `calibrate_frames`
Apply bias, dark, and flat calibration to light frames.

**Parameters**:
- `lightFrames` (string[], required) — paths to light frame files
- `masterBias` (string, optional) — path to master bias
- `masterDark` (string, optional) — path to master dark
- `masterFlat` (string, optional) — path to master flat
- `outputDirectory` (string, required)
- `enableCFA` (boolean, default: false) — for OSC/DSLR cameras

---

### `register_frames`
Align frames to a reference using StarAlignment.

**Parameters**:
- `referenceImage` (string, required) — path to reference frame
- `targetFrames` (string[], required)
- `outputDirectory` (string, required)
- `distortionCorrection` (boolean, default: false)

---

### `integrate_frames`
Stack registered frames using ImageIntegration.

**Parameters**:
- `frames` (string[], required) — paths to registered frames
- `combination` (string, default: "average") — "average", "median", "min", "max"
- `rejection` (string, default: "sigma_clip") — "sigma_clip", "winsorized", "linear_fit", "percentile", "none"
- `sigmaLow` (number, default: 4.0)
- `sigmaHigh` (number, default: 3.0)
- `outputFilePath` (string, optional)

**Returns**: `{ viewId, outputPath, totalFrames, rejectedFrames }`

---

### `debayer`
Demosaic a CFA/Bayer image.

**Parameters**:
- `viewId` (string, required)
- `bayerPattern` (string, default: "auto") — "auto", "RGGB", "BGGR", "GBRG", "GRBG"
- `method` (string, default: "VNG")

---

## Phase 3 — Post-Processing

### `remove_gradient`
Remove background gradients using ABE.

**Parameters**:
- `viewId` (string, required)
- `polyDegree` (number, default: 4) — polynomial degree (1-6)
- `tolerance` (number, default: 1.0)

---

### `color_calibrate`
Calibrate colors using SPCC (if plate-solved) or PCC.

**Parameters**:
- `viewId` (string, required)
- `method` (string, default: "spcc") — "spcc", "pcc", "basic"

---

### `remove_green_cast`
Apply SCNR to remove green cast.

**Parameters**:
- `viewId` (string, required)
- `amount` (number, default: 1.0) — 0.0 to 1.0

---

### `stretch_image`
Apply histogram stretch (linear to non-linear).

**Parameters**:
- `viewId` (string, required)
- `method` (string, default: "auto") — "auto" (AutoHistogram), "manual" (HistogramTransformation)
- `shadowsClipping` (number, optional) — for manual method
- `midtones` (number, optional) — for manual method

---

### `apply_curves`
Apply curves transformation.

**Parameters**:
- `viewId` (string, required)
- `curvePoints` (array) — array of [x, y] control points (0.0-1.0)
- `channel` (string, default: "rgb") — "rgb", "red", "green", "blue", "lightness", "saturation"

---

### `denoise`
Apply noise reduction (MultiscaleLinearTransform).

**Parameters**:
- `viewId` (string, required)
- `layers` (number, default: 4) — number of wavelet layers
- `strength` (number[], optional) — per-layer noise reduction strength

---

### `sharpen`
Apply UnsharpMask sharpening.

**Parameters**:
- `viewId` (string, required)
- `sigma` (number, default: 2.0)
- `amount` (number, default: 0.8)

---

## Phase 4 — Advanced Tools

### `plate_solve`
Solve astrometry for an image (ImageSolver).

**Parameters**:
- `viewId` (string, required)
- `ra` (number, optional) — approximate RA in degrees (hint)
- `dec` (number, optional) — approximate Dec in degrees (hint)

---

### `extract_channels`
Separate an image into individual channels.

**Parameters**:
- `viewId` (string, required)
- `colorSpace` (string, default: "RGB") — "RGB", "HSV", "HSI", "CIE Lab"

---

### `combine_channels`
Combine separate channel images into a color image.

**Parameters**:
- `channels` (object, required) — `{ red: "viewId", green: "viewId", blue: "viewId" }`

---

### `run_script`
Execute arbitrary PJSR code inside PixInsight. Escape hatch for anything not covered by specific tools.

**Parameters**:
- `code` (string, required) — PJSR JavaScript code to execute

**Returns**: Console output captured during execution

---

### `evaluate_subframes`
Evaluate subframe quality using SubframeSelector.

**Parameters**:
- `frames` (string[], required)

**Returns**: Per-frame quality metrics (FWHM, eccentricity, noise, SNR, etc.)

---

## Tool Naming Conventions

- Use snake_case for tool names
- Use descriptive, action-oriented names
- Parameters use camelCase
- File paths are always absolute
- View IDs reference open PixInsight image windows by their main view identifier
