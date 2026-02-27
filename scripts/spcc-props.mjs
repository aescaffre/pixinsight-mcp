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
      att++; if (att > 60) { clearInterval(poll); reject(new Error('Timeout')); }
    }, 500);
  });
}
const r = await send('run_script', '__script__', { code: `
  var P = new SpectrophotometricColorCalibration;
  var props = [];
  for (var key in P) {
    if (typeof P[key] !== 'function') {
      var val = P[key];
      var t = typeof val;
      if (t === 'object' && val !== null) {
        try { val = JSON.stringify(val); } catch(e) { val = '[object]'; }
      }
      props.push(key + ' (' + t + ') = ' + String(val));
    }
  }
  props.join('\\n');
` });
console.log(r.outputs?.consoleOutput || r.error?.message || 'no output');
