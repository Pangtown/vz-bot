/**
 * LLM provider – Claude (Anthropic) or OpenAI (when implemented); single round, conversation manager handles tool loop
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { SYSTEM_PROMPT } from './prompts.js';
import { toClaudeTools, parseClaudeToolUse, toGeminiTools, parseGeminiToolUse } from './tool-calling.js';

function getClient(apiKeyOverride) {
  const key = apiKeyOverride || process.env.ANTHROPIC_API_KEY || '';
  return new Anthropic({ apiKey: key });
}

/**
 * Test connectivity to the LLM with the given provider and optional API key.
 * Returns { ok: true } or { ok: false, error: string }.
 */
export async function testConnection(options = {}) {
  const provider = (options.provider || process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const apiKey = options.apiKey || (provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY) || '';
  if (provider === 'openai') {
    return { ok: false, error: 'OpenAI not yet implemented.' };
  }
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, error: `API key required. Set ${provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} in .env or enter in the UI.` };
  }
  if (provider === 'gemini') {
    try {
      const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
      const geminiModel = (options.model && options.model.includes('gemini')) ? options.model : 'gemini-2.5-flash';
      await ai.models.generateContent({
        model: geminiModel,
        contents: 'Reply with OK.',
      });
      return { ok: true };
    } catch (err) {
      const msg = err.message || String(err);
      return { ok: false, error: msg.length > 200 ? msg.slice(0, 200) + '…' : msg };
    }
  }
  try {
    const client = getClient(apiKey.trim());
    await client.messages.create({
      model: options.model || process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    });
    return { ok: true };
  } catch (err) {
    const msg = err.message || String(err);
    return { ok: false, error: msg.length > 200 ? msg.slice(0, 200) + '…' : msg };
  }
}

function getTextContent(res) {
  if (!res.content || !Array.isArray(res.content)) return '';
  const part = res.content.find(c => c.type === 'text');
  return part?.text ?? '';
}

/**
 * Convert our message format to Anthropic format.
 * Messages can be: { role, content } or for assistant/user with tool results: content may be array.
 */
function toAnthropicMessages(messages) {
  return messages.map(m => {
    if (m.role === 'user') {
      const content = typeof m.content === 'string' ? m.content : m.content;
      return { role: 'user', content: Array.isArray(content) ? content : [{ type: 'text', text: content }] };
    }
    if (m.role === 'assistant') {
      const content = m.content;
      return { role: 'assistant', content: Array.isArray(content) ? content : [{ type: 'text', text: content }] };
    }
    return null;
  }).filter(Boolean);
}

/**
 * Single round: send messages to LLM with tools. Returns { text } or { toolCalls }.
 * options.provider: 'anthropic' | 'openai' (openai not yet implemented)
 */
export async function chat(messages, options = {}) {
  const provider = (options.provider || process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  if (provider === 'openai') {
    throw new Error('OpenAI not yet implemented. Use LLM_PROVIDER=anthropic or gemini.');
  }

  if (provider === 'gemini') {
    const apiKey = options.apiKey || process.env.GEMINI_API_KEY || '';
    const ai = new GoogleGenAI({ apiKey: apiKey.trim() || undefined });

    const geminiMessages = messages.map(m => {
      if (m.role === 'user') return { role: 'user', parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] };
      if (m.role === 'assistant') return { role: 'model', parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] };
      return null;
    }).filter(Boolean);

    const geminiModel = (options.model && options.model.includes('gemini')) ? options.model : 'gemini-2.5-flash';
    const res = await ai.models.generateContent({
      model: geminiModel,
      contents: geminiMessages,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: toGeminiTools(),
        temperature: 0,
      }
    });

    const toolUses = parseGeminiToolUse(res);
    if (toolUses.length > 0) {
      return { text: null, toolCalls: toolUses, assistantContent: res.functionCalls };
    }
    return { text: res.text, toolCalls: [], assistantContent: null };
  }

  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const client = getClient(apiKey.trim() || undefined);
  const anthropicMessages = toAnthropicMessages(messages);
  const res = await client.messages.create({
    model: options.model || process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: options.maxTokens || 4096,
    system: SYSTEM_PROMPT,
    tools: toClaudeTools(),
    messages: anthropicMessages,
  });

  const toolUses = parseClaudeToolUse(res);
  if (toolUses.length > 0) {
    return { text: null, toolCalls: toolUses, assistantContent: res.content };
  }
  return { text: getTextContent(res), toolCalls: [], assistantContent: null };
}
