# GHS (Generalized Hyperbolic Stretch) — Complete Reference

## Status
- `GeneralizedHyperbolicStretch-pxm.dylib` is **NOT installed**
- `new GeneralizedHyperbolicStretch` throws "is not defined"
- Must use PixelMath fallback replicating the math from the GHS script

## Origins
GHS was proposed by **Dave Payne** (September 2021) as a unified framework for astronomical
image stretching. **Mike Cranfield** implemented it as a PixInsight script (Dec 2021), then
a process module (autumn 2022). Now part of PixInsight v1.8.9-2+.

## D Parameter Conversion
D in the GUI/script is on a log scale:
```
actual_D = exp(D) - 1
```
| Slider D | Actual D |
|----------|----------|
| 0.5 | 0.649 |
| 1.0 | 1.718 |
| 2.0 | 6.389 |
| 3.0 | 19.086 |
| 5.0 | 147.41 |

## Parameters
| Param | Description | Range | Effect |
|-------|-------------|-------|--------|
| D | Stretch strength (log scale) | 0-20 | Higher = more aggressive stretch |
| B | Curve type / local intensity | -5 to 15 | Controls focus of contrast addition |
| SP | Symmetry point | 0-1 | Where maximum contrast is applied |
| LP | Shadow protection | 0 to SP | Below LP: linear tangent (locks shadows) |
| HP | Highlight protection | SP to 1 | Above HP: linear tangent (locks highlights) |
| BP | Black point (Linear mode) | -1 to WP | Clips to zero below BP |

## B Parameter — The Critical Control

B controls the **shape** and **focus** of the stretch curve:

| B value | Name | Focus | Use case |
|---------|------|-------|----------|
| -5 to -2 | Integral (broad) | Very spread | Post-stretch gentle refinement |
| -1 | **Logarithmic** | Broad | Gentle contrast, post-stretch |
| -0.5 to 0 | Integral/Exponential | Moderate | General refinement |
| 0 | Exponential | Balanced | General purpose |
| **1** | **Harmonic = HT/STF** | Moderate | Equivalent to HistogramTransformation |
| 2-5 | Hyperbolic | Focused | Targeted enhancement |
| **5-10** | Super-hyperbolic | **Very focused** | **Initial linear stretch** |
| **10-15** | Ultra-hyperbolic | **Extremely focused** | **Narrow linear peaks** |

### Critical Insight: B=1 IS HistogramTransformation
The harmonic case `T(x) = 1 - (1+D*x)^(-1) = D*x/(1+D*x)` is mathematically equivalent
to HT's MTF: `MTF(x,m) = (m-1)*x / ((2m-1)*x - m)` where `m = 0.5/(D+1)`.

**HT is just one specific case within the GHS family.**

### Why High B for Linear Data
Linear astronomical data has an extremely narrow histogram peak (median ~0.001).
- Low B (negative): spreads contrast broadly — misses the peak, wastes stretch on empty space
- High B (10-15): concentrates ALL contrast addition at SP — perfect for boosting the narrow peak
- This is why pure GHS can replace HT: use B=10+ to focus on the histogram peak

## Piecewise Construction

The stretch is piecewise over 4 zones:

### Zone 1: x < LP (Shadow Protection)
```
T1(x) = slope_at_LP * (x - LP) + T2(LP)
```
**A tangent line** — linear continuation with slope = derivative at LP boundary.
Preserves relative contrast of shadow pixels exactly.

### Zone 2: LP ≤ x < SP (Below symmetry point)
```
T2(x) = -T(SP - x)    (180° rotation of T around SP)
```

### Zone 3: SP ≤ x < HP (Above symmetry point — main stretch)
```
T3(x) = T(x - SP)     (base transform)
```

### Zone 4: x ≥ HP (Highlight Protection)
```
T4(x) = slope_at_HP * (x - HP) + T3(HP)
```
Same tangent-line approach. Stars and galaxy cores above HP are linearly scaled.

### Normalization
```
f(x) = (Ti(x) - T1(0)) / (T4(1) - T1(0))
```

## Formulas by B Value

### B = -1 (Logarithmic)
```
T(x) = ln(1 + D*x)
T'(x) = D / (1 + D*x)
```
PixelMath: `a + b * ln(c + d * $T)`

### B < -1 or -1 < B < 0 (Integral)
```
T(x) = (1 - (1 - b*D*x)^((b+1)/b)) / (D*(b+1))
T'(x) = (1 - b*D*x)^(1/b)
```
PixelMath: `a + b * exp(e * ln(c + d * $T))` (using exp(e*ln()) for power)

### B = 0 (Exponential)
```
T(x) = 1 - exp(-D*x)
T'(x) = D * exp(-D*x)
```
PixelMath: `a + b * exp(c + d * $T)`

### B = 1 (Harmonic = HT)
```
T(x) = D*x / (1 + D*x)
T'(x) = D * (1 + D*x)^(-2)
```

### B > 0, B ≠ 1 (Hyperbolic/Super-Hyperbolic)
```
T(x) = 1 - (1 + b*D*x)^(-1/b)
T'(x) = D * (1 + b*D*x)^(-(1+b)/b)
```
PixelMath: `a + b * exp(e * ln(c + d * $T))` (using exp(e*ln()) for power)

## PixelMath Expression
```
iif($T < LP, a1 + b1*$T, iif($T < SP, <exp2>, iif($T <= HP, <exp3>, a4 + b4*$T)))
```

Critical formatting:
- Wrap negative numbers in parens: `(-1.859)` not `-1.859`
- Use `exp(e*ln(base))` for power operations (no `pow()` in PixelMath)
- Set `P.use64BitWorkingImage = true; P.truncate = true`

## LP Protection: How "Locking" Works Across Passes

### Mathematical Mechanism
Below LP, the function is a straight line (tangent at LP boundary):
```
slope = T2'(LP) = derivative of stretch at LP
T1(x) = slope * (x - LP) + T2(LP)
```
All pixels below LP receive identical linear scaling — no nonlinear distortion.

### Multi-Pass Protection Pattern
This is the key to the 3-phase sweep technique:

1. **After Pass 1** (shadows lifted to ~0.05): shadow structure established
2. **Pass 2 with LP=0.03**: pixels below 0.03 get only linear scaling (minimal disturbance).
   Shadow work from pass 1 is preserved while midtones expand.
3. **Pass 3 with LP=0.08**: everything below 0.08 locked. Only highlights stretched.

**This is fundamentally different from running HT multiple times**, where every pass
re-compresses shadows further.

## 3-Phase GHS from Linear (APOD Technique)

For stretching linear astronomical data without HT:

### Phase 1: "Pied de courbe" — Shadow Lift
```
D: 2.0-3.0 (slider)     B: 10-15 (super-hyperbolic, focused)
SP: image median (~0.001-0.003)
LP: 0                    HP: 0.95
```
Lifts the entire histogram off the left wall.
Background target: ~10,000-15,000 ADU (0.15-0.23 normalized).

### Phase 2: "Sommet de courbe" — Midtone Expansion
```
D: 1.5-2.0              B: 3-6 (broader)
SP: new median (~0.05-0.10, auto-measured)
LP: 0.02-0.05 (protects phase 1 shadows)
HP: 0.90
```
LP locks the shadow region from phase 1. Midtone range expands.

### Phase 3: "Fin de courbe" — Highlight Refinement
```
D: 0.5-1.0              B: -1.0 to 0 (gentle, broad)
SP: new median (~0.10-0.20)
LP: 0.05-0.08 (protects phases 1+2)
HP: 0.85
```
Gentle pass refining tonal distribution without disturbing established contrast.

### Optional Phase 4: Core Compression
For galaxy cores that are too bright:
```
D: 0.3-0.5              B: -1.5 (logarithmic, broad)
SP: 0.5-0.8             LP: 0.15       HP: 1.0
```

## Galaxy Processing Recommendations

### Initial Stretch
Use the 3-phase sweep above. Key differences from nebulae:
- Galaxy cores clip easily → use HP=0.90-0.95 in early passes
- Faint outer arms need significant boost → Phase 1 must lift aggressively
- Stars must not bloat → HP protects them

### Post-Stretch Refinement
After initial stretch (whether HT or GHS):
```
Pass 1: "Midtone boost"   D=0.6-1.0, B=-1.0, SP=median, LP=0.02, HP=0.95
Pass 2: "Fine contrast"   D=0.4-0.6, B=-1.5, SP=median, LP=0.03, HP=0.90
```
SP is re-measured after each pass (image statistics change).

### Pre-HT Highlight Compression (Hybrid Approach)
If using HT for initial stretch, can pre-compress highlights on linear data first:
- CAUTION: B must be high (5+) on linear data, NOT negative
- SP should be WITHIN the data range, near actual signal features
- v26 showed this partially works but cores still clip post-HT (max=0.9999)

## Colour Stretch Mode
GHS offers RGB vs Colour-preserving modes:
- **RGB/K mode**: applies per-channel (can shift color balance)
- **Col mode**: preserves hue ratios (arcsinh-like)
- **Blend slider**: 0=RGB, 1=Col

For PixelMath: colour-preserving requires computing luminance, applying GHS to luminance,
and scaling RGB channels proportionally. Our pipeline uses `useSingleExpression=true`
which applies per-channel independently.

## GHS is Reversible
The Inverse checkbox applies the inverse function. Useful workflow:
1. Apply moderate GHS to linear (for SXT star removal)
2. Remove stars (SXT works better on slightly stretched data)
3. Apply inverse GHS to return both images to linear
4. Continue linear processing

## Constraints (Pipeline Validation)
- **HP must be > SP** — otherwise negative values in formula → NaN
- **LP must be < SP** — otherwise formula domain error
- **D = 0** → identity transform (no change)
- Check built expression for NaN/Infinity before executing

## Implementation
Full code in `scripts/run-pipeline.mjs`:
- `computeGHSCoefficients(orgD, B, SP, LP, HP)` — all B-value cases
- `buildGHSExpr(c)` — piecewise PixelMath expression builder
- `ghsCode(viewId, orgD, B, SP, LP, HP)` — complete PJSR code string with validation
