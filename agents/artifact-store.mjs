// ============================================================================
// Artifact store: structured directory management for agent products
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

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
    const counter = (this.variantCounters[agentName] || 0) + 1;
    this.variantCounters[agentName] = counter;
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

  /**
   * Load a variant by opening its XISF in PixInsight.
   * @returns {object} metadata
   */
  async loadVariant(ctx, artifactId) {
    const parts = artifactId.split('/');
    const agentName = parts[1];
    const variantId = parts[2];
    const dir = path.join(this.agentDir(agentName), variantId);
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf-8'));

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
    if (loadedId && loadedId !== metadata.viewId) {
      await ctx.pjsr(`
        var w = ImageWindow.windowById('${loadedId}');
        if (!w.isNull) w.mainView.id = '${metadata.viewId}';
      `);
    }

    return metadata;
  }

  /**
   * Promote a variant as the winner for an agent.
   */
  promoteWinner(agentName, variantId, score) {
    this.manifest.agents[agentName] = {
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
    if (!winnerInfo) return null;

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
