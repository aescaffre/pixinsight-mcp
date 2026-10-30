import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { cleanOldRuns, collectProtectedRuns, cleanOrphanSwap } from '../agents/llm/disk-hygiene.mjs';

test('cleanOldRuns protects champion and base run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wi24-'));
  const runs = path.join(root, 'runs'); fs.mkdirSync(runs);
  const names = ['run_2026-01-01_a1', 'run_2026-01-02_b2', 'run_2026-01-03_c3', 'run_2026-01-04_d4', 'run_2026-01-05_e5', 'run_2026-01-06_f6'];
  for (const n of names) { fs.mkdirSync(path.join(runs, n)); fs.writeFileSync(path.join(runs, n, 'x'), 'x'); }
  const ledger = path.join(root, 'ledger.json');
  fs.writeFileSync(ledger, JSON.stringify({ classes: { c: { champions: { m: { xisfPath: `${runs}/run_2026-01-01_a1/g/image.xisf` } } } } }));
  const protect = collectProtectedRuns({ runId: 'run_2026-01-06_f6', baseRun: 'run_2026-01-02_b2', ledgerPath: ledger, approvedPath: path.join(root, 'none.json') });
  // Fresh fixture dirs are all 'recent': the default 24 h protection would keep everything.
  assert.deepStrictEqual(cleanOldRuns({ runsDir: runs, keep: 3, protect, log: () => {} }).map(d => d.name), []);
  const del = cleanOldRuns({ runsDir: runs, keep: 3, protect, log: () => {}, minAgeMs: 0 });
  // candidates (oldest 3): a1 protected, b2 protected, c3 deleted -> only 1 beyond keep... verify with keep=2
  assert.deepStrictEqual(del.map(d => d.name), ['run_2026-01-03_c3']);
  const del2 = cleanOldRuns({ runsDir: runs, keep: 1, protect, log: () => {}, minAgeMs: 0 });
  assert.deepStrictEqual(del2.map(d => d.name).sort(), ['run_2026-01-04_d4', 'run_2026-01-05_e5']);
  assert.ok(fs.existsSync(path.join(runs, 'run_2026-01-01_a1')) && fs.existsSync(path.join(runs, 'run_2026-01-02_b2')));
});

test('cleanOrphanSwap deletes only entries older than PI start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi24swap-'));
  const old = path.join(dir, '~PI~old.swp'), neu = path.join(dir, '~PI~new.swp'), other = path.join(dir, 'keepme');
  for (const p of [old, neu, other]) fs.writeFileSync(p, 'x');
  const st = fs.statSync(neu);
  const piStart = st.birthtimeMs - 5000;
  // make "old" older by backdating birthtime is not possible; instead use a PI start after both, then before both
  let r = cleanOrphanSwap({ swapDir: dir, piStartMs: piStart, log: () => {} });
  assert.strictEqual(r.deleted, 0);
  r = cleanOrphanSwap({ swapDir: dir, piStartMs: Date.now() + 60000, log: () => {} });
  assert.strictEqual(r.deleted, 2);
  assert.ok(fs.existsSync(other));
});
