import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-hyg-'));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const mem = await import(path.join(ROOT, 'agents/memory/hierarchical-memory.mjs'));

const brief = { target: { name: 'M51', classification: 'galaxy_spiral', fieldCharacteristics: {} }, dataDescription: { workflow: 'LRGB' } };

test('recallForBrief labels prior strength and caps universal', () => {
  for (let i = 0; i < 40; i++) mem.saveEntry('universal', null, { title: `auto ${i}`, content: 'x', param: `p${i}`, value: i }, brief);
  mem.saveEntry('universal', null, { title: 'fb1', content: 'user said', tags: ['feedback'] }, brief);
  mem.saveEntry('universal', null, { title: 'fb1', content: 'user said', tags: ['feedback'] }, brief);
  mem.saveEntry('universal', null, { title: 'State machine: lrgb_combine requires compose state — trigger via early star_protected_blend', content: 'hack' }, brief);
  mem.saveEntry('type', 'galaxy_spiral', { title: 'T1', content: 'type rule', confidence: 3 }, brief);
  mem.saveEntry('target', 'M51', { title: 'W1', content: 'target anecdote' }, brief);
  const r = mem.recallForBrief(brief);
  const lines = r.summary.split('\n');
  assert.ok(lines.some(l => l.startsWith('- [STRONG]')));
  assert.ok(lines.some(l => l.startsWith('- [TYPE prior galaxy_spiral, conf=3]')));
  assert.ok(lines.some(l => l.startsWith('- [WEAK target-only M51, conf=1]')));
  assert.ok(r.summary.includes('target-level recipes are anecdotes'));
  const strong = lines.filter(l => l.startsWith('- [STRONG]'));
  const fb = r.universal.filter(mem.isProtectedEntry).length;
  assert.ok(strong.length <= fb + 20, `${strong.length} <= ${fb}+20`);
  assert.ok(strong.some(l => l.includes('fb1')));
  assert.equal(r.universal.filter(e => e.title === 'fb1').length, 2, 'feedback entries survive dedupe');
  assert.ok(r.summary.includes('SUPERSEDED after WI-05') || !strong.some(l => l.includes('early star_protected_blend')));
});

test('curateUniversal caps non-protected at 30 and keeps feedback', () => {
  const now = Date.now();
  const arr = [];
  for (let i = 0; i < 50; i++) arr.push({ title: `a${i}`, param: `q${i}`, value: i, timestamp: new Date(now - i * 1000).toISOString() });
  for (let i = 0; i < 5; i++) arr.push({ title: `g${i}`, tags: ['gotcha'], timestamp: new Date(now - 1e9).toISOString() });
  const out = mem.curateUniversal(arr);
  assert.equal(out.length, 35);
  assert.ok(out.some(e => e.title === 'a0') && !out.some(e => e.title === 'a49'));
});

test('agreeingEntries promotes median within +-15%', () => {
  const g = mem.agreeingEntries([
    { value: 0.30, targetName: 'A' }, { value: 0.33, targetName: 'B' }, { value: 0.35, targetName: 'C' }, { value: 0.9, targetName: 'D' },
  ]);
  assert.equal(new Set(g.group.map(e => e.targetName)).size, 3);
  assert.ok(Math.abs(g.value - 0.33) < 1e-9);
});
