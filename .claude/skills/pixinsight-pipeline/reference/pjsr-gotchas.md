# PJSR Gotchas & Constraints

## PJSR runtime: V8 only (2026-10-29)
**Root cause of the 2026-10-28/29 crash series (10 PixInsight aborts, identical report: `EXC_BAD_ACCESS/SIGABRT`, fault `0xfff2000000000000`, stack `libmozjs-24.dylib FinalizeArenas -> _sigtramp -> __cxa_throw -> terminate`):** that stack is the garbage collector of the LEGACY SpiderMonkey 24 runtime. Since PI 1.9.4 PJSR runs on V8, but a script with no `#engine` directive still runs on the legacy engine (`#engine sm` default), which on macOS ARM64 is an obsolete interpreter-only build scheduled for removal (shipped docs: `/Applications/PixInsight/doc/docs/PJSR/PJSR.html`, sections 2.2 and 9). Our watcher had no directive, so EVERY bridge command ran on the legacy engine and any collection (explicit `gc()` or automatic) could abort PI. The earlier rules ("never gc()", warm-up, stride pixel loops) treated symptoms.

**Fix (pjsr/pixinsight-mcp-watcher.js, version `0.2.0-v8`):**
- Line 1 is `#engine v8`, then `CoreApplication.ensureMinimumVersion(1, 9, 5)`. Never add `#engine sm` anywhere; never remove the directive. The console banner must show `Engine: V8 <version> (JS 2025)` and `~/.pixinsight-mcp/bridge/watcher-state.json` reports `engine: "v8"` + `v8Version`. Launch procedure is unchanged (Script Editor, same file). The old file is kept as `pjsr/pixinsight-mcp-watcher-sm-legacy.js` for reference only.
- Compat layer for command code sent from Node (ES5-style snippets keep working):
  - `v8CompatCode()` rewrites `/\b([A-Z]\w*)\.prototype\.([A-Z]\w*)/g` -> `$1.$2` before `eval`, because V8 moved process constants from `Process.prototype.X` to `Process.X` (116 such uses in agents/ and scripts/ keep working through this shim; new code should write `Process.CONST`).
  - Deprecated globals `processEvents`, `msleep`, `sleep`, `gc` are shadowed on `globalThis` by silent shims (`CoreApplication.processEvents()`, `System.msleep()`, `System.sleep()`, `gc` = no-op) so scripts do not spam deprecation warnings.
  - `searchDirectory(...)` -> `File.searchDirectory(...)`.
- Legacy `.jsh` includes were removed. The AdP ImageSolver include chain is now OPTIONAL behind `// #define MCP_WITH_SOLVER`: that chain requires `SETTINGS_MODULE` (and `SOLVER_SETTINGS_MODULE`) to be `#define`d BEFORE the includes, otherwise the watcher fails to compile (that was the compile error seen when first porting). Plate solving via the bridge is therefore off by default; `run_plate_solve` still uses the wrong executeOn API (follow-up).

**Verified live under V8 (2026-10-29):** smoke test (open 24 MP, stats, PixelMath with `.prototype.` constants, selectedRect block medians, `console.beginLog/endLog`, clone/close; `measureSubjectDetail` 509 ms vs ~1000 ms before) and the full gate back-test (`scripts/backtest-gates.mjs` on pacman_lift5 60 MP + ngc7023_best_of_both + ngc4490_giga_rejected) in ONE session, exit 0, no crash. That exact battery killed PI repeatedly on the legacy engine.

**V8 breaking-changes checklist for new PJSR code (from the shipped docs):**
- `gc()` is a deprecated no-op (shimmed).
- `Process.prototype.CONST` -> `Process.CONST` (rewritten by the watcher; write the new form).
- `.jsh` header constants are enum statics now (`UndoFlag.NoSwapFile`, etc.).
- `VectorGraphics` removed. `ImageStatistics` removed: use `Image.median()`, `Image.MAD()`, `Image.stdDev()`, etc.
- `Image.forEachSample` / `Image.forEachPixel` removed: use `ImageIterator`.
- `ImageWindow.purge()` takes no boolean arguments.
- `View.viewById()` / `ImageWindow.previewById()` return `null` when missing; `View.window` / `View.image` are `null` for invalid views; `View.properties` is an empty array. (`ImageWindow.windowById()` still returns an object: check `.isNull`, see below.)
- `FileFormatInstance.open()` returns `[]` when no image.
- Constructor-function inheritance (`__base__`, prototype assignment) does not work: use ES classes (allowed inside the watcher file; command snippets stay ES5-style by convention, which V8 runs fine).
- Deprecated globals still work with warnings: `processEvents`, `msleep`, `sleep`, `coreVersion*`, `jsArguments`, `searchDirectory`, `getEnvironmentVariable`, `cpuId`, `physicalMemoryStatus`. Replacements live in `CoreApplication`, `System`, `File`, `Runtime`.
- `Math` statistical extensions (`Math.median` etc.) -> `Stat`.
- `Compression` / `Ephemeris` return shapes changed.

**Status of the older crash sections below** ("PixInsight 1.9.5 crash signature", "CAUGHT: explicit gc()", "Bisect result", memory rules about warm-up and stride): HISTORICAL. They describe the legacy-engine behaviour. Under V8 automatic GC is no longer dangerous and `gc()` is a no-op. Still keep JS pixel loops light (stride/bin, PI processes for heavy work) for SPEED, not for survival, and keep `w.purge()` + `processEvents()` + aggressive window closing for memory.

### SPCC "no valid astrometric solution" after the live gradient phase (2026-10-29, fixed)
On PI 1.9.5 the combined RGB keeps `hasAstrometricSolution=true` after the gradient agent's tools (GradientCorrection / per-channel ABE / clone-restore), yet SPCC fails with `*** Error: The image has no valid astrometric solution`. Runs that replayed a cached gradient snapshot (views reloaded from XISF) were fine; live gradient phases failed every time (NGC7023 run2, NGC4490, NGC3628). Fix in `deterministic-prep.mjs`: after `copyAstrometricSolution()` call `updateAstrometryMetadata()` + `regenerateAstrometricSolution()`, and if SPCC still returns false, regenerate on the target and retry once. Validated on M97 (f543876a): first attempt failed, retry succeeded. The PI console of the SPCC step is captured to `/tmp/spcc-prep-console.log` (last 25 lines are logged on failure).

### Closing an active MASK window crashes PixInsight 1.9.5 (2026-10-30)
First crash on the V8 watcher, after ~40 h clean: `close_image('HA_MASK')` while another image still had HA_MASK applied as its mask -> `__dynamic_cast` fault inside `QWidget::event` -> C++ throw -> abort (report PixInsight-2026-10-30-002555). Not the old GC signature. `closeImage()` (image-mgmt.mjs) and `ctx.safeClose()` now scan `ImageWindow.windows`, call `removeMask()` on any window whose mask is the one being closed, `processEvents()`, then `forceClose()`. Do the same in any ad-hoc close script. The queue's auto-relaunch brought PixInsight back in 18 s; the interrupted run can be continued with `giga-run --resume-agent <runId>`.

### Modal dialogs block the watcher (2026-10-29, V8)
`ImageWindow.open()` on a path that does not exist pops a modal "file not found" box on the V8 runtime (the legacy engine threw). The watcher thread is blocked until someone clicks it: every queued command waits, Node callers time out after 20 min, and an unattended run stalls (NGC3628 lost 30 min that way from an ad-hoc diagnostic). Rules: never `ImageWindow.open()` a path you have not checked with `File.exists()` first (the watcher's open_image handler already does; ad-hoc scripts must too); keep diagnostics off the bridge while a run is in progress; after a stall, the stuck command's result file appears in `~/.pixinsight-mcp/bridge/results/` once the dialog is dismissed. Forensics: `executing.json` names the blocked command.

### Plate-solve fallback status (2026-10-29)
- The V8 ImageSolver library (MCP_WITH_SOLVER in the watcher) compiles and runs: `new ImageSolver; P.initialize(w); P.solveImage(w)`; `P.metadata.{ra,dec,focal,xpixsz,resolution}` are read from keywords (M101 drizzle set: XPIXSZ 1.88 um, focal 1520 mm -> 0.255"/px; `metadata.resolution` came out 2x too coarse, set `P.metadata.useFocal=false; P.metadata.resolution=arcsec/3600` explicitly).
- `CatalogMode`: 0 LocalText, 1 Online (VizieR), 2 Automatic (local XPSD), 3 LocalXPSDServer. The June note "catalogMode=2 = VizieR" was wrong for V8.
- CORRECTION (same day): the local Gaia database is fine. `ImageSolver.initialize()` loads the user's LAST ImageSolver settings (own scope, 1520 mm) over the file's FOCALLEN/XPIXSZ, so a borrowed 459 mm / 1.88 um (drizzle 2x) dataset was seeded at 0.255"/px instead of 0.845"/px, the catalog window was 4x too small (160 stars) and alignment failed. With the keyword-derived seed the solve locks in 14 s against the LOCAL catalog (1063 stars, 850 matches, RMS 0.9 px). deterministic-prep now seeds from FOCALLEN/XPIXSZ (or `config.files.pixelScale` in arcsec/px) and brackets x2/x0.5/x4/x0.25.
- Online mode: vizier.cds.unistra.fr was unreachable from this Mac (connect timeout) and the solver then opened a MODAL dialog that blocked the watcher. Never use CatalogMode.Online unattended.
- `config.files.distortionCorrection: true` switches StarAlignment distortion correction on in prep (borrowed/drizzled sets with channel fringing).
- `--automation-mode` does NOT suppress the `ImageWindow.open()` file-not-found dialog (tested): dialogs must be avoided by guards, not by flags. The relaunch script therefore does not use it.

### Headless (re)launch of PixInsight with modules + watcher (2026-10-29, validated)
`scripts/pi-relaunch.sh [--kill]` kills a stalled/crashed instance, deletes orphan `~PI~*` swap files, clears the bridge queue and runs
`open -a PixInsight --args -m=/Applications/PixInsight/bin/RCAstroSuite-pxm.dylib -r=<repo>/pjsr/pixinsight-mcp-watcher.js --no-startup-check-updates`.
`-m=` installs the RC-Astro suite for the session (after an unclean exit PI forgets third-party modules; this replaces the manual Process > Modules > Install Modules > Search > Install), `-r=` runs the watcher right after startup. watcher-state.json appeared 12 s after launch; BXT/NXT/SXT/SPCC were `function`. Other useful flags (`PixInsight --help`): `-x=<script>` sends a script to a running instance by IPC, `--terminate=<slot>`, `-e` enumerates instances, `--automation-mode` (unattended: no informative/warning messages, preferences not saved) — not yet tried with the pipeline.

## Language: ECMAScript 5 style (V8 runtime since 2026-10-29)
PJSR now runs on V8 (ES2025) via `#engine v8` in the watcher, so modern syntax works. By CONVENTION the command snippets sent from Node still use ES5 style for compatibility with existing code and docs:
- `let`, `const` — prefer `var`
- Arrow functions `() => {}` — prefer `function() {}`
- Template literals `` `${x}` `` — prefer `'text' + x + 'text'` (Node-side template literals are used to inject values BEFORE sending; avoid confusion)
- Destructuring, spread, `class`, `for...of`, `Promise` — allowed by V8 but unused in snippets

## File I/O
```javascript
// Reading
var lines = File.readLines(path);       // returns array of strings
var text = lines.join('\n');

// Writing
File.writeTextFile(path, text);         // static method, no instance needed

// Checks
File.exists(path);
File.directoryExists(path);
File.createDirectory(path, true);       // recursive mkdir

// Listing
File.searchDirectory(dir + '/*.json'); // glob-like listing (V8; bare searchDirectory is deprecated, rewritten by the watcher)
```

**Do NOT use** `DataType_ByteArray` — it's not defined.

## XISF Crop Masks
XISF files from WBPP contain embedded crop masks. Opening creates MULTIPLE windows:
```javascript
// After opening XISF, close crop masks:
var wins = ImageWindow.windows;
for (var i = 0; i < wins.length; i++) {
    if (wins[i].mainView.id.indexOf('crop_mask') >= 0) {
        wins[i].forceClose();
    }
}
```

## PixelMath in Global Context
`createNewImage = true` with `executeGlobal()` requires ALL of:
- `newImageWidth`, `newImageHeight`
- `newImageColorSpace` (`PixelMath.RGB` or `.Gray`; `.prototype.` spelling is rewritten by the watcher under V8)
- `newImageSampleFormat` (`PixelMath.f32`)

Without these: "Cannot execute instance in the global context" error.

## PixelMath Limitations
- **No `pow()` function** — use `exp(exponent * ln(base))` instead
- **`^` operator** works for fractional/negative exponents
- Negative numbers must be wrapped: `(-1.859)` not `-1.859` in some contexts
- `P.use64BitWorkingImage = true; P.truncate = true` for precision

## StarAlignment
- Output directory path must have **NO SPACES** — PJSR silently fails
- Use `/tmp/aligned/` or `~/.pixinsight-mcp/aligned/` instead
- `targets` format: `[[enabled, drizzle, filepath]]`

## eval() Context
- `#include` directives don't work inside eval — they're compile-time
- Code goes through JSON.stringify → JSON.parse → eval (beware escaping)
- Single quotes in PJSR code work fine
- Write long scripts to `/tmp/` files to avoid escaping issues

## Process Module Availability
- Not all PI processes are installed as `.dylib` modules
- Check: `/Applications/PixInsight/bin/<ProcessName>-pxm.dylib`
- GHS is script-only (no .dylib) — must use PixelMath fallback
- SXT/NXT/BXT ARE native modules
- Runtime check: `try { new ProcessName; } catch(e) { /* not available */ }`
- **A PixInsight reinstall/upgrade drops the RC-Astro modules** (seen 2026-10-25, PI 1.9.5): `BlurXTerminator is not defined`.
  The user must reinstall them via Resources > Updates (RC-Astro repositories), restart PI and relaunch the watcher.
  `narrowband-prep.mjs` checks for BXT/NXT/SXT up front and fails with a clear message. StarNet2 is not installed either, so there is no fallback star remover.
- **ChannelExtraction / ChannelCombination (PI 1.9.x)**: use `P.channels = [[true,'id'], ...]`.
  The old `channelEnabled`/`channelId` names are silently ignored, so the extracted views get default ids (`<view>_R`/`_L`…).
  This was the cause of the broken `runPerChannelABE` (fixed 2026-10-26).
- **RC-Astro "not defined" after a PI restart (2026-10-27/28):** RC-Astro ships as ONE module, `bin/RCAstroSuite-pxm.dylib` (not separate BXT/NXT/SXT dylibs).
  PI persists its installed-module list only on a CLEAN exit, so after a crash the suite isn't loaded at the next start.
  - Fix for the session: Process > Modules > Install Modules > Search > Install.
  - Permanent fix: then quit PI cleanly once.
  - Don't search bin/ for the separate per-tool files: that was a false "files deleted" diagnosis.
- After any PI restart the watcher is gone: `ping-watcher.mjs` times out even though the PixInsight process is alive.

## UI Responsiveness
- Under V8 `processEvents()`/`msleep()` are deprecated globals shimmed by the watcher (`CoreApplication.processEvents()`, `System.msleep()`); new watcher-side code should call the replacements.
- `processEvents()` is CRITICAL in any loop to prevent freeze
- `msleep(ms)` blocks completely — no UI events during sleep
- Pattern: alternate `msleep(50)` with `processEvents()` in idle loops
- During `P.executeOn(view)`, UI is blocked — unavoidable

## Memory Management
- PixInsight accumulates undo history — each operation adds ~300MB per 6000x4000 RGB image
- **Purge undo history** with `w.purge()` after mask-heavy steps (LHE, HDRMT) and merge points
- **Close images when done**: L_work after LRGB combine, stars after star addition, masks after use
- Check OS-level memory between heavy steps (BXT, NXT, SXT, SPCC)
- Close crop masks, ABE models, alignment outputs immediately
- Each 5972x3920 f32 RGB image ≈ 280MB RAM (plus undo = 280MB per operation)
- Thresholds: warn=4GB (auto-purge), abort=8GB (auto-checkpoint + exit)
- Without purging: 44GB observed. With purging: peak 1.3GB for same pipeline.
- After pipeline crash: relaunch PixInsight, resume from checkpoint with `--restart-from`

## ImageWindow Constructor — Dimension Bug
PJSR `Image.width` / `Image.height` properties don't pass cleanly as arguments to
`new ImageWindow(width, height, ...)`. The constructor throws "invalid dimension(s)"
even though the values appear correct.

**Workaround: Two-call pattern**
1. First PJSR call: query dimensions as JSON
```javascript
var img = srcW.mainView.image;
JSON.stringify({ w: Math.round(img.width), h: Math.round(img.height) });
```
2. Second PJSR call: use JS template literals to inject literal numbers
```javascript
var mw = new ImageWindow(${dims.w}, ${dims.h}, 1, 32, true, false, 'maskId');
```

The key is that `${dims.w}` gets interpolated by JavaScript (Node.js) into a literal
number like `5972` BEFORE the PJSR code is sent to PixInsight. This avoids passing
PJSR Image property values directly to the constructor.

Also use `floatSample=true` (5th arg) for mask windows — `false` creates integer images
which behave differently for PixelMath operations.

## ImageWindow.windowById() Never Returns Null
`ImageWindow.windowById('someId')` **always** returns an ImageWindow object, even if no
window with that ID exists. The returned object has `.isNull === true` when not found.

**WRONG:**
```javascript
var w = ImageWindow.windowById('myView');
if (!w) throw new Error('not found');  // NEVER throws — w is always truthy!
if (w ? 'yes' : 'no')  // ALWAYS 'yes'!
```

**CORRECT:**
```javascript
var w = ImageWindow.windowById('myView');
if (w.isNull) throw new Error('not found');  // Properly checks
w.isNull ? 'no' : 'yes';  // Correct boolean check
```

This is a critical PJSR gotcha — caused mask creation to silently fail for 4 iterations
because the Ha_work existence check always returned 'yes'.
Note (V8): `View.viewById()` and `ImageWindow.previewById()` DO return `null` when missing — the two APIs differ.

## Astrometry Transfer
```javascript
// Copy WCS solution from source to destination
dstWindow.copyAstrometricSolution(srcWindow);
```
Essential after creating PixelMath composites — SPCC needs WCS data.

## Error propagation in agent tools (WI-14)
- `bridge.pjsr()` never throws (ops modules rely on that). In `agents/llm/tools.mjs` use `pjsrOrThrow(ctx, code, label)`: it throws when the PJSR run errors, and prepends `execOrThrow(P, view, label)`.
- Process `executeOn()` returns `false` (bridge status still 'ok') on PixelMath parse failures (pow(), undeclared symbols, `$T.R`). Use `execOrThrow(P, view, label)` in PJSR so the failure surfaces as `Error:` to the agent.
- `run_pixelmath` pre-validates: refuses `pow(`; refuses `;` without `symbols`.
- `lrgb_combine` steps 1-3 throw; the handler closes `lrgb_lum_ref` and `<rgb>_R/G/B/L` in its catch.

## PI swap files: safe orphan rule (WI-24, verified 2026-10-28 on PI 1.9.5)
- Each `~PI~*.swp` file has its OWN random 16-char prefix (68 files / 68 prefixes) — there is NO per-session prefix. The old "keep the active session prefix, rm the rest" rule would delete the live session's other windows. Never use it.
- Never use mtime-based "stale" deletion either (idle windows' swap is not rewritten).
- Safe orphan test: swap entry creation time (birthtime) EARLIER than the live PixInsight process start (`ps -o lstart= -p $(pgrep -x PixInsight)`, parsed with `LC_ALL=C`; on a non-English locale the month names break Date.parse). PI not running => all `~PI~*` are orphans. If PI runs but its start time is unreadable, delete nothing.
- Implemented in `agents/llm/disk-hygiene.mjs` (`cleanOrphanSwap`), run once at giga-run startup and via `node scripts/clean-swap.mjs [--dry-run]`.
- giga-run also prunes old `runs/` (keep 3, protecting current/base run, ledger champions, approved registry; `--keep-runs N`) and caps prep-cache/gradient-cache to the 4 newest keys (no age pruning). Disk check: warn <20 GB, abort <10 GB.

## PI crash recovery and window pressure (WI-07b)
- Crash sentinel: bridge `send()` sets `ctx.crashed` and calls `opts.onCrash`; the MCP server writes `<run>/CRASH.json`, every later tool call returns `FATAL: PixInsight crashed ...`, and engine-max SIGTERMs the CLI within ~10 s. giga-run prints the resume command.
- Resume: restart PixInsight + watcher, then `node agents/llm/giga-run.mjs --config <cfg> --resume-agent <runId>`. It resumes the recorded Claude session (`agents/giga_orchestrator.json`, same cwd) with `PIX_RESUME=1`; MCP state is restored from `agent-state-giga_orchestrator.json` (turnsUsed reset; an `assess` snapshot resumes in `generate_candidates` so load_variant is allowed).
- `load_variant` accepts short ids (`variant_05`), takes `view_id` / `replace_existing`, and refuses (never auto-suffixes) when the target view is open. Variant numbering comes from disk.
- `list_open_images` reports estMB per window + PixInsight RSS and warns above 6000 MB; clone/open/load/recall refuse at 12+ non-mask windows. Keep <=6 full-res windows: save_variant then close_image for long-lived references.

## PixInsight 1.9.5 crash signature (2026-10-28)
> SUPERSEDED 2026-10-29 by the V8 runtime section at the top of this file (legacy SpiderMonkey GC was the cause; kept as history).
Three crashes in one day had the SAME crash report: `EXC_BAD_ACCESS (SIGABRT)`, `KERN_INVALID_ADDRESS at 0xfff2000000000000 (possible pointer authentication failure)`, faulting thread `__cxa_throw -> std::terminate -> abort` inside the PixInsight binary. It is NOT a macOS memory kill (no jetsam/memorystatus event, RSS < 1 GB at the time): an uncaught C++ exception inside PixInsight during scripted work on 60 MP images (PSF blob count, gate battery on the 5th opened image, gate battery with the critic).
- After any crash the RC-Astro suite is unloaded at the next start (module list only persists on a clean exit): Process > Modules > Install Modules > Search > Install, then quit cleanly once.
- The bridge now writes `~/.pixinsight-mcp/bridge/last-command.json` before every command; read it after a crash to identify the culprit call.
- Mitigation until the culprit is found: keep PI sessions short (one back-test image or one run per session), ≤4 full-res windows, purge undo (`w.purge()`), and never leave the gate battery's temp windows open.
- 4th crash (07:33) came right after `compare_to_reference` closed its 60 MP reference window and a second heavy call followed immediately. Pattern across all four: force-close of a 60 MP window followed at once by another heavy open/measure. Mitigation in code: `ctx.safeClose(viewId)` in bridge.mjs (purge → processEvents → forceClose → msleep 1500 → gc) used by backtest-gates.mjs, and the same sequence inside `compareToReference`'s finally. Use `ctx.safeClose` for any large window instead of a bare `forceClose()`; never chain two 60 MP compares without it.
- 5th crash (08:44): FIRST `compare_to_reference` call in a fresh session, one 60 MP window open, ~1 s after `open_image` → the gentle close is not the whole story. Common factor of all five crashes: **60 MP images** (PACMAN 9481×6261, NGC3628) with heavy PJSR scripts; the 24 MP NGC7023/NGC4490 batteries never crashed. `compareToReference` now writes stage markers to `~/.pixinsight-mcp/bridge/last-stage.txt` (opened reference / pixel sampling / detail loop / ms-ssim resample / closing) — read it with last-command.json after the next crash to bisect. Until the culprit stage is known: do not run compare_to_reference, the PSF blob count or the full gate battery on 60 MP images in a session that must survive; run them last.
- 6th crash (08:51): NO heavy script at all. Sequence: open_image (60 MP LIFT5) → script `rename; processEvents(); msleep(3000); gc()` → PI died 3 s in. Crash stack: `PixInsight → _sigtramp → PixInsight → __cxa_throw → terminate`: a SIGNAL (bad access at 0xfff2000000000000, which looks like a NaN-boxed JS value used as a pointer) is converted by PixInsight into a C++ exception inside the signal handler → abort. So the trigger is inside the PJSR engine/GC a few seconds after opening a 60 MP image, not our measurement code. Suspects: explicit `gc()` / `msleep()` in scripts, large JS heaps. Bisect script ready: scratchpad `bisect2.mjs` (stages S1..S8 with Node-side sleeps; progress file names the stage).
- **Stale command replay:** command files in `~/.pixinsight-mcp/bridge/commands/` survive a crash and the next watcher executes them at startup (a compare script from a dead session re-ran 7 min later). `createBridgeContext` now deletes commands/results older than 5 min; after a crash also `rm ~/.pixinsight-mcp/bridge/commands/*.json` before relaunching the watcher.

## CAUGHT (2026-10-29): explicit `gc()` in PJSR kills PixInsight 1.9.5 with a 60 MP image open
> SUPERSEDED 2026-10-29 by the V8 runtime section at the top of this file (legacy SpiderMonkey GC was the cause; kept as history).
Bisect on LIFT5 (9481×6261 RGB f32): open → idle 15 s → trivial script → `msleep(3000)` all fine; `gc()` alone → PixInsight aborts 3 s later (signal inside the JS engine → C++ throw in the signal handler → terminate). All six 2026-10-28 crashes had a `gc()` nearby: the swap-guard purge in mcp-agent-tools.mjs (ran periodically in every agent run), `checkMemory`, `safeClose`, `compareToReference`'s finally, scratch scripts.
**Rule: never call `gc()` from PJSR.** Removed everywhere (agents/, scripts/). `w.purge()` + `processEvents()` are fine. 24 MP images tolerated it; 60 MP did not.
- 2026-10-29 follow-up: the stale `gc()` command from the bisect was replayed by every new watcher start → "PixInsight crashes each time I start the MCP bridge". Fixed twice over: the watcher now discards all pre-existing command files at startup and skips any command older than 5 min; the Node bridge also deletes stale commands/results when a context is created. Manual recovery if ever needed: `rm ~/.pixinsight-mcp/bridge/commands/*.json` before launching the watcher.
- `node --check pjsr/pixinsight-mcp-watcher.js` fails on the `#include/#define` lines: check a copy with `grep -v '^\s*#'` instead.
- 2026-10-29 00:21, 7th crash, SAME signature, on a 24 MP image (NGC7023 cached prep) during `stretch_stars` after SXT + Seti stretch, with NO gc() anywhere → explicit gc() was only the fastest trigger. Working theory: a GC (explicit or automatic) finalising JS wrappers of large PI images/views crashes the PJSR engine. Bisect prepared: scratchpad `gcbisect.mjs T1..T5` (one scenario per fresh session: gc() without image access / after image access / after close / 24 MP / automatic GC by allocation). Forensics: watcher now writes `~/.pixinsight-mcp/bridge/executing.json` before each command (survives the crash) and the bridge keeps `command-log.jsonl` (last 30) so a post-crash `list_open_images` no longer hides the fatal call.

## Bisect result (2026-10-29): the crash needs a FRESH watcher session
> SUPERSEDED 2026-10-29 by the V8 runtime section at the top of this file (legacy SpiderMonkey GC was the cause; kept as history).
Scenarios on a fresh PI+watcher: T1 (open 60 MP via open_image, idle, gc()) → CRASH. In a session where a gc() had already run with nothing open (T0) → T4 (24 MP), T6/T7 (60 MP opened from a script, pinned or not), T8 (show()), T9 (view.image), and T1 itself all SURVIVED. So: the first garbage collection of a watcher session while a 60 MP image is open aborts PixInsight; after one collection with nothing open, the same sequences are fine (first-GC engine initialisation vs a 700 MB live object, presumably). Mitigation: the watcher now runs `gc(); processEvents();` once at startup before accepting commands ("GC warm-up done" in the console). Command scripts must still never call gc(). Scratch scripts: scratchpad `gcbisect.mjs T0..T9`.
- 2026-10-29 00:38: a `gc()` placed at the very START of the watcher script crashed PixInsight 39 s after launch, with nothing open. So the fatal condition is "a garbage collection too early in a fresh PixInsight/PJSR session" (first GC + big live heap at worst), not only "60 MP open". Final design: the watcher runs the warm-up gc() from its idle loop only after 45 s of polling with no image open, then writes `~/.pixinsight-mcp/bridge/watcher-state.json` {warmedUp:true}; `createBridgeContext().send()` waits (≤150 s) for that state before the first non-ping command. Start the watcher, wait for "[MCP Watcher] GC warm-up done" in the console, then run anything.
- 2026-10-29 00:41: the DEFERRED warm-up gc() itself crashed PI once (45 s after watcher start, PI uptime 167 s, nothing open); the retry in the next session succeeded, and the warmed session then survived the original crasher. So `gc()` in a fresh PJSR session is NON-DETERMINISTIC (a race), with or without images; the warm-up just takes that coin flip while nothing is open so a crash costs only a restart. **Protocol:** start PixInsight → launch the watcher → wait for "[MCP Watcher] GC warm-up done" in the console; if PixInsight dies before that line, restart both and wait again; only then run anything. The bridge enforces the wait.
- 2026-10-29 01:13 (8th crash): a GC-WARMED session still died 7 s into `measure_psf_field` on a 60 MP channel (`buildPsfFieldPjsr`: JS loop over every pixel of the 2× binned image, 15 M `sample()` calls + candidate arrays). So the warm-up removes the fresh-session trigger only; an AUTOMATIC collection during a JS-heavy pixel loop on 60 MP data still aborts. Rule: PJSR scripts must not iterate >~2 M pixels in JS on 60 MP images (stride ≥ 4 or bin ≥ 4, cap candidate arrays); prefer PI processes (StarDetector, PixelMath, statistics with selectedRect) over JS pixel loops.
- 2026-10-29 01:18 (9th crash): the deferred warm-up gc() crashed PI again (2 of 3 sessions, always exactly 45 s after watcher start, nothing open). Verdict: an EXPLICIT `gc()` is a coin flip in PI 1.9.5 regardless of state; automatic collections only crashed under the 15 M-pixel JS loop. **Final policy: no `gc()` anywhere, no warm-up** (WARMUP_ENABLED=false in the watcher; watcher-state.json is written warmedUp:true immediately so the bridge does not wait). Keep scripts light: stride/caps on pixel loops, PI processes for heavy work, ≤3 big windows, purge()+processEvents() only.

## ABE enum constants in PI 1.9.x (2026-10-29)
- **V8 update (2026-10-29):** under V8 process constants are `Process.CONST` (e.g. `AutomaticBackgroundExtractor.Subtract` if exposed); the watcher rewrites `.prototype.` spelling, so the undefined-constant failure below was a legacy-engine symptom. The numeric `P.targetCorrection = 1` (Subtraction) in `agents/ops/gradient.mjs`, `scripts/run-pipeline.mjs`, `scripts/process-rosetta-v2.mjs` stays valid under V8 and was validated live: per-channel ABE deg 1 moved the color-gradient score 0.0133 -> 0.0093; ABE on L changed uniformity x7. Keep the numeric form.
- `AutomaticBackgroundExtractor.prototype.Subtract`, `.f32`, `.SameAsTarget` are **undefined** in PI 1.9.5 → "invalid argument type: unsigned integer value expected". Module strings expose `Subtraction` / `Division` / `None`; do NOT set the sample-format params (defaults are f32 / SameAsTarget). `agents/ops/gradient.mjs` runABE used to swallow this as a WARN → silent no-op (memory claims of "run_abe deg=1 converged 0.0133→0.0093" are suspect). Now it throws. (Validated live under V8 on 2026-10-29: run_abe is no longer a no-op.)
- **NEVER enumerate a process prototype with `for (k in Process.prototype)` in PJSR** — doing it on AutomaticBackgroundExtractor killed PixInsight instantly (no crash log). Probe individual constants with `typeof` instead.

## Bridge latency (2026-11-10)
- A bare `ctx.pjsr('1+1')` round trip took 3.5-4 s although the script executed in 3 ms: the watcher's idle loop
  was 25 x (msleep 20 + processEvents) and processEvents is slow with large images open; the Node side polled
  every 500 ms. Fixed with wall-clock-boxed loops (re-check every ~100 ms, 120 ms yield after a command) and a
  100 ms Node poll: round trip ~105 ms. Restart the watcher (scripts/pi-relaunch.sh --kill) after editing it.

## PixInsight conventions needed to reproduce measurements outside PI (verified 2026-11-10)
- `Convolution` Parametric Gaussian: kernel truncated at 1% of the peak (radius round(3.035 sigma)), reflected
  borders (d c b a | a b c d). Matches scipy `gaussian_filter(mode='reflect', truncate=sqrt(2 ln 100))` to 1e-6.
- `Image.median()` with no channel selected pools all channels; even counts average the two middle values.
  `Image.MAD()` is the raw (unscaled) median absolute deviation.
- `FileFormatInstance.writeImage(img)` without a description wrote a Float32 view as UInt16 — to export a float
  copy, assign into a 32-bit `ImageWindow` and `saveAs(path, false, false, false, false)`.
