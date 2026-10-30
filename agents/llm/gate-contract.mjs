// ============================================================================
// gate-contract.mjs — single source of truth for finish-gate constants.
//
// Before WI-01 these numbers were inlined in the finish handler (tools.mjs) and
// again in the metric functions (subject-metrics.mjs, quality-gates.mjs). They
// now live here so the prompt gate table (buildGateTable), the finish handler,
// the metric text and the back-test harness cannot drift apart.
//
// Per-class overrides: processing-profiles.json may carry optional keys (see
// OVERRIDE_KEYS). An override is only honoured when the SAME object also carries
// a `_calibration` string explaining which approved image it was back-tested on.
// ============================================================================

export const BURN_CLIP = 0.95;
export const BRIGHT_BLOCK_LEVEL = 0.80;
export const NOISE_BG_HARD = 0.022;
export const NOISE_DUST_HARD = 0.040;
export const SUBJECT_MIN = 0.25;
export const CONTRAST_GATE = 3.0;
export const CONTRAST_GATE_OUTER_HALO = 2.0;
export const DETAIL_MIN = 0.001;
export const SAT_HARD_MARGIN = 0.10;

/**
 * Single source for the Gate 7 saturation numbers (used by the finish gate, the nearest-margin
 * diagnostics and the prompt gate table). The BLOCKING level is always profile.saturation.max_p90
 * + SAT_HARD_MARGIN: `look.max_p90` / `look.target_p90` are PROVISIONAL (not back-tested on an
 * approved galaxy) and only drive the advisory warning tier.
 */
export function saturationLimits(profile) {
  const look = profile?.look;
  const maxP90 = profile?.saturation?.max_p90 ?? 0.65;
  const warnAt = look?.target_p90 ?? maxP90;
  const failAt = Math.max(maxP90 + SAT_HARD_MARGIN, warnAt);
  return { maxP90, warnAt, failAt, targetP90: look?.target_p90, lookMaxP90: look?.max_p90 };
}
export const TONAL = 3.0;
export const TONAL_SMALL = 2.5;            // subject coverage < 3%
export const STAR_CONTRAST = { prominent: 4.0, balanced: 3.0, subdued: 2.0 };
export const FWHM_HARD = 12;               // galaxies exempt
export const STAR_COUNT_WARN = 20;
// WI-16: star-field metric (measureStarField). ALL ADVISORY and PROVISIONAL until back-tested (scripts/backtest-gates.mjs).
export const STAR_FWHM_ADVISORY = 8;            // px, advisory (FWHM_HARD stays the blocking limit)
export const STAR_ELLIPTICITY_WARN = 0.25;      // 1 - b/a
export const STAR_DARK_RING_WARN = 0.05;        // ring depth as a fraction of star prominence
export const STAR_CENTER_RADIUS_FRAC = 0.55;    // x half-diagonal (NOT min(W,H)/2: inside the 3590 px ASI6200 corrected circle)
export const STAR_KNOT_RATIO = 0.6;             // compactness: neighbour/peak (above local bg) >= this -> nebula knot
export const STAR_SATURATED = 0.98;             // saturated plateau skipped
export const RINGING_WARN = 3;
export const REF_COLOR_EMD = 0.25;
export const REF_COVERAGE_DELTA = 0.30;
// WI-21: ADVISORY (warning) thresholds for the reworked reference metrics. PROVISIONAL until
// scripts/backtest-gates.mjs shows pacman_lift5 vs itself ~0, vs pacman_iter01 above them,
// and ngc7023_best_of_both vs ngc7023_iter03 below them.
export const REF_PALETTE_L1 = 0.35;
export const REF_LAB_EMD = 12;

/** Optional per-class override keys read from processing-profiles.json. */
export const OVERRIDE_KEYS = [
  'stars.fwhm_hard', 'stars.min_contrast', 'tonal.min_separation', 'detail.min_detail',
  'core_burn.rel_contrast_hard', 'core_burn.white_hard', 'noise.bg_hard', 'noise.dust_hard',
  'texture.min_retention', 'aesthetic_gate.min_score',
  'reference.max_color_emd', 'reference.max_coverage_delta',
  'reference.max_palette_l1', 'reference.max_lab_emd',
  'burn.max_clip_blocks',
  'background.min_level', 'background.max_black_fraction', 'stars.min_density_per_mpx',   // 2026-10-29 crushed-background gates
];

function splitKey(key) {
  const i = key.indexOf('.');
  return [key.slice(0, i), key.slice(i + 1)];
}

/**
 * Resolve a gate threshold. Returns the profile override when present AND the
 * enclosing object has a `_calibration` string; otherwise the code default.
 * An override without `_calibration` is ignored (warned on stderr) — it is a
 * profile authoring error that validateProfileCalibration() reports in tests.
 */
export function gateThreshold(profile, key, codeDefault) {
  if (!profile || typeof profile !== 'object') return codeDefault;
  const [group, field] = splitKey(key);
  const g = profile[group];
  if (!g || typeof g !== 'object' || g[field] === undefined || g[field] === null) return codeDefault;
  if (typeof g._calibration !== 'string' || !g._calibration.trim()) {
    process.stderr.write(`[gate-contract] ignoring uncalibrated override ${key}=${g[field]} (profile.${group}._calibration missing)\n`);
    return codeDefault;
  }
  return g[field];
}

/** Returns a list of problems: overrides present without a `_calibration` string. */
export function validateProfileCalibration(profile) {
  const problems = [];
  for (const key of OVERRIDE_KEYS) {
    const [group, field] = splitKey(key);
    const g = profile?.[group];
    if (g && typeof g === 'object' && g[field] !== undefined && g[field] !== null &&
        (typeof g._calibration !== 'string' || !g._calibration.trim())) {
      problems.push(`${key} override without ${group}._calibration`);
    }
  }
  return problems;
}

/** Contrast gate minimum for a faintStructureGoal value. */
export function contrastGateFor(faintStructureGoal) {
  return faintStructureGoal === 'outer_halo' ? CONTRAST_GATE_OUTER_HALO : CONTRAST_GATE;
}

/** Star brightness minimum contrast for a profile (prominence + override). */
export function starMinContrast(profile) {
  const prominence = profile?.stars?.prominence || 'balanced';
  const def = STAR_CONTRAST[prominence] ?? STAR_CONTRAST.balanced;
  return gateThreshold(profile, 'stars.min_contrast', def);
}

/**
 * One row per finish gate, resolved from the brief. Used by WI-09 to render a
 * single table in the prompt, and by the contract test.
 * Row: {gate, tool, threshold, predicateText, status, relaxation, thresholdKey, codeDefault}
 */
export function buildGateTable(brief) {
  const profile = brief?.processingProfile || {};
  const classification = brief?.target?.classification || 'unknown';
  const faint = brief?.target?.fieldCharacteristics?.faintStructureGoal;
  const starless = !!brief?.dataDescription?.starless;
  const narrowband = !!brief?.dataDescription?.narrowband;
  const isGalaxy = classification.startsWith('galaxy');
  const emergency = 'Relaxed to a warning when <=10 turns remain (emergency budget).';
  const rows = [];
  const add = (gate, tool, threshold, predicateText, status, relaxation, thresholdKey = null, codeDefault = null) =>
    rows.push({ gate, tool, threshold, predicateText, status, relaxation, thresholdKey, codeDefault });

  const starC = starMinContrast(profile);
  add('stars_brightness', 'check_star_quality', starC, `star/background contrast >= ${starC}x`,
    starless ? 'SKIPPED' : 'BLOCKING', starless ? 'Starless deliverable.' : emergency,
    'stars.min_contrast', STAR_CONTRAST[profile?.stars?.prominence || 'balanced'] ?? STAR_CONTRAST.balanced);
  const fwhm = gateThreshold(profile, 'stars.fwhm_hard', FWHM_HARD);
  add('stars_fwhm', 'check_star_quality', fwhm, `median FWHM <= ${fwhm}px`,
    starless ? 'SKIPPED' : (isGalaxy ? 'WARNING' : 'BLOCKING'),
    starless ? 'Starless deliverable.' : (isGalaxy ? 'Galaxy: advisory only (HII knots inflate FWHM).' : emergency),
    'stars.fwhm_hard', FWHM_HARD);
  add('star_field', 'check_star_quality', `ell<=${STAR_ELLIPTICITY_WARN}, ring<=${STAR_DARK_RING_WARN}, FWHM<=${STAR_FWHM_ADVISORY}px`,
    'compact-peak star field: centre/edge FWHM, ellipticity, dark rings, absolute prominence (PROVISIONAL)',
    starless ? 'SKIPPED' : 'WARNING', starless ? 'Starless deliverable.' : 'Advisory only until back-tested.');
  const pal = profile?.palette || {};
  add('palette', 'measure_palette_balance',
    `green<=${pal.max_green_frac ?? 0.10}, magenta<=${pal.max_magenta_frac ?? 0.08}, cool>=${pal.min_cool_frac ?? 0.05}`,
    'false-colour palette family fractions within profile limits',
    narrowband ? 'BLOCKING' : 'SKIPPED', narrowband ? emergency : 'Broadband workflow.');
  add('ringing', 'check_ringing', RINGING_WARN, 'ringing score within limit',
    ['galaxy_edge_on', 'galaxy_spiral', 'galaxy_cluster'].includes(classification) ? 'SKIPPED' : 'WARNING',
    'Always advisory; skipped for galaxies with natural radial profiles.');
  add('burn_clip', 'scan_burnt_regions', BURN_CLIP, `no burnt blocks above ${BURN_CLIP}`, 'BLOCKING', 'Not relaxed (safety gate).');
  const maxBright = profile?.burn?.max_bright_block_pct ?? 3.0;
  add('bright_blocks', 'scan_burnt_regions', maxBright, `blocks above ${BRIGHT_BLOCK_LEVEL} <= ${maxBright}% of image`, 'BLOCKING', emergency);
  const relHard = gateThreshold(profile, 'core_burn.rel_contrast_hard', null);
  add('core_contrast', 'check_core_contrast', relHard ?? 'per-class default',
    'extended bright core keeps relative local contrast', 'BLOCKING', emergency);
  add('dust_ifn', 'measure_dust_coverage', profile?.ifn ? 'profile.ifn' : '-',
    'dust colour/coverage/peaks within profile.ifn limits', profile?.ifn ? 'BLOCKING' : 'SKIPPED',
    profile?.ifn ? emergency : 'Profile declares no ifn block.');
  const nbg = gateThreshold(profile, 'noise.bg_hard', NOISE_BG_HARD);
  const nd = gateThreshold(profile, 'noise.dust_hard', NOISE_DUST_HARD);
  add('noise_bg', 'check_noise', nbg, `dark-sky grain <= ${nbg}`, 'BLOCKING', emergency, 'noise.bg_hard', NOISE_BG_HARD);
  add('noise_dust', 'check_noise', nd, `dust-band grain <= ${nd}`, 'BLOCKING', emergency, 'noise.dust_hard', NOISE_DUST_HARD);
  add('subject_brightness', 'measure_subject_detail', SUBJECT_MIN, `subject brightness >= ${SUBJECT_MIN}`, 'BLOCKING', 'Not relaxed.');
  const cg = contrastGateFor(faint);
  add('subject_contrast', 'measure_subject_detail', cg, `contrast ratio >= ${cg}x`, 'BLOCKING', 'Not relaxed.');
  const dmin = gateThreshold(profile, 'detail.min_detail', DETAIL_MIN);
  add('subject_detail', 'measure_subject_detail', dmin, `detail score >= ${dmin}`, 'BLOCKING', 'Not relaxed.', 'detail.min_detail', DETAIL_MIN);
  const tgt = profile?.stretch?.target_median || 0.15;
  add('exposure', 'get_image_stats', +(tgt * 0.35).toFixed(4), `median >= 0.35 x target_median (${tgt})`, 'BLOCKING', 'Not relaxed.');
  const bgMin = gateThreshold(profile, 'background.min_level', null);
  const bgBlack = gateThreshold(profile, 'background.max_black_fraction', null);
  add('background_floor', 'check_background_floor', bgMin ?? 'uncalibrated',
    `sky level >= floor${bgBlack != null ? `; black blocks <= ${Math.round(bgBlack * 100)}%` : ''}`,
    bgMin != null || bgBlack != null ? 'BLOCKING' : 'WARNING', bgMin != null || bgBlack != null ? emergency : 'Advisory until calibrated.',
    bgMin != null ? 'background.min_level' : null, null);
  const dens = gateThreshold(profile, 'stars.min_density_per_mpx', null);
  add('star_retention', 'check_star_quality', dens ?? 'uncalibrated', 'star density (stars/Mpx) above the profile floor',
    starless ? 'SKIPPED' : (dens != null ? 'BLOCKING' : 'WARNING'), starless ? 'Starless deliverable.' : (dens != null ? emergency : 'Advisory until calibrated.'),
    'stars.min_density_per_mpx', null);
  const { maxP90, failAt: satFailAt } = saturationLimits(profile);
  add('saturation', 'check_saturation', +satFailAt.toFixed(2), `subject P90 saturation <= max_p90 (${maxP90}) + ${SAT_HARD_MARGIN}`, 'BLOCKING', emergency);
  const tonal = gateThreshold(profile, 'tonal.min_separation', TONAL);
  add('tonal_presence', 'check_tonal_presence', tonal, `subject/background separation >= ${tonal}x (${TONAL_SMALL}x for small galaxies; advisory at low ROI confidence)`,
    'BLOCKING', emergency, 'tonal.min_separation', TONAL);
  const hasBrightCore = profile?.characteristics?.has_bright_core;
  const texApplies = classification.includes('emission') || isGalaxy || hasBrightCore ||
    brief?.target?.fieldCharacteristics?.structuralZones === 'multi_zone';
  const texBlocking = profile?.highlight_texture?.blocking === true;
  add('highlight_texture', 'check_highlight_texture', 'per-metric', 'bright zones keep tonal variation',
    texApplies ? (texBlocking ? 'BLOCKING' : 'WARNING') : 'SKIPPED',
    texApplies ? (texBlocking ? emergency : 'Advisory until highlight_texture.blocking is calibrated.') : 'Applies to emission/galaxy/bright-core/multi-zone only.');
  const hasL = !!brief?.dataDescription?.channels?.L;
  const lrgbAvoided = profile?.tools?.LRGB?.use === 'avoid';
  add('l_usage', 'lrgb_combine', '-', 'L data incorporated (lrgb_combine or PixelMath L injection)',
    hasL && !lrgbAvoided ? 'BLOCKING' : 'SKIPPED', hasL && !lrgbAvoided ? emergency : 'No L data, or profile avoids LRGB.');
  const minAes = gateThreshold(profile, 'aesthetic_gate.min_score', profile?.min_aesthetic ?? 6.0);
  const aesBlocking = profile?.aesthetic_gate?.blocking === true && Number.isFinite(profile?.aesthetic_gate?.min_score)
    && !starless && !narrowband;
  add('aesthetic', 'aesthetic_critic', minAes, `independent critic score >= ${minAes}/10`,
    aesBlocking ? 'BLOCKING' : 'WARNING', aesBlocking ? emergency : 'Advisory until aesthetic_gate.blocking is calibrated.',
    'aesthetic_gate.min_score', profile?.min_aesthetic ?? 6.0);
  const hasRef = !!(brief?.reference_path || '').trim();
  const cov = gateThreshold(profile, 'reference.max_coverage_delta', REF_COVERAGE_DELTA);
  const pL1 = gateThreshold(profile, 'reference.max_palette_l1', REF_PALETTE_L1);
  const lEmd = gateThreshold(profile, 'reference.max_lab_emd', REF_LAB_EMD);
  add('reference', 'compare_to_reference', `coverage_delta<=${cov} (blocking); palette_l1<=${pL1}, lab_emd<=${lEmd} (advisory warnings); color_emd retired (inert)`,
    'similarity to the registered reference image', hasRef ? 'BLOCKING' : 'SKIPPED', hasRef ? emergency : 'No reference registered.');
  return rows;
}
