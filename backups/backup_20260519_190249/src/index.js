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
import { runWithContext } from './gateway/context.js';
import { handleVhiApi } from './gateway/vhi-api.js';
import { logger } from './utils/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 18789;

let chatPageHtml = null;
async function getChatPage() {
  if (chatPageHtml) return chatPageHtml;
  chatPageHtml = await readFile(join(__dirname, '..', 'public', 'index.html'), 'utf8');
  return chatPageHtml;
}

let vhiPageHtml = null;
async function getVhiPage() {
  if (vhiPageHtml) return vhiPageHtml;
  vhiPageHtml = await readFile(join(__dirname, '..', 'public', 'vhi.html'), 'utf8');
  return vhiPageHtml;
}

let clustersPageHtml = null;
async function getClustersPage() {
  if (clustersPageHtml) return clustersPageHtml;
  clustersPageHtml = await readFile(join(__dirname, '..', 'public', 'clusters.html'), 'utf8');
  return clustersPageHtml;
}

const app = async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  const method = req.method || 'GET';
  if (method === 'POST' && (url === '/api/chat' || url === '/api/chat/')) {
    return handlePostChat(req, res);
  }
  if (method === 'POST' && (url === '/api/llm/test' || url === '/api/llm/test/')) {
    return handleLlmTest(req, res);
  }
  // VHI dashboard API — handles all /api/vhi/* routes
  if (url.startsWith('/api/vhi')) {
    const handled = await handleVhiApi(req, res);
    if (handled) return;
  }
  if (method === 'GET' && (url === '/api/health' || url === '/api/health/')) {
    logger.debug('Health check requested');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      service: 'vz-bot',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    }));
    return;
  }
  if (method === 'GET' && (url === '/api/config' || url === '/api/config/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      llmProvider: process.env.LLM_PROVIDER || 'anthropic',
      llmModel: process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '',
      llmBaseUrl: process.env.LLM_BASE_URL || '',
      availableProviders: ['anthropic', 'gemini', 'openai'],
      authRequired: !!process.env.WEB_PASSWORD,
    }));
    return;
  }
  if (method === 'GET' && (url === '/' || url === '/vhi' || url === '/vhi/' || url === '/vhi.html' || url === '/index.html')) {
    try {
      const html = await getVhiPage();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading VHI dashboard page.');
    }
    return;
  }
  if (method === 'GET' && (url === '/chat' || url === '/chat/')) {
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
  if (method === 'GET' && (url === '/clusters' || url === '/clusters/' || url === '/clusters.html')) {
    try {
      const html = await getClustersPage();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading clusters page.');
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
    const baseUrl = payload?.llmBaseUrl || process.env.OPENAI_BASE_URL || '';
    const { testConnection } = await import('./llm/provider.js');
    const result = await testConnection({ provider, apiKey: apiKey.trim() || undefined, baseUrl: baseUrl.trim() || undefined });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    logger.error(`LLM test failed: ${err.message}`, { error: err, provider });
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
  const llmBaseUrl = payload?.llmBaseUrl || null;
  const vhiBaseUrl = payload?.vhiBaseUrl || null;
  const vhiUser = payload?.vhiUser || null;
  const vhiPassword = payload?.vhiPassword || null;
  const vhiProject = payload?.vhiProject || null;
  const vhiSshHost = payload?.vhiSshHost || null;
  const vhiSshUser = payload?.vhiSshUser || null;
  const vhiSshPassword = payload?.vhiSshPassword || null;

  if (!message || typeof message !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid message' }));
    return;
  }
  try {
    const { createRouter } = await import('./gateway/router.js');
    const router = createRouter(() => { });
    const reply = await runWithContext({
      vhiBaseUrl, vhiUser, vhiPassword, vhiProject, vhiSshHost, vhiSshUser, vhiSshPassword
    }, () => router.handleIncoming(conversationId, message, { llmProvider, apiKey, baseUrl: llmBaseUrl }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reply, conversationId }));
  } catch (err) {
    logger.error(`Error handling chat request: ${err.message}`, { error: err });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
}

const server = createServer((req, res) => app(req, res).catch(() => { }));

// ── WebSocket SSH Bridge ───────────────────────────────────────────────────
import { WebSocketServer } from 'ws';
import { openSshShell } from './vhi/vinfra.js';

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let shell = null;
  
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      
      // Initialize shell on 'init' message
      if (data.type === 'init') {
        const { creds } = data;
        shell = openSshShell(creds, 
          (out) => ws.send(JSON.stringify({ type: 'data', data: out.toString() })),
          (err) => {
            ws.send(JSON.stringify({ type: 'error', message: err ? err.message : 'Session closed' }));
            ws.close();
          }
        );
      } else if (data.type === 'data') {
        if (shell) shell.write(data.data);
      } else if (data.type === 'resize') {
        if (shell) shell.resize(data.cols, data.rows);
      }
    } catch (e) {
      console.error('WS Error:', e);
    }
  });

  ws.on('close', () => {
    if (shell) shell.close();
  });
});

server.listen(PORT, () => {
  const url = 'http://localhost:' + PORT;
  logger.info(`VZ Bot listening on ${url}`);
  logger.info('Open this URL in your browser for the chat page (text box to type messages):');
  logger.info(`  ${url}`);
  if (process.env.HEALTH_POLL_ENABLED !== '0') {
    logger.info(`Scheduler: health poll every ${Number(process.env.HEALTH_POLL_MINUTES) || 5} min`);
    scheduler.start({ healthPollIntervalMinutes: Number(process.env.HEALTH_POLL_MINUTES) || 5 });
  }
});
