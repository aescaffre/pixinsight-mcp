// ============================================================================
// WI-07b: crash sentinel + per-agent MCP state persistence helpers.
// Pure file helpers so they can be unit-tested without PixInsight.
// ============================================================================
import fs from 'fs';
import path from 'path';

export const FATAL_TEXT = 'FATAL: PixInsight crashed — STOP calling tools and end your turn now';

export function crashFilePath(baseDir) { return baseDir ? path.join(baseDir, 'CRASH.json') : null; }
export function agentStatePath(baseDir, agentName) { return baseDir ? path.join(baseDir, `agent-state-${agentName}.json`) : null; }

export function writeCrashFile(baseDir, info) {
  const f = crashFilePath(baseDir);
  if (!f) return null;
  try { fs.writeFileSync(f, JSON.stringify({ ts: Date.now(), ...info }, null, 2)); } catch {}
  return f;
}

/** True when this process saw the crash (ctx.crashed) or any process wrote CRASH.json. */
export function isCrashed(ctx, baseDir) {
  if (ctx && ctx.crashed) return true;
  const f = crashFilePath(baseDir);
  return !!(f && fs.existsSync(f));
}

export function countTraceLines(traceFile) {
  try {
    if (!traceFile || !fs.existsSync(traceFile)) return 0;
    const t = fs.readFileSync(traceFile, 'utf-8');
    return t.split('\n').filter(l => l.trim()).length;
  } catch { return 0; }
}

export function saveAgentState(baseDir, agentName, { stateMachine, provenance, starIntegrity, traceSeq, variantCounters, lUsage, lRoots }) {
  const f = agentStatePath(baseDir, agentName);
  if (!f) return null;
  const snap = {
    stateMachine: typeof stateMachine?.toJSON === 'function' ? stateMachine.toJSON() : null,
    viewProvenance: provenance instanceof Map ? [...provenance.entries()] : (provenance || []),
    starIntegrity: starIntegrity || {},
    traceSeq: traceSeq || 0,
    lUsage: lUsage || [],
    lRoots: lRoots || [],
    variantCounters: variantCounters || {},
    savedAt: Date.now(),
  };
  try { fs.writeFileSync(f, JSON.stringify(snap)); } catch {}
  return snap;
}

/**
 * Restore a saved snapshot into the live objects. turnsUsed is RESET to 0 (new CLI session).
 * On parse failure the state machine is put in permissive 'compose'.
 * @returns {{restored:boolean, traceSeq?:number, reason?:string}}
 */
export function restoreAgentState(baseDir, agentName, { stateMachine, provenance, brief }) {
  const f = agentStatePath(baseDir, agentName);
  if (!f || !fs.existsSync(f)) return { restored: false, reason: 'no snapshot' };
  let snap;
  try { snap = JSON.parse(fs.readFileSync(f, 'utf-8')); }
  catch (e) {
    if (stateMachine && 'state' in stateMachine) stateMachine.state = 'compose';
    return { restored: false, reason: `parse failure: ${e.message}` };
  }
  if (snap.stateMachine && typeof stateMachine.restore === 'function') {
    stateMachine.restore(snap.stateMachine);
    stateMachine.turnsUsed = 0;
    if (stateMachine.stateTurns) for (const k of Object.keys(stateMachine.stateTurns)) stateMachine.stateTurns[k] = 0;
    stateMachine.stateStartTurn = 0;
  }
  if (provenance instanceof Map) {
    provenance.clear();
    for (const [k, v] of (snap.viewProvenance || [])) provenance.set(k, v);
  }
  if (brief) {
    brief._starIntegrity = snap.starIntegrity || {};
    brief._lUsage = Array.isArray(snap.lUsage) ? snap.lUsage : [];   // WI-13 Gate 10 provenance
    brief._lRoots = Array.isArray(snap.lRoots) ? snap.lRoots : [];
  }
  return { restored: true, traceSeq: snap.traceSeq || 0, variantCounters: snap.variantCounters || {} };
}
