// ============================================================================
// Vision Aesthetic Critic — spawns a fresh `claude -p` competition judge to
// score a rendered preview on a natural-vs-cooked competition rubric.
// Zero dollar cost: runs on the Max subscription via OAuth (ANTHROPIC_API_KEY
// stripped). The image is passed as a FILE PATH (base64 is stripped under
// `claude -p`); the judge views it via the Read tool. Verified 2026-06-23.
// ============================================================================
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const RUBRIC_SYSTEM_PROMPT = [
  'You are a veteran astrophotography competition judge (think APOD / IOTY panel).',
  'You are shown ONE finished deep-sky image. Judge it with fresh eyes — you did NOT',
  'process it and have no stake in it. Be honest and demanding; most images score 5-7.',
  '',
  'Score the image 0-10 (one decimal) on overall aesthetic merit, weighing:',
  '  1. NATURAL vs COOKED — the single most important axis. Does it read as a real',
  '     photograph of the sky, or as an over-sharpened, over-saturated, HDR-haloed,',
  '     plastic/synthetic render? Cooked images are heavily penalized.',
  '  2. CORE INTEGRITY — bright cores/shells show internal structure, not blown-out',
  '     featureless white blobs or muddy crushed mush.',
  '  3. IFN / FAINT STRUCTURE — faint nebulosity, dust, outer halo, tidal features are',
  '     present and credible (not noise, not crushed to flat black).',
  '  4. STARS — tight, round, natural color, controlled. Penalize bloat, dark halos,',
  '     uniform gray/white dots, or stars erased entirely.',
  '  5. COLOR — believable palette, good balance, no garish neon casts or gray washout.',
  '',
  'A 9-10 is gallery/award grade. 7-8 is strong. 6 is competent/acceptable. Below 6 has',
  'a clear aesthetic flaw a judge would call out. Below 4 is unpresentable.',
  '',
  'Respond with ONLY a single JSON object, no prose, no code fences:',
  '{"aesthetic_score": <0-10 number>, "flaws": ["short specific flaw", ...]}',
  'List 0-5 of the most important flaws; empty array if none.',
].join('\n');

async function renderCritiqueJpeg(ctx, viewId, jpegPath, maxDim) {
  await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${viewId}');
    if (srcW.isNull) throw new Error('View not found: ${viewId}');
    var img = srcW.mainView.image;
    var w = img.width, h = img.height;
    var scale = Math.min(1, ${maxDim} / Math.max(w, h));
    var nw = Math.round(w * scale), nh = Math.round(h * scale);
    var tmp = new ImageWindow(nw, nh, img.numberOfChannels, 32, false, img.isColor, 'critique_tmp');
    tmp.mainView.beginProcess();
    tmp.mainView.image.assign(img);
    tmp.mainView.endProcess();
    if (scale < 1) {
      var R = new Resample;
      R.mode = Resample.prototype.RelativeDimensions;
      R.xSize = scale; R.ySize = scale;
      R.absoluteMode = Resample.prototype.ForceWidthAndHeight;
      R.interpolation = Resample.prototype.MitchellNetravaliFilter;
      R.executeOn(tmp.mainView);
    }
    var p = '${jpegPath.replace(/'/g, "\\'")}';
    if (File.exists(p)) File.remove(p);
    tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
    'OK';
  `);
  return jpegPath;
}

function extractVerdict(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    let score = Number(obj.aesthetic_score);
    if (!isFinite(score)) return null;
    if (score > 10 && score <= 100) score = score / 10;
    score = Math.max(0, Math.min(10, score));
    const flaws = Array.isArray(obj.flaws) ? obj.flaws.map(String).slice(0, 8) : [];
    return { aesthetic_score: Math.round(score * 10) / 10, flaws };
  } catch { return null; }
}

function runJudge(jpegPath, model, log) {
  return new Promise((resolve) => {
    const promptText =
      'Judge the attached astrophotograph per your rubric.\n\n' +
      '### Image to critique\n' +
      `Use the Read tool to view this file, then score it:\n${jpegPath}\n`;
    const args = [
      '-p', promptText,
      '--output-format', 'json',
      '--append-system-prompt', RUBRIC_SYSTEM_PROMPT,
      '--allowedTools', 'Read',
      '--permission-mode', 'bypassPermissions',
      '--model', model || 'opus',
    ];
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // OAuth / Max subscription — zero $ cost
    let stdout = '', stderr = '';
    let claude;
    try { claude = spawn('claude', args, { cwd: process.cwd(), env, timeout: 5 * 60 * 1000 }); }
    catch (e) { log(`spawn failed: ${e.message}`); return resolve(null); }
    claude.stdout.on('data', d => { stdout += d.toString(); });
    claude.stderr.on('data', d => { stderr += d.toString(); });
    claude.on('error', (e) => { log(`subprocess error: ${e.message}`); resolve(null); });
    claude.on('close', (code) => {
      if (code !== 0) log(`judge exited ${code}: ${stderr.slice(0, 200)}`);
      let resultText = stdout;
      try { resultText = JSON.parse(stdout)?.result || stdout; } catch { /* raw */ }
      resolve(extractVerdict(resultText));
    });
  });
}

/**
 * Render → hash → (cache or spawn judge) → verdict.
 * @returns {Promise<{aesthetic_score,flaws,cached,model}|{error}>}
 */
export async function critiqueAesthetic(ctx, viewId, opts = {}) {
  const log = opts.log || ((m) => console.log(`  [aesthetic-critic] ${m}`));
  const baseDir = opts.baseDir;
  if (!baseDir) return { error: 'no baseDir (store) available for critique' };
  const maxDim = opts.maxDim || 1500;
  const model = opts.model || 'opus';
  const label = (opts.label || 'critique').replace(/[^A-Za-z0-9_.-]/g, '_');

  const dir = path.join(baseDir, 'critiques');
  const cacheDir = path.join(dir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const jpegPath = path.join(dir, `${label}.jpg`);

  try { await renderCritiqueJpeg(ctx, viewId, jpegPath, maxDim); }
  catch (e) { return { error: `render failed: ${e.message}` }; }
  if (!fs.existsSync(jpegPath)) return { error: 'critique JPEG not created' };

  const hash = crypto.createHash('sha256').update(fs.readFileSync(jpegPath)).digest('hex').slice(0, 16);
  const cachePath = path.join(cacheDir, `${hash}.json`);
  if (fs.existsSync(cachePath)) {
    try { const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')); log(`cache hit ${hash} → score ${cached.aesthetic_score}`); return { ...cached, cached: true }; }
    catch { /* re-judge */ }
  }

  log(`spawning judge (${model}) over ${path.basename(jpegPath)} [${maxDim}px]`);
  const verdict = await runJudge(jpegPath, model, log);
  if (!verdict) return { error: 'judge produced no parseable verdict' };

  const out = { aesthetic_score: verdict.aesthetic_score, flaws: verdict.flaws, model };
  try { fs.writeFileSync(cachePath, JSON.stringify(out)); } catch { /* best-effort */ }
  return { ...out, cached: false };
}
