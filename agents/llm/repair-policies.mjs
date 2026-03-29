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
]);

/** Tools commonly allowed during saturation repairs. */
const SATURATION_REPAIR_TOOLS = new Set([
  ...BASELINE_TOOLS,
  'lrgb_combine',
  'star_screen_blend',
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
  'star_screen_blend',
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
      'star_screen_blend',
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
      'star_screen_blend',
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
      'star_screen_blend',
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
];

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

/**
 * Check if a tool call is allowed under the active repair policy.
 *
 * Checks in order:
 *   1. Explicitly forbidden tools (hard block)
 *   2. Forbidden patterns (tool + arg combination block)
 *   3. Allowed tools whitelist
 *
 * @param {string} toolName
 * @param {object} args    - tool arguments
 * @param {object} policy  - the active repair policy
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkRepairToolAccess(toolName, args, policy) {
  if (!policy) {
    return { allowed: true };
  }

  // 1. Hard-forbidden tools
  if (policy.forbiddenTools?.has(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is forbidden by repair policy "${policy.id}".`,
    };
  }

  // 2. Forbidden patterns — tool + specific arg combinations
  if (policy.forbiddenPatterns?.length) {
    for (const pattern of policy.forbiddenPatterns) {
      if (pattern.tool !== toolName) continue;

      // Check each key in argPattern against the actual args.
      // Keys starting with '_' are internal flags and are skipped for
      // matching (they serve as documentation markers in the pattern).
      const patternKeys = Object.keys(pattern.argPattern).filter(
        (k) => !k.startsWith('_'),
      );

      const allMatch = patternKeys.every(
        (key) => args?.[key] === pattern.argPattern[key],
      );

      if (allMatch && patternKeys.length > 0) {
        return {
          allowed: false,
          reason: pattern.reason || `Forbidden argument pattern for "${toolName}" under repair policy "${policy.id}".`,
        };
      }
    }
  }

  // 3. Allowed tools whitelist
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
