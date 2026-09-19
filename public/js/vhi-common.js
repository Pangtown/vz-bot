'use strict';

// ── session state ─────────────────────────────────────────────────────────
var session = null; // { baseUrl, username, project, userDomain, projectDomain }

// ── utility ───────────────────────────────────────────────────────────────

function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'show toast-' + type;
  clearTimeout(el._t);
  const ms = type === 'err' ? 12000 : 3200;
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

function statusBadge(status = '') {
  const s = status.toLowerCase();
  let cls = 'badge-default';
  if (['active','up','running','available','in-use'].includes(s)) cls = 'badge-active';
  else if (['error','failed','down','cancelled'].includes(s)) cls = 'badge-error';
  else if (['cancelling'].includes(s)) cls = 'badge-build';
  else if (['build','migrating','resize'].includes(s)) cls = 'badge-build';
  else if (['shutoff','stopped'].includes(s)) cls = 'badge-shutoff';
  return `<span class="badge ${cls}">${status || '–'}</span>`;
}

function fmtBytes(bytes) {
  if (!bytes) return '–';
  const gb = bytes / 1073741824;
  return gb >= 1 ? gb.toFixed(1) + ' GB' : (bytes / 1048576).toFixed(0) + ' MB';
}

function fmtDate(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function pct(used, total) {
  if (!total) return 0;
  return Math.min(100, Math.round(used / total * 100));
}

function barHtml(usedPct) {
  const cls = usedPct > 85 ? 'bar-crit' : usedPct > 65 ? 'bar-warn' : 'bar-ok';
  return `<div class="bar-wrap"><div class="bar-fill ${cls}" style="width:${usedPct}%"></div></div> ${usedPct}%`;
}

function skeletonRows(cols, n = 3) {
  return Array.from({ length: n }).map(() =>
    `<tr class="skeleton-row"><td colspan="${cols}"><div class="skeleton"></div></td></tr>`
  ).join('');
}

function emptyState(icon, msg) {
  return `<tr><td colspan="99"><div class="empty-state"><span class="es-icon">${icon}</span><p>${msg}</p></div></td></tr>`;
}

function filterRows(rows, query) {
  if (!query) return rows;
  const q = query.toLowerCase();
  return rows.filter(r => r.toLowerCase().includes(q));
}

// ── session headers ───────────────────────────────────────────────────────

function authHeaders() {
  const webPw = localStorage.getItem('webPassword') || '';
  const baseHeaders = {
    'Content-Type': 'application/json',
    ...(webPw ? { 'X-Web-Password': webPw } : {}),
  };
  if (!session) return baseHeaders;
  
  // Use cluster-scoped SSH config if available
  let sshConfig = {};
  try {
    const saved = localStorage.getItem(getGlobalSshKey());
    if (saved) sshConfig = JSON.parse(saved);
  } catch(e) {}

  return {
    ...baseHeaders,
    'X-VHI-Base-URL':    session.baseUrl,
    'X-VHI-User':        session.username,
    'X-VHI-Password':    session.password,
    'X-VHI-Project':     session.project,
    'X-VHI-Project-ID':  session.projectId || '',
    'X-VHI-Domain':      session.userDomain,
    'X-VHI-Project-Domain': session.projectDomain || session.userDomain || 'Default',
    'X-VHI-SSH-Host':     sshConfig.host || '',
    'X-VHI-SSH-User':     sshConfig.username || 'root',
    'X-VHI-SSH-Password': sshConfig.password || '',
  };
}

// ── API calls ─────────────────────────────────────────────────────────────

async function apiGet(path) {
  const r = await fetch(path, { headers: authHeaders() });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return r.json();
}

async function apiGetForCluster(path, cluster) {
  if (!cluster) return apiGet(path);
  const webPw = localStorage.getItem('webPassword') || '';
  const r = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(webPw ? { 'X-Web-Password': webPw } : {}),
      'X-VHI-Base-URL': cluster.baseUrl,
      'X-VHI-User': cluster.username,
      'X-VHI-Password': cluster.password,
      'X-VHI-Project': cluster.project || 'admin',
      'X-VHI-Project-ID': cluster.projectId || '',
      'X-VHI-Domain': cluster.userDomain || 'Default',
      'X-VHI-Project-Domain': cluster.projectDomain || cluster.userDomain || 'Default',
    },
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return r.json();
}

async function apiPatch(path, body) {
  const r = await fetch(path, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return r.json();
}

async function apiDelete(path) {
  const r = await fetch(path, {
    method: 'DELETE',
    headers: authHeaders()
  });
  if (!r.ok && r.status !== 404) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return r.json().catch(() => ({ ok: true }));
}


// ── LOGIN ─────────────────────────────────────────────────────────────────

// Restore saved theme on load
const currentTheme = localStorage.getItem('vhi_theme') || 'light';
document.documentElement.setAttribute('data-theme', currentTheme);

document.getElementById('themeToggle')?.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('vhi_theme', newTheme);
});



document.getElementById('advToggle')?.addEventListener('click', () => {
  const f = document.getElementById('advFields');
  const a = document.getElementById('advArrow');
  f.classList.toggle('open');
  a.textContent = f.classList.contains('open') ? '▼' : '▶';
});

document.getElementById('connectBtn')?.addEventListener('click', doLogin);
document.getElementById('loginPass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

document.getElementById('discoverBtn')?.addEventListener('click', async () => {
  let hostStr = document.getElementById('loginHost').value.trim().replace(/https?:\/\//, '');
  let host = hostStr;
  if (hostStr.includes(']')) {
    host = hostStr.split(']')[0] + ']';
  } else if (hostStr.includes(':')) {
    host = hostStr.split(':')[0];
  } else {
    host = hostStr.split('/')[0];
  }
  if (!host) { setLoginStatus('Enter cluster address first', 'error'); return; }
  setLoginStatus('Discovering…', '');
  try {
    const r = await fetch(`https://${host}:5000/v3`, { method: 'GET' });
    setLoginStatus(`✓ Keystone reachable (HTTP ${r.status})`, 'success');
  } catch (e) {
    setLoginStatus(`✗ Cannot reach ${host}:5000 — check address`, 'error');
  }
});

function setLoginStatus(msg, type) {
  const el = document.getElementById('loginStatus');
  el.textContent = msg;
  el.className = 'login-status' + (type ? ' ' + type : '');
}

async function doLogin() {
  const host    = document.getElementById('loginHost').value.trim();
  const user    = document.getElementById('loginUser').value.trim();
  const pass    = document.getElementById('loginPass').value;
  const uDomain = document.getElementById('loginUserDomain').value.trim() || 'Default';
  const pDomain = document.getElementById('loginProjDomain').value.trim() || 'Default';
  const project = document.getElementById('loginProject').value.trim() || 'admin';

  if (!host || !user || !pass) {
    setLoginStatus('Please fill in all required fields', 'error');
    return;
  }

  const btn = document.getElementById('connectBtn');
  btn.disabled = true; btn.textContent = 'Connecting…';
  setLoginStatus('Authenticating…', '');

  try {
    const data = await apiPost('/api/vhi/auth', {
      baseUrl: host, username: user, password: pass,
      userDomain: uDomain, projectDomain: pDomain, project,
    });

    if (!data.ok) throw new Error(data.error || 'Authentication failed');

    session = {
      baseUrl:      data.baseUrl,
      username:     data.username,
      password:     pass,         // kept in JS memory only
      project:      data.project,
      projectId:    data.projectId || '',
      userDomain:   data.userDomain,
      projectDomain: data.projectDomain,
      isAdmin:      !!data.isAdmin,
    };

    // show app
    document.getElementById('loginOverlay').classList.add('hidden');
    document.getElementById('appShell').classList.add('visible');
    const clusterDot = document.getElementById('clusterDot');
    if (clusterDot) clusterDot.style.background = 'var(--success)';
    rememberClusterInSwitcher();
    refreshClusterSwitcher();

    if (typeof window.onVhiReady === 'function') window.onVhiReady();
  } catch (err) {
    setLoginStatus(err.message || 'Connection failed', 'error');
    // If auto-connect hid the overlay, bring it back gracefully on error
    document.getElementById('loginOverlay').classList.remove('hidden');
    document.getElementById('loginOverlay').style.display = '';
    document.getElementById('appShell').classList.remove('visible');
  } finally {
    btn.disabled = false; btn.textContent = 'Connect';
  }
}


function getGlobalSshKey() {
  const clusterId = session?.baseUrl || 'default';
  return 'vhi_ssh_global_' + clusterId;
}

function escapeHtml(str) {
  if (str == null || str === '') return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;').replace(/\r?\n/g, ' ');
}

const CLUSTER_STORE_KEY = 'vhi_multi_clusters';
function readSavedClusters() {
  try { return JSON.parse(localStorage.getItem(CLUSTER_STORE_KEY) || '[]'); }
  catch (e) { return []; }
}
function clusterIdFromSession(s) {
  if (!s) return '';
  const host = String(s.baseUrl || '').replace(/https?:\/\//, '').split('/')[0];
  return host + '_' + (s.project || 'admin');
}
function rememberClusterInSwitcher() {
  if (!session) return;
  const clusters = readSavedClusters();
  const id = clusterIdFromSession(session);
  const rec = {
    id,
    baseUrl: session.baseUrl,
    username: session.username,
    password: session.password,
    project: session.project,
    userDomain: session.userDomain,
    projectDomain: session.projectDomain,
    projectId: session.projectId || '',
  };
  const idx = clusters.findIndex(c => c.id === id);
  if (idx >= 0) clusters[idx] = Object.assign({}, clusters[idx], rec);
  else clusters.push(rec);
  localStorage.setItem(CLUSTER_STORE_KEY, JSON.stringify(clusters));
}
function refreshClusterSwitcher() {
  const sel = document.getElementById('clusterSwitcher');
  if (!sel) return;
  const clusters = readSavedClusters();
  const currentId = clusterIdFromSession(session);
  if (!clusters.length) {
    const label = session
      ? String(session.baseUrl || '').replace(/https?:\/\//, '').split(/[:/]/)[0]
      : 'Not connected';
    sel.innerHTML = `<option value="">${escapeHtml(label)}</option>`;
    return;
  }
  sel.innerHTML = clusters.map(c => {
    const host = String(c.baseUrl || '').replace(/https?:\/\//, '').split(/[:/]/)[0];
    const label = host + ' · ' + (c.project || 'admin');
    return `<option value="${escapeHtml(c.id)}"${c.id === currentId ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}
async function switchCluster(id) {
  const c = readSavedClusters().find(x => x.id === id);
  if (!c) return;
  if (session && clusterIdFromSession(session) === id) return;
  if (!c.password) {
    toast('No saved password for this cluster. Open Clusters to reconnect.', 'warn');
    refreshClusterSwitcher();
    return;
  }
  localStorage.setItem('vhiBaseUrl', c.baseUrl);
  localStorage.setItem('vhiUser', c.username);
  localStorage.setItem('vhiPassword', c.password);
  localStorage.setItem('vhiProject', c.project);
  document.getElementById('loginHost').value = c.baseUrl;
  document.getElementById('loginUser').value = c.username;
  document.getElementById('loginPass').value = c.password;
  document.getElementById('loginProject').value = c.project || 'admin';
  if (c.userDomain) document.getElementById('loginUserDomain').value = c.userDomain;
  if (c.projectDomain) document.getElementById('loginProjDomain').value = c.projectDomain;
  toast('Switching cluster…', 'info');
  await doLogin();
}
document.getElementById('clusterSwitcher')?.addEventListener('change', (e) => {
  if (e.target.value) switchCluster(e.target.value);
});

function stashVhiSession() {
  if (!session) return;
  localStorage.setItem('vhiBaseUrl', session.baseUrl);
  localStorage.setItem('vhiUser', session.username);
  localStorage.setItem('vhiPassword', session.password);
  localStorage.setItem('vhiProject', session.project);
}
document.getElementById('marketplaceLink')?.addEventListener('click', stashVhiSession);
document.getElementById('migrationsNavLink')?.addEventListener('click', stashVhiSession);

document.getElementById('logoutBtn')?.addEventListener('click', () => {
  session = null;
  sessionStorage.setItem('loggedOut', '1');
  localStorage.removeItem('vhiBaseUrl');
  localStorage.removeItem('vhiUser');
  localStorage.removeItem('vhiPassword');
  localStorage.removeItem('vhiProject');

  document.getElementById('appShell').classList.remove('visible');
  const overlay = document.getElementById('loginOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.style.display = '';
  }
  const pass = document.getElementById('loginPass');
  if (pass) pass.value = '';
  setLoginStatus('', '');
  ['vmBody','nodeBody','volBody','netBody','imgBody','overviewVmBody'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = skeletonRows(7);
  });
  ['vmBadge','nodeBadge','volBadge','netBadge','imgBadge'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '–';
  });
  ['statVms','statRunning','statNodes','statVols','statNets','statImgs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '–';
  });
});

window.stashVhiSession = stashVhiSession;
window.bootVhiSession = function bootVhiSession(onReady) {
  window.onVhiReady = onReady;
  const fwdBaseUrl = localStorage.getItem('vhiBaseUrl') || '172.16.218.7';
  const fwdUser = localStorage.getItem('vhiUser') || 'admin';
  const fwdPass = localStorage.getItem('vhiPassword') || 'Nexpass8188!';
  const fwdProj = localStorage.getItem('vhiProject') || 'admin';

  if (sessionStorage.getItem('loggedOut') !== '1') {
    const hostEl = document.getElementById('loginHost');
    const userEl = document.getElementById('loginUser');
    const passEl = document.getElementById('loginPass');
    const projEl = document.getElementById('loginProject');
    if (hostEl) hostEl.value = fwdBaseUrl;
    if (userEl) userEl.value = fwdUser;
    if (passEl) passEl.value = fwdPass;
    if (fwdProj && projEl) projEl.value = fwdProj;

    const overlay = document.getElementById('loginOverlay');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.style.display = 'none';
    }
    document.getElementById('appShell')?.classList.add('visible');
    doLogin();
  }
};
