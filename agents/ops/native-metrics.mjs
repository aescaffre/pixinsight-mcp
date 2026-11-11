// ============================================================================
// Native metrics bridge (2026-11-10): the quality-gate measurements run in the Rust binary `pixmetrics`
// (native/pixmetrics) instead of PixInsight's JS engine. PixInsight writes the view to an uncompressed XISF
// once per image state (fingerprinted), the binary reads it (~70 ms for 3000x2000x3) and computes the metric
// in milliseconds. M74 v11: the gate battery took ~350 s per call and checks were 61% of the run.
//
// Every measureX in agents/ops keeps its PJSR implementation as the fallback: if the binary is missing,
// fails, or PIXINSIGHT_MCP_NATIVE=0, the old path runs unchanged.
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = process.platform === 'win32' ? 'pixmetrics.exe' : 'pixmetrics';
const EXPORT_ROOT = path.join(os.homedir(), '.pixinsight-mcp', 'native-export');
// One sub-directory per process (the orchestrator and each MCP tool server import this module), removed on exit.
// Before 2026-11-11 exports were never deleted: 127 files / 14 GB after two runs, enough to fill the disk on a
// 9576x6388 colour target (734 MB per view).
const EXPORT_DIR = path.join(EXPORT_ROOT, String(process.pid));
const MAX_EXPORTS = Math.max(2, Number(process.env.PIXMETRICS_MAX_EXPORTS) || 8);   // LRU cap per process

let _bin;            // resolved binary path, null = unavailable
let _names = null;   // metric names the binary implements
let _reqSeq = 0;
const _stats = { calls: 0, ms: 0, fallbacks: 0, exports: 0, exportMs: 0, batches: 0, batchMetrics: 0, batchHits: 0 };

export function nativeEnabled() {
  return process.env.PIXINSIGHT_MCP_NATIVE !== '0' && !!binaryPath();
}

/** Binary location: $PIXMETRICS_BIN, native/pixmetrics/bin/<platform-arch>/, then the cargo release build. */
export function binaryPath() {
  if (_bin !== undefined) return _bin;
  const cands = [
    process.env.PIXMETRICS_BIN,
    path.join(ROOT, 'native', 'pixmetrics', 'bin', `${process.platform}-${process.arch}`, EXE),
    path.join(ROOT, 'native', 'pixmetrics', 'target', 'release', EXE),
  ].filter(Boolean);
  _bin = cands.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
  return _bin;
}

function runBin(args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    execFile(binaryPath(), args, { maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      let j = null; try { j = JSON.parse(stdout); } catch { /* fallthrough */ }
      if (j) return resolve(j);
      reject(err || new Error('pixmetrics: no JSON output'));
    });
  });
}

/** Metric names implemented natively (cached). */
export async function nativeNames() {
  if (_names) return _names;
  if (!binaryPath()) return (_names = new Set());
  try { const j = await runBin(['list'], 20000); _names = new Set(j.metrics || []); } catch { _names = new Set(); }
  return _names;
}

// ---------------------------------------------------------------------------
// View export, cached per (viewId, fingerprint). The fingerprint is cheap (dimensions + per-channel mean +
// a 64-point sample grid) and changes whenever a process modifies the image.
// ---------------------------------------------------------------------------
const _exports = new Map();   // viewId -> { fp, file }  (Map order = LRU order: re-inserted on every use)
let _swept = false;

const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** First use: remove exports left by dead processes (and the pre-2026-11-11 flat files); register exit cleanup. */
function sweepStale() {
  if (_swept) return; _swept = true;
  try {
    for (const name of fs.readdirSync(EXPORT_ROOT)) {
      const f = path.join(EXPORT_ROOT, name);
      if (/^\d+$/.test(name)) { if (Number(name) !== process.pid && !pidAlive(Number(name))) fs.rmSync(f, { recursive: true, force: true }); }
      else if (/\.(xisf|json)$/.test(name)) fs.rmSync(f, { force: true });
    }
  } catch { /* root missing: nothing to sweep */ }
  process.once('exit', () => { try { fs.rmSync(EXPORT_DIR, { recursive: true, force: true }); } catch {} });
}

function evictExports() {
  while (_exports.size > MAX_EXPORTS) {
    const [vid, ent] = _exports.entries().next().value; const file = ent.file;
    if (_active && _active.viewId === vid) { _exports.delete(vid); _exports.set(vid, ent); continue; }
    _exports.delete(vid); try { fs.unlinkSync(file); } catch {}
  }
}

/**
 * Write the view to an uncompressed Float32 XISF (no change to the window or its file path), unless the cached
 * export of this view is still current. One PixInsight round trip: the script computes the fingerprint, compares
 * it with the one we pass, and only writes when it differs (a 32-bit float copy window -> saveAs -> close).
 */
export async function exportView(ctx, viewId) {
  sweepStale();
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const file = path.join(EXPORT_DIR, `${String(viewId).replace(/[^A-Za-z0-9_]/g, '_')}.xisf`);
  const hit = _exports.get(viewId);
  const known = hit && fs.existsSync(hit.file) ? hit.fp : '';
  const t0 = Date.now();
  const id = String(viewId).replace(/'/g, "\\'");
  const fwd = file.replace(/\\/g, '/');
  const r = await ctx.pjsr(`var w = ImageWindow.windowById('${id}'); if (w.isNull) throw new Error('view not found: ${id}');
    var img = w.mainView.image, s = [img.width, img.height, img.numberOfChannels, img.bitsPerSample], c, i, j;
    for (c = 0; c < img.numberOfChannels; c++) s.push(img.mean(new Rect(0, 0, img.width, img.height), c, c));
    for (i = 1; i < 9; i++) for (j = 1; j < 9; j++) for (c = 0; c < img.numberOfChannels; c++) s.push(img.sample(Math.floor(i * img.width / 9), Math.floor(j * img.height / 9), c));
    var fp = JSON.stringify(s), wrote = false;
    if (fp !== '${known.replace(/'/g, "\\'")}') {
      var t = new ImageWindow(img.width, img.height, img.numberOfChannels, 32, true, img.isColor, 'NATIVE_EXPORT_TMP');
      t.mainView.beginProcess(); t.mainView.image.assign(img); t.mainView.endProcess();
      var ok = t.saveAs('${fwd}', false, false, false, false); t.forceClose();
      if (!ok) throw new Error('saveAs failed');
      wrote = true;
    }
    JSON.stringify({ fp: fp, wrote: wrote });`);
  let o = null; try { o = JSON.parse(r.outputs?.consoleOutput?.trim() || ''); } catch {}
  if (r.status === 'error' || !o) throw new Error(`native export failed: ${r.error?.message || r.outputs?.consoleOutput}`);
  if (o.wrote) { _stats.exports++; _stats.exportMs += Date.now() - t0; }
  _exports.delete(viewId); _exports.set(viewId, { fp: o.fp, file });
  evictExports();
  return file;
}

/** Forget cached exports (e.g. when the run ends). */
export function clearExports() {
  for (const { file } of _exports.values()) { try { fs.unlinkSync(file); } catch {} }
  _exports.clear();
}

/**
 * Run native metrics on a view. metrics = [{ name, params, id? }]. Returns { id|name: value }.
 * Throws when unavailable — callers use nativeOr() for the fallback.
 */
export async function measureNative(ctx, viewId, metrics) {
  const file = await exportView(ctx, viewId);
  return measureFile(file, metrics);
}

async function runRequest(file, metrics) {
  // Request through a temp file: inventories (Ha knot lists, profiles) exceed Windows' 32 K command-line limit.
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const req = path.join(EXPORT_DIR, `req-${process.pid}-${++_reqSeq}.json`);
  fs.writeFileSync(req, JSON.stringify({ metrics }));
  let j;
  try { j = await runBin(['measure', '--image', file, '--request-file', req]); }
  finally { try { fs.unlinkSync(req); } catch {} }
  return j;
}

export async function measureFile(file, metrics) {
  const t0 = Date.now();
  const j = await runRequest(file, metrics);
  if (!j.ok) throw new Error(`pixmetrics: ${j.error}`);
  const out = {};
  for (const r of j.results || []) {
    if (!r.ok) throw new Error(`pixmetrics ${r.name}: ${r.error}`);
    out[r.id || r.name] = r.value;
  }
  _stats.calls++; _stats.ms += Date.now() - t0;
  return out;
}

// ---------------------------------------------------------------------------
// Batching (2026-11-10): a gate battery calls ~30 metrics on the same unchanged view. Inside nativeBatch() the view
// is exported/fingerprinted ONCE and frozen (gates are read-only), and every metric the same battery label asked
// for last time is computed in ONE binary call (one image read, metrics in parallel). The record self-updates, so
// no list has to be kept in sync with the gate code; a metric not prefetched simply runs on the frozen export.
// ---------------------------------------------------------------------------
const _batchPlans = new Map();   // label -> [{ name, params }] asked for in the last battery with this label
let _active = null;              // { viewId, file, cache: Map(key -> value), seen: Map(key -> req) }
const stableKey = (name, params) => name + '|' + JSON.stringify(params, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);

export async function nativeBatch(ctx, viewId, label, fn) {
  if (process.env.PIXINSIGHT_MCP_NATIVE === '0' || !binaryPath() || (_active && _active.viewId === viewId)) return fn();
  let file;
  try { file = await exportView(ctx, viewId); } catch { return fn(); }
  const cache = new Map(), seen = new Map();
  const plan = _batchPlans.get(label) || [];
  if (plan.length) {
    const t0 = Date.now();
    try {
      const reqs = plan.map((r, i) => ({ id: 'm' + i, name: r.name, params: r.params }));
      const j = await runRequest(file, reqs);
      for (const r of j.results || []) if (r.ok) { const q = plan[Number(r.id.slice(1))]; cache.set(stableKey(q.name, q.params), r.value); }
      _stats.batches++; _stats.batchMetrics += cache.size; _stats.ms += Date.now() - t0;
    } catch { /* prefetch is an optimisation: individual calls still work */ }
  }
  const prev = _active;
  _active = { viewId, file, cache, seen };
  try { return await fn(); }
  finally { _active = prev; if (seen.size) _batchPlans.set(label, [...seen.values()]); }
}

/**
 * Use the native metric when available, else the PJSR implementation. A native failure is logged once per
 * metric and falls back (the gate must still run).
 */
const _warned = new Set();
export async function nativeOr(ctx, viewId, name, params, pjsrFallback) {
  if (process.env.PIXINSIGHT_MCP_NATIVE !== '0' && binaryPath() && (await nativeNames()).has(name)) {
    try {
      if (_active && _active.viewId === viewId) {   // inside a batch: frozen export, prefetched results
        const key = stableKey(name, params);
        _active.seen.set(key, { name, params });
        if (_active.cache.has(key)) { _stats.batchHits++; return _active.cache.get(key); }
        return (await measureFile(_active.file, [{ name, params }]))[name];
      }
      return (await measureNative(ctx, viewId, [{ name, params }]))[name];
    }
    catch (e) {
      _stats.fallbacks++;
      if (!_warned.has(name)) { _warned.add(name); (ctx.log || console.log)(`  [native] ${name} failed (${e.message}) — PixInsight fallback`); }
    }
  }
  return pjsrFallback();
}

export function nativeStats() { return { ..._stats, bin: binaryPath() }; }
