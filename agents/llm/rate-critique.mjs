#!/usr/bin/env node
// Record user ratings against aesthetic-critic verdicts and report judge/user agreement.
//   node agents/llm/rate-critique.mjs --run <runId> --label <finish_variant_xx> --rate <1-10> [--note "..."]
//   node agents/llm/rate-critique.mjs --report
// Reads/writes ~/.pixinsight-mcp/runs/<runId>/critiques/calibration.jsonl
import fs from 'fs';
import os from 'os';
import path from 'path';

const RUNS_DIR = process.env.PIXINSIGHT_RUNS_DIR || path.join(os.homedir(), '.pixinsight-mcp', 'runs');

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function rank(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

/** Spearman rho (Pearson on average ranks); null when n<3 or zero variance. */
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Pair user ratings with judge scores by hash; returns {class: {n, rho}} */
export function buildReport(entries) {
  const byHash = new Map();
  for (const e of entries) {
    if (e.user_rating == null) continue;
    byHash.set(e.hash, { ...(byHash.get(e.hash) || {}), user: e.user_rating });
  }
  const judged = new Map();
  for (const e of entries) if (e.score != null && e.hash) judged.set(e.hash, e);
  const groups = {};
  for (const [h, u] of byHash) {
    const j = judged.get(h);
    if (!j) continue;
    const cls = j.classification || 'unknown';
    (groups[cls] ||= []).push([j.score, u.user]);
  }
  const out = {};
  for (const [cls, pairs] of Object.entries(groups)) out[cls] = { n: pairs.length, rho: spearman(pairs.map(p => p[0]), pairs.map(p => p[1])) };
  return out;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') a.report = true;
    else if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.report) {
    const entries = [];
    if (fs.existsSync(RUNS_DIR)) for (const r of fs.readdirSync(RUNS_DIR)) entries.push(...readJsonl(path.join(RUNS_DIR, r, 'critiques', 'calibration.jsonl')));
    const rep = buildReport(entries);
    if (!Object.keys(rep).length) { console.log('No rated pairs yet.'); return; }
    for (const [cls, v] of Object.entries(rep)) console.log(`${cls}: n=${v.n} rho=${v.rho == null ? 'n/a' : v.rho.toFixed(3)}${v.n < 8 ? '  (n<8: not enough to set aesthetic_gate)' : ''}`);
    return;
  }
  const rate = Number(a.rate);
  if (!a.run || !a.label || !Number.isFinite(rate) || rate < 1 || rate > 10) {
    console.error('usage: rate-critique.mjs --run <runId> --label <label> --rate <1-10> [--note "..."]  |  --report');
    process.exit(2);
  }
  const file = path.join(RUNS_DIR, a.run, 'critiques', 'calibration.jsonl');
  const label = a.label.replace(/[^A-Za-z0-9_.-]/g, '_');
  const matches = readJsonl(file).filter(e => e.label === label && e.score != null);
  if (!matches.length) { console.error(`No critique for label ${label} in ${file}`); process.exit(1); }
  const last = matches[matches.length - 1];
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), runId: a.run, label, hash: last.hash, user_rating: rate, note: a.note || '' }) + '\n');
  console.log(`Recorded user_rating=${rate} for ${label} (hash ${last.hash}, judge ${last.score}).`);
}

import { fileURLToPath } from 'url';
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
