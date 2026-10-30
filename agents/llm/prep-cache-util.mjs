// Shared prep-cache helpers (used by deterministic-prep.mjs and narrowband-prep.mjs;
// kept separate to avoid a circular import).
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export const CACHE_DIR = path.join(os.homedir(), '.pixinsight-mcp', 'prep-cache');

/**
 * Compute a fingerprint for a file using size + first/last 64KB.
 * Fast enough for multi-GB XISF files.
 */
export function fileFingerprint(filePath) {
  if (!filePath?.trim() || !fs.existsSync(filePath)) return 'missing';
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash('sha256');
  hash.update(`${stat.size}:${stat.mtimeMs}:`);
  const fd = fs.openSync(filePath, 'r');
  const chunk = 65536;
  const buf = Buffer.alloc(chunk);
  const readHead = fs.readSync(fd, buf, 0, chunk, 0);
  hash.update(buf.subarray(0, readHead));
  if (stat.size > chunk) {
    const readTail = fs.readSync(fd, buf, 0, chunk, stat.size - chunk);
    hash.update(buf.subarray(0, readTail));
  }
  fs.closeSync(fd);
  return hash.digest('hex').slice(0, 16);
}

/** Hard-link src to dst (copy if linking fails). Replaces an existing dst. Returns dst. */
export function linkOrCopy(src, dst) {
  if (path.resolve(src) === path.resolve(dst)) return dst;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.rmSync(dst, { force: true }); } catch { /* */ }
  try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
  return dst;
}

/**
 * Open an image file in PixInsight, close crop_mask / rejection windows that come with it,
 * and rename the main view to newId. Returns the new view id.
 */
export async function openXisfAs(ctx, filePath, newId) {
  const before = (await ctx.listImages()).map(i => i.id);
  const r = await ctx.send('open_image', '__internal__', { filePath });
  if (r?.status === 'error') throw new Error(`open ${filePath} failed: ${r.error?.message}`);
  const added = (await ctx.listImages()).filter(i => !before.includes(i.id));
  const isAux = id => /crop_mask|rejection_low|rejection_high/i.test(id);
  for (const v of added.filter(i => isAux(i.id))) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${v.id}');if(!w.isNull)w.forceClose();`);
  }
  const main = added.find(i => !isAux(i.id));
  if (!main) throw new Error(`open ${filePath}: no new view appeared`);
  for (const v of added.filter(i => !isAux(i.id) && i.id !== main.id)) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${v.id}');if(!w.isNull)w.forceClose();`);
  }
  if (main.id !== newId) {
    await ctx.pjsr(`var w=ImageWindow.windowById('${main.id}');if(!w.isNull)w.mainView.id='${newId}';`);
  }
  return newId;
}
