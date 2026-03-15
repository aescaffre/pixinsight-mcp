import fs from 'fs';
import path from 'path';
import os from 'os';

const home = os.homedir();
const DEFAULT_CHECKPOINT_DIR = path.join(home, '.pixinsight-mcp', 'checkpoints');

/**
 * Save a checkpoint for the given step, persisting all live branch images to XISF files.
 *
 * @param {object} ctx        - Bridge context with pjsr(), send(), listImages(), log()
 * @param {string} stepId     - Checkpoint step identifier (e.g. 'sxt', 'stretch')
 * @param {object} liveImages - Map of branch → viewId (e.g. { main: 'M81', stars: 'M81_stars', ha: 'Ha_work', lum: 'L_work' })
 * @param {object} [opts]
 * @param {string} [opts.checkpointDir] - Override the default checkpoint directory
 * @returns {object} manifest  - The saved manifest { stepId, timestamp, images }
 */
export async function saveCheckpoint(ctx, stepId, liveImages, opts = {}) {
  const checkpointDir = opts.checkpointDir || DEFAULT_CHECKPOINT_DIR;
  if (!fs.existsSync(checkpointDir)) fs.mkdirSync(checkpointDir, { recursive: true });
  const manifest = { stepId, timestamp: new Date().toISOString(), images: {} };

  for (const [branch, viewId] of Object.entries(liveImages)) {
    const filename = `checkpoint_${stepId}_${branch}.xisf`;
    const filePath = path.join(checkpointDir, filename);
    ctx.log(`    [checkpoint] Saving ${branch} (${viewId}) -> ${filename}`);
    const r = await ctx.pjsr(`
      var w = ImageWindow.windowById('${viewId}');
      if (w.isNull) throw new Error('View not found: ${viewId}');
      var p = '${filePath.replace(/'/g, "\\'")}';
      if (File.exists(p)) File.remove(p);
      w.saveAs(p, false, false, false, false);
      // saveAs may rename view to match filename — rename back to original
      if (w.mainView.id !== '${viewId}') {
        w.mainView.id = '${viewId}';
      }
      'OK';
    `);
    if (r.status === 'error') {
      ctx.log('    [checkpoint] WARN: ' + r.error.message);
      continue;
    }
    manifest.images[branch] = { viewId, filename };
  }

  const manifestPath = path.join(checkpointDir, `checkpoint_${stepId}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  ctx.log(`    [checkpoint] Saved checkpoint: ${stepId} (${Object.keys(manifest.images).length} images)`);
  return manifest;
}

/**
 * Load a checkpoint, closing all currently open images and restoring the saved branches.
 *
 * @param {object} ctx    - Bridge context with pjsr(), send(), listImages(), log()
 * @param {string} stepId - Checkpoint step identifier to restore
 * @param {object} [opts]
 * @param {string} [opts.checkpointDir] - Override the default checkpoint directory
 * @returns {object} liveImages - Restored map of branch → viewId
 */
export async function loadCheckpoint(ctx, stepId, opts = {}) {
  const checkpointDir = opts.checkpointDir || DEFAULT_CHECKPOINT_DIR;
  const manifestPath = path.join(checkpointDir, `checkpoint_${stepId}.json`);
  if (!fs.existsSync(manifestPath)) throw new Error('No checkpoint found for: ' + stepId);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  ctx.log('  Checkpoint timestamp: ' + manifest.timestamp);

  // Close all currently open images
  let imgs = await ctx.listImages();
  if (imgs.length > 0) {
    const ids = imgs.map(i => "'" + i.id + "'").join(',');
    await ctx.pjsr(`var ids=[${ids}]; for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(!w.isNull)w.forceClose();processEvents();}`);
  }

  const liveImages = {};

  // Open each checkpoint image
  for (const [branch, info] of Object.entries(manifest.images)) {
    const filePath = path.join(checkpointDir, info.filename);
    ctx.log(`  Loading ${branch}: ${info.filename} (viewId: ${info.viewId})`);
    const r = await ctx.send('open_image', '__internal__', { filePath });
    if (r.status === 'error') { ctx.log('  WARN: ' + r.error.message); continue; }

    // Close crop masks
    const allImgs = await ctx.listImages();
    for (const cm of allImgs.filter(i => i.id.indexOf('crop_mask') >= 0)) {
      await ctx.pjsr(`var w=ImageWindow.windowById('${cm.id}');if(!w.isNull)w.forceClose();`);
    }

    // Rename view to original viewId if different
    const loadedId = r.outputs.id;
    if (loadedId !== info.viewId) {
      await ctx.pjsr(`
        var w = ImageWindow.windowById('${loadedId}');
        if (!w.isNull) { w.mainView.id = '${info.viewId}'; }
      `);
    }
    liveImages[branch] = info.viewId;
  }

  ctx.log('  Restored branches: ' + Object.keys(liveImages).join(', '));
  return liveImages;
}
