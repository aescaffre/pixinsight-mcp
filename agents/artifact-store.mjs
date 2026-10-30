// ============================================================================
// Artifact store: structured directory management for agent products
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { scoreVariantDimensions } from './ledger.mjs';

const home = os.homedir();
const DEFAULT_RUNS_DIR = path.join(home, '.pixinsight-mcp', 'runs');

// Agent directory prefixes for ordering
const AGENT_PREFIXES = {
  readiness: '01_ready',
  luminance_detail: '02_luminance',
  rgb_cleanliness: '03_rgb',
  ha_integration: '04_ha',
  star_policy: '05_stars',
  composition: '06_composition',
  finishing: '07_finishing',
  selection: '08_selection'
};

export class ArtifactStore {
  /**
   * @param {string} runId - Unique run identifier (or auto-generated)
   * @param {object} opts - { runsDir }
   */
  constructor(runId, opts = {}) {
    this.runId = runId || `run_${new Date().toISOString().slice(0, 10)}_${crypto.randomUUID().slice(0, 8)}`;
    this.runsDir = opts.runsDir || DEFAULT_RUNS_DIR;
    this.baseDir = path.join(this.runsDir, this.runId);
    this.variantCounters = {};

    // Create base directory
    fs.mkdirSync(this.baseDir, { recursive: true });

    // Initialize or load manifest
    this.manifestPath = path.join(this.baseDir, 'manifest.json');
    if (fs.existsSync(this.manifestPath)) {
      this.manifest = JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
    } else {
      this.manifest = {
        runId: this.runId,
        created: new Date().toISOString(),
        agents: {},
        status: 'running'
      };
      this._saveManifest();
    }
  }

  /**
   * Get the directory path for an agent's artifacts.
   */
  agentDir(agentName) {
    const prefix = AGENT_PREFIXES[agentName] || agentName;
    return path.join(this.baseDir, prefix);
  }

  /**
   * Save a variant produced by an agent.
   * @param {object} ctx - Bridge context (for saving XISF via PixInsight)
   * @param {string} agentName - Agent identifier
   * @param {string} viewId - PixInsight view ID to save
   * @param {object} params - Parameters used for this variant
   * @param {object} metrics - Image statistics
   * @param {object} opts - { saveXisf: true, savePreview: true }
   * @returns {object} { artifactId, dir, metadata }
   */
  async saveVariant(ctx, agentName, viewId, params, metrics, opts = {}) {
    // WI-07b: counter comes from disk (max variant_NN + 1) so MCP restarts / resumed agents never reuse an id
    const counter = Math.max(this.variantCounters[agentName] || 0, this.maxVariantOnDisk(agentName)) + 1;
    this.variantCounters[agentName] = counter;
    this.manifest.variantCounters = { ...(this.manifest.variantCounters || {}), [agentName]: counter };
    this._saveManifest();
    const variantId = `variant_${String(counter).padStart(2, '0')}`;
    const dir = path.join(this.agentDir(agentName), variantId);
    fs.mkdirSync(dir, { recursive: true });

    const artifactId = `${this.runId}/${agentName}/${variantId}`;

    // Save XISF via PixInsight
    if (opts.saveXisf !== false) {
      const xisfPath = path.join(dir, 'image.xisf');
      await ctx.pjsr(`
        var w = ImageWindow.windowById('${viewId}');
        if (w.isNull) throw new Error('View not found: ${viewId}');
        var p = '${xisfPath.replace(/'/g, "\\'")}';
        if (File.exists(p)) File.remove(p);
        w.saveAs(p, false, false, false, false);
        if (w.mainView.id !== '${viewId}') w.mainView.id = '${viewId}';
        'OK';
      `);
    }

    // Save preview JPEG
    if (opts.savePreview !== false) {
      const previewPath = path.join(dir, 'preview.jpg');
      await ctx.pjsr(`
        var srcW = ImageWindow.windowById('${viewId}');
        if (srcW.isNull) throw new Error('View not found: ${viewId}');
        var img = srcW.mainView.image;
        var w = img.width, h = img.height;
        var tmp = new ImageWindow(w, h, img.numberOfChannels, 32, false, img.isColor, 'artifact_preview_tmp');
        tmp.mainView.beginProcess();
        tmp.mainView.image.assign(img);
        tmp.mainView.endProcess();
        var dir = '${dir.replace(/'/g, "\\'")}';
        if (!File.directoryExists(dir)) File.createDirectory(dir, true);
        var p = '${previewPath.replace(/'/g, "\\'")}';
        if (File.exists(p)) File.remove(p);
        tmp.saveAs(p, false, false, false, false);
        tmp.forceClose();
        'OK';
      `);
    }

    // Save metadata
    const metadata = {
      artifactId,
      agent: agentName,
      variantId,
      timestamp: new Date().toISOString(),
      viewId,
      xisfPath: path.join(dir, 'image.xisf'),
      previewPath: path.join(dir, 'preview.jpg'),
      params,
      metrics
    };
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));

    return { artifactId, dir, metadata };
  }

  /** WI-07b: highest variant_NN number present on disk for an agent (0 if none). */
  maxVariantOnDisk(agentName) {
    try {
      const dir = this.agentDir(agentName);
      if (!fs.existsSync(dir)) return 0;
      let max = 0;
      for (const d of fs.readdirSync(dir)) {
        const m = /^variant_(\d+)$/.exec(d);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      return max;
    } catch { return 0; }
  }

  /** WI-07b: mark the run as crashed (PixInsight died). */
  fail(reason) {
    this.manifest.status = 'crashed';
    this.manifest.failReason = reason || null;
    this.manifest.failedAt = new Date().toISOString();
    this._saveManifest();
  }

  /**
   * Load a variant by opening its XISF in PixInsight.
   * artifactId: full "runId/agent/variant_NN" or a short "variant_NN" (resolved for opts.agentName, default giga_orchestrator).
   * opts: { agentName, viewId (rename target, default = the saved view id), replaceExisting (default false) }
   * @returns {object} metadata
   */
  async loadVariant(ctx, artifactId, opts = {}) {
    let agentName, variantId;
    if (String(artifactId).indexOf('/') < 0) {
      agentName = opts.agentName || 'giga_orchestrator';
      variantId = String(artifactId);
      if (!this.getVariantById(agentName, variantId)) throw new Error(`Variant not found: ${variantId} (agent ${agentName})`);
    } else {
      const parts = artifactId.split('/');
      agentName = parts[1];
      variantId = parts[2];
    }
    const dir = path.join(this.agentDir(agentName), variantId);
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf-8'));
    const targetId = opts.viewId || metadata.viewId;

    // Never let PixInsight auto-suffix silently: refuse (or replace) when the target id is already open
    const before = await ctx.listImages();
    if (before.some(i => i.id === targetId)) {
      if (opts.replaceExisting) {
        await ctx.pjsr(`var w=ImageWindow.windowById('${targetId}');if(!w.isNull)w.forceClose();`);
      } else {
        throw new Error(`REFUSED: view ${targetId} already open — close it or pass view_id (or replace_existing=true)`);
      }
    }

    // Open XISF in PixInsight
    const r = await ctx.send('open_image', '__internal__', { filePath: metadata.xisfPath });
    if (r.status === 'error') throw new Error(`Failed to open ${metadata.xisfPath}: ${r.error?.message}`);

    // Close crop masks
    const allImgs = await ctx.listImages();
    for (const cm of allImgs.filter(i => i.id.indexOf('crop_mask') >= 0)) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
    }

    // Rename view to original ID if needed
    const loadedId = r.outputs?.id;
    if (loadedId && loadedId !== targetId) {
      await ctx.pjsr(`
        var w = ImageWindow.windowById('${loadedId}');
        if (!w.isNull) w.mainView.id = '${targetId}';
      `);
    }

    return { ...metadata, loadedViewId: targetId };
  }

  /**
   * WI-08: record the model/effort/usage an agent subprocess ran with (merged into
   * manifest.agents[name]; does not clobber a promoted `winner`).
   */
  recordAgentRun(agentName, info) {
    const prev = this.manifest.agents[agentName] || {};
    this.manifest.agents[agentName] = { ...prev, ...info, recordedAt: new Date().toISOString() };
    this._saveManifest();
  }

  /**
   * Promote a variant as the winner for an agent.
   */
  promoteWinner(agentName, variantId, score) {
    this.manifest.agents[agentName] = {
      ...(this.manifest.agents[agentName] || {}),
      winner: `${this.runId}/${agentName}/${variantId}`,
      score,
      promotedAt: new Date().toISOString()
    };
    this._saveManifest();

    // Create winner symlink/copy
    const winnerDir = path.join(this.agentDir(agentName), 'winner');
    const sourceDir = path.join(this.agentDir(agentName), variantId);
    if (fs.existsSync(winnerDir)) fs.rmSync(winnerDir, { recursive: true });
    try {
      fs.symlinkSync(sourceDir, winnerDir);
    } catch {
      // Fallback: copy metadata.json to winner dir
      fs.mkdirSync(winnerDir, { recursive: true });
      if (fs.existsSync(path.join(sourceDir, 'metadata.json'))) {
        fs.copyFileSync(path.join(sourceDir, 'metadata.json'), path.join(winnerDir, 'metadata.json'));
      }
    }
  }

  /**
   * Get the winner artifact for an agent.
   * @returns {object|null} metadata or null
   */
  getWinner(agentName) {
    const winnerInfo = this.manifest.agents[agentName];
    if (!winnerInfo || !winnerInfo.winner) return null;

    const parts = winnerInfo.winner.split('/');
    const variantId = parts[2];
    const metaPath = path.join(this.agentDir(agentName), variantId, 'metadata.json');
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  }

  /**
   * Save a critic scorecard.
   */
  saveScorecard(agentName, criticName, scorecard) {
    const scoresDir = path.join(this.agentDir(agentName), 'scores');
    fs.mkdirSync(scoresDir, { recursive: true });
    fs.writeFileSync(
      path.join(scoresDir, `${criticName}.json`),
      JSON.stringify(scorecard, null, 2)
    );
  }

  /**
   * Save the processing brief.
   */
  saveBrief(brief) {
    fs.writeFileSync(path.join(this.baseDir, 'brief.json'), JSON.stringify(brief, null, 2));
  }

  /**
   * Load the processing brief.
   */
  loadBrief() {
    const p = path.join(this.baseDir, 'brief.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  /**
   * List all variants for an agent.
   */
  listVariants(agentName) {
    const dir = this.agentDir(agentName);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(d => d.startsWith('variant_'))
      .map(d => {
        const metaPath = path.join(dir, d, 'metadata.json');
        if (!fs.existsSync(metaPath)) return null;
        return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      })
      .filter(Boolean);
  }

  /**
   * Persist a gate-battery result (WI-01 run_quality_gates) into a variant's metadata.json
   * under the `gates` key. list_variants shows it.
   * @returns {object|null} updated metadata or null if the variant does not exist
   */
  saveVariantMetrics(agentName, variantId, gates) {
    const metaPath = path.join(this.agentDir(agentName), variantId, 'metadata.json');
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.gates = { ...gates, evaluatedAt: new Date().toISOString() };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return meta;
  }

  /**
   * Look up a variant by its short ID (e.g. "variant_21").
   * @param {string} agentName
   * @param {string} variantId - e.g. "variant_21"
   * @returns {object|null} metadata or null
   */
  getVariantById(agentName, variantId) {
    const dir = path.join(this.agentDir(agentName), variantId);
    const metaPath = path.join(dir, 'metadata.json');
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  }

  /**
   * Write the final selection record for export.
   * @param {object} selection - { variant_id, variant_path, notes, finish_seq }
   */
  writeFinalSelection(selection) {
    const record = {
      ...selection,
      created_at: new Date().toISOString(),
      run_id: this.runId,
    };
    fs.writeFileSync(
      path.join(this.baseDir, 'final-selection.json'),
      JSON.stringify(record, null, 2)
    );
    return record;
  }

  /**
   * Read the final selection record.
   * @returns {object|null}
   */
  readFinalSelection() {
    const p = path.join(this.baseDir, 'final-selection.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }

  /**
   * Record completion of a pipeline stage for resume support.
   */
  recordStageCompletion(stageIndex, agentName, winnerId, artifactId, extras = {}) {
    if (!this.manifest.stageProgress) this.manifest.stageProgress = [];
    this.manifest.stageProgress.push({
      stageIndex,
      agentName,
      winnerId,
      artifactId,
      ...extras,
      completedAt: new Date().toISOString()
    });
    this._saveManifest();
  }

  /**
   * Get the last completed stage for resume.
   * @returns {{ stageIndex, agentName, winnerId, artifactId, ... } | null}
   */
  getLastCompletedStage() {
    const progress = this.manifest.stageProgress || [];
    return progress.length > 0 ? progress[progress.length - 1] : null;
  }

  /**
   * Finalize the run.
   */
  finalize(finalArtifactId) {
    this.manifest.status = 'completed';
    this.manifest.completedAt = new Date().toISOString();
    this.manifest.finalArtifact = finalArtifactId;
    this._saveManifest();
  }

  _saveManifest() {
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }
}

/**
 * WI-07a: pick the best saved variant when the agent never produced a passing finish.
 * Preference: persisted run_quality_gates PASS (fewest warnings) > highest ledger
 * scoreVariantDimensions sum > latest save. Variants without an existing XISF are skipped.
 * @returns {object|null} variant metadata
 */
export function getBestVariant(store, agent = 'giga_orchestrator') {
  const all = (store.listVariants(agent) || []).filter(v => v && v.xisfPath && fs.existsSync(v.xisfPath));
  if (all.length === 0) return null;
  // Never export a STAR LAYER as the final (IC5146 d1746166, 2026-10-30: the fallback picked
  // D_stars_reduced). Prefer composites (stage compose/final/merge), then any non-star variant.
  const isStar = v => /star/i.test(String(v.stage || '')) || /star/i.test(String(v.viewId || v.view_id || ''));
  const nonStar = all.filter(v => !isStar(v));
  const composites = nonStar.filter(v => /comp|final|merge|finali/i.test(String(v.stage || '')));
  const variants = composites.length ? composites : (nonStar.length ? nonStar : all);
  const byNum = (v) => parseInt(String(v.variantId || '').replace(/\D/g, ''), 10) || 0;
  const passing = variants.filter(v => v.gates && v.gates.pass === true);
  if (passing.length) {
    passing.sort((a, b) => (a.gates.warnings || 0) - (b.gates.warnings || 0) || byNum(b) - byNum(a));
    return passing[0];
  }
  let best = null, bestScore = -Infinity;
  for (const v of variants) {
    const m = v.gates?.metrics || v.metrics;
    if (!m) continue;
    let sc = -Infinity;
    try {
      const dims = scoreVariantDimensions(m);
      const vals = Object.values(dims).filter(x => typeof x === 'number' && isFinite(x));
      if (vals.length) sc = vals.reduce((a, b) => a + b, 0);
    } catch {}
    if (sc > bestScore || (sc === bestScore && best && byNum(v) > byNum(best))) { best = v; bestScore = sc; }
  }
  if (best && bestScore > -Infinity) return best;
  return variants.slice().sort((a, b) => byNum(b) - byNum(a))[0];
}

