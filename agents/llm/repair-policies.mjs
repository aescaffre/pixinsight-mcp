/**
 * repair-policies.mjs — Repair policy engine for quality gate failures.
 *
 * When a quality gate fails, this engine determines the correct repair action
 * based on three inputs:
 *   1. Which gate failed
 *   2. Which tool last modified the image (provenance)
 *   3. The target category
 *
 * Each policy constrains what the agent may do, preventing common mistakes
 * like stacking global desaturation on an already-damaged image instead of
 * fixing the upstream tool that caused the problem.
 */

// ---------------------------------------------------------------------------
// Shared allowed-tool sets
// ---------------------------------------------------------------------------

/** Baseline tools every repair policy allows (diagnostics, safe operations). */
const BASELINE_TOOLS = new Set([
  'get_image_stats',
  'measure_subject_detail',
  'save_variant',
  'save_and_show_preview',
  'clone_image',
  'restore_from_clone',
  'scan_burnt_regions',
  'check_saturation',
  'list_open_images',
  'close_image',
  // finish is the designated verify tool of every policy; it must stay callable in repair
  'finish',
  'run_quality_gates',
  'list_variants',
  'load_variant',
  'create_luminance_mask',
  'apply_mask',
  'remove_mask',
]);

/** Tools commonly allowed during saturation repairs. */
const SATURATION_REPAIR_TOOLS = new Set([
  ...BASELINE_TOOLS,
  'lrgb_combine',
  'inject_luminance',
  'star_protected_blend',
  'check_star_layer_integrity',
  'continuous_clamp',
  'multi_scale_enhance',
  'run_curves',
  'run_pixelmath',
]);

/** Tools commonly allowed during burn repairs. */
const BURN_REPAIR_TOOLS = new Set([
  ...BASELINE_TOOLS,
  'continuous_clamp',
  'multi_scale_enhance',
  'run_hdrmt',
  'run_curves',
  'run_pixelmath',
  'lrgb_combine',
  'star_protected_blend',
  'check_star_layer_integrity',
]);

// ---------------------------------------------------------------------------
// Policy definitions
// ---------------------------------------------------------------------------

const POLICIES = [
  // ---- 1. saturation_after_lrgb ----
  {
    id: 'saturation_after_lrgb',
    description: 'Saturation too high after LRGB composition',
    failureGate: 'check_saturation',
    blocking: true,

    /** Returns true when this policy matches the failure context. */
    matches(gateName, _gateResult, provenance, _category) {
      return (
        gateName === 'check_saturation' &&
        provenance?.tool === 'lrgb_combine'
      );
    },

    requiredActions: [
      { tool: 'restore_from_clone', params: { hint: 'comp_backup' } },
      { tool: 'lrgb_combine', paramAdjustment: { saturation: 'decrease_by_0.20' } },
    ],

    allowedTools: new Set([
      ...SATURATION_REPAIR_TOOLS,
    ]),

    forbiddenTools: new Set(),

    forbiddenPatterns: [
      {
        tool: 'run_curves',
        argPattern: { channel: 'S' },
        reason:
          'No S-curve desaturation on the combined result. ' +
          'Adjust the lrgb_combine saturation parameter instead.',
      },
      {
        tool: 'run_pixelmath',
        argPattern: { _containsDesat: true },
        reason:
          'No global PixelMath desaturation on the combined result. ' +
          'Reduce the lrgb_combine saturation parameter instead.',
      },
    ],

    /**
     * Build a retry ladder relative to the current saturation param value.
     * Falls back to absolute values if current value is unknown.
     */
    buildRetryLadder(provenance) {
      const current = provenance?.params?.saturation;
      if (typeof current === 'number') {
        return [
          Math.max(0, +(current - 0.20).toFixed(2)),
          Math.max(0, +(current - 0.35).toFixed(2)),
          Math.max(0, +(current - 0.45).toFixed(2)),
        ];
      }
      // Absolute fallback ladder
      return [0.60, 0.45, 0.35, 0.25];
    },

    maxRepairTurns: 12,
  },

  // ---- 2. saturation_after_ha_inject ----
  {
    id: 'saturation_after_ha_inject',
    description: 'Saturation too high after narrowband injection',
    failureGate: 'check_saturation',
    blocking: true,

    matches(gateName, _gateResult, provenance, _category) {
      const HA_TOOLS = new Set([
        'ha_inject_red',
        'ha_inject_luminance',
        'dynamic_narrowband_blend',
      ]);
      return (
        gateName === 'check_saturation' &&
        provenance?.tool != null &&
        HA_TOOLS.has(provenance.tool)
      );
    },

    requiredActions: [
      { tool: 'restore_from_clone', params: { hint: 'pre_ha_backup' } },
      { tool: '_rerun_ha_inject', paramAdjustment: { strength: 'decrease_by_0.10' } },
    ],

    allowedTools: new Set([
      ...SATURATION_REPAIR_TOOLS,
      'ha_inject_red',
      'ha_inject_luminance',
      'dynamic_narrowband_blend',
    ]),

    forbiddenTools: new Set(),

    forbiddenPatterns: [
      {
        tool: 'run_curves',
        argPattern: { channel: 'S' },
        reason:
          'No global S-curve desaturation after Ha injection. ' +
          'Reduce the Ha injection strength instead.',
      },
      {
        tool: 'run_pixelmath',
        argPattern: { _containsDesat: true },
        reason:
          'No global PixelMath desaturation after Ha injection. ' +
          'Reduce the Ha injection strength instead.',
      },
    ],

    buildRetryLadder(provenance) {
      const current = provenance?.params?.strength;
      if (typeof current === 'number') {
        return [
          Math.max(0, +(current - 0.10).toFixed(2)),
          Math.max(0, +(current - 0.20).toFixed(2)),
        ];
      }
      return [0.30, 0.20, 0.10];
    },

    maxRepairTurns: 10,
  },

  // ---- 3. burn_after_detail ----
  {
    id: 'burn_after_detail',
    description: 'Burnt regions detected after detail enhancement',
    failureGate: 'scan_burnt_regions',
    blocking: true,

    matches(gateName, _gateResult, provenance, _category) {
      const DETAIL_TOOLS = new Set(['multi_scale_enhance', 'run_hdrmt']);
      return (
        gateName === 'scan_burnt_regions' &&
        provenance?.tool != null &&
        DETAIL_TOOLS.has(provenance.tool)
      );
    },

    requiredActions: [
      // Two possible strategies: restore+re-enhance, or clamp in place.
      // The agent should try restoring first.
      { tool: 'restore_from_clone', params: { hint: 'pre_detail_backup' } },
      {
        tool: '_rerun_detail',
        paramAdjustment: { amount: 'decrease', note: 'Lower enhancement strength or apply continuous_clamp after' },
      },
    ],

    allowedTools: new Set([
      ...BURN_REPAIR_TOOLS,
    ]),

    forbiddenTools: new Set(),

    forbiddenPatterns: [
      {
        tool: 'run_curves',
        argPattern: { _globalDarkening: true },
        reason:
          'Do not stack global darkening curves to fix burns. ' +
          'Restore and re-enhance with lower strength, or use continuous_clamp.',
      },
    ],

    buildRetryLadder(provenance) {
      const current = provenance?.params?.amount;
      if (typeof current === 'number') {
        return [
          Math.max(0, +(current * 0.7).toFixed(3)),
          Math.max(0, +(current * 0.5).toFixed(3)),
          Math.max(0, +(current * 0.3).toFixed(3)),
        ];
      }
      // Can't build meaningful ladder without a known value
      return null;
    },

    maxRepairTurns: 8,
  },

  // ---- 4. burn_after_composition ----
  {
    id: 'burn_after_composition',
    description: 'Burnt regions detected after LRGB combination or star blend',
    failureGate: 'scan_burnt_regions',
    blocking: true,

    matches(gateName, _gateResult, provenance, _category) {
      const COMP_TOOLS = new Set(['lrgb_combine']);
      // Note: star_screen_blend/star_protected_blend burns are now handled by
      // burn_after_star_blend (policy 6), which takes priority due to ordering.
      return (
        gateName === 'scan_burnt_regions' &&
        provenance?.tool != null &&
        COMP_TOOLS.has(provenance.tool)
      );
    },

    requiredActions: [
      {
        tool: 'continuous_clamp',
        params: { note: 'Clamp burns first, or restore and recompose with lower brightness' },
      },
    ],

    allowedTools: new Set([
      ...BURN_REPAIR_TOOLS,
    ]),

    forbiddenTools: new Set(),
    forbiddenPatterns: [],

    buildRetryLadder(_provenance) {
      // No single parameter to ladder; the agent decides between clamp vs recompose
      return null;
    },

    maxRepairTurns: 6,
  },

  // ---- 5. star_color_after_desat ----
  {
    id: 'star_color_after_desat',
    description: 'Star color degraded after desaturation curves',
    failureGate: 'check_star_quality',
    blocking: true,

    matches(gateName, gateResult, provenance, _category) {
      const isColorFailure =
        gateResult?.failedMetrics?.includes('color') ||
        gateResult?.reason?.toLowerCase().includes('color');
      const wasDesatCurve =
        provenance?.tool === 'run_curves' &&
        provenance?.params?.channel === 'S';
      return (
        gateName === 'check_star_quality' &&
        isColorFailure &&
        wasDesatCurve
      );
    },

    requiredActions: [
      { tool: 'restore_from_clone', params: { hint: 'pre_desat_backup' } },
      {
        tool: '_upstream_star_safe',
        paramAdjustment: {
          note: 'Use a star-safe upstream approach: spatial-masked desaturation, or adjust the source tool that caused excess saturation.',
        },
      },
    ],

    allowedTools: new Set([
      ...BASELINE_TOOLS,
      'run_curves',
      'run_pixelmath',
      'lrgb_combine',
      'ha_inject_red',
      'ha_inject_luminance',
      'dynamic_narrowband_blend',
      'multi_scale_enhance',
      'continuous_clamp',
    ]),

    forbiddenTools: new Set(),

    forbiddenPatterns: [
      {
        tool: 'run_curves',
        argPattern: { channel: 'S', _stackedOnDamaged: true },
        reason:
          'Do not stack more desaturation passes on an image with damaged star color. ' +
          'Restore and use a star-safe upstream approach.',
      },
      {
        tool: 'run_pixelmath',
        argPattern: { _containsDesat: true },
        reason:
          'No global PixelMath desaturation on an image with damaged star color. ' +
          'Restore and use a star-safe upstream approach (spatial mask or fix the source tool).',
      },
    ],

    buildRetryLadder(_provenance) {
      return null;
    },

    maxRepairTurns: 6,
  },

  // ---- 6. burn_after_star_blend ----
  {
    id: 'burn_after_star_blend',
    description: 'Burnt regions detected after star reintegration (screen blend pushed core above limits)',
    failureGate: 'scan_burnt_regions',
    blocking: true,

    matches(gateName, _gateResult, provenance, _category) {
      const STAR_TOOLS = new Set(['star_protected_blend', 'star_screen_blend']);
      return (
        gateName === 'scan_burnt_regions' &&
        provenance?.tool != null &&
        STAR_TOOLS.has(provenance.tool)
      );
    },

    requiredActions: [
      { tool: 'restore_from_clone', params: { hint: 'pre_star_backup' } },
      {
        tool: 'star_protected_blend',
        paramAdjustment: {
          strength: 'decrease_by_0.15',
          note: 'Re-blend with lower strength or tighter core protection (lower core_threshold_high by 0.10).',
        },
      },
    ],

    allowedTools: new Set([
      // NOTE: continuous_clamp deliberately EXCLUDED — it is forbidden as the
      // primary fix for star-blend burns. The agent MUST restore + re-blend first.
      // After exiting repair back to compose, continuous_clamp is available there
      // as a secondary safety net.
      ...BASELINE_TOOLS,
      'star_protected_blend',
      'check_star_layer_integrity',
      'check_tonal_presence',
      'run_curves',
      'run_pixelmath',
      'create_luminance_mask',
      'apply_mask',
      'remove_mask',
      'close_mask',
    ]),

    forbiddenTools: new Set([
      'continuous_clamp',  // HARD FORBIDDEN — must fix reintegration upstream, not clamp downstream
    ]),

    forbiddenPatterns: [],

    buildRetryLadder(provenance) {
      const current = provenance?.params?.strength;
      if (typeof current === 'number') {
        return [
          Math.max(0.30, +(current - 0.15).toFixed(2)),
          Math.max(0.30, +(current - 0.30).toFixed(2)),
          Math.max(0.30, +(current - 0.40).toFixed(2)),
        ];
      }
      return [0.70, 0.55, 0.45];
    },

    maxRepairTurns: 10,
  },

  // ---- 7. tonal_presence_subdued ----
  {
    id: 'tonal_presence_subdued',
    description: 'Subject is tonally subdued — technically safe but not impactful',
    failureGate: 'check_tonal_presence',
    blocking: true,

    matches(gateName, gateResult, _provenance, _category) {
      const isSubdued =
        gateResult?.resultText?.includes('subdued') ||
        gateResult?.tonal_verdict === 'subdued';
      return gateName === 'check_tonal_presence' && isSubdued;
    },

    requiredActions: [
      { tool: 'restore_from_clone', params: { hint: 'pre_star_backup' } },
      {
        tool: 'run_curves',
        paramAdjustment: {
          note: 'Apply ONE subject-masked midtone lift. Create luminance mask first, then apply brightness curves through it.',
        },
      },
      {
        tool: 'star_protected_blend',
        paramAdjustment: { note: 'Re-blend stars after midtone lift.' },
      },
    ],

    allowedTools: new Set([
      ...BASELINE_TOOLS,
      'run_curves',
      'run_pixelmath',
      'star_protected_blend',
      'check_star_layer_integrity',
      'check_tonal_presence',
      'create_luminance_mask',
      'apply_mask',
      'remove_mask',
      'close_mask',
    ]),

    forbiddenTools: new Set(),

    forbiddenPatterns: [],

    /** Guidance note: the agent MUST create a luminance mask and apply curves
     *  through it. A global brightness boost (unmasked run_pixelmath or run_curves
     *  without mask) will wash out the background and flatten structure.
     *  This is enforced via guidance text, not arg-pattern matching. */

    buildRetryLadder(_provenance) {
      // No single parameter to ladder; the agent decides the curves shape
      return null;
    },

    maxRepairTurns: 8,
  },

  // ---- 8. ringing_edge_on_advisory ----
  {
    id: 'ringing_edge_on_advisory',
    description:
      'Ringing detected on edge-on galaxy — advisory only (natural radial profile)',
    failureGate: 'check_ringing',
    blocking: false, // NOT a real failure for edge-on galaxies

    matches(gateName, _gateResult, _provenance, category) {
      return (
        gateName === 'check_ringing' &&
        category === 'galaxy_edge_on'
      );
    },

    requiredActions: [],
    allowedTools: new Set([...BASELINE_TOOLS]),
    forbiddenTools: new Set(),
    forbiddenPatterns: [],

    buildRetryLadder() {
      return null;
    },

    maxRepairTurns: 0,
  },

  // ---- 9. highlight_collapsed_after_compression ----
  {
    id: 'highlight_collapsed_after_compression',
    description:
      'Shell texture collapsed after continuous_clamp — compression was too destructive. ' +
      'Restore pre-clamp checkpoint, then either skip clamp (if burn gates pass without it) ' +
      'or re-clamp with less aggressive params (higher knee, more headroom).',
    failureGate: 'check_highlight_texture',
    blocking: true,

    matches(gateName, gateResult, provenance, _category) {
      return (
        gateName === 'check_highlight_texture' &&
        gateResult?.resultText?.includes('COLLAPSED') &&
        provenance?.tool === 'continuous_clamp'
      );
    },

    requiredActions: [
      'RESTORE from pre-clamp checkpoint (the reference_id used in the failing check)',
      'Check whether absolute burn gates (0.95) actually fail WITHOUT clamping',
      'If burn gates PASS without clamp: SKIP clamping entirely — it was unnecessary',
      'If burn gates fail: re-apply continuous_clamp with LESS compression (higher knee, more headroom)',
      'After any re-application: check_highlight_texture against pre-clamp reference',
      'If retention still < 50% after 2 retries: accept pre-clamp state as-is',
    ],
    allowedTools: new Set([
      ...BASELINE_TOOLS,
      'continuous_clamp',
      'check_highlight_texture',
      'run_curves',
      'run_pixelmath',
    ]),
    forbiddenTools: new Set(),
    forbiddenPatterns: [
      {
        tool: 'continuous_clamp',
        test: (args, prov) =>
          typeof args?.min_clamp === 'number' &&
          typeof prov?.params?.min_clamp === 'number' &&
          args.min_clamp < prov.params.min_clamp,
        reason: 'More aggressive clamping (lower min_clamp than the failing clamp) destroys shell texture further',
      },
    ],

    buildRetryLadder(provenance) {
      const mc = provenance?.params?.min_clamp ?? 0.75;
      const hd = provenance?.params?.headroom ?? 0.12;
      return [
        { action: 'skip_clamp_if_burn_passes', note: 'Check 0.95 gate without clamp first' },
        { min_clamp: +(mc + 0.08).toFixed(2), headroom: +(hd + 0.04).toFixed(2), rate: 2.0, note: 'Higher knee, more headroom' },
        { action: 'accept_pre_clamp', note: 'Visible texture > dim image. Accept brighter result.' },
      ];
    },

    postRepairValidation: [
      'check_highlight_texture',
      'measureSubjectDetail',
      'check_saturation',
    ],

    maxRepairTurns: 8,
  },

  // ---- 10. highlight_collapsed_after_detail ----
  {
    id: 'highlight_collapsed_after_detail',
    description:
      'Shell texture degraded after detail enhancement — wrong tool or too aggressive. ' +
      'If multi_scale_enhance was used on emission shell: SWITCH to shell_detail_enhance. ' +
      'If shell_detail_enhance was used: reduce amounts.',
    failureGate: 'check_highlight_texture',
    blocking: true,

    matches(gateName, _gateResult, provenance, _category) {
      return (
        gateName === 'check_highlight_texture' &&
        (provenance?.tool === 'multi_scale_enhance' || provenance?.tool === 'shell_detail_enhance')
      );
    },

    requiredActions: [
      'RESTORE from pre-detail checkpoint',
      'If multi_scale_enhance was used: SWITCH to shell_detail_enhance (LHE causes brightness amplification)',
      'If shell_detail_enhance was used: reduce medium_amount and large_amount by 30%',
      'After re-application: check_highlight_texture against pre-detail reference',
    ],
    allowedTools: new Set([
      ...BASELINE_TOOLS,
      'shell_detail_enhance',
      'multi_scale_enhance',
      'check_highlight_texture',
      'create_adaptive_zone_masks',
      'apply_mask',
      'remove_mask',
    ]),
    forbiddenTools: new Set([
      'continuous_clamp', // Clamping is not the answer for detail-tool failures
    ]),
    forbiddenPatterns: [],

    buildRetryLadder(provenance) {
      if (provenance?.tool === 'multi_scale_enhance') {
        return [{ switchTool: 'shell_detail_enhance', medium_amount: 1.0, large_amount: 0.5 }];
      }
      const ma = provenance?.params?.medium_amount ?? 1.0;
      const la = provenance?.params?.large_amount ?? 0.5;
      return [
        { medium_amount: +(ma * 0.7).toFixed(2), large_amount: +(la * 0.7).toFixed(2) },
        { medium_amount: +(ma * 0.5).toFixed(2), large_amount: +(la * 0.5).toFixed(2) },
      ];
    },

    postRepairValidation: [
      'check_highlight_texture',
      'measureSubjectDetail',
      'scan_burnt_regions',
    ],

    maxRepairTurns: 8,
  },

  // ---- 11. highlight_collapsed_after_ha ----
  {
    id: 'highlight_collapsed_after_ha',
    description:
      'Shell texture swamped by Ha injection brightness. ' +
      'Reduce Ha strength or max_output, then verify texture retention.',
    failureGate: 'check_highlight_texture',
    blocking: true,

    matches(gateName, _gateResult, provenance, _category) {
      return (
        gateName === 'check_highlight_texture' &&
        (provenance?.tool?.includes('ha_inject') || provenance?.tool === 'dynamic_narrowband_blend')
      );
    },

    requiredActions: [
      'RESTORE from pre-Ha checkpoint',
      'Reduce Ha injection strength by 20% or lower max_output by 0.05',
      'Re-apply Ha injection with reduced parameters',
      'check_highlight_texture against pre-Ha reference',
    ],
    allowedTools: new Set([
      ...BASELINE_TOOLS,
      'ha_inject_red',
      'ha_inject_luminance',
      'dynamic_narrowband_blend',
      'check_highlight_texture',
      'apply_mask',
      'remove_mask',
    ]),
    forbiddenTools: new Set([
      'continuous_clamp', // Ha brightness issue, not a clamping issue
    ]),
    forbiddenPatterns: [],

    buildRetryLadder(provenance) {
      const str = provenance?.params?.ha_strength ?? 0.40;
      const mo = provenance?.params?.max_output ?? 0.85;
      return [
        { ha_strength: +(str * 0.80).toFixed(2), max_output: +(mo - 0.05).toFixed(2) },
        { ha_strength: +(str * 0.65).toFixed(2), max_output: +(mo - 0.10).toFixed(2) },
      ];
    },

    postRepairValidation: [
      'check_highlight_texture',
      'measureSubjectDetail',
      'check_saturation',
    ],

    maxRepairTurns: 6,
  },

  // ---- 12-17. WI-06 finish-level policies (synthetic gate keys 'finish:*') ----
  {
    id: 'finish_core_contrast',
    description: 'Finish gate: core perceptually burnt / flat. Recover local contrast in the core; do not clamp harder.',
    failureGate: 'finish:core_contrast',
    blocking: true,
    matches(gateName) { return gateName === 'finish:core_contrast' || gateName === 'check_core_contrast'; },
    requiredActions: [
      { tool: 'create_adaptive_zone_masks', params: { note: 'Build core/shell masks so detail reaches the core' } },
      { tool: 'multi_scale_enhance', paramAdjustment: { note: 'or shell_detail_enhance, through the core mask (shrink any donut hole)' } },
      { tool: 'check_core_contrast', params: { note: 'verify' } },
    ],
    allowedTools: new Set([
      ...BASELINE_TOOLS, 'multi_scale_enhance', 'shell_detail_enhance', 'create_adaptive_zone_masks', 'apply_mask',
      'remove_mask', 'close_mask', 'create_luminance_mask', 'check_core_contrast', 'run_hdrmt', 'run_curves',
      'run_pixelmath', 'continuous_clamp', 'star_protected_blend', 'check_star_layer_integrity',
    ]),
    forbiddenTools: new Set(),
    forbiddenPatterns: [
      {
        tool: 'run_curves',
        argPattern: { _globalDarkening: true },
        reason: 'No global darkening curve to fix a flat/burnt core: it flattens the whole image. Recover core contrast through a core mask instead.',
      },
      {
        tool: 'continuous_clamp',
        test: (_args, _prov, ctx) => !hasMoved(ctx, ['multi_scale_enhance', 'shell_detail_enhance', 'run_hdrmt', 'restore_from_clone']),
        reason: 'continuous_clamp cannot be the FIRST move against a flat core (efe2138e: three clamps made it flatter). First recover local contrast (multi_scale_enhance / shell_detail_enhance through a core mask) or restore_from_clone.',
      },
    ],
    verifyTools: ['check_core_contrast', 'finish'],
    buildRetryLadder() { return null; },
    maxRepairTurns: 12,
  },
  {
    id: 'finish_noise',
    description: 'Finish gate: background too noisy. One light NXT pass, then re-measure. Do not stretch further.',
    failureGate: 'finish:noise',
    blocking: true,
    matches(gateName) { return gateName === 'finish:noise'; },
    requiredActions: [
      { tool: 'run_nxt', params: { note: 'ONE pass, denoise ~0.30, detail ~0.10' } },
      { tool: 'check_noise', params: { note: 'verify' } },
    ],
    allowedTools: new Set([...BASELINE_TOOLS, 'run_nxt', 'check_noise', 'measure_dust_coverage', 'lift_dust', 'apply_mask', 'remove_mask']),
    forbiddenTools: new Set(['stretch_stars']),
    forbiddenPatterns: [
      {
        tool: 'run_curves',
        argPattern: { _lifting: true },
        reason: 'Do not stretch/lift further to fix noise: it amplifies grain. Denoise (run_nxt, one pass) instead.',
      },
    ],
    verifyTools: ['check_noise', 'finish'],
    buildRetryLadder() { return null; },
    maxRepairTurns: 8,
  },
  {
    id: 'finish_dust',
    description: 'Finish gate: IFN/dust greyed and crushed. Lift the dust selectively (inject_l_ifn / lift_dust), not globally.',
    failureGate: 'finish:dust',
    blocking: true,
    matches(gateName) { return gateName === 'finish:dust'; },
    requiredActions: [
      { tool: 'inject_l_ifn', params: { note: 'or lift_dust (selective, masked)' } },
      { tool: 'run_scnr', params: { note: 'amount <= 0.30 if a green cast appears' } },
      { tool: 'measure_dust_coverage', params: { note: 'verify' } },
    ],
    allowedTools: new Set([
      ...BASELINE_TOOLS, 'inject_l_ifn', 'lift_dust', 'run_scnr', 'run_nxt', 'measure_dust_coverage', 'check_noise',
      'apply_mask', 'remove_mask', 'create_luminance_mask',
    ]),
    forbiddenTools: new Set(),
    forbiddenPatterns: [
      {
        tool: 'run_scnr',
        test: (args) => typeof args?.amount === 'number' && args.amount > 0.30,
        reason: 'run_scnr amount must stay <= 0.30 while repairing dust (stronger SCNR kills the warm dust colour).',
      },
    ],
    verifyTools: ['measure_dust_coverage', 'finish'],
    buildRetryLadder() { return null; },
    maxRepairTurns: 10,
  },
  {
    id: 'finish_palette',
    description: 'Finish gate: narrowband palette imbalance (green/magenta/cool fractions). Fix hue upstream with the SHO tools.',
    failureGate: 'finish:palette',
    blocking: true,
    matches(gateName) { return gateName === 'finish:palette'; },
    requiredActions: [
      { tool: 'sho_hue_shift', params: { note: 'or sho_combine with adjusted gains' } },
      { tool: 'run_scnr', params: { note: 'green only if needed' } },
      { tool: 'measure_palette_balance', params: { note: 'verify' } },
    ],
    allowedTools: new Set([
      ...BASELINE_TOOLS, 'sho_hue_shift', 'sho_combine', 'sho_hue_saturation', 'run_scnr', 'measure_palette_balance',
      'measure_color_gradient', 'apply_mask', 'remove_mask',
    ]),
    forbiddenTools: new Set(),
    forbiddenPatterns: [],
    verifyTools: ['measure_palette_balance', 'finish'],
    buildRetryLadder() { return null; },
    maxRepairTurns: 10,
  },
  {
    id: 'finish_exposure',
    description: 'Finish gate: image too dark. Restore and re-stretch; no post-hoc gamma.',
    failureGate: 'finish:exposure',
    blocking: true,
    matches(gateName) { return gateName === 'finish:exposure'; },
    requiredActions: [
      { tool: 'restore_from_clone', params: { note: 'return to the pre-stretch/pre-darkening state' } },
      { tool: 'run_pixelmath', params: { note: 're-stretch (GHS / MTF) to the profile target median' } },
    ],
    allowedTools: new Set([...BASELINE_TOOLS, 'run_pixelmath', 'run_curves', 'get_image_stats', 'apply_mask', 'remove_mask']),
    forbiddenTools: new Set(),
    forbiddenPatterns: [
      {
        tool: 'run_curves',
        argPattern: { _posthocGamma: true },
        reason: 'No post-hoc global gamma/lift to fix exposure. Restore and re-stretch properly.',
      },
    ],
    verifyTools: ['get_image_stats', 'finish'],
    buildRetryLadder() { return null; },
    maxRepairTurns: 8,
  },
  {
    id: 'finish_l_missing',
    description: 'Finish gate: L data exists but was not used. Combine it (lrgb_combine or inject_luminance).',
    failureGate: 'finish:l_missing',
    blocking: true,
    matches(gateName) { return gateName === 'finish:l_missing'; },
    requiredActions: [
      { tool: 'inject_luminance', params: { note: 'when L/RGB median ratio > 2x' } },
      { tool: 'lrgb_combine', params: { note: 'when the ratio is moderate' } },
      { tool: 'check_star_layer_integrity', params: { note: 'before any star blend' } },
    ],
    allowedTools: new Set([
      ...BASELINE_TOOLS, 'inject_luminance', 'lrgb_combine', 'check_star_layer_integrity', 'star_protected_blend',
      'run_pixelmath', 'apply_mask', 'remove_mask', 'create_luminance_mask',
    ]),
    forbiddenTools: new Set(),
    forbiddenPatterns: [],
    verifyTools: ['check_star_layer_integrity', 'finish'],
    buildRetryLadder() { return null; },
    maxRepairTurns: 10,
  },
];

// Existing policies verify with the gate tool that raised them (WI-06).
for (const p of POLICIES) {
  if (!p.verifyTools) p.verifyTools = [p.failureGate, 'finish'];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find the matching repair policy for a gate failure.
 *
 * Policies are checked in definition order; the first match wins.
 * Returns null when no policy matches (the agent should use generic handling).
 *
 * @param {string} gateName   - e.g. 'check_saturation'
 * @param {object} gateResult - the gate's result object (p90S, pass, etc.)
 * @param {object} provenance - { tool, params, seq } from the provenance tracker
 * @param {string} category   - target category (e.g. 'galaxy_edge_on')
 * @returns {object|null} repair policy or null
 */
export function findRepairPolicy(gateName, gateResult, provenance, category) {
  if (!gateName) return null;

  for (const policy of POLICIES) {
    try {
      if (policy.matches(gateName, gateResult, provenance, category)) {
        // Attach a computed retry ladder for this specific failure instance.
        const retryLadder = policy.buildRetryLadder(provenance);
        return {
          ...policy,
          retryLadder,
          // Strip the matches function — callers don't need it
          matches: undefined,
          buildRetryLadder: undefined,
        };
      }
    } catch (_err) {
      // If a policy's matches() throws (e.g. unexpected shape), skip it.
      continue;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Forbid evaluation (WI-06)
// ---------------------------------------------------------------------------

const DESAT_RE = /CIE[a-z]*|\$T\s*\*\s*0\.|(avg|mean)\(/;

/** True when a run_pixelmath expression looks like a global S/luminance desaturation idiom. */
export function isDesatExpression(expr) {
  return typeof expr === 'string' && DESAT_RE.test(expr);
}

function _pts(args) {
  return Array.isArray(args?.points) ? args.points.filter(p => Array.isArray(p) && p.length >= 2) : [];
}

/** run_curves with no mask applied on the view and every interior point on/below the identity line (at least one below). */
export function isGlobalDarkening(args, ctx) {
  if (ctx?.maskActive) return false;
  const pts = _pts(args).filter(p => p[0] > 0.001 && p[0] < 0.999);
  if (!pts.length) return false;
  return pts.every(p => p[1] <= p[0] + 1e-6) && pts.some(p => p[1] < p[0] - 0.005);
}

/** run_curves lifting (any interior point above identity), unmasked. */
function isLifting(args, ctx) {
  if (ctx?.maskActive) return false;
  return _pts(args).some(p => p[0] > 0.001 && p[0] < 0.999 && p[1] > p[0] + 0.01);
}

/** Simple (<= 3 points) unmasked RGB/L bend that lifts the midtones = post-hoc gamma. */
function isPosthocGamma(args, ctx) {
  if (ctx?.maskActive) return false;
  if (args?.channel && !['RGB', 'L'].includes(args.channel)) return false;
  return _pts(args).length <= 3 && isLifting(args, ctx);
}

function hasMoved(ctx, tools) {
  const h = ctx?.history || [];
  return h.some(t => tools.includes(t));
}

const FLAG_EVALUATORS = {
  _containsDesat: (tool, args) => tool === 'run_pixelmath' && isDesatExpression(args?.expression),
  _globalDarkening: (tool, args, _prov, ctx) => tool === 'run_curves' && isGlobalDarkening(args, ctx),
  _lifting: (tool, args, _prov, ctx) => tool === 'run_curves' && isLifting(args, ctx),
  _posthocGamma: (tool, args, _prov, ctx) => tool === 'run_curves' && isPosthocGamma(args, ctx),
  _stackedOnDamaged: () => true,   // pattern only exists on a policy engaged because the image is already damaged
};

/**
 * Steps 1-2 of the repair access check (forbiddenTools + forbiddenPatterns), with NO allowlist.
 * WI-06: enforced on any view with an active policy regardless of the state machine state.
 * Pattern forms: {tool, argPattern:{key:value, _flag:true}} and {tool, test:(args, prov, ctx)=>bool}.
 * @param {string} toolName
 * @param {object} args
 * @param {object} policy
 * @param {object} [prov]  lastModifier provenance of the view
 * @param {object} [ctx]   { history:[tool names since engagement], maskActive:boolean }
 */
export function checkRepairForbids(toolName, args, policy, prov, ctx) {
  if (!policy) return { allowed: true };

  if (policy.forbiddenTools?.has(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" is forbidden by repair policy "${policy.id}".` };
  }

  for (const pattern of policy.forbiddenPatterns || []) {
    if (pattern.tool !== toolName) continue;
    let hit = false;
    if (typeof pattern.test === 'function') {
      try { hit = !!pattern.test(args || {}, prov, ctx || {}); } catch (_e) { hit = false; }
    } else if (pattern.argPattern) {
      const keys = Object.keys(pattern.argPattern);
      const real = keys.filter(k => !k.startsWith('_'));
      const flags = keys.filter(k => k.startsWith('_'));
      const realOk = real.every(k => args?.[k] === pattern.argPattern[k]);
      const flagsOk = flags.every(k => {
        const ev = FLAG_EVALUATORS[k];
        return ev ? !!ev(toolName, args || {}, prov, ctx || {}) : false;
      });
      hit = realOk && flagsOk && (real.length > 0 || flags.length > 0);
    }
    if (hit) {
      return {
        allowed: false,
        reason: pattern.reason || `Forbidden argument pattern for "${toolName}" under repair policy "${policy.id}".`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Check if a tool call is allowed under the active repair policy
 * (forbids first, then the allowed-tools whitelist). Used by the state machine's
 * repair state; WI-06 enforcement of forbids alone uses checkRepairForbids.
 */
export function checkRepairToolAccess(toolName, args, policy, prov, ctx) {
  if (!policy) return { allowed: true };
  const forb = checkRepairForbids(toolName, args, policy, prov, ctx);
  if (!forb.allowed) return forb;

  if (policy.allowedTools?.size > 0 && !policy.allowedTools.has(toolName)) {
    return {
      allowed: false,
      reason:
        `Tool "${toolName}" is not in the allowed set for repair policy "${policy.id}". ` +
        `Allowed: ${[...policy.allowedTools].join(', ')}.`,
    };
  }
  return { allowed: true };
}

/**
 * Generate the repair guidance text to include in a gate failure message.
 *
 * The returned string is designed to be injected into the system prompt
 * or tool result so the agent knows exactly what it must do, what it
 * cannot do, and what parameter values to try.
 *
 * @param {object} policy     - the matched repair policy
 * @param {object} provenance - current provenance ({ tool, params, seq })
 * @returns {string} multi-line guidance text
 */
export function generateRepairGuidance(policy, provenance) {
  if (!policy) {
    return 'No specific repair policy matched. Use your best judgement to fix the issue.';
  }

  const lines = [];

  // ---- Header ----
  lines.push(`REPAIR POLICY: ${policy.id}`);
  lines.push(`  ${policy.description}`);
  lines.push('');

  // ---- Advisory (non-blocking) ----
  if (policy.blocking === false) {
    lines.push('STATUS: Advisory only (non-blocking)');
    lines.push(
      '  This gate failure is expected for this target category. ' +
      'No repair is required. You may proceed.',
    );
    return lines.join('\n');
  }

  // ---- Required actions ----
  if (policy.requiredActions?.length) {
    lines.push('REQUIRED ACTIONS (execute in order):');
    for (let i = 0; i < policy.requiredActions.length; i++) {
      const action = policy.requiredActions[i];
      if (typeof action === 'string') { lines.push(`  ${i + 1}. ${action}`); continue; }
      const parts = [`  ${i + 1}. ${action.tool}`];
      if (action.params) {
        parts.push(`     params: ${JSON.stringify(action.params)}`);
      }
      if (action.paramAdjustment) {
        parts.push(`     adjustment: ${JSON.stringify(action.paramAdjustment)}`);
      }
      lines.push(parts.join('\n'));
    }
    lines.push('');
  }

  // ---- Retry ladder ----
  if (policy.retryLadder?.length) {
    const suspectedParam = _guessSuspectedParam(policy);
    const currentVal = provenance?.params?.[suspectedParam];
    lines.push('RETRY LADDER:');
    if (currentVal != null) {
      lines.push(`  Current ${suspectedParam}: ${currentVal}`);
    }
    lines.push(`  Try these values in order: ${policy.retryLadder.join(' -> ')}`);
    lines.push('  If the gate still fails after all ladder values, escalate to the orchestrator.');
    lines.push('');
  }

  // ---- Forbidden patterns ----
  if (policy.forbiddenPatterns?.length) {
    lines.push('FORBIDDEN (do NOT do these):');
    for (const fp of policy.forbiddenPatterns) {
      lines.push(`  - ${fp.tool}: ${fp.reason}`);
    }
    lines.push('');
  }

  // ---- Max turns ----
  if (policy.maxRepairTurns > 0) {
    lines.push(`MAX REPAIR TURNS: ${policy.maxRepairTurns}`);
    lines.push(
      '  If you cannot pass the gate within this budget, save a variant and report failure.',
    );
    lines.push('');
  }

  // ---- Provenance context ----
  if (provenance) {
    lines.push('PROVENANCE (last tool that modified the image):');
    lines.push(`  tool: ${provenance.tool || 'unknown'}`);
    if (provenance.params) {
      lines.push(`  params: ${JSON.stringify(provenance.params)}`);
    }
    if (provenance.seq != null) {
      lines.push(`  sequence: ${provenance.seq}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Guess the primary parameter name for a policy's retry ladder, based on
 * the paramAdjustment in its required actions.
 */
function _guessSuspectedParam(policy) {
  for (const action of policy.requiredActions || []) {
    if (action.paramAdjustment) {
      const keys = Object.keys(action.paramAdjustment).filter(
        (k) => k !== 'note',
      );
      if (keys.length > 0) return keys[0];
    }
  }
  return 'value';
}

// ---------------------------------------------------------------------------
// Gate-text parsing (WI-06)
// ---------------------------------------------------------------------------

/**
 * Parse a gate failure text into structured fields.
 * 'colorless' -> 'color', 'bloated' -> 'fwhm', 'TOO DIM' -> 'brightness',
 * 'SUBDUED' -> tonal_verdict 'subdued', 'P90=x' -> p90S.
 * @returns {{resultText:string, failedMetrics:string[], reason:string, tonal_verdict:(string|null), p90S:(number|null)}}
 */
export function parseGateFailure(gateName, resultText) {
  const text = String(resultText || '');
  const failedMetrics = [];
  if (/colorless/i.test(text)) failedMetrics.push('color');
  if (/bloated/i.test(text)) failedMetrics.push('fwhm');
  if (/stars too dim|too dim/i.test(text) && /star/i.test(text)) failedMetrics.push('brightness');
  if (/OVER-SATURATED|exceeds hard limit/i.test(text)) failedMetrics.push('saturation');
  if (/BURN SCAN FAILED|BURNT REGIONS/i.test(text)) failedMetrics.push('burn');
  if (/TOO MANY BRIGHT REGIONS/i.test(text)) failedMetrics.push('bright_blocks');
  if (/COLLAPSED/.test(text)) failedMetrics.push('texture');
  if (/CORE PERCEPTUALLY BURNT|FAILS CORE/i.test(text)) failedMetrics.push('core');
  let tonal_verdict = null;
  if (/SUBDUED/.test(text)) tonal_verdict = 'subdued';
  else if (/AGGRESSIVE/.test(text)) tonal_verdict = 'aggressive';
  if (tonal_verdict === 'subdued') failedMetrics.push('tonal');
  let p90S = null;
  const m = /P90\s*=\s*([0-9]*\.?[0-9]+)/.exec(text);
  if (m) p90S = parseFloat(m[1]);
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l) || '';
  return { resultText: text, failedMetrics, reason: firstLine.slice(0, 300), tonal_verdict, p90S };
}

/** Prefix -> gate table used to recover gates from a legacy finish prose (no GATES_JSON trailer). */
const FINISH_PROSE_GATES = [
  [/^STARS TOO DIM/, 'stars_brightness', 'check_star_quality'],
  [/^STARS SEVERELY BLOATED/, 'stars_fwhm', 'check_star_quality'],
  [/^PALETTE IMBALANCED/, 'palette', 'finish:palette'],
  [/^BURN SCAN FAILED/, 'burn_clip', 'scan_burnt_regions'],
  [/^TOO MANY BRIGHT REGIONS/, 'bright_blocks', 'scan_burnt_regions'],
  [/^CORE PERCEPTUALLY BURNT/, 'core_contrast', 'finish:core_contrast'],
  [/^IFN\/DUST GATE/, 'dust_ifn', 'finish:dust'],
  [/^BACKGROUND TOO NOISY/, 'noise', 'finish:noise'],
  [/^IMAGE TOO DARK/, 'exposure', 'finish:exposure'],
  [/^OVER-SATURATED/, 'saturation', 'check_saturation'],
  [/^TONAL PRESENCE SUBDUED/, 'tonal_presence', 'check_tonal_presence'],
];

/** Recover failedGates from the "  - message" lines of a FINISH REJECTED text. */
export function gatesFromFinishProse(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s{2}- (.*)$/.exec(line);
    if (!m) continue;
    const msg = m[1];
    const hit = FINISH_PROSE_GATES.find(([re]) => re.test(msg));
    if (!hit) continue;
    out.push({ gate: hit[1], tool: hit[2], reason: msg.slice(0, 300), resultText: msg, repairable: true, ...parseGateFailure(hit[1], msg) });
  }
  return out;
}

/** Extract the failedGates array from a finish result's GATES_JSON trailer (or from legacy prose). */
export function parseFinishResult(text) {
  const t = String(text || '');
  const i = t.lastIndexOf('GATES_JSON:');
  if (i >= 0) {
    try {
      const j = JSON.parse(t.slice(i + 'GATES_JSON:'.length).trim().split('\n')[0]);
      if (j && Array.isArray(j.failedGates)) return { viewId: j.viewId || null, failedGates: j.failedGates };
    } catch (_e) { /* fall through to prose */ }
  }
  return { viewId: null, failedGates: gatesFromFinishProse(t) };
}

/** Did this tool call fail its gate? */
export function isFailResult(toolName, text) {
  const t = String(text || '');
  if (toolName === 'finish') return /^FINISH REJECTED/.test(t);
  // \bFAIL\b: the static threshold line once read 'finish gate FAILS above 0.85' and every saturation check
  // after an Ha injection opened a repair (M101 friend crop 2026-11-08).
  if (toolName === 'check_saturation') return /exceeds hard limit|UPSTREAM FIX REQUIRED|\bFAIL\b|REJECTED/.test(t);
  return /FAIL|REJECTED|COLLAPSED|SUBDUED/.test(t);
}

/** Did this verification call PASS? */
export function isPassResult(toolName, text) {
  const t = String(text || '');
  if (toolName === 'finish') return t.startsWith('Finished (quality gates PASSED)');
  if (toolName === 'check_saturation') return !isFailResult(toolName, t) && /Saturation:/.test(t);
  if (toolName === 'get_image_stats' || toolName === 'measure_palette_balance') return false;   // no verdict text
  return /\bPASS/.test(t) && !/FAIL|REJECTED|SUBDUED/.test(t);
}

// ---------------------------------------------------------------------------
// Tracker: provenance + active policies + enforcement + exit (WI-06)
// ---------------------------------------------------------------------------

export const COMPOSITION_TOOLS = new Set([
  'lrgb_combine', 'ha_inject_red', 'ha_inject_luminance', 'dynamic_narrowband_blend', 'star_screen_blend', 'star_protected_blend',
]);

const MODIFYING_TOOLS = new Set([
  ...COMPOSITION_TOOLS,
  'run_curves', 'run_pixelmath', 'multi_scale_enhance', 'run_hdrmt', 'shell_detail_enhance', 'continuous_clamp',
  'lift_dust', 'inject_l_ifn', 'inject_luminance', 'stretch_stars', 'run_nxt', 'run_bxt', 'run_scnr', 'mask_ops',
]);

export function isModifyingTool(name) {
  return MODIFYING_TOOLS.has(name) || /^sho_/.test(name);
}

/** Tools whose results can open a repair (spec: + finish, check_ringing, check_core_contrast). */
export const REPAIR_TRIGGER_TOOLS = new Set([
  'check_saturation', 'scan_burnt_regions', 'check_star_quality', 'check_tonal_presence', 'check_highlight_texture',
  'check_ringing', 'check_core_contrast', 'finish',
]);

/**
 * Per-process repair state. Pure (no I/O) so it can be unit-tested and replayed on a trace.
 *  - prov: viewId -> lastModifier {tool, params, seq, history:[<=5], lastComposition}
 *  - active: viewId -> {policy, enteredSeq, gateName, maxTurns, history:[tools], violations}
 */
export function createRepairTracker() {
  const prov = new Map();
  const active = new Map();
  const masked = new Set();

  function recordModifier(name, args, seq, viewId) {
    if (name === 'apply_mask' && args?.target_id) masked.add(args.target_id);
    if (name === 'remove_mask' && args?.target_id) masked.delete(args.target_id);
    const a = active.get(viewId);
    if (a) a.history.push(name);
    if (!viewId || !isModifyingTool(name)) return;
    const prev = prov.get(viewId);
    const rec = { tool: name, params: args || {}, seq };
    const history = [...(prev?.history || []), rec].slice(-5);
    prov.set(viewId, {
      ...rec,
      history,
      lastComposition: COMPOSITION_TOOLS.has(name) ? rec : prev?.lastComposition,
    });
  }

  /** Forbids-only check, any state. Returns {allowed, reason?, policy?}. */
  function checkForbids(name, args, viewId) {
    const a = active.get(viewId);
    if (!a) return { allowed: true };
    const ctx = { history: a.history, maskActive: masked.has(viewId) };
    const r = checkRepairForbids(name, args || {}, a.policy, prov.get(viewId), ctx);
    if (!r.allowed) a.violations++;
    return r.allowed ? r : { ...r, policy: a.policy.id };
  }

  /** Drop policies older than maxTurns by seq (blocked calls count). Returns events. */
  function expire(seq) {
    const events = [];
    for (const [viewId, a] of active) {
      if (seq - a.enteredSeq > a.maxTurns) {
        active.delete(viewId);
        events.push({ event: 'repair_cleared', reason: 'max_turns', policy: a.policy.id, viewId, seq });
      }
    }
    return events;
  }

  function _engage(viewId, policy, gateName, seq) {
    const cur = active.get(viewId);
    if (cur && cur.policy.id === policy.id) return null;   // same policy already running: keep its clock
    active.set(viewId, {
      policy, enteredSeq: seq, gateName,
      maxTurns: policy.maxRepairTurns || 12,
      history: [], violations: 0,
    });
    return { event: 'repair_engaged', policy: policy.id, gate: gateName, viewId, seq };
  }

  /**
   * Process a completed tool call. Clears policies on verify PASS / accepted finish and engages a new one
   * when a trigger tool failed.
   * @returns {{events:Object[], guidance:string, failedGates:Object[], engaged:(object|null)}}
   */
  function onResult({ name, args, resultText, seq, viewId, category }) {
    const events = [];
    let guidance = '';
    let failedGates = [];
    let engaged = null;

    // --- exit ---
    if (name === 'finish' && isPassResult('finish', resultText)) {
      for (const [vid, a] of active) events.push({ event: 'repair_cleared', reason: 'finish_accepted', policy: a.policy.id, viewId: vid, seq });
      active.clear();
    } else {
      const a = active.get(viewId);
      if (a && a.policy.verifyTools?.includes(name) && name !== 'finish' && isPassResult(name, resultText)) {
        active.delete(viewId);
        events.push({ event: 'repair_cleared', reason: 'verify_pass', policy: a.policy.id, viewId, seq });
      }
    }

    // --- trigger ---
    if (REPAIR_TRIGGER_TOOLS.has(name) && isFailResult(name, resultText)) {
      let resolvedView = viewId;
      let gates;
      if (name === 'finish') {
        const pf = parseFinishResult(resultText);
        gates = pf.failedGates;
        resolvedView = pf.viewId || viewId;
      } else {
        gates = [{ gate: name, tool: name, repairable: true, ...parseGateFailure(name, resultText) }];
      }
      failedGates = gates;
      const p = prov.get(resolvedView);
      for (const g of gates) {
        if (g.repairable === false) continue;
        let policy = findRepairPolicy(g.tool, g, p, category);
        if (!policy && p?.lastComposition) policy = findRepairPolicy(g.tool, g, p.lastComposition, category);
        if (!policy || policy.blocking === false) continue;
        engaged = _engage(resolvedView, policy, g.gate || g.tool, seq);
        const live = active.get(resolvedView);
        if (engaged) events.push(engaged);
        guidance = '\n\n' + generateRepairGuidance(live.policy, p);
        break;
      }
    }
    return { events, guidance, failedGates, engaged };
  }

  return {
    prov, active, masked,
    recordModifier, checkForbids, expire, onResult,
    policyIdFor: (viewId) => active.get(viewId)?.policy.id || null,
    anyPolicyId: () => { for (const a of active.values()) return a.policy.id; return null; },
  };
}
