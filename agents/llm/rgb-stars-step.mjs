// ============================================================================
// Mandatory RGB-stars finishing step for STARLESS deliverables (2026-11-11, user: "the agent should not finish
// without it"). The agent never blends stars on a starless narrowband run (tools.mjs refuses); this step puts
// the true-colour RGB stars on the exported result with scripts/add-rgb-stars.mjs — ONE screen blend, the only
// star blend of the run.
//
// Config (files.stars):
//   { "rgbConfig": "<R/G/B-only config for add-rgb-stars>",   required
//     "ref": "<narrowband master the stars register onto>",   default files.Ha || files.O || files.S
//     "reuseReg": "<already registered stretched star layer>", optional (skips RGB prep + registration)
//     "peak": 0.88, "satPasses": 2 }                           optional
// A starless run without files.stars refuses to start unless files.deliverStarless === true (explicit opt-out).
// ============================================================================
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'add-rgb-stars.mjs');

/** null = no stars step (run delivers stars itself); { optOut } or { stars } otherwise; throws when misconfigured. */
export function planRgbStars(config, brief) {
  if (!brief?.dataDescription?.starless) return null;
  const f = config.files || {};
  if (f.deliverStarless === true) return { optOut: true };
  const s = f.stars;
  if (!s || !s.rgbConfig) {
    throw new Error('STARLESS deliverable without stars: add files.stars = { rgbConfig, ref?, reuseReg? } to the config '
      + '(RGB star layer added by a single screen blend after export), or set files.deliverStarless: true to opt out explicitly.');
  }
  const ref = s.ref || f.Ha || f.O || f.S;
  for (const [k, p] of [['stars.rgbConfig', s.rgbConfig], ['stars.ref', ref], ...(s.reuseReg ? [['stars.reuseReg', s.reuseReg]] : [])]) {
    if (!p || !fs.existsSync(p)) throw new Error(`files.${k} not found: ${p}`);
  }
  return { stars: { rgbConfig: s.rgbConfig, ref, reuseReg: s.reuseReg || null, peak: s.peak ?? 0.88, satPasses: s.satPasses ?? 2 } };
}

/** Runs add-rgb-stars on the exported starless XISF. Returns { xisf, jpg }; throws on failure. */
export function addRgbStars(plan, starlessXisf, outBase, log = console.log) {
  const s = plan.stars;
  const args = [SCRIPT, '--rgb-config', s.rgbConfig, '--starless', starlessXisf, '--ref', s.ref, '--out', outBase,
    '--peak', String(s.peak), '--sat-passes', String(s.satPasses), ...(s.reuseReg ? ['--reuse-reg', s.reuseReg] : [])];
  log(`  [stars] add-rgb-stars → ${outBase}.xisf${s.reuseReg ? ' (reusing registered star layer)' : ' (RGB prep + registration)'}`);
  execFileSync(process.execPath, args, { stdio: 'inherit', timeout: 3 * 3600 * 1000 });
  const out = { xisf: `${outBase}.xisf`, jpg: `${outBase}.jpg` };
  if (!fs.existsSync(out.xisf)) throw new Error(`add-rgb-stars produced no ${out.xisf}`);
  return out;
}
