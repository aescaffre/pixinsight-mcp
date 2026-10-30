import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { profileFor } = await import(path.join(ROOT, 'agents/classifier.mjs'));
const tools = await import(path.join(ROOT, 'agents/llm/tools.mjs'));
const { handlers } = tools.buildToolSet('giga_orchestrator');

// Mock bridge ctx: every PJSR call "succeeds" with stats-shaped output.
const ctx = { pjsr: async () => ({ status: 'ok', outputs: { consoleOutput: JSON.stringify({ median: 0.1, mad: 0.01, min: 0, max: 0.5 }) } }) };

function brief(cls) {
  return {
    target: { classification: cls },
    processingProfile: profileFor(cls, false, 'LRGB'),
    _starIntegrity: { stars: { verdict: 'PASS', turnsAgo: 0, median: 0.05, nonzero_pixel_count: 1000 } },
  };
}

test('star_protected_blend: planetary_nebula defaults come from profile', async () => {
  const r = await handlers.get('star_protected_blend')(ctx, null, brief('planetary_nebula'), { target_id: 't', stars_id: 'stars' });
  assert.match(r.text, /core=\[0\.75,0\.95\], min_frac=0\.5/);
  assert.match(r.text, /profile:planetary_nebula/);
});

test('star_protected_blend: unknown class falls back to defaults and says so', async () => {
  const b = brief('dark_nebula');
  const r = await handlers.get('star_protected_blend')(ctx, null, b, { target_id: 't', stars_id: 'stars' });
  assert.match(r.text, /core=\[0\.6,0\.82\], min_frac=0\.1/);
  assert.match(r.text, /core_threshold_low=0\.6 \(default\)/);
});

test('star_protected_blend: agent value wins and is labelled', async () => {
  const r = await handlers.get('star_protected_blend')(ctx, null, brief('planetary_nebula'), { target_id: 't', stars_id: 'stars', core_threshold_low: 0.5 });
  assert.match(r.text, /core_threshold_low=0\.5 \(agent\)/);
});

test('star_protected_blend: profile cap announced and traced for any class that defines it', async () => {
  const r = await handlers.get('star_protected_blend')(ctx, null, brief('galaxy_spiral'), { target_id: 't', stars_id: 'stars', strength: 1.2 });
  assert.match(r.text, /^PROFILE CAP \(galaxy_spiral\): blend requested 1\.2 → applied 0\.95/);
  assert.equal(r.profileCaps[0].key, 'stars.screen_blend_strength');
  const r2 = await handlers.get('star_protected_blend')(ctx, null, brief('supernova_remnant'), { target_id: 't', stars_id: 'stars', strength: 1.0 });
  assert.match(r2.text, /PROFILE CAP \(supernova_remnant\)/);
});
