// ============================================================================
// Bridge communication with PixInsight via file-based IPC
// ============================================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const home = os.homedir();
const DEFAULT_CMD_DIR = path.join(home, '.pixinsight-mcp/bridge/commands');
const DEFAULT_RES_DIR = path.join(home, '.pixinsight-mcp/bridge/results');
const DEFAULT_PI_BIN = '/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight';
const DEFAULT_WATCHER = fileURLToPath(new URL('../../pjsr/pixinsight-mcp-watcher.js', import.meta.url));
const DEFAULT_LINGER_MS = 8000;

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
 * The user stopped the watcher on purpose (Pause/Abort or the shutdown file).
 * Extends BridgeCrashError so every existing crash handler halts the run and
 * offers a resume, instead of the bridge quietly relaunching the watcher and
 * carrying on.
 */
export class BridgeAbortError extends BridgeCrashError {
  constructor(message) {
    super(message);
    this.name = 'BridgeAbortError';
    this.isAbort = true;
  }
}

/**
 * Check if PixInsight process is running.
 */
function isPixInsightAlive() {
  try {
    const { execSync } = require('child_process');
    const out = execSync("ps aux | grep '[P]ixInsight.app' | wc -l", { timeout: 5000 }).toString().trim();
    return parseInt(out, 10) > 0;
  } catch {
    return false;
  }
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

async function isAlive() {
  try {
    const execSync = await getExecSync();
    // Generous timeout: under heavy multi-threaded PJSR processing (StarAlignment,
    // HDRMT, etc. can peg all cores for minutes), even a plain `ps` shell-out can
    // stall long enough to hit a short timeout, which would falsely read as "crashed".
    const out = execSync("ps aux | grep '[P]ixInsight.app' | wc -l", { timeout: 15000 }).toString().trim();
    return parseInt(out, 10) > 0;
  } catch {
    return false;
  }
}

// Start time of the PixInsight main process (ms since epoch), 0 if unknown.
async function piStartMs() {
  try {
    const execSync = await getExecSync();
    const line = execSync("ps -axo lstart=,command= | grep '[P]ixInsight.app/Contents/MacOS/PixInsight$'",
      { timeout: 15000 }).toString().trim().split('\n')[0];
    const t = Date.parse(line.slice(0, 24)); // "Sun Sep 20 10:27:23 2026"
    return Number.isNaN(t) ? 0 : t;
  } catch {
    return 0;
  }
}

/**
 * Create a bridge context for communicating with PixInsight.
 * All ops functions take this context as their first argument.
 *
 * On-demand watcher: PixInsight greys out view interaction (right-click, STF)
 * for as long as any script runs, and a script's timers die when it returns, so
 * a resident watcher cannot be non-modal. When autoLaunch is on (default) the
 * bridge starts the watcher with `PixInsight -x=` when none is running and the
 * watcher exits after `lingerMs` with no commands. Set PIXINSIGHT_MCP_AUTOLAUNCH=0
 * to keep the old behavior (a watcher you started by hand, resident).
 */
export function createBridgeContext(opts = {}) {
  const cmdDir = opts.cmdDir || DEFAULT_CMD_DIR;
  const resDir = opts.resDir || DEFAULT_RES_DIR;
  const logFn = opts.log || console.log;

  const bridgeDir = path.dirname(cmdDir);
  const heartbeatFile = path.join(bridgeDir, 'heartbeat');
  const lastStopFile = path.join(bridgeDir, 'last-stop');
  const idleCfgFile = path.join(bridgeDir, 'idle_exit_ms');
  const autoLaunch = opts.autoLaunch ?? (process.env.PIXINSIGHT_MCP_AUTOLAUNCH !== '0');
  const lingerMs = opts.lingerMs ?? (Number(process.env.PIXINSIGHT_MCP_LINGER_MS) || DEFAULT_LINGER_MS);
  const piBin = opts.piBin || process.env.PIXINSIGHT_BIN || DEFAULT_PI_BIN;
  const watcherPath = opts.watcherPath || DEFAULT_WATCHER;
  const createdAt = Date.now();

  function readBeat() {
    try {
      const parts = fs.readFileSync(heartbeatFile, 'utf-8').trim().split(' ');
      return { state: parts[0], ts: Number(parts[parts.length - 1]) };
    } catch { return null; }
  }

  function readLastStop() {
    try {
      const [reason, ts] = fs.readFileSync(lastStopFile, 'utf-8').split(' | ');
      return { reason: reason.trim(), ts: Number(ts) };
    } catch { return null; }
  }

  // "busy" counts as alive however old it is: a running command blocks the
  // watcher loop, so it cannot refresh the heartbeat.
  async function watcherAlive() {
    const beat = readBeat();
    if (!beat) return false;
    if (beat.state !== 'busy') return Date.now() - beat.ts < 5000;
    if (Date.now() - beat.ts > 30_000) {
      // A "busy" left behind by a PixInsight that crashed must not count as alive.
      const start = await piStartMs();
      if (start && beat.ts < start) {
        fs.rmSync(heartbeatFile, { force: true });
        return false;
      }
    }
    return true;
  }

  let launching = null;
  function ensureWatcher() {
    if (!autoLaunch) return Promise.resolve();
    if (launching) return launching;
    launching = (async () => {
      try {
        if (await watcherAlive()) return;
        const stop = readLastStop();
        if (stop && stop.ts >= createdAt && (stop.reason === 'abort requested' || stop.reason === 'shutdown file')) {
          throw new BridgeAbortError(`Watcher was stopped on purpose (${stop.reason}); not relaunching it. Resume with --resume --run-id <runId> when ready.`);
        }
        if (!(await isAlive())) {
          throw new BridgeCrashError('PixInsight process not found — start PixInsight, then resume with --resume --run-id <runId>');
        }
        logFn(`  [bridge] no watcher running — launching on demand (linger ${lingerMs}ms)`);
        fs.writeFileSync(idleCfgFile, String(lingerMs));
        spawn(piBin, ['-x=' + watcherPath], { detached: true, stdio: 'ignore' }).unref();
        const t0 = Date.now();
        while (!(await watcherAlive())) {
          if (Date.now() - t0 > 30_000) throw new Error('Watcher did not start within 30s of the -x launch');
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        launching = null;
      }
    })();
    return launching;
  }

  // Clean up stale results from previous crashed sessions (older than 5 min)
  try {
    const cutoff = Date.now() - 5 * 60_000;
    for (const f of fs.readdirSync(resDir)) {
      const fp = path.join(resDir, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) { try { fs.unlinkSync(fp); } catch {} }
    }
  } catch {}

  async function send(tool, proc, params, sendOpts) {
    return new Promise(async (resolve, reject) => {
      const id = crypto.randomUUID();
      const cmd = {
        id, timestamp: new Date().toISOString(), tool, process: proc,
        parameters: params,
        executeMethod: sendOpts?.exec || 'executeGlobal',
        targetView: sendOpts?.view || null
      };
      // An async Promise executor swallows throws, so reject explicitly.
      try { await ensureWatcher(); } catch (e) { reject(e); return; }
      const cmdFile = path.join(cmdDir, id + '.json');
      fs.writeFileSync(cmdFile, JSON.stringify(cmd, null, 2));
      const sentAt = Date.now();
      let att = 0;
      let consecutiveDeadChecks = 0;
      let checkingPickup = false;
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
        // Still unconsumed after 4s and no live watcher: it probably exited just as the
        // command was written (idle exit). Relaunch it, unless the user stopped it on purpose.
        if (autoLaunch && !checkingPickup && Date.now() - sentAt > 4000 && fs.existsSync(cmdFile)) {
          checkingPickup = true;
          try {
            if (!(await watcherAlive())) await ensureWatcher();
          } catch (e) {
            clearInterval(poll);
            fs.rmSync(cmdFile, { force: true }); // don't let a later watcher run a command the user aborted
            reject(e);
            return;
          } finally {
            checkingPickup = false;
          }
        }
        att++;
        // Every 20 polls (~10 seconds), check if PixInsight is still alive
        if (att % 20 === 0 && att > 0) {
          const alive = await isAlive();
          if (!alive) {
            consecutiveDeadChecks++;
            // Require 2 consecutive failed checks (~10s apart) before declaring a crash —
            // a single miss is usually just the `ps` shell-out getting starved while
            // PixInsight's worker threads peg all cores on a heavy process.
            if (consecutiveDeadChecks >= 2) {
              clearInterval(poll);
              reject(new BridgeCrashError('PixInsight process not found — it may have crashed. Restart PixInsight and the watcher, then resume with --resume --run-id <runId>'));
            }
          } else {
            consecutiveDeadChecks = 0;
          }
        }
        if (att > 2400) { clearInterval(poll); reject(new Error('Timeout: ' + tool)); }
      }, 500);
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
      const execSync = await getExecSync();
      const out = execSync("ps aux | grep '[P]ixInsight.app' | awk '{s+=$6} END{print s}'").toString().trim();
      const memKB = parseInt(out, 10);
      if (!memKB) return memKB;
      const memMB = Math.round(memKB / 1024);
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
        await pjsr('gc(); processEvents();');
        const out2 = execSync("ps aux | grep '[P]ixInsight.app' | awk '{s+=$6} END{print s}'").toString().trim();
        const memMB2 = Math.round(parseInt(out2, 10) / 1024);
        logFn(`  [MEMORY] After purge: ${memMB2}MB`);
        return memMB2;
      } else {
        logFn(`  [memory] ${memMB}MB`);
        return memMB;
      }
    } catch { return 0; }
  }

  function log(msg) { logFn(msg); }

  return { send, pjsr, listImages, detectNewImages, checkMemory, ping, log };
}
