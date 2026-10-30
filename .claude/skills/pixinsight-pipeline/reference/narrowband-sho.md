# Narrowband SHO / HOO workflow (Hubble palette)

Mono SII / Ha / OIII masters rendered in a false-color palette. Implemented in
`agents/llm/narrowband-prep.mjs` (deterministic prep) and `agents/ops/sho-palette.mjs`
(palette ops, exposed to agents as `sho_combine`, `sho_hue_shift`, `sho_hue_saturation`,
`measure_palette_balance`, `suggest_narrowband_balance`).

## Config
```json
"files": {
  "S": "/path/FILTER-S.xisf", "Ha": "/path/FILTER-H.xisf", "O": "/path/FILTER-O.xisf",
  "palette": "SHO", "starless": true,
  "narrowband": { "palette": "foraxx", "gradientEdgeSigma": 1.5, "nxtLinear": {"H":0.25,"S":0.35,"O":0.35} },
  "outputDir": "...", "targetName": "NGC281"
}
```
No R/G/B keys means the workflow is detected as `SHO` (or `HOO` when there is no S). `files.H` works as an alias for `Ha`.
`starless` defaults to true for narrowband. When it is true, the finish star gates and the star-branch completeness rule are skipped.
Example config: `PACMAN_SHO_agentic.json`.

## Prep order (per channel, H = alignment reference)
1. Open the masters and close crop_mask windows. Run StarAlignment only when the geometry differs from H.
2. **Measured gradient**: compute an 8×8 grid of cell medians in units of pixel σ. Apply GC only if the border-cell spread
   exceeds `gradientEdgeSigma` (1.5σ). NB backgrounds are often flat, and GC on an Ha field with a frame-wide faint halo
   eats real signal. (PACMAN: spread ≤ 0.3σ on all three channels, so GC was skipped.)
3. BXT correct → BXT sharpen (nonstellar 0.60, stars 0.25) → NXT linear (H 0.25, S/O 0.35).
4. SXT linear (`stars=true`, no unscreen). NB star layers are **saved linear to disk** (`stars_linear_<ch>.xisf`) and closed.
5. **Unlinked** Seti stretch of each channel to the same target median (profile overlay: 0.12). This is the first
   normalization step, since SII and OIII are 3–10× weaker than Ha.
6. Initial palette composite (`sho_combine`) → the target view. No SPCC and no BackgroundNeutralization, because a false-color palette has no white point.
7. Never crop or resample: the RGB stars are added later and must match the master geometry.

## Palettes (`sho_combine`, all on stretched starless mono)
Gains act above each channel's own background: `X' = bg + gain·(X − bg)`.
Auto-balance brings the S span (P99.5 − median) to 70% of the H span, and the O span to 85%.

| palette | mapping | character |
|---|---|---|
| `foraxx` | R = (O^~O)·S + ~(O^~O)·H; G = ((OH)^~(OH))·H + ~((OH)^~(OH))·O; B = O | dynamic SHO: gold/blue directly, little green. Best default. Credit: thecoldestnights (2020). |
| `sho` | R = S, G = H, B = O | classic. Ha reads green, so it needs `sho_hue_shift` |
| `hue_screen` | per-channel HSV tint (S 0°, H 35°, O 195°) screen-blended | method of Jürgen Bätz's *NarrowbandHueCombination* (Toolbox script, GUI-only, so reimplemented headless) |
| `hoo` | R = H, G = w·O + (1−w)·H, B = O | bicolor |

PixelMath has no `pow()`, so write `x^y` as `exp(y*ln(max(x,1e-5)))`.

## Color finish
- `sho_hue_shift`: CurvesTransformation **hue→hue** curve (`P.H`, `P.Ht=AkimaSubsplines`). It folds the green band (0.20–0.42)
  toward gold (0.12) and keeps red (0) and cyan (≥0.48) fixed. Prefer it over SCNR: SCNR greys the green, the hue shift re-hues it.
  PI hue scale: 0 red, 0.167 yellow, 0.333 green, 0.5 cyan, 0.667 blue, 0.833 magenta.
- `sho_hue_saturation`: ColorSaturation `HS` curve (hue → saturation delta). Typical settings: gold +0.15, cyan/blue +0.25, green −0.3.
- `measure_palette_balance`: hue-family fractions on subject pixels.
  The finish gate (Gate 1b) blocks when green > 10%, magenta > 8%, or cyan+blue < 5% (profile `narrowband_palette.palette`).

## Star residuals on aberrated fields (`repairStarResiduals`)
On fast reducers with full-frame sensors (PACMAN: Starizona 0.63× on a 2300 mm SCT, ASI6200), the stars outside the corrected circle are comatic.
SXT removes the core but leaves the **wing 30–50 px beside the star**, at a spot where the star layer is ~0.
So a star-layer mask (even a dilated one) misses the wing, and a second SXT pass on stretched data doesn't help either.

The repair works like this:
- **Near-star zone:** the saved linear star layers (> 6e-5, about 5σ of the linear sky), reach 40 px.
- **Protection:** subtract the Hα nebula **envelope**, i.e. the 128× median of Hα more than 0.015 above sky. The whole nebula, dark lanes included, is never touched.
- **Replacement:** inside what's left, replace pixels whose σ-3-blurred value deviates from the 48× median background by more than 2–4 noise units.
- **Result on PACMAN:** 0.3–0.8% of pixels changed, all in the outer field.

Using the channel's own background as protection was wrong: in OIII the dust lane looks like sky, and its bright rim got flattened.

## Palette lessons (PACMAN / NGC 281, 2026-10-26)
- **SII is the weakest channel by far:** span/noise was 4 for SII, 11 for OIII and 18 for Hα after the stretch.
  Run post-stretch NXT per channel *before* the palette gains (S 0.60, O 0.45, H 0.30); auto-gain hits the 4.0 clamp for S.
- **Foraxx** gave a red rim and cyan core: Hα lands in R, so there's no gold. Clean, but not the Hubble look.
- **Classic SHO** (h_gain 0.85) → `sho_hue_shift` (strength 1.0, target 0.10, cyan_keep 0.50) → **SCNR 0.6** (average-neutral, preserve lightness).
  This gave the Hubble look: green went from 35% to 9%, with gold 71% and cyan+blue 14%.
  The hue shift alone leaves an olive band where Hα and OIII overlap (hues 0.40–0.47).
- **hue_screen** must tint the signal *above background*. Screening three raw channels stacks their 0.12 backgrounds into a brown cast; fixed by using a neutral pedestal.
  Even then OIII is lost under gold where both channels are bright (cyan screened with gold turns whitish).
- **The hue shift also rotates greenish sky noise to gold**, which gives a warm/brown sky. Follow it with `neutralize_palette_background`.
  PI's BackgroundNeutralization and a "pixels below the luminance median" estimate are both biased here, because luminance is mostly G.
- The palette after an unlinked stretch to 0.12 is flat (nebula P99 only 0.41). A contrast curve fixed it: K curve through (0.12→0.075, 0.26→0.40, 0.45→0.72).
- Hue saturation for the finish: gold +0.30, red +0.15, green −0.45, **cyan/blue +0.10**. At +0.25 on blue, the OIII core clipped in B (median 0.93, max 1.0).
  The contrast curve also needs highlight headroom (0.65→0.86, 0.85→0.93, 1→0.97).
- **Chroma mottle**: weak SII gained ×4 shows up as orange/blue blotches 30–80 px across in the OIII core at 1:1.
  NXT color/frequency separation did nothing visible. `chroma_smooth` (CIE Lab a/b Gaussian σ8, lightness untouched) removed it.
- shellDetailEnhance at full strength (1.0/0.5) amplified grain (detail ×5.6, mostly noise). 0.6/0.4 + NXT 0.35 gave detail ×2 and stayed clean.
  LHE r160 was invisible at 1:1 and clipped.
- **Validated PACMAN finish** (`/Volumes/Extension/PACMAN/output/claude/final/finish_recipe.json`), in order:
  curve → residual hue fold (0.6) → hue saturation → neutralize sky → shell detail 0.6/0.4 → NXT 0.35 → chroma σ8 → neutralize sky.
  Result: green 3.9%, gold 79%, cool 10.7%, P90 sat 0.68, 0 burnt blocks.
- **Open flaws:** the outer Hα halo is crushed by the curve's toe (needs a masked shadow lift), and o_gain was not bracketed above 1.78.
- The finish gate's palette thresholds (green ≤10%, magenta ≤8%, cool ≥5%) pass on this result. They have not yet been back-tested on a user-approved SHO image.

## USER-APPROVED result: PACMAN LIFT5 ("really perfect", 2026-10-27)
After the palette finish, reveal the faint outer nebulosity. The stretch and contrast curve crush it, but it is real signal: Hα 0.13–0.15 vs sky 0.11.
1. **`lift_faint_halo`** (`liftFaintHalo`), on a clone.
   - Mask: pre-lift luminance σ20, ramp in sky+0.0035 → sky+0.0165, ramp out 0.13 → 0.19 (body excluded), × Hα guard, feather σ25.
   - Through it: lift curve, gold hue fold, hue saturation, LHE r250/0.35/slope 2.0, then NXT 0.25, then halo color (S curve + gold/red).
2. **`body_edge_contrast`**: LHE r120/0.28/slope 1.6 through BODY_EDGE (pre-lift luminance 0.11→0.16 in, 0.30→0.40 out).

What didn't work: a mask built from Hα alone overlapped the body (the body's Hα is 0.13–0.17), which made the body hazy and the halo olive (LIFT1–3).
Build the body exclusion from the *final image's luminance*, where halo ≤ 0.11 and body ≥ 0.21.

Result: subject coverage 14% → 25%, saturation P90 0.785, gold 87%, cool 6.9%, no burnt blocks.
Reference image: `/Volumes/Extension/PACMAN/output/claude/final/NGC281_SHO_starless_iteration_01_haloLift5.xisf` (`files.referencePath` in `PACMAN_SHO_agentic.json`).
**Taste:** for emission palettes the user prefers a rich, expansive look (strong warm halo OK), not the muted galaxy look.

**Gate back-test on the approved image:** all blocking gates pass after one calibration.
The core-contrast gate rejected the smooth OIII cavity (relContrast 0.055 < 0.22), so `narrowband_palette.core_burn.rel_contrast_hard` = 0.03.
Ringing (advisory) fires near the cluster; ignore.

## Profile overlay
`processing-profiles.json → narrowband_palette` is deep-merged over the class profile for SHO/HOO.
It sets stretch target 0.12, SPCC off, Ha-injection off, and saturation max_p90 0.85.

## HOO (bicolor, no SII) — WI-11
Example config: `NGC6888_HOO_agentic.json` (`files.Ha`, `files.O`, no `files.S`; the classifier picks workflow `HOO`, `starless: true`).
- `sho_combine` defaults to palette `hoo` for an HOO brief. A non-hoo palette without SII returns `palette X needs SII; this is an HOO dataset — use palette "hoo"`. `suggest_narrowband_balance` and `repair_star_residuals` skip `FILTER_S` for HOO.
- Bracket `hoo_o_weight` 0.5 / 0.65 / 0.8 and `o_gain` (OIII is what makes the image). Optional `sho_hue_saturation` (red/orange, cyan/blue +0.10). There is no `sho_hue_shift` step: the hoo mapping cannot produce green or magenta.
- `measure_palette_balance` takes `palette: 'hoo'`; its notes then say only `cyan/blue X% — OIII not reading: raise o_gain or hoo_o_weight`. The finish palette gate thresholds are unchanged.
- `maxChannelImbalance` is `null` for SHO/HOO briefs, so the `channel_balanced` hard constraint returns pass ("false-color palette — skipped").

## Rendered prompt layout for narrowband (giga-orchestrator)
The broadband sections that do not apply are removed when `brief.dataDescription.narrowband` is true. Broadband renders are byte-identical to `test/golden/prompt-*.txt`.
- Header: "NARROWBAND <wf> MODE" (no photometric colour calibration, delivered channels only, `Stars: none (starless deliverable)` or the on-disk linear star layer paths, and the `begin_composition` entry rule).
- Practices: no star blend, no LRGB, no astrometric-solution lines. Star-quality section and pre/post-star clamp bullets are omitted when starless. Ha-injection lines are omitted (Ha is a palette channel).
- Branch C = the palette recipe (SHO steps 1-9 verbatim, luminance option is step 10; HOO variant above). Branch D is omitted when starless (a short star-layer note otherwise).
- Compositions: `COMP_palette_foraxx` / `COMP_palette_sho` (HOO: `COMP_palette_hoo`), `COMP_synthL` (Ha or 0.7 Ha + 0.3 O as L, lightness <= 0.5), `COMP_halo_lift`.
- Phase 7.5 is a palette background check: `measure_palette_balance`, `run_gradient_correction` on the mono `FILTER_*` view then rebuild with `sho_combine`, `neutralize_palette_background` last. No ABE/SCNR on the palette.
- Finish hints: DETAIL TOO LOW -> `shell_detail_enhance` (medium 0.6, large 0.4) through a body mask; TONAL SUBDUED -> luminance-mask `run_curves` lift then `lift_faint_halo`. `star_protected_blend` / `star_screen_blend` refuse on a starless brief.
- Memory: entries are stamped with `workflow` and `starless`; a narrowband recall excludes broadband-stamped universal/trait entries and starts with a "STARLESS NARROWBAND run" note.

## Narrowband prep cache, linear snapshots, warm start (WI-12)
**NB result cache** (`narrowband-prep.mjs`, dir `~/.pixinsight-mcp/prep-cache/<key>_nb/`):
- Key = sha256(narrowband-prep.mjs + ops/sho-palette.mjs + fingerprints of S/Ha/O + `files.starless` + resolved stretch target/headroom + ONLY the channel-affecting options `nxtLinear, nxtPost, bxtNonstellar, gradientEdgeSigma, repairStarResiduals, forceAlign, stretchTarget`). `computeNbCacheKey(F, nb, target, headroom)` (pure; unit-tested in `test/nb-prep-cache.test.mjs`). `palette / hGain / hueShift / scnr` are NOT in the key: they only drive the cheap initial composite, rebuilt on every hit.
- Invalidation: editing narrowband-prep.mjs or sho-palette.mjs, changing a master (size/mtime/head/tail), the stretch profile, or the profile NXT values (`narrowband_palette.tools.NXT`) gives a new key. `nb.noCache` / `opts.noCache` forces a miss.
- Miss: chain runs (align, BXT, linear NXT, SXT, stretch, NXT post, residual repair), then the stretched starless FILTER_S/Ha/O are saved with meta.json (stats, starLayers, gradient, residualRepair, linear snapshot paths, prepSeconds). Star layers and linear snapshots are hard-linked into the cache dir (no extra disk). Log: `NB cache MISS (<key>)` then `channel chain took Ns` (this is the measured prep duration; the earlier "30+ min" figure was never measured).
- Hit: existing FILTER_*/target windows are force-closed, the XISFs reopened (crop_mask closed, renamed), stats/narrowband restored, files hard-linked into `<runDir>/prep/` so the run is self-contained. Log: `NB cache HIT`. A missing cached file is a miss. The palette tail (shoCombine, hue shift, SCNR, balance, detail baseline) always runs.

**Linear starless snapshots**: after SXT each channel is saved to `<runDir>/prep/FILTER_<H|S|O>_linear_starless.xisf` (~230 MB each). `result.narrowband.prepParams` records nxtLinear/nxtPost/stretchTarget/headroom/hueShift/scnr/hGain; they are printed in the giga initial message ("Prep applied: ..."). `<runDir>/prep/nb-prep.json` persists the narrowband block for warm start.
- Tool `reload_narrowband_channel {channel:'S'|'H'|'O', stretch_target?, nxt_post?}` (category narrowband): closes FILTER_<ch>, reopens the snapshot, Seti-stretches (default prep target), optional NXT (default none), returns stats; leaves exactly one window of that name.
- Tool `measure_background_grid {view_id}` (measurement, mono only): edgeSpread/edgeMin/edgeMax in sigma. The prep still applies GC deterministically when edgeSpread > 1.5 sigma (measured spread on the only real dataset was <= 0.3 sigma; a per-channel gradient sub-agent is poor value).

**NXT from the profile**: `narrowband_palette.tools.NXT` = `denoise_linear` (0.30) / `denoise_linear_per_channel {H .25, S .35, O .35}` / `denoise_post_stretch` (0.45) / `denoise_post_stretch_per_channel {H .30, S .60, O .45}`. Per-channel entries win over the scalar; `files.narrowband.nxtLinear` / `nxtPost` still override. Any NXT the agent applies is on top of the prep's post-NXT.

**Warm start** (`--base-run <run>` of a narrowband run): `warmstart.loadBaseRunAsPrep` reads the base brief; if `dataDescription.narrowband` it reopens FILTER_S/Ha/O from `<baseRun>/prep/` (fallback: recompute the NB cache key from the current config; else throws "rerun prep"), restores the narrowband block (prepParams, star layers, linear snapshots) so the NARROWBAND section and `lift_faint_halo`/`sho_combine` defaults resolve. `rgb` = base winner. Requirement: base run's `prep/` still present (runs are pruned to 3 by default; protect the base run) or the cache entry still exists.
