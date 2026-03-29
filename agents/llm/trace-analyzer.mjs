// ============================================================================
// Trace Analyzer — reads a trace.jsonl file and produces structured analysis
// of a GIGA pipeline agent run.
//
// Trace format: one JSON object per line with fields:
//   seq, ts, relMs, tool, args, viewId, durationMs, resultSummary, error
//
// Returns a rich analysis object with branch detection, quality gates,
// retry sequences, tool stats, and finish outcome.
// ============================================================================
import fs from 'fs';

// Tools whose repeated calls are informational, not retries.
// These are read-only measurement/inspection tools.
const READ_ONLY_TOOLS = new Set([
  'get_image_stats',
  'check_saturation',
  'check_ringing',
  'check_star_quality',
  'check_core_burning',
  'scan_burnt_regions',
  'check_sharpness',
  'list_open_images',
  'recall_memory',
  'compute_scores',
  'measure_subject_detail',
]);

// Tools that act as quality gates.
const QUALITY_GATE_TOOLS = new Set([
  'check_saturation',
  'check_ringing',
  'check_star_quality',
  'check_core_burning',
  'scan_burnt_regions',
  'check_sharpness',
  'finish',
]);

/**
 * Parse a trace.jsonl file into an array of entry objects.
 * Skips blank lines and lines that fail JSON parsing (with a warning).
 *
 * @param {string} tracePath - Absolute path to the trace.jsonl file
 * @returns {object[]} Parsed trace entries
 */
function parseTraceFile(tracePath) {
  if (!fs.existsSync(tracePath)) {
    return [];
  }

  const raw = fs.readFileSync(tracePath, 'utf-8');
  const lines = raw.split('\n');
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const entry = JSON.parse(line);
      // Normalize: ensure required fields have defaults
      entries.push({
        seq: entry.seq ?? i,
        ts: entry.ts ?? 0,
        relMs: entry.relMs ?? 0,
        tool: entry.tool ?? 'unknown',
        args: entry.args ?? {},
        viewId: entry.viewId ?? null,
        durationMs: entry.durationMs ?? 0,
        resultSummary: entry.resultSummary ?? '',
        error: entry.error ?? null,
      });
    } catch (err) {
      // Skip malformed lines — could be truncated writes
      console.warn(`[trace-analyzer] Skipping malformed line ${i + 1}: ${err.message}`);
    }
  }

  return entries;
}

/**
 * Detect branches created via clone_image tool calls.
 * A branch starts when clone_image is called, and all subsequent operations
 * on that clone_id belong to that branch.
 *
 * @param {object[]} entries - Parsed trace entries
 * @param {string|null} winnerViewId - The winning view_id from finish
 * @returns {object} Map of clone_id -> branch info
 */
function detectBranches(entries, winnerViewId) {
  const branches = {};

  // First pass: find all clone_image calls to establish branches
  for (const entry of entries) {
    if (entry.tool === 'clone_image' && entry.args) {
      const sourceId = entry.args.source_id;
      const cloneId = entry.args.clone_id;
      if (cloneId) {
        branches[cloneId] = {
          parentView: sourceId || null,
          createdAtSeq: entry.seq,
          entries: [entry.seq],
          outcome: 'dead-end', // default; upgraded later
        };
      }
    }
  }

  // Second pass: assign subsequent operations to branches
  const branchIds = new Set(Object.keys(branches));
  for (const entry of entries) {
    if (entry.tool === 'clone_image') continue; // already recorded

    // An entry belongs to a branch if its viewId matches a known clone_id
    const vid = entry.viewId || entry.args?.view_id || entry.args?.target_id;
    if (vid && branchIds.has(vid)) {
      branches[vid].entries.push(entry.seq);
    }
  }

  // Third pass: determine outcomes
  // Collect all closed view_ids
  const closedViews = new Set();
  for (const entry of entries) {
    if (entry.tool === 'close_image') {
      const vid = entry.args?.view_id;
      if (vid) closedViews.add(vid);
    }
  }

  // Collect all views that were used as inputs to operations producing the winner.
  // This catches merges: if branch A was used as source in a PixelMath that produced
  // the winner, branch A is "merged".
  const mergedSources = new Set();
  if (winnerViewId) {
    for (const entry of entries) {
      // Look for operations that reference a branch as source and produce the winner
      const args = entry.args || {};
      const targetVid = entry.viewId || args.view_id || args.target_id;
      if (targetVid === winnerViewId) {
        // Any source references in args that match a branch are merged
        for (const key of Object.keys(args)) {
          const val = args[key];
          if (typeof val === 'string' && branchIds.has(val)) {
            mergedSources.add(val);
          }
        }
      }
    }
  }

  for (const [cloneId, branch] of Object.entries(branches)) {
    if (winnerViewId && cloneId === winnerViewId) {
      branch.outcome = 'winner';
    } else if (mergedSources.has(cloneId)) {
      branch.outcome = 'merged';
    } else if (closedViews.has(cloneId)) {
      branch.outcome = 'dead-end';
    }
    // else remains 'dead-end' (abandoned without explicit close)
  }

  return branches;
}

/**
 * Detect quality gate results from trace entries.
 * Quality gate tools report PASS/FAIL in their resultSummary.
 * The finish tool reports PASSED/REJECTED.
 *
 * @param {object[]} entries - Parsed trace entries
 * @returns {object[]} Array of quality gate result objects
 */
function detectQualityGates(entries) {
  const gates = [];

  for (const entry of entries) {
    if (!QUALITY_GATE_TOOLS.has(entry.tool)) continue;

    const summary = (entry.resultSummary || '').toUpperCase();
    let pass = null;
    let metric = '';
    let details = entry.resultSummary || '';

    if (entry.tool === 'finish') {
      // Finish has special pass/fail semantics
      if (summary.includes('REJECTED')) {
        pass = false;
        metric = 'finish_gate';
      } else if (summary.includes('PASSED') || summary.includes('FINISHED')) {
        pass = true;
        metric = 'finish_gate';
      } else {
        // Ambiguous — skip
        continue;
      }
    } else {
      // Standard quality gate tools
      if (summary.includes('PASS')) {
        pass = true;
      } else if (summary.includes('FAIL')) {
        pass = false;
      } else {
        // Some gates return numeric results without explicit PASS/FAIL
        // (e.g., check_sharpness returns a score). Still record them.
        pass = null;
      }
      metric = entry.tool;
    }

    gates.push({
      seq: entry.seq,
      tool: entry.tool,
      viewId: entry.viewId,
      pass,
      metric,
      details: details.slice(0, 500),
    });
  }

  return gates;
}

/**
 * Detect retry sequences: the same non-read-only tool called multiple times
 * on the same viewId, presumably with different parameters.
 * Excludes finish (tracked separately via finishAttempts/finishRejections).
 *
 * @param {object[]} entries - Parsed trace entries
 * @returns {object[]} Array of retry sequence objects
 */
function detectRetries(entries) {
  // Group by (tool, viewId) — only for non-read-only, non-finish tools
  const groups = new Map();

  for (const entry of entries) {
    if (READ_ONLY_TOOLS.has(entry.tool)) continue;
    if (entry.tool === 'finish') continue; // tracked separately
    if (!entry.viewId) continue;

    const key = `${entry.tool}::${entry.viewId}`;
    if (!groups.has(key)) {
      groups.set(key, { tool: entry.tool, viewId: entry.viewId, attempts: [] });
    }
    groups.get(key).attempts.push({ seq: entry.seq, args: entry.args });
  }

  // Only keep groups with more than one attempt (actual retries)
  const retries = [];
  for (const group of groups.values()) {
    if (group.attempts.length > 1) {
      retries.push(group);
    }
  }

  return retries;
}

/**
 * Compute per-tool usage statistics.
 *
 * @param {object[]} entries - Parsed trace entries
 * @returns {object} Map of tool_name -> { count, totalMs }
 */
function computeToolStats(entries) {
  const stats = {};

  for (const entry of entries) {
    const name = entry.tool;
    if (!stats[name]) {
      stats[name] = { count: 0, totalMs: 0 };
    }
    stats[name].count++;
    stats[name].totalMs += entry.durationMs || 0;
  }

  return stats;
}

/**
 * Detect the finish outcome: winning view_id, number of attempts, rejections.
 *
 * @param {object[]} entries - Parsed trace entries
 * @returns {{ winnerViewId: string|null, finishAttempts: number, finishRejections: number }}
 */
function detectFinishOutcome(entries) {
  let winnerViewId = null;
  let finishAttempts = 0;
  let finishRejections = 0;

  for (const entry of entries) {
    if (entry.tool !== 'finish') continue;

    finishAttempts++;

    const summary = (entry.resultSummary || '').toUpperCase();
    if (summary.includes('REJECTED')) {
      finishRejections++;
    } else if (summary.includes('PASSED') || summary.includes('FINISHED')) {
      // Extract winning view_id from resultSummary
      // Expected format: "Finished (quality gates PASSED). Best: VIEW_ID"
      const bestMatch = entry.resultSummary.match(/Best:\s*(\S+)/i);
      if (bestMatch) {
        winnerViewId = bestMatch[1];
      } else {
        // Fallback: use the view_id from the tool args
        winnerViewId = entry.args?.view_id || entry.viewId || null;
      }
    }
  }

  // If no successful finish but args had view_id, use the last attempt's view_id
  if (!winnerViewId && finishAttempts > 0) {
    const lastFinish = entries.filter(e => e.tool === 'finish').pop();
    if (lastFinish) {
      winnerViewId = lastFinish.args?.view_id || lastFinish.viewId || null;
    }
  }

  return { winnerViewId, finishAttempts, finishRejections };
}

/**
 * Analyze a trace.jsonl file and return a structured analysis of the pipeline run.
 *
 * @param {string} tracePath - Absolute path to the trace.jsonl file
 * @returns {object} Structured analysis object
 */
export function analyzeTrace(tracePath) {
  const entries = parseTraceFile(tracePath);

  // Handle empty trace
  if (entries.length === 0) {
    return {
      totalCalls: 0,
      totalDurationMs: 0,
      wallClockMs: 0,
      branches: {},
      qualityGates: [],
      retries: [],
      toolStats: {},
      winnerViewId: null,
      finishAttempts: 0,
      finishRejections: 0,
      entries: [],
    };
  }

  // Basic aggregates
  const totalCalls = entries.length;
  const totalDurationMs = entries.reduce((sum, e) => sum + (e.durationMs || 0), 0);

  // Wall clock: last timestamp minus first timestamp
  const timestamps = entries.map(e => e.ts).filter(t => t > 0);
  const wallClockMs = timestamps.length >= 2
    ? timestamps[timestamps.length - 1] - timestamps[0]
    : 0;

  // Finish detection (needed before branch detection for winner assignment)
  const { winnerViewId, finishAttempts, finishRejections } = detectFinishOutcome(entries);

  // Branch detection
  const branches = detectBranches(entries, winnerViewId);

  // Quality gates
  const qualityGates = detectQualityGates(entries);

  // Retry sequences
  const retries = detectRetries(entries);

  // Tool usage stats
  const toolStats = computeToolStats(entries);

  return {
    totalCalls,
    totalDurationMs,
    wallClockMs,
    branches,
    qualityGates,
    retries,
    toolStats,
    winnerViewId,
    finishAttempts,
    finishRejections,
    entries,
  };
}
