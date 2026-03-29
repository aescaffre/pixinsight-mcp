/**
 * state-machine.mjs — 5-state runtime state machine for the GIGA agentic pipeline.
 *
 * States: assess -> generate_candidates -> compose -> finalize
 *                                            |   ^
 *                                            v   |
 *                                          repair
 *
 * Each state constrains which tools the agent may call.  Budget caps enforce
 * forward progress; auto-transitions fire on sentinel tool calls or budget
 * exhaustion.
 */

// ---------------------------------------------------------------------------
// Budget caps per state (max turns the agent may spend in each state)
// ---------------------------------------------------------------------------
const STATE_BUDGET_CAPS = {
  assess: 15,
  generate_candidates: 100,
  compose: 50,
  repair: 15,
  finalize: 20,
};

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

/** Tools that are NEVER available to the agent (internal / prep-only). */
const INTERNAL_TOOLS = new Set([
  'run_lhe',               // use multi_scale_enhance instead
  'run_abe',               // used in prep only
  'run_per_channel_abe',   // used in prep only
]);

/** Tools restricted to specific states.  Anything NOT here and NOT internal
 *  is treated as public (allowed in any state). */
const STATE_TOOLS = {
  assess: new Set([
    'recall_memory', 'list_open_images', 'get_image_stats',
    'measure_subject_detail', 'measure_uniformity', 'check_saturation',
    'check_star_quality', 'check_ringing', 'check_sharpness',
    'check_core_burning', 'scan_burnt_regions', 'check_constraints',
    'check_tonal_presence',
    'compute_scores', 'submit_scores',
    'save_and_show_preview', 'save_variant', 'rename_view',
    'get_image_dimensions',
    'clone_image', 'close_image', 'purge_undo',
  ]),

  generate_candidates: new Set([
    // Candidate generation
    'multi_scale_enhance', 'run_hdrmt', 'run_curves', 'run_pixelmath',
    'run_nxt', 'run_bxt', 'run_scnr', 'run_sxt',
    'seti_stretch', 'stretch_stars', 'auto_stretch',
    'run_spcc', 'run_background_neutralization',
    // Ha / narrowband
    'ha_inject_red', 'ha_inject_luminance', 'continuum_subtract_ha',
    'extract_pseudo_oiii', 'dynamic_narrowband_blend', 'create_synthetic_luminance',
    // Masks
    'create_luminance_mask', 'apply_mask', 'remove_mask', 'close_mask',
    'create_zone_masks',
    // Image management
    'clone_image', 'restore_from_clone', 'close_image', 'purge_undo',
    'rename_view', 'open_image', 'combine_channels',
    // Measurement
    'get_image_stats', 'measure_subject_detail', 'measure_uniformity',
    'check_saturation', 'check_star_quality', 'check_ringing',
    'check_sharpness', 'check_core_burning', 'scan_burnt_regions',
    'check_constraints', 'compute_scores',
    'check_tonal_presence', 'check_star_layer_integrity',
    // Artifacts
    'continuous_clamp',
    // Variants
    'save_variant', 'load_variant', 'list_variants',
    'save_and_show_preview', 'submit_scores',
    'list_open_images',
    // Star handling (for star branch)
    'star_screen_blend', 'star_protected_blend',
  ]),

  compose: new Set([
    'lrgb_combine', 'star_screen_blend', 'star_protected_blend',
    'run_curves', 'run_pixelmath',
    'multi_scale_enhance', 'continuous_clamp',
    'clone_image', 'restore_from_clone', 'close_image',
    'save_variant', 'load_variant', 'list_variants',
    'save_and_show_preview',
    'get_image_stats', 'measure_subject_detail', 'measure_uniformity',
    'check_saturation', 'check_star_quality', 'check_ringing',
    'check_sharpness', 'scan_burnt_regions', 'check_constraints',
    'check_tonal_presence', 'check_star_layer_integrity',
    'compute_scores', 'submit_scores',
    'create_luminance_mask', 'apply_mask', 'remove_mask', 'close_mask',
    'list_open_images', 'rename_view', 'purge_undo',
  ]),

  // repair: tools determined dynamically by repairPolicy.allowedTools

  finalize: new Set([
    'finish',
    'run_pixelmath', 'run_curves', 'continuous_clamp',
    'save_variant', 'save_and_show_preview', 'save_memory',
    'get_image_stats', 'measure_subject_detail', 'measure_uniformity',
    'check_saturation', 'check_star_quality', 'check_ringing',
    'scan_burnt_regions', 'check_constraints', 'check_sharpness',
    'check_tonal_presence', 'check_star_layer_integrity',
    'compute_scores',
    'list_open_images', 'close_image',
  ]),
};

/**
 * Build a union of every tool name that appears in at least one state's
 * restricted set.  Any tool NOT in this union and NOT internal is public.
 */
const ALL_RESTRICTED_TOOLS = new Set();
for (const stateSet of Object.values(STATE_TOOLS)) {
  for (const t of stateSet) ALL_RESTRICTED_TOOLS.add(t);
}

// ---------------------------------------------------------------------------
// StateMachine
// ---------------------------------------------------------------------------

class StateMachine {
  /**
   * @param {number} maxTurns - Total turn budget across all states.
   */
  constructor(maxTurns) {
    this.state = 'assess';
    this.maxTurns = maxTurns;
    this.turnsUsed = 0;
    this.stateStartTurn = 0;
    this.stateTurns = {
      assess: 0,
      generate_candidates: 0,
      compose: 0,
      repair: 0,
      finalize: 0,
    };
    this.repairPolicy = null;   // set when entering repair state
    this.repairAttempts = 0;
    this._branchCompletenessOverride = false;  // when true, incomplete branches are advisory only
  }

  /**
   * Override branch completeness enforcement (e.g. under budget pressure).
   * Once called, incomplete branches produce warnings instead of blocking.
   */
  overrideBranchCompleteness() {
    this._branchCompletenessOverride = true;
  }

  // -----------------------------------------------------------------------
  // Tool access control
  // -----------------------------------------------------------------------

  /**
   * Check if a tool is allowed in the current state.
   * @param {string} toolName
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkToolAccess(toolName) {
    // Internal tools are always blocked.
    if (INTERNAL_TOOLS.has(toolName)) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" is internal-only and cannot be called by the agent.`,
      };
    }

    // Public tools (not in any state's restricted set) are always allowed.
    if (!ALL_RESTRICTED_TOOLS.has(toolName)) {
      return { allowed: true };
    }

    // In repair state, defer to the repair policy's allowed tool list.
    if (this.state === 'repair') {
      if (this.repairPolicy && this.repairPolicy.allowedTools) {
        const allowed = this.repairPolicy.allowedTools.has
          ? this.repairPolicy.allowedTools.has(toolName)
          : Array.isArray(this.repairPolicy.allowedTools)
            ? this.repairPolicy.allowedTools.includes(toolName)
            : false;
        if (allowed) return { allowed: true };
        return {
          allowed: false,
          reason: `Tool "${toolName}" is not permitted by the active repair policy (${this.repairPolicy.name || 'unnamed'}).`,
        };
      }
      // No policy set — block everything restricted.
      return {
        allowed: false,
        reason: `Tool "${toolName}" is restricted and no repair policy is active.`,
      };
    }

    // Normal state — check if the tool is in this state's allowed set.
    const stateSet = STATE_TOOLS[this.state];
    if (stateSet && stateSet.has(toolName)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Tool "${toolName}" is not allowed in state "${this.state}".`,
    };
  }

  // -----------------------------------------------------------------------
  // Turn tracking & auto-transitions
  // -----------------------------------------------------------------------

  /**
   * Record a tool call and potentially auto-transition state.
   * Call this AFTER the tool executes successfully.
   * @param {string} toolName
   * @param {object} args - Tool arguments (for logging / future use).
   * @param {string} resultSummary - Brief description of tool result.
   */
  recordToolCall(toolName, args, resultSummary) {
    this.turnsUsed++;
    this.stateTurns[this.state]++;

    const stateBudgetUsed = this.turnsUsed - this.stateStartTurn;
    const turnsRemaining = this.maxTurns - this.turnsUsed;

    // --- Global safety: force-finalize when budget is nearly exhausted ---
    if (turnsRemaining <= 15 && this.state !== 'finalize') {
      this.transitionTo('finalize');
      return;
    }

    // --- State-specific auto-transitions ---

    if (this.state === 'assess') {
      // clone_image signals the agent is starting to explore variants.
      if (toolName === 'clone_image') {
        this.transitionTo('generate_candidates');
        return;
      }
      // Budget cap reached — move on.
      if (stateBudgetUsed >= STATE_BUDGET_CAPS.assess) {
        this.transitionTo('generate_candidates');
        return;
      }
    }

    if (this.state === 'generate_candidates') {
      // Composition tool signals generation is done.
      if (toolName === 'lrgb_combine' || toolName === 'star_screen_blend' || toolName === 'star_protected_blend') {
        this.transitionTo('compose');
        return;
      }
      // Budget cap reached.
      if (stateBudgetUsed >= STATE_BUDGET_CAPS.generate_candidates) {
        this.transitionTo('compose');
        return;
      }
    }

    if (this.state === 'compose') {
      // finish signals we're done composing.
      if (toolName === 'finish') {
        this.transitionTo('finalize');
        return;
      }
      // Budget cap — move to finalize (skip repair if budget is tight).
      if (stateBudgetUsed >= STATE_BUDGET_CAPS.compose) {
        this.transitionTo('finalize');
        return;
      }
    }

    if (this.state === 'repair') {
      // Budget cap per repair cycle.
      if (stateBudgetUsed >= STATE_BUDGET_CAPS.repair) {
        this.exitRepair();
        return;
      }
    }

    if (this.state === 'finalize') {
      // Budget cap — no further transitions; finalize is terminal.
      // (The agent should call `finish` before exhausting this.)
    }
  }

  // -----------------------------------------------------------------------
  // Repair state management
  // -----------------------------------------------------------------------

  /**
   * Enter repair state with a specific policy.
   * @param {object} policy - Repair policy object (must have `allowedTools`
   *                          as a Set or Array, and optionally `name`).
   */
  enterRepair(policy) {
    if (this.state !== 'compose') {
      throw new Error(`Cannot enter repair from state "${this.state}" (must be in compose).`);
    }
    this.repairPolicy = policy;
    this.repairAttempts++;
    this.transitionTo('repair');
  }

  /**
   * Exit repair state (success or budget exhausted).
   * Returns to compose so the agent can re-evaluate.
   */
  exitRepair() {
    this.repairPolicy = null;
    this.transitionTo('compose');
  }

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------

  /**
   * Force transition to a state.
   * @param {string} newState - One of the 5 valid states.
   */
  transitionTo(newState) {
    const validStates = Object.keys(STATE_BUDGET_CAPS);
    if (!validStates.includes(newState)) {
      throw new Error(`Invalid state: "${newState}". Must be one of: ${validStates.join(', ')}`);
    }
    const previousState = this.state;
    this.state = newState;
    this.stateStartTurn = this.turnsUsed;

    // Log transition (useful for tracing / debugging).
    if (typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(
        `[state-machine] ${previousState} -> ${newState} at turn ${this.turnsUsed}/${this.maxTurns}\n`
      );
    }
  }

  // -----------------------------------------------------------------------
  // Budget reporting
  // -----------------------------------------------------------------------

  /**
   * Get budget status for injection into tool responses.
   * @returns {object}
   */
  getBudgetStatus() {
    const turnsRemaining = this.maxTurns - this.turnsUsed;
    const stateBudgetUsed = this.turnsUsed - this.stateStartTurn;
    const stateBudgetCap = STATE_BUDGET_CAPS[this.state] || 999;

    // Reserved turns for future phases (only count phases we haven't reached).
    const reserved = {
      compose:
        this.state === 'assess' || this.state === 'generate_candidates'
          ? 35
          : 0,
      repair: this.state !== 'finalize' ? 15 : 0,
      finalize: this.state !== 'finalize' ? 15 : 0,
    };
    const totalReserved = Object.values(reserved).reduce((a, b) => a + b, 0);
    const availableForCurrentState = turnsRemaining - totalReserved;

    // Overall budget health.
    let status;
    if (turnsRemaining > 100) status = 'healthy';
    else if (turnsRemaining > 60) status = 'caution';
    else if (turnsRemaining > 20) status = 'converge';
    else status = 'critical';

    // Contextual guidance based on budget pressure.
    const guidance = [];
    if (status === 'caution') {
      guidance.push('No optional overdone variants. Narrow exploration.');
    }
    if (status === 'converge') {
      guidance.push('Choose winners NOW. Max one composition retry.');
    }
    if (status === 'critical') {
      guidance.push('Direct path to finish only. No new variants.');
    }

    return {
      turnsUsed: this.turnsUsed,
      turnsRemaining,
      maxTurns: this.maxTurns,
      status,
      state: this.state,
      stateBudget: { used: stateBudgetUsed, cap: stateBudgetCap },
      reserved,
      availableForCurrentState: Math.max(0, availableForCurrentState),
      guidance,
    };
  }
}

// ---------------------------------------------------------------------------
// Branch completeness check
// ---------------------------------------------------------------------------

/**
 * Check if enough variant branches have been explored before composition.
 * Blocks compose transition when incomplete — the caller must force the
 * state machine back to generate_candidates unless budget pressure or an
 * explicit override allows proceeding.
 *
 * @param {Array} variants - List of saved variants (from store.listVariants)
 * @param {object} brief - Processing brief (for hasL check)
 * @returns {{ complete: boolean, warnings: string[] }}
 */
export function checkBranchCompleteness(variants, brief) {
  const warnings = [];
  if (!variants || variants.length === 0) {
    return { complete: false, warnings: ['No variants saved — branches may not have been explored.'] };
  }

  const variantTexts = variants.map(v => {
    const text = ((v.notes || '') + ' ' + (v.variantId || '') + ' ' + (v.viewId || '')).toLowerCase();
    return text;
  });

  // Star branch: >= 2 variants with "star" in notes/viewId
  const starCount = variantTexts.filter(t => t.includes('star')).length;
  if (starCount < 2) {
    warnings.push(`Star branch shallow: only ${starCount} star variant(s) saved (need >= 2). Explore more star processing options.`);
  }

  // Color branch: >= 2 variants with "color" or "saturation"
  const colorCount = variantTexts.filter(t => t.includes('color') || t.includes('saturation')).length;
  if (colorCount < 2) {
    warnings.push(`Color branch shallow: only ${colorCount} color variant(s) saved (need >= 2). Explore more saturation/color options.`);
  }

  // L detail branch (if hasL): >= 2 variants with "detail", "lhe", or "l_detail"
  const hasL = !!(brief?.dataDescription?.channels?.L || brief?.files?.L);
  if (hasL) {
    const detailCount = variantTexts.filter(t =>
      t.includes('detail') || t.includes('lhe') || t.includes('l_detail')
    ).length;
    if (detailCount < 2) {
      warnings.push(`L detail branch shallow: only ${detailCount} detail variant(s) saved (need >= 2). Explore more LHE/HDRMT options.`);
    }
  }

  const complete = warnings.length === 0;
  return { complete, warnings };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new state machine instance for a GIGA run.
 * @param {number} maxTurns - Total turn budget (default 200).
 * @returns {StateMachine}
 */
export function createStateMachine(maxTurns = 200) {
  return new StateMachine(maxTurns);
}

// Also export the class for type checking / testing.
export { StateMachine, STATE_BUDGET_CAPS, INTERNAL_TOOLS, STATE_TOOLS };
