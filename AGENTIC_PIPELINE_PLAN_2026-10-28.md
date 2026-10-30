# PixInsight Agentic Pipeline — Improvement Plan (2026-10-28)

Lead-architect synthesis of 47 verified findings (models, prompts, metrics, tools, architecture, narrowband, feedback-alignment). Overlapping findings are merged into 27 work items; conflicts between findings are resolved explicitly below. Each item names exact files/functions, has an acceptance test, and marks whether PixInsight must be running (`[PI REQUIRED]`).

## 0. Ground rules the plan enforces (from user memory — treated as requirements)

1. **Agentic-first**: add tools, measurements and context; never hardcode workflows. Hard caps are kept only where the user accepted them (galaxy star midtone/blend caps, finish gates).
2. **Calibrate every gate against a user-approved image** before it blocks. A gate that rejects an approved image is wrong by definition. New gates ship ADVISORY and are promoted only after the back-test harness (WI-01) passes.
3. **Natural over synthetic** for broadband galaxies; **rich and expansive** for emission/SHO palettes. Taste is class-dependent — encode it per profile, never globally.
4. **Full-res, never downsample** masters. Previews/crops may be resampled.
5. **No double star blend; stars delivered linear; fix upstream, never downstream.**
6. 16 GB Mac, PI crashes at ~10 full-res windows: every new PJSR path closes temp windows in `finally`; no change may add persistent windows.

## 1. Conflict resolutions (decided here so Sonnet does not have to)

| Conflict | Decision |
|---|---|
| State machine: "delete STATE_TOOLS, go category-based" (architecture-state-allowlist) vs "add tools to the sets" (tools-state-blocks, prompts-phase-plan) | **Minimal-incremental**: keep `STATE_TOOLS` but (a) make pure measurement tools public, (b) add dust/mask/detail tools to `compose`, (c) make `finalize` a superset of `compose`, (d) a REJECTED finish no longer transitions, (e) add a public `begin_composition` sentinel, (f) blocked calls consume budget. Category-based policy is deferred: the repair engine relies on restricted-set semantics (WI-06) and a rewrite would silently disable `forbiddenTools`. |
| Model defaults: "pin giga to opus" vs "do not silently switch away from fable" | **Explicit = current baseline.** All agents get an explicit, *recorded* model; giga_orchestrator default `inherit` (= user's `fable`, effort high). Opus/sonnet reassignments are A/B decisions made from recorded `modelUsage` via the ledger, not asserted in this plan. See §4. |
| Galaxy saturation numbers: hard-code 0.58/0.37 (feedback_alignment) vs "anti-agentic, M81 approved at 0.70" (skeptic) | Encode **intent + bracket**, not one recipe: profile `look` block with `target_p90`/`max_p90` per class, prompt renders a restrained→overdone bracket around the profile midpoint, gate warns above target and fails above max. Final numbers come from the harness on the approved images; plan values are provisional starting points. |
| Gate 11 (critic): "make advisory" vs "keep blocking for galaxies" | Advisory everywhere **until** `aesthetic_gate.min_score` is set per profile from ≥8 rated pairs; starless/narrowband never blocks; context-aware rubric. Gate 12 (reference) stays the grounded blocking gate when a reference is registered. |
| IFN tools in finalize only vs make public | `measure_dust_coverage/check_noise/measure_color_gradient/get_image_dimensions` → public (read-only). `lift_dust/inject_l_ifn` → stay restricted, added to generate_candidates + compose (repair policies must still govern them). |
| PNe HDRMT: prompt mandates GLOBAL unmasked HDRMT vs profile/memory say donut mask | Delete the global mandate; present the **donut-mask recipe as a validated option** in the branch phase (M97 e8834489 / M27 944196c5); do not add run_hdrmt to compose for PNe. |
| LRGB: "MUST lrgb_combine" vs ">2× ratio → PixelMath injection" | Ratio-routed decision block in prompt + new `inject_luminance` tool + provenance-based Gate 10. |
| Legacy orchestrator: delete vs archive | Archive to `agents/legacy/llm/` (engine.mjs, orchestrator.mjs, 8 prompts); remove the 3 SDK deps. Keep `vision.mjs` intact (`jpegToContentBlock` is live). |
| Detail gain cap: galaxy 1.6 vs approved M81 +76% | Ship `detail.max_gain` ADVISORY; promote only after harness measures NGC3628 approved + M81/NGC891 champions (if the user re-exports them). |

## 2. Prioritised work items (ordered by priority, then dependency)

### Phase 0 — Foundations (do first; everything else back-tests through these)

**WI-01 (P0) Gate back-test harness + approved-image registry + `runFinishGates` extraction + `run_quality_gates` tool** `[PI REQUIRED]`
Merges metrics-01, tools-no-preflight-gate-battery, gate-constants half of prompts-gate-numbers-disagree. Extract the 12-gate body of `finish` into `evaluateFinishGates(ctx, store, brief, viewId, agentName, opts)`; add `agents/calibration/approved-images.json` seeded ONLY with files verified on disk today; `scripts/backtest-gates.mjs`; `agents/llm/gate-contract.mjs` constants; public read-only `run_quality_gates` tool.

**WI-08 (P1) Explicit per-agent model/effort + recording** — prerequisite for any model A/B (§4).

**WI-07a (P1) Engine hygiene: enforce turn budget, classify timeout/max-turns, stdin closed, prompt via file, best-variant fallback** — makes failed runs produce an export and a labelled cause.

### Phase 1 — P0 quality defects

**WI-02 (P0) Aesthetic critic: context-aware rubric, advisory Gate 11, spawn hygiene, calibration log** `[PI REQUIRED for back-test]` — confirmed empirically: the current rubric scores the user-approved PACMAN LIFT5 at 5.4–5.6 < 6.0 → would reject it.

**WI-03 (P0) Galaxy natural look: profile `look` block, intent-driven Branch C, Gate 7 per-class, ledger color_richness, memory re-levelling** `[PI REQUIRED for calibration]`.

**WI-04 (P1) Star contract: single prominence source, profile-driven blend caps and star_protected_blend defaults, "(stretched)" label fix** `[PI REQUIRED for back-test]`.

### Phase 2 — Control plane (reliability + "fix upstream")

**WI-05 (P1) State machine corrections** (tools-state-blocks, tools-rejected-finish, architecture-rejected-finish, architecture-state-allowlist, prompts-phase-plan, narrowband-no-compose-path).
**WI-06 (P1) Repair engine actually engages** (metrics-05, architecture-repair-policies-never-engage). Depends on WI-05.
**WI-07b (P1) PI crash sentinel, MCP state persistence, `--resume-agent`, variant counter from disk, window-pressure signal** (models-01, architecture-crash-swallowed, tools-variant-load-and-window-pressure).
**WI-10 (P1) Tool-set hygiene: `AGENT_TOOL_CATEGORIES.giga_orchestrator`, hidden/visibleTo, prompt references to hidden tools** (models-05, tools-giga-served-all-92, metrics-13 scoring part).
**WI-09 (P1) giga-orchestrator prompt consistency pass** (prompts-ifn-branch-skipped, prompts-phase-plan prompt half, prompts-pne-global-hdrmt, prompts-lrgb-block, prompts-gate-numbers prompt half, prompts-visual-overrides, prompts-dead-phase1, feedback_alignment-eyes-override, feedback_alignment-stale-history, models-04 diagnostics). Depends on WI-01 (gate table), WI-05 (state names), WI-10 (hidden tools).

### Phase 3 — Tools & metrics (P1)

**WI-13 (P1) `inject_luminance` tool + provenance-based Gate 10** (tools-missing-inject-luminance, feedback_alignment-lrgb).
**WI-14 (P1) PJSR error propagation (`pjsrOrThrow` + `executeOn` check)** `[PI REQUIRED]` (tools-pjsr-errors-swallowed).
**WI-15 (P1) Mask shaping tool, 1:1 crop previews, post-op metrics, startup diagnostics delivered** `[PI REQUIRED]` (tools-mask-ops-missing, tools-no-1to1-crop-preview, tools-missing-post-op-metrics, models-04).
**WI-17 (P1) Core relC advisory when core is structured + galaxy core_burn calibration** `[PI REQUIRED]` (metrics-04).
**WI-18 (P1) Credible detail metric + prep baseline + advisory gain cap** `[PI REQUIRED]` (metrics-08).
**WI-19 (P1) Ledger/champions: dust wired, scoreVersion, stage/approach signatures, workflow key, params_summary persisted, dead learning paths removed** (metrics-12, architecture-ledger-signature, architecture-dead-learning-paths, narrowband-ledger-keyed-by-class).
**WI-16 (P1) Star field metric rework (compact-peak detection, local-bg FWHM, center/edge, absolute prominence)** `[PI REQUIRED]` (metrics-06). Advisory first.
**WI-24 (P1) Old-run cleanup + orphan-swap cleanup by PI start time** (feedback_alignment-giga-run-no-old-run-cleanup).

### Phase 4 — Narrowband path (never run end-to-end yet)

**WI-11 (P1) Narrowband prompt conditional rendering, starless blend refusal, HOO defaults, channel_balanced skip, gate hints, recall filter** (prompts-narrowband-stale, narrowband-prompt-broadband-residue, narrowband-hoo-path-broken, narrowband-finish-gate-messages, narrowband-memory-recall-pollution).
**WI-12 (P1) Narrowband prep cache, channel snapshots, `reload_narrowband_channel`, profile NXT wiring, warm-start** `[PI REQUIRED]` (narrowband-prep-no-cache, narrowband-prep-hardcodes-creative-choices).

### Phase 5 — P2 hygiene & new advisory metrics

WI-20 memory/docs hygiene · WI-21 compare_to_reference rework `[PI]` · WI-22 gradient agent fixes · WI-23 prep BXT profile-driven + applied recipe + visible caps · WI-25 observability + legacy archive · WI-26 new advisory metrics (banding, chroma noise, texture baseline, PSF field) `[PI]` · WI-27 core-specialist contract + load_variant id forms.

## 3. Calibration protocol (used by every gate item)

Registry `agents/calibration/approved-images.json` — seed ONLY with files verified present on 2026-10-28:

| id | path | class | verdict | notes |
|---|---|---|---|---|
| pacman_lift5 | `/Volumes/Extension/PACMAN/output/claude/final/NGC281_SHO_starless_iteration_01_haloLift5.xisf` | narrowband_palette (emission_nebula@SHO), starless | approved ("really perfect") | sat P90 0.785 — rich palette is correct |
| pacman_iter01 | `/Volumes/Extension/PACMAN/output/claude/final/NGC281_SHO_starless_iteration_01.xisf` | same | superseded (earlier iteration, green-Ha) | negative control for palette/reference metrics only |
| ngc7023_iter03 | `/Volumes/Extension/NGC 7023/masters/agentic/NGC7023_iter03.xisf` (note the space) | reflection_nebula | approved | dust coverage 28%, FWHM ~13 px, stars "outstanding" |
| ngc7023_best_of_both | `~/.pixinsight-mcp/runs/run_2026-06-23_efe2138e/giga_orchestrator/variant_08/image.xisf` → copy to `~/.pixinsight-mcp/approved/reflection_nebula/NGC7023_efe2138e_v08.xisf` | reflection_nebula | accepted milestone | has a faint green band at left (user saw it) — must still PASS blocking gates |
| ngc7023_giga_rejected | `/Volumes/Extension/NGC 7023/masters/agentic/NGC7023_giga.xisf` | reflection_nebula | rejected (burnt core + empty field) | negative control |
| ngc3628_candidate | `/Volumes/Extension/NGC3628/agentic/output/NGC3628_giga_v3.xisf` vs `NGC3628_giga_keep.xisf` | galaxy_edge_on | **USER MUST CONFIRM which is the approved variant_16 (P90 ≈0.37)** | until confirmed, galaxy thresholds stay PROVISIONAL |
| ngc4490_giga_rejected | `/Users/aescaffre/agentic ngc4490/agentic/NGC4490_giga.xisf` | galaxy_spiral | rejected (white-blob core) | negative control |
| planetary_nebula | — | — | **no approved image on disk** | PNe gates remain as-is; mark `_calibration: "uncalibrated — no reference"` |

Rules: run `node scripts/backtest-gates.mjs` before merging any threshold change; exit 1 if an approved image hits a blocking failure. Add `--approve <runId>` to giga-run export that copies the XISF to `~/.pixinsight-mcp/approved/<class>/` and appends to the registry so the registry stops rotting with run pruning.

## 4. Model assignment

Facts: no `--model` is passed today; all three MaxAgents inherit `~/.claude/settings.json` → `"model": "fable"` (effort high). Only the critic pins `opus`. No run records the model used, so no A/B exists. LLM gaps are ~77% of wall time (57 min run: 13 min tools, 44 min LLM).

| Agent | Decision | Effort | fallback | maxTurns | Rationale |
|---|---|---|---|---|---|
| giga_orchestrator | `inherit` (explicit; = fable today) | high | sonnet | 250 | 250-turn long-horizon creative reasoning; all validated lessons were produced on this model. Switching to opus is itself an unvalidated change — do it only via a recorded A/B on NGC7023 (ledger judge). |
| gradient_agent | `inherit` default; **first A/B candidate: sonnet, effort medium** | medium | sonnet | 50 | Short measure→adjust loop; objective metrics (measure_color_gradient, subject_detail) + the gradient snapshot cache make an A/B cheap on the same input. Not switched by default: IFN preservation is a user-weighted dimension. |
| core_specialist | `inherit` default; A/B candidate: sonnet, effort high | high | sonnet | 50 | `composer.judgeAB` is deterministic, so an A/B is objective. Flagged post-pass only. |
| aesthetic_critic | `opus` (pinned) | **default (do not lower)** | — | 3 | Flaw-finder must stay demanding (feedback_visual_judgment); `--max-turns 3` is enough for Read + answer. |
| composer / judgeAB | deterministic | — | — | — | No LLM. |
| haiku | never | | | | Weak at long-horizon tool use; money is not the constraint on Max. |

Uncertainty: there is no evidence that fable vs opus vs sonnet changes output quality on this task; the only evidence is latency. The plan therefore makes model choice explicit, recorded and flag-switchable (`--model-<agent>`, `--effort-<agent>`, `config.models`) and leaves defaults at the baseline.

## 5. Test infrastructure

Add `"test": "node --test test/"` to `package.json`. Tests are plain `node:test`; PI-backed tests live in `scripts/` and are run manually (marked `[PI REQUIRED]`). Every item below lists its acceptance test.

## 6. Items (full specs follow in the structured list)

See `items[]` — one spec per WI with files, functions, signatures, prompt text, thresholds, calibration steps, acceptance test and dependencies.

## 7. What is deliberately NOT in this plan

- metrics-07 (bright-block fraction counts stars) — refuted; only its docstring/prompt text inconsistency is fixed in WI-09/WI-10.
- Per-agent subprocess timeouts shorter than 2 h (gradient 30 min / core 45 min) — untested thresholds on 60 MP data; rejected per calibrate-against-known-good.
- Global replacement of luminance formulas inside already-calibrated gates — only new code uses the shared `PJSR_LUM` helper.
- Hard-blocking any new metric (banding, chroma noise, detail gain, star field) before the harness measures the approved images.


## 8. Work item specifications

### WI-01 (P0) Gate back-test harness, approved-image registry, runFinishGates extraction, gate-contract constants, run_quality_gates tool

**Files:** agents/llm/tools.mjs, agents/llm/gate-contract.mjs, agents/calibration/approved-images.json, scripts/backtest-gates.mjs, agents/classifier.mjs, agents/ops/subject-metrics.mjs, agents/artifact-store.mjs, package.json, test/gate-contract.test.mjs

**Depends on:** none

**Spec:**

1) agents/llm/gate-contract.mjs (new): export the constants the finish handler and metric functions currently inline: BURN_CLIP=0.95, BRIGHT_BLOCK_LEVEL=0.80, NOISE_BG_HARD=0.022, NOISE_DUST_HARD=0.040, SUBJECT_MIN=0.25, CONTRAST_GATE=3.0, CONTRAST_GATE_OUTER_HALO=2.0, DETAIL_MIN=0.001, SAT_HARD_MARGIN=0.10, TONAL=3.0, TONAL_SMALL=2.5 (coverage<3%), STAR_CONTRAST={prominent:4.0,balanced:3.0,subdued:2.0}, FWHM_HARD=12 (galaxy exempt), STAR_COUNT_WARN=20, RINGING_WARN=3, REF_COLOR_EMD=0.25, REF_COVERAGE_DELTA=0.30. Export gateThreshold(profile,key,codeDefault) that reads optional per-class overrides from processing-profiles.json (keys: stars.fwhm_hard, stars.min_contrast, tonal.min_separation, detail.min_detail, core_burn.rel_contrast_hard/white_hard, noise.bg_hard/dust_hard, texture.min_retention, aesthetic_gate.min_score, reference.max_color_emd/max_coverage_delta) and requires a `_calibration` string only when an override is present. Export buildGateTable(brief) returning rows {gate, tool, threshold, predicateText, status:'BLOCKING'|'WARNING'|'SKIPPED', relaxation} resolved from the brief's profile/classification/faintStructureGoal/starless (used by WI-09 to render one table in the prompt). Make tools.mjs finish, subject-metrics.mjs measureSubjectDetail/measureBackgroundNoise and quality-gates.mjs scanBurntRegions import these constants (behaviour unchanged; also fixes the stale 3.0-vs-2.0 outer_halo advisory divergence at subject-metrics.mjs:147 by passing profile/faintStructureGoal through).

2) tools.mjs: extract lines ~2373-2842 of the finish handler into `export async function evaluateFinishGates(ctx, store, brief, viewId, agentName, opts={})` with opts {mode:'run'|'backtest', aesthetic:true, reference:true, variantId}. Returns {failures, warnings, metrics:{stars,core,detail,saturation,dust,noise,tonal,texture,palette}, stats, failedGates:[]} (failedGates structure is filled by WI-06; create the array now). In mode 'backtest': skip the L-usage trace gate (Gate 10), skip the highlight-texture variant-reference lookup, make the aesthetic critic opt-in (opts.aesthetic=false default), and keep isEmergency driven by brief._budget exactly as today. finish calls it with mode 'run' and keeps variant validation, writeFinalSelection and recordChampions unchanged.

3) New tool `run_quality_gates` {view_id, include_aesthetic=false, include_reference=true, variant_id?} in category 'quality_gate', NOT added to any STATE_TOOLS set (so public in every state) and NOT added to the repair-trigger list. Returns '[GATE BATTERY: PASS|FAIL] n failures / m warnings' + identical failure/warning texts + one metric line per dimension. When variant_id is given, persist the result into that variant's metadata via store.saveVariantMetrics(agent, variantId, metrics) (new helper in artifact-store.mjs; list_variants shows gate status). Gate 9's temporary reference window must still be force-closed.

4) agents/classifier.mjs: `export function profileFor(classification, isNarrowband, workflow)` wrapping buildProfile (keep generateBrief unchanged).

5) agents/calibration/approved-images.json: entries {id, path, classification, narrowband, starless, verdict:'approved'|'rejected'|'superseded', source, notes} seeded with exactly the 7 rows from plan §3 (paths verified on disk 2026-10-28; `/Volumes/Extension/NGC 7023/...` contains a space). Mark planetary_nebula 'no approved reference'. First copy run_2026-06-23_efe2138e/giga_orchestrator/variant_08/image.xisf to ~/.pixinsight-mcp/approved/reflection_nebula/NGC7023_efe2138e_v08.xisf.

6) scripts/backtest-gates.mjs [--class X] [--critic] [--only gate,gate] [--dry]: for each registry entry sequentially: createBridgeContext → open XISF (close crop_mask/aux windows immediately, as loadFromCache does) → brief = {target:{classification,...}, dataDescription:{starless,narrowband}, processingProfile: profileFor(...)} → evaluateFinishGates(mode 'backtest') → record per-gate pass/fail + raw metric values → forceClose before the next (16 GB). Print gate×image matrix + raw numbers; list thresholds with zero approved-image coverage; write agents/calibration/last-backtest.json. Exit 1 if any 'approved' image hits a blocking failure; exit 2 if a 'rejected' image passes every blocking gate (warning-level).

7) giga-run.mjs: add `--approve` flag on export that copies the final XISF to ~/.pixinsight-mcp/approved/<class>/<target>_<runId>.xisf and appends an 'approved' registry entry; ledger recordChampions should point xisfPath at that durable copy when present.

8) package.json: add "test": "node --test test/". test/gate-contract.test.mjs: for every profile in processing-profiles.json buildGateTable() resolves without throwing and each BLOCKING row's threshold equals gateThreshold(); assert evaluateFinishGates is exported and the finish handler's source no longer contains the literal 0.95/0.80/0.022 numbers (grep).

**Acceptance:**

node --check on all touched files; npm test passes (gate-contract test); `node scripts/backtest-gates.mjs --dry` lists 7 registry entries and resolves profiles. [PI REQUIRED] `node scripts/backtest-gates.mjs` runs on pacman_lift5 + ngc7023_iter03 + ngc7023_best_of_both with exit code 1 (expected: it will EXPOSE current miscalibrations — record them in last-backtest.json; this is the baseline for WI-02/03/04/17). Diff of finish output on a saved variant before/after extraction is byte-identical except the new GATES trailer.

### WI-08 (P1) Explicit per-agent model/effort/fallback/max-turns + model recording in trace, manifest and ledger

**Files:** agents/llm/engine-max.mjs, agents/llm/giga-run.mjs, agents/llm/aesthetic-critic.mjs, agents/llm/tools.mjs, agents/llm/mcp-agent-tools.mjs, agents/llm/trace-analyzer.mjs, .claude/skills/pixinsight-pipeline/SKILL.md

**Depends on:** none

**Spec:**

1) engine-max.mjs constructor: accept opts.model ('inherit' or alias), opts.effort ('low'|'medium'|'high'|'xhigh'|'max'), opts.fallbackModel, opts.timeoutMs (default 120*60*1000). run(): push '--model' only when model && model!=='inherit'; push '--effort' when set; push '--fallback-model' when set; push '--max-turns', String(Math.ceil(this.maxTurns*1.5)) (outer safety net only — CLI turns count text/Read/blocked turns; the MCP-side gate in WI-07a is the normal stop). Warn on unknown opts keys (currently `tools`/`ctx` are silently ignored). After JSON parse, read result.modelUsage; resolve {..., model: this.model||'inherit', effort, actualModels: Object.keys(result.modelUsage||{}), modelUsage, num_turns, duration_ms, subtype: result.subtype, is_error: result.is_error}. _writeMcpConfig: push String(this.maxTurns) as argv[5] and this.model||'' as argv[6] so mcp-agent-tools.mjs can read them (WI-07a uses argv[5]).

2) giga-run.mjs: single AGENT_MODELS map {giga_orchestrator:{model:'inherit',effort:'high',fallbackModel:'sonnet',maxTurns:250}, gradient_agent:{model:'inherit',effort:'medium',fallbackModel:'sonnet',maxTurns:50}, core_specialist:{model:'inherit',effort:'high',fallbackModel:'sonnet',maxTurns:50}, aesthetic_critic:{model:'opus',effort:undefined,maxTurns:3}}; resolution order CLI --model-<agent>/--effort-<agent> > config.models.<agent> > defaults; thread aesthetic_critic into brief.models.critic. Pass model/effort/fallbackModel into the three MaxAgent constructors (currently at ~252, ~372, ~478) and remove the dead `tools:`/`ctx:` options and the local buildToolSet/creativeCategories block (~286-293; WI-10 owns the category map). Record {agent, requestedModel, effort, fallbackModel, actualModels, num_turns, duration_ms, usage} into manifest.agents[name] via a new store.recordAgentRun(name, info), into a `run_meta` first line of trace.jsonl, and into the ledger champion record (scoreVersion bump happens in WI-19). Log a WARNING when actualModels does not include the requested alias family (fallback fired).

3) tools.mjs:295 and :2792: replace model:'opus' with brief?.models?.critic || 'opus'. aesthetic-critic.mjs runJudge: accept opts {model, maxTurns=3} and push '--max-turns' (spawn hygiene itself is WI-02).

4) Docs: list the new flags in SKILL.md and append to memory feedback_claude_binary.md working-args list (--model, --effort, --fallback-model, --max-turns are accepted by claude 2.1.312; --max-turns is hidden from --help but parsed).

**Acceptance:**

node --check; `node agents/llm/giga-run.mjs --config M97_LRGB_agentic.json --dry-run --model-gradient sonnet` prints the resolved AGENT_MODELS table with gradient_agent=sonnet and the others 'inherit'; unit test asserts resolution order (CLI > config.models > default) and that engine-max builds args containing '--effort high' and '--max-turns 375' for giga and omits '--model' for 'inherit'. After one real run, manifest.json.agents.giga_orchestrator.actualModels is non-empty and trace.jsonl line 1 is run_meta.

### WI-14 (P1) PJSR error propagation: pjsrOrThrow + executeOn checks in all 31 bare handlers, PixelMath pre-validation, lrgb_combine cleanup on throw

**Files:** agents/llm/tools.mjs, agents/ops/bridge.mjs

**Depends on:** none

**Spec:**

1) tools.mjs: add `async function pjsrOrThrow(ctx, code, label)` that calls ctx.pjsr and throws `new Error(`${label}: ${r.error?.message||r.error||'PJSR error'}`)` when r.status==='error'. Replace the 31 bare `await ctx.pjsr(` calls listed in the finding (save_and_show_preview:234, run_nxt:496, run_bxt:527, run_background_neutralization:897, run_hdrmt:958, run_curves:1101, run_pixelmath:1129, star_protected_blend:1259/1292, blend_regions:1363/1374, restore_star_color:1473, load_prior_winner:1591/1594, recall_champion:1623/1628, lrgb_combine:1683/1714/1724/1751/1765, ha_inject_red:1811, ha_inject_luminance:1859, open_image:2959, rename_view:2982, align_to_reference:3098-3120, combine_channels:3176/3184). Do NOT change bridge.pjsr semantics (ops modules rely on non-throwing).

2) REQUIRED (verified: PixelMath parse failures return executeOn()===false with status 'ok'): prepend a shared PJSR prelude string `function execOrThrow(P,v,label){if(!P.executeOn(v))throw new Error(label+': executeOn returned false — parameters/expression rejected by PixInsight');}` and use it in every process-running handler (run_pixelmath, run_curves, run_nxt, run_bxt, run_hdrmt, run_background_neutralization, star_protected_blend, blend_regions, restore_star_color, ha_inject_red, ha_inject_luminance, lrgb_combine steps 1-3, inject_luminance). For PixelMath append the hint 'check for pow() (use exp(e*ln(b))), undeclared symbols (multi-statement expressions need `symbols`), and $T.R-style channel syntax (use $T[0])'. Keep lrgb_combine step 4's intentional PixelMath fallback.

3) run_pixelmath pre-validation: refuse `pow(`; refuse ';' in expression when symbols is empty (verified: returns false without symbols, true with).

4) lrgb_combine: wrap steps 1-3 in try/finally closing lrgb_lum_ref and ${tgt}_R/G/B/L (needed now that failures throw).

5) The MCP layer already turns thrown errors into 'Error: …' results (mcp-agent-tools.mjs:343-351); after WI-06 the trace entry also records error.

**Acceptance:**

node --check; grep count of bare `await ctx.pjsr(` in tools.mjs handlers == 0 (allow only pjsrOrThrow and the ops modules). [PI REQUIRED] On a throwaway 32×32 window: run_pixelmath 'pow($T,2)' → tool returns 'Error:' (pre-validation); 'foo*$T' → 'Error: … executeOn returned false'; 'L=0.5*$T; L*2' without symbols → REFUSED, with symbols='L' → 'PixelMath applied'; run_curves with point [2,5] → 'Error: … numeric value out of range'; after a failed lrgb_combine step 2 no ${tgt}_R/G/B/L or lrgb_lum_ref windows remain.

### WI-24 (P1) Disk hygiene in giga-run: old-run cleanup with champion/base-run protection, orphan-swap cleanup by PI process start time, cache count caps, coherent disk thresholds

**Files:** agents/llm/giga-run.mjs, agents/llm/mcp-agent-tools.mjs, scripts/clean-swap.mjs, agents/ledger.mjs, .claude/skills/pixinsight-pipeline/reference/pjsr-gotchas.md

**Depends on:** none

**Spec:**

1) giga-run.mjs right after `const store = new ArtifactStore()` (~:197): `cleanOldRuns({keep: opts.keepRuns ?? 3, protect})` where protect = {store.runId, opts.baseRun, every run dir referenced by any xisfPath under ledger.json classes.*.champions.*, every path in agents/calibration/approved-images.json}; sort run_* dirs by name, delete beyond keep unless protected, log each deletion with size. Add --keep-runs N. Prep-cache and gradient-cache: keep the N newest keys (default 4) by meta.json mtime (do NOT age-prune by 14 days — the user reprocesses targets months apart).

2) `cleanOrphanSwap()` run once at startup before checkDiskSpace: PI start time via `ps -o lstart= -p $(pgrep -x PixInsight)` (PI not running → every ~PI~* entry is an orphan); delete every `~PI~*` file/dir in the swap dir whose birthtimeMs (fallback mtimeMs) is EARLIER than that start time; never touch anything newer. VERIFIED on 2026-10-28: on PI 1.9.5 each swap file has its own random 16-char prefix (68 files / 68 prefixes), so the memory note's 'session prefix' rule is WRONG and would delete the live session's other windows — do not implement it. Derive the swap dir from os.tmpdir()'s parent `/C` sibling and verify it exists. Delete the three unsafe mtime-based implementations: giga-run.mjs:44-81 cleanPISwapFiles, mcp-agent-tools.mjs:110-128 periodicSwapCleanup, and rewrite scripts/clean-swap.mjs to the birthtime<PI-start rule with --dry-run. Log count + GB freed (today: 68 files / 24.4 GB reclaimable with zero risk).

3) checkDiskSpace runs AFTER 1-2; warn <20 GB, abort <10 GB (coherent with SWAP_LOW_GB=14); do not abort at 20 GB (prep-B XTerminator OOMs are RAM spikes documented with 79 GB free).

4) ledger.mjs getChampions: skip entries whose xisfPath no longer exists (log once) — 2 of 3 current champions already dangle.

5) Update memory feedback_swap_cleanup_close_first.md and pjsr-gotchas.md: correct the 'session prefix' statement; the safe orphan test is creation time < live PI process start.

**Acceptance:**

node --check; unit test with a fake runs dir (6 run_* dirs, one referenced by a fake ledger champion, one by --base-run) → exactly 2 deleted; cleanOrphanSwap unit test with a fake swap dir and injected PI start time deletes only older entries. [PI REQUIRED] With PI running, `node scripts/clean-swap.mjs --dry-run` lists only files older than the PI process start; PI keeps working after the real run.

### WI-07a (P1) Engine hygiene: MCP-side turn-budget enforcement, timeout/max-turns classification, stdin closed, prompt file, best-variant fallback for export + post-pass

**Files:** agents/llm/engine-max.mjs, agents/llm/mcp-agent-tools.mjs, agents/llm/state-machine.mjs, agents/llm/giga-run.mjs, agents/llm/aesthetic-critic.mjs, agents/artifact-store.mjs

**Depends on:** WI-08

**Spec:**

1) mcp-agent-tools.mjs: `const maxTurns = parseInt(process.argv[5],10) || 250;` giga → createStateMachine(maxTurns); replace the non-giga stub with a real counter object {state:'free', turnsUsed, maxTurns, recordToolCall(){turnsUsed++}, recordBlockedCall(){turnsUsed++}, getBudgetStatus() returning real turnsRemaining/maxTurns/status ('ok'>30, 'converge'<=30, 'critical'<=15), checkToolAccess:()=>({allowed:true}), enterRepair/transitionTo no-ops}. Before dispatch (after the state check): `const EXHAUST_WHITELIST = {giga_orchestrator:['finish','save_variant','list_variants','load_variant','get_image_stats','save_memory','close_image','run_quality_gates'], core_specialist:['restore_from_clone','close_image','get_image_stats','save_memory','save_variant'], gradient_agent:['measure_color_gradient','measure_subject_detail','save_memory']}`; if budget.turnsRemaining<=0 and tool not whitelisted → write trace entry error 'BLOCKED (budget exhausted)' and return 'BUDGET EXHAUSTED: only {list} are allowed. ' + per-agent instruction (giga: 'finish is in EMERGENCY mode — call finish with your best saved variant now'; core: 'restore_from_clone your best clone into CORE_WORK and stop'; gradient: 'stop now'). Blocked calls (state policy or budget) must call stateMachine.recordBlockedCall() (new method in state-machine.mjs: increments turnsUsed/stateTurns and applies ONLY the turnsRemaining<=15 force-finalize and the per-state budget caps, never the tool-name sentinels) so a block loop is bounded.

2) engine-max.mjs: spawn with stdio:['ignore','pipe','pipe'] (removes the 3 s 'no stdin data' stall; verified Read/-p still work); write the system prompt to `${store.baseDir}/prompts/system-${agentName}-${ts}.md` and pass '--append-system-prompt-file <path>' (fallback to argv if a `claude --help` probe lacks the flag — cache the probe once per process). close handler signature (code, signal): timedOut = signal==='SIGTERM' && elapsed >= timeoutMs-5000; maxTurnsHit = result?.subtype==='error_max_turns'; log '!!! AGENT TIMED OUT after Ns' / '!!! AGENT HIT CLI MAX-TURNS'; resolve {..., timedOut, maxTurnsHit, exitCode: code, signal}; do NOT set crashError for these (crashError is reserved for the WI-07b sentinel). Keep the legacy stderr-string crash heuristic until WI-07b replaces it.

3) aesthetic-critic.mjs runJudge: same stdio:['ignore','pipe','pipe'].

4) giga-run.mjs: after agent.run, if result.timedOut||result.maxTurnsHit print a loud banner and tag exportSource += ' (AGENT TIMED OUT|MAX TURNS)'. Implement getBestVariant(store, agent='giga_orchestrator'): prefer the variant with persisted run_quality_gates PASS metrics (WI-01), else highest ledger scoreVariantDimensions sum, else the latest save; when final-selection.json is missing AND trace recovery finds no PASSED finish (existing :412-454 path), call store.writeFinalSelection({variant_id, variant_path, agent, notes:'RECOVERED best-effort (no passing finish)', recovered:true, gates_passed:false}) so export AND the --core-specialist post-pass run. Write status ('finished'|'recovered'|'timed_out'|'max_turns'|'crashed') into run-summary.json (WI-25 extends it) and print it in the wrap-up.

5) giga-run.mjs: after the first enforced gradient/core runs, if they are routinely cut at 50, raise AGENT_MODELS.*.maxTurns to 70 (do not widen the CLI margin).

**Acceptance:**

node --check; unit test: StateMachine(250) after 250 recordToolCall/recordBlockedCall mixed → getBudgetStatus().turnsRemaining===0 and a non-whitelisted tool returns BUDGET EXHAUSTED text (simulate via the handler's exported gate function); engine-max unit: a stub `claude` script that sleeps past timeoutMs=2000 yields timedOut:true, and one that prints {subtype:'error_max_turns'} yields maxTurnsHit:true. Empirical: spawn `claude -p hi --output-format json` with stdio ignore → no 'no stdin data' warning in stderr. giga-run on a run dir with variants but no final-selection.json and no PASSED finish in trace produces final-selection.json with recovered:true and exports.

### WI-02 (P0) Aesthetic critic: context-aware rubric, Gate 11 advisory until calibrated, starless/narrowband never block, spawn hygiene, calibration log + rating CLI

**Files:** agents/llm/aesthetic-critic.mjs, agents/llm/tools.mjs, agents/processing-profiles.json, agents/llm/rate-critique.mjs, agents/llm/vision.mjs

**Depends on:** WI-01

**Spec:**

1) aesthetic-critic.mjs: replace the RUBRIC_SYSTEM_PROMPT constant with `buildCritiqueRubric(context)` where context = {classification, workflow, narrowband, palette, starless, colorSaturation, starProminence, referenceNotes} taken from brief.target.classification, brief.dataDescription.{workflow,narrowband,palette,starless}, brief.aestheticIntent.{colorSaturation,starProminence,referenceNotes}, brief.processingProfile.palette?.goal. Keep the JSON contract, the eight axes and the 'most images score 5-7' calibration line, and APPEND a '### Target context' section: starless → 'This is a STARLESS deliverable by design (stars are added later from RGB). Do NOT score axis 4 STARS and do not list missing stars or star-removal residue as a flaw unless it is a visible blotch.'; galaxy_* → 'The owner prefers photographic restraint for broadband galaxies: muted saturation is CORRECT; over-saturation, crunchy over-sharpening and a white featureless core are the flaws.'; narrowband → `False-colour ${palette} palette: judge palette balance (residual Ha-green, S+O magenta, blown Ha cores, chroma mottle), NOT natural colour; a strong warm/gold outer halo is the intended look, not fog; a rich saturated palette is correct.`; reflection/dark → 'Brown dust must be present across the field and not greyed/crushed; a blown blue core is the flaw.'; referenceNotes non-empty → append as 'Owner intent: ...'. Export RUBRIC_VERSION=2. runJudge(jpegPaths[], rubricText, {model, maxTurns=3, log}): args = ['-p',prompt,'--output-format','json','--append-system-prompt',rubricText,'--tools','Read','--allowedTools','Read','--permission-mode','bypassPermissions','--strict-mcp-config','--max-turns',String(maxTurns),'--model',model]; spawn with stdio:['ignore','pipe','pipe']; do NOT pass --effort (keep the demanding default); do NOT use --bare. The prompt lists all jpegPaths (overview + a subject-centred 800 px 1:1 crop produced by vision.mjs generateDiagnosticViews-style crop, so stars/grain are visible). critiqueAesthetic(ctx, viewId, opts{..., brief}) builds the context from opts.brief; cache key = sha256(jpegBytes of all files + rubricText + model) → `${hash}-v${RUBRIC_VERSION}.json`. Treat error_max_turns / no parseable verdict as the existing advisory path. Append every verdict (cached or not — do it at the call site, not inside the cache branch) to `<baseDir>/critiques/calibration.jsonl` {ts, runId, label, hash, model, score, flaws, classification, starless, narrowband}.

2) tools.mjs Gate 11 (~2786-2803): `const ag = brief?.processingProfile?.aesthetic_gate; const blocking = ag?.blocking===true && Number.isFinite(ag?.min_score) && !isStarless && !brief?.dataDescription?.narrowband;` push to failures only when blocking && score<min_score && !isEmergency; otherwise push the full message (score, flaws, min if any) to warnings. Pass {brief, model: brief?.models?.critic||'opus'} from both call sites (tools.mjs:295 rename `_brief`→`brief`; :2792). Remove the `?? 6.0` default.

3) processing-profiles.json: do not add aesthetic_gate to any profile yet. Document in a top-level `_aesthetic_gate_policy` string: 'Set aesthetic_gate:{blocking:true,min_score:X,_calibration:...} only when ≥8 user-rated pairs for that class show the judge ranks in agreement with the user.'

4) agents/llm/rate-critique.mjs CLI: `--run <runId> --label <finish_variant_xx> --rate <1-10> [--note]` appends {user_rating} keyed by hash to the same calibration.jsonl; `--report` prints per-class Spearman rho and n.

5) Move agents/llm/prompts/aesthetic-critic.mjs with the legacy orchestrator in WI-25 (only the 0-10 rubric remains live).

**Acceptance:**

node --check; unit test renders buildCritiqueRubric for {starless:true,narrowband:true,palette:'SHO'} and asserts it contains 'Do NOT score axis 4' and 'False-colour SHO'; for galaxy_spiral asserts 'muted saturation is CORRECT'; cache-key test: same JPEG + different rubric → different filename. [PI REQUIRED] Back-test: critiqueAesthetic on pacman_lift5 (rendered 1500 px overview + 1:1 crop) with the narrowband/starless context ≥3 runs — record scores in calibration.jsonl; the finish gate on pacman_lift5 and ngc7023_iter03 must report Gate 11 as a WARNING, never a failure (scripts/backtest-gates.mjs --critic exit 0 for Gate 11).

### WI-03 (P0) Galaxy natural look: per-class `look` block, intent-driven Branch C text, Gate 7 per-class warn/fail, ledger color_richness, memory re-levelling of M81 universal recipes

**Files:** agents/processing-profiles.json, agents/classifier.mjs, agents/llm/prompts/giga-orchestrator.mjs, agents/llm/tools.mjs, agents/ledger.mjs, scripts/relevel-legacy-universal.mjs, test/prompt-render.test.mjs

**Depends on:** WI-01

**Spec:**

1) processing-profiles.json: add `look` per class. Provisional values (harness decides final; mark each `_calibration:'PROVISIONAL — back-test pending'`): galaxy_spiral {s_curve_midpoint:0.58, target_p90:0.40, max_p90:0.50, saturation_stages:1, detail_gain_target:0.28, detail_gain_max:0.60}; galaxy_elliptical same with target 0.35/max 0.45; galaxy_edge_on {0.58, 0.45, 0.60, 1, 0.28, 0.80} (NGC891 approved at +71-77% detail, P90 0.217); galaxy_cluster {0.70, 0.55, 0.65, 1, ...} (user-validated bold midpoint 0.88 — keep vivid-ish); emission_nebula/planetary_nebula/supernova_remnant/narrowband_palette {s_curve_midpoint:0.72, target_p90:0.75, max_p90:0.85, saturation_stages:2}; reflection_nebula keep current max_p90. Delete dead keys rgb_initial/composition_target/blue_boost/pink_boost (unreferenced in agents/). galaxy_spiral tools.LRGB.saturation 0.80→0.50 and lightness 0.55→0.50 (code caps at 0.50 anyway); rewrite galaxy_spiral `notes` ('Push saturation — warm, vivid') to 'Muted, photographic: single S-curve midpoint ~0.58, P90 ≈ target_p90, neutral background; cooked/synthetic is the failure mode.' Keep max_p90 for classes without look as-is.

2) classifier.mjs:238: `colorSaturation: opts.colorSaturation || config.aesthetic?.colorSaturation || (isGalaxy && classification!=='galaxy_cluster' ? 'moderate' : 'vivid')`; document 'muted'|'moderate'|'vivid' in SKILL.md.

3) giga-orchestrator.mjs: `const look = brief.processingProfile?.look || {}; const satIntent = brief.aestheticIntent?.colorSaturation || 'vivid';` echo both in the brief header next to Style (line ~50). Branch C (:499-546): under satIntent==='vivid' keep text byte-identical; under 'moderate'/'muted' replace the non-PNe block (:524-527) with: '## BRANCH C — COLOR, NATURAL BROADBAND. Goal: believable, photographic colour; neutral background (measure_color_gradient per-channel medians equal). Cooked/synthetic is the failure mode for this intent. SINGLE global S-curve bracket — midpoint ${(m-0.08).toFixed(2)} (restrained) / ${m} (target) / ${(m+0.10).toFixed(2)} (edge) / ${(m+0.20).toFixed(2)} (overdone), where m=look.s_curve_midpoint; no second masked stage by default (allowed only as the edge candidate). Run check_saturation after each candidate AND after L-injection/LRGB (P90 rises ~0.22→0.37-0.47 downstream — judge P90 at composition). Profile targets: P90 target ${look.target_p90}, warn above it, finish FAILS above ${look.max_p90}. Reference anchors (data, not rules): NGC3628 approved P90≈0.37 (muted); M81 approved midpoint 0.70 (moderate). Stop at the restrained/target candidate unless check_saturation and the critic both say it is washed out.' Make the hue-selective bullet (:528-532) conditional: PNe/zoned → existing OIII text; broadband galaxies → 'Blue arms / yellow-brown cores may be boosted; RESTRAIN red/pink HII and Ha; dust lanes stay dark/muted; use the CIE a* reduction when HII looks overdone.' Make :69 Timidity, :100, :795-801 intent-aware: under 'moderate'/'muted' append 'for broadband galaxies the opposite failure (cooked, over-saturated, over-sharpened) is equally disqualifying — a restrained candidate that passes the critic is a legitimate winner.' Soften :126-127 to 'find the synthetic boundary with the bracket; the restrained candidate may be the winner for a natural intent' (do NOT change Branch A amounts/caps).

4) tools.mjs Gate 7 (~2645-2660): `const look=brief?.processingProfile?.look; const maxP90 = look?.max_p90 ?? (profile.saturation?.max_p90 ?? 0.65); const warnAt = look?.target_p90 ?? maxP90; const failAt = look ? maxP90 : maxP90+0.10;` warn when p90S>warnAt, fail when p90S>failAt (keeps +0.10 slack for classes without look). check_saturation tool text reports the same two numbers.

5) ledger.mjs scoreVariantDimensions: thread targetP90; for classification startsWith('galaxy') color_richness = max(0, 1-|p90S-targetP90|/targetP90), else keep the current cap formula; pass targetP90 from both call sites (tools.mjs ~1417 compare_to_champions and ~2882 finish). scoreVersion handling is in WI-19.

6) scripts/relevel-legacy-universal.mjs (one-off, prints diff, backs up hierarchical.json): move universal entries with migrated:true whose title/tags name a target (M81, M97, NGC\d+, Abell, Bubble, PACMAN) — e.g. 'M81 composition winning parameters' (LRGB sat 0.80) — to target[<name>]; annotate type/galaxy entries recommending sat midpoint 0.70 with 'superseded for galaxy_spiral by the natural-look rule (NGC3628, 2026-06-07)'; add one type-level galaxy_spiral entry summarising the NGC3628 rejection and approved numbers.

7) Calibration [PI REQUIRED]: harness runs checkSaturation on the user-confirmed NGC3628 approved XISF (must PASS target/max), NGC3628 rejected default (must WARN or FAIL), ngc4490_giga_rejected (should at least WARN), and — if the user re-exports them — NGC891 c33f2a98 and M81 v11 winners. Adjust look values so all approved images pass; record in `_calibration`. Render NGC891_LRGB_agentic.json and PACMAN_SHO_agentic.json before/after: emission/SHO render must be byte-identical.

**Acceptance:**

npm test: test/prompt-render.test.mjs renders buildGigaOrchestratorPrompt for fixture briefs (galaxy_spiral moderate, galaxy_cluster vivid, emission vivid, planetary) and asserts the galaxy render contains 'NATURAL BROADBAND' and no '0.65 → 0.75 → 0.85', while the emission render equals a stored golden snapshot; Gate 7 unit test with a stubbed checkSaturation: p90 0.45 on galaxy_spiral → warning, 0.55 → failure, 0.80 on emission → pass. [PI REQUIRED] scripts/backtest-gates.mjs --class galaxy_edge_on exit 0 on the confirmed approved NGC3628 image.

### WI-04 (P1) Star contract: one prominence source, profile-driven blend caps and star_protected_blend defaults, fix '(stretched)' label and stale stretch_stars refusal text

**Files:** agents/classifier.mjs, agents/processing-profiles.json, agents/llm/tools.mjs, agents/llm/prompts/giga-orchestrator.mjs, agents/llm/giga-run.mjs, agents/llm/deterministic-prep.mjs, agents/llm/narrowband-prep.mjs, agents/ops/quality-gates.mjs, test/prompt-render.test.mjs

**Depends on:** WI-01

**Spec:**

1) giga-run.mjs:326: replace '(stretched)' with `(LINEAR, median=${(prepResult.stats.stars?.median ?? 0).toExponential(2)} — call stretch_stars, then check_star_layer_integrity, BEFORE any curves/rolloff/blend; stretch_stars refuses non-linear input so it is always safe to call first)`. deterministic-prep.mjs after Step 7 (~:982): `result.stats.stars = await getStats(ctx, result.views.stars);` warn on stderr if median>=0.001. narrowband-prep.mjs:192: same for stars_H when kept open. Fix the viewsList formatter (giga-run.mjs:300) to toExponential for medians <1e-3. tools.mjs:685: delete the stale 'The star layer from prep is already stretched — skip this tool' refusal text.

2) Single source of truth: import STAR_CONTRAST from gate-contract.mjs (WI-01) in the finish gate and in quality-gates.mjs:176 (replace the fixed 3.0). classifier.mjs:241: `starProminence: buildProfile(...).stars?.prominence || 'balanced'`; :248 default aestheticPreferences.starPresence from the same value (map 1:1), keep the opts.starPresence override; delete the false '>= 50 stars gate' sentence (finish only warns <20).

3) processing-profiles.json: galaxy_spiral stars → prominence 'balanced', screen_blend_strength 0.95 (was 0.85 — the cap was never user-requested; the user asked for MORE prominent galaxy stars twice), keep stretch_midtone 0.22 / stretch_iterations 5 / rolloff_knee 0.65, rewrite notes dropping 'Blend at 0.85 max'; galaxy_elliptical/galaxy_cluster → 'balanced'; galaxy_edge_on unchanged (0.95/prominent); add stretch_midtone/stretch_iterations to every galaxy_* profile (edge_on/elliptical/cluster currently fall to the hardcoded 0.25/4, contradicting the prompt's 0.22/5). Add star_protected_blend defaults using the EXISTING flat keys (same names as tool inputs): planetary_nebula core_threshold_low 0.75 / core_threshold_high 0.95 / min_strength_fraction 0.50 (M27 1a3cc341 winner, M97 e8834489); emission_nebula 0.55/0.75/0.10 (NGC7635 6d0b2048 + bc93d9d1; note f25fea4e used 0.60/0.85 as provisional range); reflection_nebula keep 0.55/0.70/0.0; others fall back to the global 0.60/0.82/0.10; each with `_calibration` citing the run id.

4) tools.mjs star_protected_blend (~1208-1210): `const starProf = brief?.processingProfile?.stars||{}; const low = input.core_threshold_low ?? starProf.core_threshold_low ?? 0.60; const high = input.core_threshold_high ?? starProf.core_threshold_high ?? 0.82; const minFrac = input.min_strength_fraction ?? starProf.min_strength_fraction ?? 0.10;` and append to the result text which source each value came from (agent / profile:<class> / default). Galaxy cap (~1201-1206): read profile.stars.screen_blend_strength as the cap for ANY class that defines it; when clamped, prepend 'PROFILE CAP (<class>): blend requested X → applied Y' to the result text and add profileCaps:[{param,requested,applied,key}] to the trace entry (mcp-agent-tools.mjs). Same visibility for stretch_stars (~597-609) and lrgb_combine lightness (~1673-1679; replace Math.min(x,0.50) with profile.tools.LRGB.max_lightness ?? 0.50). Update the three input_schema descriptions from '(default 0.60)' etc. to 'default: profile-driven per target class, else 0.60'.

5) giga-orchestrator.mjs: delete line 60's star sentence, the isGalaxy ternary (554-570) and line 581; replace with ONE 'STAR CONTRACT' block built from `const S = brief.processingProfile?.stars||{}`: prominence + finish threshold `${STAR_CONTRAST[S.prominence]}× star/bg contrast (BLOCKING)`; `stretch_stars midtone=${S.stretch_midtone ?? 0.25}, iterations=${S.stretch_iterations ?? 4} (tool-enforced minimum)`; `star_protected_blend defaults for this class: low/high/minFrac = ${low}/${high}/${minFrac}; blend strength default ${S.screen_blend_strength ?? 0.95} (tool-enforced cap only when the profile defines it; 0.90-1.00 otherwise)`; rolloff knee 0.65 with the soft formula; one S-curve (say 'apply twice' only for emission/planetary); 'do not lower core_threshold_low to brighten stars'. Add a non-bloat prominence lever: 'star-layer luminance curve ~[[0,0],[0.3,0.4],[0.7,0.85],[1,1]] BEFORE the soft rolloff, then re-run check_star_layer_integrity'. Skip the block when S.prominence==='none_if_starless' or dataDescription.starless.

6) Fix the three inconsistent FWHM limits shown to the agent (tools.mjs:3195 '< 6px', :3214 '(limit: 6.0)', quality-gates.mjs:170 8.0) by rendering FWHM_HARD/galaxy exemption from gate-contract (WI-16 later reworks the metric itself).

**Acceptance:**

npm test: prompt render for NGC891 (galaxy_edge_on), NGC7023 and M97 asserts exactly one 'Star prominence:' line, zero occurrences of both '0.85 max' and 'do NOT go below 0.90', and that the rendered midtone/cap equal the profile values; tools unit test: star_protected_blend default resolution for planetary_nebula returns 0.75/0.95/0.50 and the result text names 'profile:planetary_nebula'. [PI REQUIRED] run star_protected_blend on cached M27/M97 prep with no explicit thresholds → applied values equal the recorded winners; harness: ngc7023_iter03 and best-of-both still PASS the star-brightness gate (reflection = prominent, 4×).

### WI-05 (P1) State machine corrections: public measurement tools, dust/mask/detail tools in compose, finalize ⊇ compose, rejected finish stays in compose, begin_composition sentinel, blocked calls consume budget, warm-start starts in compose, advisory branch completeness

**Files:** agents/llm/state-machine.mjs, agents/llm/mcp-agent-tools.mjs, agents/llm/tools.mjs, agents/llm/giga-run.mjs, agents/llm/engine-max.mjs, test/state-machine.test.mjs

**Depends on:** WI-01

**Spec:**

1) state-machine.mjs STATE_TOOLS: (a) REMOVE from every set (→ public): measure_dust_coverage, check_noise, measure_color_gradient, get_image_dimensions, measure_uniformity, list_open_images, save_memory, recall_memory, run_quality_gates. (b) generate_candidates: ADD lift_dust, inject_l_ifn, lrgb_combine, inject_luminance (WI-13), mask_ops (WI-15). (c) compose: ADD lift_dust, inject_l_ifn, run_nxt, run_scnr, run_hdrmt, create_zone_masks, inject_luminance, mask_ops, stretch_stars, check_star_layer_integrity. (d) finalize = new Set([...compose, ...current finalize extras]) — finalize must never be more restrictive than compose. (e) Delete 'open_image' and 'combine_channels' from generate_candidates (they no longer exist for giga after WI-10); keep run_lhe/run_abe/run_per_channel_abe INTERNAL.

2) recordToolCall: compose block → `if (toolName==='finish' && /^Finished \(quality gates PASSED\)/.test(resultSummary||'')) transitionTo('finalize')`; a REJECTED finish (text starts 'FINISH REJECTED') leaves state unchanged. Add a public sentinel: generate_candidates → compose on toolName==='begin_composition' OR lrgb_combine/star_*_blend as today. Add `recordBlockedCall()` (WI-07a) and `toJSON()/restore(snapshot)` (used by WI-07b): snapshot = {state, turnsUsed, stateTurns, stateStartTurn, repairPolicyName, _branchCompletenessOverride, _repairReturnState}. enterRepair: accept state 'compose' OR 'finalize' and record `_repairReturnState`; exitRepair returns there. Enforce STATE_BUDGET_CAPS.finalize=20 only by guidance text (not blocking) — document that finalize is terminal.

3) tools.mjs: new public control tool `begin_composition` {note?} (category 'control', not in any STATE_TOOLS set): handler calls brief._stateMachine.transitionTo('compose') when state is generate_candidates (requires ≥2 saved variants else returns advisory 'save at least 2 candidates first'), returns the budget/state line. Needed for starless SHO runs where no star blend exists.

4) mcp-agent-tools.mjs: (a) blocked branch (~206-213) calls stateMachine.recordBlockedCall(). (b) justEnteredCompose also true for name==='begin_composition'. (c) Branch completeness: compute checkBranchCompleteness BEFORE invoking lrgb_combine/star_*_blend/begin_composition handlers and append '[BRANCH COVERAGE — advisory] ...' to the result; never transitionTo('generate_candidates') after the blend already executed and never say 'Compose rejected'; drop _branchCompletenessOverride. For narrowband briefs let palette/hue/sho/hoo/foraxx variant notes satisfy the colour-branch requirement (state-machine.mjs:459-465 regex). (d) Warm start: giga-run.mjs sets brief.warmStart={baseRun, intent} before new MaxAgent (engine-max serializes brief); mcp-agent-tools constructs the state machine and, when brief.warmStart is set, immediately transitionTo('compose') and skips branch completeness. (e) The STATE POLICY refusal text must name how to leave the state: 'generate_candidates → compose: call begin_composition (or lrgb_combine / star_protected_blend)'. (f) FINISH REJECTED text (tools.mjs ~2847): append 'You remain in compose: masks (create_luminance_mask/apply_mask/mask_ops), multi_scale_enhance, shell_detail_enhance, run_hdrmt, inject_l_ifn/lift_dust, restore_from_clone are available — fix upstream, do not clamp harder.' and replace the fixed footer with 'Verify with: ' + the union of per-gate verify tools (WI-06 provides failedGates; until then keep a generic list).

5) Hierarchical memory: after this lands, run a one-off that annotates universal entry 'State machine: lrgb_combine requires compose state — trigger via early star_protected_blend' as superseded (hack no longer needed).

**Acceptance:**

npm test test/state-machine.test.mjs: (1) for every tool in buildToolSet('giga_orchestrator') assert allowed in generate_candidates and compose for the list ['inject_l_ifn','lift_dust','measure_dust_coverage','check_noise','measure_color_gradient','get_image_dimensions','multi_scale_enhance','shell_detail_enhance','star_protected_blend','run_nxt','run_scnr','run_hdrmt','apply_mask','create_luminance_mask','lrgb_combine']; finalize ⊇ compose; (2) compose + finish('FINISH REJECTED …') stays compose; finish('Finished (quality gates PASSED)…') → finalize; (3) generate_candidates + begin_composition → compose; (4) 300 blocked calls on a 250-turn machine → turnsRemaining 0 and state finalize; (5) warmStart machine starts in compose and allows finish on turn 1; (6) replay run_2026-06-23_efe2138e/trace.jsonl through the new machine: seq 67, 72, 106, 145 are no longer BLOCKED; (7) narrowband starless brief: sho_combine ×3, save_variant ×2, begin_composition → compose → finish allowed; (8) parse giga-orchestrator.mjs for backticked tool names on lines containing PRIMARY or MANDATORY and assert each is allowed in generate_candidates.

### WI-06 (P1) Repair engine wiring: structured finish failures, provenance for all image-modifying tools, gate-text parser, forbids-only enforcement in any state, exit-on-pass, new policies, trace fields

**Files:** agents/llm/tools.mjs, agents/llm/mcp-agent-tools.mjs, agents/llm/repair-policies.mjs, agents/llm/state-machine.mjs, agents/llm/trace-analyzer.mjs, test/repair-policies.test.mjs

**Depends on:** WI-05, WI-01

**Spec:**

1) tools.mjs evaluateFinishGates (WI-01): alongside every failures.push(msg) push `failedGates.push({gate, tool, metric, value, limit, failedMetrics:[...], reason:msg, resultText:msg, verify:[tools], repairable:true, p90S?, tonal_verdict?})` where tool is the equivalent check tool (check_saturation, scan_burnt_regions, check_star_quality, check_tonal_presence, check_highlight_texture, check_ringing) or a synthetic key ('finish:core_contrast','finish:noise','finish:dust','finish:palette','finish:exposure','finish:l_missing'); Gates 11/12 repairable:false. finish returns the prose text byte-identical except the footer, plus a trailer `\n\nGATES_JSON: {"viewId":<resolved>,"failedGates":[...]}`.

2) mcp-agent-tools.mjs provenance (~217-222): record `lastModifier {tool, params, seq}` for EVERY image-modifying tool on the view (run_curves, run_pixelmath, multi_scale_enhance, run_hdrmt, shell_detail_enhance, continuous_clamp, lift_dust, inject_l_ifn, inject_luminance, stretch_stars, run_nxt/bxt/scnr, mask_ops, sho_*) keeping lastComposition for the 6 composition tools and a per-view history of the last 5. Repair trigger (~268-283): add 'finish' and 'check_ringing' and 'check_core_contrast'; for finish parse the GATES_JSON trailer, use its viewId for provenance, iterate failedGates in order, call findRepairPolicy(g.tool, g, prov, category) and engage the first repairable non-advisory match (`policy.blocking !== false`); in ANY state (no compose-only guard): set activePolicies[viewId]={policy, enteredSeq, gateName, maxTurns: policy.maxRepairTurns||12} and append generateRepairGuidance. Keep enterRepair for compose/finalize (WI-05) but the enforcement below does not depend on the repair state.

3) Enforcement: new `checkRepairForbids(name,args,policy,prov)` in repair-policies.mjs = steps 1-2 of checkRepairToolAccess (forbiddenTools + forbiddenPatterns), NO allowlist; run it before every call on a view with an active policy regardless of state. Make the dead patterns real: `_containsDesat` → regex on run_pixelmath expression (/CIE[a-z]*|\$T\s*\*\s*0\.|(avg|mean)\(/ on S/luminance idioms), `_globalDarkening` → run_curves with no mask applied and all points below identity, policy 9 → `{tool:'continuous_clamp', test:(args,prov)=> args.min_clamp < prov.params?.min_clamp}` (extend the matcher to accept a test function). Scope forbids to the policy's provenance so approved moves (NGC7635 pre-star rolloff, M27 PixelMath L) are not blocked — back-test on their traces if available.

4) parseGateFailure(gateName, resultText) → {resultText, failedMetrics[], reason, tonal_verdict, p90S}: 'colorless'→'color', 'bloated'→'fwhm', 'SUBDUED'→tonal_verdict, 'OVER-SATURATED: P90=x'→p90S. Fixture test over real strings from run_2026-06-23_efe2138e/trace.jsonl.

5) New policies keyed on the synthetic names: finish:core_contrast (allowed guidance: multi_scale_enhance, shell_detail_enhance, create_adaptive_zone_masks, apply_mask, restore_from_clone, check_core_contrast; forbidden: global run_curves darkening, continuous_clamp as first move), finish:noise (run_nxt once + check_noise; forbidden: further stretch), finish:dust (inject_l_ifn, lift_dust, run_scnr ≤0.30, measure_dust_coverage), finish:palette (sho_hue_shift, sho_combine, run_scnr, measure_palette_balance), finish:exposure (restore_from_clone + re-stretch; forbidden: post-hoc gamma), finish:l_missing (inject_luminance, lrgb_combine, check_star_layer_integrity). Each policy lists verifyTools and includes finish.

6) Exit: clear activePolicies[viewId] when a verifyTool returns PASS on that view, when finish is accepted, or after maxRepairTurns counted by seq including blocked calls; call exitRepair() when in repair state.

7) Finish hints (tools.mjs ~2640-2690): when lastComposition is a star blend or lrgb_combine, replace the hard-coded 'Compress the core pedestal (continuous_clamp)' advice with generateRepairGuidance for the matched policy.

8) Trace: add `state`, `repair_policy`, `failedGates` (parsed) to every trace entry and `repair_engaged`/`repair_violation` events; trace-analyzer aggregates reject_reasons{gate} from failedGates instead of regexing summaries.

**Acceptance:**

npm test test/repair-policies.test.mjs: parseGateFailure on 6 real finish strings yields the expected failedMetrics; findRepairPolicy('finish:core_contrast', …) returns a policy; checkRepairForbids blocks continuous_clamp with lower min_clamp under policy 9 and blocks run_pixelmath '$T*0.6' S-desat under star_color policy; a verify PASS clears the policy. Replay efe2138e: after seq 74 the engine reports a repair_engaged event and seq 75-80 continuous_clamp calls would be repair_violation. Trace entries carry state/repair_policy.

### WI-07b (P1) PI crash sentinel at the producer, MCP state persistence, --resume-agent, variant counter from disk, window-pressure signal, load_variant id forms

**Files:** agents/ops/bridge.mjs, agents/llm/mcp-agent-tools.mjs, agents/llm/engine-max.mjs, agents/llm/giga-run.mjs, agents/llm/state-machine.mjs, agents/artifact-store.mjs, agents/llm/tools.mjs

**Depends on:** WI-05, WI-07a

**Spec:**

1) bridge.mjs: export isAlive(); in the send() reject path (~105) set ctx.crashed=true and call opts.onCrash?.(err); fix the message (it says 'resume with --resume --run-id' which only the legacy orchestrator has) → 'PixInsight process not found — it crashed. STOP calling tools and end your turn; the parent will offer --resume-agent.'

2) mcp-agent-tools.mjs: register onCrash → write `<storeBaseDir>/CRASH.json` {agent, tool, seq, ts, message}. At the TOP of CallTool (before syncBriefState/swapGuard) `if (ctx.crashed || fs.existsSync(crashFile)) return 'FATAL: PixInsight crashed — STOP calling tools and end your turn now'` (also write it into the trace entry). This catches crashes swallowed by swapGuard and by the ~25 try/catch blocks in tools.mjs handlers. After every tool call write `<storeBaseDir>/agent-state-<agentName>.json` = {stateMachine.toJSON(), viewProvenance (array), brief._starIntegrity, traceSeq, variantCounters}; on startup, if that file exists and env PIX_RESUME=1, restore it via stateMachine.restore(snapshot) (WI-05) — restore state/provenance/starIntegrity/traceSeq but RESET turnsUsed to 0 (new CLI session) and on parse failure start in 'compose' (permissive), not 'assess'. Initialise traceSeq from the existing trace.jsonl line count so seq stays monotonic across MCP restarts (trace-mermaid compares seq numerically). Delete the dead periodicSwapCleanup (mtime-based deletion is the unsafe pattern).

3) artifact-store.mjs: variant counter initialised from disk (`max(variant_NN)+1` per agent dir), never from in-memory 0; persist variantCounters into manifest.json on each save (manifest.agents is currently always {}). Add store.fail(reason) → manifest.status='crashed'. loadVariant: accept short ids (resolve via getVariantById when no '/'), add opts.viewId (rename target) and replaceExisting (default false): if a window with the target id is open, forceClose when true, else throw 'REFUSED: view X already open — close it or pass view_id' (never let PI auto-suffix silently). tools.mjs load_variant/rename_view: expose those params; save_variant reply says 'reload with load_variant(artifact_id="variant_NN")'.

4) engine-max.mjs: poll `<store.baseDir>/CRASH.json` every 10 s during the run and claude.kill('SIGTERM') when it appears; on close set crashError if the file exists; drop the stderr-string heuristic. Generate a session uuid at spawn and pass '--session-id <uuid>' so the id is known even if stdout is truncated; persist {sessionId, model, num_turns, elapsedMs, usage, promptHash, cwd} to `<store.baseDir>/agents/<agentName>.json` on every close.

5) giga-run.mjs: on crashError print 'Restart PixInsight + watcher (full PI quit if the RAM-fragmentation crash), then: node agents/llm/giga-run.mjs --config … --resume-agent <runId>'. Implement --resume-agent <runId>: reopen ArtifactStore(runId), require ctx.ping() to succeed first, skip prep/gradient, read agents/giga_orchestrator.json, construct MaxAgent with the same systemPrompt (from prompts/ dir written in WI-07a)/brief/store, run with extra args ['--resume', sessionId] and identical cwd, prompt 'PixInsight was restarted; all views are gone. Call list_views, then load_variant on your best saved variant (list_variants) and continue from state <state>. If you see FATAL again, stop.'; set PIX_RESUME=1; delete CRASH.json once the resume prompt is sent.

6) Window pressure (signal, no auto-close): list_open_images appends per-window estMB=w*h*channels*4/1e6, total, and PixInsight RSS from ctx.checkMemory (bridge.mjs:148, call without liveImages); warn when total>6000 MB or RSS>MEM_WARN_MB; clone_image/open_image/load_variant/recall_champion echo the window count and total after the operation; when count ≥12 (excluding crop_mask/mask windows) the tool refuses with the list of open view ids so the agent chooses what to close. Prompt sentence (giga-orchestrator.mjs ~192-193/235/249-255): 'clone_image is for short-lived rollback inside a step; for long-lived references (pre_clamp/pre_detail/pre-star) save_variant then close_image, and load_variant on demand; keep ≤6 full-res windows open.'

**Acceptance:**

node --check; unit: a stub MCP run where ctx.crashed=true returns the FATAL text and writes CRASH.json; agent-state round-trip restore() yields the same state/provenance; variant counter from a dir containing variant_01..04 yields variant_05; loadVariant short id resolves. [PI REQUIRED] Kill the watcher mid-run on a dry target: the giga subprocess is SIGTERMed within ~10 s, CRASH.json exists, giga-run prints the resume command; after restarting PI+watcher, --resume-agent reaches list_views and load_variant without STATE POLICY blocks.

### WI-10 (P1) Tool-set hygiene: AGENT_TOOL_CATEGORIES.giga_orchestrator, hidden/visibleTo for dead tools, prompt references to hidden tools removed, legacy scoring tools demoted

**Files:** agents/llm/tools.mjs, agents/llm/giga-run.mjs, agents/llm/prompts/giga-orchestrator.mjs, agents/llm/state-machine.mjs, agents/llm/trace-analyzer.mjs, agents/llm/trace-mermaid.mjs, agents/llm/mcp-agent-tools.mjs, AGENTIC_PIPELINE_REVIEW.md

**Depends on:** WI-01, WI-05

**Spec:**

1) tools.mjs TOOL_CATALOG: add optional `hidden:true` and `visibleTo:[agents]`. run_lhe hidden (no visibleTo); run_abe, run_per_channel_abe hidden visibleTo ['gradient_agent']; submit_scores, compute_scores, check_constraints hidden visibleTo ['aesthetic_critic','technical_critic'] (legacy orchestrator keeps working); star_screen_blend, check_core_burning, auto_stretch hidden for everyone. buildToolSet: `if (tool.hidden && !(tool.visibleTo||[]).includes(agentName)) continue;`. Add AGENT_TOOL_CATEGORIES.giga_orchestrator = every category EXCEPT 'readiness' (keep calibration, star_removal, measurement, preview, image_mgmt, gradient, denoise, sharpen, stretch, masks, detail, curves, lrgb, ha_injection, stars, narrowband, artifacts, memory, control, quality_gate). Move rename_view and get_image_dimensions from 'readiness' to 'image_mgmt' (giga uses both legitimately); keep open_image, align_to_reference, combine_channels in 'readiness' (giga must not reopen 60 MP masters; recovery is via load_variant). Export getToolCategory(name).

2) giga-run.mjs:286-293: delete creativeCategories and the local buildToolSet; engine-max/mcp-agent-tools already call buildToolSet(agentName). Write {agent, toolCount, schemaChars} into the run_meta trace line (WI-08).

3) giga-orchestrator.mjs: remove every mention of hidden tools: line 87 drop 'measure_uniformity, compute_scores' (keep get_image_stats, add measure_color_gradient); :99, Phase 8 (:826-827), Phase 9 (:854-855) replace 'check_constraints + compute_scores' with 'run_quality_gates (same gates as finish)'; :112 drop auto_stretch; Phase 7.5 (:810-816) replace measure_uniformity with measure_color_gradient and delete the run_abe/polyDegree step (keep run_gradient_correction, which is public); critic-mode block (:592-593) replace 'compute_scores / submit_scores' with 'run_quality_gates then vision_aesthetic_critic'. tools.mjs:576 seti_stretch description: drop auto_stretch mention.

4) state-machine.mjs: remove check_core_burning, compute_scores, check_constraints, submit_scores, auto_stretch, star_screen_blend, open_image, combine_channels from all sets; trace-analyzer.mjs/trace-mermaid.mjs: drop check_core_burning/compute_scores from their tool lists; repair-policies.mjs: prune the legacy names from allowedTools.

5) Burn consolidation (metrics-13, code part): single PJSR pass `assessBurn(ctx, viewId, {clip=0.95, bright=0.80})` in quality-gates.mjs returning {clipBlocks, brightBlocks, brightFraction, perChannelExceedance:{R,G,B}, coreWhiteFraction}; Gates 3/3b read from it (halves the 60 MP scanning); DELETE Gate 6 (per-channel img.maximum() — fires on any star pixel >0.92); attach the 'R channel hot — reduce ha_inject' hint to Gate 3's failure text when R dominates perChannelExceedance. Fix the scanBurntRegions docstring (says 100x100/0.93; code is 50/0.95/3) and the scan_burnt_regions tool description (says 32x32/0.98) to interpolate the gate-contract constants; the standalone tool also runs the 0.80 fraction pass so the agent can preview it. Delete checkCoreBurning. Keep check_ringing as a warning in finish; reword prompt section 1 to 'revert the operation if check_ringing reports ≥3 oscillations' (do not soften to advisory).

6) Update AGENTIC_PIPELINE_REVIEW.md:151 tool count.

**Acceptance:**

node -e assertion: buildToolSet('giga_orchestrator') excludes run_lhe/run_abe/run_per_channel_abe/submit_scores/compute_scores/check_constraints/check_core_burning/auto_stretch/star_screen_blend/open_image/align_to_reference/combine_channels and includes run_sxt, run_spcc, run_background_neutralization, copy_astrometric_solution, rename_view, get_image_dimensions, run_quality_gates (expect 92-12+new ≈ 82-85); buildToolSet('gradient_agent') includes run_abe and run_per_channel_abe; buildToolSet('aesthetic_critic') includes submit_scores; `grep -nE 'compute_scores|check_constraints|submit_scores|auto_stretch|run_abe|measure_uniformity|check_core_burning' agents/llm/prompts/giga-orchestrator.mjs` returns nothing. [PI REQUIRED] harness: Gate 3 with assessBurn gives identical pass/fail on all registry images as the two-pass scan did (compare last-backtest.json before/after).

### WI-13 (P1) inject_luminance tool (validated CIE-Y ratio blend) + lrgb_combine ratio advisory + provenance-based Gate 10

**Files:** agents/llm/tools.mjs, agents/llm/state-machine.mjs, agents/llm/mcp-agent-tools.mjs, agents/llm/repair-policies.mjs, .claude/skills/pixinsight-pipeline/SKILL.md, .claude/skills/pixinsight-pipeline/reference/pjsr-processes.md

**Depends on:** WI-05

**Spec:**

1) tools.mjs: new tool `inject_luminance` (category 'lrgb') by EXTRACTING the existing PixelMath fallback at ~1767 into a shared helper. Params {view_id, l_view_id (default 'FILTER_L'), weight (0.10-0.50, default 0.20), mask_view_id?}. Before running: getStats on both views, compute ratio=medL/medRGB and return it. PJSR with symbols: `Y = 0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2]; Yn = w*L + (1-w)*Y; ratio = min(max(Yn,1e-5)/max(Y,1e-5), 3.0); $T * (1 + M*(ratio-1))` where M = mask[0] or 1 (no `$T*ratio*mask` which zeroes masked pixels); PM.truncate 0..1; no hard cap (soft compression belongs to continuous_clamp/rolloff per feedback_soft_rolloff_stars). Enforce the galaxy weight cap (≤0.25) via profile the same way lrgb_combine caps lightness, visibly (WI-04 style text). Return 'L/RGB median ratio', pre/post statsLine and checkSaturation p90S. Use execOrThrow from WI-14 if landed.

2) lrgb_combine: measure lMed/rgbMed first and return an ADVISORY line when >2.0 ('ratio X — LinearFit will crush L DR; consider inject_luminance weight 0.20-0.30 (2-3×) / 0.15-0.20 (>3×); prep deliberately produces ~3×'). Advisory, not refusal.

3) Gate 10 (tools.mjs:2759-2785): replace trace string-matching with provenance: add `brief._lUsage=[]` and push {tool, viewId, seq} from lrgb_combine, inject_luminance and inject_l_ifn handlers on success, and from run_pixelmath when the expression+symbols reference the L view (helper isLDerived(id, brief): true for 'FILTER_L' or any view whose brief._provenance/clone chain roots at FILTER_L — mcp-agent-tools must record clone_image source→target in provenance). Gate: lUsed = (brief._lUsage||[]).length>0; fallback to trace.jsonl only when _lUsage is undefined, parsing JSON lines and accepting tool∈{lrgb_combine,inject_luminance,inject_l_ifn} or run_pixelmath with /FILTER_L/ in args.expression. mcp-agent-tools summarizeArgs: keep 400 chars for the `expression` key so traces stay auditable. NOTE: _lUsage must survive MCP restarts — include it in the WI-07b agent-state snapshot.

4) state-machine.mjs: add inject_luminance to generate_candidates, compose (and thus finalize); mcp-agent-tools compositionTools += 'inject_luminance'; repair-policies finish:l_missing and saturation policies allow it.

5) Docs: SKILL.md tool list + pjsr-processes.md formula note; prompt text is in WI-09 D.

**Acceptance:**

node --check; unit test on Gate 10 with synthetic briefs: _lUsage containing inject_l_ifn → pass; empty _lUsage + trace with get_image_stats FILTER_L and an unrelated run_pixelmath → FAIL (today it passes); trace fallback on run_2026-06-23_efe2138e/trace.jsonl → pass (inject_l_ifn present). [PI REQUIRED] inject_luminance on cached NGC891-style prep (ratio ~2.9×) with weight 0.30: max stays ≥0.90 (no DR crush), ratio and p90S reported; with a mask view the masked region is unchanged.

### WI-15 (P1) Mask shaping tool (mask_ops), zone-mask blur param, 1:1 crop previews with in-crop stats, post-op dimension metrics, apply_mask geometry check

**Files:** agents/ops/masks.mjs, agents/ops/narrowband-enhance.mjs, agents/ops/index.mjs, agents/llm/tools.mjs, agents/llm/vision.mjs, agents/llm/aesthetic-critic.mjs, agents/llm/state-machine.mjs, agents/llm/prompts/giga-orchestrator.mjs, .claude/skills/pixinsight-pipeline/reference/pjsr-processes.md

**Depends on:** WI-14

**Spec:**

1) masks.mjs `shapeMask(ctx, {maskId, outputId, invert, dilatePx, erodePx, blurSigma, clipLow, clipHigh, gamma, multiplyWith})`, applied in order invert → dilate/erode → blur → range → gamma → multiply, entirely with PJSR processes (no per-pixel loops): invert = PixelMath '1-$T'; dilate/erode = MorphologicalTransformation operator Dilation/Erosion, structureSize 3 (default kernel — do NOT set structureWayTable per pjsr-processes.md), numberOfIterations=px, amount 1; blur = Convolution Parametric shape 2 sigma; range = PixelMath 'max(0,min(1,($T-lo)/(hi-lo)))' truncate 0..1; gamma = 'exp(g*ln(max($T,1e-6)))'; multiply = '$T*other[0]' after a geometry check. Guard: mono + same geometry. Return mean, coverage fraction (>0.5), min/max. Tool `mask_ops` (category 'masks', public — not in any STATE_TOOLS set). Also fix applyMask (masks.mjs:100-107): check `tw.isNull`/`mw.isNull` (not truthiness), compare width/height and throw on mismatch, check r.status. create_luminance_mask: add optional `range:[lo,hi]` and `invert`. create_zone_masks: add `blur_sigma` (number or {core,shell,halo}) replacing hardcoded 8/12/20; rewrite createZoneMasks' per-pixel loop as PixelMath for 60 MP runtime. Both mask creators return mean + coverage; flag mean<0.01 'EMPTY' and >0.95 'FULL'. Update lift_dust/inject_l_ifn descriptions to the real recipe ('create_luminance_mask(...) then mask_ops(invert, dilate_px, blur_sigma)').

2) vision.mjs: `export async function renderCropJpeg(ctx, viewId, outPath, {x0,y0,size,scale=1})` using `tmp.mainView.image.assign(img, new Rect(x0,y0,x0+cw,y0+ch))` (documented Image.assign(src, rect)); forceClose in finally. Refactor generateDiagnosticViews crops to use it. tools.mjs save_and_show_preview: optional `region` ('full' default | 'center' | 'subject' | 'corner_tl/tr/bl/br' | {x,y,w,h}), `crop_size` (default 1024), `scale` (default 1.0 for crops; 2048 cap for full); 'subject' centres on locateSubjectROI; return the crop rect in full-image coordinates, the scale and median/MAD measured inside the crop (selectedRect then resetSelections); file name `${label}__${region}_1to1.jpg` so the full-frame preview is not overwritten. Add one line to the description: 'full frame is ~0.2× on 60 MP — noise, star shape and mottle can only be judged with a 1:1 crop'. aesthetic-critic.mjs (WI-02) uses the same crop. Update giga-orchestrator.mjs:921/923, lift_faint_halo (tools.mjs:2092) and chroma_smooth (:2130) descriptions to name the call; VISUAL CONFIRMATION block adds one subject 1:1 crop per finalist. Side-by-side composite: deferred.

3) Post-op metrics (no opt-out flag; each adds ~1 s): ha_inject_luminance → statsLine + R/G/B max with the burn warning used by ha_inject_red; run_nxt → measureBackgroundNoise AFTER and append 'bgNoise=X (HARD 0.022) dustNoise=Y (HARD 0.040) PASS/FAIL'; run_curves channel 'S'/'RGB' → checkSaturation p90S vs profile warn/fail thresholds exactly as finish; run_bxt (!correct_only) → checkStarQuality medianFWHM/starsFound; create_* masks → mean/coverage. giga-orchestrator.mjs:213-214: tell the agent the post-op line IS the saturation/noise measurement; a separate check is only needed after run_pixelmath or lrgb_combine.

4) Docs: pjsr-processes.md MT numberOfIterations note; SKILL.md tool list.

**Acceptance:**

node --check; unit test on the shapeMask PJSR string builder (ordering, no structureWayTable). [PI REQUIRED] On a 60 MP mask: mask_ops dilate_px 8 + blur_sigma 20 completes (time it; if >60 s document the blur+range soft-dilate path); result coverage increases; save_and_show_preview region 'subject' on a 60 MP view yields exactly 1024 px JPEG the Read tool opens; run_nxt result contains 'bgNoise='; apply_mask with a mismatched-size mask returns an Error; back-test on ngc7023_iter03 that the new outer-field mask path (create_luminance_mask → mask_ops invert+dilate) has median < 0.9 (today's inverted mask had median 1.0 = no core protection).

### WI-17 (P1) Core relC gate: advisory when the core is demonstrably structured; galaxy core_burn calibration; consistent check tool text

**Files:** agents/ops/subject-metrics.mjs, agents/llm/tools.mjs, agents/processing-profiles.json, agents/llm/composer.mjs

**Depends on:** WI-01

**Spec:**

1) subject-metrics.mjs measureCoreContrast (~290-301): `const STRUCT_OK = cb.min_struct_frac ?? 0.80, HALO_OK = cb.max_halo_frac ?? 0.03; const structuredCore = coreStructFrac >= STRUCT_OK && haloFrac <= HALO_OK && !whiteBurnt; const relBlocking = cr < HARD && !structuredCore; pass = !relBlocking && !whiteBurnt && !desatBurnt && !structBurnt && !haloBurnt;` keep structBurnt/haloBurnt blocking ONLY when the profile explicitly supplies the keys (as today — do not re-introduce the f3a5a44 starvation). Emit 'relC advisory: structured core (struct X%, halo Y%)' as a warning. Built-in 0.80/0.03 are the values calibrated in 7ae7ef8 (pass: iter03 97.5/0.3, best-of-both 95.7/0.5, NGC7023 mega 82/1.5, NGC4490 mega 95/1.2; fail: flat-core 45.7/12.3 via struct, blown-halo graft 81.9/6.1 via halo). Caveat (honest): coreStructFrac uses an absolute grad>0.012 test that can count residual noise on a 60 MP galaxy bulge — so keep whiteBurnt blocking and require the NGC4490 burnt-core negative control to still FAIL.

2) tools.mjs check_core_burning/check_core_contrast handler (~3574-3583): print the advisory condition; composer.judgeAB uses the same pass flag (no code change; add to the harness).

3) processing-profiles.json: add core_burn blocks to galaxy_spiral/galaxy_edge_on/galaxy_elliptical with rel_contrast_hard set by the harness (expect ~0.10) and white_hard 0.15, each with `_calibration`; keep reflection_nebula at 0.35 if best-of-both (0.367) still passes with margin.

4) Peak robustness (only if the harness shows `peak` differs >10% between starless and star-blended finals): in the coarse scan keep a sample only if its 4 neighbours at ±8 px are ≥0.6× its value.

**Acceptance:**

node --check; unit test with synthetic metric objects: cr 0.15, struct 0.95, halo 0.012 → pass with advisory; cr 0.15, struct 0.45 → fail; whiteBurnt → fail regardless. [PI REQUIRED] harness: ngc7023_iter03, ngc7023_best_of_both PASS; ngc7023_giga_rejected and ngc4490_giga_rejected FAIL Gate 3c; NGC4490 mega-best (if the user still has it) passes via the advisory path.

### WI-18 (P1) Credible detail metric: stratified star-rejected sampling, self-calibrated noise floor, prep baseline, advisory max_gain, ledger uses detailCredible, prompt wording

**Files:** agents/ops/subject-metrics.mjs, agents/ops/quality-gates.mjs, agents/llm/deterministic-prep.mjs, agents/llm/narrowband-prep.mjs, agents/llm/tools.mjs, agents/ledger.mjs, agents/processing-profiles.json, agents/llm/prompts/giga-orchestrator.mjs, agents/llm/warmstart.mjs

**Depends on:** WI-01

**Spec:**

1) subject-metrics.mjs measureSubjectDetail: replace the first-50-raster-blocks loop (:94) with stratified sampling over ALL subject blocks (every k-th block so ≤50 are used, spread across the subject). Star rejection per 3×3 window: skip when window max > blockMedian+0.25 or any pixel >0.85; skip whole blocks whose max/median ratio marks them star-dominated. Noise floor: in the same PJSR pass compute Sobel energy with the identical kernel/stride on the N darkest background blocks (bgSamples) → E_noise; detailCredible = mean over subject blocks of max(0, E_block − E_noise); also report detailRaw (old), detailWeber (energy / blockMedian²) and noiseDominated = detailRaw/detailCredible > 2.5. Keep `detailScore` = detailRaw for backward compatibility of thresholds.

2) Baseline: at the end of runDeterministicPrep (after result.views.rgb is final, ~:789) measure detailCredible/detailWeber on views.rgb and, when present, views.l / starless L; store brief._baselineDetail={rgb,l,max} and write prep-metrics.json in the run dir; narrowband-prep: same on the palette composite. warmstart.loadBaseRunAsPrep copies the base run's prep-metrics.json. Finish compares against `max` for LRGB/HaLRGB and `rgb` for RGB-only; measure gain on the pre-star-blend starless composition when available (star_protected_blend records brief._lastStarlessComposite={starlessId,outputId}); else star-rejected sampling on the final.

3) Gate: ADVISORY warning when detailWeber gain > profile `detail.max_gain` (starting values galaxy_spiral 1.6, galaxy_edge_on 2.0, emission 3.0, reflection 2.0, cluster 1.5, all `_calibration:'PROVISIONAL'`) or noiseDominated. Promote to blocking only after the harness measures the confirmed NGC3628 approved image (+28% must pass) and PACMAN LIFT5; M81 v11 (+76%) is recorded as a winner — if the user re-exports it, it must pass too (so galaxy_spiral max_gain will likely need ≥1.9).

4) ledger.mjs:211 scoreVariantDimensions 'detail' → detailCredible*100 + contrast*0.1 (scoreVersion bump in WI-19). composer.mjs candidate selection uses detailCredible.

5) check_sharpness: make it delegate to the new measurement with ROI support (do not delete; it is referenced in prompts, state-machine, trace tools, scripts/pi-tool.mjs).

6) giga-orchestrator.mjs:369: 'must INCREASE with each LHE/HDRMT step' → 'detailCredible should rise modestly (profile detail.max_gain over the prep baseline shown in your initial message); detailRaw/detailCredible must stay < 2.5 (noise dominance)'; measure_subject_detail description updated. Initial message prints the baseline.

**Acceptance:**

node --check; unit test on the sampling helper (stratified indices cover the whole block list; star windows rejected). [PI REQUIRED] measure_subject_detail on ngc7023_iter03 vs ngc7023_giga_rejected: credible detail ratio is consistent with the user's judgment (rejected one has lower credible detail or higher noiseDominated); on a pure-noise synthetic 1024² window detailCredible ≈ 0; NGC3628 approved image gain vs its prep (if prep cache exists) ≈ +28% ±10%.

### WI-19 (P1) Ledger & cross-run learning: dust-based IFN champion, scoreVersion, stage/approach signatures, workflow-scoped key, params_summary persisted, dead learning paths removed

**Files:** agents/ledger.mjs, agents/llm/tools.mjs, agents/llm/giga-run.mjs, agents/llm/state-machine.mjs, agents/llm/prompts/giga-orchestrator.mjs, agents/processing-profiles.json, agents/memory/hierarchical-memory.mjs

**Depends on:** WI-01, WI-18

**Spec:**

1) ledger.mjs: `export const CHAMPION_SCORE_VERSION = 2`; recordChampions stores scoreVersion and trimmed raw metrics per entry; replacement rule `if (!prev || prev.scoreVersion !== CHAMPION_SCORE_VERSION || bestScore > prev.score)`; getChampions/compare_to_champions skip mismatched versions. scoreVariantDimensions: `const du=m.dust; if (du && !du.error && typeof du.dustCoverage==='number') out.ifn_visibility = du.dustCoverage + du.dustMeanSat + 0.5*Math.min(du.fieldP95||0, 0.5); else fallback`. NOTE (honest): the skeptic found these weights rank 4bbeec17 (0.70, dust hugging core) above iter03 (0.677); before committing, run scoreVariantDimensions on ngc7023_iter03, best-of-both and 4bbeec17-like outputs and pick weights where iter03/best-of-both > the regressed output (try dustCoverage*2 + dustMeanSat + 0.25*min(fieldP95,0.5)). star_quality interim: `(starsFound>=20) ? (1/(1+medianFWHM)) * Math.min(1, starBgContrast/4) * (1 + Math.min(colorDiversity,0.05)*10) : 0` (colorDiversity is ~0.05-scale). Export ledgerKey(brief) = classification for broadband, `${classification}@${workflow}` when dataDescription.narrowband; thread through recordOutcomes/extractLedgerGuidance/recordChampions/getChampions (giga-run.mjs:334,:337,:567; tools.mjs:~1407,:~1615,:~2883; giga-orchestrator.mjs:16). Existing bare-key entries stay valid for broadband.

2) tools.mjs: finish passes dust:champDust to scoreVariantDimensions AND compare_to_champions (~1412-1418) also measures dust when profile.ifn exists (otherwise BEHIND/AHEAD is meaningless). finish writes params_summary into final-selection.json and merges it into the winner variant's metadata.params.

3) save_variant schema: optional `stage` (enum base, branch_detail, branch_ifn, branch_color, branch_stars, branch_palette, branch_core, composition, final) and `approach` (array of short tokens); handler defaults stage from brief._stateMachine.state (compose→composition, finalize→final, else branch_unspecified), stores both + state + classification in metadata.params. canonicalizeApproach: use params.approach when present (sorted/deduped/lowercased), else the notes heuristic minus the `style:edge` token; add narrowband tokens palette:<p>, hueshift:on, halo_lift:on, chroma:on, synthL:on, ogain:<round(o_gain*2)/2>. recordOutcomes counts only stage∈{composition,final} (legacy: notes /final|composition|comp_/i) as tried; also iterate composer/core_specialist dirs; SKIP recording when no final-selection exists (today churn runs record every signature as rejected). extractLedgerGuidance never emits a single-token PRUNE naming a mandatory family (detail:on, ha:on, comp:*). checkBranchCompleteness prefers params.stage when present. Migration: reset ledger.json classes.*.approaches and _meta.epsilonCounter, keep champions (dangling xisfPaths are pruned by WI-24 protection logic). Prompt: show one save_variant example per stage with stage+approach; the final save must list the full stack actually used.

4) giga-run.mjs: delete updateProcessingProfile (:626-721) and the P3b call; delete `learned_overrides` keys from processing-profiles.json ONLY where they are machine-written (keep the hand-written planetary_nebula notes by moving them into `notes`); replace extractWinningParams (:726-754, injected at :331 — it currently injects stale March-2026 M81 recipes for galaxy_spiral) with nothing (recall_memory is mandatory on turn 1 and returns the same buckets). In finish, after writeFinalSelection succeeds, save one hierarchical entry per numeric params_summary key at level 'target' tagged ['auto','finish_params'] (NOT 'winning_param' — a passing finish is not user approval; promotion stays manual/by --approve).

5) giga-orchestrator.mjs: do NOT inject champMergeCandidate when isNarrowband (region grafts between false-colour palettes are not meaningful).

**Acceptance:**

npm test: ledger unit tests — scoreVariantDimensions with dust object vs fallback; ledgerKey for SHO brief = 'emission_nebula@SHO'; canonicalizeApproach(['lhe2pass','inject_l_ifn']) → stable signature; recordOutcomes on a fixture run dir with stage metadata counts only composition/final variants; extractLedgerGuidance never prunes 'detail:on'; compare_to_champions path calls measureDustCoverage when profile.ifn (stub). Dry render of a galaxy_spiral prompt no longer contains 'Winning Parameters from Previous Runs'. [PI REQUIRED] scoreVariantDimensions on ngc7023_iter03 and best-of-both ranks above the rejected output with the chosen weights (record in _calibration).

### WI-16 (P1) Star field metric rework: compact-peak detection with knot rejection, local-background FWHM, uncapped walk, ellipticity, center/edge split, absolute prominence — advisory until back-tested

**Files:** agents/ops/quality-gates.mjs, agents/llm/tools.mjs, agents/processing-profiles.json, agents/llm/gate-contract.mjs, agents/ledger.mjs

**Depends on:** WI-01, WI-04

**Spec:**

1) quality-gates.mjs: new `measureStarField(ctx, viewId, opts)` (ES5 PJSR, no StarDetector — it crashes). Detection: keep the local-max scan but add a compactness test (reject peaks whose 4 neighbours at ±8 px are ≥0.6× the peak-minus-localBg → nebula knots) and skip saturated plateaus (>0.98). Per star: localBg = median of a 6-8 FWHM annulus; halfMax = localBg + (peak−localBg)/2; half-max walk up to 31 px uncapped (today r≤10 silently drops the bloated stars that the gate is for, and halfMax=peak/2 without bg subtraction drops faint stars on lifted fields); second moments (background-subtracted 31×31 box thresholded at 10% of prominence, SNR>20, reject if a second local max >30% of peak lies in the box) → ellipticity b/a; colour diversity from the mean of the 3×3 around the peak (not the single clipped pixel). Report center vs edge separately: center zone = `gates.stars.center_radius_px` from profile/brief, default 0.55 × half-diagonal (NOT 0.55×min(W,H)/2 which is inside the 3590 px corrected circle on the ASI6200); edge is advisory. Prominence: report absolute (peak − localBg) and local ratio; the existing whole-image ratio `medianPeak/bgMedian` stays as the BLOCKING metric until the harness confirms the replacement (it structurally conflicts with the 0.65 rolloff knee at target_median ≥0.20 — document this).

2) Star-layer source: capture `brief._starPeaks` (coordinates of compact peaks on the star layer) inside the star_protected_blend handler and have finish re-measure those coordinates on the final view; fall back to the compactness-filtered scan when absent.

3) Thresholds via gate-contract: FWHM_HARD stays 12 (advisory 8) with the galaxy exemption; ellipticity 0.25 and dark-ring 5% ADVISORY; all provisional. Retire the galaxy-only FWHM exemption only after the harness confirms NGC891/M81 champions still pass with knot rejection.

4) check_star_quality returns the new fields; finish Gate 1 warnings include center/edge FWHM, ellipticity and absolute prominence; the ledger champion record stores the measured star field so future thresholds can be calibrated cross-run.

**Acceptance:**

node --check; unit test on the ES5 string builder for syntax (eval in node with stubbed Image API where feasible). [PI REQUIRED] run measureStarField on ngc7023_iter03 (user: stars 'outstanding'; expect medianFWHM ≈11-13 px center, prominent) and on a PACMAN starred intermediate if available; a synthetic 60 MP test view with one Gaussian star FWHM 24 px must report fwhm ≈24 (today it is dropped); on an M27-like nebula field (cached M27 prep if present) starsFound drops to compact stars only (≤30% nebula knots by visual spot check of 10 coordinates). Harness: Gate 1 verdicts on all registry images unchanged (blocking metric untouched).

### WI-09 (P1) giga-orchestrator prompt consistency pass: runtime-states section, Branch B for dust fields, LRGB decision block, PNe HDRMT option, ranking by gates+reference+critic, KNOWN FLAWS rationale, dead Phase-1 removal, de-versioned anecdotes, gate table, diagnostics delivered, prompt-size ratchet

**Files:** agents/llm/prompts/giga-orchestrator.mjs, agents/llm/giga-run.mjs, agents/llm/tools.mjs, agents/target-taxonomy.json, test/prompt-render.test.mjs, test/prompt-state-consistency.test.mjs

**Depends on:** WI-01, WI-05, WI-10, WI-03, WI-13, WI-15

**Spec:**

All edits in agents/llm/prompts/giga-orchestrator.mjs unless stated. Keep emission/SHO renders byte-identical where the item says so (golden snapshots in test).

A) RUNTIME STATES: replace the Phase 0-9/7.5/8.5 scaffolding with a 'RUNTIME STATES (enforced by the harness)' section mirroring STATE_TOOLS after WI-05: assess → generate_candidates on first clone_image (or 15 turns); → compose on begin_composition / lrgb_combine / star_*_blend; repair guidance may engage on any FAIL; finish → finalize ONLY when gates pass (a rejected finish keeps you in compose with the full toolset — 'finish is a probe: run run_quality_gates first to see the same verdict without committing'); forced finalize at ≤15 turns remaining. Keep branch names as mission labels, not phases.

B) Dead Phase-1 block (:318-359) → three lines: 'Prep is done by deterministic prep from the processing profile. Your initial message lists the open views, their measured medians and the applied prep recipe (do not repeat it). Before branching, save_variant each prep view (rgb/L/Ha) as a baseline — prep does not checkpoint them.' Replace hard-coded stretch/headroom numbers at :125, :188, :340-347 with values rendered from brief.processingProfile.stretch.{target_median,headroom}.

C) Branch B: `const dustCfg = brief.processingProfile?.ifn || null; const hasDustField = hasIFN || !!dustCfg;` use at :314 and :452; heading 'BRANCH B — FAINT STRUCTURE REVEAL (IFN / dust / halo)'; render the contract from the profile: `dustMeanSat >= ${dustCfg?.min_dust_mean_sat ?? 0.24} AND fieldP95 >= ${dustCfg?.min_field_p95 ?? 0.15}; GOAL dustCoverage >= ${dustCfg?.min_dust_coverage ?? 0.24}` with the TRUE predicate 'Gate 3e FAILS only when greyed AND crushed AND warmDustFraction ≥ 0.35'; order: run_scnr → inject_l_ifn (mask_view_id = outer-field mask built with create_luminance_mask + mask_ops invert/dilate) → lift_dust → run_nxt → measure_dust_coverage + check_noise, all in generate_candidates; keep the planetary halo variant; delete 'v6 had dramatic IFN but v7 lost it'. Render brief.processingProfile.notes in the Target section. giga-run.mjs initial message: when profile.ifn exists add 'Finish Gate 3e will reject greyed/crushed dust — Branch B must run inject_l_ifn + lift_dust and verify with measure_dust_coverage.' Also: target-taxonomy.json reflection_nebula/dark_nebula get `hasDust:true` (do not flip hasIFN, which drives the galaxy-IFN wording).

D) L INCORPORATION DECISION (replace :701-721 and the PNe Option A/B at :636-645; gate on hasL; read lrgbUse = brief.processingProfile?.tools?.LRGB?.use): '(1) get_image_stats on FILTER_L and the RGB winner → ratio = medL/medRGB; measure_uniformity on FILTER_L. (2) ratio ≤ 2 AND lrgbUse !== "avoid" → lrgb_combine (profile lightness; saturation start 0.60); check_saturation + check_highlight_texture after. (3) ratio > 2 OR lrgbUse === "avoid" → inject_luminance (weight 0.15-0.20 for ratio>3, 0.20-0.30 for 2-3, never >0.30; galaxies ≤0.25) — LinearFit in lrgb_combine crushes L DR (NGC891 max 0.976→0.268). For planetary_nebula the additive form `$T*(1+(FILTER_L-med_L)*factor)` (factor ≤1.0, M97/M27) or SYNTH_L remain valid. Both routes count as using L (Gate 10). (4) Post-combine brightness recovery ONLY via run_curves channel L, never RGB gamma. (5) L uniformity > 0.02 → route 3 with low weight; never RGB-only.' Update 'For each composition' step 1 to 'Incorporate L by the decision above'. giga-run.mjs:311: add an L uniformity line to the prep summary.

E) PNe block (:656-699): rename 'CONTINUOUS CLAMP (mandatory pre-star) + HDRMT (optional, branch phase only)'; delete step 1 (GLOBAL unmasked HDRMT), 'Why this works', 'Key principle' and the v7-v12 list (convert the 5 failures into the 5 rules they encode: no clamp = core burn; global clamp = halo loss; HDRMT through small-blur core zone mask = rings; clamp-before-stars then screen blend re-burns → clamp after blend or star_protected_blend; discrete zone-mask clamping = dark rims → continuous_clamp). Add to the PNe branch guidance the validated donut recipe as a TRY: create_luminance_mask(clipLow=0.10, blur=10, gamma=2.0) → mask_ops gamma/donut via run_pixelmath '$T*(1-$T)*4' → apply_mask → run_hdrmt(inverted=true, layers=5, iterations=1) → remove_mask → check_ringing (0 oscillations) + measure_subject_detail; reject at 7L; keep only if detail rises AND the 2× contrast gate still passes (M97 +173%; M27 v10 winner used no HDRMT). :117 → 'Masks for LHE always; HDRMT only through a donut mask on PNe (never global, never through small-blur zone masks)'. processing-profiles.json planetary_nebula HDRMT reason text → donut recipe.

F) Phase 6/7 (:746-790): retitle 'ARTIFACT INSPECTION + RANKING'; delete 'metrics lie, eyes do not', 'Visual assessment OVERRIDES', 'Trust your eyes', 'FEEL something', 'Would I be proud'. Ranking order: (1) run_quality_gates on each COMP candidate (deterministic); (2) if brief.reference_path is set, compare_to_reference on the top 3 SEQUENTIALLY (open, compare, close — never hold all open), prefer lower color_emd then coverage_delta; (3) vision_aesthetic_critic(phase='composition_critic') on the top 2 — flaws are 'fix or explicitly rebut', never a hard auto-veto, numeric score not used for ranking; (4) deterministic metrics as tie-break. Previews (save_and_show_preview + Read, plus a subject 1:1 crop) are a NAMED-ARTIFACT VETO ONLY (ringing/dark rim, white core blob, mask seam, bloated/erased stars, colour mottle, banding) — never a promotion reason. Keep the priority list (faint structure, subject structure, plausible colour, controlled stars, cleanliness) as the style target; keep 'reject safe-but-dull' under vivid intent only (WI-03). Surface brief.reference_path in the header when set.

G) Phase 9 rationale: must begin with 'KNOWN FLAWS:' (critic flaws + own vetoes + gate warnings), then a metric table of finalists, then the choice; no evaluative adjectives. tools.mjs finish: add optional `remaining_flaws` (array) and return a non-blocking warning when it is absent; persist gates/critic/reference/warnings/remaining_flaws into final-selection.json (store.writeFinalSelection extended). giga-run.mjs wrap-up (:611-620): print a 'Critical summary' block FIRST (remaining_flaws, critic score + flaws, reference deltas or 'no reference', gate values nearest thresholds, warnings), then paths/duration/tokens; replace 'GIGA Processing complete!' with 'Run finished — review the flaws above; final judgment is yours.' Append the same block to trace-summary.md.

H) Anecdotes → de-versioned rules in place: :188 ('v13 showed…/NGC7635 292 blocks') → 'extended regions above 0.80 are gated by profile burn.max_bright_block_pct'; :296 → 'Any branch with max > 0.90 is burnt; check per-branch max BEFORE composition'; :543 → 'ha_inject_red without a mask reddens the whole background — always mask'; :581 drop 'Previous runs'; :815 → keep 'SCNR is mandatory for reflection/dust/IFN', drop 'The last run SKIPPED'. Renumber '### 4. SATURATION'→5, '### 5. Ha INJECTION'→6. Fold :283-296 burn-scan repetition into gate 3 (:178-193) as a short 'after any tone change' list; leave gates 1-2 untouched.

I) Gate table: render buildGateTable(brief) (WI-01) once in QUALITY RULES and replace ONLY the gate-threshold sentences at :60, :167-168, :185, :205, :217, :466, :648, :677 with references to it (FWHM/star-count rows WARNING; dust row with the real AND predicate; contrast 2× row lists the outer_halo classes from target-taxonomy.json; check_noise bgNoise 0.022 row added). Apply the same to gradient-agent.mjs and core-specialist.mjs where they quote gate numbers.

J) Startup diagnostics (models-04): giga-run.mjs:384 → `agent.run(initialText, [...diagPaths, ...lDiagPaths])`; change :328 to '### Diagnostic views saved on disk (RGB: overview / center_crop / corner_crop / bg_stretch; L in diagnostics/prep_l) — paths are listed at the end of this message. Read the overview and corner crop before branching (corner crop = coma/gradient check).' Drop the unused buildImageMessage import. Leave maxDim 2048 (lowering it does not reduce peak PI memory).

K) Prompt-size ratchet: test asserts per-config char count ≤ post-cut size (~36,000; set the ratchet to the measured value after this item, never 26,000), no duplicate '### N.' headings, no /KNOWN BUG|Previous failures|\bv\d+ (had|showed|failure)/ tokens, and every backticked tool name in RUNTIME STATES/branch sections exists in TOOL_CATALOG, is not INTERNAL/hidden, and is allowed in the mapped state; any 'name=value' next to a tool matches a key in that tool's input_schema (catches polyDegree-style drift).

**Acceptance:**

npm test: test/prompt-render.test.mjs (renders all 11 *_agentic.json configs through generateBrief + buildGigaOrchestratorPrompt with getChampions stubbed; NGC7023 and LDN15 (only if profile.ifn exists) show the dust block; M97 and NGC891 contain no 'LRGB COMBINE IS NOT OPTIONAL'; PACMAN render byte-identical to its golden snapshot from WI-11; no 'metrics lie'/'Trust your eyes'/'FEEL something'; size ratchet holds) and test/prompt-state-consistency.test.mjs. giga-run dry run prints the diagnostics path list at the end of the initial message. [PI REQUIRED] one NGC7023 live run: trace has zero BLOCKED dust-tool calls and dustCoverage ≥ 0.24 at the first finish.

### WI-11 (P1) Narrowband path: conditional prompt sections (no stars/SPCC/Ha/LRGB/ABE text for SHO/HOO), starless blend refusal, HOO defaults, channel_balanced skip, workflow-aware gate hints, recall filter, ledger key

**Files:** agents/llm/prompts/giga-orchestrator.mjs, agents/llm/tools.mjs, agents/ops/sho-palette.mjs, agents/classifier.mjs, agents/scoring.mjs, agents/llm/state-machine.mjs, agents/memory/hierarchical-memory.mjs, agents/llm/giga-run.mjs, .claude/skills/pixinsight-pipeline/reference/narrowband-sho.md, test/prompt-render.test.mjs

**Depends on:** WI-05, WI-02, WI-19

**Spec:**

1) Safety first (tiny): tools.mjs star_protected_blend (~1145) and star_screen_blend: refuse when brief.dataDescription.starless is true ('REFUSED: starless deliverable — stars are added later by the user'). Finish post-pass star warning (tools.mjs:2856-2862): guard with `if (!isStarless)`.

2) giga-orchestrator.mjs restructure into section functions keyed by workflow (practices, qualityRules, branchDetail, branchFaint, branchColor, branchStars, compositions, phase75, phase8/9) assembled by `if (isNarrowband)`; broadband assembly byte-identical to today (golden snapshot). For isNarrowband: drop SPCC/star_protected_blend/lrgb_combine/copy_astrometric_solution practice lines; line 60 → 'Stars: none (starless deliverable)' when isStarless; gate the burn-scan 'After Ha injection' line AND the shell-emission 'Ha injection FIRST' order block on hasHa; replace 'Stars layer stays open' with 'linear NB star layers on disk: <paths>' (omit when starless); Branch C body = the palette steps 1-9 VERBATIM (PACMAN-approved numbers) with the heading fixed ('replaces Branch C (colour)', not D) and the duplicate '9.' renumbered (halo lift stays 9, luminance option becomes 10); gate the 'NARROWBAND-STYLE COLOR PROCESSING' block (:507-522, extract_pseudo_oiii from B = OIII in SHO) and Branch C's ha_inject_red/ha_inject_luminance/extract_pseudo_oiii/dynamic_narrowband_blend tool list on !isNarrowband; omit Branch D entirely when isStarless, else a short NB variant ('open <Ha star layer path>, stretch_stars, check_star_layer_integrity, blend once'); compositions for NB = COMP_palette_foraxx / COMP_palette_sho (or hoo) / COMP_synthL (Ha or 0.7Ha+0.3O as L, lightness ≤0.5) / COMP_halo_lift instead of COMP_boldIFN/COMP_synth_L; Phase 7.5 for NB: no run_abe/run_gradient_correction/SCNR-first on the palette — prep already GC'd each mono channel; if a residual gradient shows, run_gradient_correction on the mono FILTER_* view then rebuild with sho_combine; final sky via neutralize_palette_background + measure_palette_balance; Phase 8/8.5 star checks omitted when starless; memory templates about Ha injection/star blend omitted. HOO branch (brief.dataDescription.workflow==='HOO'): line 907 lists only delivered channels (FILTER_Ha, FILTER_O); steps 2-4 → sho_combine palette 'hoo' bracketing hoo_o_weight 0.5/0.65/0.8 and o_gain; optional sho_hue_saturation red/orange + cyan/blue; no sho_hue_shift step. Add 'when palette bracketing is done, call begin_composition (or lrgb_combine with FILTER_Ha as L) to enter composition; finish is only accepted after that'.

3) tools.mjs HOO defaults: sho_combine `palette = input.palette || (wf==='HOO' ? 'hoo' : 'foraxx')`; if palette!=='hoo' && !channels.S && !input.s_id return text 'palette X needs SII; this is an HOO dataset — use palette "hoo" (bracket hoo_o_weight 0.5/0.65/0.8)'; pass s_id = hasS ? (input.s_id||'FILTER_S') : null; same derivation in suggest_narrowband_balance (:2179) and repair_star_residuals (:2157). sho-palette.mjs measurePaletteBalance: accept opts.palette; for 'hoo' notes become 'cyan/blue X% — OIII not reading: raise o_gain or hoo_o_weight' (drop foraxx/hue_screen/sho_hue_shift suggestions). Gate 1b thresholds unchanged (verified: the hoo mapping cannot produce green/magenta); only the notes text was wrong. Update the sho_combine description ('hoo is the only palette buildable without SII').

4) classifier.mjs: hardConstraints.maxChannelImbalance = null when isNarrowband; scoring.mjs channel_balanced returns pass with detail 'false-color palette — skipped' when the limit is null (whole-image per-channel medians make any threshold wrong for a field-filling gold palette).

5) Finish gate hint text workflow-aware: Gate 4 DETAIL TOO LOW (:2591) for emission/narrowband → 'use shell_detail_enhance (medium 0.6, large 0.4) through a body mask' (multi_scale_enhance is blocked for emission); Gate 8 TONAL (:2685) for narrowband → 'lift the body through a luminance mask (run_curves), then lift_faint_halo; no galaxy core mask'; Gate 6 is deleted in WI-10. Add shell_detail_enhance and lift_faint_halo to the finalize set (WI-05 makes finalize ⊇ compose, which already contains shell_detail_enhance; lift_faint_halo is public). Do NOT change narrowband_palette.stretch.min_median_fraction (no recorded LIFT5 median to back-test; current floor 0.042 passes with 39% margin).

6) hierarchical-memory.mjs: saveEntry stamps fullEntry.workflow and fullEntry.starless from brief; recallForBrief excludes universal/trait entries stamped with a broadband workflow when brief.dataDescription.narrowband, and adds one header line 'NOTE: STARLESS NARROWBAND run — entries about star blends, SPCC, Ha injection and compose-state tricks are broadband-era; do not call star blend tools to unlock compose (use begin_composition).' giga-run.mjs: extractLedgerGuidance uses ledgerKey (WI-19).

7) Add an HOO example config (e.g. NGC6888_HOO_agentic.json) and document the HOO section + rendered layout in narrowband-sho.md.

**Acceptance:**

npm test prompt-render: PACMAN_SHO render contains none of 'SPCC', 'ha_inject', 'BRANCH D', 'COMP_boldIFN', 'stretch_stars FIRST', 'extract_pseudo_oiii', 'run_abe' and contains the verbatim palette steps; the HOO fixture render contains 'hoo_o_weight' and not 'sho_hue_shift'; broadband renders (NGC7023, M97, NGC891) byte-identical to golden snapshots; unit: star_protected_blend handler with starless brief returns REFUSED without calling ctx; sho_combine with HOO brief and no palette resolves 'hoo'; checkHardConstraints with maxChannelImbalance null passes channel_balanced. [PI REQUIRED] one end-to-end PACMAN_SHO giga run (first ever): reaches compose via begin_composition, finish passes without Gate 11 blocking, no star blend in the trace, export is starless.

### WI-12 (P1) Narrowband prep: result cache, linear starless channel snapshots, reload_narrowband_channel tool, profile-driven NXT, warm-start support

**Files:** agents/llm/narrowband-prep.mjs, agents/llm/deterministic-prep.mjs, agents/llm/warmstart.mjs, agents/llm/tools.mjs, agents/processing-profiles.json, agents/llm/giga-run.mjs, .claude/skills/pixinsight-pipeline/reference/narrowband-sho.md

**Depends on:** WI-11

**Spec:**

1) Shared helpers: move fileFingerprint and CACHE_DIR from deterministic-prep.mjs into agents/llm/prep-cache-util.mjs (deterministic-prep already imports narrowband-prep — avoid the circular import).

2) narrowband-prep.mjs cache: key = sha256(hash of narrowband-prep.mjs + agents/ops/sho-palette.mjs + fingerprints of S/Ha/O + F.starless + resolved stretch target/headroom + ONLY the channel-affecting nb options (nxtLinear, nxtPost, bxtNonstellar, gradientEdgeSigma, repairStarResiduals, forceAlign, stretchTarget)). Do NOT hash palette/hGain/hueShift/scnr (they only drive the cheap initial composite, rebuilt on every hit). Split runNarrowbandPrep after the residual-repair step (before 'Initial palette composite'): on miss run the chain, then saveAs stretched starless FILTER_S/Ha/O into ~/.pixinsight-mcp/prep-cache/<key>_nb/ + meta.json {files, result.stats, result.narrowband (starLayers absolute paths, gradient, residualRepair), workflow, cachedAt}; on hit force-close existing FILTER_*/target windows, open the XISFs (close crop_mask/aux windows as loadFromCache does, rename mainView.id), restore stats/narrowband, verify starLayers paths exist (else miss). Then fall through to the shared palette tail. Also copy the three stretched XISFs into <runDir>/prep/ (hard-link or saveAs) so each run is self-contained.

3) Linear snapshots: after SXT (post :196, before the stretch loop) save each starless LINEAR channel to `${outputDir}/FILTER_<k>_linear_starless.xisf` (~230 MB each). Record paths + applied nxtLinear/nxtPost/stretchTarget/hueShift/scnr/hGain in result.narrowband.prepParams; print them in the giga initial message block (giga-run.mjs:319-324) so the prompt's 'NXT 0.35' reads 'NXT 0.35 on top of prep's post-NXT {…} — lower or rebracket via reload_narrowband_channel if grain/smoothing looks wrong'.

4) tools.mjs: `reload_narrowband_channel` (category 'narrowband', public) {channel:'S'|'H'|'O', stretch_target?, nxt_post?}: force-close the existing FILTER_<k> view, open the saved linear starless file, rename to FILTER_<k>, close crop_mask siblings, setiStretch at the given target (default prep target), NXT at the given strength (0 = none), return getStats. One bridge round-trip. (open_image is 'readiness' and not available to giga.)

5) Profile wiring: narrowband-prep reads brief.processingProfile.tools.NXT exactly as deterministic-prep.mjs:275-282 does — denoise_linear / denoise_post_stretch scalars plus optional denoise_post_stretch_per_channel {H,S,O} and denoise_linear_per_channel; move today's 0.30/0.60/0.45 and the linear values into processing-profiles.json narrowband_palette.tools.NXT (fixing the currently-ignored 0.25/0.30 entries); keep files.narrowband.nxtPost as a config override. Gradient: keep the deterministic 1.5σ edge-spread rule (a per-channel 50-turn sub-agent is poor value; measured spread on the only real dataset was ≤0.3σ) but expose `measure_background_grid` (category 'measurement', returns edgeSpread/edgeMin/edgeMax in σ for mono views) so the agent can verify.

6) warmstart.mjs loadBaseRunAsPrep: read the base run's brief via ArtifactStore.loadBrief(); if dataDescription.narrowband, re-open FILTER_S/Ha/O from <baseRunDir>/prep/ (fallback: recompute the nb cache key and load from prep-cache; else throw 'rerun prep'), return views.{s,ha,o} and a narrowband block so giga-run.mjs:319-325 emits the NARROWBAND section and tool defaults resolve. Keep rgb = base winner.

7) Docs: cache key/invalidation and warm-start requirements in narrowband-sho.md; update memory project_prep_cache.md; record the actual prep duration (the '30+ min' figure is unmeasured).

**Acceptance:**

node --check; unit test of the cache-key function: changing palette/hGain does not change the key, changing nxtPost does. [PI REQUIRED] Run PACMAN_SHO_agentic.json twice: second run logs 'NB cache HIT' and reaches the agent in minutes; compare_to_reference of the rebuilt initial composite vs the first run's base_palette is ≈ identical; then `--base-run <run> --intent "lift the faint halo"` → lift_faint_halo succeeds (no 'Ha view not found'); reload_narrowband_channel S with nxt_post 0.3 returns stats and leaves exactly one FILTER_S window.

### WI-20 (P2) Memory and feedback-doc hygiene: prior-strength labels in recall, universal dedupe with feedback exemption, stale/contradictory memory index reconciled

**Files:** agents/memory/hierarchical-memory.mjs, agents/llm/tools.mjs, /Users/aescaffre/.claude/projects/-Users-aescaffre-pixinsight-mcp/memory/MEMORY.md, /Users/aescaffre/.claude/projects/-Users-aescaffre-pixinsight-mcp/memory/feedback_pne_star_attenuation.md, /Users/aescaffre/.claude/projects/-Users-aescaffre-pixinsight-mcp/memory/feedback_l_gradient_rgbonly.md

**Depends on:** WI-05, WI-04

**Spec:**

1) hierarchical-memory.mjs recallForBrief summary: prefix lines with prior strength — universal '[STRONG]', type/trait '[TYPE prior <cls>, conf=N]', target '[WEAK target-only <name>, conf=N]' — and append the doctrine line 'target-level recipes are anecdotes; prefer type/trait rules; override when measurements disagree'. Universal: run deduplicateEntries, exempt entries tagged feedback/user_feedback/bug/gotcha/quality_gate from eviction, cap the remaining auto/technique entries at ~30 by recency; truncate the universal summary to feedback-tagged entries plus the 20 most recent. Annotate the stale bypass hacks ('Pedestal + PixelMath screen blend bypass works for finalize state', 'State machine: lrgb_combine requires compose state — trigger via early star_protected_blend', 'Ringing gate made non-blocking (code fix pending restart)') as superseded after WI-05. optimizeMemory Phase 1: group by param only and promote the median when 3+ targets fall within ±15% (exact float equality never fires).

2) Prompt Phase 9 save_memory guidance: 'save lessons, not recipes; one param per entry; choose level: universal only for tool/gotcha facts, type for class rules, target for this-target anecdotes'.

3) Memory docs (user's memory dir): MEMORY.md — drop feedback_l_gradient_rgbonly from the live list, add a 'Superseded' subsection ('l_gradient_rgbonly → superseded by lrgb_mandatory + lrgb_median_mismatch'); fix line 'Galaxy background target: 0.10 / PNe 0.22' to cite processing-profiles.json as source of truth (galaxy 0.08, PNe 0.11, emission 0.10, reflection 0.20) and fix the seti_stretch tool description/default in tools.mjs:547-562 to agree; rewrite feedback_pne_star_attenuation.md's 'defaults raised 0.70/0.30' bullets to 'defaults are profile-driven since WI-04 (PNe 0.75/0.95/0.50)'; prepend `superseded_by:` to the four orphan files (feedback_gemini_pro → claude_binary/Max engine; feedback_large_images_memory → full_res_no_downsample; feedback_gradient_strategy → project_agentic_gradient_phase for the linear phase, still applies post-stretch; feedback_cost_visibility → split); create feedback_early_abort_live_gates.md (indexed) carrying the still-unmet items: early abort on repeated hard-gate failure, stream finish-gate/critic lines to the console (engine-max currently buffers stdout until close — tee MCP stderr gate lines).

**Acceptance:**

npm test: recallForBrief on a galaxy_spiral fixture brief yields lines starting with '[STRONG]'/'[TYPE prior'/'[WEAK target-only' and the universal section ≤ (feedback-tagged + 20) lines; feedback-tagged entries survive deduplicate/cap. Manual: MEMORY.md has no contradictory live pair (grep for 'skip LRGB' and 'NEVER skip L' both indexed).

### WI-21 (P2) compare_to_reference rework: subject-aware chroma EMD, saturation-weighted palette distance, downsampled MS-SSIM, advisory-first thresholds

**Files:** agents/ops/subject-metrics.mjs, agents/llm/tools.mjs, agents/processing-profiles.json, AGENTIC_PIPELINE_REVIEW.md

**Depends on:** WI-01

**Spec:**

In subject-metrics.mjs compareToReference: (A) MS-SSIM: when aspect ratios match within 1%, Resample BOTH a duplicate of the target and the reference to a common width ~1500 px (MitchellNetravali, as aesthetic-critic.mjs does), compute MS-SSIM there, close both temps in finally (replaces the full-res img.sample() loop and the two-extra-full-res-window risk); if aspect differs, skip SSIM and rely on a geometry-free 9-bin subject-luminance CDF distance. (B) Replace the residual-then-Lab 'color_emd' (which is ≈0 by construction and pairs unrelated cells by index): bg_cast_delta = ΔE(a*b* only) between the two images' dark-cell median RGB triplets converted to Lab directly. (C) palette_l1: ignore subject pixels with HSV saturation <0.08 (or weight by saturation); report the saturated-subject fraction. (D) lab_emd: sample ≤50k subject pixels per image (same k=4σ threshold as measurePaletteBalance), subtract each image's own dark-cell bg median in RGB before Lab, histogram a*b* on a 24×24 grid over [-60,60], sliced-Wasserstein with 8 fixed projection angles; document as chroma-only (L* excluded so a differently-stretched user PNG does not dominate). (E) Gate 12: keep the existing block on the OLD color_emd field for one release only if WI-01 harness shows it has ever discriminated (it has not — it is inert); ship palette_l1 >0.35 / lab_emd >12 as WARNINGS, store per-category values in processing-profiles.json `reference` block, and promote to blocking only after: pacman_lift5 vs itself ≈0, pacman_lift5 vs pacman_iter01 exceeds thresholds, ngc7023_best_of_both vs ngc7023_iter03 passes. (F) Fix the tool description (tools.mjs:69) and AGENTIC_PIPELINE_REVIEW.md:105/145 (they describe a histogram-matched EMD that does not exist). Mention compare_to_reference in the prompt ranking step (WI-09 F).

**Acceptance:**

node --check; unit test of the sliced-Wasserstein helper on two synthetic a*b* clouds (identical → 0; shifted by 20 → ≈20). [PI REQUIRED] the three calibration comparisons above produce the expected ordering; peak PI window count during compare_to_reference ≤ baseline+2 and returns to baseline after.

### WI-22 (P2) Gradient sub-agent fixes: correct fieldCharacteristics path + dust classes, SCNR excluded per-agent, ABE descriptions and defaults, prompt-version cache salt, captured result contract

**Files:** agents/llm/prompts/gradient-agent.mjs, agents/llm/tools.mjs, agents/llm/warmstart.mjs, agents/llm/giga-run.mjs, agents/target-taxonomy.json, agents/classifier.mjs

**Depends on:** WI-09

**Spec:**

1) gradient-agent.mjs:33 → `const fc = brief?.target?.fieldCharacteristics || {}; const hasFaint = !!fc.hasIFN || !!fc.hasDust || isGalaxy || /reflection|dark_nebula|mixed_field/.test(cls) || !!brief?.processingProfile?.ifn;` (fc.hasDust from WI-09 C taxonomy change); reword the FAINT SIGNAL PROTECTION header to 'faint IFN / dust / extended halos'; when hasFaint cap run_per_channel_abe escalation at poly_degree 2 and require measure_subject_detail + preview before keeping any per-channel pass. Optionally add 'LDN15':'dark_nebula' to KNOWN_OBJECTS.

2) tools.mjs: `const AGENT_TOOL_EXCLUDES = { gradient_agent: new Set(['run_scnr']) }` honoured in buildToolSet (keep run_scnr in 'gradient' for giga); prompt :75 → 'SCNR is intentionally unavailable to you: global green is SPCC's job in the next phase.' run_per_channel_abe description → 'Works on linear or non-linear RGB. The gradient agent uses it on LINEAR data pre-SPCC with poly_degree 1-2; on stretched data it fixes colour-specific gradients after curves. poly_degree 1 is safest.' (drop 'must be stretched/non-linear' from view_id); run_abe description → 'poly_degree 1-2 gentle (linear data, galaxies, IFN/dust fields), 3-4 only on stretched nebula data with no faint extended signal'; handler default `input.poly_degree ?? (agentName==='gradient_agent' ? 2 : 4)`.

3) warmstart.mjs: salt gradientHash with `GRADIENT_PROMPT_VERSION` exported from gradient-agent.mjs (bump to 2) — otherwise the 3 cached snapshots replay the old-prompt result.

4) Stop contract: WHEN DONE requires a fixed block `GRADIENT RESULT: rgb <before>→<after> | l <before>→<after> | tool=<name> poly_degree=<n> | subject_detail=held|dropped`; giga-run.mjs:260 captures `const gradResult = await gradAgent.run(gradInitial)` and persists gradResult.transcript text to <run>/gradient-result.md and the run_meta trace.

5) Reconcile docs: giga-orchestrator.mjs:818 scope the prohibition to 'post-stretch on the composition — linear per-channel correction was already done by the gradient agent'; SKILL.md:184 describes both phases; add a 'Superseded 2026-06-07 by project_agentic_gradient_phase for the linear phase' note inside feedback_gradient_strategy.md.

**Acceptance:**

npm test: render buildGradientAgentPrompt for all configs — NGC7023 and LDN15 contain 'FAINT SIGNAL PROTECTION'; buildToolSet('gradient_agent') excludes run_scnr and includes run_abe/run_per_channel_abe; gradientHash differs after bumping GRADIENT_PROMPT_VERSION. [PI REQUIRED] one gradient run on cached NGC7023 prep-A: trace shows no run_scnr and poly_degree ≤2; measure_subject_detail held.

### WI-23 (P2) Prep: profile-driven BXT sharpen and Seti HDR params, applied-recipe provenance in the initial message, remove the stale Phase-1 recipe claims

**Files:** agents/llm/deterministic-prep.mjs, agents/processing-profiles.json, agents/llm/giga-run.mjs, agents/llm/prompts/giga-orchestrator.mjs

**Depends on:** WI-09

**Spec:**

1) deterministic-prep.mjs: read `brief.processingProfile.tools.BXT` once (next to the NXT read ~:277) → {correct_only, sharpen_nonstellar}; wrap the three sharpen blocks (:752-759, :827-833, :947-952) in `if (bxt.correct_only === false)` interpolating sharpen_nonstellar (fallback 0.70). setiStretch hdrAmount/hdrKnee from profileStretch.hdr_amount ?? 0.25 / hdr_knee ?? 0.35 at :779/:851/:967.

2) processing-profiles.json: to keep every current baseline byte-identical (NGC7023 milestone, NGC891, M27 champions were all produced with sharpen 0.70), set ALL 13 classes to `BXT: {use:true, correct_only:false, sharpen_nonstellar:0.70}` and `stretch.hdr_amount:0.25, hdr_knee:0.35`; do NOT ship lower per-class values (0.30 reflection etc.) in the same change — each must be back-tested against the approved image. Note in each profile `_bxt_calibration:'0.70 = baseline all approved images were produced with; PSF study 2026-10-28 found correct-only most faithful — candidate for per-class reduction after harness'.

3) Provenance: push {step, view, params} into result.applied for every BXT/NXT/SPCC/SCNR/SXT/SetiStretch call (mirror narrowband-prep.mjs:183) and print it in giga-run.mjs initialText as '### Prep recipe already applied (do not repeat)'; giga-orchestrator.mjs (after WI-09 B) adds one line: 'BXT sharpen was already applied at the profile value — run_bxt with correct_only=false is a double-sharpen; only use it after restoring a pre-prep variant.'

4) Do NOT touch computeCacheKey (phase-1 cache stops before BXT and already hashes the script file).

**Acceptance:**

node --check; unit test: with a profile BXT {correct_only:true} the generated PJSR for the sharpen step is skipped; with the shipped profiles the PJSR strings are identical to today's (snapshot). giga-run dry run prints the 'Prep recipe already applied' block. [PI REQUIRED] re-run cached NGC7023 prep: prep-B output stats identical to the previous run (same sharpen 0.70).

### WI-25 (P2) Observability + legacy archive: per-agent trace fields, monotonic seq, per-agent cost table, run-summary.json with status, manifest finalize/fail, archive engine.mjs/orchestrator.mjs/8 prompts, drop 3 SDK deps

**Files:** agents/llm/mcp-agent-tools.mjs, agents/llm/engine-max.mjs, agents/llm/trace-analyzer.mjs, agents/llm/trace-mermaid.mjs, agents/llm/giga-run.mjs, agents/llm/aesthetic-critic.mjs, agents/artifact-store.mjs, agents/legacy/llm/, package.json, README.md, AGENTIC_PIPELINE_REVIEW.md, .claude/settings.local.json

**Depends on:** WI-07a, WI-07b, WI-08

**Spec:**

1) mcp-agent-tools.mjs: traceEntry += {agent: agentName, pid: process.pid, model: process.argv[6]||null, state: stateMachine.state} (traceSeq initialised from the existing trace.jsonl line count — WI-07b — so seq stays a monotonic number). trace-analyzer.mjs: normalise agent/state/model/pid (default agent 'giga_orchestrator' for old traces), `analyzeTrace(tracePath,{agent})` defaulting to giga so branch detection ignores gradient-agent clones, add perAgent {name:{calls,totalMs,errors,blocked}}; trace-mermaid prints the perAgent table.

2) giga-run.mjs: collect agentRuns[] = {name, model, actualModels, turns, elapsedMs, usage, timedOut, maxTurnsHit} from the three run() results; aesthetic-critic.mjs exports getCritiqueUsage() (parse .usage from the judge's JSON). Extract trace-artifact generation (:583-609) + run-summary.json {status: finished|recovered|no_final_selection|crashed|timed_out|max_turns, exportSource, agentRuns, critic:{calls,usage}, gateFailCount, elapsedMs} into writeRunArtifacts(status) and call it explicitly before every exit path (process.exit(77), no-final-selection, happy path — a finally block does not run after process.exit). Happy path calls store.finalize(variant_id); crash path store.fail(reason). Replace the giga-only token line with the per-agent table.

3) Legacy archive: move agents/llm/engine.mjs, agents/llm/orchestrator.mjs and prompts/{readiness,rgb-cleanliness,star-policy,ha-integration,luminance-detail,composition,technical-critic,aesthetic-critic}.mjs to agents/legacy/llm/ (fix their relative imports); leave the root agents/orchestrator.mjs alone (that is the file AGENTIC_PIPELINE_REVIEW.md:19 flags); keep vision.mjs intact (jpegToContentBlock is live in save_preview). Remove @anthropic-ai/sdk, @google/generative-ai, @mistralai/mistralai from package.json and `npm install`; `grep -rn "@anthropic-ai/sdk\|@google/generative-ai\|@mistralai" agents scripts src editor` → 0 hits outside agents/legacy. engine-max.mjs: replace _parseFinishResult (:251-369; its <<FINISH_VIEW_ID>> marker no longer exists) with a stub returning null; mcp-agent-tools.mjs:26 default agent 'giga_orchestrator'. Update .claude/settings.local.json:68 permission string, README.md project structure, AGENTIC_PIPELINE_REVIEW.md note ('API-provider engine archived; per-agent model via MaxAgent --model only').

**Acceptance:**

node --check on all; `npm test` still passes; `node agents/llm/giga-run.mjs --dry-run` works after the archive; run-summary.json is written on a simulated crash exit (unit: call writeRunArtifacts('crashed') on a temp store) and manifest.status becomes 'crashed'; trace.jsonl entries of a dry MCP call include agent/state/pid; `npm ls` shows the three SDKs removed.

### WI-26 (P2) New advisory metrics: background banding/corner check at finish, chroma-noise/mottle metric, deterministic highlight-texture baseline, field-dependent PSF map

**Files:** agents/ops/stats.mjs, agents/ops/subject-metrics.mjs, agents/ops/quality-gates.mjs, agents/llm/tools.mjs, agents/llm/deterministic-prep.mjs, agents/llm/narrowband-prep.mjs, agents/processing-profiles.json, agents/llm/prompts/giga-orchestrator.mjs

**Depends on:** WI-01, WI-15

**Spec:**

All ADVISORY (warnings only) until the harness sets thresholds; none may open a persistent window.

A) Banding (metrics-10): stats.mjs measureColorGradient additionally computes per-column and per-row MEAN chroma (R−L, G−L, B−L) over background cells, fits a least-squares line per axis and reports band={axis,index,amp,channel} with amp = max |residual from the fit| and stepMax = max adjacent jump (a ramp is a gradient, a band is a localized step; NOT bounded by the peak-to-peak score); require ≥12 bg cells else insufficientBg; expose cornerLumDelta/cornerChroma reusing measureUniformity's 4-corner medians. Finish Gate 13 after Gate 3d: profile top-level `gradient:{warn:0.012, block:0.020, band_block:null, min_bg_cells:12, blocking:false}`; always warnings unless blocking:true. Calibration: run on ngc7023_best_of_both (has the user-seen green band at left — must register band.amp > score-based signal) and ngc7023_iter03 (clean). Hint text: 'band at column N: apply_mask with an inverted outer-field mask then run_per_channel_abe poly_degree=1 on the final, OR redo the last lift_dust/inject_l_ifn with a gentler taper; do NOT re-run the linear gradient stage'. Add an explicit mask_view_id to runPerChannelABE (gradient.mjs:73) since ABE does not honour an applied mask reliably. Expose the band/corner fields in measure_color_gradient so Phase 7.5 can use it instead of luminance-only measure_uniformity.

B) Chroma noise (metrics-11): subject-metrics.mjs measureChromaNoise(ctx, viewId): same 6×6 patch grid / darkest-12 clean / next-12 dust band as measureBackgroundNoise; per point Ca=R−L, Cb=B−L; chromaNoise = 1.4826·MAD of (C − mean of 4 dist-2 neighbours) pooled over Ca,Cb; mottle16/mottle48 = 1.4826·MAD of (box mean − mean of 4 adjacent box means) at 16 px and 48 px boxes (no σ²/64 white-noise correction — noise is correlated after NXT). Report {chromaNoise, chromaToLumNoise, mottle16, mottle48, clean/dust bands}. Tool measure_chroma_noise (measurement, public) with remedy text ('chroma_smooth sigma 6-8 through the halo/dust mask, or reduce lift/inject strength upstream; never global desaturation'). Finish: warnings next to Gate 3d; profile `noise:{max_chroma_to_lum:null, max_mottle48:null}`; narrowband gets its own ceiling. Calibration: pacman_lift5 and ngc7023_best_of_both + one over-lifted variant (re-run lift_faint_halo with in1 doubled / inject_l_ifn weight 0.4 on cached prep) → set ceiling at the midpoint only if both approved images are clearly below.

C) Highlight-texture baseline (metrics-14): at the end of deterministic prep (after setiStretch on the SXT-starless RGB) and narrowband prep, run locateSubjectROI once and measureShellTexture (export from quality-gates.mjs with opts.roi) on RGB, L, Ha; store brief._baselineTexture and brief._roi (never set today — also fixes tools.mjs:3892/3941/3972 readers) and write baseline-texture.json in the run dir. In star_protected_blend/star_screen_blend measure the starless input and stash brief._preBlendTexture. checkHighlightTexture accepts opts.referenceMetrics/currentMetrics; finish uses the pre-blend measurement when its outputId matches, else measures the finish view with the stored ROI; delete the notes-regex + ImageWindow.open block (tools.mjs:2710-2730). Read profile highlight_texture.min_retention/warn_retention (currently dead config, defaults 0.40/0.60); warn-first. Calibration positives: pacman_lift5 and ngc7023_best_of_both must pass; negative pending the next NGC7635 run.

D) PSF field map (tools-psf-field-map): port /Volumes/Extension/PACMAN/output/claude/psf_study/psfmap.js (2× IntegerResample-binned peak scan + full-res moments, validated) into quality-gates.mjs measurePsfField(ctx, viewId, {cols=8, rows=6, maxStars=1500, satLimit=0.45}); per cell {n, fwhm_med, ellipticity_med, orient_vs_radial_deg, radial_skew}; global best/worst cell, center fwhm, L/R and T/B asymmetry ratios, verdict 'uniform'|'radial coma'|'asymmetric — check tilt/backfocus' (ratio ≥1.5), and crop_box = largest axis-aligned rectangle of contiguous cells with fwhm ≤1.5× best and ellipticity ≤0.3 (user wants a crop BOX, never a crop of the starless deliverable). Close the binned temp in finally. Tool measure_psf_field (measurement, read-only); cache in brief._psf[viewId]. Hook in prep on LINEAR data: narrowband-prep once before and once after the BXT correct-only pass (~:179, before SXT) and the same in deterministic-prep; add crop_box + verdict to the prep summary. Not a finish gate.

**Acceptance:**

node --check; unit tests on the pure-JS parts (line fit/residual band index on synthetic column means: a ramp → amp≈0, a step → amp≈step; sliced MAD helpers; crop_box selection on a synthetic 8×6 grid). [PI REQUIRED] (A) band.amp on ngc7023_best_of_both > on ngc7023_iter03; (B) measure_chroma_noise on a synthetic grey window ≈0 and on pacman_lift5 reports values with no exception; (C) baseline-texture.json written by a cached NGC7023 prep run and finish no longer opens a variant XISF (window count unchanged during finish); (D) measure_psf_field on the PACMAN Ha master reproduces the study's L/R asymmetry (right edge ≈2× left) and returns a crop_box.

### WI-27 (P2) Core specialist: end-state contract in the system prompt, deterministic candidate selection in the post-pass, quality_gate tools available

**Files:** agents/llm/prompts/core-specialist.mjs, agents/llm/giga-run.mjs, agents/llm/tools.mjs, /Users/aescaffre/.claude/projects/-Users-aescaffre-pixinsight-mcp/memory/project_ctier_plan.md

**Depends on:** WI-07a, WI-17

**Spec:**

1) giga-run.mjs post-pass (~485-487): after coreAgent.run resolve the output deterministically: candidates = store.listVariants('core_specialist') xisfPaths + the live CORE_WORK saved to specPath; run measureCoreContrast on each (sequentially, close after) and pick the one maximising the judgeAB win condition vs the mega baseline (struct ≥ base+0.01 OR relC ≥ base+0.02, AND halo ≤ base+0.005, AND check_core_contrast still passes); fallback CORE_WORK then mega winner on error. 2) core-specialist.mjs: add 'END-STATE CONTRACT' to the system prompt: 'CORE_WORK must hold your best result (restore_from_clone into it if a bracket was better); also save_variant it with note core_spec struct=.. halo=.. relC=..'; replace the stale absolute targets at :57 (struct>0.80 / halo<0.03 — removed from profiles in f3a5a44) with the judge's RELATIVE criteria read from the baseline check_core_contrast; 'stop after at most 3 brackets or as soon as a bracket wins and the next is not better; do not chase relC on galaxies (soft bulge is correct)'. 3) tools.mjs:4009 AGENT_TOOL_CATEGORIES.core_specialist += 'quality_gate' (check_ringing, scan_burnt_regions, check_highlight_texture, check_core_burning-replacement); mention check_ringing and scan_burnt_regions by name where ringing is mentioned in the prompt. 4) Note in project_ctier_plan.md that the contract + fallback landed and that the C-tier A/B is unblocked by WI-07a's best-variant fallback.

**Acceptance:**

node --check; unit test: selection helper with three synthetic core metric objects picks the judgeAB winner and falls back correctly; buildToolSet('core_specialist') includes check_ringing and scan_burnt_regions. [PI REQUIRED] `--core-specialist` post-pass on a run dir with core_specialist variants selects a candidate and the composer A/B runs (judgeAB verdict written).


## 9. Verified findings (survivors)

- **models-01** [P1] PixInsight crash detection in engine-max is dead code; no resume path after a PI crash
- **models-02** [P1] Turn budgets (250/50/50) are never enforced anywhere — only the 2 h SIGTERM stops a churning agent
- **models-03** [P1] No explicit model/effort per agent — all three agents inherit the user's interactive CLI default ('fable'), and the model used is never recorded
- **models-04** [P1] Startup diagnostic previews are rendered but never handed to the agent; the initial message falsely says they are attached
- **models-05** [P2] giga_orchestrator silently gets ALL 92 tools (incl. prep/readiness tools the prompt forbids) — the creativeCategories filter in giga-run is dead
- **models-06** [P2] Aesthetic-critic subprocess loads the project's astroaro MCP server on every judge call and has no turn cap; a second divergent critic prompt lingers
- **models-07** [P2] engine.mjs (gemini/mistral/anthropic API) and the multi-agent orchestrator path are dead code carrying three unused npm dependencies and eight legacy prompts
- **models-08** [P2] Engine hygiene: silent 2 h timeout, open stdin (3 s stall per spawn), 40 KB argv system prompt, unvalidated options
- **prompts-ifn-branch-skipped-for-reflection** [P1] Branch B says "Skip this branch" for reflection/dust targets while the finish IFN gate demands dust lift
- **prompts-galaxy-color-contradicts-natural** [P0] Branch C / Phase 7 push VIVID, S-midpoint 0.65-0.85 on galaxies, violating the user's natural-over-synthetic rule and the prompt's own gate text
- **prompts-phase-plan-contradicts-state-machine** [P1] Prompt phase/tool plan contradicts the enforced runtime state machine (IFN tools, NXT/SCNR, HDRMT, run_abe, save_memory blocked where the prompt says to use them)
- **prompts-star-directives-contradict-and-stretched-label** [P1] Three contradictory star directives in one prompt, and the initial message labels the LINEAR star layer "(stretched)"
- **prompts-dead-phase1-and-run-history-bloat** [P2] Dead Phase-1 step list, baked-in per-run history and duplicate numbering inflate the prompt to 37-42K chars
- **prompts-narrowband-stale-broadband-text** [P1] SHO/HOO mode claims to override later sections but the broadband sections still render (SPCC, Ha injection, Branch D for starless, COMP_boldIFN)
- **prompts-pne-global-hdrmt-contradiction** [P2] PNe composition mandates GLOBAL unmasked HDRMT while profile, memory and the prompt's own rules require masked/zone HDRMT
- **prompts-lrgb-block-contradicts-injection-rule** [P1] 'LRGB COMBINE IS NOT OPTIONAL' block forbids the PixelMath L-injection route the memory and finish gate accept, and collides with the PNe section
- **prompts-gate-numbers-disagree-with-code** [P2] Hand-typed gate thresholds in the prompt disagree with the finish/quality-gate code
- **prompts-aesthetic-critic-target-blind** [P1] The blocking vision critic rubric has no target/workflow context and penalises starless deliverables and muted galaxies by design
- **prompts-gradient-agent-wrong-brief-path-and-false-scnr-claim** [P2] Gradient agent reads brief.fieldContext (does not exist) so faint-signal protection never renders for reflection/dark fields; it also claims it has no SCNR while run_scnr is in its tool set and its ABE tool description says 'NON-LINEAR data'
- **prompts-visual-overrides-metrics-contradicts-user** [P1] Phase 6/7 tell the agent its eyes override metrics and to pick what it 'FEELs', contradicting the user's visual-judgment feedback; compare_to_reference / critic(composition_critic) are never mentioned
- **prompts-core-specialist-output-contract-split** [P2] Core specialist's stop criteria reference metrics the judge no longer gates, its output contract lives only in the initial message, and it lacks the quality_gate tools it is told to watch
- **metrics-01** [P0] No gate back-test harness or approved-image registry; most thresholds hard-coded and never calibrated
- **metrics-02** [P1] Aesthetic critic Gate 11 blocks at 6.0 against explicit user guidance; single class-agnostic judge on a 1500 px downsample
- **metrics-03** [P1] Galaxy saturation gate permits the 'synthetic' look the user rejected (max_p90 0.75 -> blocks only above 0.85 vs approved P90 ~0.37)
- **metrics-04** [P1] Core relContrast hard gate (0.22 default / 0.35 reflection) blocks finishing on approved-quality cores; never back-tested on galaxies
- **metrics-05** [P1] finish rejections never trigger repair policies and return unstructured text with a misleading footer
- **metrics-06** [P1] Star gate is blind to severe bloat, couples star prominence to background level, counts nebula knots as stars, and reports three different FWHM limits
- **metrics-08** [P1] detailScore samples the first 50 raster-order blocks, is SNR-blind (noise counts as detail), and has no cap on detail gain — 'cooked' passes
- **metrics-09** [P1] compare_to_reference color metric ignores the subject (background-only ΔE mislabelled as EMD); SSIM requires identical geometry
- **metrics-10** [P2] No gradient/banding/corner check on the final image; measureColorGradient only runs on linear data in the gradient sub-agent
- **metrics-11** [P2] No chroma-noise / mottle metric although prompts ask the agent to 'verify at 1:1 that revealed structure is real'
- **metrics-12** [P2] IFN champion ignores the dust metric: champDust is collected at finish but never passed to scoreVariantDimensions
- **metrics-13** [P2] Redundant and mutually inconsistent burn/ringing/channel checks and a dead scoring layer still exposed to the agent
- **metrics-14** [P2] Highlight-texture gate is inert at finish unless a variant note matches a regex, and it opens a full-res XISF on a memory-constrained machine
- **tools-state-blocks-ifn-dust-tools** [P1] IFN/dust and noise/color-gradient tools are whitelisted only in finalize, so they are blocked during candidate generation and compose
- **tools-rejected-finish-enters-finalize** [P1] A REJECTED finish still transitions compose→finalize, where the remedies the gate messages prescribe are blocked
- **tools-pjsr-errors-swallowed** [P1] 31 tool handlers ignore ctx.pjsr() status, so PixInsight script errors are reported to the agent as success with unchanged stats
- **tools-giga-served-all-92-incl-dead-tools** [P2] giga_orchestrator has no AGENT_TOOL_CATEGORIES entry, so the MCP server serves all 92 tools including always-blocked, deprecated and no-op ones
- **tools-no-preflight-gate-battery** [P1] No single tool runs the finish gate battery without committing; agents fire 50+ separate gate calls per run and must call finish (with its state side-effect) to learn the real verdict
- **tools-no-1to1-crop-preview** [P2] save_and_show_preview can only render a ≤2048 px downsample of the whole frame; the prompt and tool descriptions demand 1:1 inspection that no tool can produce
- **tools-missing-inject-luminance-tool** [P1] No dedicated luminance-injection tool although memory mandates the PixelMath L-injection path when L/RGB median ratio > 2×; Gate 10 detects it by a fragile regex on 'FILTER_L'
- **tools-mask-ops-missing** [P1] Mask tools cannot invert, dilate/erode or range-clip, yet lift_dust/inject_l_ifn/blend_regions consume raw mask views and ask for inverted, dilated masks
- **tools-missing-post-op-metrics** [P2] Several processing tools return no (or the wrong) after-op information for the dimension they change
- **tools-psf-field-map-missing** [P2] No tool measures the field-dependent PSF/aberration the user asked to study; check_star_quality reports a single median FWHM
- **tools-variant-load-and-window-pressure** [P1] load_variant needs a full artifact id while save_variant returns a short id, and in-PI clones are the only checkpoint — both push the open-window count that has crashed PI
- **architecture-crash-swallowed-state-reset-variant-overwrite** [P1] PI crash is swallowed as a tool error, MCP restart resets state machine + variant counter (variants silently overwritten), and there is no resume
- **architecture-rejected-finish-enters-finalize-and-turn-budget-unenforced** [P1] A REJECTED finish still transitions to `finalize` (repair can never engage, key tools get blocked) and the 250-turn budget is never enforced — the never-finishing 270-turn runs follow from this
- **architecture-state-allowlist-silently-blocks-new-tools** [P1] Per-state tool allowlists are hand-maintained name sets: every new tool lands in a single state (or none) and gets blocked elsewhere — IFN tools, check_noise, measure_color_gradient, save_memory, finish-reachability in touch-up mode
- **architecture-ledger-signature-prunes-mandatory-branches** [P1] Ledger approach signatures are built from free-text notes and count every saved bracket variant as a competitive attempt — it now PRUNES `detail:on` while the prompt and branch-completeness REQUIRE detail variants
- **architecture-dead-learning-paths** [P2] 'Winning parameters' injection and processing-profile learning are dead code paths: they read legacy memory files last written 2026-03-27, need manifest.agents (empty in giga flow), and write learned_overrides that nothing reads
- **architecture-repair-policies-never-engage** [P1] Repair policies (the codified 'fix upstream' rule) are effectively dead: finish failures never trigger them, policy 5 cannot match, repair has no success exit and blocks finish for 15 turns
- **architecture-prep-ignores-profile-bxt-and-hides-recipe** [P1] Deterministic prep sharpens every class with BXT nonstellar=0.70 although every profile says BXT correct_only:true, hardcodes Seti HDR params, and never tells the agent what prep already applied
- **architecture-model-per-agent-unset** [P2] No model is chosen per agent: giga_orchestrator, gradient_agent and core_specialist inherit the CLI default while only the critic pins opus
- **architecture-observability-gaps** [P2] Trace entries carry no agent/state/model, three agents append to one trace.jsonl, token cost covers only the giga agent, manifest never records completion, and trace artifacts are skipped on crash
- **narrowband-state-machine-no-compose-path** [P1] Starless SHO run can never enter compose: finish is blocked and blocked calls burn no budget
- **narrowband-aesthetic-critic-gate-unvalidated** [P0] Finish Gate 11 (opus critic, blocking) judges a starless false-color palette on a natural-vs-cooked / stars rubric with no context and was never back-tested on the approved PACMAN image
- **narrowband-hoo-path-broken** [P2] HOO workflow: palette tools default to SII and foraxx, the prompt brackets S-requiring palettes, and Gate 1b applies Hubble thresholds
- **narrowband-ledger-and-profile-keyed-by-class-only** [P2] Cross-run ledger, champions, learned_overrides and winning-param recall share the `emission_nebula` key between SHO palettes and broadband HaLRGB runs
- **narrowband-prompt-broadband-residue** [P1] Orchestrator prompt and hard-constraint config still push stars, SPCC, pseudo-OIII-from-B, LRGB and ABE on an SHO target despite the narrowband header
- **narrowband-prep-no-cache-no-warmstart** [P1] Narrowband prep bypasses the prep cache and --base-run warm-start drops FILTER_Ha/S/O and the narrowband metadata
- **narrowband-finish-gate-messages-assume-rgb** [P2] Finish gate wording and post-pass star warning mislead the agent on starless palettes
- **narrowband-memory-recall-pollution-and-empty-seed** [P2] recall_memory injects broadband state-machine hacks and holds no SHO knowledge; the validated PACMAN recipe is not in memory
- **narrowband-prep-hardcodes-creative-choices** [P2] Narrowband prep bakes per-channel denoise, stretch, hue-shift and gradient decisions the agent cannot bracket or revert
- **feedback_alignment-galaxy-natural-look-not-encoded** [P0] Natural-over-synthetic for galaxies is enforced nowhere; prompt + profile + memory all push the rejected 'vivid' recipe
- **feedback_alignment-star-layer-mislabelled-stretched** [P2] Initial agent message says the star layer is '(stretched)' while prep delivers it LINEAR — the exact M27 skip-stretch failure
- **feedback_alignment-prompt-eyes-override-metrics** [P1] Prompt tells the agent its visual judgment overrides metrics and to pick what it 'FEELs' — contradicts the visual-judgment feedback
- **feedback_alignment-gate11-blocking-without-calibration-or-taste** [P1] Vision aesthetic Gate 11 blocks at 6.0 with a 'cooked is penalized' rubric and no class taste — feedback says keep advisory until calibrated
- **feedback_alignment-lrgb-mismatch-rule-contradicted-and-gate10-trivial** [P1] Prompt forbids skipping lrgb_combine for large L/RGB mismatch (contradicting the >2× PixelMath rule) and Gate 10's L-usage check is a trivial string match
- **feedback_alignment-galaxy-star-prominence-contradiction** [P1] Galaxy stars are hard-capped 'subdued'/0.85 while the user asked for MORE prominent galaxy stars and the prompt also says 'do NOT go below 0.90'
- **feedback_alignment-star-protected-blend-defaults-not-raised** [P1] star_protected_blend defaults (0.60 / 0.82 / 0.10) never received the raise the PNe feedback records (0.70 / 0.30), and are not profile-driven
- **feedback_alignment-memory-all-universal-recipes** [P1] All 71 hierarchical memory entries are level 'universal' (incl. M81 recipes) and are injected into every run as universal rules; learned-override regex pollutes profiles
- **feedback_alignment-gradient-agent-ifn-guard-wrong-path** [P1] Gradient agent reads brief.fieldContext.hasIFN (does not exist) so faint-IFN protection never activates for reflection/dark targets like NGC7023; per-channel guidance contradicts feedback and the main prompt
- **feedback_alignment-giga-run-no-old-run-cleanup** [P1] giga-run.mjs has no old-run auto-cleanup (only the legacy orchestrator does) although disk-full is the documented cause of PI OOM crashes
- **feedback_alignment-stale-target-history-in-generic-prompt** [P2] Generic giga prompt carries target-specific run anecdotes and a dead 'already done' Phase-1 procedure with values that contradict prep
- **feedback_alignment-silent-class-overrides-not-profile-driven** [P2] Class-based parameter overrides and tool blocks are hardcoded on classification strings and applied silently (stderr only), against agentic-first
- **feedback_alignment-stale-or-contradictory-feedback-index** [P2] Several memory feedback rules are stale or contradict each other / the code; MEMORY.md still lists them as live rules

## 10. Refuted

- **metrics-07** 0.80 bright-block fraction gate counts star pixels, forcing the star rolloff that kills star color and prominence
