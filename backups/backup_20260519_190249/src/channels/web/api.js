/**
 * Web channel – HTTP API for posting messages and getting reply (single conversation for testing)
 */

import { createRouter } from '../../gateway/router.js';

let router = null;
let sendReply = null;

function getRouter() {
  if (!router) {
    sendReply = (conversationId, text) => {
      // Web channel stores last reply per conversation for GET
      if (!getRouter.lastReplies) getRouter.lastReplies = {};
      getRouter.lastReplies[conversationId] = text;
    };
    router = createRouter(sendReply);
  }
  return router;
}

export function registerWebChannel(app) {
  getRouter();
  app.post('/api/chat', async (req, res) => {
    try {
      const body = await readBody(req);
      const { conversationId = 'web-default', message } = body || {};
      if (!message || typeof message !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid message' }));
        return;
      }
      const reply = await router.handleIncoming(conversationId, message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply, conversationId }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
  });

  app.get('/api/health', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'vz-bot' }));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : null); } catch (e) { resolve(null); }
    });
    req.on('error', reject);
  });
}
