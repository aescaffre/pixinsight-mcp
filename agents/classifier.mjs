// ============================================================================
// Classifier / Intent Agent
// Determines target classification and generates processing brief.
// Rule-based for Phase 1 (LLM-based classification in Phase 2).
// ============================================================================
import crypto from 'crypto';

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
  'Crescent': 'emission_nebula', 'Bubble': 'emission_nebula',
  'IC5070': 'emission_nebula', 'NGC6820': 'emission_nebula',
  'SH2': 'emission_nebula',
  // Reflection nebulae
  'M45': 'reflection_nebula', 'NGC7023': 'reflection_nebula',
  'IC2118': 'reflection_nebula', 'NGC1333': 'reflection_nebula',
  'vdB': 'reflection_nebula',
  // Planetary nebulae
  'M27': 'planetary_nebula', 'M57': 'planetary_nebula',
  'NGC7293': 'planetary_nebula', 'NGC6543': 'planetary_nebula',
  'NGC2392': 'planetary_nebula', 'NGC3242': 'planetary_nebula',
  // Star clusters
  'M13': 'star_cluster', 'M3': 'star_cluster', 'M5': 'star_cluster',
  'M92': 'star_cluster', 'M2': 'star_cluster',
  'NGC884': 'star_cluster', 'NGC869': 'star_cluster',
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

  // Determine field characteristics
  const fieldCharacteristics = {
    starDensity: 'moderate',
    haSignalStrength: workflow.includes('Ha') ? 'moderate' : 'none',
    dustLanes: isGalaxy,
    brightCore: isGalaxy || classification === 'planetary_nebula',
    faintOuterStructure: isGalaxy
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
    softGoals: opts.softGoals || []
  };
}
