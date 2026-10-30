// ============================================================================
// WI-07b: helpers for giga-run --resume-agent <runId>
// ============================================================================
import fs from 'fs';
import path from 'path';
import { agentStatePath } from './agent-state.mjs';

export function buildResumePrompt(state) {
  return `PixInsight was restarted; all views are gone. Call list_open_images, then load_variant on your best saved variant (list_variants) and continue from state ${state || 'compose'}. If you see FATAL again, stop.`;
}

/** Latest system prompt file written by engine-max for an agent (prompts/system-<agent>-<ts>.md), or null. */
export function latestSystemPromptFile(baseDir, agentName) {
  try {
    const dir = path.join(baseDir, 'prompts');
    const files = fs.readdirSync(dir).filter(f => f.startsWith(`system-${agentName}-`) && f.endsWith('.md')).sort();
    return files.length ? path.join(dir, files[files.length - 1]) : null;
  } catch { return null; }
}

/**
 * Gather everything needed to resume the giga agent. Throws with a clear message when the previous
 * session cannot be resumed (no agents/giga_orchestrator.json).
 */
export function loadResumeInfo(store, brief, config, buildPrompt) {
  const agentName = 'giga_orchestrator';
  const rec = path.join(store.baseDir, 'agents', `${agentName}.json`);
  if (!fs.existsSync(rec)) throw new Error(`Cannot resume: ${rec} not found (no recorded session id)`);
  const info = JSON.parse(fs.readFileSync(rec, 'utf-8'));
  if (!info.sessionId) throw new Error('Cannot resume: no sessionId recorded');
  let state = 'compose';
  try {
    const f = agentStatePath(store.baseDir, agentName);
    if (f && fs.existsSync(f)) state = JSON.parse(fs.readFileSync(f, 'utf-8')).stateMachine?.state || state;
  } catch {}
  const pf = latestSystemPromptFile(store.baseDir, agentName);
  const systemPrompt = pf ? fs.readFileSync(pf, 'utf-8') : buildPrompt(brief, config);
  return { sessionId: info.sessionId, cwd: info.cwd || process.cwd(), state, systemPrompt, promptSource: pf || 'rebuilt-from-brief' };
}
