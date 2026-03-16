// ============================================================================
// LLM Agent Engine: conversation loop with tool use + vision
// Supports Anthropic (Claude) and Google (Gemini) providers.
// ============================================================================
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import crypto from 'crypto';
import { BridgeCrashError } from '../ops/bridge.mjs';

const DEFAULT_MODEL = 'gemini-2.5-pro';

// ============================================================================
// Provider abstraction
// ============================================================================

/**
 * Anthropic provider — Claude models via @anthropic-ai/sdk.
 */
class AnthropicProvider {
  constructor() {
    this.client = new Anthropic();
  }

  async call(model, systemPrompt, tools, messages, maxTokens) {
    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools,
      messages,
    });
    return this._normalize(response);
  }

  _normalize(response) {
    const toolCalls = [];
    const textBlocks = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      } else if (block.type === 'text') {
        textBlocks.push(block.text);
      }
    }
    return { toolCalls, textBlocks, stopReason: response.stop_reason, raw: response };
  }

  buildMessages(messages) {
    return messages; // Anthropic format is our canonical format
  }

  buildToolResult(toolUseId, content) {
    return { type: 'tool_result', tool_use_id: toolUseId, content };
  }

  formatToolDefs(definitions) {
    return definitions; // Already in Anthropic format
  }
}

/**
 * Google provider — Gemini models via @google/generative-ai.
 */
class GoogleProvider {
  constructor() {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY environment variable required');
    this.genai = new GoogleGenerativeAI(apiKey);
  }

  async call(model, systemPrompt, tools, messages, maxTokens) {
    const genModel = this.genai.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
      tools: tools.length > 0 ? [{ functionDeclarations: this._convertTools(tools) }] : undefined,
      generationConfig: { maxOutputTokens: maxTokens },
    });

    // Convert message history to Gemini format
    const geminiHistory = this._convertHistory(messages.slice(0, -1));
    const lastMessage = messages[messages.length - 1];
    const lastParts = this._convertContent(lastMessage.content);

    const chat = genModel.startChat({ history: geminiHistory });
    const result = await chat.sendMessage(lastParts);
    return this._normalize(result.response);
  }

  _convertTools(anthropicTools) {
    return anthropicTools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: this._convertSchema(t.input_schema),
    }));
  }

  _convertSchema(schema) {
    if (!schema) return { type: 'OBJECT', properties: {} };
    const converted = { type: this._mapType(schema.type) };
    if (schema.properties) {
      converted.properties = {};
      for (const [key, val] of Object.entries(schema.properties)) {
        converted.properties[key] = this._convertSchemaField(val);
      }
    }
    if (schema.required) converted.required = schema.required;
    if (schema.items) converted.items = this._convertSchemaField(schema.items);
    if (schema.enum) converted.enum = schema.enum;
    if (schema.description) converted.description = schema.description;
    return converted;
  }

  _convertSchemaField(field) {
    const out = { type: this._mapType(field.type) };
    if (field.description) out.description = field.description;
    if (field.enum) out.enum = field.enum;
    if (field.properties) {
      out.properties = {};
      for (const [k, v] of Object.entries(field.properties)) {
        out.properties[k] = this._convertSchemaField(v);
      }
    }
    if (field.required) out.required = field.required;
    if (field.items) out.items = this._convertSchemaField(field.items);
    return out;
  }

  _mapType(t) {
    const map = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT' };
    return map[t] || 'STRING';
  }

  _convertHistory(messages) {
    const history = [];
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const parts = this._convertAssistantContent(msg.content);
        if (parts.length > 0) history.push({ role: 'model', parts });
      } else if (msg.role === 'user') {
        // Separate tool_result blocks from regular content.
        // In Gemini, functionResponse parts must use role 'function', not 'user'.
        if (Array.isArray(msg.content)) {
          const toolResults = msg.content.filter(b => b.type === 'tool_result');
          const otherContent = msg.content.filter(b => b.type !== 'tool_result');

          if (toolResults.length > 0) {
            const frParts = toolResults.map(tr => ({
              functionResponse: {
                name: tr._toolName || 'unknown',
                response: { result: this._extractText(tr.content) },
              }
            }));
            history.push({ role: 'function', parts: frParts });
          }
          if (otherContent.length > 0) {
            const parts = this._convertContent(otherContent);
            if (parts.length > 0) history.push({ role: 'user', parts });
          }
        } else {
          const parts = this._convertContent(msg.content);
          if (parts.length > 0) history.push({ role: 'user', parts });
        }
      }
    }
    return history;
  }

  _convertContent(content) {
    if (typeof content === 'string') return [{ text: content }];
    if (!Array.isArray(content)) return [{ text: JSON.stringify(content) }];

    const parts = [];
    for (const block of content) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'image') {
        // Anthropic base64 image → Gemini inline_data
        parts.push({
          inlineData: {
            mimeType: block.source?.media_type || 'image/jpeg',
            data: block.source?.data || '',
          }
        });
      } else if (block.type === 'tool_result') {
        // Convert tool results to function response
        const textContent = this._extractText(block.content);
        parts.push({
          functionResponse: {
            name: block._toolName || 'unknown',
            response: { result: textContent },
          }
        });
      }
    }
    return parts.length > 0 ? parts : [{ text: '(empty)' }];
  }

  _convertAssistantContent(content) {
    if (!Array.isArray(content)) return [{ text: String(content) }];
    const parts = [];
    for (const block of content) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        parts.push({
          functionCall: { name: block.name, args: block.input }
        });
      }
    }
    return parts;
  }

  _extractText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    }
    return String(content);
  }

  _normalize(response) {
    const toolCalls = [];
    const textBlocks = [];

    const candidates = response.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.functionCall) {
          toolCalls.push({
            id: `gemini_${crypto.randomUUID().slice(0, 8)}`,
            name: part.functionCall.name,
            input: part.functionCall.args || {},
          });
        } else if (part.text) {
          textBlocks.push(part.text);
        }
      }
    }

    const finishReason = candidates[0]?.finishReason;
    const stopReason = finishReason === 'STOP' ? 'end_turn' : finishReason;

    return { toolCalls, textBlocks, stopReason, raw: response };
  }

  buildToolResult(toolUseId, content, toolName) {
    // For Gemini, we tag with tool name for history conversion
    return { type: 'tool_result', tool_use_id: toolUseId, content, _toolName: toolName };
  }
}

/**
 * Detect provider from model name.
 */
function getProvider(model) {
  if (model.startsWith('gemini')) return new GoogleProvider();
  return new AnthropicProvider();
}

// ============================================================================
// LLMAgent
// ============================================================================

/**
 * LLMAgent — a conversation with tool use, supporting multiple LLM providers.
 *
 * Each agent:
 * 1. Receives a system prompt defining role + constraints
 * 2. Gets initial message with image + stats + brief
 * 3. Calls tools (mapped to ops library) autonomously
 * 4. Sees results (including images) injected in tool results
 * 5. Iterates until satisfied or budget exhausted
 * 6. Calls `finish` or `submit_scores` to complete
 */
export class LLMAgent {
  /**
   * @param {string} name - Agent identifier
   * @param {object} opts
   * @param {string} opts.systemPrompt - Full system prompt
   * @param {{ definitions: Array, handlers: Map }} opts.tools - From buildToolSet()
   * @param {string} opts.model - Model ID (claude-* or gemini-*)
   * @param {{ maxTurns: number, maxWallClockMs: number }} opts.budget
   * @param {ArtifactStore} opts.store
   * @param {object} opts.brief
   * @param {object} opts.ctx - Bridge context
   */
  constructor(name, opts) {
    this.name = name;
    this.systemPrompt = opts.systemPrompt;
    this.tools = opts.tools;
    this.model = opts.model || DEFAULT_MODEL;
    this.budget = {
      maxTurns: opts.budget?.maxTurns ?? 30,
      maxWallClockMs: opts.budget?.maxWallClockMs ?? 30 * 60_000,
    };
    this.store = opts.store;
    this.brief = opts.brief;
    this.ctx = opts.ctx;

    this.provider = getProvider(this.model);
    this.messages = [];
    this.turnCount = 0;
    this.startTime = null;
    this.finishResult = null;
    this.transcript = [];
  }

  /**
   * Run the agent conversation loop.
   * @param {Array} initialContent - Content array (text + images)
   * @returns {{ finishResult: object|null, transcript: Array, turnCount: number, elapsedMs: number }}
   */
  async run(initialContent) {
    this.startTime = Date.now();
    this.messages = [{ role: 'user', content: initialContent }];
    this.crashError = null;
    this._log(`Starting (model=${this.model}, maxTurns=${this.budget.maxTurns})`);

    try { // Crash detection wrapper — BridgeCrashError propagates out
    while (true) {
      // Budget check
      const budgetStatus = this._checkBudget();
      if (budgetStatus === 'exhausted') {
        this._log('Budget exhausted — forcing wrap-up');
        this.messages.push({
          role: 'user',
          content: [{ type: 'text', text: 'BUDGET EXHAUSTED. You must call `finish` now with your best result so far. Do not start new operations.' }]
        });
        const wrapResult = await this._callModel();
        for (const t of wrapResult.textBlocks) {
          this.transcript.push({ role: 'assistant', type: 'text', content: t, turn: this.turnCount });
          this._log(`[text] ${t.slice(0, 200)}`);
        }
        if (wrapResult.toolCalls.length > 0) {
          for (const tc of wrapResult.toolCalls) {
            this._log(`[tool] ${tc.name}(${JSON.stringify(tc.input).slice(0, 100)})`);
            const result = await this._executeTool(tc.name, tc.input);
            if (tc.name === 'finish') this.finishResult = { type: 'finish', ...tc.input, toolResult: result };
            if (tc.name === 'submit_scores') this.finishResult = { type: 'scores', ...tc.input };
          }
        }
        break;
      }

      // Call model
      const response = await this._callModel();
      const { toolCalls, textBlocks, stopReason } = response;

      // Record text
      for (const t of textBlocks) {
        this.transcript.push({ role: 'assistant', type: 'text', content: t, turn: this.turnCount });
        this._log(`[text] ${t.slice(0, 200)}${t.length > 200 ? '...' : ''}`);
      }

      if (toolCalls.length === 0) {
        this._log('No tool calls — conversation ended');
        break;
      }

      // Execute tool calls
      const toolResults = [];
      for (const tc of toolCalls) {
        this.transcript.push({ role: 'assistant', type: 'tool_use', tool: tc.name, input: tc.input, turn: this.turnCount });
        this._log(`[tool] ${tc.name}(${JSON.stringify(tc.input).slice(0, 150)})`);

        const result = await this._executeTool(tc.name, tc.input);
        toolResults.push(this.provider.buildToolResult
          ? this.provider.buildToolResult(tc.id, result, tc.name)
          : { type: 'tool_result', tool_use_id: tc.id, content: result }
        );
        this.transcript.push({ role: 'tool', tool: tc.name, result: this._summarizeResult(result), turn: this.turnCount });

        if (tc.name === 'finish') {
          this.finishResult = { type: 'finish', ...tc.input, toolResult: result };
        } else if (tc.name === 'submit_scores') {
          this.finishResult = { type: 'scores', ...tc.input };
        }
      }

      // Add assistant message and tool results to history
      this.messages.push({ role: 'assistant', content: response.raw?.content || this._buildAssistantContent(textBlocks, toolCalls) });
      this.messages.push({ role: 'user', content: toolResults });

      this.turnCount++;

      if (this.finishResult) {
        this._log(`Agent finished: ${this.finishResult.type}`);
        break;
      }

      if (stopReason === 'end_turn' && toolCalls.length === 0) {
        break;
      }
    }

    } catch (err) {
      if (err instanceof BridgeCrashError || err?.isCrash) {
        this._log(`CRASH DETECTED: ${err.message}`);
        this.crashError = err;
        // Don't rethrow — return gracefully so orchestrator can handle resume
      } else {
        throw err; // Non-crash errors propagate normally
      }
    }

    const elapsed = Date.now() - this.startTime;
    this._log(`Completed in ${this.turnCount} turns, ${Math.round(elapsed / 1000)}s`);

    return {
      finishResult: this.finishResult,
      crashError: this.crashError,
      transcript: this.transcript,
      turnCount: this.turnCount,
      elapsedMs: elapsed,
    };
  }

  getTranscript() { return this.transcript; }
  getFinishResult() { return this.finishResult; }

  // =========================================================================
  // Internal
  // =========================================================================

  async _callModel() {
    try {
      return await this.provider.call(
        this.model,
        this.systemPrompt,
        this.tools.definitions,
        this.messages,
        4096
      );
    } catch (err) {
      this._log(`API error: ${err.message}`);
      throw err;
    }
  }

  _buildAssistantContent(textBlocks, toolCalls) {
    // Reconstruct Anthropic-format content for history (used by Gemini provider conversion)
    const content = [];
    for (const t of textBlocks) content.push({ type: 'text', text: t });
    for (const tc of toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    return content;
  }

  async _executeTool(name, input) {
    const handler = this.tools.handlers.get(name);
    if (!handler) {
      return [{ type: 'text', text: `Unknown tool: ${name}` }];
    }

    try {
      const result = await handler(this.ctx, this.store, this.brief, input, this.name);
      if (Array.isArray(result)) return result;
      if (result && result.type) return [result];
      return [{ type: 'text', text: String(result) }];
    } catch (err) {
      // Crash errors must propagate — don't swallow them as text
      if (err instanceof BridgeCrashError || err?.isCrash) throw err;
      this._log(`Tool error (${name}): ${err.message}`);
      return [{ type: 'text', text: `Error: ${err.message}` }];
    }
  }

  _checkBudget() {
    if (this.turnCount >= this.budget.maxTurns) return 'exhausted';
    if (Date.now() - this.startTime > this.budget.maxWallClockMs) return 'exhausted';
    return 'ok';
  }

  _summarizeResult(result) {
    if (Array.isArray(result)) {
      return result.filter(r => r.type === 'text').map(r => r.text).join('\n');
    }
    if (result?.type === 'text') return result.text;
    return String(result);
  }

  _log(msg) {
    const elapsed = this.startTime ? `${Math.round((Date.now() - this.startTime) / 1000)}s` : '0s';
    console.log(`  [${this.name}][${elapsed}][turn ${this.turnCount}] ${msg}`);
  }
}
