import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeNbCacheKey, resolveNbOptions } from '../agents/llm/narrowband-prep.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbkey-'));
const mk = (n, c) => { const p = path.join(dir, n); fs.writeFileSync(p, c); return p; };
const F = { S: mk('s.xisf', 'S'), Ha: mk('h.xisf', 'H'), O: mk('o.xisf', 'O'), targetName: 'T' };
const brief = { processingProfile: { stretch: { target_median: 0.12, headroom: 0.08 }, tools: { NXT: { denoise_linear: 0.3, denoise_post_stretch: 0.45, denoise_post_stretch_per_channel: { S: 0.6 } } } } };
const key = (nbOver, f = F, b = brief) => {
  const { nb, target, headroom } = resolveNbOptions(Object.assign({}, f, { narrowband: nbOver }), b, 'SHO');
  return computeNbCacheKey(f, nb, target, headroom);
};

test('palette / hGain / hueShift / scnr do not change the key', () => {
  const k0 = key({});
  assert.equal(key({ palette: 'foraxx' }), k0);
  assert.equal(key({ hGain: 0.5 }), k0);
  assert.equal(key({ hueShift: { strength: 0.2 } }), k0);
  assert.equal(key({ scnr: { amount: 0.1 } }), k0);
});

test('nxtPost / stretchTarget / input files change the key', () => {
  const k0 = key({});
  assert.notEqual(key({ nxtPost: { H: 0.1, S: 0.1, O: 0.1 } }), k0);
  assert.notEqual(key({ stretchTarget: 0.2 }), k0);
  assert.notEqual(key({ nxtLinear: { H: 0.1, S: 0.1, O: 0.1 } }), k0);
  const F2 = Object.assign({}, F, { O: mk('o2.xisf', 'OO') });
  assert.notEqual(key({}, F2), k0);
});

test('profile NXT is honoured (per-channel wins over scalar)', () => {
  const { nb } = resolveNbOptions(F, brief, 'SHO');
  assert.equal(nb.nxtPost.S, 0.6);
  assert.equal(nb.nxtPost.H, 0.45);
  assert.equal(nb.nxtLinear.O, 0.3);
});
