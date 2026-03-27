# Galaxy Cluster Processing Reference

Research-backed techniques for processing galaxy clusters (Abell 2151, Markarian's Chain, etc.)

## Key Differences from Single Galaxies

- Targets are **tiny** (10-50px) — fine-scale tools matter most
- Brightness varies enormously between members
- Both spirals and ellipticals in same field — different processing needs
- Background must be very dark (0.08-0.10) to make faint members pop
- SXT may remove small galaxies — use conservative overlap

## BXT Settings for Small Galaxies

| Parameter | Value | Notes |
|-----------|-------|-------|
| Correct Only (1st pass) | ON | Fix aberrations before sharpening |
| Sharpen Nonstellar | 0.50-0.90 | Higher for small galaxies (we use 0.70) |
| Sharpen Stars | 0.25 | Default |
| Adjust Star Halos | 0.00 | Avoid ringing |
| Execution Order | Nonstellar then Stellar | Resolves embedded HII in spirals first |

## NXT Strategy

| Stage | Denoise | Notes |
|-------|---------|-------|
| Linear | 0.15-0.25 | GENTLE — preserve faint galaxy structures |
| Post-stretch | 0.25-0.35 | Heavier NXT after stretch is safer |
| Post-LHE/HDRMT | 0.25-0.30 | Clean up enhancement artifacts |

**Critical: 0.45 in linear kills fine detail. Keep linear NXT at 0.20-0.25.**

## LHE Multi-Scale (3 passes, all masked)

| Scale | Radius | Amount | Slope Limit | Target |
|-------|--------|--------|-------------|--------|
| Fine | 16-24 | 0.15-0.20 | 1.2 | Micro-contrast in galaxy cores |
| Medium | 35-64 | 0.25-0.30 | 1.3 | Internal galaxy structure, dust lanes |
| Large | 94-150 | 0.25-0.35 | 1.5 | Overall galaxy shape, tidal features |

- Medium scale (35-64) is MOST useful for clusters
- Circular kernel ON
- Mask: soft (clipLow=0.04-0.06, blur=5-8) to capture faint galaxy extensions
- Call measure_subject_detail after each pass

## HDRMT for Clusters

| Setting | Value |
|---------|-------|
| Layers | 5-6 |
| Iterations | 1 |
| Median Transform | **ON** (prevents dark ringing in star-rich fields) |
| To Lightness | ON |
| Lightness Mask | ON |

**Advanced: Multi-layer blend** — apply HDRMT at layers=5,6,7,8,9 on clones, blend with weighted PixelMath.

## Masking Strategy

- **Soft luminance mask** (clipLow=0.04-0.06): captures faint galaxy halos/tails
- **Range mask** (lower=0.05, upper=0.30): isolates faint galaxies for selective stretch
- **Star mask**: protect stars during galaxy enhancement
- Mask blur: 3-6 (tight for small galaxies)
- Mask gamma: 1.5-2.0 (protect cores)

## Stretch

- Background target: **0.08-0.10** (darker than single galaxies)
- Headroom: 0.10 for L, 0.05 for RGB
- Consider MaskedStretch as alternative (protects bright cores while stretching faint members)

## LRGB Combine

- Lightness: 0.45-0.55 (lower preserves color)
- Saturation: 0.40-0.50
- LinearFit L to RGB first (rejectHigh=0.92)

## Sources

- Cosgrove's Cosmos (Markarian's Chain LRGB workflow)
- Chaotic Nebula (HDRMT, LHE, BXT guides)
- PixInsight official examples (M81/M82 deconvolution)
- CloudyNights forums (Abell 2151 threads)
- RC Astro documentation (NXT AI3, BXT)
