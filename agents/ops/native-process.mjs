// ============================================================================
// Native processing (2026-11-11): operations that PixInsight runs slowly on big frames, executed by the Rust
// binary `pixmetrics process` on the exported view, then loaded back INTO the same view (same window, id, mask
// and properties; no undo swap file: the pipeline restores from clones, and a 61 MP swap is 734 MB of disk). First op: LocalHistogramEqualization, an exact port of PixInsight's
// module (native/pixmetrics/src/process/lhe.rs). PACMAN 61 MP: PixInsight LHE r250 took ~820 s, r120 ~600 s.
//
// Callers use nativeLheOr(ctx, viewId, params, maskId, pjsrFallback): the native path when available and
// enabled (default; PIXINSIGHT_MCP_NATIVE_LHE=0 disables), the PixInsight process otherwise or on any failure.
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { binaryPath, exportView } from './native-metrics.mjs';

const OUT_DIR = path.join(os.homedir(), '.pixinsight-mcp', 'native-export', String(process.pid));
let _seq = 0;
const _stats = { lhe: 0, lheMs: 0, fallbacks: 0 };

// Parity 2026-11-11 vs PixInsight 1.9.5 on real crops: mono bit-exact (r64 12-bit, r40 8-bit square), colour / masked /
// r250 within 6e-8 (one float ulp). Default ON; PIXINSIGHT_MCP_NATIVE_LHE=0 (or PIXINSIGHT_MCP_NATIVE=0) disables it.
export function nativeLheEnabled() {
  return process.env.PIXINSIGHT_MCP_NATIVE !== '0' && process.env.PIXINSIGHT_MCP_NATIVE_LHE !== '0' && !!binaryPath();
}

function runProcess(args, timeoutMs = 1800000) {
  return new Promise((resolve, reject) => {
    execFile(binaryPath(), args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      let j = null; try { j = JSON.parse(stdout); } catch { /* fallthrough */ }
      if (j && j.ok) return resolve(j);
      reject(new Error(j?.error || err?.message || 'pixmetrics process: no JSON output'));
    });
  });
}

/** Load an XISF produced by the binary into an existing view (same geometry). */
async function loadInto(ctx, viewId, file) {
  const id = String(viewId).replace(/'/g, "\\'");
  const fwd = file.replace(/\\/g, '/');
  const r = await ctx.pjsr(`var V = ImageWindow.windowById('${id}'); if (V.isNull) throw new Error('view not found: ${id}');
    var ws = ImageWindow.open('${fwd}'), T = null;
    for (var i = 0; i < ws.length; i++) { if (ws[i].mainView.id.indexOf('crop_mask') >= 0) ws[i].forceClose(); else T = ws[i]; }
    if (T === null) throw new Error('native result did not open');
    var a = V.mainView.image, b = T.mainView.image;
    if (a.width !== b.width || a.height !== b.height || a.numberOfChannels !== b.numberOfChannels) { T.forceClose(); throw new Error('native result geometry mismatch'); }
    V.mainView.beginProcess(typeof UndoFlag !== 'undefined' ? UndoFlag.NoSwapFile : 0xFFFFFFFF); V.mainView.image.assign(b); V.mainView.endProcess();
    T.forceClose(); 'ok';`);
  if (r.status === 'error') throw new Error(r.error?.message || 'load failed');
}

/**
 * LocalHistogramEqualization on a view, natively. params: { radius, bins (8|10|12 or the PJSR Bit8/Bit10/Bit12
 * name), slopeLimit, amount, circular }. maskId: optional mask view (1 = processed), as with V.mask in PixInsight.
 */
export async function nativeLhe(ctx, viewId, params, maskId = null) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  const src = await exportView(ctx, viewId);
  const mask = maskId ? await exportView(ctx, maskId) : null;
  const out = path.join(OUT_DIR, `lhe-${++_seq}.xisf`);
  const bins = typeof params.bins === 'string' ? Number(params.bins.replace(/\D/g, '')) : (params.bins ?? 12);
  const p = { radius: params.radius ?? 64, bins, slopeLimit: params.slopeLimit ?? 2.0, amount: params.amount ?? 1.0, circular: params.circular ?? true };
  try {
    const j = await runProcess(['process', '--op', 'lhe', '--image', src, '--out', out, '--params', JSON.stringify(p), ...(mask ? ['--mask', mask] : [])]);
    await loadInto(ctx, viewId, out);
    _stats.lhe++; _stats.lheMs += Date.now() - t0;
    return { ok: true, native: true, ms: Date.now() - t0, processMs: j.processMs };
  } finally { try { fs.unlinkSync(out); } catch {} }
}

const _warned = new Set();
export async function nativeLheOr(ctx, viewId, params, maskId, pjsrFallback) {
  if (nativeLheEnabled()) {
    try { return await nativeLhe(ctx, viewId, params, maskId); }
    catch (e) {
      _stats.fallbacks++;
      if (!_warned.has('lhe')) { _warned.add('lhe'); (ctx.log || console.log)(`  [native] lhe failed (${e.message}) — PixInsight fallback`); }
    }
  }
  return pjsrFallback();
}

export function nativeProcessStats() { return { ..._stats }; }
