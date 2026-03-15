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

    // Conversation summary (LLM-driven agents)
    if (result.transcript) {
      const decisions = summarizeTranscript(result.transcript);
      if (decisions.length > 0) {
        sections.push('');
        sections.push('**Key decisions:**');
        sections.push('');
        for (const d of decisions) {
          sections.push(`- ${d}`);
        }
      }
      if (result.summary?.attempts > 1) {
        sections.push(`- **Critic iterations**: ${result.summary.attempts} attempts (critic rejected earlier results)`);
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
 * Summarize an agent conversation transcript into key decisions.
 * @param {Array} transcript - Array of transcript entries from LLMAgent
 * @returns {string[]} Key decision summaries
 */
function summarizeTranscript(transcript) {
  if (!transcript || transcript.length === 0) return [];

  const decisions = [];
  for (const entry of transcript) {
    // Extract tool calls with their rationale
    if (entry.type === 'tool_use') {
      const toolName = entry.tool;
      const input = entry.input || {};

      // Summarize meaningful tool calls
      if (toolName === 'finish') {
        decisions.push(`**Decision**: Finished — ${(input.rationale || '').slice(0, 200)}`);
      } else if (toolName === 'save_variant') {
        decisions.push(`Saved variant: ${input.notes || 'no notes'}`);
      } else if (toolName === 'restore_from_clone') {
        decisions.push(`Reverted to backup \`${input.clone_id}\` (previous approach didn't work)`);
      } else if (toolName === 'submit_scores') {
        decisions.push(`Critic verdict: **${input.verdict}** — ${(input.feedback || '').slice(0, 200)}`);
      } else if (toolName === 'seti_stretch') {
        decisions.push(`Stretched: target_median=${input.target_median}, headroom=${input.hdr_headroom}`);
      } else if (toolName === 'run_lhe') {
        decisions.push(`LHE: radius=${input.radius}, amount=${input.amount}, slope=${input.slope_limit}`);
      } else if (toolName === 'run_hdrmt') {
        decisions.push(`HDRMT: layers=${input.layers}, inverted=${input.inverted}`);
      } else if (toolName === 'run_gradient_correction') {
        decisions.push(`Gradient: GC on \`${input.view_id}\``);
      } else if (toolName === 'run_abe') {
        decisions.push(`Gradient: ABE (degree=${input.poly_degree || 4}) on \`${input.view_id}\``);
      } else if (toolName === 'run_nxt') {
        decisions.push(`Denoise: NXT(${input.denoise}) on \`${input.view_id}\``);
      } else if (toolName === 'run_curves') {
        decisions.push(`Curves: ${input.channel} channel`);
      }
    }
    // Extract key text reasoning (first sentence of substantial text blocks)
    if (entry.type === 'text' && entry.role === 'assistant' && entry.content?.length > 50) {
      const firstSentence = entry.content.split(/[.!?\n]/)[0].trim();
      if (firstSentence.length > 20 && firstSentence.length < 200) {
        decisions.push(`_${firstSentence}_`);
      }
    }
  }

  // Keep it concise — max 15 entries
  return decisions.slice(0, 15);
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
