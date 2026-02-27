#!/usr/bin/env node
// GHS L-channel tuning script — iterate on each pass independently
// Usage:
//   node scripts/test-ghs-l.mjs setup              — load L, crop, SXT, save baseline
//   node scripts/test-ghs-l.mjs pass1 B=6           — test pass 1 with B=6
//   node scripts/test-ghs-l.mjs pass1 B=9           — test pass 1 with B=9
//   node scripts/test-ghs-l.mjs lock1 B=7.5         — lock pass 1 at B=7.5, apply it
//   node scripts/test-ghs-l.mjs pass2 B=5           — test pass 2 with B=5 (after locked pass 1)
//   node scripts/test-ghs-l.mjs lock2 B=5           — lock pass 2
//   node scripts/test-ghs-l.mjs pass3 B=-1          — test pass 3
//   node scripts/test-ghs-l.mjs lock3 B=-1          — lock pass 3
//   node scripts/test-ghs-l.mjs final               — save final L preview

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

const home = os.homedir();
const cmdDir = path.join(home, '.pixinsight-mcp/bridge/commands');
const resDir = path.join(home, '.pixinsight-mcp/bridge/results');
const PREVIEW_DIR = path.join(home, '.pixinsight-mcp/previews');
const STATE_FILE = path.join(home, '.pixinsight-mcp/ghs-test-state.json');

// L master file (aligned)
const L_ALIGNED = '/Users/aescaffre/Bodes Galaxy/M81 M82/masterLight_BIN-1_6224x4168_EXPOSURE-180.00s_FILTER-L_mono_autocrop.xisf';

// Default GHS params (D and LP/HP — B is what we're tuning)
const PASS_DEFAULTS = {
  1: { D: 2.5, LP: 0, HP: 0.95 },
  2: { D: 1.5, LP: 0.02, HP: 0.90 },
  3: { D: 0.8, LP: 0.05, HP: 0.85 }
};

// ============================================================================
// Bridge communication (same as pipeline)
// ============================================================================
function send(tool, proc, params) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cmd = { id, timestamp: new Date().toISOString(), tool, process: proc, parameters: params };
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
        } catch { /* retry */ }
      }
      att++;
      if (att > 2400) { clearInterval(poll); reject(new Error('Timeout')); }
    }, 500);
  });
}

async function pjsr(code) {
  const r = await send('run_script', '__script__', { code });
  r.result = r.outputs?.consoleOutput;
  if (r.status !== 'error') r.status = 'ok';
  return r;
}

async function getStats(viewId) {
  const r = await pjsr(`
    var v = ImageWindow.windowById('${viewId}').mainView;
    var img = v.image;
    JSON.stringify({ median: img.median(), mad: img.MAD(), min: img.minimum(), max: img.maximum() });
  `);
  try { return JSON.parse(r.outputs?.consoleOutput || '{}'); }
  catch { return { median: 0, mad: 0, min: 0, max: 0 }; }
}

// ============================================================================
// GHS (copied from pipeline)
// ============================================================================
function computeGHSCoefficients(orgD, B, SP, LP, HP) {
  const D = Math.exp(orgD) - 1.0;
  if (D === 0) return null;
  let a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,q0,qwp,qlp,q1,q;
  if (B === -1) {
    qlp = -Math.log(1+D*(SP-LP)); q0 = qlp - D*LP/(1+D*(SP-LP));
    qwp = Math.log(1+D*(HP-SP)); q1 = qwp + D*(1-HP)/(1+D*(HP-SP));
    q = 1/(q1-q0);
    a1=0; b1=D/(1+D*(SP-LP))*q;
    a2=-q0*q; b2=-q; c2=1+D*SP; d2=-D; e2=0;
    a3=-q0*q; b3=q; c3=1-D*SP; d3=D; e3=0;
    a4=(qwp-q0-D*HP/(1+D*(HP-SP)))*q; b4=q*D/(1+D*(HP-SP));
    return {type:'log',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  if (B === 0) {
    qlp = Math.exp(-D*(SP-LP)); q0 = qlp - D*LP*Math.exp(-D*(SP-LP));
    qwp = 2 - Math.exp(-D*(HP-SP)); q1 = qwp + D*(1-HP)*Math.exp(-D*(HP-SP));
    q = 1/(q1-q0);
    a1=0; b1=D*Math.exp(-D*(SP-LP))*q;
    a2=-q0*q; b2=q; c2=-D*SP; d2=D; e2=0;
    a3=(2-q0)*q; b3=-q; c3=D*SP; d3=-D; e3=0;
    a4=(qwp-q0-D*HP*Math.exp(-D*(HP-SP)))*q; b4=D*Math.exp(-D*(HP-SP))*q;
    return {type:'exp',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  if (B < 0) {
    const aB = -B;
    qlp = (1-Math.pow(1+D*aB*(SP-LP),(aB-1)/aB))/(aB-1);
    q0 = qlp - D*LP*Math.pow(1+D*aB*(SP-LP),-1/aB);
    qwp = (Math.pow(1+D*aB*(HP-SP),(aB-1)/aB)-1)/(aB-1);
    q1 = qwp + D*(1-HP)*Math.pow(1+D*aB*(HP-SP),-1/aB);
    q = 1/(q1-q0);
    a1=0; b1=D*Math.pow(1+D*aB*(SP-LP),-1/aB)*q;
    a2=(1/(aB-1)-q0)*q; b2=-q/(aB-1); c2=1+D*aB*SP; d2=-D*aB; e2=(aB-1)/aB;
    a3=(-1/(aB-1)-q0)*q; b3=q/(aB-1); c3=1-D*aB*SP; d3=D*aB; e3=(aB-1)/aB;
    a4=(qwp-q0-D*HP*Math.pow(1+D*aB*(HP-SP),-1/aB))*q; b4=D*Math.pow(1+D*aB*(HP-SP),-1/aB)*q;
    return {type:'pow',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
  }
  qlp = Math.pow(1+D*B*(SP-LP),-1/B); q0 = qlp - D*LP*Math.pow(1+D*B*(SP-LP),-(1+B)/B);
  qwp = 2 - Math.pow(1+D*B*(HP-SP),-1/B); q1 = qwp + D*(1-HP)*Math.pow(1+D*B*(HP-SP),-(1+B)/B);
  q = 1/(q1-q0);
  a1=0; b1=D*Math.pow(1+D*B*(SP-LP),-(1+B)/B)*q;
  a2=-q0*q; b2=q; c2=1+D*B*SP; d2=-D*B; e2=-1/B;
  a3=(2-q0)*q; b3=-q; c3=1-D*B*SP; d3=D*B; e3=-1/B;
  a4=(qwp-q0-D*HP*Math.pow(1+D*B*(HP-SP),-(B+1)/B))*q; b4=D*Math.pow(1+D*B*(HP-SP),-(B+1)/B)*q;
  return {type:'pow',a1,b1,a2,b2,c2,d2,e2,a3,b3,c3,d3,e3,a4,b4,LP,SP,HP};
}

function n(v) {
  const s = v.toFixed(12).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
  return v < 0 ? `(${s})` : s;
}

function buildGHSExpr(c) {
  let e1,e2,e3,e4;
  if (c.type === 'log') {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*ln(${n(c.c2)}+${n(c.d2)}*$T)`;
    e3=`${n(c.a3)}+${n(c.b3)}*ln(${n(c.c3)}+${n(c.d3)}*$T)`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  } else if (c.type === 'exp') {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*exp(${n(c.c2)}+${n(c.d2)}*$T)`;
    e3=`${n(c.a3)}+${n(c.b3)}*exp(${n(c.c3)}+${n(c.d3)}*$T)`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  } else {
    e1=`${n(c.a1)}+${n(c.b1)}*$T`; e2=`${n(c.a2)}+${n(c.b2)}*exp(${n(c.e2)}*ln(${n(c.c2)}+${n(c.d2)}*$T))`;
    e3=`${n(c.a3)}+${n(c.b3)}*exp(${n(c.e3)}*ln(${n(c.c3)}+${n(c.d3)}*$T))`; e4=`${n(c.a4)}+${n(c.b4)}*$T`;
  }
  let result = e3;
  if (c.HP < 1.0) result = `iif($T<${n(c.HP)},${e3},${e4})`;
  if (c.LP < c.SP) result = `iif($T<${n(c.SP)},${e2},${result})`;
  if (c.LP > 0.0) result = `iif($T<${n(c.LP)},${e1},${result})`;
  return result;
}

function ghsPixelMath(viewId, D, B, SP, LP, HP) {
  if (HP <= SP || LP >= SP) return null;
  const c = computeGHSCoefficients(D, B, SP, LP, HP);
  if (!c) return null;
  const expr = buildGHSExpr(c);
  if (expr.includes('NaN') || expr.includes('Infinity')) return null;
  return `
    var P = new PixelMath; P.expression = '${expr}'; P.useSingleExpression = true;
    P.createNewImage = false; P.use64BitWorkingImage = true;
    P.truncate = true; P.truncateLower = 0; P.truncateUpper = 1;
    P.executeOn(ImageWindow.windowById('${viewId}').mainView);
  `;
}

// ============================================================================
// Preview: save with auto-stretch (same as pipeline linear preview)
// ============================================================================
async function savePreviewAutoStretch(viewId, name) {
  const previewPath = path.join(PREVIEW_DIR, name + '.jpg');
  const r = await pjsr(`
    var srcW = ImageWindow.windowById('${viewId}');
    var src = srcW.mainView;
    var img = src.image;
    var w = img.width, h = img.height;
    var tmp = new ImageWindow(w, h, img.numberOfChannels, 32, false, img.isColor, 'preview_tmp');
    tmp.mainView.beginProcess();
    tmp.mainView.image.assign(img);
    tmp.mainView.endProcess();
    // Auto-stretch
    var timg = tmp.mainView.image;
    var med = timg.median(), mad = timg.MAD();
    var c0 = Math.max(0, med - 2.8 * mad);
    var x = (1 > c0) ? (med - c0) / (1 - c0) : 0.5;
    var tgt = 0.25;
    var m = (x <= 0 || x >= 1) ? 0.5 : x * (1 - tgt) / (x * (1 - 2*tgt) + tgt);
    var HT = new HistogramTransformation;
    HT.H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[c0,m,1,0,1],[0,0.5,1,0,1]];
    HT.executeOn(tmp.mainView);
    var dir = '${PREVIEW_DIR}';
    if (!File.directoryExists(dir)) File.createDirectory(dir, true);
    var p = '${previewPath}';
    if (File.exists(p)) File.remove(p);
    tmp.saveAs(p, false, false, false, false);
    tmp.forceClose();
    'OK';
  `);
  if (r.status === 'error') console.log('  Preview WARN: ' + r.result);
  else console.log(`  Preview saved: ${name}.jpg`);
}

// ============================================================================
// State management
// ============================================================================
function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  return { locked: {} };
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================================
// Commands
// ============================================================================
async function setup() {
  console.log('=== SETUP: Loading linear L, cropping, SXT ===');

  // Close all images
  await pjsr(`
    var wins = ImageWindow.windows;
    for (var i = 0; i < wins.length; i++) wins[i].forceClose();
  `);

  // Open L master
  console.log('  Opening L master...');
  await send('open_image', '__internal__', { filePath: L_ALIGNED });

  // Find the opened view
  const r = await pjsr(`
    var wins = ImageWindow.windows;
    var id = '';
    for (var i = 0; i < wins.length; i++) {
      if (wins[i].mainView.id.indexOf('crop_mask') < 0) id = wins[i].mainView.id;
    }
    // Close crop masks
    for (var i = 0; i < wins.length; i++) {
      if (wins[i].mainView.id.indexOf('crop_mask') >= 0) wins[i].forceClose();
    }
    id;
  `);
  const lId = r.result?.trim();
  console.log('  Loaded: ' + lId);

  // Rename to L_test
  await pjsr(`ImageWindow.windowById('${lId}').mainView.id = 'L_test';`);

  // Crop 15px edges
  console.log('  Cropping 15px edges...');
  await pjsr(`
    var w = ImageWindow.windowById('L_test');
    var img = w.mainView.image;
    var DC = new DynamicCrop;
    DC.centerX = 0.5; DC.centerY = 0.5; DC.width = img.width - 30; DC.height = img.height - 30;
    DC.scaleX = 1; DC.scaleY = 1; DC.angle = 0;
    DC.executeOn(w.mainView);
  `);

  // SXT (star removal)
  console.log('  Running SXT (star removal)...');
  const sxtR = await pjsr(`
    var SXT = new StarXTerminator;
    SXT.stars = true;
    SXT.unscreen = false;
    SXT.overlap = 0.10;
    SXT.executeOn(ImageWindow.windowById('L_test').mainView);
    'SXT done';
  `);
  console.log('  ' + (sxtR.status === 'error' ? 'WARN: ' + sxtR.result : sxtR.result));

  // Close star image
  await pjsr(`
    var wins = ImageWindow.windows;
    for (var i = 0; i < wins.length; i++) {
      if (wins[i].mainView.id !== 'L_test') wins[i].forceClose();
    }
  `);

  // Clone to L_baseline (this is our reset point)
  console.log('  Cloning to L_baseline...');
  await pjsr(`
    var srcW = ImageWindow.windowById('L_test');
    var img = srcW.mainView.image;
    var w = img.width, h = img.height;
    var bw = new ImageWindow(w, h, 1, 32, true, false, 'L_baseline');
    bw.mainView.beginProcess();
    bw.mainView.image.assign(img);
    bw.mainView.endProcess();
    bw.show();
    'Baseline: ' + w + 'x' + h;
  `);

  const st = await getStats('L_baseline');
  console.log(`  Baseline stats: median=${st.median.toFixed(6)} (${Math.round(st.median*65535)} ADU), max=${(st.max??0).toFixed(4)}`);
  await savePreviewAutoStretch('L_baseline', 'l_baseline');

  // Reset state
  saveState({ locked: {} });
  console.log('\n=== SETUP COMPLETE ===');
  console.log('  L_test = working copy (will be overwritten each test)');
  console.log('  L_baseline = pristine linear L (reset source)');
  console.log('  Now run: node scripts/test-ghs-l.mjs pass1 B=6');
}

async function testPass(passNum, B) {
  const state = loadState();
  const defaults = PASS_DEFAULTS[passNum];
  if (!defaults) { console.log('Invalid pass: ' + passNum); return; }

  console.log(`\n=== TESTING PASS ${passNum}: B=${B} (D=${defaults.D}, LP=${defaults.LP}, HP=${defaults.HP}) ===`);

  // Reset L_test from baseline
  await pjsr(`
    var srcW = ImageWindow.windowById('L_baseline');
    var dstW = ImageWindow.windowById('L_test');
    if (srcW.isNull) throw new Error('L_baseline not found — run setup first');
    if (dstW.isNull) throw new Error('L_test not found — run setup first');
    dstW.mainView.beginProcess();
    dstW.mainView.image.assign(srcW.mainView.image);
    dstW.mainView.endProcess();
    'Reset L_test from baseline';
  `);

  // Apply any locked earlier passes first
  for (let p = 1; p < passNum; p++) {
    const lockedB = state.locked[p];
    if (lockedB === undefined) {
      console.log(`  ERROR: Pass ${p} not locked yet. Lock it first with: lock${p} B=...`);
      return;
    }
    const pDef = PASS_DEFAULTS[p];
    const st = await getStats('L_test');
    const sp = st.median;
    console.log(`  Applying locked pass ${p}: B=${lockedB}, SP=${sp.toFixed(6)}`);
    const code = ghsPixelMath('L_test', pDef.D, lockedB, sp, pDef.LP, pDef.HP);
    if (!code) { console.log(`  WARN: Pass ${p} skipped (invalid params)`); continue; }
    await pjsr(code);
  }

  // Now apply the test pass
  const st = await getStats('L_test');
  const sp = st.median;
  console.log(`  Pre:  median=${st.median.toFixed(6)} (${Math.round(st.median*65535)} ADU), max=${(st.max??0).toFixed(4)}`);
  console.log(`  GHS:  D=${defaults.D}, B=${B}, SP=${sp.toFixed(6)}, LP=${defaults.LP}, HP=${defaults.HP}`);

  const code = ghsPixelMath('L_test', defaults.D, B, sp, defaults.LP, defaults.HP);
  if (!code) { console.log('  GHS skipped (invalid params)'); return; }
  const r = await pjsr(code);
  if (r.status === 'error') { console.log('  WARN: ' + r.result); return; }

  const stAfter = await getStats('L_test');
  console.log(`  Post: median=${stAfter.median.toFixed(6)} (${Math.round(stAfter.median*65535)} ADU), max=${(stAfter.max??0).toFixed(4)}`);

  // Save preview (auto-stretched for visibility)
  const tag = `l_pass${passNum}_B${B.toString().replace('.','_').replace('-','neg')}`;
  await savePreviewAutoStretch('L_test', tag);

  console.log(`\n  Result: ${tag}.jpg — check ~/.pixinsight-mcp/previews/`);
}

async function lockPass(passNum, B) {
  const state = loadState();
  state.locked[passNum] = B;
  saveState(state);
  console.log(`\n=== LOCKED PASS ${passNum}: B=${B} ===`);

  // Apply all locked passes to L_test for the next round
  await pjsr(`
    var srcW = ImageWindow.windowById('L_baseline');
    var dstW = ImageWindow.windowById('L_test');
    dstW.mainView.beginProcess();
    dstW.mainView.image.assign(srcW.mainView.image);
    dstW.mainView.endProcess();
  `);

  for (let p = 1; p <= passNum; p++) {
    const lockedB = state.locked[p];
    if (lockedB === undefined) continue;
    const pDef = PASS_DEFAULTS[p];
    const st = await getStats('L_test');
    const sp = st.median;
    console.log(`  Applying pass ${p}: B=${lockedB}, SP=${sp.toFixed(6)}`);
    const code = ghsPixelMath('L_test', pDef.D, lockedB, sp, pDef.LP, pDef.HP);
    if (code) await pjsr(code);
    const stA = await getStats('L_test');
    console.log(`    → median=${stA.median.toFixed(6)} (${Math.round(stA.median*65535)} ADU), max=${(stA.max??0).toFixed(4)}`);
  }

  const stFinal = await getStats('L_test');
  console.log(`\n  L_test now has passes 1-${passNum} applied.`);
  console.log(`  Stats: median=${stFinal.median.toFixed(6)} (${Math.round(stFinal.median*65535)} ADU), max=${(stFinal.max??0).toFixed(4)}`);
  await savePreviewAutoStretch('L_test', `l_locked_p${passNum}`);
}

// ============================================================================
// Main
// ============================================================================
const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd) {
  console.log('Usage:');
  console.log('  setup              — load L, crop, SXT, create baseline');
  console.log('  pass1 B=6          — test pass 1 with B=6');
  console.log('  pass2 B=5          — test pass 2 with B=5');
  console.log('  pass3 B=-1         — test pass 3 with B=-1');
  console.log('  lock1 B=7.5        — lock pass 1, apply it');
  console.log('  lock2 B=5          — lock pass 2');
  console.log('  lock3 B=-1         — lock pass 3');
  process.exit(0);
}

// Parse B=value from args
function parseB() {
  const bArg = args.find(a => a.startsWith('B='));
  if (!bArg) { console.log('Missing B= argument'); process.exit(1); }
  return parseFloat(bArg.split('=')[1]);
}

(async () => {
  try {
    if (cmd === 'setup') {
      await setup();
    } else if (cmd.startsWith('pass')) {
      const passNum = parseInt(cmd.replace('pass', ''));
      await testPass(passNum, parseB());
    } else if (cmd.startsWith('lock')) {
      const passNum = parseInt(cmd.replace('lock', ''));
      await lockPass(passNum, parseB());
    } else {
      console.log('Unknown command: ' + cmd);
    }
  } catch (e) {
    console.error('ERROR: ' + e.message);
  }
})();
