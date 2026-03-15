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
 * Create a bridge context for communicating with PixInsight.
 * All ops functions take this context as their first argument.
 */
export function createBridgeContext(opts = {}) {
  const cmdDir = opts.cmdDir || DEFAULT_CMD_DIR;
  const resDir = opts.resDir || DEFAULT_RES_DIR;
  const logFn = opts.log || console.log;

  async function send(tool, proc, params, sendOpts) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const cmd = {
        id, timestamp: new Date().toISOString(), tool, process: proc,
        parameters: params,
        executeMethod: sendOpts?.exec || 'executeGlobal',
        targetView: sendOpts?.view || null
      };
      fs.writeFileSync(path.join(cmdDir, id + '.json'), JSON.stringify(cmd, null, 2));
      let att = 0;
      const poll = setInterval(() => {
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

  const MEM_WARN_MB = opts.memWarnMB || 4000;
  const MEM_ABORT_MB = opts.memAbortMB || 8000;

  async function checkMemory(stepId, liveImages, onAbort) {
    try {
      const { execSync } = await import('child_process');
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

  return { send, pjsr, listImages, detectNewImages, checkMemory, log };
}
