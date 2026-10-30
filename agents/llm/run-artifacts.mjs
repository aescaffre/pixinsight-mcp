// ============================================================================
// WI-25: end-of-run artifacts (run-summary.json + trace analysis/diagram/summary)
// and manifest finalize/fail. Extracted from giga-run.mjs so it can be called
// explicitly before EVERY exit path (a finally block does not run after
// process.exit) and unit-tested against a temp store.
// ============================================================================
import fs from 'fs';
import path from 'path';
import { getCritiqueUsage } from './aesthetic-critic.mjs';

export const RUN_STATUSES = ['finished', 'recovered', 'no_final_selection', 'crashed', 'timed_out', 'max_turns'];

/** Merge-write <baseDir>/run-summary.json. Never throws. */
export function mergeRunSummary(store, patch) {
  try {
    const p = path.join(store.baseDir, 'run-summary.json');
    let cur = {};
    if (fs.existsSync(p)) { try { cur = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {} }
    fs.writeFileSync(p, JSON.stringify({ ...cur, ...patch, updatedAt: new Date().toISOString() }, null, 2));
  } catch (e) { console.error(`  run-summary write failed: ${e.message}`); }
}

/** Normalise an agent run() result into an agentRuns[] record. */
export function makeAgentRunRecord(name, requestedModel, res) {
  return {
    name,
    model: requestedModel ?? null,
    actualModels: res?.actualModels || [],
    turns: res?.num_turns ?? res?.turnCount ?? 0,
    elapsedMs: res?.elapsedMs ?? res?.duration_ms ?? 0,
    usage: res?.usage ?? null,
    timedOut: !!res?.timedOut,
    maxTurnsHit: !!res?.maxTurnsHit,
  };
}

function sumUsage(rows) {
  const t = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += Number(r?.usage?.[k]) || 0;
  return t;
}

/** Per-agent token/time table (replaces the giga-only token line). */
export function formatAgentTable(agentRuns, critic) {
  const f = (n) => (n || 0).toLocaleString();
  const lines = ['  Agent                 Model     Turns  Time     Input(fresh+cache-r+cache-w)            Output'];
  const rows = [...(agentRuns || [])];
  for (const r of rows) {
    const u = r.usage || {};
    const fresh = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
    const flags = (r.timedOut ? ' TIMEOUT' : '') + (r.maxTurnsHit ? ' MAXTURNS' : '');
    lines.push(`  ${String(r.name).padEnd(21)} ${String(r.model || 'inherit').padEnd(9)} ${String(r.turns).padStart(5)}  ${(Math.round((r.elapsedMs || 0) / 1000) + 's').padEnd(8)} ${f(fresh + cr + cw)} (${f(fresh)}+${f(cr)}+${f(cw)})  ${f(u.output_tokens)}${flags}`);
  }
  if (critic && critic.calls) {
    const u = critic.usage || {};
    const fresh = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
    lines.push(`  ${'aesthetic_critic'.padEnd(21)} ${'judge'.padEnd(9)} ${String(critic.calls).padStart(5)}  ${'-'.padEnd(8)} ${f(fresh + cr + cw)} (${f(fresh)}+${f(cr)}+${f(cw)})  ${f(u.output_tokens)}`);
  }
  const all = sumUsage([...rows, ...(critic && critic.calls ? [{ usage: critic.usage }] : [])]);
  const totIn = all.input_tokens + all.cache_read_input_tokens + all.cache_creation_input_tokens;
  lines.push(`  TOTAL: ${f(totIn + all.output_tokens)} tokens (input ${f(totIn)}, output ${f(all.output_tokens)})`);
  return lines.join('\n');
}

/**
 * Write run-summary.json + trace artifacts and finalize/fail the manifest.
 * Safe to call more than once and from any exit path; never throws.
 *
 * @param {object} store  ArtifactStore (needs baseDir, finalize, fail)
 * @param {string} status one of RUN_STATUSES
 * @param {object} info   { agentRuns, exportSource, elapsedMs, exitCode, signal, turns, finalSelection,
 *                          criticalBlock, failReason, log }
 * @returns {Promise<{summary:object, traceStats:string}>}
 */
export async function writeRunArtifacts(store, status, info = {}) {
  const log = info.log || ((m) => console.log(m));
  const agentRuns = info.agentRuns || [];
  let critic = { calls: 0, usage: {} };
  try {
    const u = getCritiqueUsage(store.baseDir);
    const { calls, ...usage } = u;
    critic = { calls, usage };
  } catch {}

  let traceStats = '';
  let gateFailCount = null;
  try {
    const tracePath = path.join(store.baseDir, 'trace.jsonl');
    if (fs.existsSync(tracePath)) {
      const { analyzeTrace } = await import('./trace-analyzer.mjs');
      const { generateMermaidDiagram, generateTraceSummary } = await import('./trace-mermaid.mjs');
      const analysis = analyzeTrace(tracePath);
      const mermaid = generateMermaidDiagram(analysis);
      const summary = generateTraceSummary(analysis);
      fs.writeFileSync(path.join(store.baseDir, 'trace-analysis.json'), JSON.stringify(analysis, null, 2));
      fs.writeFileSync(path.join(store.baseDir, 'trace-diagram.mmd'), mermaid);
      fs.writeFileSync(path.join(store.baseDir, 'trace-summary.md'), summary + (info.criticalBlock ? '\n\n' + info.criticalBlock : '') + '\n');
      const deadEnds = Object.values(analysis.branches).filter(b => b.outcome === 'dead-end').length;
      gateFailCount = analysis.qualityGates.filter(g => !g.pass).length;
      traceStats = `  Trace: ${analysis.totalCalls} tool calls, ${Object.keys(analysis.branches).length} branches (${deadEnds} dead-ends), ${analysis.qualityGates.length} quality checks (${gateFailCount} failures)`;
      log(`\n--- Execution Trace ---`);
      log(traceStats);
      log(`  Diagram: ${path.join(store.baseDir, 'trace-diagram.mmd')}`);
      log(`  Summary: ${path.join(store.baseDir, 'trace-summary.md')}`);
    }
  } catch (e) {
    log(`  Trace generation skipped: ${e.message}`);
  }

  const summary = {
    status,
    exportSource: info.exportSource || null,
    agentRuns,
    critic,
    gateFailCount,
    elapsedMs: info.elapsedMs ?? null,
    exitCode: info.exitCode ?? null,
    signal: info.signal ?? null,
    turns: info.turns ?? null,
    finalVariant: info.finalSelection?.variant_id || null,
  };
  mergeRunSummary(store, summary);

  // Manifest: finished/recovered -> finalize; crashed -> fail; other terminal statuses recorded as-is.
  try {
    if (status === 'finished' || status === 'recovered') {
      store.finalize(info.finalSelection?.variant_id || null);
    } else if (status === 'crashed') {
      store.fail(info.failReason || 'run crashed');
    } else if (store.manifest) {
      store.manifest.status = status;
      store.manifest.endedAt = new Date().toISOString();
      store._saveManifest();
    }
  } catch (e) { log(`  manifest update skipped: ${e.message}`); }

  return { summary, traceStats };
}
