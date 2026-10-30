// WI-08: explicit per-agent model / effort / fallback / maxTurns table.
// Resolution order: CLI --model-<alias>/--effort-<alias> > config.models.<agent> > defaults.
export const AGENT_MODELS = {
  giga_orchestrator: { model: 'inherit', effort: 'high', fallbackModel: 'sonnet', maxTurns: 250 },
  gradient_agent: { model: 'inherit', effort: 'medium', fallbackModel: 'sonnet', maxTurns: 50 },
  core_specialist: { model: 'inherit', effort: 'high', fallbackModel: 'sonnet', maxTurns: 50 },
  aesthetic_critic: { model: 'opus', effort: undefined, maxTurns: 3 },
};

export const AGENT_ALIASES = {
  giga: 'giga_orchestrator', giga_orchestrator: 'giga_orchestrator',
  gradient: 'gradient_agent', gradient_agent: 'gradient_agent',
  core: 'core_specialist', core_specialist: 'core_specialist',
  critic: 'aesthetic_critic', aesthetic_critic: 'aesthetic_critic',
};

/** Parse --model-<alias> X / --effort-<alias> X from argv into { agent: {model, effort} }. */
export function parseModelFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(model|effort)-(.+)$/.exec(argv[i]);
    if (!m || argv[i + 1] === undefined) continue;
    const agent = AGENT_ALIASES[m[2]];
    if (!agent) { console.warn(`WARNING: unknown agent alias in ${argv[i]}`); continue; }
    (out[agent] = out[agent] || {})[m[1]] = argv[++i];
  }
  return out;
}

/** Resolve the table. cli = parseModelFlags(argv); config = parsed config JSON. */
export function resolveAgentModels(cli = {}, config = {}) {
  const res = {};
  for (const [name, def] of Object.entries(AGENT_MODELS)) {
    const cfg = (config && config.models && config.models[name]) || {};
    const c = cli[name] || {};
    res[name] = {
      ...def,
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(cfg.effort !== undefined ? { effort: cfg.effort } : {}),
      ...(cfg.fallbackModel !== undefined ? { fallbackModel: cfg.fallbackModel } : {}),
      ...(cfg.maxTurns !== undefined ? { maxTurns: cfg.maxTurns } : {}),
      ...(c.model !== undefined ? { model: c.model } : {}),
      ...(c.effort !== undefined ? { effort: c.effort } : {}),
    };
  }
  return res;
}

/** Warn when a fallback (or other) model served the run instead of the requested family. */
export function fallbackFired(requested, actualModels) {
  if (!requested || requested === 'inherit' || !actualModels || !actualModels.length) return false;
  const fam = String(requested).toLowerCase().replace(/\[.*\]$/, '');
  return !actualModels.some(m => String(m).toLowerCase().includes(fam));
}

export function formatModelTable(table) {
  return Object.entries(table).map(([n, v]) =>
    `  ${n.padEnd(18)} model=${v.model}  effort=${v.effort ?? '(default)'}  fallback=${v.fallbackModel ?? '-'}  maxTurns=${v.maxTurns}`).join('\n');
}
