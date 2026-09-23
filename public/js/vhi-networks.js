'use strict';

// ── NETWORKS ──────────────────────────────────────────────────────────────

async function loadNetworks() {
  setRefreshing('netRefresh', true);
  document.getElementById('netBody').innerHTML = skeletonRows(5);
  try {
    const data = await apiGet('/api/vhi/networks');
    _nets = (data.networks || []).filter(n => !(n.name || '').toLowerCase().startsWith('ha network'));
    _subnets = data.subnets || [];
    renderNetworks('');
    hookSearch('netSearch', renderNetworks);
    document.getElementById('netBadge').textContent = _nets.length;
    document.getElementById('netCount').textContent = `${_nets.length} networks`;
    document.getElementById('statNets').textContent = _nets.length;
  } catch (err) {
    document.getElementById('netBody').innerHTML = emptyState('⚠️', 'Could not load networks: ' + err.message);
    toast('Networks: ' + err.message, 'err');
  } finally {
    setRefreshing('netRefresh', false);
  }
}

function renderNetworks(query) {
  const tbody = document.getElementById('netBody');
  const rows = _nets.map(n => {
    const subs = _subnets
      .filter(s => (n.subnets || []).includes(s.id))
      .map(s => s.cidr).join(', ') || '–';
    const isSystem = n.name === 'lb-mgmt-net' || (n.tags && n.tags.includes('system'));
    const sysBadge = isSystem ? '<span class="badge" style="background:rgba(255,255,255,0.12); color:var(--text-dim); font-size:0.68rem; margin-left:0.35rem; padding:0.1rem 0.35rem; border-radius:3px;">System</span>' : '';
    return `<tr>
      <td><strong>${escapeHtml(n.name || '–')}</strong>${sysBadge}<br><span class="mono">${n.id?.slice(0,8)}…</span></td>
      <td>${statusBadge(n.status)}</td>
      <td>${n['router:external'] ? '<span class="badge badge-active">External</span>' : '–'}</td>
      <td>${n.admin_state_up ? '<span class="badge badge-active">Up</span>' : '<span class="badge badge-error">Down</span>'}</td>
      <td class="mono text-dim">${subs}</td>
      <td style="text-align:right;">${isSystem ? '' : `<button class="act-btn act-danger" onclick="deleteNetworkRow('${n.id}')">Delete</button>`}</td>
    </tr>`;
  });
  const filtered = filterRows(rows, query);
  tbody.innerHTML = filtered.length ? filtered.join('') : emptyState('🌐', 'No networks found');
}

function netNameById(id) {
  if (!id) return '–';
  const n = _nets.find(x => x.id === id);
  return n ? (n.name || id.slice(0, 8) + '…') : String(id).slice(0, 8) + '…';
}

document.querySelectorAll('#netSubTabs .sub-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#netSubTabs .sub-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#panel-networks .tab-content-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const panel = document.getElementById('tab-net-' + tab.dataset.nettab);
    if (panel) panel.classList.add('active');
  });
});

async function deleteNetworkRow(id) {
  const n = _nets.find(x => x.id === id);
  const name = (n && n.name) || id;
  if (!confirm(`Delete network "${name}"? Subnets on this network are removed with it.`)) return;
  try {
    await apiDelete('/api/vhi/networks/' + id);
    toast('Network deleted', 'ok');
    loadNetworks();
  } catch (err) {
    toast('Delete failed: ' + err.message, 'err');
  }
}

function openCreateNetModal() {
  document.getElementById('newNetName').value = '';
  document.getElementById('newNetCidr').value = '';
  document.getElementById('newNetExternal').checked = false;
  openModal('createNetModal');
}
async function submitCreateNet() {
  const name = document.getElementById('newNetName').value.trim();
  const cidr = document.getElementById('newNetCidr').value.trim();
  if (!name) return toast('Name is required', 'warn');
  try {
    await apiPost('/api/vhi/networks', {
      name,
      cidr: cidr || undefined,
      external: document.getElementById('newNetExternal').checked,
    });
    closeModal('createNetModal');
    toast('Network created', 'ok');
    loadNetworks();
  } catch (err) {
    toast('Create failed: ' + err.message, 'err');
  }
}

function renderSgs(query) {
  const tbody = document.getElementById('sgBody');
  if (!tbody) return;
  const rows = (_sgs || []).map(sg => {
    const rules = (sg.security_group_rules || []).length;
    return `<tr>
      <td><strong>${escapeHtml(sg.name || '–')}</strong><br><span class="mono">${sg.id?.slice(0,8)}…</span></td>
      <td class="text-dim">${escapeHtml(sg.description || '–')}</td>
      <td>${rules}</td>
      <td style="text-align:right;"><button class="act-btn act-danger" onclick="deleteSgRow('${sg.id}')">Delete</button></td>
    </tr>`;
  });
  const filtered = filterRows(rows, query);
  tbody.innerHTML = filtered.length ? filtered.join('') : emptyState('🛡', 'No security groups found');
}

function openCreateSgModal() {
  document.getElementById('newSgName').value = '';
  document.getElementById('newSgDesc').value = '';
  openModal('createSgModal');
}
async function submitCreateSg() {
  const name = document.getElementById('newSgName').value.trim();
  if (!name) return toast('Name is required', 'warn');
  try {
    await apiPost('/api/vhi/security-groups', { name, description: document.getElementById('newSgDesc').value.trim() });
    closeModal('createSgModal');
    toast('Security group created', 'ok');
    loadSecurityGroups();
  } catch (err) {
    toast('Create failed: ' + err.message, 'err');
  }
}
async function deleteSgRow(id) {
  const sg = (_sgs || []).find(x => x.id === id);
  const name = (sg && sg.name) || id;
  if (!confirm(`Delete security group "${name}"?`)) return;
  try {
    await apiDelete('/api/vhi/security-groups/' + id);
    toast('Security group deleted', 'ok');
    loadSecurityGroups();
  } catch (err) {
    toast('Delete failed: ' + err.message, 'err');
  }
}

async function loadFloatingIPs() {
  const tbody = document.getElementById('fipBody');
  if (tbody) tbody.innerHTML = skeletonRows(5);
  try {
    const data = await apiGet('/api/vhi/floating-ips');
    _fips = data.floatingips || [];
    renderFips('');
  } catch (err) {
    if (tbody) tbody.innerHTML = emptyState('⚠️', 'Could not load floating IPs: ' + err.message);
  }
}
function renderFips(query) {
  const tbody = document.getElementById('fipBody');
  if (!tbody) return;
  const rows = (_fips || []).map(f => {
    const assigned = f.fixed_ip_address || f.port_id || '';
    return `<tr>
      <td class="mono"><strong>${escapeHtml(f.floating_ip_address || '–')}</strong></td>
      <td>${statusBadge(f.status)}</td>
      <td>${escapeHtml(netNameById(f.floating_network_id))}</td>
      <td class="text-dim">${escapeHtml(assigned || 'Unassigned')}</td>
      <td style="text-align:right;">
        ${f.port_id ? `<button class="act-btn" onclick="disassociateFip('${f.id}')">Disassociate</button>` : ''}
        <button class="act-btn act-danger" onclick="deleteFipRow('${f.id}')">Release</button>
      </td>
    </tr>`;
  });
  const filtered = filterRows(rows, query);
  tbody.innerHTML = filtered.length ? filtered.join('') : emptyState('🌐', 'No floating IPs');
}
function openCreateFipModal() {
  const ext = _nets.filter(n => n['router:external']);
  document.getElementById('newFipNetwork').innerHTML = ext.length
    ? ext.map(n => `<option value="${n.id}">${escapeHtml(n.name || n.id)}</option>`).join('')
    : '<option value="">No external networks</option>';
  const vmPorts = (_ports || []).filter(p => (p.device_owner || '').startsWith('compute:'));
  document.getElementById('newFipPort').innerHTML = '<option value="">Unassigned</option>' +
    vmPorts.map(p => {
      const ip = (p.fixed_ips && p.fixed_ips[0] && p.fixed_ips[0].ip_address) || '';
      return `<option value="${p.id}">${escapeHtml((p.device_owner || 'port') + ' ' + ip)}</option>`;
    }).join('');
  openModal('createFipModal');
}
async function submitCreateFip() {
  const floating_network_id = document.getElementById('newFipNetwork').value;
  if (!floating_network_id) return toast('Select an external network', 'warn');
  const port_id = document.getElementById('newFipPort').value;
  try {
    await apiPost('/api/vhi/floating-ips', { floating_network_id, port_id: port_id || undefined });
    closeModal('createFipModal');
    toast('Floating IP allocated', 'ok');
    loadFloatingIPs();
  } catch (err) {
    toast('Allocate failed: ' + err.message, 'err');
  }
}
async function disassociateFip(id) {
  try {
    await apiPatch('/api/vhi/floating-ips/' + id, { port_id: null });
    toast('Floating IP disassociated', 'ok');
    loadFloatingIPs();
  } catch (err) {
    toast('Disassociate failed: ' + err.message, 'err');
  }
}
async function deleteFipRow(id) {
  if (!confirm('Release this floating IP?')) return;
  try {
    await apiDelete('/api/vhi/floating-ips/' + id);
    toast('Floating IP released', 'ok');
    loadFloatingIPs();
  } catch (err) {
    toast('Release failed: ' + err.message, 'err');
  }
}

async function loadRouters() {
  const tbody = document.getElementById('rtrBody');
  if (tbody) tbody.innerHTML = skeletonRows(5);
  try {
    const data = await apiGet('/api/vhi/routers');
    _routers = data.routers || [];
    renderRouters('');
  } catch (err) {
    if (tbody) tbody.innerHTML = emptyState('⚠️', 'Could not load routers: ' + err.message);
  }
}
function renderRouters(query) {
  const tbody = document.getElementById('rtrBody');
  if (!tbody) return;
  const rows = (_routers || []).map(r => {
    const extId = r.external_gateway_info && r.external_gateway_info.network_id;
    const snat = r.external_gateway_info
      ? (r.external_gateway_info.enable_snat !== false ? 'Enabled' : 'Disabled')
      : '–';
    return `<tr>
      <td><strong>${escapeHtml(r.name || '–')}</strong></td>
      <td>${statusBadge(r.status)}</td>
      <td>${escapeHtml(netNameById(extId))}</td>
      <td>${snat}</td>
      <td style="text-align:right;">
        <button class="act-btn" onclick="addRouterIface('${r.id}')">Interface</button>
        <button class="act-btn act-danger" onclick="deleteRouterRow('${r.id}')">Delete</button>
      </td>
    </tr>`;
  });
  const filtered = filterRows(rows, query);
  tbody.innerHTML = filtered.length ? filtered.join('') : emptyState('🔀', 'No routers');
}
function openCreateRouterModal() {
  document.getElementById('newRtrName').value = '';
  const ext = _nets.filter(n => n['router:external']);
  document.getElementById('newRtrExt').innerHTML = '<option value="">None</option>' +
    ext.map(n => `<option value="${n.id}">${escapeHtml(n.name || n.id)}</option>`).join('');
  openModal('createRouterModal');
}
async function submitCreateRouter() {
  const name = document.getElementById('newRtrName').value.trim();
  if (!name) return toast('Name is required', 'warn');
  const extId = document.getElementById('newRtrExt').value;
  const body = { name };
  if (extId) body.external_gateway_info = { network_id: extId };
  try {
    await apiPost('/api/vhi/routers', body);
    closeModal('createRouterModal');
    toast('Router created', 'ok');
    loadRouters();
  } catch (err) {
    toast('Create failed: ' + err.message, 'err');
  }
}
async function addRouterIface(routerId) {
  const labels = (_subnets || []).map(s => `${s.cidr}  ${s.name || s.id}`).join('\n');
  const cidr = prompt('Attach a subnet — enter CIDR or subnet ID:\n' + labels);
  if (!cidr) return;
  const sub = (_subnets || []).find(s => s.cidr === cidr.trim() || s.id === cidr.trim() || s.name === cidr.trim());
  if (!sub) return toast('Subnet not found', 'warn');
  try {
    await apiPost(`/api/vhi/routers/${routerId}/add-interface`, { subnet_id: sub.id });
    toast('Interface added', 'ok');
    loadRouters();
    loadPortsList();
  } catch (err) {
    toast('Add interface failed: ' + err.message, 'err');
  }
}
async function deleteRouterRow(id) {
  const r = (_routers || []).find(x => x.id === id);
  const name = (r && r.name) || id;
  if (!confirm(`Delete router "${name}"?`)) return;
  try {
    await apiDelete('/api/vhi/routers/' + id);
    toast('Router deleted', 'ok');
    loadRouters();
  } catch (err) {
    toast('Delete failed: ' + err.message, 'err');
  }
}

async function loadPortsList() {
  const tbody = document.getElementById('portBody');
  if (tbody) tbody.innerHTML = skeletonRows(5);
  try {
    const data = await apiGet('/api/vhi/ports');
    _ports = data.ports || [];
    renderPorts('');
  } catch (err) {
    if (tbody) tbody.innerHTML = emptyState('⚠️', 'Could not load ports: ' + err.message);
  }
}
function renderPorts(query) {
  const tbody = document.getElementById('portBody');
  if (!tbody) return;
  const rows = (_ports || []).map(p => {
    const ip = (p.fixed_ips && p.fixed_ips[0] && p.fixed_ips[0].ip_address) || '–';
    return `<tr>
      <td class="mono">${p.id?.slice(0,8)}…</td>
      <td>${statusBadge(p.status)}</td>
      <td class="mono text-dim">${escapeHtml(p.mac_address || '–')}</td>
      <td class="mono">${escapeHtml(ip)}</td>
      <td class="text-dim">${escapeHtml(p.device_owner || '–')}</td>
    </tr>`;
  });
  const filtered = filterRows(rows, query);
  tbody.innerHTML = filtered.length ? filtered.join('') : emptyState('🔌', 'No ports');
}


hookSearch('sgSearch', renderSgs);
hookSearch('fipSearch', renderFips);
hookSearch('rtrSearch', renderRouters);
hookSearch('portSearch', renderPorts);

window.openCreateNetModal = openCreateNetModal;
window.submitCreateNet = submitCreateNet;
window.deleteNetworkRow = deleteNetworkRow;
window.openCreateSgModal = openCreateSgModal;
window.submitCreateSg = submitCreateSg;
window.deleteSgRow = deleteSgRow;
window.openCreateFipModal = openCreateFipModal;
window.submitCreateFip = submitCreateFip;
window.disassociateFip = disassociateFip;
window.deleteFipRow = deleteFipRow;
window.openCreateRouterModal = openCreateRouterModal;
window.submitCreateRouter = submitCreateRouter;
window.addRouterIface = addRouterIface;
window.deleteRouterRow = deleteRouterRow;
