// ============================================================================
// Classifier / Intent Agent
// Determines target classification and generates processing brief.
// Rule-based for Phase 1 (LLM-based classification in Phase 2).
// ============================================================================
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load processing profiles from JSON.
 */
function loadProcessingProfiles() {
  const profilePath = path.join(__dirname, 'processing-profiles.json');
  if (fs.existsSync(profilePath)) {
    return JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
  }
  return {};
}

/**
 * Load target taxonomy from JSON.
 */
function loadTaxonomy() {
  const taxPath = path.join(__dirname, 'target-taxonomy.json');
  if (fs.existsSync(taxPath)) {
    return JSON.parse(fs.readFileSync(taxPath, 'utf-8')).categories || {};
  }
  return {};
}

/**
 * Common deep sky objects and their classifications.
 * Used for rule-based classification from target name.
 */
const KNOWN_OBJECTS = {
  // Galaxies
  'M31': 'galaxy_spiral', 'M33': 'galaxy_spiral', 'M51': 'galaxy_spiral',
  'M81': 'galaxy_spiral', 'M82': 'galaxy_spiral', 'M101': 'galaxy_spiral',
  'M104': 'galaxy_spiral', 'M106': 'galaxy_spiral', 'M63': 'galaxy_spiral',
  'M64': 'galaxy_spiral', 'M66': 'galaxy_spiral', 'M65': 'galaxy_spiral',
  'NGC891': 'galaxy_edge_on', 'NGC4565': 'galaxy_edge_on', 'NGC5907': 'galaxy_edge_on',
  'NGC3628': 'galaxy_spiral', 'NGC2403': 'galaxy_spiral', 'NGC4631': 'galaxy_edge_on',
  'NGC253': 'galaxy_spiral', 'NGC4244': 'galaxy_edge_on',
  'M87': 'galaxy_elliptical', 'M49': 'galaxy_elliptical',
  // Emission nebulae
  'M42': 'emission_nebula', 'M43': 'emission_nebula',
  'NGC7000': 'emission_nebula', 'NGC6888': 'emission_nebula',
  'NGC2237': 'emission_nebula', 'NGC2244': 'emission_nebula',
  'Rosette': 'emission_nebula', 'Rosetta': 'emission_nebula',
  'IC1396': 'emission_nebula', 'NGC6992': 'emission_nebula',
  'NGC6960': 'emission_nebula', 'NGC7380': 'emission_nebula',
  'NGC281': 'emission_nebula', 'IC1805': 'emission_nebula',
  'IC1848': 'emission_nebula', 'M16': 'emission_nebula',
  'M17': 'emission_nebula', 'M20': 'emission_nebula',
  'NGC2024': 'emission_nebula', 'NGC1499': 'emission_nebula',
  'Crescent': 'emission_nebula', 'Bubble': 'emission_nebula', 'NGC7635': 'emission_nebula',
  'IC5070': 'emission_nebula', 'NGC6820': 'emission_nebula',
  'SH2': 'emission_nebula',
  // Reflection nebulae
  'M45': 'reflection_nebula', 'NGC7023': 'reflection_nebula',
  'IC2118': 'reflection_nebula', 'NGC1333': 'reflection_nebula',
  'vdB': 'reflection_nebula',
  // Planetary nebulae
  'M27': 'planetary_nebula', 'M57': 'planetary_nebula', 'M97': 'planetary_nebula',
  'NGC7293': 'planetary_nebula', 'NGC6543': 'planetary_nebula',
  'NGC2392': 'planetary_nebula', 'NGC3242': 'planetary_nebula', 'NGC6826': 'planetary_nebula',
  // Star clusters
  'M13': 'star_cluster_globular', 'M3': 'star_cluster_globular', 'M5': 'star_cluster_globular',
  'M92': 'star_cluster_globular', 'M2': 'star_cluster_globular',
  'NGC884': 'star_cluster_open', 'NGC869': 'star_cluster_open',
  // Supernova remnants
  'NGC6960': 'supernova_remnant', 'NGC6992': 'supernova_remnant',
  'Simeis147': 'supernova_remnant', 'IC443': 'supernova_remnant',
  // Galaxy clusters
  'Abell2151': 'galaxy_cluster', 'Abell1656': 'galaxy_cluster',
  'HCG92': 'galaxy_cluster', 'Stephan': 'galaxy_cluster',
  // Dark nebulae
  'Barnard33': 'dark_nebula', 'LDN1622': 'dark_nebula', 'Barnard68': 'dark_nebula',
};

/**
 * Classify a target from its name (rule-based).
 */
function classifyFromName(name) {
  const normalized = name.replace(/[\s_-]/g, '').toUpperCase();

  for (const [key, cls] of Object.entries(KNOWN_OBJECTS)) {
    if (normalized.includes(key.replace(/[\s_-]/g, '').toUpperCase())) {
      return cls;
    }
  }

  // Heuristic: if name contains common galaxy terms
  if (/galaxy|galax/i.test(name)) return 'galaxy_spiral';
  if (/nebula|neb/i.test(name)) return 'emission_nebula';
  if (/cluster/i.test(name)) return 'star_cluster';

  return 'mixed_field';
}

/**
 * Determine workflow type from available channels.
 */
function detectWorkflow(config) {
  const F = config.files;
  const hasL = !!(F.L && F.L.trim());
  const hasR = !!(F.R && F.R.trim());
  const hasG = !!(F.G && F.G.trim());
  const hasB = !!(F.B && F.B.trim());
  const hasHa = !!(F.Ha && F.Ha.trim());
  const hasRGB = hasR && hasG && hasB;

  if (!hasRGB && hasL) return 'L_only';
  if (hasL && hasHa && hasRGB) return 'HaLRGB';
  if (hasHa && hasRGB) return 'HaRGB';
  if (hasL && hasRGB) return 'LRGB';
  return 'RGB';
}

/**
 * Generate a processing brief from a pipeline config and optional user intent.
 * @param {object} config - Pipeline config (v2 JSON)
 * @param {object} opts - { intent, style, ... }
 * @returns {object} Processing brief
 */
export function generateBrief(config, opts = {}) {
  const targetName = config.files?.targetName || config.name || 'Unknown';
  const classification = opts.classification || classifyFromName(targetName);
  const workflow = detectWorkflow(config);
  const isGalaxy = classification.startsWith('galaxy');

  // Determine aesthetic intent
  const style = opts.style || 'enhanced_natural';
  const backgroundTarget = isGalaxy ? 'dark' : 'medium';

  // Set technical priorities based on target class
  let priorities;
  if (isGalaxy) {
    priorities = ['signal_preservation', 'dynamic_range', 'resolution', 'noise_control',
      'background_quality', 'natural_appearance', 'color_accuracy', 'star_quality'];
  } else if (classification === 'emission_nebula') {
    priorities = ['color_accuracy', 'signal_preservation', 'natural_appearance', 'noise_control',
      'resolution', 'dynamic_range', 'background_quality', 'star_quality'];
  } else if (classification === 'reflection_nebula') {
    priorities = ['color_accuracy', 'natural_appearance', 'noise_control', 'signal_preservation',
      'background_quality', 'resolution', 'dynamic_range', 'star_quality'];
  } else {
    priorities = ['signal_preservation', 'noise_control', 'color_accuracy', 'dynamic_range',
      'resolution', 'background_quality', 'natural_appearance', 'star_quality'];
  }

  // Determine field characteristics from taxonomy
  const taxonomy = loadTaxonomy();
  const taxEntry = taxonomy[classification] || {};
  const taxTraits = taxEntry.traits || {};
  const hasHa = workflow.includes('Ha');

  // Override signalType based on actual data
  let signalType = taxTraits.signalType || 'broadband';
  if (hasHa && signalType === 'broadband') signalType = 'ha_accented';

  const fieldCharacteristics = {
    // New processing-relevant traits
    signalType,
    structuralZones: taxTraits.structuralZones || 'uniform',
    colorZonation: taxTraits.colorZonation || 'monochromatic',
    starRelationship: taxTraits.starRelationship || 'stars_are_context',
    faintStructureGoal: taxTraits.faintStructureGoal || 'none',
    subjectScale: taxTraits.subjectScale || 'medium',
    dynamicRange: taxTraits.dynamicRange || 'moderate',
    // Legacy boolean traits (kept for backward compat with prompt conditionals)
    haSignalStrength: hasHa ? 'moderate' : 'none',
    dustLanes: taxTraits.hasDustLanes ?? isGalaxy,
    brightCore: taxTraits.hasBrightCore ?? false,
    hasIFN: taxTraits.hasIFN ?? false,
    hasHIIRegions: taxTraits.hasHIIRegions ?? hasHa,
    // Processing guidance
    processingNotes: taxEntry.processingNotes || ''
  };

  return {
    briefId: `brief_${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    target: {
      name: targetName,
      classification,
      fieldCharacteristics
    },
    dataDescription: {
      workflow,
      channels: {
        L: !!(config.files?.L?.trim()),
        R: !!(config.files?.R?.trim()),
        G: !!(config.files?.G?.trim()),
        B: !!(config.files?.B?.trim()),
        Ha: !!(config.files?.Ha?.trim())
      }
    },
    aestheticIntent: {
      style,
      colorSaturation: isGalaxy ? 'moderate' : 'vivid',
      contrastLevel: 'moderate',
      backgroundTarget,
      starProminence: isGalaxy ? 'subdued' : 'balanced',
      detailEmphasis: isGalaxy ? 'fine_detail' : 'balanced',
      referenceNotes: opts.intent || ''
    },
    aestheticPreferences: {
      noiseLevel: opts.noiseLevel || 'clean',              // very_clean | clean | natural
      glow: opts.glow || 'moderate',                     // none | subtle | moderate | strong
      starPresence: opts.starPresence || 'prominent',    // minimal | subdued | prominent | rich
    },
    technicalPriorities: priorities,
    hardConstraints: {
      maxPixelValue: 0.995,
      minBackgroundMedian: 0.001,
      maxBackgroundMedian: isGalaxy ? 0.15 : 0.25,
      maxChannelImbalance: 0.05,
      maxMemoryMB: 8000,
      maxWallClockMinutes: opts.maxWallClockMinutes || 60,
      maxIterationsPerAgent: opts.maxIterationsPerAgent || 8
    },
    softGoals: opts.softGoals || [],
    processingProfile: loadProcessingProfiles()[classification] || loadProcessingProfiles()['mixed_field'] || {}
  };
}
