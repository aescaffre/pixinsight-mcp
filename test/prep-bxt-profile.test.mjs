import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bxtSharpenPjsr, resolveBxtOptions, resolveHdrOptions } from '../agents/llm/deterministic-prep.mjs';

const profiles = JSON.parse(fs.readFileSync(new URL('../agents/processing-profiles.json', import.meta.url), 'utf8'));
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// The pre-WI-23 hardcoded sharpen PJSR (RGB variant).
const legacy = (id) => `
    var P=new BlurXTerminator;
    P.correct_only=false;P.sharpen_nonstellar=0.70;P.adjust_star_halos=0.00;
    P.AI_file='';P.device=0;
    P.executeOn(ImageWindow.windowById('${id}').mainView);
  `;

test('correct_only:true skips the sharpen step', () => {
  const bxt = resolveBxtOptions({ processingProfile: { tools: { BXT: { correct_only: true } } } });
  assert.equal(bxtSharpenPjsr('Target', bxt), null);
});

test('missing BXT profile also skips (no implicit sharpen)', () => {
  assert.equal(bxtSharpenPjsr('Target', resolveBxtOptions({})), null);
});

test('shipped profiles produce PJSR identical to the legacy hardcoded sharpen', () => {
  let n = 0;
  for (const [k, p] of Object.entries(profiles)) {
    if (!p.tools?.BXT) continue;
    n++;
    const out = bxtSharpenPjsr('Target', resolveBxtOptions({ processingProfile: p }));
    assert.equal(norm(out), norm(legacy('Target')), k);
    assert.equal(p.stretch.hdr_amount, 0.25, k);
    assert.equal(p.stretch.hdr_knee, 0.35, k);
    assert.deepEqual(resolveHdrOptions({ processingProfile: p }), { hdrAmount: 0.25, hdrKnee: 0.35 });
  }
  assert.equal(n, 13);
});

test('sharpen strength is interpolated; HDR falls back to 0.25/0.35', () => {
  const out = bxtSharpenPjsr('X', { correct_only: false, sharpen_nonstellar: 0.3 });
  assert.match(out, /sharpen_nonstellar=0\.30;/);
  assert.deepEqual(resolveHdrOptions({}), { hdrAmount: 0.25, hdrKnee: 0.35 });
});
