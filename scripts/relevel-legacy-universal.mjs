#!/usr/bin/env node
// One-off memory re-levelling (WI-03). Default is a DRY RUN that prints the diff.
//   node scripts/relevel-legacy-universal.mjs            # print planned changes
//   node scripts/relevel-legacy-universal.mjs --apply    # back up hierarchical.json, then write
// Optional: --file <path> to point at another hierarchical.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const fi = argv.indexOf('--file');
const file = fi >= 0 ? argv[fi + 1] : path.join(os.homedir(), '.pixinsight-mcp', 'agent-memory', 'hierarchical.json');

const TARGET_RE = /\b(M81|M97|Abell\s?\d+|Bubble|PACMAN|NGC\s?\d+)\b/i;
const SUPERSEDED = 'superseded for galaxy_spiral by the natural-look rule (NGC3628, 2026-06-07)';

const mem = JSON.parse(fs.readFileSync(file, 'utf8'));
const entryText = (e) => `${e.title || ''} ${(e.tags || []).join(' ')}`;
const changes = [];

// 1) move target-specific universal entries to target[<name>]
const keepUniversal = [];
for (const e of mem.universal || []) {
  const m = e.migrated === true ? entryText(e).match(TARGET_RE) : null;
  if (!m) { keepUniversal.push(e); continue; }
  const name = m[1].replace(/\s+/g, '');
  const canon = Object.keys(mem.target || {}).find((k) => k.toLowerCase() === name.toLowerCase()) || name;
  const moved = { ...e, level: 'target', scopeKey: canon, relevelledFrom: 'universal' };
  mem.target = mem.target || {};
  (mem.target[canon] = mem.target[canon] || []).push(moved);
  changes.push(`MOVE universal -> target[${canon}]: ${e.title || '(untitled)'}`);
}
mem.universal = keepUniversal;

// 2) annotate type/galaxy entries recommending saturation midpoint 0.70
for (const e of (mem.type && mem.type.galaxy) || []) {
  const c = `${e.title || ''} ${e.content || ''}`;
  if (/0\.70/.test(c) && /midpoint/i.test(c) && /satur/i.test(c) && !/superseded for galaxy_spiral/.test(c)) {
    e.content = `${e.content || ''} [${SUPERSEDED}]`;
    changes.push(`ANNOTATE type[galaxy]: ${e.title || '(untitled)'}`);
  }
}

// 3) one type-level galaxy_spiral summary entry
const summaryTitle = 'galaxy_spiral: natural, muted look is the approved target (NGC3628 rejection)';
mem.type = mem.type || {};
mem.type.galaxy_spiral = mem.type.galaxy_spiral || [];
if (!mem.type.galaxy_spiral.some((e) => e.title === summaryTitle)) {
  mem.type.galaxy_spiral.push({
    title: summaryTitle,
    content: 'NGC3628 (2026-06-07): the default vivid/cooked recipe (saturation push, second masked stage, midpoint 0.75-0.85) was rejected as synthetic. The approved variant used a single global S-curve at midpoint ~0.58, subject saturation P90 ~0.37, gentle detail gain (~+28%), neutral background. Rule: for broadband galaxies cooked/synthetic is the failure mode; a restrained candidate that passes the critic is a legitimate winner. M81 (midpoint 0.70, "moderate") is an upper reference anchor, not the default. Profile look block: target_p90 0.40 / max_p90 0.50 (PROVISIONAL until back-tested).',
    tags: ['galaxy', 'saturation', 'natural-look', 'approved', 'rejected'],
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    level: 'type',
    scopeKey: 'galaxy_spiral',
  });
  changes.push('ADD type[galaxy_spiral]: ' + summaryTitle);
}

console.log(changes.length ? changes.join('\n') : 'No changes.');
console.log(`\n${changes.length} change(s). universal entries now: ${mem.universal.length}`);
if (!apply) { console.log('DRY RUN — pass --apply to write (a .bak copy is made first).'); process.exit(0); }
const bak = `${file}.bak-${Date.now()}`;
fs.copyFileSync(file, bak);
if (mem.meta) mem.meta.totalEntries = Object.values(mem).reduce((n, v) => n + (Array.isArray(v) ? v.length : (v && typeof v === 'object' && !v.version ? Object.values(v).reduce((a, b) => a + (Array.isArray(b) ? b.length : 0), 0) : 0)), 0);
fs.writeFileSync(file, JSON.stringify(mem, null, 2));
console.log('Backup:', bak, '\nWritten:', file);
