# PJSR Gotchas & Constraints

## Language: ECMAScript 5 Only
PJSR runs ECMAScript 5. Do NOT use:
- `let`, `const` — use `var`
- Arrow functions `() => {}` — use `function() {}`
- Template literals `` `${x}` `` — use `'text' + x + 'text'`
- Destructuring, spread, `class`, `for...of`, `Promise`

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
searchDirectory(dir + '/*.json');       // glob-like listing
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
- `newImageColorSpace` (`PixelMath.prototype.RGB` or `.Gray`)
- `newImageSampleFormat` (`PixelMath.prototype.f32`)

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

## UI Responsiveness
- `CoreApplication.processEvents()` is CRITICAL in any loop to prevent freeze
- `System.msleep(ms)` blocks completely — no UI events during sleep
- Pattern: alternate `System.msleep(20)` with `CoreApplication.processEvents()` in idle loops
- During `P.executeOn(view)`, UI is blocked — unavoidable

## Script Lifetime and the "Modal" Lock (measured, PixInsight 1.9.4, V8 engine)
- While ANY script is running, PixInsight greys out view interaction (image right-click menu,
  STF button). File > Open and menus still work. This is inherent, not caused by the watcher's
  code: a plain `processEvents()/msleep()` loop does the same.
- A script cannot stay resident without running: Timers, non-modal `Dialog.open()/show()` and
  everything else die the moment `main` returns. So a watcher cannot be both resident and non-modal.
- Design that follows: the bridge launches the watcher ON DEMAND with
  `PixInsight -x=<watcher.js>` (~1 s, IPC to the running instance) and the watcher exits after a
  linger with no commands (`bridge/idle_exit_ms`, consumed once at startup; absent = stay resident,
  the manual Script-menu launch). PixInsight is locked only while commands run.
- `bridge/heartbeat` (`idle <ms>` / `busy <tool> <ms>`) and `bridge/last-stop` (`<reason> | <ms>`)
  are how the launcher tells "alive" and "why it stopped". A "busy" heartbeat stays alive however
  old (a running command blocks the loop) but is stale if older than the PixInsight process start.
- After a deliberate stop (`abort requested` / `shutdown file`) the bridge must NOT relaunch
  (`BridgeAbortError`), or Pause/Abort would be silently undone.
- Under V8 `Dialog` is a native class: `this.__base__()` throws. Use `Reflect.construct(Dialog, [])`.

## Process Console Pause/Abort (measured)
- `console.abortEnabled = true` is NOT sticky: PixInsight resets it to `false` every time a process
  finishes executing (`PixelMath.executeOn` etc.). Setting it once at startup leaves the button
  grey after the first process. Re-arm it on every loop iteration
  (`if (!console.abortEnabled) console.abortEnabled = true;`) and after each command.
- With the button grey and no polling, a script cannot be stopped at all (force quit).
- Clicking Pause/Abort only sets `console.abortRequested` (stays true until the script ends). Nothing
  interrupts the script by itself: `processEvents()` does NOT throw on abort. You must poll it.
- Abort during a native process (`executeOn`/`executeGlobal`): the process throws (message
  `undefined`), `abortRequested` and `isAborted` both stay true. The main loop sees the flag and stops.
- The global `processEvents` is read-only (`writable=false, configurable=false`); assigning to it
  silently does nothing. To make eval'd snippets abortable, run them in a function whose
  `processEvents` PARAMETER shadows the global with a version that throws once
  `console.abortRequested` is set (see `mcpRunSnippet` in the watcher).
- Shutdown sentinel: latch the stop condition. A check that deletes the sentinel and only
  `break`s an inner loop swallows the signal (the old watcher stopped ~1 time in 26).
- Verify with `abort-suite`-style tests (idle click, click during a process, click during a
  processEvents loop, sentinel x5, no relaunch after stop) rather than by eye.

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

## Astrometry Transfer
```javascript
// Copy WCS solution from source to destination
dstWindow.copyAstrometricSolution(srcWindow);
```
Essential after creating PixelMath composites — SPCC needs WCS data.
