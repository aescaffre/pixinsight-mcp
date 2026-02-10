import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
const home = os.homedir();
const id = crypto.randomUUID();
const cmd = { id, timestamp: new Date().toISOString(), tool: 'list_open_images', process: '__internal__', parameters: {} };
fs.writeFileSync(path.join(home, '.pixinsight-mcp/bridge/commands', id + '.json'), JSON.stringify(cmd));
console.log('Command sent:', id);
let att = 0;
const poll = setInterval(() => {
  const rp = path.join(home, '.pixinsight-mcp/bridge/results', id + '.json');
  if (fs.existsSync(rp)) {
    const r = JSON.parse(fs.readFileSync(rp, 'utf-8'));
    if (r.status === 'running') return;
    clearInterval(poll);
    fs.unlinkSync(rp);
    console.log('Watcher alive! Status:', r.status);
    console.log('Images:', JSON.stringify(r.outputs?.images?.map(i => i.id) || []));
    process.exit(0);
  }
  att++;
  if (att > 20) { clearInterval(poll); console.log('TIMEOUT - watcher not responding'); process.exit(1); }
}, 500);
