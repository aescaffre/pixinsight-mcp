import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(os.homedir(), '.pixinsight-mcp', 'pipeline-config.json');
const DEFAULT_CONFIG = path.join(__dirname, 'default-config.json');
const PREVIEW_DIR = path.join(os.homedir(), '.pixinsight-mcp', 'previews');
const CHECKPOINT_DIR = path.join(os.homedir(), '.pixinsight-mcp', 'checkpoints');
const PORT = 3847;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) return fs.readFileSync(CONFIG_PATH, 'utf-8');
  return fs.readFileSync(DEFAULT_CONFIG, 'utf-8');
}

function saveConfig(json) {
  ensureDir(CONFIG_PATH);
  fs.writeFileSync(CONFIG_PATH, json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

let runningProcess = null;
let runOutput = '';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Serve index.html
  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Load config
  if (req.method === 'GET' && url.pathname === '/api/config') {
    try {
      const json = loadConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(json);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Save config
  if (req.method === 'POST' && url.pathname === '/api/config') {
    try {
      const body = await readBody(req);
      JSON.parse(body); // validate JSON
      saveConfig(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: CONFIG_PATH }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Run pipeline
  if (req.method === 'POST' && url.pathname === '/api/run') {
    if (runningProcess) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Pipeline already running' }));
      return;
    }
    const script = path.join(__dirname, '..', 'scripts', 'run-pipeline.mjs');
    runOutput = '';
    const args = [script, '--config', CONFIG_PATH];

    // Parse optional restartFrom from request body
    try {
      const body = await readBody(req);
      if (body) {
        const parsed = JSON.parse(body);
        if (parsed.restartFrom) {
          args.push('--restart-from', parsed.restartFrom);
        }
      }
    } catch (e) { /* no body or invalid JSON — run normally */ }

    runningProcess = spawn('node', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    runningProcess.stdout.on('data', d => { runOutput += d.toString(); });
    runningProcess.stderr.on('data', d => { runOutput += d.toString(); });
    runningProcess.on('close', code => {
      runOutput += `\n--- Pipeline exited with code ${code} ---\n`;
      runningProcess = null;
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Pipeline started' }));
    return;
  }

  // Pipeline status / output
  if (req.method === 'GET' && url.pathname === '/api/run') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      running: runningProcess !== null,
      output: runOutput
    }));
    return;
  }

  // Stop pipeline
  if (req.method === 'DELETE' && url.pathname === '/api/run') {
    if (runningProcess) {
      runningProcess.kill('SIGTERM');
      runOutput += '\n--- Pipeline stopped by user ---\n';
      runningProcess = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Serve preview image
  if (req.method === 'GET' && url.pathname.startsWith('/api/preview/')) {
    const stepId = url.pathname.slice('/api/preview/'.length).replace(/[^a-z0-9_]/g, '');
    const imgPath = path.join(PREVIEW_DIR, stepId + '.jpg');
    if (fs.existsSync(imgPath)) {
      const stat = fs.statSync(imgPath);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(imgPath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No preview for ' + stepId }));
    }
    return;
  }

  // List available previews
  if (req.method === 'GET' && url.pathname === '/api/previews') {
    try {
      if (!fs.existsSync(PREVIEW_DIR)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ previews: {} }));
        return;
      }
      const files = fs.readdirSync(PREVIEW_DIR).filter(f => f.endsWith('.jpg'));
      const previews = {};
      for (const f of files) {
        const id = f.replace('.jpg', '');
        const stat = fs.statSync(path.join(PREVIEW_DIR, f));
        previews[id] = { mtime: stat.mtimeMs };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ previews }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Reset config to defaults
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    try {
      const json = fs.readFileSync(DEFAULT_CONFIG, 'utf-8');
      saveConfig(json);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(json);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // List checkpoints
  if (req.method === 'GET' && url.pathname === '/api/checkpoints') {
    try {
      const checkpoints = {};
      if (fs.existsSync(CHECKPOINT_DIR)) {
        const files = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json'));
        for (const f of files) {
          try {
            const manifest = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, f), 'utf-8'));
            checkpoints[manifest.stepId] = {
              timestamp: manifest.timestamp,
              branches: Object.keys(manifest.images)
            };
          } catch (e) { /* skip malformed */ }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ checkpoints }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Clear checkpoints
  if (req.method === 'DELETE' && url.pathname === '/api/checkpoints') {
    try {
      if (fs.existsSync(CHECKPOINT_DIR)) {
        const files = fs.readdirSync(CHECKPOINT_DIR);
        for (const f of files) {
          fs.unlinkSync(path.join(CHECKPOINT_DIR, f));
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Scan folder for XISF/FITS files and auto-detect channels
  if (req.method === 'GET' && url.pathname === '/api/scan-folder') {
    const folderPath = url.searchParams.get('path');
    if (!folderPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }
    try {
      if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not a valid directory: ' + folderPath }));
        return;
      }
      const allFiles = fs.readdirSync(folderPath)
        .filter(f => /\.(xisf|fits|fit)$/i.test(f))
        .sort();
      const assignments = { L: '', R: '', G: '', B: '', Ha: '' };
      const patterns = {
        Ha: /(?:FILTER[-_]?Ha|[-_]Ha[-_.]|^Ha[-_.])/i,
        L:  /(?:FILTER[-_]?L\b|[-_]L[-_.]|^L[-_.])/i,
        R:  /(?:FILTER[-_]?R\b|[-_]R[-_.]|^R[-_.])/i,
        G:  /(?:FILTER[-_]?G\b|[-_]G[-_.]|^G[-_.])/i,
        B:  /(?:FILTER[-_]?B\b|[-_]B[-_.]|^B[-_.])/i,
      };
      // Ha first to avoid matching H in other patterns
      for (const channel of ['Ha', 'L', 'R', 'G', 'B']) {
        for (const f of allFiles) {
          if (patterns[channel].test(f)) {
            assignments[channel] = path.join(folderPath, f);
            break;
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ totalFiles: allFiles.length, files: allFiles, assignments }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Pipeline Editor running at http://localhost:${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
});
