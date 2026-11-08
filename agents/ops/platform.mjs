// Platform helpers (2026-11-08, Windows portability report from a Reddit tester):
//  1. Windows paths embedded in PJSR string literals lost their backslashes ("D:\a\b" -> "D:ab").
//  2. Memory / liveness checks shelled out to ps/grep/awk and looked for "PixInsight.app" (macOS only).
import { execSync } from 'child_process';

/** Path for interpolation into PJSR code: forward slashes (PixInsight accepts them on every OS), quotes escaped. */
export function piPath(p) {
  return String(p).replace(/\\/g, '/').replace(/'/g, "\\'");
}

/**
 * Safety net applied to every script sent to PixInsight: a Windows drive path written with backslashes
 * (single "D:\x" or JSON-escaped "D:\\x") is rewritten with forward slashes. No-op when no drive path is present,
 * so macOS/Linux scripts are untouched.
 */
export function normalizeWinPathsInCode(code) {
  const s = String(code);
  if (!/[A-Za-z]:\\/.test(s)) return s;
  return s.replace(/(^|[^A-Za-z0-9_])([A-Za-z]):((?:\\{1,2}[^\\'"`\r\n]*)+)/g,
    (m, pre, drive, rest) => `${pre}${drive}:${rest.replace(/\\{1,2}/g, '/')}`);
}

/** Resident memory of PixInsight in MB, or null when it cannot be measured on this platform. */
export function piMemoryMB() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq PixInsight.exe" /FO CSV /NH', { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      let kb = 0;
      for (const line of out.split(/\r?\n/)) { const m = line.match(/"PixInsight\.exe".*"([\d.,\s\u00a0]+)\s*K"/i); if (m) kb += parseInt(m[1].replace(/[^\d]/g, ''), 10) || 0; }
      return kb ? Math.round(kb / 1024) : null;
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const out = execSync('ps -axo rss=,comm=', { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      let kb = 0;
      for (const line of out.split('\n')) { const m = line.trim().match(/^(\d+)\s+(.*)$/); if (m && /PixInsight$/i.test(m[2].trim())) kb += parseInt(m[1], 10); }
      return kb ? Math.round(kb / 1024) : null;
    }
  } catch { /* fall through */ }
  return null;
}

/** true / false when known; null when the platform has no supported check (callers treat null as alive). */
export function piAlive() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq PixInsight.exe" /NH', { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      return /PixInsight\.exe/i.test(out);
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      execSync('pgrep -x PixInsight', { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
      return true;
    }
  } catch (e) {
    if (e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM')) return null;   // slow system: unknown, not dead
    return false;
  }
  return null;
}
