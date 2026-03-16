// ============================================================================
// Bridge communication with PixInsight via file-based IPC
// ============================================================================
import fs from 'fs';
import path from 'path';
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
    const out = execSync("ps aux | grep '[P]ixInsight.app' | wc -l", { timeout: 5000 }).toString().trim();
    return parseInt(out, 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Create a bridge context for communicating with PixInsight.
 * All ops functions take this context as their first argument.
 */
export function createBridgeContext(opts = {}) {
  const cmdDir = opts.cmdDir || DEFAULT_CMD_DIR;
  const resDir = opts.resDir || DEFAULT_RES_DIR;
  const logFn = opts.log || console.log;

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
        // Every 20 polls (~10 seconds), check if PixInsight is still alive
        if (att % 20 === 0 && att > 0) {
          const alive = await isAlive();
          if (!alive) {
            clearInterval(poll);
            reject(new BridgeCrashError('PixInsight process not found — it may have crashed. Restart PixInsight and the watcher, then resume with --resume --run-id <runId>'));
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
