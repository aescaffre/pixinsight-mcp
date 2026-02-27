# Xterminator Tools (RC Astro) — PJSR Reference

All three are **native process modules** (.dylib), NOT scripts.

## StarXTerminator (SXT)

### Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `stars` | bool | false | Create separate star image (**the** key parameter) |
| `unscreen` | bool | false | Use unscreen method for star extraction |
| `overlap` | float | 0.20 | Tile overlap (0.05-0.75) |

### Critical Rules
- **Linear data**: `P.stars = true` only (NO `P.unscreen`). Get starless + stars via subtraction.
- **Non-linear data**: `P.stars = true; P.unscreen = true`. Stars are screen-blend compatible.
- `P.starmask` does NOT exist. `P.linear` does NOT exist.
- Star image name: `<viewId>_stars` (detect by diffing image list before/after)

### Star Image Detection
```javascript
// Snapshot before
var before = [];
var wins = ImageWindow.windows;
for (var i = 0; i < wins.length; i++) before.push(wins[i].mainView.id);

P.executeOn(view);

// Find new images
var after = ImageWindow.windows;
for (var i = 0; i < after.length; i++) {
    if (before.indexOf(after[i].mainView.id) < 0) {
        // This is the star image
    }
}
```

### Non-Linear Star Extraction (Best Practice)
Avoids halo bloating from stretching linear stars:
1. Save pre-SXT checkpoint
2. Run SXT on linear main image (stars=true, no unscreen) — close linear stars
3. Stretch main image (HT + GHS)
4. Load pre-SXT checkpoint, apply identical stretch
5. Run SXT with `unscreen=true` on stretched pre-SXT image
6. Result: display-range stars compatible with screen blend

### Screen Blend Recombination
```javascript
// PixelMath screen blend: ~(~starless * ~(strength * stars))
P.expression = '~(~$T * ~(' + strength + '*' + starsId + '))';
P.useSingleExpression = true;
P.executeOn(starlessView);
```

## NoiseXTerminator (NXT)

### Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `denoise` | float | 0.70 | Denoising strength (0-1) |
| `detail` | float | 0.15 | Detail preservation (0-1) |

### Recommended Strategy: Multiple Light Passes
Prefer multiple gentle applications over fewer heavy ones. Over-denoising causes:
plastic/waxy look, faint star loss, blurred edges, color smearing, reduced depth.

| Stage | Target | denoise | detail | Purpose |
|-------|--------|---------|--------|---------|
| Linear RGB | Before SXT | 0.25 | 0.15 | Clean noise before star separation |
| Post-stretch L | After L stretch | 0.25 | 0.15 | Clean stretched luminance |
| Post-stretch RGB | After main stretch | 0.25 | 0.15 | Clean stretched color |
| Final (optional) | After LHE/HDRMT | 0.15 | 0.15 | Light cleanup of amplified noise |

Each application should be a single run at low denoise — NOT high denoise values.

```javascript
var P = new NoiseXTerminator;
P.denoise = 0.25;
P.detail = 0.15;
P.executeOn(view);
```

## BlurXTerminator (BXT)

### Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `sharpenStars` | float | — | Star sharpening amount |
| `adjustStarHalos` | float | — | Halo adjustment (negative = reduce) |
| `sharpenNonstellar` | float | — | Extended feature sharpening |
| `correctOnly` | bool | false | Only aberration correction, no sharpening |
| `autoNonstellarPSF` | bool | true | Auto-detect PSF from stars |
| `nonstellarPSFDiameter` | float | — | Manual PSF diameter (0-8 px) |
| `luminanceOnly` | bool | false | Process luminance only |

### Two-Pass Best Practice
1. **Pass 1 (correctOnly)** — before color calibration:
   ```javascript
   P.correctOnly = true;
   P.sharpenStars = 0.50;
   P.sharpenNonstellar = 0.75;
   ```
2. **Pass 2 (sharpening)** — after color calibration:
   ```javascript
   P.correctOnly = false;
   P.sharpenStars = 0.25;
   P.sharpenNonstellar = 0.50;
   P.adjustStarHalos = -0.25;
   ```
