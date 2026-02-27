import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';

const home = os.homedir();
const cmdDir = path.join(home, '.pixinsight-mcp/bridge/commands');
const resDir = path.join(home, '.pixinsight-mcp/bridge/results');

function send(tool, proc, params) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cmd = { id, timestamp: new Date().toISOString(), tool, process: proc, parameters: params };
    fs.writeFileSync(path.join(cmdDir, id + '.json'), JSON.stringify(cmd));
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
        } catch(e) {}
      }
      att++; if (att > 120) { clearInterval(poll); reject(new Error('Timeout')); }
    }, 500);
  });
}
function pjsr(code) { return send('run_script', '__script__', { code }); }

async function test(label, code) {
  console.log(`\n=== TEST: ${label} ===`);
  const r = await pjsr(code);
  if (r.status === 'error') console.log('  ERROR:', r.error.message);
  else console.log('  OK:', r.outputs?.consoleOutput || '(no output)');
  return r;
}

async function run() {
  // Step 1: Read default SPCC curve format to understand the expected format
  await test('Read default SPCC filter curves format', `
    var P = new SpectrophotometricColorCalibration;
    var info = [];
    info.push('redFilterName: ' + P.redFilterName);
    info.push('redFilterTrCurve length: ' + P.redFilterTrCurve.length);
    info.push('redFilterTrCurve first 200 chars: ' + P.redFilterTrCurve.substring(0, 200));
    info.push('---');
    info.push('deviceQECurveName: ' + P.deviceQECurveName);
    info.push('deviceQECurve length: ' + P.deviceQECurve.length);
    info.push('deviceQECurve first 200 chars: ' + P.deviceQECurve.substring(0, 200));
    info.push('---');
    info.push('whiteReferenceName: ' + P.whiteReferenceName);
    info.push('whiteReferenceSpectrum length: ' + P.whiteReferenceSpectrum.length);
    info.push('whiteReferenceSpectrum first 200 chars: ' + P.whiteReferenceSpectrum.substring(0, 200));
    info.join('\\n');
  `);

  // Step 2: Read the FULL default red filter curve to see exact format
  await test('Full default red filter curve', `
    var P = new SpectrophotometricColorCalibration;
    P.redFilterTrCurve;
  `);

  // Step 3: Read the FULL default QE curve
  await test('Full default QE curve', `
    var P = new SpectrophotometricColorCalibration;
    P.deviceQECurve;
  `);

  // Step 4: Try setting a curve with comma-separated format and read back
  await test('Set red curve (comma-sep) and read back', `
    var P = new SpectrophotometricColorCalibration;
    P.redFilterTrCurve = '586,0.003\\n588,0.006\\n590,0.01';
    P.redFilterName = 'Test';
    'Set OK, readback: ' + P.redFilterTrCurve.substring(0, 100);
  `);

  // Step 5: Try tab-separated format
  await test('Set red curve (tab-sep) and read back', `
    var P = new SpectrophotometricColorCalibration;
    P.redFilterTrCurve = '586\\t0.003\\n588\\t0.006\\n590\\t0.01';
    P.redFilterName = 'Test Tab';
    'Set OK, readback: ' + P.redFilterTrCurve.substring(0, 100);
  `);

  // Step 6: Try space-separated format
  await test('Set red curve (space-sep) and read back', `
    var P = new SpectrophotometricColorCalibration;
    P.redFilterTrCurve = '586 0.003\\n588 0.006\\n590 0.01';
    P.redFilterName = 'Test Space';
    'Set OK, readback: ' + P.redFilterTrCurve.substring(0, 100);
  `);

  console.log('\n=== TESTS COMPLETE ===');
}

run().catch(e => console.error('FATAL:', e.message));
