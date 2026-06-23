# Agentic Pipeline — Review & Handoff

**Date:** 2026-06-22
**Purpose:** Hand off a full-context review brief to the next (ultracode-reset) session. Part 1 is the factual history of a long NGC 7023 (Iris Nebula) processing session and what we learned. Part 2 (appended by a multi-agent review workflow) is a deep pipeline review + out-of-the-box metric proposals. Part 3 is the charter for the next session.

> **The signal is there.** Across 5 iterations we produced individually excellent *pieces* (a clean natural look; a gorgeous brown-IFN/background/star field) but never combined them into one satisfying image. The pipeline trades one win for another instead of converging. The goal of the review is to fix *how we work*, not to do another art run.

---

## Part 1 — Session history (factual)

### Target & environment
- **Target:** NGC 7023 (Iris Nebula) — bright blue reflection nebula around HD 200775, embedded in the brown LDN 1174 dark/IFN cloud. HaLRGB.
- **Masters:** full-frame **6224×4168** (R, V→G, B, HAlpha, L), already co-registered (WBPP common reference). Carry RA/DEC/FOCALLEN(1487.8)/XPIXSZ(3.76µm) → 0.52″/px. (Stored under a wrongly-named `NGC3628/` folder due to a WBPP path mixup — data verified as genuine NGC 7023.)
- **Machine:** 16 GB RAM Mac, small system disk. PixInsight driven via the file-bridge watcher.

### Pipeline entry point (IMPORTANT)
- The real pipeline is **`agents/llm/giga-run.mjs`** — a single Claude Max "giga" mega-agent (71–73 MCP tools) in 4 stages: deterministic **prep-A** (open/align/combine, cached) → **gradient sub-agent** (linear color-gradient correction) → **prep-B** (BXT/SPCC/SCNR/NXT/SXT/stretch) → **creative agent** (the long, autonomous compositing phase with quality gates).
- `agents/orchestrator.mjs` is an **old rule-based Phase-1 MVP** (no Ha/star/LRGB, stats-only scoring). It was run by mistake first and produced junk — **do not use it.**

### Iteration log
| Iter | Change | Result | Verdict |
|------|--------|--------|---------|
| **01** | First giga run, full-frame | Core read "burnt" (perceptual: relContrast 0.10, but 0% clipped) + low-coverage edge **wedge** artifact from the full frame | Diagnosed: not clipping, *low relative contrast*; edges = un-trimmed low-coverage stack border |
| **02** | Added `check_core_contrast` gate + noise-aware **autocrop** edge-trim | Core fixed (relC 0.57), edges clean | **Too synthetic + too noisy** (user) |
| **03** | Added `check_noise` gate + pulled back saturation/LHE | Natural look, low noise (bgNoise 0.018) | Best *natural* result. **Preserved → `NGC7023_iter03.*`** |
| **04** | Lifted background (target 0.16→0.20) + brown-IFN profile guidance + **star-blob fix** (aggressive `star_protected_blend`) | **"IFN/background/stars absolutely gorgeous"** (user) — BUT **color cyan/teal** + **heart burnt** | **Preserved → `NGC7023_iter04.*`**. Discovered **SPCC never runs** (see bugs) |
| **05** | Manual color (SCNR 0.7 early) + core structure before compose | Color → natural blue (cyan gone), heart metric structured (relC 0.334) | **IFN regressed** (background darkened/greyed by aggressive SCNR) + small white center remains. User: *"not worth the time and tokens spent."* |

### What works vs what fights itself (per dimension)
- **Wide field / framing:** full frame + noise-based autocrop (trim low-coverage edges, RGB+L only) = good. *Gotcha: cropping the Ha window hangs PI for 20 min — keep Ha out of the crop set.*
- **Brown IFN / background:** best in **iter-04** (background lifted ~0.20, warm brown). Aggressive SCNR (for color) **greys/darkens it** — direct conflict with color correction.
- **Color:** never calibrated (SPCC broken). Manual SCNR+balance can reach natural blue (iter-03, iter-05) but is fragile and fights the IFN.
- **Core / "heart":** tension between (a) lifting background, (b) removing SXT's mis-extracted central glow blob, (c) keeping core structure. The `check_core_contrast` metric (relative local contrast) catches *perceptual* burn that clipping gates miss, but a passing metric (0.334) still showed a small white center → metric isn't fully capturing the percept.
- **Noise:** `check_noise` gate (background pixel-grain) reliably triggers one light NXT pass. Works.
- **Stars:** `star_protected_blend` with aggressive core protection (min_strength_fraction 0, thresholds 0.55/0.70) correctly stops SXT's central-glow blob being re-added. Works.

### Confirmed bugs & gaps (fixed = ✅)
1. **SPCC / plate-solve broken (the big color blocker).** `deterministic-prep.mjs` plate-solve: (a) uses the **wrong ImageSolver API** (`executeOn` + process-style props — ImageSolver is a *script* needing `Init()`+`SolveImage()`), (b) the success check `w.astrometricSolution` is **`undefined`** in this PJSR build (always logs "FAILED"), (c) hardcodes **pixSize 1.88** (real 3.76µm). Verified the correct API *does* solve (solution in `P.metadata`, 0.529″/px) — the remaining gap is **persisting the WCS to the window** so SPCC consumes it. Detail in memory `project_platesolve_spcc_broken`.
2. ✅ **New gates added this session:** `check_core_contrast` (Gate 3c — perceptual burn = low gradient/brightness ratio in the bright core) and `check_noise` (Gate 3d — background pixel-grain → light NXT). In `subject-metrics.mjs` + `tools.mjs` + `ops/index.mjs`.
3. ✅ **Autocrop upgraded:** trims pure-black *and* low-coverage noisy edges (per-edge, by MAD/brightness vs a clean-background grid reference). `deterministic-prep.mjs` Step 3b.
4. ✅ **Prep cache-save bug:** a boolean in `config.files` (`autoCropBorder`) broke a `.trim()` filter → cache never saved. Guarded.
5. ✅ **Cache-hit Ha restore:** phase-1 cache stores only RGB+L; on a cache hit Ha was missing → prep-B "null view". Now re-opens Ha.
6. ⚠️ **Ha autocrop hang:** adding Ha to the crop set causes a reproducible 20-min PI hang at Step 3b. Reverted (Ha left full-frame).
7. ⚠️ **Rejection sub-windows leak** (full-frame masters bring `rejection_low/high`; the open-loop close has a listImages timing race). Minor (~200 MB), worth tightening.

### Operational lessons (in memory)
- **PI OOM = disk-full starving swap, not image size.** User runs full-res routinely on 16 GB. Never downsample. Free disk instead. (`feedback_full_res_no_downsample`)
- **To free swap: close all images in PI first** (PI then releases swap), never delete `~PI~*.swp` while images are open (forces a kill). (`feedback_swap_cleanup_close_first`)
- During an active run, only safe disk levers are non-active run dirs + stale prep-cache (keep latest 2–3 runs).
- Bridge `run_script` timeout = 20 min (poll 500 ms × 2400).
- **Verification overhead is real:** my per-iteration manual checks (many bridge calls, full-res opens, preview JPEGs) cost meaningful tokens on top of the ~45–90 min runs.

### Preserved artifacts
- `/Volumes/Extension/NGC7023/masters/agentic/NGC7023_iter03.{xisf,png}` — clean natural.
- `/Volumes/Extension/NGC7023/masters/agentic/NGC7023_iter04.{xisf,png}` — gorgeous IFN/background/stars (but cyan + burnt core).
- `iteration_01..05.md` in the same folder (per-iteration write-ups).
- Reference image the user supplied (target look): structured blue core + dust lanes threading in + **prominent brown IFN filling the frame**.

---

## Part 2 — Deep pipeline review & out-of-the-box metrics

*(From the `pipeline-review-and-plan` multi-agent workflow — 14 agents, grounded in code with file:line refs.)*

## 2a. Current-state map (concise)

**How it decides.** One mega-agent (`giga_orchestrator`, `giga-run.mjs:305`) driven by `claude -p` runs the whole creative pipeline after a deterministic prep + a 50-turn gradient sub-agent. The agent self-generates 4-way brackets (weak/target/edge/overdone) per concern branch, self-critiques, self-composes, and self-selects **one** `variant_id` via the `finish` tool. There is no automated ranking — `submit_scores` is a no-op in the giga path (`tools.mjs:3135`), and `scoring.mjs`'s aggregate is advisory-only, never used to pick a winner.

**What it measures.** ~10 hard finish gates (`tools.mjs:1955-2292`): burn scan (0.95 clip + 0.80 bright-block), core contrast, bg noise, subject detail, exposure, saturation P90, tonal presence, highlight texture (vs a pre-op *clone*, not a target), L-data usage, star quality/brightness. All are **pixel statistics against absolute floors**.

**What it does NOT measure.** Aesthetic quality (`aesthetic_coherence` hardcoded 70, `scoring.mjs:212`), reference-image similarity, color/hue correctness (only channel-median balance + saturation magnitude), IFN visibility (computed inside tonal-presence but never gated), dust/reflection color, star-color *correctness*, structured noise/banding.

**How competitive attempts are scored/promoted.** They aren't, durably. Winner = the agent's `finish` choice → `final-selection.json` (no score stored). Cross-run carry-over is three lossy channels: prose `recall_memory`; win-only regex round-trip → `learned_overrides`; a fresh `ArtifactStore` per run — **all branch search restarts from zero every run.**

## 2b. Why results don't converge

1. **Whack-a-mole is structural.** Each run promotes exactly one global winner. Iter-04's brown IFN and iter-05's clean core can never coexist — nothing records *which dimension* each run won, and the compositor improvises from a fresh baseline. No Pareto frontier, only a sequence of single picks.
2. **No cross-run best-per-dimension memory.** `list_variants` is per-agent, per-run. No tool loads a prior run's winning image. The agent re-derives all brackets from the freshly-prepped baseline every run.
3. **Stats-only metrics can't see "cooked."** A uniformly white core scores `coreRelContrast=0.334` and **passes** gate 3c because the metric is gradient-energy ÷ luminance — blind to channel saturation and clip fraction. Greyed dust passes saturation gates because magnitude ≠ hue correctness.
4. **SPCC silently never runs.** `deterministic-prep.mjs:610-626`: `ImageSolver` (a PJSR *script object*) invoked as a *process*; success check reads `w.astrometricSolution` (real property is `w.hasAstrometricSolution`); `pixSize=1.88` hardcoded (half the true 3.76µm → 2× wrong scale). Falls back to background-neutralization, leaving green casts that the **duplicate unmasked `run_scnr` (default 0.80, `tools.mjs:846`, shadows the masked 0.50 at `:398`)** greys into the brown dust.
5. **Full-regen cost.** Prep + gradient + entire creative search re-run every time (`giga-run.mjs:199`). (`maxTurns` is doc-only; sole limit is the 2h spawn timeout.)
6. **No pruning of never-winning approaches.** Learning is win-only; `checkBranchCompleteness` (`state-machine.mjs:422`) *forces* ≥2 variants per branch and never drops a perennial loser.

## 2c. Out-of-the-box proposals (ranked)

| # | Proposal | Impact | Effort |
|---|----------|:--:|:--:|
| 1 | Promotion ledger + prune-never-promoted | 5 | 2 |
| 2 | Core-whiteness / IFN-visibility / dust-color metrics + gates | 5 | 2 |
| 3 | SPCC/WCS-persist fix (+ kill SCNR dup) | 5 | 1 |
| 4 | Cross-run best-per-dimension memory + region compositor | 5 | 4 |
| 5 | Reference-similarity gate + vision-aesthetic critic | 4 | 3 |
| 6 | Warm-start from prior winner (`--base-run`) | 4 | 2 |
| 7 | Specialist agents + cheap judge panel | 4 | 4 |

**(1) Promotion ledger** — global `~/.pixinsight-mcp/ledger.json` keyed by classification; per coarse approach-signature records `tried/promoted/rejected` + `reject_reasons{gate}`. New `agents/ledger.mjs`; write at `finish` success (`tools.mjs:2316`); `extractLedgerGuidance(classification)` injected into the agent prompt (`giga-run.mjs:610`) emitting PRUNE (`tried>=4 && promoted==0`) + FAST-TRACK (`promoted/tried>=0.6`) lists; `checkBranchCompleteness` drops pruned branches; epsilon-greedy re-admit every ~10th run; cold-start `tried<4` = full exploration.

**(2) Domain metrics** — extend `measureCoreContrast` with `coreWhiteFraction` (`S<0.08 AND max(RGB)>0.85`) + `coreSat` → OR-clause on gate 3c; new `measureFaintStructure` (faint band `[bg+1.5MAD, bg+5MAD]`, star-rejected → `faintContrast`,`faintCoverage`); new `measureDustColor` (`g_excess=G-(R+B)/2` green-cast detector). All in `subject-metrics.mjs`, registered as `measurement` tools, gated/warned in `finish`.

**(3) SPCC fix** — script-object solve `solver.Init(w); solver.SolveImage(w)` then `solver.metadata.SaveKeywords(w); SaveProperties(w)`; check `w.hasAstrometricSolution`; keyword-derived `pixScale=206.265*XPIXSZ*XBINNING/FOCALLEN`. **Delete duplicate `run_scnr` at `tools.mjs:846-871`**; cap surviving SCNR ≤0.30 + preserveLightness for dust classes.

**(4) Best-per-dimension + compositor** — ledger records per-dimension champions pointing at durable `variant_NN/image.xisf`; `recall_champion(class,dim)` + `blend_regions(base,donor,mask)` (modeled on `star_protected_blend`); inject mandatory `COMP_champion_merge` candidate; optional `compare_to_champions` Pareto signal.

**(5) Perceptual** — `vision_aesthetic_critic` (render JPEG → fresh `claude -p` judge → `{score,flaws}`) + `compare_to_reference` (CIELAB ΔE histogram-match + multiscale SSIM + IFN-coverage delta). Finish gate 11 (aesthetic) + 12 (reference, when `reference_path` set).

**(6) Warm-start** — `--base-run <id>` guards prep/gradient; `load_prior_winner(class)`; persist+replay gradient solution by prep-input hash.

**(7) Specialists** — IFN/color/core/stars specialists → composer → cheap Haiku judge. Propose only; gate behind the ledger proving branch value.

## 2d. Implementation plan

**(A) SAFE, now:** A1 SPCC fix + SCNR de-dup (`deterministic-prep.mjs:610-626`, `tools.mjs:731-737,846-871`). A2 domain metrics+gates (`subject-metrics.mjs`, `tools.mjs:2049`, `processing-profiles.json`). A3 promotion ledger+prune (new `agents/ledger.mjs`, `tools.mjs:2316`, `giga-run.mjs:610`, `state-machine.mjs:422`).
**(B) MEDIUM:** B1 warm-start (`giga-run.mjs:199,210`). B2 reference+aesthetic critic. B3 best-per-dimension + compositor.
**(C) BIG (propose only):** C1 specialist agents + judge panel — gate behind ledger evidence.

**Sequencing:** A1 makes color trustworthy, A2 makes "cooked" measurable, A3 builds the data substrate B1/B3 need. B is the payoff layer. C deferred until the ledger proves decomposition earns its complexity.

---

## Part 2e — IMPLEMENTED this session (A-tier, adversarially reviewed + verified)

All three SAFE-tier items shipped, reviewed by a 5-agent adversarial workflow (which caught 2 real blockers, both fixed), and re-verified:

**A1 — Color backbone (SPCC now runs).** Root cause was narrower than first thought: the masters already carry `hasAstrometricSolution=true`; the prep just failed to copy it.
- `deterministic-prep.mjs`: WCS copy fixed — `src.hasAstrometricSolution` (was the undefined `astrometricSolution`) + `copyAstrometricSolution(src)` (1-arg; 2-arg threw). Now guards the open, closes rejection sub-windows, dimension-checks before copy. Fallback plate-solve rewritten to the ImageSolver **script API** (`Init`/`SolveImage`/`SaveProperties`+`SaveKeywords`, `hasAstrometricSolution`, leak flags, no hardcoded pixSize). *Empirically verified the copy sets the solution on the target.*
- `tools.mjs` + `gradient.mjs`: deleted the **duplicate unmasked `run_scnr`** (default 0.80) that shadowed the masked one and greyed dust; survivor is dust-aware (caps 0.30 + `preserveLightness` for reflection/IFN classes).

**A2 — "Cooked/burnt" is measurable.** `subject-metrics.mjs measureCoreContrast` now also computes core **saturation** + **white-clipped fraction** and fails the gate on a white core (`coreWhiteFraction>0.15`) — fixes the 0.334 false-pass. The saturation-collapse clause is **classification-gated to emission/PNe only** (B1 fix — so it never false-fails naturally low-sat galaxy bulges or blue/white reflection cores). Routed through the existing finish gate 3c.

**A3 — Promotion ledger (cross-run learning).** New `agents/ledger.mjs` → `~/.pixinsight-mcp/ledger.json`, keyed by classification. Records each coarse approach-signature's tried/promoted/rejected; feeds the agent a **PRUNE** list (tried≥4, never promoted → don't generate) + **FAST-TRACK** list, epsilon-greedy re-admit. Wired in `giga-run.mjs` (prompt inject + post-run `recordOutcomes`). B2 fix: reads the winner from `final-selection.json` (the giga flow does NOT populate `manifest.agents`). *Unit-verified end-to-end in the real giga-flow shape.*

Minor review findings also fixed: prep open-guard + dimension-guard + rejection-window close (M2/M4/M5), epsilon write moved off the read path (M8), word-boundary signature matching (M9), memory doc property corrected (M10), stale SCNR "masking" claims updated (M7). Deferred (low-risk): keyword-merge vs overwrite (M1), channelSwap reference path (M3), tighter white-band (M6).

**Files changed:** `agents/ledger.mjs` (new), `agents/llm/deterministic-prep.mjs`, `agents/llm/tools.mjs`, `agents/llm/giga-run.mjs`, `agents/llm/prompts/giga-orchestrator.mjs`, `agents/ops/subject-metrics.mjs`, `agents/ops/gradient.mjs`. Nothing committed (review/test only) — validate on a live run before committing.

---

## Part 2f — B-TIER IMPLEMENTED (adversarially reviewed: 0 blockers)

All five B-tier features integrated; a 5-agent adversarial review found **zero blockers** (extensive CONFIRMED-CORRECT list); 10 minor items, the real ones fixed. Both high-risk mechanisms empirically verified.

- **B1 warm-start** — `agents/llm/warmstart.mjs` (new) + `giga-run.mjs` `--base-run <runId>` (skips prep+gradient, loads a prior winner for touch-up) + **gradient-solution snapshot cache** (identical-input reruns replay instead of re-spawning the sub-agent) + `load_prior_winner` tool. → cheap iteration.
- **B2a vision-aesthetic critic** — `agents/llm/aesthetic-critic.mjs` (new): spawns a fresh `claude -p` competition judge over a rendered JPEG (OAuth/Max, zero $), cached by image hash. `vision_aesthetic_critic` tool + **finish Gate 11** (BLOCK if score < `min_aesthetic` default 6.0). *Verified: judge returns clean JSON; its read of the validation image matched the human critique.* → first metric of "better/cooked", not just "not broken".
- **B2b reference similarity** — `compareToReference` (CIELAB color-EMD + multiscale luminance SSIM + faint-coverage delta) in `subject-metrics.mjs`; `compare_to_reference` tool + **finish Gate 12** (active only when `brief.reference_path` set; BLOCK color_emd>0.25 OR coverage_delta>0.30). `referencePath` flows config.files → brief. → judge vs a user reference image.
- **B3a per-dimension champions** — `ledger.mjs` `recordChampions`/`getChampions`/`scoreVariantDimensions`/`CHAMPION_DIMENSIONS`; finish records the promoted winner's per-dimension champions (ifn_visibility, core_integrity, color_richness, star_quality, detail) pointing at durable variant XISFs; `recall_champion` tool + prompt visibility. → best-of-breed memory across runs.
- **B3b region compositor** — `blend_regions` tool (geometry-guarded per-channel PixelMath; mono-base guarded) + `compare_to_champions` (Pareto signal using the SAME `scoreVariantDimensions`) + `giga-orchestrator` **COMP_champion_merge** mandatory candidate. *Verified: PixelMath blend = exactly base*(1-w)+donor*w (0.5000), RGB + mono.* → the whack-a-mole killer: graft iter-04's IFN + iter-05's core into one frame.

**Minor fixes applied:** mono-base blend guard, reference-window leak close-all, spurious-run-dir guard on bad `--base-run` id, `loadLedger` `.classes` normalization, REFUSED-message + quote-escape cosmetics, gradient-hash L-presence comment.

**Files:** `agents/llm/{warmstart,aesthetic-critic}.mjs` (new), `agents/llm/{giga-run,tools}.mjs`, `agents/llm/prompts/giga-orchestrator.mjs`, `agents/{ledger,classifier}.mjs`, `agents/ops/{subject-metrics,index}.mjs`. **Not committed** — validate on a live run before committing. `buildToolSet('giga_orchestrator')` now returns 79 tools (6 new).

**To use B-tier on a run:** add `"referencePath": "/abs/ref.xisf"` under `files` to activate Gate 12; pass `--base-run <runId>` to warm-start a touch-up; the ledger/champions/aesthetic-critic engage automatically. Each completed run now records champions + ledger outcomes for cross-run learning.

---

## Part 3 — Charter for the next (ultracode) session

**Mission:** Improve *how the agentic pipeline works* so it converges to one satisfying image instead of trading wins across runs.

Deeply review the pipeline and think out of the box, with emphasis on:
1. **Metrics that match human/aesthetic judgement** — the user judges by eye against reference images; our metrics are stats-only. Consider reference-image similarity, vision-model aesthetic critics, perceptual color/burn metrics.
2. **Beating the whack-a-mole** — cross-run memory of *best-per-dimension*, multi-objective/Pareto selection, and/or a *compositor* that merges the best aspects (iter-04's IFN + iter-05's color/core) rather than regenerating everything.
3. **Color** — fix the SPCC/plate-solve gap (WCS-persist) for photometric color, and/or robust color metrics that don't fight the IFN.
4. **Cheaper, faster iteration** — avoid re-running prep/gradient every time; targeted touch-ups; reduce verification overhead; converge in fewer runs.
5. Anything else that makes results more satisfying — the signal is there (iter-03 + iter-04 prove the pieces exist).
