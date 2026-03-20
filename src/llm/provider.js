/**
 * LLM provider – Claude, Gemini, or OpenAI (local/hosted)
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { SYSTEM_PROMPT } from './prompts.js';
import {
  toClaudeTools, parseClaudeToolUse,
  toGeminiTools, parseGeminiToolUse,
  toOpenAITools, parseOpenAIToolUse
} from './tool-calling.js';

function getAnthropicClient(apiKeyOverride) {
  const key = apiKeyOverride || process.env.ANTHROPIC_API_KEY || '';
  return new Anthropic({ apiKey: key });
}

function getOpenAIClient(apiKeyOverride, baseUrlOverride) {
  const key = apiKeyOverride || process.env.OPENAI_API_KEY || 'dummy_key_for_local';
  const baseURL = baseUrlOverride || process.env.OPENAI_BASE_URL || undefined;
  return new OpenAI({ apiKey: key, baseURL });
}

export async function testConnection(options = {}) {
  const provider = (options.provider || process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const apiKey = options.apiKey || '';
  const baseUrl = options.baseUrl || '';

  if (provider === 'openai' || provider === 'perplexity') {
    const isPerp = provider === 'perplexity';
    try {
      const actualKey = isPerp ? (apiKey || process.env.PERPLEXITY_API_KEY || '') : apiKey;
      const actualBaseUrl = isPerp ? 'https://api.perplexity.ai/' : baseUrl;

      const client = getOpenAIClient(actualKey, actualBaseUrl);
      await client.chat.completions.create({
        model: options.model || (isPerp ? 'sonar-pro' : (process.env.LLM_MODEL || 'gpt-4o-mini')),
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 10,
      });
      return { ok: true };
    } catch (err) {
      const msg = err.message || String(err);
      return { ok: false, error: msg.length > 200 ? msg.slice(0, 200) + '…' : msg };
    }
  }

  if (provider === 'gemini') {
    const key = apiKey || process.env.GEMINI_API_KEY || '';
    if (!key.trim()) return { ok: false, error: 'API key required for Gemini.' };
    try {
      const ai = new GoogleGenAI({ apiKey: key.trim() });
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

  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!key.trim()) return { ok: false, error: 'API key required for Anthropic.' };
  try {
    const client = getAnthropicClient(key.trim());
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

function toOpenAIMessages(messages) {
  const formatted = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const m of messages) {
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        // Handle tool results
        const lastToolCall = m.content[0]?.tool_use_id;
        formatted.push({
          role: 'tool',
          tool_call_id: lastToolCall,
          content: JSON.stringify(m.content)
        });
      } else {
        formatted.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant') {
      if (m.content && m.content.tool_calls) {
        // assistant tool call block
        formatted.push({
          role: 'assistant',
          tool_calls: m.content.tool_calls
        });
      } else {
        formatted.push({ role: 'assistant', content: m.content || '' });
      }
    }
  }
  return formatted;
}

export async function chat(messages, options = {}) {
  const provider = (options.provider || process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

  if (provider === 'openai' || provider === 'perplexity') {
    const isPerp = provider === 'perplexity';
    const actualKey = isPerp ? (options.apiKey?.trim() || process.env.PERPLEXITY_API_KEY || '') : options.apiKey?.trim();
    const actualBaseUrl = isPerp ? 'https://api.perplexity.ai/' : options.baseUrl?.trim();

    const client = getOpenAIClient(actualKey, actualBaseUrl);
    const openaiMessages = toOpenAIMessages(messages);

    const res = await client.chat.completions.create({
      model: options.model || (isPerp ? 'sonar-pro' : (process.env.LLM_MODEL || 'gpt-4o-mini')),
      messages: openaiMessages,
      tools: toOpenAITools(),
    });

    const choice = res.choices[0]?.message;
    if (!choice) return { text: `No response from ${isPerp ? 'Perplexity' : 'OpenAI'} provider.`, toolCalls: [], assistantContent: null };

    const toolUses = parseOpenAIToolUse(choice);
    if (toolUses.length > 0) {
      return { text: null, toolCalls: toolUses, assistantContent: choice };
    }
    return { text: choice.content, toolCalls: [], assistantContent: null };
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
  const client = getAnthropicClient(apiKey.trim() || undefined);
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
