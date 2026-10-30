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
import { renderCropJpeg } from './vision.mjs';

export const RUBRIC_VERSION = 2;

/** Build the target context from a brief (all fields optional). */
export function critiqueContextFromBrief(brief) {
  const dd = brief?.dataDescription || {};
  const ai = brief?.aestheticIntent || {};
  return {
    classification: brief?.target?.classification || '',
    workflow: dd.workflow || '',
    narrowband: !!dd.narrowband,
    palette: dd.palette || brief?.processingProfile?.palette?.goal || '',
    starless: !!dd.starless,
    colorSaturation: ai.colorSaturation || '',
    starProminence: ai.starProminence || '',
    referenceNotes: ai.referenceNotes || '',
  };
}

export function buildCritiqueRubric(context = {}) {
  const c = context || {};
  const cls = String(c.classification || '');
  const lines = [
    'You are a veteran astrophotography competition judge (think APOD / IOTY panel).',
    'You are shown ONE finished deep-sky image (an overview plus, when supplied, a 1:1 crop).',
    'Judge it with fresh eyes - you did NOT',
    'process it and have no stake in it. Be honest and demanding; most images score 5-7.',
    '',
    'Score the image 0-10 (one decimal) on overall aesthetic merit, weighing:',
    '  1. NATURAL vs COOKED - the single most important axis. Does it read as a real',
    '     photograph of the sky, or as an over-sharpened, over-saturated, HDR-haloed,',
    '     plastic/synthetic render? Cooked images are heavily penalized.',
    '  2. CORE INTEGRITY - bright cores/shells show internal structure, not blown-out',
    '     featureless white blobs or muddy crushed mush.',
    '  3. IFN / FAINT STRUCTURE - faint nebulosity, dust, outer halo, tidal features are',
    '     present and credible (not noise, not crushed to flat black).',
    '  4. STARS - tight, round, natural color, controlled. Penalize bloat, dark halos,',
    '     uniform gray/white dots, or stars erased entirely.',
    '  5. COLOR - believable palette, good balance, no garish neon casts or gray washout.',
    '  6. NOISE / GRAIN - background smoothness without plastic over-denoising.',
    '  7. COMPOSITION / BACKGROUND - even sky background, no gradients or color casts.',
    '  8. DETAIL - credible fine structure without ringing or crunchy sharpening.',
    '',
    'A 9-10 is gallery/award grade. 7-8 is strong. 6 is competent/acceptable. Below 6 has',
    'a clear aesthetic flaw a judge would call out. Below 4 is unpresentable.',
    '',
    'Respond with ONLY a single JSON object, no prose, no code fences:',
    '{"aesthetic_score": <0-10 number>, "flaws": ["short specific flaw", ...]}',
    'List 0-5 of the most important flaws; empty array if none.',
    '',
    '### Target context',
  ];
  const ctxLines = [];
  if (c.starless) ctxLines.push('This is a STARLESS deliverable by design (stars are added later from RGB). Do NOT score axis 4 STARS and do not list missing stars or star-removal residue as a flaw unless it is a visible blotch.');
  if (/^galaxy/.test(cls)) ctxLines.push('The owner prefers photographic restraint for broadband galaxies: muted saturation is CORRECT; over-saturation, crunchy over-sharpening and a white featureless core are the flaws.');
  if (c.narrowband) ctxLines.push(`False-colour ${c.palette || 'narrowband'} palette: judge palette balance (residual Ha-green, S+O magenta, blown Ha cores, chroma mottle), NOT natural colour; a strong warm/gold outer halo is the intended look, not fog; a rich saturated palette is correct.`);
  if (/reflection|dark/.test(cls)) ctxLines.push('Brown dust must be present across the field and not greyed/crushed; a blown blue core is the flaw.');
  if (cls) ctxLines.push(`Classification: ${cls}${c.workflow ? ` (workflow ${c.workflow})` : ''}.`);
  if (c.colorSaturation) ctxLines.push(`Intended colour saturation: ${c.colorSaturation}.`);
  if (c.starProminence && !c.starless) ctxLines.push(`Intended star prominence: ${c.starProminence}.`);
  if (c.referenceNotes && String(c.referenceNotes).trim()) ctxLines.push(`Owner intent: ${String(c.referenceNotes).trim()}`);
  if (!ctxLines.length) ctxLines.push('No special target context supplied; judge as a general deep-sky photograph.');
  return lines.concat(ctxLines).join('\n');
}

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

/** Centre 1:1 crop (cropDim px) of the full-resolution image via the shared WI-15 renderCropJpeg; source never modified. */
async function renderCenterCrop(ctx, viewId, jpegPath, cropDim) {
  const dr = await ctx.pjsr(`var w = ImageWindow.windowById('${viewId}'); if (w.isNull) throw new Error('View not found: ${viewId}'); JSON.stringify({ w: w.mainView.image.width, h: w.mainView.image.height });`);
  const d = JSON.parse(dr.outputs?.consoleOutput?.trim() || '{}');
  if (!d.w) throw new Error('View not found: ' + viewId);
  const sz = Math.min(cropDim, d.w, d.h);
  await renderCropJpeg(ctx, viewId, jpegPath, { x0: Math.floor((d.w - sz) / 2), y0: Math.floor((d.h - sz) / 2), size: sz });
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

// WI-25: judge usage accounting. The judge runs inside the MCP server process (not giga-run), so
// usage is also appended to <baseDir>/critiques/usage.jsonl and read back by getCritiqueUsage(baseDir).
const _critiqueUsage = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
function addUsage(acc, u) {
  acc.calls++;
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) acc[k] += (u && Number(u[k])) || 0;
  return acc;
}
/**
 * Aggregate judge usage {calls,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}.
 * With baseDir: summed from critiques/usage.jsonl (cross-process); otherwise this process's in-memory totals.
 */
export function getCritiqueUsage(baseDir) {
  if (!baseDir) return { ..._critiqueUsage };
  const acc = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  try {
    const f = path.join(baseDir, 'critiques', 'usage.jsonl');
    if (!fs.existsSync(f)) return acc;
    for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { addUsage(acc, JSON.parse(line).usage); } catch {}
    }
  } catch {}
  return acc;
}

export function runJudge(jpegPaths, rubricText, opts = {}) {
  const log = opts.log || (() => {});
  const paths = Array.isArray(jpegPaths) ? jpegPaths : [jpegPaths];
  return new Promise((resolve) => {
    const promptText =
      'Judge the attached astrophotograph per your rubric.\n\n' +
      '### Image(s) to critique\n' +
      `Use the Read tool to view EACH of these files (first is the overview; a second, if present, is a 1:1 crop where stars and grain are visible), then score:\n` +
      paths.map(p => `- ${p}`).join('\n') + '\n';
    const args = [
      '-p', promptText,
      '--output-format', 'json',
      '--append-system-prompt', rubricText,
      '--tools', 'Read',
      '--allowedTools', 'Read',
      '--permission-mode', 'bypassPermissions',
      '--strict-mcp-config',
      '--max-turns', String(opts.maxTurns ?? 3),
      '--model', opts.model || 'opus',
    ];
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // OAuth / Max subscription - zero $ cost
    let stdout = '', stderr = '';
    let claude;
    try { claude = spawn('claude', args, { cwd: process.cwd(), env, timeout: 5 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { log(`spawn failed: ${e.message}`); return resolve(null); }
    claude.stdout.on('data', d => { stdout += d.toString(); });
    claude.stderr.on('data', d => { stderr += d.toString(); });
    claude.on('error', (e) => { log(`subprocess error: ${e.message}`); resolve(null); });
    claude.on('close', (code) => {
      if (code !== 0) log(`judge exited ${code}: ${stderr.slice(0, 200)}`);
      let resultText = stdout;
      try {
        const j = JSON.parse(stdout);
        if (j?.usage) {
          addUsage(_critiqueUsage, j.usage);
          if (opts.baseDir) {
            try {
              fs.mkdirSync(path.join(opts.baseDir, 'critiques'), { recursive: true });
              fs.appendFileSync(path.join(opts.baseDir, 'critiques', 'usage.jsonl'), JSON.stringify({ ts: Date.now(), model: opts.model || 'opus', usage: j.usage }) + '\n');
            } catch {}
          }
        }
        if (j?.subtype === 'error_max_turns' && !j?.result) return resolve(null);
        resultText = j?.result || stdout;
      } catch { /* raw */ }
      resolve(extractVerdict(resultText));
    });
  });
}

/** Append one verdict line to <baseDir>/critiques/calibration.jsonl (best-effort). */
export function appendCalibration(baseDir, entry) {
  try {
    const dir = path.join(baseDir, 'critiques');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'calibration.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* best-effort */ }
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

  const jpegs = [jpegPath];
  if (opts.crop !== false) {
    const cropPath = path.join(dir, `${label}_crop.jpg`);
    try { await renderCenterCrop(ctx, viewId, cropPath, opts.cropDim || 800); if (fs.existsSync(cropPath)) jpegs.push(cropPath); }
    catch (e) { log(`crop render failed (overview only): ${e.message}`); }
  }

  const cctx = critiqueContextFromBrief(opts.brief);
  const rubricText = buildCritiqueRubric(cctx);
  const h = crypto.createHash('sha256');
  for (const f of jpegs) h.update(fs.readFileSync(f));
  h.update(rubricText).update(String(model));
  const hash = h.digest('hex').slice(0, 16);
  const cachePath = path.join(cacheDir, `${hash}-v${RUBRIC_VERSION}.json`);
  const record = (res) => appendCalibration(baseDir, {
    ts: new Date().toISOString(), runId: opts.runId || path.basename(path.resolve(baseDir)), label, hash, model,
    score: res.aesthetic_score, flaws: res.flaws, classification: cctx.classification,
    starless: cctx.starless, narrowband: cctx.narrowband, cached: !!res.cached,
  });
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      log(`cache hit ${hash} -> score ${cached.aesthetic_score}`);
      const res = { ...cached, cached: true, hash };
      record(res);
      return res;
    } catch { /* re-judge */ }
  }

  log(`spawning judge (${model}) over ${jpegs.map(f => path.basename(f)).join(' + ')} [${maxDim}px]`);
  const verdict = await runJudge(jpegs, rubricText, { model, maxTurns: opts.maxTurns ?? 3, log, baseDir });
  if (!verdict) return { error: 'judge produced no parseable verdict' };

  const out = { aesthetic_score: verdict.aesthetic_score, flaws: verdict.flaws, model };
  try { fs.writeFileSync(cachePath, JSON.stringify(out)); } catch { /* best-effort */ }
  const res = { ...out, cached: false, hash };
  record(res);
  return res;
}
