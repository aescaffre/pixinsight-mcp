import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

const home = os.homedir();
const cmdDir = path.join(home, '.pixinsight-mcp/bridge/commands');
const resDir = path.join(home, '.pixinsight-mcp/bridge/results');

// Bridge communication
function send(tool, proc, params, opts) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cmd = {
      id, timestamp: new Date().toISOString(), tool, process: proc,
      parameters: params,
      executeMethod: opts?.exec || 'executeGlobal',
      targetView: opts?.view || null
    };
    fs.writeFileSync(path.join(cmdDir, id + '.json'), JSON.stringify(cmd, null, 2));
    let att = 0;
    const poll = setInterval(() => {
      const rp = path.join(resDir, id + '.json');
      if (fs.existsSync(rp)) {
        try {
          const r = JSON.parse(fs.readFileSync(rp, 'utf-8'));
          if (r.status === 'running') return;
          clearInterval(poll);
          fs.unlinkSync(rp);
          resolve(r);
        } catch (e) { /* retry */ }
      }
      att++;
      if (att > 2400) { clearInterval(poll); reject(new Error('Timeout: ' + tool)); }
    }, 500);
  });
}

function pjsr(code) { return send('run_script', '__script__', { code }); }

async function listImages() {
  const list = await send('list_open_images', '__internal__', {});
  return list.outputs?.images || [];
}

async function getStats(viewId) {
  const r = await pjsr(`
    var v = ImageWindow.windowById('${viewId}').mainView;
    var img = v.image;
    var result = {};
    if (img.isColor) {
      var meds = [], mads = [];
      for (var c = 0; c < img.numberOfChannels; c++) {
        img.selectedChannel = c;
        meds.push(img.median());
        mads.push(img.MAD());
      }
      img.resetSelections();
      result.median = (meds[0] + meds[1] + meds[2]) / 3;
      result.mad = (mads[0] + mads[1] + mads[2]) / 3;
      result.medR = meds[0]; result.medG = meds[1]; result.medB = meds[2];
    } else {
      result.median = img.median();
      result.mad = img.MAD();
    }
    result.min = img.minimum();
    result.max = img.maximum();
    JSON.stringify(result);
  `);
  try { return JSON.parse(r.outputs?.consoleOutput || '{}'); }
  catch { return { median: 0.01, mad: 0.001 }; }
}

async function saveJpeg(viewId, outputPath, isLinear) {
  const r = await pjsr(`
    var srcW = ImageWindow.windowById('${viewId}');
    if (!srcW) throw new Error('View not found: ${viewId}');
    var src = srcW.mainView;
    var img = src.image;
    var w = img.width, h = img.height;
    var tmp = new ImageWindow(w, h, img.numberOfChannels, 32, false, img.isColor, 'jpeg_tmp');
    tmp.mainView.beginProcess();
    tmp.mainView.image.assign(img);
    tmp.mainView.endProcess();
    ${isLinear ? `
    var meds = [], mads = [];
    var timg = tmp.mainView.image;
    if (timg.isColor) {
      for (var c = 0; c < timg.numberOfChannels; c++) {
        timg.selectedChannel = c;
        meds.push(timg.median());
        mads.push(timg.MAD());
      }
      timg.resetSelections();
    } else {
      meds = [timg.median()]; mads = [timg.MAD()];
    }
    var med = 0, mad = 0;
    for (var c = 0; c < meds.length; c++) { med += meds[c]; mad += mads[c]; }
    med /= meds.length; mad /= mads.length;
    var c0 = Math.max(0, med - 2.8 * mad);
    var x = (1 > c0) ? (med - c0) / (1 - c0) : 0.5;
    var tgt = 0.25;
    var m = (x <= 0 || x >= 1) ? 0.5 : x * (1 - tgt) / (x * (1 - 2*tgt) + tgt);
    var HT = new HistogramTransformation;
    HT.H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[c0,m,1,0,1],[0,0.5,1,0,1]];
    HT.executeOn(tmp.mainView);
    ` : ''}
    var p = '${outputPath}';
    if (File.exists(p)) File.remove(p);
    tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
    'OK';
  `);
  return r;
}

// Parse CLI: node process-interactive.mjs <action> [args...]
const action = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (action) {
    case 'ping': {
      const r = await pjsr(`'pong'`);
      console.log('Watcher:', r.status, r.outputs?.consoleOutput);
      break;
    }

    case 'mem': {
      // Check PI memory via ps
      const { execSync } = await import('child_process');
      const out = execSync("ps aux | grep 'PixInsight.app/Contents/MacOS/PixInsight' | grep -v grep | awk '{print $6}'").toString().trim();
      const kb = parseInt(out);
      const gb = (kb / 1024 / 1024).toFixed(2);
      console.log(`PixInsight memory: ${gb} GB (${kb} KB)`);
      if (kb > 18 * 1024 * 1024) console.log('WARNING: Above 18GB threshold!');
      break;
    }

    case 'list': {
      const imgs = await listImages();
      for (const i of imgs) console.log(`  ${i.id} (${i.width}x${i.height})`);
      if (imgs.length === 0) console.log('  (no images open)');
      break;
    }

    case 'stats': {
      const viewId = args[0];
      const s = await getStats(viewId);
      console.log(JSON.stringify(s, null, 2));
      break;
    }

    case 'open': {
      const filePath = args[0];
      const r = await send('open_image', '__internal__', { filePath });
      if (r.status === 'error') console.log('ERROR:', r.error.message);
      else console.log(`Opened: ${r.outputs.id} (${r.outputs.width}x${r.outputs.height})`);
      // Close crop masks
      const imgs = await listImages();
      for (const cm of imgs.filter(i => i.id.indexOf('crop_mask') >= 0)) {
        await pjsr(`var w=ImageWindow.windowById('${cm.id}');if(w)w.forceClose();`);
        console.log(`  Closed crop mask: ${cm.id}`);
      }
      break;
    }

    case 'close': {
      const viewId = args[0];
      await pjsr(`var w=ImageWindow.windowById('${viewId}');if(w)w.forceClose();`);
      console.log(`Closed: ${viewId}`);
      break;
    }

    case 'closeall': {
      const imgs = await listImages();
      if (imgs.length > 0) {
        const ids = imgs.map(i => "'" + i.id + "'").join(',');
        await pjsr(`var ids=[${ids}]; for(var i=0;i<ids.length;i++){var w=ImageWindow.windowById(ids[i]);if(w)w.forceClose();processEvents();}`);
        console.log(`Closed ${imgs.length} images`);
      } else {
        console.log('No images to close');
      }
      break;
    }

    case 'run': {
      const code = args.join(' ');
      const r = await pjsr(code);
      if (r.status === 'error') console.log('ERROR:', r.error.message);
      else console.log(r.outputs?.consoleOutput || 'OK');
      break;
    }

    case 'jpeg': {
      const viewId = args[0];
      const outputPath = args[1];
      const isLinear = args[2] === 'linear';
      const r = await saveJpeg(viewId, outputPath, isLinear);
      if (r.status === 'error') console.log('ERROR:', r.error.message);
      else console.log('Saved:', outputPath);
      break;
    }

    default:
      console.log('Usage: node process-interactive.mjs <action> [args]');
      console.log('Actions: ping, mem, list, stats <view>, open <path>, close <view>, closeall, run <code>, jpeg <view> <path> [linear]');
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
