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
  // WI-10: hidden legacy tools (tools.mjs hidden:true) — never available to the mega-agent
  'check_core_burning', 'compute_scores', 'check_constraints', 'submit_scores', 'auto_stretch', 'star_screen_blend',
  'open_image', 'combine_channels',
]);

/** Compose-state tools (finalize is a strict superset of this set). */
const COMPOSE_TOOLS = new Set([
    'finish',
    'lrgb_combine', 'star_protected_blend', 'restore_star_color',
    'run_curves', 'run_pixelmath',
    'multi_scale_enhance', 'shell_detail_enhance', 'continuous_clamp',
    'clone_image', 'restore_from_clone', 'close_image',
    'save_variant', 'load_variant', 'list_variants',
    'save_and_show_preview',
    'get_image_stats', 'measure_subject_detail',    'check_saturation', 'check_star_quality', 'check_ringing',
    'check_sharpness', 'scan_burnt_regions', 
    'check_tonal_presence', 'check_star_layer_integrity', 'check_bright_chroma',
    'check_highlight_texture',
    
    'create_luminance_mask', 'create_adaptive_zone_masks',
    'apply_mask', 'remove_mask', 'close_mask',
    'rename_view', 'purge_undo',
    // WI-05: dust/mask/detail/denoise tools stay usable after a REJECTED finish
    'lift_dust', 'inject_l_ifn', 'run_nxt', 'run_scnr', 'run_hdrmt', 'create_zone_masks',
    'inject_luminance', 'stretch_stars', 'check_star_layer_integrity',
]);

/** Tools restricted to specific states.  Anything NOT here and NOT internal
 *  is treated as public (allowed in any state). */
const STATE_TOOLS = {
  assess: new Set([
    'get_image_stats',
    'measure_subject_detail', 'check_saturation',
    'check_star_quality', 'check_ringing', 'check_sharpness',
    'scan_burnt_regions', 
    'check_tonal_presence',
    
    'save_and_show_preview', 'save_variant', 'rename_view',
    'clone_image', 'close_image', 'purge_undo',
  ]),

  generate_candidates: new Set([
    // Candidate generation
    'multi_scale_enhance', 'shell_detail_enhance', 'run_hdrmt', 'run_curves', 'run_pixelmath',
    'run_nxt', 'run_bxt', 'run_scnr', 'run_sxt',
    'seti_stretch', 'stretch_stars', 
    'run_spcc', 'run_background_neutralization',
    // Ha / narrowband
    'ha_inject_red', 'ha_inject_luminance', 'continuum_subtract_ha',
    'extract_pseudo_oiii', 'dynamic_narrowband_blend', 'create_synthetic_luminance',
    // Masks
    'create_luminance_mask', 'apply_mask', 'remove_mask', 'close_mask',
    'create_zone_masks', 'create_adaptive_zone_masks',
    // Image management
    'clone_image', 'restore_from_clone', 'close_image', 'purge_undo',
    'rename_view',
    // Measurement
    'get_image_stats', 'measure_subject_detail',    'check_saturation', 'check_star_quality', 'check_ringing',
    'check_sharpness', 'scan_burnt_regions',
    
    'check_tonal_presence', 'check_star_layer_integrity', 'check_bright_chroma',
    'check_highlight_texture',
    // Artifacts
    'continuous_clamp',
    // Variants
    'save_variant', 'load_variant', 'list_variants',
    'save_and_show_preview', 
        // Star handling (for star branch)
    'star_protected_blend', 'restore_star_color',
    // WI-05: dust/L-IFN, LRGB, luminance injection, mask ops available while generating
    'lift_dust', 'inject_l_ifn', 'lrgb_combine', 'inject_luminance',
    // mask_ops is public (WI-15): not in any STATE_TOOLS set
  ]),

  compose: COMPOSE_TOOLS,

  // repair: tools determined dynamically by repairPolicy.allowedTools

  // finalize must never be more restrictive than compose (WI-05); terminal state.
  finalize: new Set([
    ...COMPOSE_TOOLS,
    'finish',
    'run_pixelmath', 'run_curves', 'continuous_clamp',
    'run_nxt', 'run_scnr', // the finish noise/green gates DEMAND these — must be runnable in finalize (was the blocked-final-denoise bug)
    'lift_dust', 'inject_l_ifn', // IFN/dust + noise/color polish in finalize
    'star_protected_blend', 'stretch_stars', 'check_star_layer_integrity', // safety net: allow star blend in finalize
    'lrgb_combine', // safety net: allow LRGB if finish rejected for missing it
    'clone_image', 'restore_from_clone',
    'save_variant', 'save_and_show_preview',    'get_image_stats', 'measure_subject_detail',    'check_saturation', 'check_star_quality', 'check_ringing',
    'scan_burnt_regions', 'check_sharpness',
    'check_tonal_presence', 'check_bright_chroma',
    'check_highlight_texture',
    
    'close_image',
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
  constructor(maxTurns, opts = {}) {
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
    this._repairReturnState = 'compose';  // where exitRepair() goes (compose or finalize)
    // WI-05: warm start (--base-run) has no branch phase: begin directly in compose.
    this.warmStart = !!opts.warmStart;
    if (this.warmStart) this.state = 'compose';
  }

  /** WI-05: serialisable snapshot (used by WI-07b). */
  toJSON() {
    return {
      state: this.state,
      turnsUsed: this.turnsUsed,
      stateTurns: { ...this.stateTurns },
      stateStartTurn: this.stateStartTurn,
      repairPolicyName: this.repairPolicy ? (this.repairPolicy.name || this.repairPolicy.id || null) : null,
      _branchCompletenessOverride: false,   // retained for snapshot compatibility; branch completeness is advisory
      _repairReturnState: this._repairReturnState,
    };
  }

  /** WI-05: restore from a toJSON() snapshot. repairPolicy object is NOT restored (only its name is recorded). */
  restore(snapshot) {
    if (!snapshot) return this;
    this.state = snapshot.state;
    this.turnsUsed = snapshot.turnsUsed || 0;
    this.stateTurns = { ...this.stateTurns, ...(snapshot.stateTurns || {}) };
    this.stateStartTurn = snapshot.stateStartTurn || 0;
    this._repairReturnState = snapshot._repairReturnState || 'compose';
    this.repairPolicy = null;
    if (this.state === 'repair') this.state = this._repairReturnState;  // policy object is gone; do not stay in a policy-less repair
    return this;
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
          reason: `Tool "${toolName}" is not permitted by the active repair policy (${this.repairPolicy.name || this.repairPolicy.id || 'unnamed'}).`,
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
      const refusedBegin = toolName === 'begin_composition' && /^save at least 2/i.test(resultSummary || '');
      if (toolName === 'lrgb_combine' || toolName === 'star_screen_blend' || toolName === 'star_protected_blend' ||
          (toolName === 'begin_composition' && !refusedBegin)) {
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
      // Only a PASSED finish moves to finalize; a 'FINISH REJECTED' leaves the state unchanged.
      if (toolName === 'finish' && /^Finished \(quality gates PASSED\)/.test(resultSummary || '')) {
        this.transitionTo('finalize');
        return;
      }
      // Budget cap - move to finalize (skip repair if budget is tight).
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

  /**
   * Record a BLOCKED call (state policy / repair policy / budget exhausted).
   * Consumes budget so a block loop is bounded, but applies ONLY the
   * force-finalize (<=15 remaining) and per-state budget caps - never the
   * tool-name sentinels (a blocked lrgb_combine must not advance to compose).
   */
  recordBlockedCall() {
    this.turnsUsed++;
    this.stateTurns[this.state]++;
    const stateBudgetUsed = this.turnsUsed - this.stateStartTurn;
    const turnsRemaining = this.maxTurns - this.turnsUsed;
    if (turnsRemaining <= 15 && this.state !== 'finalize') {
      this.transitionTo('finalize');
      return;
    }
    const cap = STATE_BUDGET_CAPS[this.state];
    if (cap !== undefined && stateBudgetUsed >= cap) {
      if (this.state === 'assess') this.transitionTo('generate_candidates');
      else if (this.state === 'generate_candidates') this.transitionTo('compose');
      else if (this.state === 'compose') this.transitionTo('finalize');
      else if (this.state === 'repair') this.exitRepair();
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
    if (this.state !== 'compose' && this.state !== 'finalize') {
      throw new Error(`Cannot enter repair from state "${this.state}" (must be in compose or finalize).`);
    }
    this._repairReturnState = this.state;
    this.repairPolicy = policy;
    this.repairAttempts++;
    this.transitionTo('repair');
  }

  /**
   * Exit repair state (success or budget exhausted).
   * Returns to the state repair was entered from (compose or finalize).
   */
  exitRepair() {
    this.repairPolicy = null;
    this.transitionTo(this._repairReturnState || 'compose');
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
 * ADVISORY ONLY (WI-05): the caller appends the warnings to the tool result;
 * it never blocks or reverts the transition.
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

  // WI-19: an explicit params.stage (branch_stars/color/detail/palette) is authoritative for that
  // variant; only variants without a specific branch stage fall back to the notes/viewId text match.
  const STAGE_CAT = { branch_stars: 'star', branch_color: 'color', branch_detail: 'detail', branch_palette: 'palette' };
  const stageOf = (v) => (v && v.params && typeof v.params.stage === 'string') ? v.params.stage : null;
  const variantTexts = variants.map(v => {
    const st = stageOf(v);
    if (st && STAGE_CAT[st]) return STAGE_CAT[st] + ' ' + (st === 'branch_detail' ? 'l_detail ' : '') + (st === 'branch_palette' ? 'palette ' : '') + (st === 'branch_color' ? 'saturation ' : '');
    if (st && st !== 'branch_unspecified' && st !== 'base') return ''; // ifn/core/composition/final stages are not star/color/detail/palette coverage
    const text = ((v.notes || '') + ' ' + (v.variantId || '') + ' ' + (v.viewId || '')).toLowerCase();
    return text;
  });

  // Star branch: >= 2 variants with "star" in notes/viewId — not for starless deliverables
  const isStarless = !!brief?.dataDescription?.starless;
  const starCount = variantTexts.filter(t => t.includes('star')).length;
  if (!isStarless && starCount < 2) {
    warnings.push(`Star branch shallow: only ${starCount} star variant(s) saved (need >= 2). Explore more star processing options.`);
  }

  // Color branch: >= 2 variants with "color" or "saturation" (narrowband: palette/hue/sho/hoo/foraxx notes count too)
  const nbColor = !!brief?.dataDescription?.narrowband;
  const colorCount = variantTexts.filter(t => t.includes('color') || t.includes('saturation') ||
    (nbColor && /palette|hue|sho|hoo|foraxx/.test(t))).length;
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

  // Palette branch (SHO/HOO): >= 2 palette variants (palette / gains / hue shift bracketed)
  if (brief?.dataDescription?.narrowband) {
    const palCount = variantTexts.filter(t => /palette|foraxx|hue|sho|hoo/.test(t)).length;
    if (palCount < 2) {
      warnings.push(`Palette branch shallow: only ${palCount} palette variant(s) saved (need >= 2). Bracket sho_combine palettes/gains and sho_hue_shift strength.`);
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
 * @param {{warmStart?: boolean}} opts - warmStart: begin in compose (no branch phase).
 * @returns {StateMachine}
 */
export function createStateMachine(maxTurns = 200, opts = {}) {
  return new StateMachine(maxTurns, opts);
}

// Also export the class for type checking / testing.
export { StateMachine, STATE_BUDGET_CAPS, INTERNAL_TOOLS, STATE_TOOLS };


// ---------------------------------------------------------------------------
// WI-07a: MCP-side turn budget for non-giga agents + exhaustion gate
// ---------------------------------------------------------------------------

/** Counter-only budget object for agents that have no state machine (gradient, core). */
export function createCounterBudget(maxTurns = 250) {
  return {
    state: 'free',
    repairPolicy: null,
    _branchCompletenessOverride: false,
    turnsUsed: 0,
    maxTurns,
    recordToolCall() { this.turnsUsed++; },
    recordBlockedCall() { this.turnsUsed++; },
    getBudgetStatus() {
      const turnsRemaining = this.maxTurns - this.turnsUsed;
      const status = turnsRemaining <= 15 ? 'critical' : turnsRemaining <= 30 ? 'converge' : 'ok';
      return { turnsUsed: this.turnsUsed, turnsRemaining, maxTurns: this.maxTurns, status, state: this.state, guidance: [] };
    },
    checkToolAccess: () => ({ allowed: true }),
    enterRepair() {},
    transitionTo() {},
  };
}

export const EXHAUST_WHITELIST = {
  giga_orchestrator: ['finish', 'save_variant', 'list_variants', 'load_variant', 'get_image_stats', 'save_memory', 'close_image', 'run_quality_gates'],
  core_specialist: ['restore_from_clone', 'close_image', 'get_image_stats', 'save_memory', 'save_variant'],
  gradient_agent: ['measure_color_gradient', 'measure_subject_detail', 'save_memory'],
};

const EXHAUST_INSTRUCTION = {
  giga_orchestrator: 'finish is in EMERGENCY mode - call finish with your best saved variant now.',
  core_specialist: 'restore_from_clone your best clone into CORE_WORK and stop.',
  gradient_agent: 'stop now.',
};

/**
 * Budget-exhaustion gate. Returns null if the call may proceed, else the
 * refusal text for the agent.
 */
export function checkBudgetExhausted(agentName, toolName, budget) {
  if (!budget || budget.turnsRemaining > 0) return null;
  const list = EXHAUST_WHITELIST[agentName];
  if (list && list.includes(toolName)) return null;
  const allowed = (list || []).join(', ') || 'none';
  return `BUDGET EXHAUSTED: only ${allowed} are allowed. ` + (EXHAUST_INSTRUCTION[agentName] || 'stop now.');
}
