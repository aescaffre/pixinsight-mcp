#!/usr/bin/env node
// ============================================================================
// backtest-gates.mjs — back-test the finish gate battery against the registry of
// user-approved / rejected images (agents/calibration/approved-images.json).
//
//   node scripts/backtest-gates.mjs [--class X] [--id id,id] [--critic] [--only gate,gate] [--dry]
//
// For each registry entry (sequentially, one full-res window at a time):
//   open XISF -> close crop_mask/aux windows -> evaluateFinishGates(mode 'backtest')
//   -> record per-gate pass/fail + raw metrics -> force-close before the next image.
// Writes agents/calibration/last-backtest.json.
// Exit: 1 if an 'approved' image hits a blocking failure; 2 if a 'rejected' image
// passes every blocking gate; 3 if PixInsight crashed mid-run; else 0.
// 'superseded' and 'candidate' entries are informational (never affect the exit code).
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = path.join(ROOT, 'agents/calibration/approved-images.json');
const OUT = path.join(ROOT, 'agents/calibration/last-backtest.json');
const VIEW = 'BT_IMG';
const AUX = /crop_mask|rejection_low|rejection_high|slope|weights?$/i;

// Matrix columns = the names evaluateFinishGates passes to fail().
const GATE_COLUMNS = ['stars_brightness', 'stars_fwhm', 'palette', 'burn_clip', 'bright_blocks', 'core_contrast',
  'dust_ifn', 'noise', 'subject_brightness', 'subject_contrast', 'subject_detail', 'exposure', 'saturation',
  'tonal_presence', 'highlight_texture', 'l_usage', 'aesthetic', 'reference', 'background_floor', 'star_retention'];
const TABLE_TO_COLUMN = { noise_bg: 'noise', noise_dust: 'noise' };

function parseArgs(argv) {
  const a = { dry: false, critic: false, class: null, only: null, id: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry') a.dry = true;
    else if (argv[i] === '--critic') a.critic = true;
    else if (argv[i] === '--class') a.class = argv[++i];
    else if (argv[i] === '--id') a.id = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--only') a.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else { console.error(`Unknown argument: ${argv[i]}`); process.exit(64); }
  }
  return a;
}

const expand = (p) => (p || '').replace(/^~(?=\/|$)/, os.homedir());

function buildBrief(entry, classifier) {
  const { generateBrief, profileFor } = classifier;
  const brief = generateBrief({ files: { targetName: entry.id }, name: entry.id }, { classification: entry.classification });
  brief.dataDescription.narrowband = !!entry.narrowband;
  brief.dataDescription.starless = !!entry.starless;
  if (entry.narrowband) brief.dataDescription.workflow = 'SHO';
  brief.processingProfile = profileFor(entry.classification, !!entry.narrowband, brief.dataDescription.workflow);
  return brief;
}

function blockingColumns(table) {
  const m = {};
  for (const r of table) {
    const col = TABLE_TO_COLUMN[r.gate] || r.gate;
    const st = r.status;
    if (!m[col] || m[col] === 'SKIPPED' || (m[col] === 'WARNING' && st === 'BLOCKING')) m[col] = st;
  }
  return m;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
  let entries = reg.entries;
  if (args.class) entries = entries.filter(e => e.classification === args.class);
  if (args.id) entries = entries.filter(e => args.id.includes(e.id));

  const classifier = await import(path.join(ROOT, 'agents/classifier.mjs'));
  const { buildGateTable } = await import(path.join(ROOT, 'agents/llm/gate-contract.mjs'));

  console.log(`Registry: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${args.class ? ` (class=${args.class})` : ''}`);
  const prepared = entries.map(e => {
    const brief = buildBrief(e, classifier);
    const file = expand(e.path);
    return { entry: e, brief, file, exists: fs.existsSync(file), table: buildGateTable(brief) };
  });
  for (const p of prepared) {
    const blocking = p.table.filter(r => r.status === 'BLOCKING').length;
    console.log(`  [${p.entry.verdict.padEnd(10)}] ${p.entry.id.padEnd(24)} ${p.entry.classification}${p.entry.narrowband ? '@narrowband' : ''}${p.entry.starless ? ' starless' : ''}  ` +
      `${p.exists ? 'file OK' : 'FILE MISSING'}  profile resolved, ${blocking} blocking gates`);
  }
  for (const u of reg.uncalibrated || []) console.log(`  [no image  ] ${u.classification}: ${u._calibration}`);
  if (args.dry) { console.log('--dry: no PixInsight calls made.'); return 0; }

  const { createBridgeContext, BridgeCrashError } = await import(path.join(ROOT, 'agents/ops/bridge.mjs'));
  const { evaluateFinishGates, summarizeGateMetrics } = await import(path.join(ROOT, 'agents/llm/tools.mjs'));
  const ctx = createBridgeContext({ log: () => {} });
  const results = [];
  let crashed = false;

  for (const p of prepared) {
    const { entry } = p;
    const rec = { id: entry.id, verdict: entry.verdict, classification: entry.classification, path: p.file, status: 'pending' };
    results.push(rec);
    if (!p.exists) { rec.status = 'missing'; console.log(`\n[${entry.id}] SKIP — file missing: ${p.file}`); continue; }
    console.log(`\n[${entry.id}] opening ${p.file}`);
    const baseline = new Set((await ctx.listImages()).map(i => i.id));
    try {
      await ctx.send('open_image', '__internal__', { filePath: p.file });
      let opened = (await ctx.listImages()).filter(i => !baseline.has(i.id));
      for (const a of opened.filter(i => AUX.test(i.id))) {
        await ctx.safeClose(a.id);
      }
      opened = opened.filter(i => !AUX.test(i.id));
      if (opened.length === 0) throw new Error('no main window after open');
      // keep the largest as main, close extras
      opened.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      for (const x of opened.slice(1)) await ctx.safeClose(x.id);
      await ctx.pjsr(`var w=ImageWindow.windowById('${opened[0].id}');if(!w.isNull)w.mainView.id='${VIEW}';`);

      const t0 = Date.now();
      const res = await evaluateFinishGates(ctx, args.critic ? { baseDir: path.join(os.homedir(), '.pixinsight-mcp', 'backtest') } : null, p.brief, VIEW, 'backtest', { mode: 'backtest', aesthetic: args.critic, reference: false });
      // evaluateFinishGates swallows per-gate exceptions into warnings, so a PI crash or a dead
      // bridge would otherwise read as a clean pass. Treat that as a harness error, never a pass.
      const warnText = (res.warnings || []).join('\n');
      if (/PixInsight process not found|PixInsight.*crash/i.test(warnText)) {
        throw new Error('PixInsight process not found (reported inside gate warnings; battery invalid)');
      }
      const metricsSummary = summarizeGateMetrics(res.metrics);
      const hasValue = (v) => (v && typeof v === 'object') ? Object.values(v).some(hasValue) : (v !== null && v !== undefined);
      if (!hasValue(metricsSummary)) throw new Error('harness error: every gate metric is null (battery did not measure anything)');
      if (entry.verdict === 'approved' && /(Palette|Saturation|Highlight)[^\n]*check error/i.test(warnText)) {
        throw new Error('harness error: a gate raised a check error on an approved image: ' + (warnText.match(/[^\n]*check error[^\n]*/i) || [''])[0].slice(0, 200));
      }
      rec.status = 'ok';
      rec.seconds = +((Date.now() - t0) / 1000).toFixed(1);
      rec.failedGates = res.failedGates.map(g => g.gate);
      rec.failures = res.failures;
      rec.warnings = res.warnings;
      rec.metrics = summarizeGateMetrics(res.metrics);
      rec.imageStats = { median: res.stats.median, max: res.stats.max ?? null };
      rec.gateStatus = blockingColumns(p.table);
      // Gates that backtest mode does not evaluate must not read as 'ok' in the matrix.
      rec.gateStatus.l_usage = 'NOT_RUN';
      rec.gateStatus.reference = 'NOT_RUN';
      if (!args.critic) rec.gateStatus.aesthetic = 'NOT_RUN';
    } catch (e) {
      rec.status = 'error';
      rec.error = e.message;
      console.log(`[${entry.id}] ERROR: ${e.message}`);
      if (e instanceof BridgeCrashError || e?.isCrash || /PixInsight process not found/i.test(e.message)) {
        crashed = true;
        console.log('PixInsight crashed — stopping PI use immediately.');
        break;
      }
    } finally {
      if (!crashed) {
        try {
          for (const i of await ctx.listImages()) {
            if (!baseline.has(i.id)) await ctx.safeClose(i.id);
          }
        } catch (e2) { console.log(`cleanup warning: ${e2.message}`); }
      }
    }
  }

  // ---- matrix -----------------------------------------------------------
  const only = args.only ? GATE_COLUMNS.filter(c => args.only.includes(c)) : GATE_COLUMNS;
  const ran = results.filter(r => r.status === 'ok');
  console.log('\n=== GATE x IMAGE MATRIX (FAIL = blocking failure, ok = passed, . = gate skipped/advisory) ===');
  const idw = Math.max(...results.map(r => r.id.length), 5);
  console.log('gate'.padEnd(20) + ran.map(r => r.id.slice(0, 14).padEnd(15)).join(''));
  for (const col of only) {
    console.log(col.padEnd(20) + ran.map(r => {
      const st = r.gateStatus?.[col];
      const cell = r.failedGates.includes(col) ? 'FAIL' : (st === 'BLOCKING' ? 'ok' : '.');
      return cell.padEnd(15);
    }).join(''));
  }
  console.log('\n=== RAW METRICS ===');
  for (const r of ran) {
    console.log(`\n${r.id.padEnd(idw)} [${r.verdict}] failedGates=[${r.failedGates.join(', ')}] warnings=${r.warnings.length}`);
    console.log(JSON.stringify(r.metrics));
    for (const f of r.failures) console.log(`   FAIL: ${f.slice(0, 220)}`);
  }

  // ---- coverage ---------------------------------------------------------
  const approvedRan = ran.filter(r => r.verdict === 'approved');
  const covered = new Set();
  for (const r of approvedRan) for (const [col, st] of Object.entries(r.gateStatus || {})) if (st === 'BLOCKING') covered.add(col);
  const uncovered = GATE_COLUMNS.filter(c => !covered.has(c));
  console.log(`\nBlocking gates with ZERO approved-image coverage in this run: ${uncovered.join(', ') || '(none)'}`);

  // ---- exit code --------------------------------------------------------
  const approvedBad = approvedRan.filter(r => r.failedGates.some(g => only.includes(g)));
  const rejectedPass = ran.filter(r => r.verdict === 'rejected' && !r.failedGates.some(g => only.includes(g)));
  let code = 0;
  if (rejectedPass.length) code = 2;
  if (approvedBad.length) code = 1;
  if (crashed || results.some(r => r.status === 'error')) code = 3;   // an invalid battery outranks any verdict
  if (approvedBad.length) console.log(`\nMISCALIBRATED: approved image(s) hit a blocking failure: ${approvedBad.map(r => `${r.id}[${r.failedGates.join(',')}]`).join('; ')}`);
  if (rejectedPass.length) console.log(`\nWARNING-LEVEL: rejected image(s) pass every blocking gate: ${rejectedPass.map(r => r.id).join(', ')}`);

  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), args, exitCode: code, crashed,
    uncoveredBlockingGates: uncovered, results,
  }, null, 2));
  console.log(`\nWrote ${OUT}  (exit ${code})`);
  return code;
}

main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(70); });
