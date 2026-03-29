// ============================================================================
// Trace visualization: Mermaid flowchart + Markdown summary from trace analysis
// ============================================================================

// ============================================================================
// Constants
// ============================================================================

/** Tools to skip entirely from the diagram (housekeeping noise) */
const SKIP_TOOLS = new Set([
  'close_image', 'close_mask', 'remove_mask', 'purge_undo_history',
  'list_open_images', 'create_luminance_mask', 'apply_mask',
]);

/** Tools to collapse as annotations on the preceding node */
const ANNOTATION_TOOLS = new Set([
  'get_image_stats',
]);

/** Quality gate tool names */
const QUALITY_GATE_TOOLS = new Set([
  'check_saturation', 'check_ringing', 'check_sharpness',
  'check_core_burning', 'scan_burnt_regions', 'check_star_quality',
]);

/** Composition-phase tools */
const COMPOSITION_TOOLS = new Set([
  'lrgb_combine', 'star_screen_blend',
]);

const STYLE_CLASSES = `
    classDef winner fill:#1a4a1a,stroke:#4a8c1c,color:#fff
    classDef deadend fill:#4a1a1a,stroke:#8c3c1c,color:#fff
    classDef gate_pass fill:#1a4a1a,stroke:#2d7a2d,color:#fff
    classDef gate_fail fill:#5c1616,stroke:#c0392b,color:#fff
    classDef normal fill:#1a3a5c,stroke:#2980b9,color:#fff
    classDef clone fill:#3a1a5c,stroke:#7b2fbe,color:#fff`;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Safely access a nested value, returning a fallback if missing.
 */
function safeGet(obj, path, fallback) {
  if (!obj) return fallback;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return fallback;
    cur = cur[p];
  }
  return cur !== undefined && cur !== null ? cur : fallback;
}

/**
 * Format a duration in milliseconds as a human-readable string.
 */
function formatDuration(ms) {
  if (ms == null || isNaN(ms)) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/**
 * Parse a numeric value from a resultSummary string (e.g. "P90=0.482").
 */
function parseResultValue(summary, key) {
  if (!summary || typeof summary !== 'string') return null;
  const re = new RegExp(key + '\\s*=\\s*([0-9.eE+-]+)');
  const m = summary.match(re);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Escape text for Mermaid node labels (quotes and special chars).
 */
function mermaidEscape(text) {
  if (!text) return '';
  return text
    .replace(/"/g, "'")
    .replace(/[<>]/g, '')
    .replace(/&/g, '&amp;');
}

/**
 * Truncate a string to maxLen, appending ellipsis if needed.
 */
function truncate(str, maxLen) {
  if (!str) return '';
  return str.length <= maxLen ? str : str.slice(0, maxLen) + '...';
}

/**
 * Build a compact parameter summary for a tool call node label.
 */
function toolParamSummary(entry) {
  const tool = entry.tool;
  const args = entry.args || {};
  const result = entry.resultSummary || '';

  switch (tool) {
    case 'clone_image':
      return `${safeGet(args, 'source_view_id', '?')} -> ${safeGet(args, 'clone_id', '?')}`;
    case 'get_image_stats': {
      const med = parseResultValue(result, 'median');
      return med != null ? `med=${med.toFixed(4)}` : '';
    }
    case 'run_lhe':
      return `r=${safeGet(args, 'radius', '?')} a=${safeGet(args, 'amount', '?')}`;
    case 'run_hdrmt':
      return `layers=${safeGet(args, 'number_of_layers', '?')} iter=${safeGet(args, 'iterations', '?')}`;
    case 'multi_scale_enhance':
      return `clip=${safeGet(args, 'mask_clip_low', '?')}`;
    case 'run_nxt':
      return `d=${safeGet(args, 'denoise', '?')}`;
    case 'run_curves':
      return `${safeGet(args, 'channel', '?')}`;
    case 'run_pixelmath':
      return truncate(safeGet(args, 'expression', ''), 30);
    case 'ha_inject_red':
      return `str=${safeGet(args, 'strength', '?')}`;
    case 'lrgb_combine':
      return `L=${safeGet(args, 'l_id', '?')} light=${safeGet(args, 'lightness', '?')}`;
    case 'star_screen_blend':
      return `str=${safeGet(args, 'strength', '?')}`;
    case 'continuous_clamp':
      return `min=${safeGet(args, 'min', '?')} max=${safeGet(args, 'max', '?')}`;
    case 'check_saturation': {
      const p90 = parseResultValue(result, 'P90');
      return p90 != null ? `P90=${p90.toFixed(2)}` : '';
    }
    case 'check_ringing': {
      const osc = parseResultValue(result, 'osc');
      return osc != null ? `osc=${osc.toFixed(3)}` : '';
    }
    case 'scan_burnt_regions': {
      const blocks = parseResultValue(result, 'blocks');
      return blocks != null ? `blocks=${blocks}` : '';
    }
    case 'finish': {
      const vid = safeGet(args, 'view_id', '?');
      const passed = !entry.error && !/REJECT/i.test(result);
      return `${vid} ${passed ? 'PASSED' : 'REJECTED'}`;
    }
    case 'save_variant':
      return `${safeGet(args, 'label', '?')}`;
    case 'recall_memory':
      return truncate(safeGet(args, 'query', ''), 20);
    default:
      return '';
  }
}

/**
 * Determine which phase an entry belongs to.
 * Returns 'pre-branch' | branchCloneId | 'composition' | 'finish'
 */
function classifyEntry(entry, branches, firstCloneSeq, lastBranchSeq, winnerViewId) {
  if (entry.tool === 'finish') return 'finish';

  // Clone_image: assign to the branch it creates
  if (entry.tool === 'clone_image') {
    const cloneId = safeGet(entry.args, 'clone_id', null);
    if (cloneId && branches[cloneId]) return cloneId;
  }

  // Before first clone: pre-branch
  if (firstCloneSeq == null || entry.seq < firstCloneSeq) return 'pre-branch';

  // Check if entry belongs to a branch by seq membership or viewId
  const vid = entry.viewId || safeGet(entry.args, 'view_id', null);
  if (branches) {
    for (const [cloneId, branch] of Object.entries(branches)) {
      if (branch.entries && branch.entries.includes(entry.seq)) return cloneId;
      // Fallback: match by cloneId in viewId
      if (vid && (vid === cloneId || vid.includes(cloneId))) return cloneId;
    }
  }

  // After all branches: composition
  if (lastBranchSeq != null && entry.seq > lastBranchSeq) return 'composition';

  // Couldn't classify — if it's after clones, call it composition
  if (firstCloneSeq != null && entry.seq >= firstCloneSeq) return 'composition';

  return 'pre-branch';
}

/**
 * Determine if a quality gate passed or failed.
 */
function isGatePass(entry, qualityGates) {
  if (qualityGates) {
    const gate = qualityGates.find(g => g.seq === entry.seq);
    if (gate) return gate.pass;
  }
  // Fallback: check result for PASS/FAIL keywords
  const r = entry.resultSummary || '';
  if (/PASS/i.test(r)) return true;
  if (/FAIL|REJECT/i.test(r)) return false;
  return !entry.error;
}

/**
 * Check if a finish entry passed or was rejected.
 */
function isFinishPass(entry) {
  const r = entry.resultSummary || '';
  if (/REJECT/i.test(r)) return false;
  if (entry.error) return false;
  return true;
}

/**
 * Build retry groups from the retries array.
 * Returns a Map of firstSeq -> retryGroup for collapsing.
 */
function buildRetryMap(retries) {
  const map = new Map();
  if (!retries) return map;
  for (const retry of retries) {
    if (!retry.attempts || retry.attempts.length < 3) continue;
    const firstSeq = retry.attempts[0].seq;
    map.set(firstSeq, retry);
    // Mark subsequent attempts for skipping
    for (let i = 1; i < retry.attempts.length; i++) {
      map.set(retry.attempts[i].seq, { skip: true, firstSeq });
    }
  }
  return map;
}

/**
 * Build a Mermaid node label line (with tool name, params, duration).
 */
function buildNodeLabel(entry, annotation) {
  const tool = entry.tool;
  const params = toolParamSummary(entry);
  const dur = entry.durationMs != null ? formatDuration(entry.durationMs) : '';

  let parts = [mermaidEscape(tool)];
  if (params) parts.push(mermaidEscape(params));
  if (dur) parts.push(dur);
  if (annotation) parts.push(mermaidEscape(annotation));

  return parts.join('<br/>');
}

/**
 * Build a retry-collapsed node label.
 */
function buildRetryLabel(retry) {
  const tool = retry.tool;
  const count = retry.attempts.length;
  // Build parameter progression
  const paramKeys = new Set();
  for (const att of retry.attempts) {
    if (att.args) Object.keys(att.args).forEach(k => paramKeys.add(k));
  }

  let progression = '';
  for (const key of paramKeys) {
    if (key === 'view_id' || key === 'source_view_id') continue;
    const vals = retry.attempts
      .map(a => safeGet(a, `args.${key}`, null))
      .filter(v => v != null);
    if (vals.length > 1 && new Set(vals.map(String)).size > 1) {
      progression += `${key}: ${vals.join(' -> ')}<br/>`;
    }
  }

  let label = `${mermaidEscape(tool)} x${count}`;
  if (progression) label += `<br/>${progression}`;
  return label;
}

// ============================================================================
// Main exports
// ============================================================================

/**
 * Generate a Mermaid flowchart diagram from a trace analysis object.
 * @param {object} analysis - Trace analysis from trace-analyzer.mjs
 * @returns {string} Mermaid source code
 */
export function generateMermaidDiagram(analysis) {
  if (!analysis) return 'flowchart TD\n    empty["No analysis data"]';

  const entries = analysis.entries || [];
  if (entries.length === 0) return 'flowchart TD\n    empty["No entries"]';

  const branches = analysis.branches || {};
  const qualityGates = analysis.qualityGates || [];
  const retries = analysis.retries || [];
  const winnerViewId = analysis.winnerViewId || null;

  // Determine phase boundaries
  let firstCloneSeq = null;
  let lastBranchSeq = null;
  for (const e of entries) {
    if (e.tool === 'clone_image') {
      if (firstCloneSeq == null || e.seq < firstCloneSeq) firstCloneSeq = e.seq;
    }
  }
  // Last branch seq: the max seq in any branch's entries
  for (const branch of Object.values(branches)) {
    if (branch.entries) {
      for (const seq of branch.entries) {
        if (lastBranchSeq == null || seq > lastBranchSeq) lastBranchSeq = seq;
      }
    }
  }

  // Build retry map for collapsing
  const retryMap = buildRetryMap(retries);

  // Determine winner branch seqs for styling
  const winnerSeqs = new Set();
  const deadEndSeqs = new Set();
  for (const [cloneId, branch] of Object.entries(branches)) {
    const seqSet = branch.outcome === 'winner' ? winnerSeqs : deadEndSeqs;
    if (branch.entries) branch.entries.forEach(s => seqSet.add(s));
  }

  // Filter entries and classify into phases
  const phases = {
    'pre-branch': [],
    'composition': [],
    'finish': [],
  };
  // Initialize branch phases
  for (const cloneId of Object.keys(branches)) {
    phases[cloneId] = [];
  }

  let pendingAnnotation = null;
  const processedNodes = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Skip housekeeping tools
    if (SKIP_TOOLS.has(entry.tool)) continue;

    // Handle retry collapsing
    const retryInfo = retryMap.get(entry.seq);
    if (retryInfo && retryInfo.skip) continue; // subsequent retry attempt, skip

    // Annotation tools: attach to next processing node
    if (ANNOTATION_TOOLS.has(entry.tool) && entry.tool !== 'finish') {
      const med = parseResultValue(entry.resultSummary, 'median');
      if (med != null) pendingAnnotation = `med=${med.toFixed(4)}`;
      continue;
    }

    const phase = classifyEntry(entry, branches, firstCloneSeq, lastBranchSeq, winnerViewId);

    // Ensure phase bucket exists
    if (!phases[phase]) phases[phase] = [];

    const nodeId = `n${entry.seq}`;
    const isQualityGate = QUALITY_GATE_TOOLS.has(entry.tool);
    const isFinish = entry.tool === 'finish';
    const isClone = entry.tool === 'clone_image';

    // Build the node
    let label;
    let shape;

    if (retryInfo && !retryInfo.skip) {
      // This is the first entry of a retry group
      label = buildRetryLabel(retryInfo);
      shape = 'rect';
    } else {
      const ann = pendingAnnotation;
      pendingAnnotation = null;
      label = buildNodeLabel(entry, ann);
      shape = isQualityGate ? 'diamond' : isFinish ? 'hexagon' : isClone ? 'stadium' : 'rect';
    }

    // Determine styling class
    let styleClass = 'normal';
    if (isClone) {
      styleClass = 'clone';
    } else if (isQualityGate) {
      styleClass = isGatePass(entry, qualityGates) ? 'gate_pass' : 'gate_fail';
    } else if (isFinish) {
      styleClass = isFinishPass(entry) ? 'gate_pass' : 'gate_fail';
    } else if (winnerSeqs.has(entry.seq)) {
      styleClass = 'winner';
    } else if (deadEndSeqs.has(entry.seq)) {
      styleClass = 'deadend';
    }

    const node = { nodeId, label, shape, styleClass, seq: entry.seq, phase, entry };
    phases[phase].push(node);
    processedNodes.push(node);
  }

  // Size control: if too many nodes, collapse consecutive same-category runs
  const totalVisible = processedNodes.length;
  if (totalVisible > 120) {
    collapseConsecutive(phases, 3);
  }

  // Generate Mermaid source
  const lines = ['flowchart TD'];

  // Emit subgraphs
  emitSubgraph(lines, 'Assessment', phases['pre-branch']);
  for (const cloneId of Object.keys(branches)) {
    const branchNodes = phases[cloneId] || [];
    if (branchNodes.length > 0) {
      const outcome = branches[cloneId].outcome || 'unknown';
      const label = `${cloneId} [${outcome}]`;
      emitSubgraph(lines, label, branchNodes);
    }
  }
  emitSubgraph(lines, 'Composition', phases['composition']);
  emitSubgraph(lines, 'Finish', phases['finish']);

  // Emit connections
  emitConnections(lines, phases, branches, firstCloneSeq);

  // Emit style classes
  lines.push(STYLE_CLASSES);

  // Apply classes to nodes
  for (const node of processedNodes) {
    if (node.styleClass !== 'normal') {
      lines.push(`    class ${node.nodeId} ${node.styleClass}`);
    }
  }

  return lines.join('\n');
}

/**
 * Emit a subgraph with its nodes into lines array.
 */
function emitSubgraph(lines, label, nodes) {
  if (!nodes || nodes.length === 0) return;

  lines.push(`    subgraph ${sanitizeSubgraphId(label)}["${mermaidEscape(label)}"]`);
  for (const node of nodes) {
    lines.push(`        ${renderNode(node)}`);
  }
  lines.push('    end');
}

/**
 * Sanitize a label for use as a Mermaid subgraph ID.
 */
function sanitizeSubgraphId(label) {
  return label.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Render a single node in Mermaid syntax.
 */
function renderNode(node) {
  const { nodeId, label, shape } = node;
  switch (shape) {
    case 'diamond':
      return `${nodeId}{{"${label}"}}`;
    case 'hexagon':
      return `${nodeId}{{"${label}"}}`;
    case 'stadium':
      return `${nodeId}(["${label}"])`;
    case 'rect':
    default:
      return `${nodeId}["${label}"]`;
  }
}

/**
 * Emit connections between nodes across phases.
 */
function emitConnections(lines, phases, branches, firstCloneSeq) {
  // Connect nodes sequentially within each phase
  for (const [phaseName, nodes] of Object.entries(phases)) {
    if (!nodes || nodes.length < 2) continue;
    for (let i = 0; i < nodes.length - 1; i++) {
      lines.push(`    ${nodes[i].nodeId} --> ${nodes[i + 1].nodeId}`);
    }
  }

  const preBranch = phases['pre-branch'] || [];
  const lastPreBranch = preBranch.length > 0 ? preBranch[preBranch.length - 1] : null;

  // Connect pre-branch to each branch's first node
  if (lastPreBranch) {
    for (const cloneId of Object.keys(branches)) {
      const branchNodes = phases[cloneId] || [];
      if (branchNodes.length > 0) {
        lines.push(`    ${lastPreBranch.nodeId} --> ${branchNodes[0].nodeId}`);
      }
    }
  }

  // Connect each branch's last node to composition phase
  const composition = phases['composition'] || [];
  const firstComposition = composition.length > 0 ? composition[0] : null;
  if (firstComposition) {
    for (const cloneId of Object.keys(branches)) {
      const branchNodes = phases[cloneId] || [];
      if (branchNodes.length > 0) {
        const lastNode = branchNodes[branchNodes.length - 1];
        lines.push(`    ${lastNode.nodeId} --> ${firstComposition.nodeId}`);
      }
    }
  }

  // Connect composition to finish
  const finishNodes = phases['finish'] || [];
  const lastComposition = composition.length > 0 ? composition[composition.length - 1] : null;
  if (lastComposition && finishNodes.length > 0) {
    lines.push(`    ${lastComposition.nodeId} --> ${finishNodes[0].nodeId}`);
  } else if (lastPreBranch && finishNodes.length > 0 && Object.keys(branches).length === 0 && composition.length === 0) {
    // No branches and no composition — connect pre-branch directly to finish
    lines.push(`    ${lastPreBranch.nodeId} --> ${finishNodes[0].nodeId}`);
  }

  // Finish rejections: if multiple finish nodes, connect rejection back to composition or previous finish
  for (let i = 0; i < finishNodes.length - 1; i++) {
    const curr = finishNodes[i];
    const isRejection = !isFinishPass(curr.entry);
    if (isRejection) {
      // Loop back: rejected finish connects to the next node (which could be a rework step or next finish)
      lines.push(`    ${curr.nodeId} -->|"rejected"| ${finishNodes[i + 1].nodeId}`);
    }
  }
}

/**
 * Collapse runs of 3+ consecutive same-tool nodes into single aggregate nodes.
 * Mutates the phase arrays in place.
 */
function collapseConsecutive(phases, minRun) {
  for (const [phaseName, nodes] of Object.entries(phases)) {
    if (!nodes || nodes.length < minRun) continue;

    const collapsed = [];
    let i = 0;
    while (i < nodes.length) {
      // Find run of same tool category
      const cat = getToolCategory(nodes[i].entry.tool);
      let j = i + 1;
      while (j < nodes.length && getToolCategory(nodes[j].entry.tool) === cat) {
        j++;
      }
      const runLen = j - i;
      if (runLen >= minRun && cat !== 'quality' && cat !== 'finish') {
        // Collapse into one node
        const first = nodes[i];
        const tools = [...new Set(nodes.slice(i, j).map(n => n.entry.tool))];
        first.label = `${tools.join(', ')} x${runLen}`;
        collapsed.push(first);
      } else {
        for (let k = i; k < j; k++) collapsed.push(nodes[k]);
      }
      i = j;
    }
    phases[phaseName] = collapsed;
  }
}

/**
 * Simple tool category for collapsing.
 */
function getToolCategory(tool) {
  if (QUALITY_GATE_TOOLS.has(tool)) return 'quality';
  if (tool === 'finish') return 'finish';
  if (tool === 'clone_image') return 'clone';
  if (tool === 'run_pixelmath') return 'pixelmath';
  if (['run_lhe', 'run_hdrmt', 'multi_scale_enhance', 'run_nxt'].includes(tool)) return 'enhance';
  if (['run_curves', 'run_scnr'].includes(tool)) return 'color';
  return 'other';
}

// ============================================================================
// Markdown Summary
// ============================================================================

/**
 * Generate a Markdown summary from a trace analysis object.
 * @param {object} analysis - Trace analysis from trace-analyzer.mjs
 * @returns {string} Markdown text
 */
export function generateTraceSummary(analysis) {
  if (!analysis) return '# Execution Trace\n\nNo analysis data available.';

  const entries = analysis.entries || [];
  const branches = analysis.branches || {};
  const qualityGates = analysis.qualityGates || [];
  const retries = analysis.retries || [];
  const toolStats = analysis.toolStats || {};

  // Try to extract target name and run_id from entries or context
  const target = extractTarget(analysis);
  const runId = extractRunId(analysis);

  const heading = runId
    ? `# Execution Trace -- ${target || 'Unknown'}${runId ? ` (${runId})` : ''}`
    : `# Execution Trace${target ? ` -- ${target}` : ''}`;

  const lines = [heading, ''];

  // ---- Overview table ----
  const totalBranches = Object.keys(branches).length;
  const deadEnds = Object.values(branches).filter(b => b.outcome === 'dead-end').length;
  const gateFailures = qualityGates.filter(g => !g.pass).length;

  lines.push('## Overview');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Duration | ${formatDuration(analysis.wallClockMs || analysis.totalDurationMs)} |`);
  lines.push(`| Tool calls | ${analysis.totalCalls || entries.length} |`);
  lines.push(`| Branches | ${totalBranches} (${deadEnds} dead-end${deadEnds !== 1 ? 's' : ''}) |`);
  lines.push(`| Quality checks | ${qualityGates.length} (${gateFailures} failure${gateFailures !== 1 ? 's' : ''}) |`);
  lines.push(`| Finish attempts | ${analysis.finishAttempts || 0} (${analysis.finishRejections || 0} rejection${(analysis.finishRejections || 0) !== 1 ? 's' : ''}) |`);
  lines.push('');

  // ---- Branches table ----
  if (totalBranches > 0) {
    lines.push('## Branches');
    lines.push('| Branch | Parent | Operations | Outcome | Key Tools |');
    lines.push('|--------|--------|------------|---------|-----------|');
    for (const [cloneId, branch] of Object.entries(branches)) {
      const parent = branch.parentView || '?';
      const ops = branch.entries ? branch.entries.length : 0;
      const outcomeStr = branch.outcome === 'winner' ? 'Winner' : branch.outcome === 'merged' ? 'Merged' : 'Dead-end';

      // Find key tools used in this branch
      const branchEntries = (branch.entries || [])
        .map(seq => entries.find(e => e.seq === seq))
        .filter(Boolean);
      const toolNames = [...new Set(
        branchEntries
          .map(e => e.tool)
          .filter(t => !SKIP_TOOLS.has(t) && !ANNOTATION_TOOLS.has(t))
      )];
      const keyTools = toolNames.slice(0, 5).join(', ');

      lines.push(`| ${cloneId} | ${parent} | ${ops} | ${outcomeStr} | ${keyTools} |`);
    }
    lines.push('');
  }

  // ---- Quality Gate History ----
  if (qualityGates.length > 0) {
    lines.push('## Quality Gate History');
    lines.push('| # | Gate | View | Result | Detail |');
    lines.push('|---|------|------|--------|--------|');
    qualityGates.forEach((gate, idx) => {
      const result = gate.pass ? 'PASS' : 'FAIL';
      const detail = gate.details || gate.metric || '';
      lines.push(`| ${idx + 1} | ${gate.tool} | ${gate.viewId || '?'} | ${result} | ${mermaidEscape(detail)} |`);
    });
    lines.push('');
  }

  // ---- Retry Sequences ----
  const significantRetries = retries.filter(r => r.attempts && r.attempts.length >= 2);
  if (significantRetries.length > 0) {
    lines.push('## Retry Sequences');
    lines.push('| Tool | View | Attempts | Parameter Range |');
    lines.push('|------|------|----------|----------------|');
    for (const retry of significantRetries) {
      const view = retry.viewId || '?';
      const count = retry.attempts.length;

      // Build parameter range descriptions
      const paramRanges = [];
      const paramKeys = new Set();
      for (const att of retry.attempts) {
        if (att.args) Object.keys(att.args).forEach(k => paramKeys.add(k));
      }
      for (const key of paramKeys) {
        if (key === 'view_id' || key === 'source_view_id') continue;
        const vals = retry.attempts
          .map(a => safeGet(a, `args.${key}`, null))
          .filter(v => v != null);
        if (vals.length > 1 && new Set(vals.map(String)).size > 1) {
          paramRanges.push(`${key}: ${vals.join(' -> ')}`);
        }
      }
      const rangeStr = paramRanges.length > 0 ? paramRanges.join('; ') : '(same params)';
      lines.push(`| ${retry.tool} | ${view} | ${count} | ${rangeStr} |`);
    }
    lines.push('');
  }

  // ---- Tool Usage ----
  const sortedTools = Object.entries(toolStats)
    .sort((a, b) => (b[1].totalMs || 0) - (a[1].totalMs || 0));
  if (sortedTools.length > 0) {
    lines.push('## Tool Usage');
    lines.push('| Tool | Count | Total Time |');
    lines.push('|------|-------|-----------|');
    for (const [name, stats] of sortedTools) {
      lines.push(`| ${name} | ${stats.count || 0} | ${formatDuration(stats.totalMs)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Try to extract the target name from analysis context.
 */
function extractTarget(analysis) {
  if (!analysis) return null;

  // Check entries for view IDs that might contain the target name
  const entries = analysis.entries || [];
  for (const e of entries) {
    const vid = e.viewId || safeGet(e.args, 'view_id', null) || safeGet(e.args, 'source_view_id', null);
    if (vid && !vid.startsWith('__') && !vid.startsWith('mask_') && vid.length > 2) {
      // Strip common prefixes/suffixes like FILTER_, _stretched, _combined
      const cleaned = vid
        .replace(/^FILTER_/, '')
        .replace(/_(stretched|combined|clone|stars|starless|comp).*$/i, '');
      if (cleaned.length > 1) return cleaned;
    }
  }

  // Check winnerViewId
  if (analysis.winnerViewId) {
    const cleaned = analysis.winnerViewId
      .replace(/^COMP_/, '')
      .replace(/_(balanced|edge|bold|soft).*$/i, '');
    if (cleaned.length > 1) return cleaned;
  }

  return null;
}

/**
 * Try to extract the run ID from analysis context.
 */
function extractRunId(analysis) {
  if (!analysis) return null;
  // If analysis has a path or metadata with run_XXXX pattern
  if (analysis.runId) return analysis.runId;
  if (analysis.tracePath) {
    const m = analysis.tracePath.match(/(run_[0-9-]+_[a-f0-9]+)/);
    if (m) return m[1];
  }
  return null;
}
