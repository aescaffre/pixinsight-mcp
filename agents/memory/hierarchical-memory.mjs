// ============================================================================
// Hierarchical Memory System
//
// Five levels of knowledge, from general to specific:
//   1. universal   — applies to ALL processing
//   2. trait        — applies to targets sharing a processing trait
//   3. type         — applies to a target classification (galaxy_spiral, etc.)
//   4. data_class   — applies to similar data (same gear, similar SNR, scale)
//   5. target       — applies to ONE specific target dataset
//
// Memory entries have:
//   - level, scope, param, value, confidence, sources
//   - Confidence increases when the same value wins across multiple targets
//   - Optimizer promotes entries up the hierarchy when patterns emerge
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';

const MEMORY_DIR = path.join(os.homedir(), '.pixinsight-mcp', 'agent-memory');
const HIER_FILE = path.join(MEMORY_DIR, 'hierarchical.json');


// WI-20: entries carrying these tags are user/gate feedback and must never be evicted by dedupe/cap.
export const PROTECTED_TAGS = ['feedback', 'user_feedback', 'bug', 'gotcha', 'quality_gate'];
export const UNIVERSAL_AUTO_CAP = 30;       // auto/technique universal entries kept (by recency)
export const UNIVERSAL_SUMMARY_RECENT = 20; // recent non-feedback universal entries shown in the summary

export function isProtectedEntry(e) {
  const tags = Array.isArray(e && e.tags) ? e.tags.map(t => String(t).toLowerCase()) : [];
  return tags.some(t => PROTECTED_TAGS.includes(t));
}

// Stale workarounds from the pre-WI-05 state machine. Annotated, not deleted.
const SUPERSEDED_PATTERNS = [
  /Pedestal \+ PixelMath screen blend bypass works for finalize state/i,
  /State machine:\s*lrgb_combine requires compose state\s*[\u2014-]+\s*trigger via early star_protected_blend/i,
  /Ringing gate made non-blocking \(code fix pending restart\)/i,
];
export const SUPERSEDED_NOTE = '[SUPERSEDED after WI-05: compose is entered with begin_composition; lrgb_combine/inject tools are allowed in compose; do not use star-blend or pedestal bypasses]';

export function isSupersededEntry(e) {
  const text = `${e && e.title || ''} ${e && e.content || ''}`;
  return SUPERSEDED_PATTERNS.some(re => re.test(text));
}

function entryTime(e) {
  const t = Date.parse(e && e.timestamp);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Universal-level curation: dedupe, keep every protected (feedback/bug/gotcha/quality_gate) entry,
 * cap the remaining entries at `autoCap` by recency. Returns a new array (original order preserved).
 */
export function curateUniversal(entries, autoCap = UNIVERSAL_AUTO_CAP) {
  const deduped = deduplicateEntries(entries || []);
  const rest = deduped.filter(e => !isProtectedEntry(e));
  if (rest.length <= autoCap) return deduped;
  const keep = new Set(rest.slice().sort((a, b) => entryTime(b) - entryTime(a)).slice(0, autoCap));
  return deduped.filter(e => isProtectedEntry(e) || keep.has(e));
}

function firstLine(e) { return (e.content || '').split('\n')[0]; }
function annotate(e) { return isSupersededEntry(e) ? ` ${SUPERSEDED_NOTE}` : ''; }

/**
 * Load the hierarchical memory store.
 * @returns {object} { universal: [], trait: {}, type: {}, data_class: {}, target: {}, meta: {} }
 */
export function loadMemory() {
  if (fs.existsSync(HIER_FILE)) {
    return JSON.parse(fs.readFileSync(HIER_FILE, 'utf-8'));
  }
  return {
    universal: [],
    trait: {},       // keyed by trait name (e.g. "core_halo")
    type: {},        // keyed by classification (e.g. "galaxy_spiral")
    data_class: {},  // keyed by data class fingerprint
    target: {},      // keyed by target name
    meta: { version: 1, lastOptimized: null, totalEntries: 0 }
  };
}

/**
 * Save the memory store.
 */
export function saveMemory(mem) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  mem.meta.totalEntries = countEntries(mem);
  fs.writeFileSync(HIER_FILE, JSON.stringify(mem, null, 2));
}

function countEntries(mem) {
  let count = mem.universal.length;
  for (const entries of Object.values(mem.trait)) count += entries.length;
  for (const entries of Object.values(mem.type)) count += entries.length;
  for (const entries of Object.values(mem.data_class)) count += entries.length;
  for (const entries of Object.values(mem.target)) count += entries.length;
  return count;
}

/**
 * Compute a data class key from a brief.
 * Groups targets with similar data characteristics.
 * Format: "{workflow}_{scale}_{snrBucket}"
 */
export function dataClassKey(brief) {
  const workflow = brief.dataDescription?.workflow || 'RGB';
  const scale = brief.target?.fieldCharacteristics?.subjectScale || 'medium';
  // SNR bucket: we don't have exact SNR, so use workflow + scale as proxy
  return `${workflow}_${scale}`;
}

/**
 * Recall memories relevant to a given brief.
 * Returns all matching entries from all levels, ordered general → specific.
 *
 * @param {object} brief - Processing brief
 * @returns {object} { universal, trait, type, data_class, target, summary }
 */
export function recallForBrief(brief) {
  const mem = loadMemory();
  const classification = brief.target?.classification || 'mixed_field';
  const targetName = brief.target?.name || '';
  const fc = brief.target?.fieldCharacteristics || {};
  const dcKey = dataClassKey(brief);

  // WI-11: narrowband runs must not inherit broadband-era universal/trait rules (entries stamped with a broadband workflow).
  const isNB = !!brief.dataDescription?.narrowband;
  const isBroadbandStamp = (e) => !!e && typeof e.workflow === 'string' && e.workflow !== 'SHO' && e.workflow !== 'HOO';
  const keepForBrief = (e) => !(isNB && isBroadbandStamp(e));

  const result = {
    universal: (mem.universal || []).filter(keepForBrief),
    trait: [],
    type: mem.type[classification] || [],
    data_class: mem.data_class[dcKey] || [],
    target: mem.target[targetName] || [],
  };

  // Gather trait-level memories for ALL matching traits
  const traitKeys = [];
  if (fc.structuralZones) traitKeys.push(fc.structuralZones);
  if (fc.signalType) traitKeys.push(fc.signalType);
  if (fc.colorZonation) traitKeys.push(fc.colorZonation);
  if (fc.starRelationship) traitKeys.push(fc.starRelationship);
  if (fc.faintStructureGoal) traitKeys.push(fc.faintStructureGoal);
  // Also include legacy boolean traits
  if (fc.hasIFN) traitKeys.push('ifn');
  if (fc.hasHIIRegions) traitKeys.push('hii_regions');
  if (fc.brightCore) traitKeys.push('bright_core');

  for (const tk of traitKeys) {
    if (mem.trait[tk]) {
      result.trait.push(...mem.trait[tk].filter(keepForBrief));
    }
  }

  // Build human-readable summary for the agent
  const lines = [];
  if (isNB && brief.dataDescription?.starless) {
    lines.push('NOTE: STARLESS NARROWBAND run — entries about star blends, SPCC, Ha injection and compose-state tricks are broadband-era; do not call star blend tools to unlock compose (use begin_composition).');
  }
  // WI-20: universal = dedupe + feedback exemption; summary shows feedback-tagged + the 20 most recent others.
  result.universal = curateUniversal(result.universal);
  if (result.universal.length) {
    const fb = result.universal.filter(isProtectedEntry);
    const recent = result.universal.filter(e => !isProtectedEntry(e))
      .sort((a, b) => entryTime(b) - entryTime(a)).slice(0, UNIVERSAL_SUMMARY_RECENT);
    const shown = new Set([...fb, ...recent]);
    lines.push(`## Universal Rules (${shown.size} of ${result.universal.length})`);
    for (const e of result.universal) {
      if (shown.has(e)) lines.push(`- [STRONG] ${e.title || 'untitled'}: ${firstLine(e)}${annotate(e)}`);
    }
  }
  if (result.trait.length) {
    lines.push(`\n## Trait-Level (${result.trait.length}) [${traitKeys.join(', ')}]`);
    for (const e of result.trait) lines.push(`- [TYPE prior ${e.traitKey || '?'}, conf=${e.confidence || 1}] ${e.title || 'untitled'}: ${firstLine(e)}${annotate(e)}`);
  }
  if (result.type.length) {
    lines.push(`\n## Type-Level: ${classification} (${result.type.length})`);
    for (const e of result.type) lines.push(`- [TYPE prior ${classification}, conf=${e.confidence || 1}] ${e.title || 'untitled'}: ${firstLine(e)}${annotate(e)}`);
  }
  if (result.data_class.length) {
    lines.push(`\n## Data-Class: ${dcKey} (${result.data_class.length})`);
    for (const e of result.data_class) lines.push(`- [DATA-CLASS prior ${dcKey}, conf=${e.confidence || 1}] ${e.title || 'untitled'}: ${firstLine(e)}${annotate(e)}`);
  }
  if (result.target.length) {
    lines.push(`\n## Target: ${targetName} (${result.target.length})`);
    for (const e of result.target) lines.push(`- [WEAK target-only ${targetName}, conf=${e.confidence || 1}] ${e.title || 'untitled'}: ${firstLine(e)}${annotate(e)}`);
  }
  if (lines.some(l => l.startsWith('- ['))) {
    lines.push('\nDoctrine: target-level recipes are anecdotes; prefer type/trait rules; override when measurements disagree.');
  }

  result.summary = lines.join('\n');
  return result;
}

/**
 * Save a memory entry at the specified level.
 *
 * @param {string} level - "universal", "trait", "type", "data_class", "target"
 * @param {string} key - scope key (trait name, classification, dataclass key, target name). Ignored for universal.
 * @param {object} entry - { title, content, param?, value?, tags? }
 * @param {object} brief - Processing brief (for auto-deriving keys)
 */
export function saveEntry(level, key, entry, brief) {
  const mem = loadMemory();
  const fullEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
    level,
    scopeKey: key,
    source: brief?.target?.name || 'unknown',
    confidence: entry.confidence || 1,
    // WI-11: stamp the run type so narrowband recalls can exclude broadband-era rules
    workflow: brief?.dataDescription?.workflow,
    starless: !!brief?.dataDescription?.starless,
  };

  // Add trait key for trait-level entries
  if (level === 'trait') fullEntry.traitKey = key;

  switch (level) {
    case 'universal':
      // Deduplicate by param name
      if (entry.param) {
        const idx = mem.universal.findIndex(e => e.param === entry.param);
        if (idx >= 0) { mem.universal[idx] = fullEntry; }
        else { mem.universal.push(fullEntry); }
      } else {
        mem.universal.push(fullEntry);
      }
      break;
    case 'trait':
      if (!mem.trait[key]) mem.trait[key] = [];
      mem.trait[key].push(fullEntry);
      break;
    case 'type':
      if (!mem.type[key]) mem.type[key] = [];
      mem.type[key].push(fullEntry);
      break;
    case 'data_class':
      if (!mem.data_class[key]) mem.data_class[key] = [];
      mem.data_class[key].push(fullEntry);
      break;
    case 'target':
      if (!mem.target[key]) mem.target[key] = [];
      mem.target[key].push(fullEntry);
      break;
  }

  saveMemory(mem);
  return fullEntry;
}

/**
 * Memory Optimizer — promotes entries up the hierarchy when patterns emerge.
 *
 * Rules:
 * 1. If the same param+value appears in 3+ target entries across different targets
 *    of the same type → promote to type level
 * 2. If the same param+value appears in 2+ type entries across different types
 *    sharing a trait → promote to trait level
 * 3. If a type-level entry is confirmed across all data classes → promote to universal
 *
 * Also deduplicates and removes outdated entries.
 */
export function optimizeMemory() {
  const mem = loadMemory();
  const promotions = [];

  // --- Phase 1: Target → Type promotion ---
  // WI-20: group by type+param only; promote the MEDIAN when 3+ distinct targets fall within ±15% of it
  // (exact float equality essentially never fires). Non-numeric values still need an exact match.
  const targetParams = {}; // { type -> { param -> [entry+targetName] } }
  for (const [targetName, entries] of Object.entries(mem.target)) {
    for (const e of entries) {
      if (!e.param || e.value === undefined) continue;
      const type = e.tags?.find(t => t.startsWith('type:'))?.replace('type:', '') || e.classification || 'unknown';
      if (!targetParams[type]) targetParams[type] = {};
      if (!targetParams[type][e.param]) targetParams[type][e.param] = [];
      targetParams[type][e.param].push({ ...e, targetName });
    }
  }

  for (const [type, params] of Object.entries(targetParams)) {
    for (const [param, entries] of Object.entries(params)) {
      const agreeing = agreeingEntries(entries);
      if (!agreeing) continue;
      const { group, value } = agreeing;
      const uniqueTargets = new Set(group.map(e => e.targetName));
      if (uniqueTargets.size < 3) continue;
      const typeEntries = mem.type[type] || [];
      const existing = typeEntries.find(e => e.param === param);
      if (!existing) {
        const promoted = {
          title: `[AUTO-PROMOTED] ${param} = ${value} (confirmed across ${uniqueTargets.size} targets)`,
          content: `Parameter ${param} with value ${value} (median of values within 15%) was confirmed across targets: ${[...uniqueTargets].join(', ')}. Auto-promoted from target to type level.`,
          param,
          value,
          confidence: uniqueTargets.size,
          sources: [...uniqueTargets],
          timestamp: new Date().toISOString(),
          level: 'type',
          scopeKey: type,
          autoPromoted: true,
        };
        if (!mem.type[type]) mem.type[type] = [];
        mem.type[type].push(promoted);
        promotions.push(`target→type: ${param}=${value} for ${type} (${uniqueTargets.size} targets)`);
      } else {
        existing.confidence = Math.max(existing.confidence || 1, uniqueTargets.size);
        existing.sources = [...new Set([...(existing.sources || []), ...uniqueTargets])];
      }
    }
  }

  // --- Phase 2: Type → Trait promotion ---
  // If same param+value appears across 2+ types that share a trait, promote to trait
  const typeParams = {}; // { "param:value" → [{type, traitKeys}, ...] }
  const taxonomy = loadTaxonomySafe();

  for (const [type, entries] of Object.entries(mem.type)) {
    const taxEntry = taxonomy[type];
    const traits = taxEntry?.traits || {};
    const traitKeys = Object.entries(traits)
      .filter(([k, v]) => v === true || (typeof v === 'string' && v !== 'none'))
      .map(([k, v]) => typeof v === 'string' ? v : k);

    for (const e of entries) {
      if (!e.param || e.value === undefined) continue;
      const key = `${e.param}:${JSON.stringify(e.value)}`;
      if (!typeParams[key]) typeParams[key] = [];
      typeParams[key].push({ type, traitKeys });
    }
  }

  for (const [key, typeInfos] of Object.entries(typeParams)) {
    if (typeInfos.length < 2) continue;
    // Find shared traits
    const allTraits = typeInfos.flatMap(t => t.traitKeys);
    const traitCounts = {};
    for (const t of allTraits) traitCounts[t] = (traitCounts[t] || 0) + 1;
    const sharedTraits = Object.entries(traitCounts).filter(([, c]) => c >= 2).map(([t]) => t);

    if (sharedTraits.length > 0) {
      const [param, valueStr] = key.split(':');
      const value = JSON.parse(valueStr);
      for (const trait of sharedTraits) {
        const traitEntries = mem.trait[trait] || [];
        if (!traitEntries.find(e => e.param === param)) {
          const promoted = {
            title: `[AUTO-PROMOTED] ${param} = ${value} (shared across types via trait: ${trait})`,
            content: `Parameter ${param} with value ${value} confirmed across types: ${typeInfos.map(t => t.type).join(', ')}. Shared trait: ${trait}.`,
            param,
            value,
            confidence: typeInfos.length,
            traitKey: trait,
            timestamp: new Date().toISOString(),
            level: 'trait',
            scopeKey: trait,
            autoPromoted: true,
          };
          if (!mem.trait[trait]) mem.trait[trait] = [];
          mem.trait[trait].push(promoted);
          promotions.push(`type→trait: ${param}=${value} via trait ${trait}`);
        }
      }
    }
  }

  // --- Phase 3: Deduplication ---
  // Remove exact duplicate entries (same level, key, param, value)
  for (const level of ['universal', 'trait', 'type', 'data_class', 'target']) {
    const container = mem[level];
    if (Array.isArray(container)) {
      mem[level] = level === 'universal' ? curateUniversal(container) : deduplicateEntries(container);
    } else {
      for (const [key, entries] of Object.entries(container)) {
        container[key] = deduplicateEntries(entries);
      }
    }
  }

  // --- Phase 4: Cap entries per bucket ---
  const MAX_PER_BUCKET = 20;
  for (const level of ['trait', 'type', 'data_class', 'target']) {
    for (const [key, entries] of Object.entries(mem[level])) {
      if (entries.length > MAX_PER_BUCKET) {
        // Keep highest confidence + most recent
        entries.sort((a, b) => (b.confidence || 1) - (a.confidence || 1) || new Date(b.timestamp) - new Date(a.timestamp));
        mem[level][key] = entries.slice(0, MAX_PER_BUCKET);
      }
    }
  }

  mem.meta.lastOptimized = new Date().toISOString();
  saveMemory(mem);

  return { promotions, totalEntries: countEntries(mem) };
}

export function deduplicateEntries(entries) {
  const seen = new Set();
  return entries.filter(e => {
    if (isProtectedEntry(e)) return true; // WI-20: feedback-tagged entries are never evicted
    const key = `${e.param || ''}:${JSON.stringify(e.value || '')}:${e.title || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * WI-20: find the largest group of entries whose numeric values lie within ±15% of the group median
 * (non-numeric: largest exact-match group). Returns { group, value } or null.
 */
export function agreeingEntries(entries) {
  const numeric = entries.filter(e => typeof e.value === 'number' && Number.isFinite(e.value));
  let best = null;
  if (numeric.length) {
    for (const anchor of numeric) {
      const group = numeric.filter(e => Math.abs(e.value - anchor.value) <= 0.15 * Math.abs(anchor.value) + 1e-12);
      const vals = group.map(e => e.value).sort((x, y) => x - y);
      const mid = vals.length >> 1;
      const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
      const tight = group.filter(e => Math.abs(e.value - median) <= 0.15 * Math.abs(median) + 1e-12);
      const tv = tight.map(e => e.value).sort((x, y) => x - y);
      const tm = tv.length >> 1;
      const tmed = tv.length % 2 ? tv[tm] : (tv[tm - 1] + tv[tm]) / 2;
      const nT = new Set(tight.map(e => e.targetName)).size;
      if (!best || nT > best.n) best = { group: tight, value: tmed, n: nT };
    }
  }
  const byVal = {};
  for (const e of entries) {
    if (typeof e.value === 'number') continue;
    (byVal[JSON.stringify(e.value)] ||= []).push(e);
  }
  for (const [k, group] of Object.entries(byVal)) {
    const nT = new Set(group.map(e => e.targetName)).size;
    if (!best || nT > best.n) best = { group, value: JSON.parse(k), n: nT };
  }
  return best ? { group: best.group, value: best.value } : null;
}

function loadTaxonomySafe() {
  try {
    const taxPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'target-taxonomy.json');
    if (fs.existsSync(taxPath)) return JSON.parse(fs.readFileSync(taxPath, 'utf-8')).categories || {};
  } catch {}
  return {};
}

/**
 * Migrate old flat memory (giga_orchestrator.json, etc.) into hierarchical system.
 */
export function migrateOldMemory() {
  const mem = loadMemory();
  const oldFiles = ['giga_orchestrator.json', 'luminance_detail.json', 'composition.json',
    'rgb_cleanliness.json', 'star_policy.json', 'ha_integration.json'];
  let migrated = 0;

  for (const file of oldFiles) {
    const filePath = path.join(MEMORY_DIR, file);
    if (!fs.existsSync(filePath)) continue;

    const entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    for (const e of entries) {
      // Determine level from tags
      const tags = e.tags || [];
      const isUserFeedback = tags.includes('user_feedback');
      const isWinningParam = tags.includes('winning_param');
      const classification = tags.find(t =>
        t.startsWith('galaxy') || t.startsWith('emission') || t.startsWith('planetary') ||
        t.startsWith('star_cluster') || t === 'mixed_field');
      const targetName = e.source || e.title?.match(/M\d+|NGC\d+|Abell\d+/)?.[0];

      if (isUserFeedback) {
        // User feedback → type level (applies to all targets of this class)
        const type = classification || 'mixed_field';
        if (!mem.type[type]) mem.type[type] = [];
        mem.type[type].push({
          ...e, level: 'type', scopeKey: type,
          migrated: true, originalFile: file
        });
      } else if (isWinningParam && targetName) {
        // Winning params → target level
        if (!mem.target[targetName]) mem.target[targetName] = [];
        mem.target[targetName].push({
          ...e, level: 'target', scopeKey: targetName,
          migrated: true, originalFile: file
        });
      } else if (tags.includes('overcorrection_warning') || e.title?.includes('WARNING')) {
        // Warnings → universal
        mem.universal.push({
          ...e, level: 'universal', scopeKey: 'universal',
          migrated: true, originalFile: file
        });
      } else if (classification) {
        // General observations → type level
        const type = classification;
        if (!mem.type[type]) mem.type[type] = [];
        mem.type[type].push({
          ...e, level: 'type', scopeKey: type,
          migrated: true, originalFile: file
        });
      } else {
        // Everything else → universal
        mem.universal.push({
          ...e, level: 'universal', scopeKey: 'universal',
          migrated: true, originalFile: file
        });
      }
      migrated++;
    }
  }

  saveMemory(mem);
  return { migrated, totalEntries: countEntries(mem) };
}
