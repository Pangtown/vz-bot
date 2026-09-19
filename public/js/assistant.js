'use strict';

let chatHistory = [];
let _vms = [];
let _nodes = [];
let _vols = [];
let _nets = [];
let _imgs = [];
let _flavors = [];
let _volTypes = [];

const chatMsgs = document.getElementById('panelChatMessages');
const chatInput = document.getElementById('panelChatInput');
const chatSendBtn = document.getElementById('panelChatSend');

async function loadAssistantContext() {
  if (typeof refreshClusterSwitcher === 'function') refreshClusterSwitcher();
  const results = await Promise.allSettled([
    apiGet('/api/vhi/servers'),
    apiGet('/api/vhi/nodes'),
    apiGet('/api/vhi/volumes'),
    apiGet('/api/vhi/networks'),
    apiGet('/api/vhi/images'),
    apiGet('/api/vhi/flavors'),
    apiGet('/api/vhi/volume-types'),
  ]);
  const value = (i, key) => (results[i].status === 'fulfilled' ? (results[i].value[key] || []) : []);
  _vms = value(0, 'servers');
  _nodes = value(1, 'nodes');
  _vols = value(2, 'volumes');
  _nets = value(3, 'networks');
  _imgs = value(4, 'images');
  _flavors = value(5, 'flavors');
  _volTypes = value(6, 'volume_types');
}

function appendMsg(role, text, cls) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'msg-user' : 'msg-ai') + (cls ? ' ' + cls : '');
  div.textContent = text;
  chatMsgs.appendChild(div);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  return div;
}

function buildSystemContext() {
  const cluster = session?.baseUrl || 'unknown';
  const vmSummary = _vms.length ? `${_vms.length} VMs (${_vms.filter((v) => v.status === 'ACTIVE').length} active)` : 'No VMs';
  const nodeSummary = _nodes.length ? `${_nodes.length} nodes` : 'No nodes';
  const policies = _volTypes.map((t) => t.name).join(', ') || 'None';
  const nets = _nets.map((n) => `${n.name || 'unnamed'} (${String(n.id || '').slice(0, 8)})`).join(', ') || 'None';
  const imgs = _imgs.slice(0, 10).map((i) => `${i.name || 'unnamed'} (${String(i.id || '').slice(0, 8)})`).join(', ') || 'None';
  const flavors = _flavors.slice(0, 8).map((f) => `${f.name} (${String(f.id || '').slice(0, 8)})`).join(', ') || 'None';
  return `You are VZ Bot, an AI assistant for Virtuozzo Hybrid Infrastructure (VHI).
Cluster: ${cluster}
State: ${vmSummary}, ${nodeSummary}, ${_vols.length} volumes, ${_nets.length} networks, ${_imgs.length} images.
Storage Policies: ${policies}
Available Networks: ${nets}
Available Images (Top 10): ${imgs}
Available Flavors (Top 8): ${flavors}

Guidelines:
1. Use provided IDs/Names if the user refers to resources.
2. If asked to create something, use the available policies/flavors/networks.
3. If IDs are missing, ask the user or use list tools to find them.
4. Answer concisely. Use markdown tables for lists.`;
}

async function sendChat() {
  const text = (chatInput?.value || '').trim();
  if (!text) return;
  chatInput.value = '';
  chatInput.style.height = '48px';
  if (chatSendBtn) chatSendBtn.disabled = true;
  appendMsg('user', text);
  chatHistory.push({ role: 'user', content: text });
  const thinkingEl = appendMsg('assistant', 'Thinking...', 'thinking');
  try {
    const ssh = (() => {
      try { return JSON.parse(localStorage.getItem(getGlobalSshKey()) || '{}'); } catch (_) { return {}; }
    })();
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        conversationId: 'web-session',
        systemContext: buildSystemContext(),
        chatHistory: chatHistory.slice(-10),
        llmProvider: localStorage.getItem('llmProvider') || undefined,
        apiKey: localStorage.getItem('llmApiKey') || undefined,
        llmBaseUrl: localStorage.getItem('llmBaseUrl') || undefined,
        vhiBaseUrl: session?.baseUrl,
        vhiUser: session?.username,
        vhiPassword: session?.password,
        vhiProject: session?.project,
        vhiSshHost: ssh.host,
        vhiSshUser: ssh.username,
        vhiSshPassword: ssh.password,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    const reply = data.reply || 'No response from AI agent.';
    thinkingEl.classList.remove('thinking');
    thinkingEl.textContent = reply;
    chatHistory.push({ role: 'assistant', content: reply });
  } catch (err) {
    thinkingEl.classList.remove('thinking');
    thinkingEl.textContent = '! ' + (err.message || 'Request failed');
  } finally {
    if (chatSendBtn) chatSendBtn.disabled = false;
    chatInput?.focus();
  }
}

chatInput?.addEventListener('input', () => {
  chatInput.style.height = '48px';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
});
chatInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
chatSendBtn?.addEventListener('click', sendChat);

function openSettingsModal() {
  const provider = document.getElementById('llmProvider');
  const key = document.getElementById('llmApiKey');
  const base = document.getElementById('llmBaseUrl');
  if (provider) provider.value = localStorage.getItem('llmProvider') || 'anthropic';
  if (key) key.value = localStorage.getItem('llmApiKey') || '';
  if (base) base.value = localStorage.getItem('llmBaseUrl') || '';
  document.getElementById('settingsModal')?.classList.remove('hidden');
}

function closeSettingsModal() {
  document.getElementById('settingsModal')?.classList.add('hidden');
}

document.getElementById('settingsToggle')?.addEventListener('click', openSettingsModal);
document.getElementById('closeSettingsModal')?.addEventListener('click', closeSettingsModal);
document.getElementById('cancelSettingsBtn')?.addEventListener('click', closeSettingsModal);
document.getElementById('saveSettingsBtn')?.addEventListener('click', () => {
  const provider = document.getElementById('llmProvider');
  const key = document.getElementById('llmApiKey');
  const base = document.getElementById('llmBaseUrl');
  if (provider) localStorage.setItem('llmProvider', provider.value);
  if (key) localStorage.setItem('llmApiKey', key.value);
  if (base) localStorage.setItem('llmBaseUrl', base.value);
  toast('Settings saved successfully', 'ok');
  closeSettingsModal();
});

if (document.body.getAttribute('data-nav') === 'assistant') {
  bootVhiSession(loadAssistantContext);
}