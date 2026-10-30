import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { evaluateLUsage, isLDerived, pixelmathReferencesL, recordLUsage } from '../agents/llm/tools.mjs';

test('provenance: inject_l_ifn passes', () => {
  assert.equal(evaluateLUsage({ _lUsage: [{ tool: 'inject_l_ifn', viewId: 'x', seq: 3 }] }, null), true);
});
test('empty _lUsage + unrelated pixelmath trace fails', () => {
  const trace = [
    JSON.stringify({ tool: 'get_image_stats', args: { view_id: 'FILTER_L' } }),
    JSON.stringify({ tool: 'run_pixelmath', args: { view_id: 'a', expression: '$T*1.1' } }),
  ].join('\n');
  assert.equal(evaluateLUsage({ _lUsage: [] }, trace), false);
  assert.equal(evaluateLUsage({}, trace), false);
});
test('trace fallback accepts pixelmath with FILTER_L', () => {
  const trace = JSON.stringify({ tool: 'run_pixelmath', args: { expression: '0.5*FILTER_L+$T' } });
  assert.equal(evaluateLUsage({}, trace), true);
});
test('trace fallback on real run efe2138e', () => {
  const f = os.homedir() + '/.pixinsight-mcp/runs/run_2026-06-23_efe2138e/trace.jsonl';
  if (!fs.existsSync(f)) return;
  assert.equal(evaluateLUsage({}, fs.readFileSync(f, 'utf-8')), true);
});
test('clone chain + helpers', () => {
  const b = { _lUsage: [], _lRoots: ['L_bak'] };
  assert.ok(isLDerived('FILTER_L', b) && isLDerived('L_bak', b) && !isLDerived('other', b));
  assert.ok(pixelmathReferencesL({ expression: '$T+L_bak' }, b));
  assert.ok(!pixelmathReferencesL({ expression: '$T*2' }, b));
  recordLUsage(b, 'inject_luminance', 'v');
  assert.equal(b._lUsage.length, 1);
  const c = {}; recordLUsage(c, 'x', 'v'); assert.equal(c._lUsage, undefined);
});
