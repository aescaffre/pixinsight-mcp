// ============================================================================
// C-TIER COMPOSER (deterministic) — Phase 1: core graft + no-regression A/B judge.
//
// The core specialist produces an improved version of the mega-winner (it was told to
// touch ONLY the core). The composer does NOT trust that — it grafts ONLY the core
// region from the specialist back into the PRISTINE mega-winner through a feathered core
// mask, so the surroundings (the loved brown IFN) are guaranteed identical to the
// mega-winner and only the core can change. No brightness scaling is needed: the
// specialist worked on a clone of the mega-winner, so core brightness already matches —
// this is what avoids the blown-halo seam of a naive graft.
//
// The judge then runs a STRICT no-regression A/B using the validated metrics only
// (never a free vision score). The merge is exported ONLY if the core improves AND
// nothing else regresses AND it passes the hard gates — so C-tier can only improve or tie.
// ============================================================================
import fs from 'fs';
import path from 'path';
import {
  measureCoreContrast, measureDustCoverage, measureBackgroundNoise, measureSubjectDetail,
} from '../ops/subject-metrics.mjs';

async function openAs(ctx, filePath, id) {
  const r = await ctx.pjsr(`
    var a = ImageWindow.open('${filePath.replace(/'/g, "\\'")}');
    var w = a[0];
    for (var i = 1; i < a.length; i++) a[i].forceClose();
    w.mainView.id = '${id}';
    var im = w.mainView.image;
    JSON.stringify({ w: im.width, h: im.height, color: im.isColor });
  `);
  if (r.status === 'error') throw new Error(`composer openAs(${id}): ${r.error?.message || r.result}`);
  return JSON.parse(r.result || r.outputs?.consoleOutput || '{}');
}
async function closeId(ctx, id) { await ctx.pjsr(`var w=ImageWindow.windowById('${id}');if(!w.isNull)w.forceClose();`); }

/**
 * Graft the specialist's core region into a pristine copy of the mega-winner.
 * @returns {string} path to the merged XISF
 */
export async function composeCore(ctx, { megaPath, specPath, outPath, log = console.log }) {
  const base = await openAs(ctx, megaPath, 'CMP_BASE');   // pristine mega-winner (gets grafted in place)
  const donor = await openAs(ctx, specPath, 'CMP_CORE');  // specialist output
  if (base.w !== donor.w || base.h !== donor.h) {
    await closeId(ctx, 'CMP_BASE'); await closeId(ctx, 'CMP_CORE');
    throw new Error(`composeCore geometry mismatch: base ${base.w}x${base.h} vs spec ${donor.w}x${donor.h}`);
  }
  // Feathered core mask from BASE luminance: 1 inside the bright core, 0 in the field.
  // Threshold derived from the image (bg + fraction*(peak-bg)) so it adapts per target
  // (reflection core vs galaxy bulge), feathered so the graft seam is invisible.
  const t = await ctx.pjsr(`
    var b=ImageWindow.windowById('CMP_BASE').mainView.image; var W=b.width,H=b.height,isC=b.isColor;
    function L(x,y){return isC?0.2126*b.sample(x,y,0)+0.7152*b.sample(x,y,1)+0.0722*b.sample(x,y,2):b.sample(x,y);}
    var bg=b.median(); var coarse=[];
    for(var y=4;y<H-4;y+=24)for(var x=4;x<W-4;x+=24)coarse.push(L(x,y));
    coarse.sort(function(a,b){return a-b;});
    var peak=coarse[Math.floor(coarse.length*0.999)]; if(peak<=bg)peak=coarse[coarse.length-1];
    JSON.stringify({ lo: bg+0.45*(peak-bg), hi: bg+0.70*(peak-bg) });
  `);
  const { lo, hi } = JSON.parse(t.result || t.outputs?.consoleOutput);
  log(`  [composer] core graft mask: feather ${lo.toFixed(3)}..${hi.toFixed(3)} (no brightness scaling)`);
  // Per-channel: out = BASE*(1-m) + CMP_CORE*m, m = smoothstep(BASE lum, lo, hi).
  const chain = `Lb = 0.2126*$T[0]+0.7152*$T[1]+0.0722*$T[2]; m = max(0, min(1, (Lb - ${lo})/(${hi} - ${lo})))`;
  await ctx.pjsr(`
    var w=ImageWindow.windowById('CMP_BASE');
    var P=new PixelMath;
    P.expression='${chain}; $T*(1-m) + CMP_CORE[0]*m';
    P.expression1='${chain}; $T*(1-m) + CMP_CORE[1]*m';
    P.expression2='${chain}; $T*(1-m) + CMP_CORE[2]*m';
    P.symbols='Lb, m';
    P.useSingleExpression=false; P.use64BitWorkingImage=true;
    P.truncate=true; P.truncateLower=0; P.truncateUpper=1; P.createNewImage=false;
    P.executeOn(w.mainView);
    w.saveAs('${outPath.replace(/'/g, "\\'")}', false, false, false, false);
    'merged';
  `);
  await closeId(ctx, 'CMP_BASE'); await closeId(ctx, 'CMP_CORE');
  return outPath;
}

async function measureAll(ctx, viewId, profile) {
  const out = {};
  try { out.core = await measureCoreContrast(ctx, viewId, profile?._classification, profile?.core_burn); } catch {}
  try { out.dust = await measureDustCoverage(ctx, viewId, profile?.ifn); } catch {}
  try { out.noise = await measureBackgroundNoise(ctx, viewId); } catch {}
  try { out.detail = await measureSubjectDetail(ctx, viewId); } catch {}
  return out;
}

/**
 * Strict no-regression A/B. The merge wins ONLY if the core genuinely improves AND
 * nothing the user cares about regresses AND the merge passes the hard gates.
 * @returns {{winner:'merged'|'mega', reason:string, mega:object, merged:object}}
 */
export async function judgeAB(ctx, { megaPath, mergedPath, profile, log = console.log }) {
  await openAs(ctx, megaPath, 'JDG_MEGA');
  const mega = await measureAll(ctx, 'JDG_MEGA', profile);
  await closeId(ctx, 'JDG_MEGA');
  await openAs(ctx, mergedPath, 'JDG_MERGED');
  const merged = await measureAll(ctx, 'JDG_MERGED', profile);
  await closeId(ctx, 'JDG_MERGED');

  const EPS_DUST = 0.03;    // dust coverage may not drop more than 3pp
  const EPS_SAT = 0.03;     // dust saturation tolerance
  const EPS_NOISE = 0.003;  // noise may not rise more than this

  // Core improvement: structure up (the real signal) without introducing a halo.
  const mStruct = merged.core?.coreStructFrac ?? 0, gStruct = mega.core?.coreStructFrac ?? 0;
  const mHalo = merged.core?.haloFrac ?? 1, gHalo = mega.core?.haloFrac ?? 0;
  const mRel = merged.core?.coreRelContrast ?? 0, gRel = mega.core?.coreRelContrast ?? 0;
  const coreImproved = (mStruct > gStruct + 0.01 || mRel > gRel + 0.02) && mHalo <= gHalo + 0.005;

  // Hard gate: merged core must itself pass (struct/halo/white/relContrast per profile).
  const mergedCorePasses = merged.core?.pass !== false;

  // No-regression on the surroundings the user loves + noise.
  const dustOk = (merged.dust?.dustCoverage ?? 0) >= (mega.dust?.dustCoverage ?? 0) - EPS_DUST
              && (merged.dust?.dustMeanSat ?? 0) >= (mega.dust?.dustMeanSat ?? 0) - EPS_SAT;
  const noiseOk = (merged.noise?.bgNoise ?? 0) <= (mega.noise?.bgNoise ?? 1) + EPS_NOISE
               && (merged.noise?.dustNoise ?? 0) <= (mega.noise?.dustNoise ?? 1) + EPS_NOISE;

  const win = coreImproved && mergedCorePasses && dustOk && noiseOk;
  const reason = win
    ? `core struct ${(gStruct*100).toFixed(0)}%→${(mStruct*100).toFixed(0)}% / relC ${gRel.toFixed(2)}→${mRel.toFixed(2)}, halo ${(gHalo*100).toFixed(1)}%→${(mHalo*100).toFixed(1)}%, dust+noise preserved`
    : `no clear win (coreImproved=${coreImproved} corePasses=${mergedCorePasses} dustOk=${dustOk} noiseOk=${noiseOk}) — keeping mega-winner`;
  log(`  [judge] ${win ? 'MERGE WINS' : 'MEGA KEPT'}: ${reason}`);
  return { winner: win ? 'merged' : 'mega', reason, mega, merged };
}

/**
 * Pure helper: choose the best core-specialist candidate against the mega baseline using
 * the judgeAB core win condition (struct >= base+0.01 OR relC >= base+0.02) AND
 * halo <= base+0.005 AND the core check still passes (pass !== false).
 * candidates: [{path, label, core:{coreStructFrac, haloFrac, coreRelContrast, pass}|null, error?}]
 * Falls back to the candidate labelled fallbackLabel (default 'CORE_WORK'), then to null
 * (caller keeps the mega winner) when nothing was measurable.
 * @returns {{chosen: object|null, reason: string, wins: object[]}}
 */
export function selectCoreCandidate(baselineCore, candidates, { fallbackLabel = 'CORE_WORK' } = {}) {
  const b = baselineCore || {};
  const bS = b.coreStructFrac ?? 0, bH = b.haloFrac ?? 0, bR = b.coreRelContrast ?? 0;
  const wins = [];
  for (const c of candidates || []) {
    const m = c && c.core;
    if (!m || c.error) continue;
    const s = m.coreStructFrac ?? 0, h = m.haloFrac ?? 1, r = m.coreRelContrast ?? 0;
    const improved = (s >= bS + 0.01 || r >= bR + 0.02) && h <= bH + 0.005;
    if (improved && m.pass !== false) {
      wins.push({ ...c, gain: (s - bS) + (r - bR) - Math.max(0, h - bH) });
    }
  }
  if (wins.length) {
    wins.sort((a, z) => z.gain - a.gain);
    return { chosen: wins[0], wins, reason: `best of ${wins.length} winning candidate(s): ${wins[0].label}` };
  }
  const fb = (candidates || []).find(c => c && c.label === fallbackLabel && c.path);
  if (fb) return { chosen: fb, wins, reason: `no candidate meets the win condition; falling back to ${fallbackLabel}` };
  return { chosen: null, wins, reason: 'no usable candidate; keep mega winner' };
}

/**
 * Measure core contrast on each file sequentially (one window open at a time, closed after).
 * Never throws: per-candidate failures are returned as {error}.
 */
export async function measureCoreCandidates(ctx, items, profile, log = console.log) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const id = 'CORE_CAND';
    try {
      await openAs(ctx, it.path, id);
      const core = await measureCoreContrast(ctx, id, profile?._classification, profile?.core_burn);
      out.push({ ...it, core });
      log(`  [core-select] ${it.label}: struct=${((core.coreStructFrac ?? 0) * 100).toFixed(0)}% halo=${((core.haloFrac ?? 0) * 100).toFixed(1)}% relC=${(core.coreRelContrast ?? 0).toFixed(2)} pass=${core.pass}`);
    } catch (e) {
      out.push({ ...it, core: null, error: e.message });
      log(`  [core-select] ${it.label}: measure error ${e.message}`);
    } finally {
      try { await closeId(ctx, id); } catch {}
    }
  }
  return out;
}
