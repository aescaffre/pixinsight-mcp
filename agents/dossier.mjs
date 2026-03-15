// ============================================================================
// Processing Dossier Generator
// Reads all artifacts from a run and generates a comprehensive report.
// ============================================================================
import fs from 'fs';
import path from 'path';

/**
 * Generate a full processing dossier from a completed run.
 * @param {ArtifactStore} store - The artifact store
 * @param {object} brief - Processing brief
 * @param {object} agentResults - { rgb: result, lum: result, comp: result, ... }
 * @returns {string} Markdown dossier
 */
export function generateDossier(store, brief, agentResults) {
  const sections = [];

  // Header
  sections.push(`# Processing Dossier — ${brief.target.name}`);
  sections.push('');
  sections.push(`**Generated**: ${new Date().toISOString()}`);
  sections.push(`**Run ID**: ${store.runId}`);
  sections.push('');

  // 1. Input Summary
  sections.push('## 1. Input Summary');
  sections.push('');
  sections.push(`| Property | Value |`);
  sections.push(`|----------|-------|`);
  sections.push(`| Target | ${brief.target.name} |`);
  sections.push(`| Classification | ${brief.target.classification} |`);
  sections.push(`| Workflow | ${brief.dataDescription.workflow} |`);
  const channels = Object.entries(brief.dataDescription.channels)
    .filter(([, v]) => v).map(([k]) => k).join(', ');
  sections.push(`| Channels | ${channels} |`);
  sections.push('');

  // 2. Processing Intent
  sections.push('## 2. Processing Intent');
  sections.push('');
  sections.push(`- **Style**: ${brief.aestheticIntent.style}`);
  sections.push(`- **Saturation**: ${brief.aestheticIntent.colorSaturation}`);
  sections.push(`- **Contrast**: ${brief.aestheticIntent.contrastLevel}`);
  sections.push(`- **Background**: ${brief.aestheticIntent.backgroundTarget}`);
  sections.push(`- **Stars**: ${brief.aestheticIntent.starProminence}`);
  sections.push(`- **Detail**: ${brief.aestheticIntent.detailEmphasis}`);
  if (brief.aestheticIntent.referenceNotes) {
    sections.push(`- **Notes**: ${brief.aestheticIntent.referenceNotes}`);
  }
  sections.push('');

  // 3. Technical Priorities
  sections.push('## 3. Technical Priorities');
  sections.push('');
  brief.technicalPriorities.forEach((p, i) => {
    sections.push(`${i + 1}. ${p.replace(/_/g, ' ')}`);
  });
  sections.push('');

  // 4. Agent Summaries
  const agentOrder = [
    ['rgb', 'RGB Cleanliness'],
    ['lum', 'Luminance Detail'],
    ['ha', 'Ha Integration'],
    ['stars', 'Star Policy'],
    ['comp', 'Composition'],
    ['finish', 'Finishing']
  ];

  let sectionNum = 4;
  for (const [key, label] of agentOrder) {
    const result = agentResults[key];
    if (!result) continue;

    sections.push(`## ${sectionNum}. ${label} Agent`);
    sections.push('');
    sections.push(`- **Winner**: ${result.winnerId || 'N/A'}`);
    sections.push(`- **Score**: ${result.winnerScore?.toFixed(1) || 'N/A'} / 100`);
    sections.push(`- **Iterations**: ${result.summary?.iterations || 0}`);
    sections.push(`- **Final state**: ${result.summary?.state || 'N/A'}`);
    sections.push(`- **Time**: ${Math.round((result.summary?.elapsedMs || 0) / 1000)}s`);

    // Winner parameters
    if (result.winnerMetadata?.params) {
      sections.push('');
      sections.push('**Winning parameters:**');
      sections.push('');
      sections.push('| Parameter | Value |');
      sections.push('|-----------|-------|');
      for (const [param, value] of Object.entries(result.winnerMetadata.params)) {
        const displayValue = typeof value === 'object' ? JSON.stringify(value) : value;
        sections.push(`| ${param} | ${displayValue} |`);
      }
    }

    // Score dimensions
    if (result.scorecards?.length > 0) {
      const winnerCard = result.scorecards.find(s => s.candidateId === result.winnerId);
      if (winnerCard?.scores) {
        sections.push('');
        sections.push('**Quality scores:**');
        sections.push('');
        sections.push('| Dimension | Score |');
        sections.push('|-----------|-------|');
        for (const [dim, score] of Object.entries(winnerCard.scores)) {
          sections.push(`| ${dim.replace(/_/g, ' ')} | ${typeof score === 'number' ? score.toFixed(1) : score} |`);
        }
      }
    }

    sections.push('');
    sectionNum++;
  }

  // Known Compromises
  sections.push(`## ${sectionNum}. Known Compromises`);
  sections.push('');
  sections.push('- Stats-only scoring (no visual/aesthetic critic in Phase 1)');
  const missingAgents = agentOrder
    .filter(([key]) => !agentResults[key])
    .map(([, label]) => label);
  if (missingAgents.length > 0) {
    sections.push(`- Agents not run: ${missingAgents.join(', ')}`);
  }
  sections.push('');
  sectionNum++;

  // Provenance
  sections.push(`## ${sectionNum}. Provenance`);
  sections.push('');
  sections.push(`- **Artifacts directory**: \`${store.baseDir}\``);
  sections.push(`- **Manifest**: \`${store.manifestPath}\``);
  sections.push(`- **Brief**: \`${path.join(store.baseDir, 'brief.json')}\``);
  sections.push('');
  sections.push('---');
  sections.push('*Generated by Agentic Pipeline Orchestrator v0.1*');

  return sections.join('\n');
}

/**
 * Generate machine-readable provenance JSON.
 */
export function generateProvenance(store, brief, agentResults) {
  return {
    runId: store.runId,
    timestamp: new Date().toISOString(),
    brief: {
      target: brief.target,
      workflow: brief.dataDescription.workflow,
      style: brief.aestheticIntent.style
    },
    agents: Object.fromEntries(
      Object.entries(agentResults).map(([key, result]) => [
        key,
        {
          winnerId: result.winnerId,
          winnerScore: result.winnerScore,
          iterations: result.summary?.iterations,
          state: result.summary?.state,
          elapsedMs: result.summary?.elapsedMs,
          winnerParams: result.winnerMetadata?.params
        }
      ])
    ),
    manifest: store.manifest
  };
}
