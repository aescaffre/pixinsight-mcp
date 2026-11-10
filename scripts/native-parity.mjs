#!/usr/bin/env node
// Parity harness: every native-wired metric, PJSR (…Pjsr) vs Rust (pixmetrics), on images opened in PixInsight.
//   node scripts/native-parity.mjs --image a.xisf [--image b.xisf] --inv prep-metrics.json [--only name,name]
// Prints per-metric timings and the largest relative difference over all numeric leaves.
import fs from 'fs';
import { createBridgeContext } from '../agents/ops/bridge.mjs';
import * as SM from '../agents/ops/subject-metrics.mjs';
import * as QG from '../agents/ops/quality-gates.mjs';
import * as ST from '../agents/ops/stats.mjs';
import { measureNative, nativeStats } from '../agents/ops/native-metrics.mjs';

const argv = process.argv.slice(2);
const all = (k) => argv.flatMap((a, i) => a === k ? [argv[i + 1]] : []);
const images = all('--image');
const pm = JSON.parse(fs.readFileSync(all('--inv')[0], 'utf-8'));
const inv = pm.inventory, rDisc = pm.baselineDetail?.scale?.rDisc;
const only = all('--only')[0]?.split(',');
const REF = all('--ref')[0];

const CASES = [
  ['palette_purity', { inv }, (c, v) => SM.measurePalettePurityPjsr(c, v, inv)],
  ['nucleus', { inv }, (c, v) => SM.measureNucleusPjsr(c, v, inv)],
  ['core_amp', { inv }, (c, v) => SM.measureCoreAmpPjsr(c, v, inv)],
  ['core_spectrum', { inv, opts: {} }, (c, v) => SM.measureCoreSpectrumPjsr(c, v, inv)],
  ['core_texture', { inv, opts: {} }, (c, v) => SM.measureCoreTexturePjsr(c, v, inv)],
  ['core_troughs', { inv, opts: {} }, (c, v) => SM.measureCoreTroughsPjsr(c, v, inv)],
  ['core_contrast', { classification: 'galaxy_spiral' }, (c, v) => SM.measureCoreContrastPjsr(c, v, 'galaxy_spiral')],
  ['zone_structure', { inv }, (c, v) => SM.measureZoneStructurePjsr(c, v, inv)],
  ['inventory_zones', { inv }, (c, v) => SM.measureInventoryZonesPjsr(c, v, inv)],
  ['envelope_sectors', { inv }, (c, v) => SM.measureEnvelopeSectorsPjsr(c, v, inv)],
  ['sector_profiles', { inv, opts: {} }, (c, v) => SM.measureSectorProfilesPjsr(c, v, inv)],
  ['arm_gap_depth', { inv }, (c, v) => SM.measureArmGapDepthPjsr(c, v, inv)],
  ['outer_arms', { r0: inv.zones.outer[0], r1: inv.zones.outer[1], sigma: 8 }, (c, v) => SM.measureOuterArmsPjsr(c, v, inv.zones.outer[0], inv.zones.outer[1], 8)],
  ['faint_disc', {}, (c, v) => SM.measureFaintDiscPjsr(c, v)],
  ['scale_bands', { opts: { rDisc } }, (c, v) => SM.measureScaleBandsPjsr(c, v, { rDisc })],
  ['disc_mottle', { opts: { radius: rDisc } }, (c, v) => SM.measureDiscMottlePjsr(c, v, { radius: rDisc })],
  ['background_noise', { opts: {} }, (c, v) => SM.measureBackgroundNoisePjsr(c, v, {})],
  ['background_floor', {}, (c, v) => SM.measureBackgroundFloorPjsr(c, v)],
  ['subject_detail', { opts: {} }, (c, v) => SM.measureSubjectDetailPjsr(c, v, {})],
  ['dust_coverage', { ifnCfg: {} }, (c, v) => SM.measureDustCoveragePjsr(c, v, {})],
  ['subject_roi', {}, (c, v) => SM.locateSubjectROIPjsr(c, v)],
  ['chroma_noise', { opts: {} }, (c, v) => SM.measureChromaNoisePjsr(c, v, {})],
  ['saturation', {}, (c, v) => QG.checkSaturationPjsr(c, v)],
  ['burn', { opts: {} }, (c, v) => QG.assessBurnPjsr(c, v, {})],
  ['scan_burnt_regions', { opts: {} }, (c, v) => QG.scanBurntRegionsPjsr(c, v, {})],
  ['ringing', {}, (c, v) => QG.checkRingingPjsr(c, v)],
  ['shell_texture', { opts: {} }, (c, v) => QG.measureShellTexturePjsr(c, v, {})],
  ['color_gradient', { opts: {} }, (c, v) => ST.measureColorGradientPjsr(c, v, {})],
  ['star_quality', {}, (c, v) => QG.checkStarQualityPjsr(c, v, {})],
  ['tonal_presence', { category: 'galaxy_spiral' }, (c, v) => QG.checkTonalPresencePjsr(c, v, 'galaxy_spiral')],
  ['bright_chroma', { brightnessThreshold: 0.5 }, (c, v) => QG.checkBrightChromaPjsr(c, v, 0.5)],
  ['star_layer_integrity', {}, (c, v) => QG.checkStarLayerIntegrityPjsr(c, v)],
  ...(REF ? [['compare_reference', { reference_path: REF }, (c, v) => SM.compareToReferencePjsr(c, v, REF)]] : []),
].filter(c => !only || only.includes(c[0]));

function leaves(o, p = '', out = {}) {
  if (typeof o === 'number') out[p] = o;
  else if (Array.isArray(o)) o.forEach((v, i) => leaves(v, `${p}[${i}]`, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) leaves(v, p ? `${p}.${k}` : k, out);
  return out;
}
function diff(a, b) {
  const A = leaves(a), B = leaves(b); let worst = { k: null, rel: 0, a: null, b: null }, missing = [];
  for (const [k, va] of Object.entries(A)) {
    if (!(k in B)) { missing.push(k); continue; }
    const vb = B[k], rel = Math.abs(va - vb) / Math.max(1e-9, Math.abs(va), Math.abs(vb));
    if (rel > worst.rel) worst = { k, rel, a: va, b: vb };
  }
  return { worst, missing, n: Object.keys(A).length };
}

const ctx = createBridgeContext({ log: () => {} });
for (const img of images) {
  await ctx.pjsr(`var ws = ImageWindow.open('${img}'); for (var i = 0; i < ws.length; i++) { if (ws[i].mainView.id.indexOf('crop_mask') >= 0) ws[i].forceClose(); else ws[i].mainView.id = 'PARITY'; } 'ok'`);
  console.log(`\n=== ${img}`);
  let tP = 0, tN = 0;
  for (const [name, params, pj] of CASES) {
    let a, b, e1 = null, e2 = null;
    let t = Date.now(); try { a = await pj(ctx, 'PARITY'); } catch (e) { e1 = e.message; } const dp = Date.now() - t; tP += dp;
    t = Date.now(); try { b = (await measureNative(ctx, 'PARITY', [{ name, params }]))[name]; } catch (e) { e2 = e.message; } const dn = Date.now() - t; tN += dn;
    if (e1 || e2) { console.log(`${name.padEnd(20)} PJSR ${dp}ms native ${dn}ms  ERROR pjsr=${e1} native=${e2}`); continue; }
    const d = diff(a, b);
    const flag = d.worst.rel > 0.01 ? 'DIFF' : (d.worst.rel > 1e-4 ? 'close' : 'same');
    console.log(`${name.padEnd(20)} PJSR ${String(dp).padStart(6)}ms native ${String(dn).padStart(5)}ms  ${flag.padEnd(5)} worst ${d.worst.k ?? '-'} ${d.worst.a ?? ''} vs ${d.worst.b ?? ''} (rel ${d.worst.rel.toExponential(1)})${d.missing.length ? ' missing:' + d.missing.slice(0, 4).join(',') : ''} [${d.n} leaves]`);
  }
  console.log(`TOTAL PJSR ${(tP / 1000).toFixed(1)} s, native ${(tN / 1000).toFixed(1)} s`);
  await ctx.safeClose('PARITY', 200);
}
console.log(JSON.stringify(nativeStats()));
