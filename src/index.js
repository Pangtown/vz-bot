#!/usr/bin/env node
/**
 * VZ Bot – entry point; starts gateway, web channel, and optional scheduler
 */

import 'dotenv/config';

// Accept self-signed certificates ONLY for registered VHI hosts.
// All other HTTPS traffic (LLM APIs, etc.) keeps full TLS verification.
import { installVhiTlsBypass, registerInsecureHost } from './utils/tls.js';
installVhiTlsBypass();
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import * as scheduler from './gateway/scheduler.js';
import { runWithContext } from './gateway/context.js';
import { handleVhiApi } from './gateway/vhi-api.js';
import { tokenFromRequest, touchConsoleSession } from './gateway/console-session.js';
import { safeEqual } from './gateway/vhi-api/helpers.js';
import { createRouter } from './gateway/router.js';
import { testConnection } from './llm/provider.js';
import { logger } from './utils/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 18789;

// Safety net: a stray error in any async path (pollers, SSH bridge, WebSocket)
// must not take down the whole service.
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception (service kept alive): ${err.message}`, { error: err, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error(`Unhandled rejection (service kept alive): ${msg}`, { reason });
});

async function getChatPage() {
  return readFile(join(__dirname, '..', 'public', 'index.html'), 'utf8');
}

async function getVhiPage() {
  return readFile(join(__dirname, '..', 'public', 'vhi.html'), 'utf8');
}

async function getClustersPage() {
  return readFile(join(__dirname, '..', 'public', 'clusters.html'), 'utf8');
}

async function getMarketplacePage() {
  return readFile(join(__dirname, '..', 'public', 'marketplace.html'), 'utf8');
}

async function getMigrationsPage() {
  return readFile(join(__dirname, '..', 'public', 'migrations.html'), 'utf8');
}

async function getDrPage() {
  return readFile(join(__dirname, '..', 'public', 'dr.html'), 'utf8');
}

async function getAssistantPage() {
  return readFile(join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
}

async function getSchedulerPage() {
  return readFile(join(__dirname, '..', 'public', 'scheduler.html'), 'utf8');
}

const PUBLIC_ASSETS = {
  '/vhi.css': { file: 'vhi.css', type: 'text/css; charset=utf-8' },
  '/js/vhi-common.js': { file: 'js/vhi-common.js', type: 'text/javascript; charset=utf-8' },
  '/js/migrations.js': { file: 'js/migrations.js', type: 'text/javascript; charset=utf-8' },
  '/js/dr.js': { file: 'js/dr.js', type: 'text/javascript; charset=utf-8' },
  '/js/vm-create.js': { file: 'js/vm-create.js', type: 'text/javascript; charset=utf-8' },
  '/js/marketplace.js': { file: 'js/marketplace.js', type: 'text/javascript; charset=utf-8' },
  '/js/assistant.js': { file: 'js/assistant.js', type: 'text/javascript; charset=utf-8' },
  '/js/scheduler.js': { file: 'js/scheduler.js', type: 'text/javascript; charset=utf-8' },
  '/js/vhi-dashboard.js': { file: 'js/vhi-dashboard.js', type: 'text/javascript; charset=utf-8' },
  '/js/vhi-networks.js': { file: 'js/vhi-networks.js', type: 'text/javascript; charset=utf-8' },
};

async function getSpicePage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>No console</title>
<style>body{font:15px/1.45 system-ui,sans-serif;background:#111;color:#ddd;margin:2rem;max-width:40rem}</style>
</head><body>
<h1>This is not a VM console</h1>
<p>SPICE mock terminals are disabled. Open the guest from the VHI dashboard with <strong>VNC (Web)</strong> after Nova has deployed it.</p>
</body></html>`;
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
      llmModel: process.env.LLM_MODEL || 'claude-sonnet-4-6',
      // Never expose the actual API key; the server falls back to its env key
      // when the client doesn't supply one.
      hasApiKey: !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY),
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
  if (method === 'GET' && (url === '/marketplace' || url === '/marketplace/' || url === '/marketplace.html')) {
    try {
      const html = await getMarketplacePage();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading marketplace page.');
    }
    return;
  }
  if (method === 'GET' && (url === '/migrations' || url === '/migrations/' || url === '/migrations.html')) {
    try {
      const html = await getMigrationsPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading migrations page.');
    }
    return;
  }
  if (method === 'GET' && (url === '/dr' || url === '/dr/' || url === '/dr.html')) {
    try {
      const html = await getDrPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading disaster recovery page.');
    }
    return;
  }
  if (method === 'GET' && (url === '/assistant' || url === '/assistant/' || url === '/assistant.html')) {
    try {
      const html = await getAssistantPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading AI assistant page.');
    }
    return;
  }
  if (method === 'GET' && (url === '/scheduler' || url === '/scheduler/' || url === '/scheduler.html')) {
    try {
      const html = await getSchedulerPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading scheduler page.');
    }
    return;
  }
  if (method === 'GET' && (url === '/spice' || url === '/spice/' || url === '/spice.html' || url === '/console' || url === '/console.html')) {
    try {
      const html = await getSpicePage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading console page: ' + e.message);
    }
    return;
  }
  const asset = PUBLIC_ASSETS[url];
  if (method === 'GET' && asset) {
    try {
      const body = await readFile(join(__dirname, '..', 'public', asset.file));
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
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
  if (!expected) return false;
  return safeEqual(payload?.webPassword, expected);
}

async function handleLlmTest(req, res) {
  let provider = process.env.LLM_PROVIDER || 'anthropic';
  try {
    const payload = await readJsonBody(req);
    if (!touchConsoleSession(tokenFromRequest(req)) && !verifyWebPassword(payload)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid web password' }));
      return;
    }
    provider = payload?.provider || payload?.llmProvider || provider;
    const apiKey = payload?.apiKey || process.env.ANTHROPIC_API_KEY || '';
    const baseUrl = payload?.llmBaseUrl || process.env.OPENAI_BASE_URL || '';
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
  const consoleSession = touchConsoleSession(tokenFromRequest(req));
  if (!consoleSession && !verifyWebPassword(payload)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: Invalid web password' }));
    return;
  }
  const conversationId = payload?.conversationId || 'web-default';
  const message = payload?.message;
  const llmProvider = payload?.llmProvider || process.env.LLM_PROVIDER || 'anthropic';
  const apiKey = payload?.apiKey || null;
  const llmBaseUrl = payload?.llmBaseUrl || null;
  const vhiBaseUrl = payload?.vhiBaseUrl || consoleSession?.baseUrl || null;
  const vhiUser = payload?.vhiUser || consoleSession?.username || null;
  const vhiPassword = payload?.vhiPassword || consoleSession?.password || null;
  const vhiProject = payload?.vhiProject || consoleSession?.project || null;
  const vhiSshHost = payload?.vhiSshHost || null;
  const vhiSshUser = payload?.vhiSshUser || null;
  const vhiSshPassword = payload?.vhiSshPassword || null;

  if (!message || typeof message !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid message' }));
    return;
  }
  try {
    if (vhiBaseUrl) registerInsecureHost(vhiBaseUrl);
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

const server = createServer((req, res) => app(req, res).catch((err) => {
  logger.error(`Unhandled request error: ${err.message}`, { error: err, url: req.url });
  if (!res.headersSent) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  } else {
    res.end();
  }
}));

// ── WebSocket SSH Bridge ───────────────────────────────────────────────────
import { WebSocketServer } from 'ws';
import { openSshShell } from './vhi/vinfra.js';

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let shell = null;

  // Sending on a closed socket emits an unhandled 'error' and crashes the
  // process — only send while the socket is open, and absorb socket errors.
  const safeSend = (payload) => {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  };
  ws.on('error', (err) => logger.error(`WS socket error: ${err.message}`));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      // Initialize shell on 'init' message
      if (data.type === 'init') {
        // Require web password (when configured) before opening an SSH shell
        if (!touchConsoleSession(data.sessionToken) && !verifyWebPassword(data)) {
          safeSend(JSON.stringify({ type: 'error', message: process.env.WEB_PASSWORD ? 'Unauthorized: Invalid web password' : 'WEB_PASSWORD is not set. Add it to .env and restart.' }));
          ws.close();
          return;
        }
        const { creds } = data;
        shell = openSshShell(creds,
          (out) => safeSend(JSON.stringify({ type: 'data', data: out.toString() })),
          (err) => {
            safeSend(JSON.stringify({ type: 'error', message: err ? err.message : 'Session closed' }));
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
  if (!process.env.WEB_PASSWORD) {
    logger.error('WEB_PASSWORD is not set. Dashboard, chat, and SSH routes will refuse requests until it is set in .env.');
  }
  logger.info(`VZ Bot listening on ${url}`);
  logger.info('Open this URL in your browser for the chat page (text box to type messages):');
  logger.info(`  ${url}`);
  scheduler.start({ healthPollIntervalMinutes: Number(process.env.HEALTH_POLL_MINUTES) || 5 });
  if (process.env.HEALTH_POLL_ENABLED !== '0') {
    logger.info(`Scheduler: health poll every ${Number(process.env.HEALTH_POLL_MINUTES) || 5} min`);
  }
});
