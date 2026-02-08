# MCP Tools Catalog

The tools the MCP server will expose to AI assistants. Organized by category.

---

## Category 1 — Recipe Catalog Tools

### `search_recipes`
Search the local recipe catalog for processing workflows matching an object or criteria.

**Parameters**:
- `object` (string, optional) — astronomical object name (e.g., "M42", "NGC 7000")
- `objectType` (string, optional) — "galaxy", "emission_nebula", "planetary_nebula", "cluster", "reflection_nebula", etc.
- `filters` (string[], optional) — filter set used (e.g., ["L", "R", "G", "B", "Ha"])
- `tags` (string[], optional) — additional tags to filter on
- `limit` (number, default: 5)

**Returns**: Array of recipe summaries with `{ id, title, objects, source, resultImageUrl, stepCount, difficulty }`

---

### `get_recipe`
Get full recipe details by ID, including all steps and parameters.

**Parameters**:
- `recipeId` (string, required)

**Returns**: Full recipe object (see [recipes-catalog.md](recipes-catalog.md) for schema)

---

### `search_new_recipes`
Search the web for new processing workflows for a given object. Extracts structured recipes from found content and adds them to the catalog.

**Parameters**:
- `object` (string, required) — object name to search for
- `filters` (string[], optional) — filter set to refine search
- `sources` (string[], optional) — limit to specific platforms ("astrobin", "cloudynights", "webastro", "youtube", "blog")

**Returns**: Array of newly discovered recipe summaries

---

### `add_recipe`
Add a manually crafted recipe to the catalog.

**Parameters**:
- `recipe` (object, required) — full recipe object following the schema

**Returns**: `{ id, status: "added" }`

---

### `import_recipe_from_url`
AI reads a URL (blog post, forum thread, AstroBin page) and extracts a structured processing recipe from it.

**Parameters**:
- `url` (string, required) — source URL
- `object` (string, optional) — object name hint (helps extraction)

**Returns**: Extracted recipe (user can review before saving)

---

### `execute_recipe`
Execute a recipe step-by-step on loaded images in PixInsight.

**Parameters**:
- `recipeId` (string, required)
- `channelMapping` (object, required) — maps recipe channels to open views, e.g., `{ "L": "L_master", "R": "R_master", "Ha": "Ha_master" }`
- `startFromStep` (number, default: 1) — resume from a specific step
- `interactive` (boolean, default: true) — if true, pause after each step for user review

**Returns**: Progress and result for each step

---

### `rate_recipe`
Rate a recipe after using it.

**Parameters**:
- `recipeId` (string, required)
- `rating` (number, required) — 1-5
- `notes` (string, optional)

---

## Category 2 — Image Management Tools

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

## Category 3 — Processing Tools (Post-WBPP)

These are the core tools for post-processing. Recipes are composed of these steps.

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
- `method` (string, default: "auto") — "auto" (AutoHistogram), "stf" (use STF values), "manual" (HistogramTransformation)
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

### `deconvolve`
Apply deconvolution to restore detail.

**Parameters**:
- `viewId` (string, required)
- `psfSigma` (number, default: 2.5) — PSF sigma estimate
- `iterations` (number, default: 50)

---

### `combine_lrgb`
Combine Luminance with RGB color data.

**Parameters**:
- `luminanceViewId` (string, required)
- `rgbViewId` (string, required)
- `luminanceWeight` (number, default: 1.0)

---

### `blend_narrowband`
Blend narrowband channel into broadband data using PixelMath.

**Parameters**:
- `targetViewId` (string, required) — the broadband image
- `narrowbandViewId` (string, required) — the narrowband channel (e.g., Ha)
- `blendMode` (string, default: "max") — "max", "screen", "add", "custom"
- `blendStrength` (number, default: 1.0) — 0.0 to 1.0
- `targetChannel` (string, optional) — "red", "luminance", "all"

---

## Category 4 — Pre-Processing Tools (Direct Use)

Available for direct use, but **not** used in post-WBPP recipes.

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

## Category 5 — Advanced / Utility Tools

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
