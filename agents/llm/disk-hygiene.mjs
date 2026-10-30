// WI-24: disk hygiene helpers (old-run cleanup, orphan PI swap cleanup, cache caps).
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const fmtGB = (b) => (b / 1024 ** 3).toFixed(2) + ' GB';

function dirSize(p) {
  let total = 0;
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    for (const f of fs.readdirSync(p)) total += dirSize(path.join(p, f));
  } catch {}
  return total;
}

/** Run ids (run_*) referenced by any xisfPath string anywhere inside obj. */
export function runIdsFromPaths(obj, out = new Set()) {
  if (typeof obj === 'string') {
    const m = obj.match(/(run_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9a-f]+)/i);
    if (m) out.add(m[1]);
  } else if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) runIdsFromPaths(v, out);
  }
  return out;
}

/** Protected run ids: current run, base run, ledger champions, approved-image registry. */
export function collectProtectedRuns({ runId, baseRun, ledgerPath, approvedPath } = {}) {
  const protect = new Set();
  if (runId) protect.add(runId);
  if (baseRun) protect.add(baseRun);
  try {
    const l = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    for (const cls of Object.values(l.classes || {})) {
      if (cls && cls.champions) runIdsFromPaths(cls.champions, protect);
    }
  } catch {}
  try {
    runIdsFromPaths(JSON.parse(fs.readFileSync(approvedPath, 'utf-8')), protect);
  } catch {}
  return protect;
}

/**
 * Delete run_* dirs beyond the newest `keep` unless protected. Returns deleted [{name,bytes}].
 * "Newest" is by directory mtime (name as tie-break): run names are run_<date>_<random hash>, so
 * sorting by name deleted the MOST RECENT run of the day (crashed M101 9dab226d, 2026-10-30) and
 * made --resume-agent impossible. Runs modified within `minAgeMs` (default 24 h) and runs holding a
 * CRASH.json (resumable) are never deleted.
 */
export function cleanOldRuns({ runsDir, keep = 3, protect = new Set(), log = console.log, dryRun = false, minAgeMs = 24 * 3600 * 1000 }) {
  const deleted = [];
  let dirs;
  try {
    dirs = fs.readdirSync(runsDir).filter(d => d.startsWith('run_'))
      .map(d => { let m = 0; try { m = fs.statSync(path.join(runsDir, d)).mtimeMs; } catch { /* */ } return { d, m }; })
      .sort((a, b) => (a.m - b.m) || a.d.localeCompare(b.d))
      .map(x => x.d);
  } catch { return deleted; }
  const now = Date.now();
  const candidates = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const d of candidates) {
    if (protect.has(d)) { log(`  runs: keeping protected ${d}`); continue; }
    try {
      const st = fs.statSync(path.join(runsDir, d));
      if (minAgeMs > 0 && now - st.mtimeMs < minAgeMs) { log(`  runs: keeping recent ${d}`); continue; }
    } catch { /* */ }
    if (fs.existsSync(path.join(runsDir, d, 'CRASH.json'))) { log(`  runs: keeping resumable (crashed) ${d}`); continue; }
    const p = path.join(runsDir, d);
    const bytes = dirSize(p);
    try {
      if (!dryRun) fs.rmSync(p, { recursive: true, force: true });
      deleted.push({ name: d, bytes });
      log(`  runs: deleted ${d} (${fmtGB(bytes)})${dryRun ? ' [dry-run]' : ''}`);
    } catch (e) { log(`  runs: could not delete ${d}: ${e.message}`); }
  }
  return deleted;
}

/** Keep the N newest cache entries. entries: [{key, mtimeMs, paths:[...]}]. */
function pruneEntries(entries, keep, log, label) {
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const e of entries.slice(keep)) {
    let bytes = 0;
    for (const p of e.paths) { bytes += dirSize(p); try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
    out.push({ key: e.key, bytes });
    log(`  ${label}: deleted ${e.key} (${fmtGB(bytes)})`);
  }
  return out;
}

/** prep-cache: dirs keyed by hash, ordered by meta.json mtime. No age pruning. */
export function capPrepCache(dir, keep = 4, log = console.log) {
  let entries = [];
  try {
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d);
      try {
        if (!fs.statSync(p).isDirectory()) continue;
        let m; try { m = fs.statSync(path.join(p, 'meta.json')).mtimeMs; } catch { m = fs.statSync(p).mtimeMs; }
        entries.push({ key: d, mtimeMs: m, paths: [p] });
      } catch {}
    }
  } catch { return []; }
  return pruneEntries(entries, keep, log, 'prep-cache');
}

/** gradient-cache: <hash>.xisf plus <hash>_L.xisf (and .xisf sidecar dirs) grouped by hash. */
export function capGradientCache(dir, keep = 4, log = console.log) {
  const groups = new Map();
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(.+?)(_L)?\.(xisf|xish)$/) || f.match(/^(.+?)(_L)?\.data$/);
      if (!m) continue;
      const key = m[1];
      const p = path.join(dir, f);
      let mt = 0; try { mt = fs.statSync(p).mtimeMs; } catch {}
      const g = groups.get(key) || { key, mtimeMs: 0, paths: [] };
      g.mtimeMs = Math.max(g.mtimeMs, mt); g.paths.push(p);
      groups.set(key, g);
    }
  } catch { return []; }
  return pruneEntries([...groups.values()], keep, log, 'gradient-cache');
}

/**
 * PI process start time. Returns {running:false} when PI is not running, {running:true,startMs:null}
 * when it runs but the start time cannot be parsed (callers must then delete NOTHING).
 */
export function getPIStartTime() {
  let pid = '';
  try { pid = execSync('pgrep -x PixInsight', { encoding: 'utf-8' }).trim().split('\n')[0]; } catch { return { running: false, startMs: null }; }
  if (!pid) return { running: false, startMs: null };
  try {
    // LC_ALL=C forces English month/day names so Date.parse works on non-English locales
    const s = execSync(`ps -o lstart= -p ${parseInt(pid, 10)}`, { encoding: 'utf-8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }).trim();
    const t = Date.parse(s);
    return { running: true, startMs: Number.isFinite(t) ? t : null };
  } catch { return { running: true, startMs: null }; }
}

/** Default swap dir: sibling "C" of os.tmpdir() (".../T" -> ".../C"). null if absent. */
export function defaultSwapDir() {
  const d = path.join(path.dirname(os.tmpdir()), 'C');
  return fs.existsSync(d) ? d : null;
}

/**
 * Delete ~PI~* entries created strictly before the live PI process started.
 * piStartMs: injected (tests) or auto-detected; null/undefined with autoDetect => PI not running => all orphans.
 * Never touches entries newer than PI start.
 */
export function cleanOrphanSwap({ swapDir, piStartMs, autoDetect = true, dryRun = false, log = console.log } = {}) {
  const dir = swapDir || defaultSwapDir();
  const res = { deleted: 0, bytes: 0, kept: 0, dryRun };
  if (!dir || !fs.existsSync(dir)) { log('  PI swap: swap dir not found — skipped'); return res; }
  let start = piStartMs;
  if (start === undefined && autoDetect) {
    const pi = getPIStartTime();
    if (pi.running && pi.startMs == null) { log('  PI swap: PI is running but its start time is unreadable — nothing deleted'); return res; }
    start = pi.running ? pi.startMs : null;
  }
  const cutoff = start == null ? Infinity : start;   // PI not running => everything is orphaned
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('~PI~')) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      const born = st.birthtimeMs && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
      if (born < cutoff) {
        const bytes = dirSize(p);
        if (!dryRun) fs.rmSync(p, { recursive: true, force: true });
        res.deleted++; res.bytes += bytes;
        if (dryRun) log(`  [would delete] ${name} (${(bytes / 1048576).toFixed(0)} MB, created ${new Date(born).toISOString()})`);
      } else res.kept++;
    } catch {}
  }
  log(`  PI swap: ${dryRun ? 'would remove' : 'removed'} ${res.deleted} orphan entries (${fmtGB(res.bytes)}), kept ${res.kept} newer than PI start${start == null ? ' (PI not running)' : ''}`);
  return res;
}
