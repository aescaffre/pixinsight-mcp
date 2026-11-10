// ============================================================================
// Bridge communication with PixInsight via file-based IPC
// ============================================================================
import fs from 'fs';
import path from 'path';
import { normalizeWinPathsInCode, piMemoryMB, piAlive } from './platform.mjs';
import crypto from 'crypto';
import os from 'os';

const home = os.homedir();
const DEFAULT_CMD_DIR = path.join(home, '.pixinsight-mcp/bridge/commands');
const DEFAULT_RES_DIR = path.join(home, '.pixinsight-mcp/bridge/results');

/**
 * Error thrown when PixInsight process is not found (crashed).
 * Callers should catch this specifically and handle crash recovery.
 */
export class BridgeCrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeCrashError';
    this.isCrash = true;
  }
}

/**
 * Check if PixInsight process is running.
 */
function isPixInsightAlive() {
  return piAlive() !== false;
}

// Lazy-load child_process for isPixInsightAlive (ESM compat)
let _execSync = null;
async function getExecSync() {
  if (!_execSync) {
    const cp = await import('child_process');
    _execSync = cp.execSync;
  }
  return _execSync;
}

export async function isAlive() {
  // Declare PixInsight dead only on a CONFIRMED absence. The old check ran `ps aux | grep` with a
  // 5 s timeout and returned false on timeout; under a heavy 100 MP operation (swap thrashing) ps
  // exceeded it, the run was aborted as "crashed" and the queue then killed a healthy PixInsight
  // (IC5146 babad074, 2026-10-30). Now: pgrep, 15 s timeout, 3 confirmations, timeouts = alive.
  // Platform-aware (pgrep on macOS/Linux, tasklist on Windows); null = unknown platform or slow system = alive.
  for (let i = 0; i < 3; i++) {
    if (piAlive() !== false) return true;
    // no match; confirm twice more before declaring a crash
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Create a bridge context for communicating with PixInsight.
 * All ops functions take this context as their first argument.
 */
export function createBridgeContext(opts = {}) {
  const cmdDir = opts.cmdDir || DEFAULT_CMD_DIR;
  const resDir = opts.resDir || DEFAULT_RES_DIR;
  const logFn = opts.log || console.log;

  // Clean up stale results AND stale commands from previous crashed sessions (older than 5 min).
  // Command files survive a PixInsight crash and the next watcher replays them at startup
  // (seen 2026-10-28: a compare script from a crashed session ran again 7 min later in the
  // fresh session). Never let a dead session's command run in the next one.
  try {
    const cutoff = Date.now() - 5 * 60_000;
    for (const dir of [resDir, cmdDir]) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) { try { fs.unlinkSync(fp); } catch {} }
      }
    }
  } catch {}

  // Wait for the watcher's deferred GC warm-up (see pixinsight-mcp-watcher.js) before the
  // first real command of this context: a fresh session that opens a 60 MP image before
  // its first garbage collection aborts PixInsight 1.9.5. Old watchers write no state
  // file: proceed after a short grace period. Pings (list_open_images) never wait.
  let warmChecked = false;
  async function waitForWarmWatcher() {
    if (warmChecked) return;
    warmChecked = true;
    const stateFile = path.join(cmdDir, '..', 'watcher-state.json');
    const t0 = Date.now();
    let announced = false;
    while (Date.now() - t0 < 150_000) {
      let state = null;
      try { state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch {}
      if (!state) {
        if (Date.now() - t0 > 5_000) { logFn('[bridge] no watcher-state.json (older watcher) — proceeding without GC warm-up'); return; }
      } else if (state.warmedUp) {
        if (announced) logFn('[bridge] watcher GC warm-up confirmed');
        return;
      } else if (!announced) {
        logFn('[bridge] waiting for the watcher GC warm-up (runs ~45 s after watcher start, with no image open)...');
        announced = true;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    logFn('[bridge] watcher warm-up not confirmed after 150 s — proceeding (close all images and restart the watcher if PixInsight aborts)');
  }

  async function send(tool, proc, params, sendOpts) {
    if (tool !== 'list_open_images') await waitForWarmWatcher();
    return new Promise(async (resolve, reject) => {
      const id = crypto.randomUUID();
      // Windows: drive paths embedded in PJSR lose their backslashes; rewrite them to forward slashes.
      if (params && typeof params.code === 'string') params = { ...params, code: normalizeWinPathsInCode(params.code) };
      const cmd = {
        id, timestamp: new Date().toISOString(), tool, process: proc,
        parameters: params,
        executeMethod: sendOpts?.exec || 'executeGlobal',
        targetView: sendOpts?.view || null
      };
      // Crash forensics: PixInsight 1.9.5 aborts (uncaught C++ exception, EXC_BAD_ACCESS/SIGABRT)
      // on some scripted calls on 60 MP images; the crash report has no symbols, so record the
      // last command sent. After a crash, read ~/.pixinsight-mcp/bridge/last-command.json.
      try {
        const script = typeof params?.script === 'string' ? params.script : (typeof params?.code === 'string' ? params.code : undefined);
        const entry = {
          id, timestamp: cmd.timestamp, tool, process: proc, targetView: cmd.targetView,
          paramKeys: params && typeof params === 'object' ? Object.keys(params) : [],
          scriptHead: script ? script.slice(0, 600) : undefined,
        };
        fs.writeFileSync(path.join(cmdDir, '..', 'last-command.json'), JSON.stringify(entry, null, 2));
        // Rolling log of the last 30 commands: a post-crash list_open_images must not
        // overwrite the call that actually crashed PixInsight (it did on 2026-10-29).
        const logPath = path.join(cmdDir, '..', 'command-log.jsonl');
        let lines = [];
        try { lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean); } catch {}
        lines.push(JSON.stringify(entry));
        fs.writeFileSync(logPath, lines.slice(-30).join('\n') + '\n');
      } catch {}
      fs.writeFileSync(path.join(cmdDir, id + '.json'), JSON.stringify(cmd, null, 2));
      let att = 0;
      const poll = setInterval(async () => {
        const rp = path.join(resDir, id + '.json');
        if (fs.existsSync(rp)) {
          try {
            const r = JSON.parse(fs.readFileSync(rp, 'utf-8'));
            if (r.status === 'running') return;
            clearInterval(poll);
            fs.unlinkSync(rp);
            resolve(r);
          } catch (e) { /* retry */ }
        }
        att++;
        // Every 100 polls (~10 seconds), check if PixInsight is still alive
        if (att % 100 === 0 && att > 0) {
          const alive = await isAlive();
          if (!alive) {
            clearInterval(poll);
            const err = new BridgeCrashError('PixInsight process not found — it crashed. STOP calling tools and end your turn; the parent will offer --resume-agent.');
            self.crashed = true;
            try { opts.onCrash?.(err, { tool }); } catch {}
            reject(err);
          }
        }
        if (att > 12000) { clearInterval(poll); reject(new Error('Timeout: ' + tool)); }   // 20 min
      }, 100);   // 2026-11-10: was 500 ms (with the watcher's slow idle cycle, 2-4 s per round trip)
    });
  }

  async function pjsr(code) {
    const r = await send('run_script', '__script__', { code });
    r.result = r.outputs?.consoleOutput;
    if (r.status !== 'error') r.status = 'ok';
    return r;
  }

  async function listImages() {
    const list = await send('list_open_images', '__internal__', {});
    return list.outputs?.images || [];
  }

  async function detectNewImages(beforeIds) {
    const imgs = await listImages();
    return imgs.filter(i => !beforeIds.includes(i.id));
  }

  /**
   * Quick health check — returns true if PixInsight watcher responds within timeout.
   */
  async function ping(timeoutMs = 10000) {
    try {
      const alive = await isAlive();
      if (!alive) return false;
      const result = await Promise.race([
        send('list_open_images', '__internal__', {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), timeoutMs))
      ]);
      return result.status !== 'error';
    } catch {
      return false;
    }
  }

  const MEM_WARN_MB = opts.memWarnMB || 4000;
  const MEM_ABORT_MB = opts.memAbortMB || 8000;

  async function checkMemory(stepId, liveImages, onAbort) {
    try {
      const memMB = piMemoryMB();          // null on unsupported platforms: skip silently (no ps/grep/awk on Windows)
      if (!memMB) return 0;
      if (memMB > MEM_ABORT_MB) {
        logFn(`  [MEMORY] CRITICAL: PixInsight using ${memMB}MB`);
        if (onAbort) await onAbort(stepId);
        return memMB;
      } else if (memMB > MEM_WARN_MB) {
        logFn(`  [MEMORY] WARNING: PixInsight using ${memMB}MB — purging undo history`);
        if (liveImages) {
          for (const [branch, viewId] of Object.entries(liveImages)) {
            await pjsr(`var w = ImageWindow.windowById('${viewId}'); if (!w.isNull) w.purge();`);
          }
        }
        await pjsr('processEvents();');
        const memMB2 = piMemoryMB() ?? 0;
        logFn(`  [MEMORY] After purge: ${memMB2}MB`);
        return memMB2;
      } else {
        logFn(`  [memory] ${memMB}MB`);
        return memMB;
      }
    } catch { return 0; }
  }

  function log(msg) { logFn(msg); }

  // Close a (large) window the gentle way. PixInsight 1.9.5 aborted four times on
  // 2026-10-28 right after a 60 MP window was force-closed and another heavy
  // open/measure followed immediately (crash reports: uncaught C++ exception ->
  // abort, no symbols). Purging history first, letting the event loop drain and
  // giving the swap writer a moment avoids the back-to-back pattern.
  async function safeClose(viewId, settleMs = 1500) {
    const id = String(viewId).replace(/'/g, "\\'");
    return pjsr(
      `var w = ImageWindow.windowById('${id}');` +
      `if (!w.isNull) { var ws = ImageWindow.windows; for (var i = 0; i < ws.length; i++) { try { var mk = ws[i].mask; if (mk && !mk.isNull && mk.mainView.id === w.mainView.id) ws[i].removeMask(); } catch (e) {} } try { w.purge(); } catch (e) {} try { w.hide(); } catch (e) {} processEvents(); msleep(150); processEvents(); w.forceClose(); processEvents(); }` +
      `processEvents(); msleep(${Math.max(0, settleMs | 0)}); processEvents();`
    );
  }

  const self = { send, pjsr, listImages, detectNewImages, checkMemory, ping, log, isAlive, safeClose, crashed: false, memWarnMB: MEM_WARN_MB };
  return self;
}
