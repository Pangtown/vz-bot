#!/usr/bin/env node
/**
 * VZ Bot – entry point; starts gateway, web channel, and optional scheduler
 */

import 'dotenv/config';

// Disable TLS warnings for self-signed certificates from VHI
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import * as scheduler from './gateway/scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 18789;

let chatPageHtml = null;
async function getChatPage() {
  if (chatPageHtml) return chatPageHtml;
  chatPageHtml = await readFile(join(__dirname, '..', 'public', 'index.html'), 'utf8');
  return chatPageHtml;
}

const app = async (req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';
  if (method === 'POST' && (url === '/api/chat' || url === '/api/chat/')) {
    return handlePostChat(req, res);
  }
  if (method === 'POST' && (url === '/api/llm/test' || url === '/api/llm/test/')) {
    return handleLlmTest(req, res);
  }
  if (method === 'GET' && (url === '/api/health' || url === '/api/health/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'vz-bot' }));
    return;
  }
  if (method === 'GET' && (url === '/api/config' || url === '/api/config/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      llmProvider: process.env.LLM_PROVIDER || 'anthropic',
      llmModel: process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
      availableProviders: ['anthropic', 'gemini'],
      authRequired: !!process.env.WEB_PASSWORD,
    }));
    return;
  }
  if (method === 'GET' && (url === '/' || url === '/chat' || url === '/index.html')) {
    try {
      const html = await getChatPage();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading chat page.');
    }
    return;
  }
  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('VZ Bot running. Open / in browser to chat.');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
};

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : null;
}

function verifyWebPassword(payload) {
  const expected = process.env.WEB_PASSWORD;
  if (!expected) return true;
  return payload && payload.webPassword === expected;
}

async function handleLlmTest(req, res) {
  try {
    const payload = await readJsonBody(req);
    if (!verifyWebPassword(payload)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid web password' }));
      return;
    }
    const provider = payload?.provider || payload?.llmProvider || process.env.LLM_PROVIDER || 'anthropic';
    const apiKey = payload?.apiKey || process.env.ANTHROPIC_API_KEY || '';
    const { testConnection } = await import('./llm/provider.js');
    const result = await testConnection({ provider, apiKey: apiKey.trim() || undefined });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
  }
}

async function handlePostChat(req, res) {
  let payload = null;
  try {
    const body = await readJsonBody(req);
    payload = body;
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || 'Invalid JSON' }));
    return;
  }
  if (!verifyWebPassword(payload)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: Invalid web password' }));
    return;
  }
  const conversationId = payload?.conversationId || 'web-default';
  const message = payload?.message;
  const llmProvider = payload?.llmProvider || process.env.LLM_PROVIDER || 'anthropic';
  const apiKey = payload?.apiKey || null;

  // Removed process.env overwrites from UI payload to prevent breaking .env credentials
  if (!message || typeof message !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid message' }));
    return;
  }
  try {
    const { createRouter } = await import('./gateway/router.js');
    const router = createRouter(() => { });
    const reply = await router.handleIncoming(conversationId, message, { llmProvider, apiKey });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reply, conversationId }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
}

createServer((req, res) => app(req, res).catch(() => { })).listen(PORT, () => {
  const url = 'http://localhost:' + PORT;
  console.log('VZ Bot listening on ' + url);
  console.log('Open this URL in your browser for the chat page (text box to type messages):');
  console.log('  ' + url);
  if (process.env.HEALTH_POLL_ENABLED !== '0') {
    scheduler.start({ healthPollIntervalMinutes: Number(process.env.HEALTH_POLL_MINUTES) || 5 });
  }
});
