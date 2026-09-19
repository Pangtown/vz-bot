'use strict';

let images = [];
let flavors = [];
let networks = [];
let scripts = [];
let deployImage = null;
let editingScriptId = null;

function esc(s) {
  return typeof escapeHtml === 'function' ? escapeHtml(s) : String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function mpApi(path, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  if (method === 'GET') return apiGet(path);
  if (method === 'DELETE') return apiDelete(path);
  const body = opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body) : {};
  return apiPost(path, body);
}

async function loadMarketplace() {
  if (typeof refreshClusterSwitcher === 'function') refreshClusterSwitcher();
  loadScripts();
  loadTemplates();
  try {
    const [f, n] = await Promise.all([apiGet('/api/vhi/flavors'), apiGet('/api/vhi/networks')]);
    flavors = f.flavors || [];
    networks = n.networks || [];
  } catch (err) {
    toast('Failed to load flavors/networks: ' + err.message, 'err');
  }
}

document.querySelectorAll('.mp-tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.mp-tab').forEach((t) => t.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById('tab-templates').style.display = tab.dataset.tab === 'templates' ? '' : 'none';
  document.getElementById('tab-scripts').style.display = tab.dataset.tab === 'scripts' ? '' : 'none';
}));

async function loadTemplates() {
  const grid = document.getElementById('tplGrid');
  if (grid) grid.innerHTML = '<div class="empty">Loading templates…</div>';
  try {
    const data = await apiGet('/api/vhi/images');
    const active = (data.images || []).filter((i) => i.status === 'active');
    images = active.filter((i) =>
      (i.disk_format || '').toLowerCase() !== 'iso' &&
      cloudInitSupport(i).level !== 'no' &&
      !(i.tags || []).includes('hci.system')
    );
    const hidden = active.length - images.length;
    const note = document.getElementById('tplHiddenNote');
    if (note) {
      note.textContent = hidden > 0
        ? `${hidden} image${hidden === 1 ? '' : 's'} hidden (ISOs / system / no script support)`
        : '';
    }
    renderTemplates();
  } catch (err) {
    if (grid) grid.innerHTML = `<div class="empty">Failed to load images: ${esc(err.message)}</div>`;
  }
}

function osIcon(img) {
  const n = ((img.os_distro || '') + ' ' + (img.name || '')).toLowerCase();
  if (n.includes('win')) return '🪟';
  if (n.includes('ubuntu')) return '🟠';
  if (n.includes('centos') || n.includes('alma') || n.includes('rocky') || n.includes('rhel') || n.includes('fedora')) return '🔴';
  if (n.includes('debian')) return '🌀';
  if (n.includes('cirros') || n.includes('test')) return '🧪';
  return '🐧';
}

function fmtSize(bytes) {
  if (!bytes) return '–';
  const gb = bytes / 1073741824;
  return gb >= 1 ? gb.toFixed(1) + ' GB' : (bytes / 1048576).toFixed(0) + ' MB';
}

function cloudInitSupport(img) {
  const n = ((img.name || '') + ' ' + (img.os_distro || '')).toLowerCase();
  const fmt = (img.disk_format || '').toLowerCase();
  if (n.includes('coreos')) {
    return { level: 'no', label: '✗ no cloud-init (Ignition)', title: 'CoreOS images use Ignition and ignore #cloud-config — post-provision scripts will NOT run.' };
  }
  if (fmt === 'iso' || /\.iso(\s|$)/.test(n)) {
    return { level: 'no', label: '✗ installer ISO', title: 'This is an installer ISO, not a cloud image — post-provision scripts will NOT run.' };
  }
  if (n.includes('vmware') || n.includes('vporter')) {
    return { level: 'unknown', label: '? cloud-init unknown', title: 'Migrated image — cloud-init may not be installed, so scripts may not run.' };
  }
  const distros = ['ubuntu', 'debian', 'centos', 'alma', 'rocky', 'rhel', 'fedora', 'suse', 'cirros'];
  if (distros.some((d) => n.includes(d))) {
    return { level: 'yes', label: '✓ cloud-init ready', title: 'Standard cloud image — post-provision scripts should run on first boot.' };
  }
  return { level: 'unknown', label: '? cloud-init unknown', title: 'Could not tell from image metadata whether cloud-init is installed — scripts may not run.' };
}

function ciBadge(img) {
  const ci = cloudInitSupport(img);
  const cls = ci.level === 'yes' ? 'active' : ci.level === 'no' ? 'off' : 'warn';
  return `<span class="badge ${cls}" title="${esc(ci.title)}">${esc(ci.label)}</span>`;
}

function renderTemplates() {
  const q = (document.getElementById('tplSearch')?.value || '').trim().toLowerCase();
  const list = images.filter((i) => !q || (i.name || '').toLowerCase().includes(q));
  const grid = document.getElementById('tplGrid');
  if (!grid) return;
  if (!list.length) {
    grid.innerHTML = '<div class="empty">No templates found.</div>';
    return;
  }
  grid.innerHTML = list.map((img) => `
    <div class="card">
      <div class="os-icon">${osIcon(img)}</div>
      <h3>${esc(img.name || img.id)}</h3>
      <div class="meta">
        <span>${esc(img.os_distro || 'unknown os')}${img.os_version ? ' ' + esc(img.os_version) : ''}</span>
        <span>${fmtSize(img.size)}</span>
        <span>min disk ${img.min_disk || 0} GB</span>
      </div>
      <div><span class="badge active">ACTIVE</span> ${ciBadge(img)}</div>
      <div class="deploy-row"><button class="btn btn-primary" style="width:100%; justify-content:center" data-deploy="${esc(img.id)}">Deploy</button></div>
    </div>`).join('');
  grid.querySelectorAll('[data-deploy]').forEach((btn) =>
    btn.addEventListener('click', () => openDeploy(btn.dataset.deploy)));
}

document.getElementById('tplSearch')?.addEventListener('input', renderTemplates);
document.getElementById('tplRefresh')?.addEventListener('click', loadTemplates);

function openDeploy(imageId) {
  deployImage = images.find((i) => i.id === imageId);
  if (!deployImage) return;
  document.getElementById('deployTitle').textContent = 'Deploy: ' + (deployImage.name || deployImage.id);
  document.getElementById('deploySub').textContent = `Project “${session?.project}” on ${String(session?.baseUrl || '').replace(/https?:\/\//, '')}`;
  document.getElementById('depName').value = '';
  document.getElementById('depDisk').value = Math.max(deployImage.min_disk || 0, 20);
  document.getElementById('depFlavor').innerHTML = flavors.map((f) =>
    `<option value="${esc(f.id)}">${esc(f.name)} — ${f.vcpus} vCPU / ${Math.round((f.ram || 0) / 1024)} GB RAM</option>`).join('')
    || '<option value="">No flavors available</option>';
  document.getElementById('depNetwork').innerHTML = networks.map((n) =>
    `<option value="${esc(n.id)}">${esc(n.name || n.id)}</option>`).join('')
    || '<option value="">No networks available</option>';
  const sel = document.getElementById('depScript');
  sel.innerHTML = '<option value="">None — no post-provision script</option>'
    + scripts.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')
    + '<option value="__custom__">Custom — write your own…</option>';
  document.getElementById('depScriptContent').style.display = 'none';
  document.getElementById('depScriptContent').value = '';
  document.getElementById('depCiWarn').style.display = 'none';
  const st = document.getElementById('deployStatus');
  st.className = 'status-msg';
  st.textContent = '';
  document.getElementById('deployOverlay').classList.add('open');
}

function updateCiWarning() {
  const warn = document.getElementById('depCiWarn');
  const scriptChosen = !!document.getElementById('depScript').value;
  const ci = deployImage ? cloudInitSupport(deployImage) : null;
  if (scriptChosen && ci && ci.level !== 'yes') {
    warn.textContent = '⚠ ' + ci.title;
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }
}

document.getElementById('depScript')?.addEventListener('change', (e) => {
  const ta = document.getElementById('depScriptContent');
  const v = e.target.value;
  updateCiWarning();
  if (!v) { ta.style.display = 'none'; ta.value = ''; return; }
  ta.style.display = 'block';
  if (v === '__custom__') {
    ta.value = '#cloud-config\npackage_update: true\nruncmd:\n  - echo "provisioned by vz-bot marketplace"\n';
    return;
  }
  const s = scripts.find((x) => x.id === v);
  ta.value = s ? s.content : '';
});

document.getElementById('depCancel')?.addEventListener('click', () =>
  document.getElementById('deployOverlay').classList.remove('open'));

document.getElementById('depGo')?.addEventListener('click', async () => {
  const st = document.getElementById('deployStatus');
  const name = document.getElementById('depName').value.trim();
  const flavorRef = document.getElementById('depFlavor').value;
  const netId = document.getElementById('depNetwork').value;
  const diskGb = parseInt(document.getElementById('depDisk').value, 10);
  const userData = document.getElementById('depScript').value ? document.getElementById('depScriptContent').value.trim() : '';
  st.className = 'status-msg';
  st.textContent = '';
  if (!name) { st.className = 'status-msg error'; st.textContent = 'VM name is required.'; return; }
  if (!flavorRef) { st.className = 'status-msg error'; st.textContent = 'Pick a flavor.'; return; }
  if (!netId) { st.className = 'status-msg error'; st.textContent = 'Pick a network.'; return; }
  if (!diskGb || diskGb < (deployImage.min_disk || 1)) {
    st.className = 'status-msg error';
    st.textContent = `Boot volume must be at least ${deployImage.min_disk || 1} GB for this image.`;
    return;
  }
  const btn = document.getElementById('depGo');
  btn.disabled = true;
  btn.textContent = 'Deploying…';
  try {
    const payload = {
      name,
      imageRef: deployImage.id,
      flavorRef,
      networks: [{ uuid: netId }],
      volume_size: diskGb,
    };
    if (userData) payload.user_data = userData;
    const data = await apiPost('/api/vhi/servers', payload);
    st.className = 'status-msg ok';
    st.textContent = `Deployed! Server ID ${data.server?.id || '(pending)'} — first boot will run your script via cloud-init.`;
    toast(`VM “${name}” is deploying${userData ? ' with post-provision script' : ''}.`, 'ok');
    setTimeout(() => document.getElementById('deployOverlay').classList.remove('open'), 2500);
  } catch (err) {
    st.className = 'status-msg error';
    st.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Deploy';
  }
});

async function loadScripts() {
  try {
    const data = await apiGet('/api/vhi/marketplace/scripts');
    scripts = data.scripts || [];
    renderScripts();
  } catch (err) {
    toast('Failed to load scripts: ' + err.message, 'err');
  }
}

function renderScripts() {
  const tbody = document.getElementById('scriptRows');
  if (!tbody) return;
  if (!scripts.length) {
    tbody.innerHTML = '<tr><td colspan="4"><div class="empty">No scripts yet — add one.</div></td></tr>';
    return;
  }
  tbody.innerHTML = scripts.map((s) => `
    <tr>
      <td><strong>${esc(s.name)}</strong></td>
      <td class="desc">${esc(s.description || '')}</td>
      <td class="desc">${s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : '–'}</td>
      <td>
        <button class="btn btn-secondary" style="padding:.3rem .6rem;font-size:.8rem;" data-edit="${esc(s.id)}">Edit</button>
        <button class="btn btn-secondary" style="padding:.3rem .6rem;font-size:.8rem;" data-del="${esc(s.id)}">Delete</button>
      </td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openScriptEditor(b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteScript(b.dataset.del)));
}

function openScriptEditor(id = null) {
  editingScriptId = id;
  const s = id ? scripts.find((x) => x.id === id) : null;
  document.getElementById('scriptModalTitle').textContent = s ? 'Edit Script' : 'New Script';
  document.getElementById('scrName').value = s?.name || '';
  document.getElementById('scrDesc').value = s?.description || '';
  document.getElementById('scrContent').value = s?.content || '';
  const st = document.getElementById('scriptStatus');
  st.className = 'status-msg';
  st.textContent = '';
  document.getElementById('scriptOverlay').classList.add('open');
}

document.getElementById('newScriptBtn')?.addEventListener('click', () => openScriptEditor());
document.getElementById('scrCancel')?.addEventListener('click', () =>
  document.getElementById('scriptOverlay').classList.remove('open'));

document.getElementById('scrSave')?.addEventListener('click', async () => {
  const st = document.getElementById('scriptStatus');
  const body = {
    name: document.getElementById('scrName').value.trim(),
    description: document.getElementById('scrDesc').value.trim(),
    content: document.getElementById('scrContent').value,
  };
  if (editingScriptId) body.id = editingScriptId;
  try {
    await apiPost('/api/vhi/marketplace/scripts', body);
    document.getElementById('scriptOverlay').classList.remove('open');
    toast(`Script “${body.name}” saved.`, 'ok');
    loadScripts();
  } catch (err) {
    st.className = 'status-msg error';
    st.textContent = err.message;
  }
});

async function deleteScript(id) {
  const s = scripts.find((x) => x.id === id);
  if (!confirm(`Delete script “${s?.name}”? This cannot be undone.`)) return;
  try {
    await apiDelete('/api/vhi/marketplace/scripts/' + id);
    toast('Script deleted.', 'ok');
    loadScripts();
  } catch (err) {
    toast('Delete failed: ' + err.message, 'err');
  }
}

if (document.body.getAttribute('data-nav') === 'marketplace') {
  bootVhiSession(loadMarketplace);
}
