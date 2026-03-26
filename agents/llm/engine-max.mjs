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
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { buildToolSet } from './tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, 'mcp-agent-tools.mjs');

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
    this.startTime = null;
    this.finishResult = null;

    // Build the allowed tools list from the agent's tool set
    const toolSet = buildToolSet(this.agentName);
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
      '--append-system-prompt', this.systemPrompt,
      '--mcp-config', mcpConfigPath,
      '--strict-mcp-config',
      '--allowedTools', allowedTools.join(','),
      '--permission-mode', 'bypassPermissions',
    ];

    if (this.model) {
      args.push('--model', this.model);
    }

    this._log(`Spawning claude subprocess (${this._toolNames.length} MCP tools)...`);

    return new Promise((resolve, reject) => {
      const spawnEnv = { ...process.env };
      delete spawnEnv.ANTHROPIC_API_KEY;  // Force OAuth/Max subscription auth
      this._log(`[DEBUG] Args count: ${args.length}, system prompt length: ${this.systemPrompt?.length}`);
      const claude = spawn('claude', args, {
        cwd: process.cwd(),
        env: spawnEnv,
        timeout: 120 * 60 * 1000, // 2 hour max for giga pipeline
      });

      let stdout = '';
      let stderr = '';

      claude.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      claude.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) this._log(`[stderr] ${line.slice(0, 300)}`);
        stderr += data.toString();
      });

      claude.on('close', (code) => {
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

        // Detect PixInsight crash from stderr
        let crashError = null;
        if (stderr.includes('BRIDGE_CRASH') || stderr.includes('PixInsight crashed') ||
            stderr.includes('bridge timeout') || code === 77) {
          crashError = { isCrash: true, message: `PixInsight bridge crash detected during ${this.name}` };
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

        resolve({
          finishResult: this.finishResult,
          crashError,
          transcript: [{ role: 'assistant', type: 'text', content: resultText }],
          turnCount: result?.num_turns || 0,
          elapsedMs: elapsed,
          sessionId: result?.session_id,
          usage: result?.usage,
        });
      });

      claude.on('error', (err) => {
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
   * Parse the result text to extract finish/scoring information.
   * Claude Code agents call the `finish` or `submit_scores` MCP tools,
   * and the result text will contain the tool output.
   */
  _parseFinishResult(text) {
    if (!text) return null;

    // Look for finish tool output pattern: "Finished. Best: <view_id>"
    const finishMatch = text.match(/Finished\.\s*Best:\s*(\w+)/);
    if (finishMatch) {
      const viewId = finishMatch[1];
      // Extract rationale if present
      const rationaleMatch = text.match(/Rationale:\s*(.+?)(?:\n|$)/);
      return {
        type: 'finish',
        view_id: viewId,
        rationale: rationaleMatch?.[1] || text.slice(0, 500),
      };
    }

    // Look for view_id patterns in various forms
    const viewMatch = text.match(/view[_\s]?id[:\s]+['"`]?(\w+)/i) ||
                     text.match(/best result[:\s]+['"`]?(\w+)/i) ||
                     text.match(/\bfinish\b.*?['"`](\w+)['"`]/i);
    if (viewMatch) {
      return {
        type: 'finish',
        view_id: viewMatch[1],
        rationale: text.slice(0, 500),
      };
    }

    // Look for submit_scores output (critic agents)
    const verdictMatch = text.match(/Verdict:\s*(accept|reject)/i);
    if (verdictMatch) {
      const feedbackMatch = text.match(/feedback[:\s]+['"]*(.+?)['"]*(?:\n|$)/i);
      return {
        type: 'scores',
        verdict: verdictMatch[1].toLowerCase(),
        feedback: feedbackMatch?.[1] || '',
      };
    }

    // Fallback: return raw text
    return {
      type: 'finish',
      view_id: this._extractViewId(text),
      rationale: text.slice(0, 500),
    };
  }

  /**
   * Try to extract a PixInsight view ID from the result text.
   */
  _extractViewId(text) {
    const match = text.match(/view[_\s]?id[:\s]+['"`]?(\w+)/i) ||
                  text.match(/finish.*['"`](\w+)['"`]/i) ||
                  text.match(/best result[:\s]+['"`]?(\w+)/i);
    return match?.[1] || null;
  }

  getTranscript() { return []; }
  getFinishResult() { return this.finishResult; }

  _log(msg) {
    const elapsed = this.startTime ? `${Math.round((Date.now() - this.startTime) / 1000)}s` : '0s';
    console.log(`  [${this.name}][max][${elapsed}] ${msg}`);
  }
}
