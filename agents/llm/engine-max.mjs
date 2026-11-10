// ============================================================================
// Claude Max Engine: uses `claude -p` subprocess instead of API
// Zero cost — runs on Max subscription via Claude Code
//
// Each agent = one `claude -p` subprocess that:
// 1. Gets the system prompt via --append-system-prompt
// 2. Gets the task prompt (with stats, image file paths) as the main prompt
// 3. Has access to custom MCP tools (PixInsight operations)
// 4. Claude Code handles the tool loop automatically
// 5. Returns JSON result
// ============================================================================
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { buildToolSet } from './tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, 'mcp-agent-tools.mjs');

const CLAUDE_BIN = process.env.PIX_CLAUDE_BIN || 'claude';

// Probe once per process whether the CLI supports --append-system-prompt-file.
let _promptFileFlagSupported = null;
function supportsPromptFileFlag() {
  if (_promptFileFlagSupported !== null) return _promptFileFlagSupported;
  try {
    const r = spawnSync(CLAUDE_BIN, ['--help'], { encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    const txt = (r.stdout || '') + (r.stderr || '');
    _promptFileFlagSupported = /append-system-prompt-file|append-system-prompt\[-file\]/.test(txt);
  } catch { _promptFileFlagSupported = false; }
  return _promptFileFlagSupported;
}

/**
 * MaxAgent — runs a Claude Code subprocess for each agent.
 * Uses the user's Max subscription. No API key needed.
 *
 * The tool loop is handled automatically by Claude Code.
 * Custom tools are provided via MCP server configuration.
 */
export class MaxAgent {
  /**
   * @param {string} name - Display name for logging
   * @param {object} opts
   * @param {string} opts.systemPrompt - Full system prompt (appended via --append-system-prompt)
   * @param {string} opts.agentName - Agent name for tool set selection (e.g. 'rgb_cleanliness')
   * @param {number} opts.maxTurns - Max agentic turns (mapped to --max-budget-usd as proxy)
   * @param {ArtifactStore} opts.store - Artifact store (for save_variant, etc.)
   * @param {object} opts.brief - Processing brief
   * @param {string} opts.model - Model name (optional, e.g. 'sonnet', 'opus')
   */
  constructor(name, opts) {
    this.name = name;
    this.systemPrompt = opts.systemPrompt;
    this.agentName = opts.agentName || name;
    this.maxTurns = opts.maxTurns ?? opts.budget?.maxTurns ?? 30;
    this.store = opts.store;
    this.brief = opts.brief;
    this.model = opts.model;
    this.effort = opts.effort;
    this.fallbackModel = opts.fallbackModel;
    this.timeoutMs = opts.timeoutMs ?? 120 * 60 * 1000;
    this.extraArgs = opts.extraArgs || [];   // WI-07b: e.g. ['--resume', sessionId]
    this.cwd = opts.cwd || process.cwd();
    this.extraEnv = opts.env || {};
    const KNOWN_OPTS = new Set(['extraArgs', 'cwd', 'env', 'systemPrompt', 'agentName', 'maxTurns', 'budget', 'store', 'brief', 'model', 'effort', 'fallbackModel', 'timeoutMs']);
    for (const k of Object.keys(opts)) {
      if (!KNOWN_OPTS.has(k)) console.warn(`  [${name}][max] WARNING: unknown MaxAgent option "${k}" is ignored`);
    }
    this.startTime = null;
    this.finishResult = null;

    // Build the allowed tools list from the agent's tool set
    const toolSet = buildToolSet(this.agentName, [], { brief: this.brief });   // same data-aware list as the MCP server
    this._toolNames = toolSet.definitions.map(d => d.name);
  }

  /**
   * Run the agent via claude CLI subprocess.
   * @param {string|Array} prompt - The task prompt (text string, or content array — images should be file paths in text)
   * @param {string[]} imagePaths - Optional image file paths to include in prompt text
   * @returns {{ finishResult: object|null, transcript: Array, turnCount: number, elapsedMs: number, crashError?: object }}
   */
  async run(prompt, imagePaths = []) {
    this.startTime = Date.now();
    this._log(`Starting (maxTurns=${this.maxTurns})`);

    // Flatten prompt to text
    let promptText;
    if (typeof prompt === 'string') {
      promptText = prompt;
    } else if (Array.isArray(prompt)) {
      // Content array format — extract text blocks, skip image blocks
      promptText = prompt
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    } else {
      promptText = String(prompt);
    }

    // Append image file paths if provided
    if (imagePaths.length > 0) {
      promptText += '\n\n### Preview images saved to disk\n';
      promptText += 'Use the Read tool to view any of these images:\n';
      imagePaths.forEach((p, i) => {
        promptText += `${i + 1}. ${p}\n`;
      });
    }

    // Generate MCP config JSON file dynamically
    const mcpConfigPath = this._writeMcpConfig();

    // Build the allowed tools list for --allowedTools
    // Include all MCP tools (prefixed with mcp__pixinsight__) + Read (for viewing images)
    const allowedTools = [
      ...this._toolNames.map(t => `mcp__pixinsight__${t}`),
      'Read',  // For viewing preview images
    ];

    // Build claude CLI args
    // --strict-mcp-config: only use our MCP server
    // --bypassPermissions: auto-approve all tool calls
    // No --bare: allows OAuth/Max subscription auth (--bare requires API key which has no credits)
    // Strip ANTHROPIC_API_KEY: forces OAuth flow instead of API billing
    const args = [
      '-p', promptText,
      '--output-format', 'json',
      '--mcp-config', mcpConfigPath,
      '--strict-mcp-config',
      '--allowedTools', allowedTools.join(','),
      // CONTAINMENT (2026-10-29): under bypassPermissions, --allowedTools does NOT remove the
      // CLI's built-in tools. The gradient agent used Bash/Edit/Write to modify pipeline
      // source, skill docs and the user's memory mid-run and ran its own PJSR probe that
      // crashed PixInsight. Processing agents get MCP tools + Read only.
      '--disallowedTools', ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'TodoWrite', 'KillShell', 'BashOutput'].join(','),
      '--permission-mode', 'bypassPermissions',
    ];

    // System prompt: file when the CLI supports it (keeps argv small), else inline argv.
    let promptFile = null;
    if (supportsPromptFileFlag() && this.store?.baseDir) {
      try {
        const pdir = path.join(this.store.baseDir, 'prompts');
        fs.mkdirSync(pdir, { recursive: true });
        promptFile = path.join(pdir, `system-${this.agentName}-${Date.now()}.md`);
        fs.writeFileSync(promptFile, this.systemPrompt || '');
        args.push('--append-system-prompt-file', promptFile);
      } catch { promptFile = null; }
    }
    if (!promptFile) args.push('--append-system-prompt', this.systemPrompt);

    if (this.model && this.model !== 'inherit') args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.fallbackModel) args.push('--fallback-model', this.fallbackModel);
    // Outer safety net only: CLI turns count text/Read/blocked turns too.
    args.push('--max-turns', String(Math.ceil(this.maxTurns * 1.5)));
    // WI-07b: known session id (even if stdout is truncated). A --resume run keeps the resumed id.
    const resumeIdx = this.extraArgs.indexOf('--resume');
    this.sessionId = resumeIdx >= 0 ? this.extraArgs[resumeIdx + 1] : crypto.randomUUID();
    if (resumeIdx < 0) args.push('--session-id', this.sessionId);
    args.push(...this.extraArgs);
    this._args = args;
    this._promptHash = crypto.createHash('sha256').update(this.systemPrompt || '').digest('hex').slice(0, 16);

    this._log(`Spawning claude subprocess (${this._toolNames.length} MCP tools)...`);

    return new Promise((resolve, reject) => {
      const spawnEnv = { ...process.env, ...this.extraEnv };
      delete spawnEnv.ANTHROPIC_API_KEY;  // Force OAuth/Max subscription auth
      this._log(`[DEBUG] Args count: ${args.length}, system prompt length: ${this.systemPrompt?.length}`);
      // stdin ignored: avoids the 3 s "no stdin data" stall of claude -p.
      const claude = spawn(CLAUDE_BIN, args, {
        cwd: this.cwd,
        env: spawnEnv,
        timeout: this.timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      // WI-07b: the MCP server writes <store.baseDir>/CRASH.json when the PI process dies. Poll it and kill the CLI.
      const crashFile = this.store?.baseDir ? path.join(this.store.baseDir, 'CRASH.json') : null;
      let killedForCrash = false;
      const crashPoll = crashFile ? setInterval(() => {
        if (!killedForCrash && fs.existsSync(crashFile)) {
          killedForCrash = true;
          this._log('!!! CRASH.json detected - PixInsight crashed; sending SIGTERM to the agent');
          try { claude.kill('SIGTERM'); } catch {}
        }
      }, 10_000) : null;

      claude.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      claude.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) this._log(`[stderr] ${line.slice(0, 300)}`);
        stderr += data.toString();
      });

      claude.on('close', (code, signal) => {
        if (crashPoll) clearInterval(crashPoll);
        const elapsed = Date.now() - this.startTime;
        this._log(`Completed in ${Math.round(elapsed / 1000)}s (exit ${code})`);

        // Debug: log raw output on failure
        if (code !== 0) {
          this._log(`[DEBUG] stdout (first 500): ${stdout.slice(0, 500)}`);
          this._log(`[DEBUG] stderr (first 500): ${stderr.slice(0, 500)}`);
        }

        // Keep MCP config for debugging
        this._log(`[DEBUG] MCP config: ${mcpConfigPath}`);
        // try { fs.unlinkSync(mcpConfigPath); } catch {}

        // WI-07b: crash = CRASH.json written by the MCP producer (no stderr-string heuristic)
        let crashError = null;
        if (crashFile && fs.existsSync(crashFile)) {
          let info = {};
          try { info = JSON.parse(fs.readFileSync(crashFile, 'utf-8')); } catch {}
          crashError = { isCrash: true, message: `PixInsight crashed during ${this.name}${info.tool ? ` (tool ${info.tool})` : ''}: ${info.message || ''}`.trim(), info };
        }

        // Parse JSON output
        let result;
        try {
          result = JSON.parse(stdout);
        } catch {
          result = { result: stdout, parseError: true };
        }

        // Extract the result text
        const resultText = result?.result || stdout;

        // Extract finish info from the result
        this.finishResult = this._parseFinishResult(resultText);

        const timedOut = signal === 'SIGTERM' && elapsed >= this.timeoutMs - 5000;
        const maxTurnsHit = result?.subtype === 'error_max_turns';
        if (timedOut) this._log(`!!! AGENT TIMED OUT after ${Math.round(elapsed / 1000)}s`);
        if (maxTurnsHit) this._log('!!! AGENT HIT CLI MAX-TURNS');

        // WI-07b: persist session info on every close
        try {
          if (this.store?.baseDir) {
            const adir = path.join(this.store.baseDir, 'agents');
            fs.mkdirSync(adir, { recursive: true });
            fs.writeFileSync(path.join(adir, `${this.agentName}.json`), JSON.stringify({
              sessionId: result?.session_id || this.sessionId, model: this.model || 'inherit',
              num_turns: result?.num_turns ?? null, elapsedMs: elapsed, usage: result?.usage ?? null,
              promptHash: this._promptHash, cwd: this.cwd, crashed: !!crashError, exitCode: code, signal,
            }, null, 2));
          }
        } catch (e) { this._log(`agent session record skipped: ${e.message}`); }

        resolve({
          finishResult: this.finishResult,
          crashError,
          timedOut,
          maxTurnsHit,
          exitCode: code,
          signal,
          transcript: [{ role: 'assistant', type: 'text', content: resultText }],
          turnCount: result?.num_turns || 0,
          elapsedMs: elapsed,
          sessionId: result?.session_id || this.sessionId,
          usage: result?.usage,
          model: this.model || 'inherit',
          effort: this.effort,
          actualModels: Object.keys(result?.modelUsage || {}),
          modelUsage: result?.modelUsage,
          num_turns: result?.num_turns,
          duration_ms: result?.duration_ms,
          subtype: result?.subtype,
          is_error: result?.is_error,
        });
      });

      claude.on('error', (err) => {
        if (crashPoll) clearInterval(crashPoll);
        // Clean up temp MCP config on error
        try { fs.unlinkSync(mcpConfigPath); } catch {}
        reject(err);
      });
    });
  }

  /**
   * Write a temporary MCP config JSON file for this agent.
   * Points to mcp-agent-tools.mjs with the correct agent name, store path, and brief path.
   * @returns {string} Path to the generated config file
   */
  _writeMcpConfig() {
    const tmpDir = path.join(os.homedir(), '.pixinsight-mcp', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });

    const configPath = path.join(tmpDir, `mcp-config-${this.name}-${Date.now()}.json`);

    // Build args for the MCP server process
    const serverArgs = [MCP_SERVER_PATH, this.agentName];

    // Add store base dir if available
    if (this.store?.baseDir) {
      serverArgs.push(this.store.baseDir);
    } else {
      serverArgs.push('');
    }

    // argv[5] = maxTurns (MCP-side turn gate), argv[6] = model — pushed after brief path below
    // Write brief to a temp file and pass path
    if (this.brief) {
      const briefPath = path.join(tmpDir, `brief-${this.name}-${Date.now()}.json`);
      fs.writeFileSync(briefPath, JSON.stringify(this.brief, null, 2));
      serverArgs.push(briefPath);
      // Schedule cleanup (brief file is small, cleanup is best-effort)
      this._briefPath = briefPath;
    } else {
      serverArgs.push('');
    }

    serverArgs.push(String(this.maxTurns), this.model || '');

    const config = {
      mcpServers: {
        pixinsight: {
          command: 'node',
          args: serverArgs,
        }
      }
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  /**
   * WI-25: stub. The <<FINISH_VIEW_ID>> marker no longer exists; the finish
   * result is read from the artifact store (final-selection), not the CLI text.
   */
  _parseFinishResult(_text) {
    return null;
  }

  getTranscript() { return []; }
  getFinishResult() { return this.finishResult; }

  _log(msg) {
    const elapsed = this.startTime ? `${Math.round((Date.now() - this.startTime) / 1000)}s` : '0s';
    console.log(`  [${this.name}][max][${elapsed}] ${msg}`);
  }
}
