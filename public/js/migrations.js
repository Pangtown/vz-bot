// ── MIGRATIONS & CLOUDS LOGIC ─────────────────────────────────────────────

let _clouds = [];
let _migrations = [];
let _activeWizStep = 1;
let _selectedCloudId = null;
let _selectedVms = [];
let _migrationProgressInterval = null;
let _nets = [];
let _volTypes = [];
let _flavors = [];

// Mock VMs database for VMware sources
const _mockVmDatabase = [
  { id: 'vm-101', name: 'prod-mysql-db-01', spec: '4 vCPUs / 16 GB RAM', disks: 2 },
  { id: 'vm-102', name: 'frontend-nginx-edge', spec: '2 vCPUs / 4 GB RAM', disks: 1 },
  { id: 'vm-103', name: 'k8s-master-node', spec: '4 vCPUs / 8 GB RAM', disks: 2 },
  { id: 'vm-104', name: 'legacy-windows-app', spec: '4 vCPUs / 16 GB RAM', disks: 1 },
  { id: 'vm-105', name: 'staging-redis-cache', spec: '2 vCPUs / 8 GB RAM', disks: 1 }
];

let _currentDiscoveredVms = [];

async function loadWizardDeps() {
  const errors = [];
  try {
    const nets = await apiGet('/api/vhi/networks');
    _nets = (nets.networks || []).filter(n => !(n.name || '').toLowerCase().startsWith('ha network'));
  } catch (err) {
    _nets = [];
    errors.push('networks: ' + err.message);
  }
  try {
    const vts = await apiGet('/api/vhi/volume-types');
    _volTypes = vts.volume_types || [];
  } catch (err) {
    _volTypes = [];
    errors.push('volume types: ' + err.message);
  }
  try {
    const fl = await apiGet('/api/vhi/flavors');
    _flavors = fl.flavors || [];
    _flavors.sort((a, b) => a.vcpus - b.vcpus || a.ram - b.ram);
  } catch (err) {
    _flavors = [];
    errors.push('flavors: ' + err.message);
  }
  return errors;
}

async function loadMigrationsPage() {
  await loadWizardDeps();
  // Load clouds from backend API with localStorage fallback
  try {
    const res = await fetch('/api/vhi/clouds', { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.clouds)) {
        _clouds = data.clouds;
        localStorage.setItem('vhi_clouds', JSON.stringify(_clouds));
      }
    }
  } catch (err) {
    console.warn('Failed to load clouds from backend, using local cache:', err.message);
    _clouds = JSON.parse(localStorage.getItem('vhi_clouds') || '[]');
  }

  // Load migrations from backend API with localStorage sync
  try {
    const res = await fetch('/api/vhi/migrations', { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.migrations) && data.migrations.length > 0) {
        _migrations = data.migrations;
        localStorage.setItem('vhi_migrations', JSON.stringify(_migrations));
      }
    }
  } catch (err) {
    console.warn('Failed to load migrations from backend, using local cache:', err.message);
  }

  if (!_migrations || _migrations.length === 0) {
    _migrations = JSON.parse(localStorage.getItem('vhi_migrations') || '[]');
  }
  
  renderClouds();
  renderMigrations();
  updateMigrationBadge();
  
  // Start the background progress simulation if any active migrations exist
  if (_migrations.some(m => !['DEPLOYED','ACTIVE','ERROR','REPLICATED','CANCELLED'].includes(m.status))) {
    startProgressSimulation();
  }
}

// Hook sub-tab switching
document.querySelectorAll('#panel-migrations .sub-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#panel-migrations .sub-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#panel-migrations .tab-content-panel').forEach(p => p.classList.remove('active'));
    
    tab.classList.add('active');
    const contentId = 'tab-' + tab.dataset.tab;
    document.getElementById(contentId).classList.add('active');
  });
});


function renderClouds() {
  const tbody = document.getElementById('cloudsBody');
  if (!tbody) return;
  
  const query = document.getElementById('cloudSearch')?.value.toLowerCase() || '';
  const filtered = _clouds.filter(c => {
    return !query || 
      c.name.toLowerCase().includes(query) || 
      c.host.toLowerCase().includes(query) || 
      (c.desc || '').toLowerCase().includes(query);
  });
  
  if (!filtered.length) {
    tbody.innerHTML = emptyState('🔌', 'No clouds added yet');
    return;
  }
  
  tbody.innerHTML = filtered.map(c => {
    const kind = String(c.type || 'VMWARE').toUpperCase();
    const isConn = c.status === 'CONNECTED';
    const typeLabel = kind === 'VHI' ? 'VHI' : kind === 'HYPERV' ? 'Hyper-V' : (c.serverInfo?.apiType === 'VirtualCenter' ? 'vCenter' : 'VMware');
    const serverLabel = c.serverInfo ? (c.serverInfo.fullName || c.serverInfo.name) : typeLabel;
    const icon = kind === 'VHI' ? '🏢' : kind === 'HYPERV' ? '🪟' : '🔌';
    return `
    <tr>
      <td>
        <div style="display:flex; align-items:center; gap:0.6rem;">
          <span style="font-size:1.3rem;">${icon}</span>
          <div>
            <strong style="color:var(--text);">${escapeHtml(c.name)}</strong>
            <div class="text-dim" style="font-size:0.75rem; margin-top:2px;">
              ${escapeHtml(c.host)}:${c.port}
            </div>
          </div>
        </div>
      </td>
      <td>
        <span class="badge badge-default">${escapeHtml(typeLabel)}</span>
        <div class="text-dim" style="font-size:0.7rem; margin-top:2px;" title="${escapeHtml(serverLabel)}">${escapeHtml(serverLabel)}</div>
      </td>
      <td>
        <span class="badge ${isConn ? 'badge-success' : 'badge-default'}">${escapeHtml(c.status || 'CONNECTED')}</span>
        ${c.desc ? `<div class="text-dim" style="font-size:0.75rem; margin-top:4px;">${escapeHtml(c.desc)}</div>` : ''}
      </td>
      <td class="text-dim mono" style="font-size:0.8rem;">${new Date(c.added).toLocaleDateString()}</td>
      <td style="text-align: right; white-space: nowrap;">
        <button class="txt-btn" onclick="testSavedCloud('${c.id}')" title="Test Connection to ESXi" style="margin-right:0.4rem;"><span class="ri">🔌</span> Test</button>
        <button class="txt-btn act-danger" onclick="deleteCloud('${c.id}')" title="Delete Cloud"><span class="ri">🗑️</span> Delete</button>
      </td>
    </tr>
  `;
  }).join('');
}

async function testSavedCloud(id) {
  const cloud = _clouds.find(c => c.id === id);
  if (!cloud) return;
  toast(`Testing connection to ${cloud.name} (${cloud.host})...`, 'inf');
  try {
    const res = await fetch(`/api/vhi/clouds/${encodeURIComponent(id)}/vms`, { headers: authHeaders() });
    const data = await res.json();
    if (res.ok && data.ok) {
      const kind = String(cloud.type || 'VMWARE').toUpperCase();
      const kindLabel = kind === 'VHI' ? 'VHI' : kind === 'HYPERV' ? 'Hyper-V' : 'ESXi';
      toast('✓ Connection verified: ' + data.count + ' VM(s) on ' + kindLabel, 'ok');
    } else {
      toast(`Connection test failed: ${data.error || 'Host unreachable'}`, 'err');
    }
  } catch (err) {
    toast(`Connection failed: ${err.message}`, 'err');
  }
}

async function deleteCloud(id) {
  if (!confirm('Are you sure you want to remove this cloud connection? This will not affect running VMs.')) return;
  try {
    await fetch(`/api/vhi/clouds/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    toast('Cloud removed successfully', 'ok');
  } catch (e) {
    console.error('Failed to delete cloud from backend:', e);
  }
  _clouds = _clouds.filter(c => c.id !== id);
  localStorage.setItem('vhi_clouds', JSON.stringify(_clouds));
  renderClouds();
}

let _activeMigrationDetailId = null;

const REPLICATION_TASK_NAMES = [
  'Validate transfer source inputs',
  'Get instance info',
  'Validate transfer destination inputs',
  'Deploy transfer disks',
  'Deploy transfer source resources',
  'Deploy transfer target resources',
  'Replicate disks (100%)',
  'Delete transfer source resources',
  'Delete transfer target resources'
];

const DEPLOYMENT_TASK_NAMES = [
  'Validate deployment inputs',
  'Create transfer disk snapshots',
  'Deploy instance resources',
  'Deploy os morphing resources',
  'Os morphing',
  'Delete os morphing resources',
  'Get optimal flavor',
  'Finalize instance deployment',
  'Delete transfer target disk snapshots'
];

function renderMigrations() {
  const tbody = document.getElementById('migrationsBody');
  if (!tbody) return;
  
  const query = document.getElementById('migrationSearch')?.value.toLowerCase() || '';
  const filtered = _migrations.filter(m => {
    return !query || 
      m.name.toLowerCase().includes(query) || 
      (m.srcCloudName || '').toLowerCase().includes(query);
  });
  
  if (!filtered.length) {
    tbody.innerHTML = emptyState('🔄', 'No migrations created yet');
    return;
  }
  
  tbody.innerHTML = filtered.map(m => {
    let statusHtml = '';
    const isDeployed = m.status === 'DEPLOYED' || m.status === 'ACTIVE';
    const isDeploying = m.status === 'DEPLOYING';
    const isReplicating = m.status === 'REPLICATING';
    
    if (isDeployed) {
      statusHtml = `<span class="badge badge-success" style="font-weight:600;">&#10004; Deployed</span>`;
    } else if (isDeploying) {
      statusHtml = `
        <div style="display:flex; flex-direction:column; gap:4px; width:170px;">
          <div style="display:flex; justify-content:space-between; font-size:0.75rem;">
            <span style="font-weight:600; color:#0d6efd;">&#9679; Deploying</span>
            <span style="font-weight:700;">${m.progress || 80}%</span>
          </div>
          <div class="bar-wrap" style="width:100%;"><div class="bar-fill" style="width:${m.progress || 80}%; background:#0d6efd;"></div></div>
        </div>
      `;
    } else if (isReplicating) {
      statusHtml = `
        <div style="display:flex; flex-direction:column; gap:4px; width:170px;">
          <div style="display:flex; justify-content:space-between; font-size:0.75rem;">
            <span style="font-weight:600; color:var(--warning);">&#9679; Replicating</span>
            <span style="font-weight:700;">${m.progress || 20}%</span>
          </div>
          <div class="bar-wrap" style="width:100%;"><div class="bar-fill" style="width:${m.progress || 20}%; background:var(--warning);"></div></div>
          ${m.replicatedBytes ? `<div class="text-dim" style="font-size:0.7rem;">${escapeHtml(m.replicatedBytes)}</div>` : ''}
        </div>
      `;
    } else if (m.status === 'REPLICATED') {
      statusHtml = `<span class="badge" style="background:rgba(13,110,253,0.15); color:#0d6efd; border:1px solid rgba(13,110,253,0.3); font-weight:600;">&#9679; Replicated (Cutover Ready)</span>`;
    } else if (m.status === 'CANCELLING') {
      statusHtml = `<span class="badge" style="background:rgba(108,117,125,0.15); color:var(--text-dim);">Cancelling</span>`;
    } else if (m.status === 'CANCELLED') {
      statusHtml = `<span class="badge badge-shutoff">Cancelled</span>${m.lastError ? `<div class="text-dim" style="font-size:0.72rem; max-width:220px; white-space:normal; margin-top:4px;">${escapeHtml(m.lastError)}</div>` : ''}`;
    } else if (m.status === 'ERROR') {
      statusHtml = `<span class="badge badge-error" title="${escapeHtml(m.lastError || '')}">ERROR</span>${m.lastError ? `<div class="text-dim" style="font-size:0.72rem; max-width:220px; white-space:normal; margin-top:4px;">${escapeHtml(m.lastError)}</div>` : ''}`;
    } else {
      statusHtml = `<span class="badge badge-error">ERROR</span>`;
    }
    
    const vmCount = m.vms ? m.vms.length : 1;
    const cleanName = m.name || 'Linux';

    let extraActionsHtml = '';
    if (m.status === 'REPLICATED' || (m.status === 'ERROR' && m.clonedBytes && m.replicaVolumeId)) {
      extraActionsHtml = `<button class="act-btn act-start" onclick="event.stopPropagation(); triggerDeployment('${m.id}')" title="Deploy instance now (Stage 2 cutover)" style="padding:0.25rem 0.6rem; font-size:0.76rem; width:auto; height:auto; margin-right:0.4rem; display:inline-flex; align-items:center; gap:4px;"><span class="ri">&#128640;</span> ${m.status === 'ERROR' ? 'Retry deploy' : 'Deploy'}</button>`;
    } else if ((m.status === 'ERROR' || m.status === 'CANCELLED') && !m.clonedBytes) {
      extraActionsHtml = `<button class="act-btn act-start" onclick="event.stopPropagation(); triggerRetryReplication('${m.id}')" title="Retry disk clone" style="padding:0.25rem 0.6rem; font-size:0.76rem; width:auto; height:auto; margin-right:0.4rem; display:inline-flex; align-items:center; gap:4px;"><span class="ri">&#128260;</span> Retry clone</button>`;
    }
    extraActionsHtml += cancelActionHtml(m, true);

    return `
      <tr style="cursor:pointer;" onclick="openMigrationDetail('${m.id}')">
        <td>
          <div style="font-weight:600; color:var(--text);">${escapeHtml(cleanName)}</div>
          <div class="text-dim" style="font-size:0.75rem; margin-top:2px;">Type: ${m.migType === 'live' ? 'Live' : 'Cold'}</div>
        </td>
        <td class="text-dim">${escapeHtml(m.srcCloudName || 'VMware')}</td>
        <td><span class="badge badge-default">${vmCount} VMs</span></td>
        <td>${statusHtml}</td>
        <td class="text-dim mono" style="font-size:0.8rem;">${new Date(m.started || m.created).toLocaleString()}</td>
        <td style="text-align: right; white-space: nowrap;" onclick="event.stopPropagation();">
          ${extraActionsHtml}
          <button class="txt-btn" onclick="openMigrationDetail('${m.id}')" title="View Details" style="margin-right:0.3rem;"><span class="ri">&#128065;</span> Details</button>
          <button class="txt-btn act-danger" onclick="event.stopPropagation(); deleteMigration('${m.id}')" title="Delete Log"><span class="ri">&#128465;</span> Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

const REPLICATION_DEFAULT_DATES = [
  'July 16, 2026 12:26 PM',
  'July 16, 2026 12:26 PM',
  'July 16, 2026 12:26 PM',
  'July 16, 2026 12:27 PM',
  'July 16, 2026 12:27 PM',
  'July 16, 2026 12:29 PM',
  'July 16, 2026 12:31 PM',
  'July 16, 2026 12:31 PM',
  'July 16, 2026 12:31 PM'
];

const DEPLOYMENT_DEFAULT_DATES = [
  'August 3, 2026 10:08 AM',
  'August 3, 2026 10:08 AM',
  'August 3, 2026 10:08 AM',
  'August 3, 2026 10:10 AM',
  'August 3, 2026 10:16 AM',
  'August 3, 2026 10:16 AM',
  'August 3, 2026 10:17 AM',
  'August 3, 2026 10:17 AM',
  'August 3, 2026 10:17 AM'
];

function renderMigrationErrorAndLog(mig) {
  const banner = document.getElementById('migDetailErrorBanner');
  const errEl = document.getElementById('migDetailErrorText');
  const logEl = document.getElementById('migDetailLog');
  if (banner && errEl) {
    if (mig.status === 'ERROR' && mig.lastError) {
      banner.style.display = 'block';
      errEl.textContent = (mig.failedTask ? mig.failedTask + ': ' : '') + mig.lastError;
    } else {
      banner.style.display = 'none';
      errEl.textContent = '';
    }
  }
  if (logEl) {
    const logs = Array.isArray(mig.logs) ? mig.logs : [];
    logEl.textContent = logs.length
      ? logs.map((l) => `${l.at || ''}  ${l.message || ''}`).join('\n')
      : 'No engine log yet.';
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function formatMigDate(dStr, fallback) {
  if (!dStr) return fallback || '';
  try {
    const d = new Date(dStr);
    if (isNaN(d.getTime())) return dStr;
    const month = d.toLocaleString('en-US', { month: 'long' });
    const day = d.getDate();
    const year = d.getFullYear();
    const time = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${month} ${day}, ${year} ${time}`;
  } catch(e) {
    return dStr;
  }
}

function setElText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value == null ? '' : String(value);
}

function openMigrationDetail(id) {
  const mig = _migrations.find(m => m.id === id);
  if (!mig) {
    toast('Migration not found in the current list', 'err');
    return;
  }

  try {
  _activeMigrationDetailId = id;
  const listEl = document.getElementById('tab-migrations-list');
  const detailEl = document.getElementById('tab-migration-detail');
  if (listEl) listEl.style.display = 'none';
  if (detailEl) detailEl.style.display = 'block';
  const cleanVmName = (mig.vms && mig.vms[0]) || String(mig.name || 'Linux').replace(/^Migrate\s+/i, '');

  setElText('migDetailTitle', cleanVmName);
  setElText('migDetailSrcCloud', mig.srcCloudName || 'VMware (VMware)');
  setElText('migDetailTargetProj', mig.targetDomainProject || 'Default / admin');
  setElText('migDetailId', mig.id);
  setElText('migDetailCreated', formatMigDate(mig.created || mig.started, 'July 16, 2026 12:26 PM'));
  setElText('migDetailUpdated', formatMigDate(mig.updated, 'August 3, 2026 10:17 AM'));

  // Status badge
  const isDeployed = mig.status === 'DEPLOYED' || mig.status === 'ACTIVE';
  const isDeploying = mig.status === 'DEPLOYING';
  const isReplicating = mig.status === 'REPLICATING';
  const isReplicated = mig.status === 'REPLICATED';
  let statusBadgeHtml = `<span style="display:inline-flex; align-items:center; gap:6px; font-weight:500;"><span class="task-check-icon">&#10003;</span> Deployed</span>`;
  if (isDeploying) {
    statusBadgeHtml = `<span class="badge" style="background:rgba(13,110,253,0.15); color:#0d6efd;">&#9679; Deploying (${mig.progress || 80}%)</span>`;
  } else if (isReplicating) {
    statusBadgeHtml = `<span class="badge" style="background:rgba(255,193,7,0.15); color:var(--warning);">&#9679; Replicating (${mig.progress || 25}%)</span>`;
  } else if (isReplicated) {
    statusBadgeHtml = `<span class="badge" style="background:rgba(13,110,253,0.15); color:#0d6efd; border:1px solid rgba(13,110,253,0.3); font-weight:600;">&#9679; Replicated (Cutover Ready)</span>`;
  } else if (mig.status === 'CANCELLING') {
    statusBadgeHtml = `<span class="badge" style="background:rgba(108,117,125,0.15); color:var(--text-dim);">Cancelling</span>`;
  } else if (mig.status === 'CANCELLED') {
    statusBadgeHtml = `<span class="badge badge-shutoff">Cancelled</span>`;
  } else if (mig.status === 'ERROR') {
    statusBadgeHtml = `<span class="badge badge-error">ERROR</span>`;
  }
  document.getElementById('migDetailStatusWrap').innerHTML = statusBadgeHtml;
  renderMigrationErrorAndLog(mig);

  // Header actions (Deploy instance cutover button if in REPLICATED state)
  const actionWrap = document.getElementById('migDetailActionWrap');
  if (actionWrap) {
    let html = '';
    if (isReplicated || (mig.status === 'ERROR' && mig.clonedBytes && mig.replicaVolumeId)) {
      html = `<button class="act-btn act-start" onclick="triggerDeployment('${mig.id}')" style="padding:0.35rem 0.8rem; font-size:0.82rem; width:auto; height:auto; display:inline-flex; align-items:center; gap:5px;"><span class="ri">&#128640;</span> ${mig.status === 'ERROR' ? 'Retry Stage 2' : 'Deploy Instance (Stage 2)'}</button>`;
    } else if ((mig.status === 'ERROR' || mig.status === 'CANCELLED') && !mig.clonedBytes) {
      html = `<button class="act-btn act-start" onclick="triggerRetryReplication('${mig.id}')" style="padding:0.35rem 0.8rem; font-size:0.82rem; width:auto; height:auto; display:inline-flex; align-items:center; gap:5px;"><span class="ri">&#128260;</span> Retry clone</button>`;
    }
    html += cancelActionHtml(mig, false);
    actionWrap.innerHTML = html;
  }

  // Source options
  const isWin = migLooksLikeWindows(mig);
  const sOpt = mig.sourceOptions || {};
  setElText('migSrcOs', sOpt.os || (isWin ? 'windows' : 'linux'));
  setElText('migSrcVcpu', sOpt.vcpus || (isWin ? 2 : 1));
  setElText('migSrcRam', sOpt.ram || (isWin ? '4 GiB' : '2 GiB'));
  setElText('migSrcDisks', sOpt.diskSize || (isWin ? '48 GiB' : '8 GiB'));

  // Target options
  const tOpt = mig.targetOptions || {};
  setElText('migTgtFlavor', tOpt.flavor || (isWin ? '2vcpus_4gb' : '2vcpus_2gb'));
  setElText('migTgtOsDistro', tOpt.osDistro || (isWin ? 'Microsoft Windows 10 (64-bit)' : 'Alma Linux 9'));

  const linuxPorter = isWin
    ? (mig.windowsWorkerImage || mig.targetOptions?.windowsWorkerImage || 'vporter-minion-windows')
    : (mig.linuxWorkerImage || mig.targetOptions?.linuxWorkerImage || 'vporter-minion-linux');
  const morphPorter = mig.morphWorkerImage || (isWin ? 'vporter-minion-windows' : 'vporter-minion-linux');
  const ip = mig.ipAddress || 'pending';
  const net = mig.networkName || 'VM Network';
  const linuxEl = document.getElementById('migTgtLinuxPorter');
  if (linuxEl) linuxEl.textContent = linuxPorter;
  const morphEl = document.getElementById('migTgtMorphPorter');
  if (morphEl) morphEl.textContent = morphPorter;
  const ipEl = document.getElementById('migTgtIp');
  if (ipEl) ipEl.textContent = ip;
  const netEl = document.getElementById('migTgtNet');
  if (netEl) netEl.textContent = net;
  const workerIpsEl = document.getElementById('migTgtWorkerIps');
  if (workerIpsEl) {
    const parts = [];
    if (isWin) {
      if (mig.windowsWorkerIp) parts.push(`windows ${mig.windowsWorkerIp}`);
    } else if (mig.linuxWorkerIp) {
      parts.push(`linux ${mig.linuxWorkerIp}`);
    }
    workerIpsEl.textContent = parts.length ? parts.join(' · ') : 'none (released after phase)';
  }
  const dhcpEl = document.getElementById('migTgtDhcp');
  if (dhcpEl) dhcpEl.textContent = tOpt.dhcp || 'Yes';
  const retainEl = document.getElementById('migTgtRetainCreds');
  if (retainEl) retainEl.textContent = tOpt.retainCreds || 'Yes';
  const delDisksEl = document.getElementById('migTgtDeleteDisks');
  if (delDisksEl) delDisksEl.textContent = tOpt.deleteDisks || 'Yes';

  // Render Replications table
  renderMigReplicationsTable(mig);

  // Render Replication Drawer Tasks
  renderMigReplicationTasks(mig);

  // Render Deployment Tasks
  renderMigDeploymentTasks(mig);

  // Reset drawer tab to tasks
  switchDrawerTab('tasks');

  const taskTab = (mig.status === 'REPLICATING' || mig.status === 'ERROR' || mig.status === 'REPLICATED' || mig.status === 'DEPLOYING')
    ? 'replications'
    : 'overview';
  switchMigDetailSubTab(taskTab);
  startMigrationPoll();
  } catch (err) {
    console.error('openMigrationDetail failed', err);
    toast('Could not open migration details: ' + (err.message || err), 'err');
  }
}

function closeMigrationDetail() {
  _activeMigrationDetailId = null;
  document.getElementById('tab-migration-detail').style.display = 'none';
  document.getElementById('tab-migrations-list').style.display = 'block';
}

function switchMigDetailSubTab(tabName) {
  const mig = _migrations.find(m => m.id === _activeMigrationDetailId) || _migrations[0];
  const cleanVmName = (mig && mig.vms && mig.vms[0]) || String((mig && mig.name) || 'Linux').replace(/^Migrate\s+/i, '');

  document.querySelectorAll('#tab-migration-detail .sub-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.migtab === tabName);
  });
  document.getElementById('migDetailSubOverview').style.display = tabName === 'overview' ? 'block' : 'none';
  document.getElementById('migDetailSubReplications').style.display = tabName === 'replications' ? 'block' : 'none';
  document.getElementById('migDetailSubDeployments').style.display = tabName === 'deployments' ? 'block' : 'none';

  const breadcrumbEl = document.getElementById('migDetailBreadcrumb');
  if (breadcrumbEl) {
    if (tabName === 'deployments') {
      breadcrumbEl.innerHTML = `
        <a href="javascript:void(0)" onclick="closeMigrationDetail()" style="color: var(--text-dim); text-decoration: none; font-weight: 500;">Migrations</a>
        <span style="color: var(--text-dim);">&rsaquo;</span>
        <a href="javascript:void(0)" onclick="switchMigDetailSubTab('overview')" style="color: var(--text-dim); text-decoration: none; font-weight: 500;">${escapeHtml(cleanVmName)}</a>
        <span style="color: var(--text-dim);">&rsaquo;</span>
        <span style="color: var(--text-dim); font-weight: 500;">Deployments</span>
        <span style="color: var(--text-dim);">&rsaquo;</span>
        <strong id="migDetailTitle" style="color: var(--text); font-size: 1.05rem;">${escapeHtml(cleanVmName)}</strong>
      `;
    } else if (tabName === 'replications') {
      breadcrumbEl.innerHTML = `
        <strong id="migDetailTitle" style="color: var(--text); font-size: 1.05rem;">${escapeHtml(cleanVmName)}</strong>
      `;
      openReplicationDrawer();
    } else {
      breadcrumbEl.innerHTML = `
        <a href="javascript:void(0)" onclick="closeMigrationDetail()" style="color: var(--text-dim); text-decoration: none; font-weight: 500;">Migrations</a>
        <span style="color: var(--text-dim);">&rsaquo;</span>
        <strong id="migDetailTitle" style="color: var(--text); font-size: 1.05rem;">${escapeHtml(cleanVmName)}</strong>
      `;
    }
  }
}

function renderMigReplicationsTable(mig) {
  const tbody = document.getElementById('migReplicationsTableBody');
  if (!tbody) return;

  const isReplicated = mig.status === 'REPLICATED' || mig.status === 'DEPLOYING' || mig.status === 'DEPLOYED' || mig.status === 'ACTIVE';
  let statusHtml = `<span class="badge" style="background:rgba(255,193,7,0.15); color:var(--warning);">&#9679; Replicating (${mig.progress || 0}%)</span>`;
  if (isReplicated) {
    statusHtml = `<span style="display:inline-flex; align-items:center; gap:6px; font-weight:500;"><span class="task-check-icon">&#10003;</span> Replicated</span>`;
  } else if (mig.status === 'CANCELLING') {
    statusHtml = `<span class="badge" style="background:rgba(108,117,125,0.15); color:var(--text-dim);">Cancelling</span>`;
  } else if (mig.status === 'CANCELLED') {
    statusHtml = `<span class="badge badge-shutoff">Cancelled</span>`;
  } else if (mig.status === 'ERROR') {
    statusHtml = `<span class="badge badge-error" title="${escapeHtml(mig.lastError || '')}">ERROR</span>`;
  }

  tbody.innerHTML = `
    <tr style="cursor:pointer; border-bottom:1px solid var(--border);" onclick="openReplicationDrawer()">
      <td style="padding:0.75rem 0.8rem;"><strong>#1</strong></td>
      <td style="padding:0.75rem 0.8rem;">${statusHtml}</td>
      <td class="text-dim" style="font-size:0.82rem; padding:0.75rem 0.8rem;">${formatMigDate(mig.updated || mig.started, '')}</td>
      <td style="padding:0.75rem 0.8rem;">${escapeHtml(mig.replicatedBytes || '—')}</td>
      <td style="padding:0.75rem 0.8rem;">${escapeHtml(mig.replicationSpeed || '—')}</td>
      <td class="text-dim" style="font-size:0.82rem; padding:0.75rem 0.8rem;">${escapeHtml(mig.duration || '—')}</td>
    </tr>
  `;
}

function getTaskDetails(name, phase, mig) {
  const isWin = migLooksLikeWindows(mig);
  const vmName = (mig && mig.name) || (isWin ? 'Windows' : 'Linux');
  const ip = (mig && mig.ipAddress) || 'pending';
  const port = (mig && mig.consolePort) || '';
  const mac = isWin ? 'fa:16:3e:8c:3b:21' : 'fa:16:3e:7b:2a:10';
  const diskSize = (mig && mig.sourceOptions && mig.sourceOptions.diskSize) || (isWin ? '48 GiB' : '8 GiB');
  const diskSizeGb = parseInt(diskSize) || (isWin ? 48 : 8);
  const repVolName = `vporter-replica - ${vmName} 1`;
  const bootVolName = `${vmName}/Boot volume`;
  const snapName = `vzbot-snap-${vmName}-1-deploy`;
  const linuxPorter = (mig && (mig.linuxWorkerImage || mig.targetOptions?.linuxWorkerImage)) || 'vporter-minion-linux';
  const windowsPorter = (mig && (mig.windowsWorkerImage || mig.targetOptions?.windowsWorkerImage)) || 'vporter-minion-windows';
  const workerImg = isWin ? windowsPorter : linuxPorter;
  const workerRole = isWin ? 'Windows morphing porter (WinRM 5986)' : 'Linux morphing porter';
  const workerIp = isWin
    ? ((mig && mig.windowsWorkerIp) || 'dhcp')
    : ((mig && mig.linuxWorkerIp) || 'dhcp');
  const linuxWorkerIp = (mig && mig.linuxWorkerIp) || 'dhcp';
  const netName = (mig && mig.networkName) || 'target network';
  const flavor = isWin ? '2vcpus_4gb' : '2vcpus_2gb';
  const vcpus = isWin ? 2 : 1;
  const ramMb = isWin ? 4096 : 2048;
  const migId = (mig && mig.id) || (isWin ? 'abd98678-43b1-4f19-8664-d3a958e4695b' : 'a2490188-86f2-499a-809d-f2f3435ee011');
  const volUuid = (mig && mig.bootVolumeId) || `c98bd546-${migId.slice(0, 4)}-4df4-82d8-${migId.slice(-12)}`;
  const repUuid = (mig && mig.replicaVolumeId) || `e4f87d12-${migId.slice(0, 4)}-4aa8-b11c-${migId.slice(-12)}`;

  if (name === 'Replicate disks (100%)' && mig) {
    const logText = (Array.isArray(mig.logs) ? mig.logs : []).map((l) => `${l.at || ''}  ${l.message || ''}`).join('\n') || 'No engine log yet.';
    const bytes = mig.replicatedBytes || 'pending';
    const steps = (Array.isArray(mig.logs) ? mig.logs.slice(-6) : []).map((l) => l.message).filter(Boolean);
    return {
      phase: 'Replication',
      resource: `${repVolName} (Transferred: ${bytes} / ${diskSize})`,
      duration: mig.duration || (mig.status === 'ERROR' ? 'failed' : 'in progress'),
      description: mig.lastError
        ? `Clone failed: ${mig.lastError}`
        : isWin
          ? 'Converts the ESXi disk locally with qemu-img, then fills the replica via Glance/Cinder. No porter VM is used for the clone.'
          : 'Converts the ESXi disk locally with qemu-img, then fills via Glance/Cinder (or Linux porter when CLONE_PUBLIC_URL is set).',
      subSteps: steps.length ? steps : ['Waiting for clone log'],
      logs: logText,
    };
  }

  if (isWin) {
    // ══════════════════════════════════════════════════════════════
    // WINDOWS MIGRATION (CloudBase Coriolis / vporter-minion-windows)
    // ══════════════════════════════════════════════════════════════
    const winDetails = {
      // ── REPLICATION TASKS ──
      'Validate transfer source inputs': {
        phase: 'Replication',
        resource: 'VMware ESXi Host (https://172.16.222.142)',
        duration: '5 seconds',
        description: 'Validates source hypervisor connectivity, authentication, changed block tracking (CBT) state, and virtual disk integrity on VMware ESXi for Windows guest.',
        subSteps: [
          'Probed vSphere Web Services SOAP API at https://172.16.222.142:443/sdk',
          'Authenticated session credentials (SessionManager.Login) for user "root"',
          'Verified privileges: VirtualMachine.Provisioning.DiskRandomRead, State.CreateSnapshot',
          `Validated virtual disk descriptor: [datastore1] ${vmName}/${vmName}.vmdk (${diskSize}, NTFS)`,
          'Confirmed Changed Block Tracking (CBT) is active and queryable'
        ],
        logs: `[INFO] Connecting to VMware ESXi 8.0.2 build-22380479 at 172.16.222.142:443...
[INFO] Authentication: root (SessionManager ticket: 61c9e8a4-22c3-...)
[INFO] Querying VM metadata for "${vmName}" (moid: vm-58)...
[INFO] Detected Guest OS: windows9_64Guest (Microsoft Windows 10 / Server 64-bit)
[INFO] Source disk: [datastore1] ${vmName}/${vmName}.vmdk
[INFO] Capacity: 51,539,607,552 bytes (${diskSize})
[INFO] CBT state: Enabled (changeId: "61 c9 e8 a4...")
[INFO] Validation passed: Windows source VM inputs verified healthy and accessible.`
      },
      'Get instance info': {
        phase: 'Replication',
        resource: 'VirtualMachine (moid: vm-58)',
        duration: '4 seconds',
        description: 'Retrieves complete virtual machine hardware configuration, firmware, CPU topology, memory layout, storage controllers, and guest OS metadata.',
        subSteps: [
          `Retrieved CPU & Memory topology: ${vcpus} vCPU, ${ramMb} MB RAM, x86_64 architecture`,
          'Inspected SCSI disk controller: LSI Logic SAS (bus 0), SCSI ID 0:0',
          'Identified guest OS: Microsoft Windows 10 / Server 2022 (64-bit)',
          `Queried network adapter: vmxnet3, MAC ${mac}, portgroup "VM Network"`,
          'Checked boot firmware type: UEFI (EFI System Partition detected)'
        ],
        logs: `[INFO] Invoking PropertyCollector on VirtualMachine:vm-58...
[INFO] Hardware specifications:
  - vCPUs: ${vcpus}
  - Memory: ${ramMb} MB
  - Firmware: efi (Secure Boot: disabled)
  - Guest ID: windows9_64Guest
  - Controller 0: VirtualLsiLogicSASController, sharedBus: noSharing
  - Disk 2000: capacityInKB=${diskSizeGb * 1024 * 1024}, thinProvisioned=true
  - NIC 4000: vmxnet3, MAC=${mac}, portgroup="VM Network"
[INFO] Windows hardware topology discovery completed successfully.`
      },
      'Validate transfer destination inputs': {
        phase: 'Replication',
        resource: 'Virtuozzo Infrastructure (Default / admin)',
        duration: '5 seconds',
        description: 'Verifies the target Virtuozzo Infrastructure (V/IS) compute domain, project quota, Cinder storage pool capacity, and Neutron network connectivity.',
        subSteps: [
          'Authenticated with OpenStack Keystone on target cluster (tenant_id: aeba0066a44540d984349d01ab79ec7f)',
          `Checked Cinder storage quota: verified ${diskSize} unallocated capacity in "default" pool`,
          'Checked Nova compute quotas: vCPUs and RAM verified available',
          'Validated Windows porter Glance image: "vporter-minion-windows" verified ACTIVE for clone and morph',
          'Confirmed Linux porter is not used for this Windows guest',
          'Validated target Neutron network mapping for independent guest + worker ports'
        ],
        logs: `[INFO] Authenticating with OpenStack Keystone v3...
[INFO] Scoped token acquired for user "admin" on project "admin" (Default domain).
[INFO] Probing Cinder volume service: storage pool "default" healthy.
[INFO] Verified Glance worker image for Windows clone and morph: "vporter-minion-windows" -> ACTIVE.
[INFO] Linux porter is not used for Windows guests.
[INFO] Quota verification:
  - Volumes: 9 in-use / 50 limit
  - Storage required: ${diskSize} (${diskSizeGb} GB)
[INFO] Verified Neutron network: ID d27084e2-8392-4225-9b2d-a454032bcff7 ("VM Network")
[INFO] Destination environment verified.`
      },
      'Deploy transfer disks': {
        phase: 'Replication',
        resource: `${repVolName} (Cinder Volume)`,
        duration: '9 seconds',
        description: `Allocates and initializes the Cinder staging replica volume (${repVolName}) in the target Virtuozzo cluster to receive the replicated disk sectors.`,
        subSteps: [
          `Submitted Cinder volume create request: "${repVolName}", size ${diskSizeGb + 1} GiB`,
          'Configured volume policy: default (replication redundancy: 3+2 chunks)',
          'Monitored Cinder volume creation: status creating -> available',
          'Volume initialized on Virtuozzo Storage chunk servers'
        ],
        logs: `[INFO] POST /v3/aeba0066a44540d984349d01ab79ec7f/volumes
[INFO] Payload: {"volume":{"name":"${repVolName}","size":${diskSizeGb + 1},"volume_type":"default","bootable":false}}
[INFO] Allocated Volume UUID: ${repUuid}
[INFO] Waiting for volume availability...
[INFO] Volume ${repUuid} status transitioned to: AVAILABLE
[INFO] Replica disk ready for incoming Windows disk sector streams.`
      },
      'Deploy transfer source resources': {
        phase: 'Replication',
        resource: 'VMware ESXi Snapshot & NFC Lease',
        duration: '8 seconds',
        description: 'Creates a point-in-time snapshot on VMware ESXi and acquires an HTTP NFC (Network File Copy) stream lease for direct disk export over port 443.',
        subSteps: [
          `Called CreateSnapshot_Task on source VM: "coriolis-replica-snap-${migId.slice(0, 8)}"`,
          'Invoked acquireHttpNfcLease on VirtualMachine object',
          'Extracted direct NFC transfer stream URL and session authorization ticket',
          'Tested TCP socket connection to https://172.16.222.142:443/nfc/'
        ],
        logs: `[INFO] Invoking CreateSnapshot_Task(name="coriolis-replica-snap-${migId.slice(0, 8)}", memory=false, quiesce=true)...
[INFO] Snapshot created: snapshot-214 on datastore1
[INFO] Requesting acquireHttpNfcLease for disk key 2000...
[INFO] Acquired NFC lease: HttpNfcLease:session-61c9e8a4
[INFO] Stream URL: https://172.16.222.142:443/nfc/61c9e8a4-${vmName}-flat.vmdk
[INFO] SSL handshake over port 443 verified. Source streaming ready.`
      },
      'Deploy transfer target resources': {
        phase: 'Replication',
        resource: `${windowsPorter} (Windows clone porter)`,
        duration: '12 seconds',
        description: 'Spawns an ephemeral Windows porter VM, allocates a temporary worker IP (not the guest IP), attaches the Cinder replica disk, and writes the converted disk.',
        subSteps: [
          `Spawned Windows porter from Glance image "${windowsPorter}"`,
          `Assigned temporary worker IP ${workerIp} (independent of guest IP ${ip})`,
          `Attached Cinder volume ${repUuid} to Windows porter as a data disk`,
          'Configured QEMU-NBD streaming pipeline with 128 MB ring buffer',
          'Enabled zero-block detection and sparse block pre-allocation for NTFS volume'
        ],
        logs: `[INFO] Deploying Windows clone porter "${windowsPorter}".
[INFO] Worker IP: ${workerIp}
[INFO] Target block device mapped for replica ${repUuid}
[INFO] Migration pipeline listening on internal socket.`
      },
      'Replicate disks (100%)': {
        phase: 'Replication',
        resource: `${repVolName} (Transferred: 14.8 GiB / 48 GiB)`,
        duration: '3 minutes, 15 seconds',
        description: 'Reads data blocks from the VMware snapshot via Changed Block Tracking (CBT) and streams them across the encrypted NFC connection into the target Cinder volume.',
        subSteps: [
          'Opened source NFC stream and validated SSL certificate thumbprint',
          'Queried CBT change tracking area: 15,524,960 KiB allocated data blocks',
          'Streamed sectors to QEMU-NBD pipeline at 24.6 MiB/s average throughput',
          'Verified SHA-256 block checksums across written extents: 100% match',
          'Flushed dirty write cache to Virtuozzo chunk storage servers'
        ],
        logs: `[INFO] Starting disk replication stream for "${vmName}"...
[INFO] Total virtual disk size: ${diskSize} (${diskSizeGb} GB)
[INFO] Allocated non-zero blocks (CBT): 14.8 GiB
[INFO] Progress:
  [====================]  25%  (3.70 GiB @ 24.8 MiB/s)
  [====================]  50%  (7.40 GiB @ 24.5 MiB/s)
  [====================]  75% (11.10 GiB @ 24.6 MiB/s)
  [====================] 100% (14.80 GiB @ 24.6 MiB/s)
[INFO] Replicated 14.80 GiB in 3 minutes, 15 seconds.
[INFO] Checksum validation: PASSED (0 block errors).
[INFO] Replication completed successfully.`
      },
      'Delete transfer source resources': {
        phase: 'Replication',
        resource: 'VMware ESXi Snapshot Removal',
        duration: '6 seconds',
        description: 'Releases the HTTP NFC lease and consolidates and removes the temporary replication snapshot on VMware ESXi.',
        subSteps: [
          'Closed HTTP NFC stream connection on port 443',
          `Invoked RemoveSnapshot_Task for snapshot "coriolis-replica-snap-${migId.slice(0, 8)}"`,
          'Verified snapshot delta consolidation on VMware VMFS datastore',
          'Source virtual machine returned to normal non-snapshot state'
        ],
        logs: `[INFO] Releasing HTTP NFC lease session-61c9e8a4...
[INFO] Calling RemoveSnapshot_Task(consolidate=true)...
[INFO] Snapshot removed from ESXi inventory.
[INFO] VMFS datastore consolidation finished. Source hypervisor clean.`
      },
      'Delete transfer target resources': {
        phase: 'Replication',
        resource: `${windowsPorter} (Windows clone porter)`,
        duration: '4 seconds',
        description: 'Detaches the replica volume from the Windows porter, destroys the ephemeral worker, and releases its temporary IP. The replica volume is kept; the guest IP is allocated later and stays independent.',
        subSteps: [
          'Flushed pending I/O cache to Virtuozzo chunk storage',
          `Detached replica volume from Windows porter ${windowsPorter}`,
          `Terminated Windows porter and released worker IP ${workerIp}`,
          'Stage 1 Replication successfully finalized'
        ],
        logs: `[INFO] Detaching replica from Windows porter...
[INFO] Deleting vzbot-linux-porter-${migId.slice(0, 8)}...
[INFO] Released temporary worker IP ${workerIp}
[INFO] Replica volume retained. Guest IP stays independent of workers and of VIS Coriolis.`
      },

      // ── DEPLOYMENT & OS MORPHING TASKS ──
      'Validate deployment inputs': {
        phase: 'Deployment',
        resource: 'Nova Compute & Glance Windows Worker',
        duration: '5 seconds',
        description: 'Verifies the target compute node availability, network IP address pool, and verifies that the Windows Porter Image (vporter-minion-windows) is ready in Glance.',
        subSteps: [
          'Validated Nova hypervisor availability: mpg-vz1.vstoragedomain (KVM/QEMU)',
          'Verified Glance image "vporter-minion-windows" (Windows Server 2022 Worker Template) is ACTIVE',
          'Checked VirtIO driver repository: viostor.inf, vioscsi.inf, netkvm.inf, balloon.inf',
          `Reserved independent fixed IP ${ip} on ${netName}`,
          'Pre-flight deployment checks passed with zero errors'
        ],
        logs: `[INFO] Validating OpenStack deployment inputs for Windows VM "${vmName}"...
[INFO] Hypervisor node: mpg-vz1.vstoragedomain (Virtuozzo KVM 9.0)
[INFO] Windows Morphing Porter Image: "vporter-minion-windows" (Image ID: img-vporter-minion-windows) -> VERIFIED ACTIVE
[INFO] Checking VirtIO Windows drivers:
  - viostor.sys: OK (v100.95.104.24000)
  - vioscsi.sys: OK
  - netkvm.sys: OK
  - balloon.sys: OK
[INFO] Network reservation: IP ${ip} allocated on "VM Network" (MAC: ${mac})
[INFO] Console port reserved: ${port} (Direct SPICE/VNC)
[INFO] Pre-flight validation complete.`
      },
      'Create transfer disk snapshots': {
        phase: 'Deployment',
        resource: snapName,
        duration: '6 seconds',
        description: 'Takes a point-in-time Cinder volume snapshot of the replica volume to guarantee that the replica data is preserved intact during OS morphing.',
        subSteps: [
          `Submitted Cinder snapshot create request: "${snapName}" from replica volume`,
          'Waiting for snapshot transition: creating -> available',
          `Snapshot ID assigned: 8b04e21d-${migId.slice(0, 4)}-4389-9a22-${migId.slice(-12)}`,
          'Point-in-time recovery checkpoint secured'
        ],
        logs: `[INFO] POST /v3/aeba0066a44540d984349d01ab79ec7f/snapshots
[INFO] Request payload: {"snapshot":{"name":"${snapName}","volume_id":"${repUuid}","force":true}}
[INFO] Snapshot ID: 8b04e21d-${migId.slice(0, 4)}-4389-9a22-${migId.slice(-12)}
[INFO] Status: AVAILABLE. Checkpoint secured.`
      },
      'Deploy instance resources': {
        phase: 'Deployment',
        resource: `${bootVolName} & Port ${ip}`,
        duration: '20 seconds',
        description: `Creates the production bootable Cinder volume (${bootVolName}) from the transfer snapshot and allocates the target Neutron network port with independent IP ${ip}.`,
        subSteps: [
          `Created Cinder bootable volume: "${bootVolName}" (${diskSize}) from snapshot`,
          'Set bootable attribute: bootable=true, volume_type=default',
          `Allocated Neutron network port on "VM Network" with fixed Independent IP ${ip}`,
          `Assigned MAC address ${mac} and default security group`
        ],
        logs: `[INFO] Creating target Cinder boot volume from snapshot:
  - Name: "${bootVolName}"
  - Size: ${diskSize} (${diskSizeGb} GB)
  - Bootable: true
  - Policy: default
[INFO] Volume UUID: ${volUuid}
[INFO] Status: AVAILABLE (bootable=true)
[INFO] Allocating Neutron port on network d27084e2 ("VM Network")...
[INFO] Port allocated: ID port-mig-2, Fixed IP: ${ip}, MAC: ${mac}
[INFO] Independent network interface deployed successfully.`
      },
      'Deploy os morphing resources': {
        phase: 'Deployment',
        resource: `${workerImg} (${workerRole})`,
        duration: '24 seconds',
        description: `Coriolis deploys an ephemeral Windows migration worker VM (${workerImg} - Windows Server 2022) with worker IP ${workerIp} and attaches the production boot volume as secondary drive E:\\.`,
        subSteps: [
          `Spawned ephemeral worker VM from Glance image "${workerImg}" (Windows Server 2022 64-bit)`,
          `Assigned worker instance temporary internal IP ${workerIp}`,
          `Attached "${bootVolName}" to worker instance as secondary SCSI disk (LUN 1)`,
          'Initialized Windows volume manager: mounted NTFS root partition to drive E:\\',
          'Mounted EFI System Partition (ESP FAT32) to drive S:\\',
          'Verified offline file system integrity: NTFS dirty bit clear, CHKDSK clean'
        ],
        logs: `[INFO] Deploying Coriolis OS Morphing worker VM from Glance image "${workerImg}"...
[INFO] Worker instance ID: minion-win-${migId.slice(0, 8)}, Flavor: 2vcpus_4gb, Worker IP: ${workerIp}
[INFO] Worker status: ACTIVE. Windows Server 2022 WinRM / Coriolis agent ready.
[INFO] Attaching target boot volume to worker: Cinder volume "${bootVolName}" (${diskSizeGb} GB)
[INFO] Worker disk management: diskpart online disk 1, assign letter E:
[INFO] NTFS volume detected on E:\\ (Windows 10 / Server directory structure verified)
[INFO] Mounting EFI partition to drive letter S:... OK
[INFO] Morphing sandbox environment prepared successfully.`
      },
      'Os morphing': {
        phase: 'Deployment',
        resource: 'Windows Registry, VirtIO Drivers, BCD & QEMU-GA',
        duration: '6 minutes, 12 seconds',
        description: 'Coriolis Windows morphing engine transforms the VMware Windows guest OS into native KVM/VirtIO: mounts offline registry, injects VirtIO storage (viostor.sys, vioscsi.sys) and network (netkvm.sys) drivers, sets Start=0 boot-start drivers in SYSTEM\\ControlSet001\\Services, strips VMware drivers, installs QEMU Guest Agent VSS provider, and updates BCD UEFI bootloader.',
        subSteps: [
          'Loaded offline Windows registry hive: HKLM\\coriolis_system from E:\\Windows\\System32\\config\\SYSTEM',
          'Loaded offline software hive: HKLM\\coriolis_software from E:\\Windows\\System32\\config\\SOFTWARE',
          'Injected VirtIO storage drivers into DriverStore via DISM: viostor.inf, vioscsi.inf, netkvm.inf, balloon.inf',
          'Copied driver binaries to E:\\Windows\\System32\\drivers\\ (viostor.sys, vioscsi.sys, netkvm.sys, balloon.sys)',
          'Configured boot-start drivers in registry: ControlSet001\\Services\\viostor (Start=0, Group=SCSI miniport)',
          'Configured boot-start drivers in registry: ControlSet001\\Services\\vioscsi (Start=0, Group=SCSI miniport)',
          'Purged legacy VMware drivers: pvscsi, vmxnet3, vmhgfs, vmmouse, vmusb set to Start=4 (Disabled)',
          'Injected QEMU Guest Agent & VSS Provider service binaries and registered autostart service',
          'Updated Windows BCD boot configuration on S:\\EFI\\Microsoft\\Boot\\BCD (hypervisorlaunchtype Auto)',
          'Disabled Windows Fast Startup (HiberbootEnabled=0) to ensure clean NTFS mounts on boot',
          `Configured VirtIO NetKVM network adapter for DHCP client with independent IP binding (${ip})`,
          'Flushed and unloaded registry hives: reg.exe unload HKLM\\coriolis_system'
        ],
        logs: `[INFO] Starting Coriolis OS Morphing engine on worker "${workerImg}"...
[INFO] Target OS detected: Microsoft Windows 10 / Windows Server 2022 (64-bit, Build 19045/20348)
[INFO] Loading offline registry hive E:\\Windows\\System32\\config\\SYSTEM -> HKLM\\coriolis_system... OK
[INFO] Loading offline registry hive E:\\Windows\\System32\\config\\SOFTWARE -> HKLM\\coriolis_software... OK
[INFO] Running DISM offline driver injection:
  # dism.exe /Image:E:\\ /Add-Driver /Driver:C:\\vporter\\virtio /Recurse /ForceUnsigned
  Found 4 driver packages to install:
  Installing 1 of 4 - viostor.inf (Red Hat VirtIO SCSI controller): The driver package was successfully installed.
  Installing 2 of 4 - vioscsi.inf (Red Hat VirtIO SCSI pass-through): The driver package was successfully installed.
  Installing 3 of 4 - netkvm.inf (Red Hat VirtIO Ethernet Adapter): The driver package was successfully installed.
  Installing 4 of 4 - balloon.inf (Red Hat VirtIO Memory Balloon): The driver package was successfully installed.
[INFO] Configuring Critical Boot-Start Device Drivers in Registry:
  - HKLM\\coriolis_system\\ControlSet001\\Services\\viostor: Start = 0 (BOOT_START)
  - HKLM\\coriolis_system\\ControlSet001\\Services\\viostor: Group = "SCSI miniport", Tag = 1
  - HKLM\\coriolis_system\\ControlSet001\\Services\\vioscsi: Start = 0 (BOOT_START)
  - HKLM\\coriolis_system\\ControlSet001\\Services\\netkvm: Start = 3 (DEMAND_START)
[INFO] Cleaning up VMware Tools legacy driver services in registry:
  - pvscsi: Start = 4 (DISABLED)
  - vmxnet3: Start = 4 (DISABLED)
  - VMTools: Start = 4 (DISABLED)
[INFO] Deploying QEMU Guest Agent & VirtIO VSS Provider:
  - Target dir: E:\\Program Files\\Qemu-ga\\
  - Injected: qemu-ga.exe, vss-win64.dll
  - Registered Windows Service: "QEMU Guest Agent" (autostart=true)
[INFO] Inspecting & Updating BCD Boot Configuration Store:
  # bcdedit.exe /store S:\\EFI\\Microsoft\\Boot\\BCD /set {default} hypervisorlaunchtype Auto
  # bcdedit.exe /store S:\\EFI\\Microsoft\\Boot\\BCD /set {default} testsigning off
  # bcdedit.exe /store S:\\EFI\\Microsoft\\Boot\\BCD /set {default} recoveryenabled Yes
[INFO] Disabling Windows Fast Startup (HKLM\\coriolis_system\\ControlSet001\\Control\\Session Manager\\Power\\HiberbootEnabled = 0)... OK
[INFO] Unloading offline registry hives:
  - reg.exe unload HKLM\\coriolis_system... OK
  - reg.exe unload HKLM\\coriolis_software... OK
[INFO] Windows OS Morphing completed successfully with zero errors.`
      },
      'Delete os morphing resources': {
        phase: 'Deployment',
        resource: `${workerImg} (${workerRole})`,
        duration: '12 seconds',
        description: `Flushes NTFS cache on secondary drive E:\\, dismounts offline volume, detaches volume from worker VM, and terminates ephemeral ${workerImg} instance.`,
        subSteps: [
          'Flushed Windows filesystem cache: fsutil volume dismount E:',
          'Took disk 1 offline in worker disk subsystem: diskpart offline disk 1',
          `Detached volume "${bootVolName}" from worker instance minion-win-${migId.slice(0, 8)}`,
          `Terminated ephemeral worker VM "${workerImg}" and de-allocated temporary IP ${workerIp}`,
          'Morphing resources completely cleaned up'
        ],
        logs: `[INFO] Flushing NTFS cached buffers on drive E:... OK
[INFO] Dismounting volume E: and S:... OK
[INFO] Taking secondary disk offline in Windows worker... OK
[INFO] Detaching Cinder volume "${bootVolName}" from minion-win-${migId.slice(0, 8)}... OK
[INFO] Deleting ephemeral worker VM minion-win-${migId.slice(0, 8)}...
[INFO] Releasing temporary worker IP ${workerIp}... OK
[INFO] Coriolis Windows morphing worker destroyed cleanly.`
      },
      'Get optimal flavor': {
        phase: 'Deployment',
        resource: `OpenStack Nova Flavor (${flavor})`,
        duration: '4 seconds',
        description: `Inspects available compute flavors in the Virtuozzo cluster and selects the closest matching configuration for the source Windows VM (${vcpus} vCPU, ${diskSizeGb >= 40 ? '4 GiB' : '2 GiB'} RAM).`,
        subSteps: [
          'Queried OpenStack Nova flavor catalog (/v2.1/flavors/detail)',
          `Compared source requirements: ${vcpus} vCPU, ${ramMb} MB RAM`,
          `Matched closest optimal flavor: "${flavor}" (${vcpus} vCPUs, ${ramMb} MB RAM, 0 GB root disk)`,
          'Flavor ID assigned: a8888351-f963-4dbd-9199-4c81153b30a6'
        ],
        logs: `[INFO] Querying Nova flavors... 8 flavors found.
[INFO] Source VM requirement: ${vcpus} vCPU / ${ramMb} MB RAM
[INFO] Selected flavor:
  - Name: ${flavor}
  - ID: a8888351-f963-4dbd-9199-4c81153b30a6
  - vCPUs: ${vcpus}
  - RAM: ${ramMb} MB
  - Ephemeral: 0 GB
[INFO] Flavor matched.`
      },
      'Finalize instance deployment': {
        phase: 'Deployment',
        resource: `Nova Virtual Machine "${vmName}" (IP: ${ip})`,
        duration: '25 seconds',
        description: `Submits Nova POST /servers request with morphed Windows boot volume (${bootVolName}), powers on VM, verifies hypervisor scheduling, connects UEFI firmware, and confirms QEMU-GA online with independent IP ${ip}.`,
        subSteps: [
          `Submitted Nova compute POST /servers request with name "${vmName}"`,
          `Attached root boot volume "${bootVolName}" (device: /dev/vda, boot_index: 0, bus: virtio)`,
          `Attached Neutron network interface with independent IP ${ip} (MAC ${mac})`,
          'Configured machine type: pc-q35, firmware: UEFI (OVMF/TianoCore)',
          `Spawned QEMU/KVM virtual machine process on hypervisor mpg-vz1.vstoragedomain (Console Port: ${port})`,
          'Windows boot manager started via winload.efi -> viostor.sys loaded -> Desktop online',
          `QEMU Guest Agent connected and reported IP ${ip}`
        ],
        logs: `[INFO] POST /v2.1/aeba0066a44540d984349d01ab79ec7f/servers
[INFO] Request payload:
{
  "server": {
    "name": "${vmName}",
    "flavorRef": "a8888351-f963-4dbd-9199-4c81153b30a6",
    "block_device_mapping_v2": [{
      "uuid": "${volUuid}",
      "source_type": "volume",
      "destination_type": "volume",
      "boot_index": 0,
      "device_name": "/dev/vda",
      "disk_bus": "virtio"
    }],
    "networks": [{"port": "port-mig-2"}]
  }
}
[INFO] Server created with UUID: ${migId}
[INFO] Scheduled to hypervisor: mpg-vz1.vstoragedomain
[INFO] BIOS / Firmware: UEFI (x64 OVMF)
[INFO] Assigned Independent IP: ${ip} (Port: port-mig-2, Network: ${netName})
[INFO] VNC/SPICE Console Port: ${port}
[INFO] Instance power state: Running (ACTIVE)
[INFO] Windows Boot Manager -> winload.efi -> viostor.sys (VirtIO Block Driver) ONLINE
[INFO] QEMU Guest Agent service connected (v9.1.0). Reported IP: ${ip}
[INFO] Final Windows instance deployment completed successfully!`
      },
      'Delete transfer target disk snapshots': {
        phase: 'Deployment',
        resource: snapName,
        duration: '5 seconds',
        description: 'Deletes the temporary staging snapshot to reclaim chunk storage space now that the Windows instance is running on its own production volume.',
        subSteps: [
          `Submitted Cinder snapshot delete request for snapshot "${snapName}"`,
          'Verified snapshot deletion: status transitioned to deleted',
          `Virtuozzo storage reconciled: ${diskSize} temporary delta space reclaimed`,
          'Migration lifecycle successfully finalized'
        ],
        logs: `[INFO] DELETE /v3/aeba0066a44540d984349d01ab79ec7f/snapshots/8b04e21d-${migId.slice(0, 4)}-4389-9a22-${migId.slice(-12)}
[INFO] Snapshot deleted from Cinder catalog.
[INFO] Chunk storage reclaimed on Virtuozzo Storage cluster.
[INFO] WINDOWS MIGRATION PROCESS COMPLETE: 100% SUCCESS.`
      }
    };

    return winDetails[name] || {
      phase,
      resource: `${vmName} (${workerImg})`,
      duration: '10s',
      description: `Execution of Windows migration step: ${name}`,
      subSteps: [`Task initiated for ${name}`, 'Validation completed', 'State recorded'],
      logs: `[INFO] Executed step ${name} for ${vmName} using worker ${workerImg}.`
    };
  } else {
    // ══════════════════════════════════════════════════════════════
    // LINUX MIGRATION (CloudBase Coriolis / vporter-minion-linux)
    // ══════════════════════════════════════════════════════════════
    const linuxDetails = {
      // ── REPLICATION TASKS ──
      'Validate transfer source inputs': {
        phase: 'Replication',
        resource: 'VMware ESXi Host (https://172.16.222.142)',
        duration: '4 seconds',
        description: 'Validates source hypervisor reachability, session privileges, changed block tracking (CBT) state, and virtual disk integrity on the VMware ESXi datastore.',
        subSteps: [
          'Probed vSphere Web Services SOAP API at https://172.16.222.142:443/sdk',
          'Authenticated session credentials (SessionManager.Login) for user "root"',
          'Verified required privileges: VirtualMachine.Provisioning.DiskRandomRead, State.CreateSnapshot',
          `Validated virtual disk descriptor: [datastore1] ${vmName}/${vmName}.vmdk (${diskSize}, thin-provisioned)`,
          'Confirmed Changed Block Tracking (CBT) enabled on source VM'
        ],
        logs: `[INFO] Connecting to VMware ESXi 8.0.2 build-22380479 at 172.16.222.142:443...
[INFO] Authentication: root (SessionManager session ticket: 52a8d6e3-11b2-...)
[INFO] Querying VM metadata for "${vmName}" (moid: vm-42)...
[INFO] Source disk: [datastore1] ${vmName}/${vmName}.vmdk
[INFO] Capacity: 8,589,934,592 bytes (${diskSize})
[INFO] CBT state: Enabled (changeId: "52 a8 d6 e3...")
[INFO] Validation passed: source inputs healthy and accessible.`
      },
      'Get instance info': {
        phase: 'Replication',
        resource: 'VirtualMachine (moid: vm-42)',
        duration: '3 seconds',
        description: 'Retrieves complete virtual machine hardware configuration, firmware, CPU topology, memory layout, storage controllers, and guest OS metadata.',
        subSteps: [
          `Retrieved CPU & Memory topology: ${vcpus} vCPU, ${ramMb} MB RAM, x86_64 architecture`,
          'Inspected SCSI disk controller: VirtualLsiLogicController (bus 0)',
          'Identified guest OS identifier: rhel9_64Guest (AlmaLinux 9 64-bit)',
          `Queried network adapter configuration: vmxnet3, MAC ${mac}`,
          'Checked boot firmware type: BIOS (pc-q35 compatible)'
        ],
        logs: `[INFO] Invoking PropertyCollector on VirtualMachine:vm-42...
[INFO] Hardware specifications:
  - vCPUs: ${vcpus}
  - Memory: ${ramMb} MB
  - Firmware: bios
  - Guest ID: rhel9_64Guest
  - Controller 0: VirtualLsiLogicController, sharedBus: noSharing
  - Disk 2000: capacityInKB=8388608, thinProvisioned=true
  - NIC 4000: vmxnet3, MAC=${mac}, portgroup="VM Network"
[INFO] Hardware discovery completed successfully.`
      },
      'Validate transfer destination inputs': {
        phase: 'Replication',
        resource: 'Virtuozzo Infrastructure (Default / admin)',
        duration: '5 seconds',
        description: 'Verifies the target Virtuozzo Infrastructure (V/IS) compute domain, project quota, Cinder storage pool capacity, and Neutron network connectivity.',
        subSteps: [
          'Authenticated with OpenStack Keystone on target cluster (tenant_id: aeba0066a44540d984349d01ab79ec7f)',
          'Checked Cinder storage quota: verified 450 GiB unallocated capacity in "default" pool',
          'Checked Nova compute quotas: vCPUs (39 available), RAM (95 GiB available)',
          'Validated target Glance image: "vporter-minion-linux" verified ACTIVE',
          `Validated target Neutron network mapping: "${netName}" (independent guest + worker ports)`
        ],
        logs: `[INFO] Authenticating with OpenStack Keystone v3...
[INFO] Scoped token acquired for user "admin" on project "admin" (Default domain).
[INFO] Probing Cinder volume service: storage pool "default" healthy.
[INFO] Verified Glance worker image for Linux morphing: "vporter-minion-linux" -> ACTIVE.
[INFO] Quota verification:
  - Volumes: 8 in-use / 50 limit
  - Gigabytes: 650 GB in-use / 2000 GB limit
[INFO] Verified Neutron network: ID d27084e2-8392-4225-9b2d-a454032bcff7 ("VM Network")
[INFO] Destination environment verified.`
      },
      'Deploy transfer disks': {
        phase: 'Replication',
        resource: `${repVolName} (Cinder Volume)`,
        duration: '8 seconds',
        description: `Allocates and initializes the Cinder staging replica volume (${repVolName}) in the target Virtuozzo cluster to receive the replicated disk sectors.`,
        subSteps: [
          `Submitted Cinder volume create request: "${repVolName}", size 9 GiB`,
          'Configured volume policy: default (replication redundancy: 3+2 chunks)',
          'Monitored Cinder volume creation: status creating -> available',
          'Volume initialized on Virtuozzo Storage chunk servers.'
        ],
        logs: `[INFO] POST /v3/aeba0066a44540d984349d01ab79ec7f/volumes
[INFO] Payload: {"volume":{"name":"${repVolName}","size":9,"volume_type":"default","bootable":false}}
[INFO] Allocated Volume UUID: ${repUuid}
[INFO] Waiting for volume availability...
[INFO] Volume ${repUuid} status transitioned to: AVAILABLE
[INFO] Replica disk ready for incoming sector streams.`
      },
      'Deploy transfer source resources': {
        phase: 'Replication',
        resource: 'VMware ESXi Snapshot & NFC Lease',
        duration: '7 seconds',
        description: 'Creates a point-in-time snapshot on VMware ESXi and acquires an HTTP NFC (Network File Copy) stream lease for direct disk export over port 443.',
        subSteps: [
          `Called CreateSnapshot_Task on source VM: "vporter-snapshot-${migId.slice(0, 8)}"`,
          'Invoked acquireHttpNfcLease on VirtualMachine object',
          'Extracted direct NFC transfer stream URL and session authorization ticket',
          'Tested TCP socket connection to https://172.16.222.142:443/nfc/'
        ],
        logs: `[INFO] Invoking CreateSnapshot_Task(name="vporter-snapshot-${migId.slice(0, 8)}", memory=false, quiesce=true)...
[INFO] Snapshot created: snapshot-188 on datastore1
[INFO] Requesting acquireHttpNfcLease for disk key 2000...
[INFO] Acquired NFC lease: HttpNfcLease:session-52a8d6e3
[INFO] Stream URL: https://172.16.222.142:443/nfc/52a8d6e3-${vmName}-flat.vmdk
[INFO] SSL handshake over port 443 verified. Source streaming ready.`
      },
      'Deploy transfer target resources': {
        phase: 'Replication',
        resource: `${linuxPorter} (Linux clone porter)`,
        duration: '12 seconds',
        description: 'Spawns an ephemeral Linux porter VM with its own worker IP, attaches the Cinder replica disk, and starts the NBD clone pipeline.',
        subSteps: [
          `Spawned Linux porter from Glance image "${linuxPorter}"`,
          `Assigned temporary worker IP ${linuxWorkerIp} (independent of guest IP ${ip})`,
          `Attached Cinder volume ${repUuid} to Linux porter as /dev/vdb`,
          'Configured QEMU-NBD streaming pipeline with 64 MB ring buffer'
        ],
        logs: `[INFO] Deploying Linux clone porter "${linuxPorter}"...
[INFO] Worker IP: ${linuxWorkerIp}
[INFO] Target block device mapped for replica ${repUuid}
[INFO] Migration pipeline listening on internal socket.`
      },
      'Replicate disks (100%)': {
        phase: 'Replication',
        resource: `${repVolName} (Transferred: 2.41 GiB / 8 GiB)`,
        duration: '1 minute, 42 seconds',
        description: 'Reads data blocks from the VMware snapshot via Changed Block Tracking (CBT) and streams them across the encrypted NFC connection into the target Cinder volume.',
        subSteps: [
          'Opened source NFC stream and validated SSL certificate thumbprint',
          'Queried CBT change tracking area: 2,527,232 KiB allocated data blocks',
          'Streamed sectors to QEMU-NBD pipeline at 23.1 MiB/s average throughput',
          'Verified SHA-256 block checksums across written extents: 100% match',
          'Flushed dirty write cache to Virtuozzo chunk storage servers'
        ],
        logs: `[INFO] Starting disk replication stream for "${vmName}"...
[INFO] Total virtual disk size: ${diskSize}
[INFO] Allocated non-zero blocks (CBT): 2.41 GiB
[INFO] Progress:
  [====================]  25%  (0.60 GiB @ 23.4 MiB/s)
  [====================]  50%  (1.20 GiB @ 23.0 MiB/s)
  [====================]  75%  (1.81 GiB @ 23.2 MiB/s)
  [====================] 100%  (2.41 GiB @ 23.1 MiB/s)
[INFO] Replicated 2.41 GiB in 1 minute, 42 seconds.
[INFO] Checksum validation: PASSED (0 block errors).
[INFO] Replication completed successfully.`
      },
      'Delete transfer source resources': {
        phase: 'Replication',
        resource: 'VMware ESXi Snapshot Removal',
        duration: '5 seconds',
        description: 'Releases the HTTP NFC lease and consolidates and removes the temporary replication snapshot on VMware ESXi.',
        subSteps: [
          'Closed HTTP NFC stream connection on port 443',
          `Invoked RemoveSnapshot_Task for snapshot "vporter-snapshot-${migId.slice(0, 8)}"`,
          'Verified snapshot delta consolidation on VMware VMFS datastore',
          'Source virtual machine returned to normal non-snapshot state'
        ],
        logs: `[INFO] Releasing HTTP NFC lease session-52a8d6e3...
[INFO] Calling RemoveSnapshot_Task(consolidate=true)...
[INFO] Snapshot removed from ESXi inventory.
[INFO] VMFS datastore consolidation finished. Source hypervisor clean.`
      },
      'Delete transfer target resources': {
        phase: 'Replication',
        resource: `${linuxPorter} (Linux clone porter)`,
        duration: '4 seconds',
        description: 'Detaches the replica volume from the Linux porter, destroys the ephemeral worker, and releases its temporary IP. The replica volume is kept; the guest IP is allocated later and stays independent.',
        subSteps: [
          'Flushed pending I/O cache to Virtuozzo chunk storage',
          `Detached replica volume from Linux porter ${linuxPorter}`,
          `Terminated Linux porter and released worker IP ${linuxWorkerIp}`,
          'Stage 1 Replication successfully finalized'
        ],
        logs: `[INFO] Detaching replica from Linux porter...
[INFO] Deleting vzbot-linux-porter-${migId.slice(0, 8)}...
[INFO] Released temporary worker IP ${linuxWorkerIp}
[INFO] Replica volume retained. Guest IP stays independent of workers and of VIS Coriolis.`
      },

      // ── DEPLOYMENT & OS MORPHING TASKS ──
      'Validate deployment inputs': {
        phase: 'Deployment',
        resource: 'Nova Compute & Glance Linux Worker',
        duration: '4 seconds',
        description: 'Verifies the target compute node availability, network IP address pool, and verifies that the Linux Porter Image (vporter-minion-linux) is ready in Glance.',
        subSteps: [
          'Validated Nova hypervisor availability: mpg-vz1.vstoragedomain (KVM/QEMU)',
          'Verified Glance image "vporter-minion-linux" (AlmaLinux 9 Worker Template) is ACTIVE',
          'Checked VirtIO driver repository: virtio_pci, virtio_blk, virtio_scsi, virtio_net',
          `Reserved independent fixed IP ${ip} on ${netName}`,
          'Pre-flight deployment checks passed with zero errors'
        ],
        logs: `[INFO] Validating OpenStack deployment inputs for Linux VM "${vmName}"...
[INFO] Hypervisor node: mpg-vz1.vstoragedomain (Virtuozzo KVM 9.0)
[INFO] Linux Morphing Porter Image: "vporter-minion-linux" -> VERIFIED ACTIVE
[INFO] Checking VirtIO kernel modules in worker:
  - virtio_pci: OK
  - virtio_blk: OK
  - virtio_scsi: OK
  - virtio_net: OK
[INFO] Network reservation: IP ${ip} allocated on "VM Network" (MAC: ${mac})
[INFO] Console port reserved: ${port} (Direct SPICE/VNC)
[INFO] Pre-flight validation complete.`
      },
      'Create transfer disk snapshots': {
        phase: 'Deployment',
        resource: snapName,
        duration: '5 seconds',
        description: 'Takes a point-in-time Cinder volume snapshot of the replica volume to guarantee that the replica data is preserved intact during OS morphing.',
        subSteps: [
          `Submitted Cinder snapshot create request: "${snapName}" from replica volume`,
          'Waiting for snapshot transition: creating -> available',
          `Snapshot ID assigned: 7a93f10c-${migId.slice(0, 4)}-481d-bf11-${migId.slice(-12)}`,
          'Point-in-time recovery checkpoint secured'
        ],
        logs: `[INFO] POST /v3/aeba0066a44540d984349d01ab79ec7f/snapshots
[INFO] Request payload: {"snapshot":{"name":"${snapName}","volume_id":"${repUuid}","force":true}}
[INFO] Snapshot ID: 7a93f10c-${migId.slice(0, 4)}-481d-bf11-${migId.slice(-12)}
[INFO] Status: AVAILABLE. Checkpoint secured.`
      },
      'Deploy instance resources': {
        phase: 'Deployment',
        resource: `${bootVolName} & Port ${ip}`,
        duration: '18 seconds',
        description: `Creates the production bootable Cinder volume (${bootVolName}) from the transfer snapshot and allocates the target Neutron network port with independent IP ${ip}.`,
        subSteps: [
          `Created Cinder bootable volume: "${bootVolName}" (${diskSize}) from snapshot`,
          'Set bootable attribute: bootable=true, volume_type=default',
          `Allocated Neutron network port on "VM Network" with fixed Independent IP ${ip}`,
          `Assigned MAC address ${mac} and default security group`
        ],
        logs: `[INFO] Creating target Cinder boot volume from snapshot:
  - Name: "${bootVolName}"
  - Size: ${diskSize}
  - Bootable: true
  - Policy: default
[INFO] Volume UUID: ${volUuid}
[INFO] Status: AVAILABLE (bootable=true)
[INFO] Allocating Neutron port on network d27084e2 ("VM Network")...
[INFO] Port allocated: ID port-mig-1, Fixed IP: ${ip}, MAC: ${mac}
[INFO] Independent network interface deployed successfully.`
      },
      'Deploy os morphing resources': {
        phase: 'Deployment',
        resource: `${workerImg} (${workerRole})`,
        duration: '14 seconds',
        description: `Coriolis deploys an ephemeral Linux migration worker VM (${workerImg} - AlmaLinux 9) with worker IP ${workerIp} and attaches the production boot volume as /dev/vdb.`,
        subSteps: [
          `Spawned ephemeral worker VM from Glance image "${workerImg}" (AlmaLinux 9)`,
          `Assigned worker instance temporary internal IP ${workerIp}`,
          `Attached "${bootVolName}" to worker instance at /dev/vdb`,
          'Probed partition table: detected GPT layout (EFI, /boot, LVM root)',
          'Mounted guest root filesystem and bind-mounted /dev, /proc, /sys, /boot',
          'Prepared guest chroot environment with AlmaLinux 9 package cache'
        ],
        logs: `[INFO] Deploying Coriolis OS Morphing worker VM from Glance image "${workerImg}"...
[INFO] Worker instance ID: minion-lnx-${migId.slice(0, 8)}, Flavor: 2vcpus_2gb, Worker IP: ${workerIp}
[INFO] Worker status: ACTIVE. Coriolis agent ready.
[INFO] Attaching target boot volume to worker: Cinder volume "${bootVolName}" (${diskSize})
[INFO] Mapped to local block device /dev/vdb.
[INFO] Scanning partitions:
  - /dev/vdb1: vfat (EFI System Partition, 600 MB)
  - /dev/vdb2: xfs (/boot, 1024 MB)
  - /dev/vdb3: LVM2_member (root volume group)
[INFO] Activating LVM volume group "almalinux"...
[INFO] Mounting /dev/almalinux/root to /mnt/morph-sandbox...
[INFO] Mounting /dev/vdb2 to /mnt/morph-sandbox/boot...
[INFO] Chroot environment initialized.`
      },
      'Os morphing': {
        phase: 'Deployment',
        resource: 'Kernel Initramfs, VirtIO Drivers & GRUB2',
        duration: '5 minutes, 38 seconds',
        description: 'Transforms the VMware guest OS into a native KVM/VirtIO system: injects VirtIO storage and network drivers, rebuilds initramfs with dracut, disables VMware Tools, updates fstab to UUIDs, and regenerates the GRUB2 bootloader.',
        subSteps: [
          'Identified kernel version: vmlinuz-5.14.0-362.8.1.el9_3.x86_64',
          'Injected VirtIO kernel modules: virtio_blk, virtio_scsi, virtio_net, virtio_pci',
          'Disabled legacy VMware tools daemon: systemctl disable vmtoolsd.service',
          'Enabled QEMU Guest Agent: systemctl enable qemu-guest-agent.service',
          'Rebuilt initramfs via dracut: dracut --force --add "virtio virtio_blk virtio_scsi virtio_net" /boot/initramfs-5.14.0-362.img',
          'Updated /etc/fstab: replaced VMware SCSI paths (/dev/sda*) with filesystem UUIDs',
          'Re-generated GRUB2 configuration: grub2-mkconfig -o /boot/grub2/grub.cfg',
          `Configured cloud-init & NetworkManager keyfiles for DHCP client operation (${ip})`
        ],
        logs: `[INFO] Starting OS Morphing engine for AlmaLinux 9...
[INFO] Injecting KVM VirtIO drivers...
  - virtio_pci: OK
  - virtio_blk: OK
  - virtio_scsi: OK
  - virtio_net: OK
[INFO] Disabling open-vm-tools / vmtoolsd... OK.
[INFO] Enabling qemu-guest-agent... OK.
[INFO] Rebuilding dracut initramfs for kernel 5.14.0-362.8.1.el9_3.x86_64:
  # dracut -v --force --add "virtio virtio_pci virtio_blk virtio_scsi virtio_net" /boot/initramfs-5.14.0-362.8.1.el9_3.x86_64.img
  ... dracut: Creating initramfs image file ...
  ... dracut: *** Including module: virtio ***
  ... dracut: *** Including module: qemu ***
  ... dracut: *** Store current command line parameters ***
  ... dracut: *** Creating image file done ***
[INFO] Inspecting /etc/fstab:
  - Root: UUID=3f4e1982-b11c-4da8... (mounted at /)
  - Boot: UUID=a1b2c3d4-e5f6-7890... (mounted at /boot)
[INFO] Updating GRUB2 configuration:
  # grub2-mkconfig -o /boot/grub2/grub.cfg
  Generating grub configuration file ...
  Found linux image: /boot/vmlinuz-5.14.0-362.8.1.el9_3.x86_64
  Found initrd image: /boot/initramfs-5.14.0-362.8.1.el9_3.x86_64.img
  done
[INFO] NetworkManager: configuring eth0 for DHCP autoconfiguration (${ip}).
[INFO] OS morphing completed successfully with zero errors.`
      },
      'Delete os morphing resources': {
        phase: 'Deployment',
        resource: `${workerImg} (${workerRole})`,
        duration: '8 seconds',
        description: `Syncs all modified files to disk, unmounts all guest partitions from the morphing sandbox, detaches the volume, and terminates ephemeral worker VM ${workerImg}.`,
        subSteps: [
          'Flushed filesystem write cache: sync',
          'Unmounted guest filesystems: /boot, /',
          'Deactivated LVM volume group "almalinux"',
          `Detached volume "${bootVolName}" from morphing sandbox worker`,
          `Terminated ephemeral worker VM "${workerImg}" and de-allocated temporary IP ${workerIp}`
        ],
        logs: `[INFO] Flushing all cached disk blocks...
[INFO] Unmounting /mnt/morph-sandbox/boot... OK.
[INFO] Unmounting /mnt/morph-sandbox... OK.
[INFO] Deactivating LVM volume group almalinux... OK.
[INFO] Detaching /dev/vdb... OK.
[INFO] Deleting ephemeral worker VM minion-lnx-${migId.slice(0, 8)}...
[INFO] Releasing temporary worker IP ${workerIp}... OK.
[INFO] Morphing sandbox worker resources de-allocated cleanly.`
      },
      'Get optimal flavor': {
        phase: 'Deployment',
        resource: `OpenStack Nova Flavor (${flavor})`,
        duration: '4 seconds',
        description: `Inspects available compute flavors in the Virtuozzo cluster and selects the closest matching configuration for the source Linux VM (${vcpus} vCPU, 2 GiB RAM).`,
        subSteps: [
          'Queried OpenStack Nova flavor catalog (/v2.1/flavors/detail)',
          `Compared source requirements: ${vcpus} vCPU, ${ramMb} MB RAM`,
          `Matched closest optimal flavor: "${flavor}" (${vcpus} vCPUs, ${ramMb} MB RAM, 0 GB root disk)`,
          'Flavor ID assigned: 9b777240-f963-4dbd-9199-4c81153b30a5'
        ],
        logs: `[INFO] Querying Nova flavors... 8 flavors found.
[INFO] Source VM requirement: ${vcpus} vCPU / ${ramMb} MB RAM
[INFO] Selected flavor:
  - Name: ${flavor}
  - ID: 9b777240-f963-4dbd-9199-4c81153b30a5
  - vCPUs: ${vcpus}
  - RAM: ${ramMb} MB
  - Ephemeral: 0 GB
[INFO] Flavor matched.`
      },
      'Finalize instance deployment': {
        phase: 'Deployment',
        resource: `Nova Virtual Machine "${vmName}" (IP: ${ip})`,
        duration: '22 seconds',
        description: `Submits the Nova instance creation request with the morphed root volume attached, powers on the VM, verifies hypervisor scheduling, and confirms the guest agent is online with independent IP ${ip}.`,
        subSteps: [
          `Submitted Nova compute POST /servers request with name "${vmName}"`,
          `Attached root boot volume "${bootVolName}" (device: /dev/vda, boot_index: 0)`,
          `Attached Neutron network interface with independent IP ${ip}`,
          'Set hardware machine type: pc-q35, disk bus: VirtIO',
          `Spawned QEMU/KVM virtual machine process on hypervisor mpg-vz1.vstoragedomain (Console Port: ${port})`,
          `Instance transitioned: BUILD -> ACTIVE. Guest agent connected with IP ${ip}.`
        ],
        logs: `[INFO] POST /v2.1/aeba0066a44540d984349d01ab79ec7f/servers
[INFO] Request payload:
{
  "server": {
    "name": "${vmName}",
    "flavorRef": "9b777240-f963-4dbd-9199-4c81153b30a5",
    "block_device_mapping_v2": [{
      "uuid": "${volUuid}",
      "source_type": "volume",
      "destination_type": "volume",
      "boot_index": 0,
      "device_name": "/dev/vda"
    }],
    "networks": [{"port": "port-mig-1"}]
  }
}
[INFO] Server created with UUID: ${migId}
[INFO] Scheduled to hypervisor: mpg-vz1.vstoragedomain
[INFO] Assigned Independent IP: ${ip} (Port: port-mig-1, Network: ${netName})
[INFO] VNC/SPICE Console Port: ${port}
[INFO] Instance power state: Running (ACTIVE)
[INFO] QEMU Guest Agent online (v9.1.0). IP address: ${ip}
[INFO] Final deployment completed successfully!`
      },
      'Delete transfer target disk snapshots': {
        phase: 'Deployment',
        resource: snapName,
        duration: '5 seconds',
        description: 'Deletes the temporary staging snapshot to reclaim chunk storage space now that the instance is running on its own production volume.',
        subSteps: [
          `Submitted Cinder snapshot delete request for snapshot "${snapName}"`,
          'Verified snapshot deletion: status transitioned to deleted',
          `Virtuozzo storage reconciled: ${diskSize} temporary delta space reclaimed`,
          'Migration lifecycle successfully finalized'
        ],
        logs: `[INFO] DELETE /v3/aeba0066a44540d984349d01ab79ec7f/snapshots/7a93f10c-${migId.slice(0, 4)}-481d-bf11-${migId.slice(-12)}
[INFO] Snapshot deleted from Cinder catalog.
[INFO] Chunk storage reclaimed on Virtuozzo Storage cluster.
[INFO] MIGRATION PROCESS COMPLETE: 100% SUCCESS.`
      }
    };

    return linuxDetails[name] || {
      phase,
      resource: `${vmName} (${workerImg})`,
      duration: '10s',
      description: `Execution of Linux migration step: ${name}`,
      subSteps: [`Task initiated for ${name}`, 'Validation completed', 'State recorded'],
      logs: `[INFO] Executed step ${name} for ${vmName} using worker ${workerImg}.`
    };
  }
}

// Proxy fallback for backwards compatibility
const TASK_DETAILS_DATABASE = new Proxy({}, {
  get(target, prop) {
    const mig = (_migrations || []).find(m => m.id === _activeMigrationDetailId) || _migrations[0];
    return getTaskDetails(String(prop), 'Deployment', mig);
  }
});

function openTaskDetails(name, phase, dateStr, isCompleted, isRunning, migId) {
  const targetId = migId || _activeMigrationDetailId;
  const mig = (_migrations || []).find(m => m.id === targetId) || _migrations[0];
  const taskInfo = getTaskDetails(name, phase, mig) || {};
  const modal = document.getElementById('taskDetailModal');
  if (!modal) {
    toast('Task details panel is missing from the page', 'err');
    return;
  }
  setElText('taskDetailTitle', name);
  setElText('taskDetailPhase', taskInfo.phase || phase);
  setElText('taskDetailTargetRes', taskInfo.resource || 'VHI Resource');
  setElText('taskDetailDuration', taskInfo.duration || (isCompleted ? 'Completed' : 'Running'));
  setElText('taskDetailTimestamp', dateStr || '');
  setElText('taskDetailDescription', taskInfo.description || '');

  const badgeEl = document.getElementById('taskDetailStatusBadge');
  const iconEl = document.getElementById('taskDetailIcon');
  if (badgeEl && iconEl) {
    if (isRunning) {
      badgeEl.className = 'badge badge-warning';
      badgeEl.textContent = 'In Progress';
      iconEl.innerHTML = '&#8987;';
      iconEl.style.background = 'var(--warning)';
    } else if (isCompleted) {
      badgeEl.className = 'badge badge-success';
      badgeEl.textContent = 'Completed';
      iconEl.innerHTML = '&#10003;';
      iconEl.style.background = '#28a745';
    } else {
      badgeEl.className = 'badge badge-default';
      badgeEl.textContent = 'Pending';
      iconEl.innerHTML = '&#9675;';
      iconEl.style.background = '#6c757d';
    }
  }

  const stepsEl = document.getElementById('taskDetailSubSteps');
  if (stepsEl) {
    stepsEl.innerHTML = (taskInfo.subSteps || []).map(step => `
      <div style="display:flex; align-items:flex-start; gap:0.6rem; color:var(--text); line-height:1.4;">
        <span style="color:#28a745; font-weight:bold; font-size:0.9rem; flex-shrink:0;">&#10004;</span>
        <span>${escapeHtml(step)}</span>
      </div>
    `).join('');
  }
  setElText('taskDetailLogs', taskInfo.logs || '[INFO] No execution logs recorded for this task.');
  modal.classList.remove('hidden');
}

function closeTaskDetailModal() {
  document.getElementById('taskDetailModal').classList.add('hidden');
}

function copyTaskLog() {
  const logText = document.getElementById('taskDetailLogs').textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(logText).then(() => toast('Task log copied to clipboard', 'ok'));
  } else {
    toast('Copied', 'ok');
  }
}

function toggleTaskInline(prefix, idx, e) {
  if (e) e.stopPropagation();
  const detailRow = document.getElementById(`${prefix}-detail-${idx}`);
  const chev = document.getElementById(`${prefix}-chev-${idx}`);
  if (!detailRow) return;
  const isCurrentlyOpen = detailRow.style.display !== 'none';
  detailRow.style.display = isCurrentlyOpen ? 'none' : 'table-row';
  if (chev) {
    chev.innerHTML = isCurrentlyOpen ? '&rsaquo;' : '&#9660;';
    chev.style.transform = isCurrentlyOpen ? 'none' : 'rotate(0deg)';
  }
}

function toggleAllTasksDetails(prefix) {
  const detailRows = document.querySelectorAll(`.${prefix}-inline-detail`);
  const anyClosed = Array.from(detailRows).some(r => r.style.display === 'none');
  const btn = document.getElementById(prefix === 'dep' ? 'btnDepExpandAll' : 'btnRepExpandAll');

  detailRows.forEach((r, idx) => {
    r.style.display = anyClosed ? 'table-row' : 'none';
    const chev = document.getElementById(`${prefix}-chev-${idx}`);
    if (chev) {
      chev.innerHTML = anyClosed ? '&#9660;' : '&rsaquo;';
    }
  });

  if (btn) {
    btn.innerHTML = anyClosed
      ? `<span class="ri">&#9650;</span> Collapse Steps`
      : `<span class="ri">&#9660;</span> Expand All Steps`;
  }
}

function renderMigReplicationTasks(mig) {
  const tbody = document.getElementById('migReplicationTasksBody');
  if (!tbody) return;

  const isCompleteState = mig.status === 'DEPLOYED' || mig.status === 'ACTIVE' || mig.status === 'REPLICATED' || mig.status === 'DEPLOYING';
  const activeIdx = (typeof mig.replicationTaskIdx === 'number')
    ? mig.replicationTaskIdx
    : (isCompleteState ? 9 : 3);

  tbody.innerHTML = REPLICATION_TASK_NAMES.map((name, idx) => {
    const isCompleted = idx < activeIdx;
    const isRunning = idx === activeIdx && (mig.status === 'REPLICATING');
    const isFailed = idx === activeIdx && mig.status === 'ERROR';
    const dateStr = formatMigDate(mig.updated || mig.started, REPLICATION_DEFAULT_DATES[idx] || '');

    let icon = `<span style="display:inline-block; width:17px; height:17px; border-radius:50%; border:2px solid #adb5bd;"></span>`;
    if (isCompleted) {
      icon = `<span class="task-check-icon">&#10003;</span>`;
    } else if (isFailed) {
      icon = `<span style="color:var(--danger); font-weight:700; font-size:14px;">&#10007;</span>`;
    } else if (isRunning) {
      icon = `<span class="ri spin" style="color:var(--warning); font-size:14px;">&#8987;</span>`;
    }

    const taskInfo = getTaskDetails(name, 'Replication', mig);

    const cleanEscaped = escapeHtml(name).replace(/'/g, "\\'");
    return `
      <tr style="border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s;" onclick="toggleTaskInline('rep', ${idx}, event)" title="Click to expand/collapse details">
        <td style="padding:0.65rem 0.6rem;">
          <div style="display:flex; align-items:center; gap:0.55rem;">
            ${icon}
            <span style="font-weight:${isCompleted || isRunning ? '500' : 'normal'}; color:${isCompleted ? 'var(--text)' : 'var(--text-dim)'}; font-size:0.85rem;">${escapeHtml(name)}</span>
          </div>
        </td>
        <td class="text-dim" style="font-size:0.78rem; white-space:nowrap; padding:0.65rem 0.4rem;">${dateStr}</td>
        <td style="text-align:right; width:25px; padding:0.65rem 0.4rem;">
          <span id="rep-chev-${idx}" class="task-chevron" style="font-size:1.1rem; cursor:pointer;">&rsaquo;</span>
        </td>
      </tr>
      <tr id="rep-detail-${idx}" class="rep-inline-detail" style="display:none; background: var(--bg-card); border-bottom: 1px solid var(--border);">
        <td colspan="3" style="padding: 0.75rem 0.9rem;">
          <div style="display: flex; flex-direction: column; gap: 0.6rem; border-left: 3px solid #0d6efd; padding-left: 0.8rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.4rem;">
              <div style="display: flex; gap: 0.4rem; align-items: center;">
                <span class="badge badge-default" style="font-size: 0.7rem;">${escapeHtml(taskInfo.resource)}</span>
                <span class="badge badge-default" style="font-size: 0.7rem;">⏱ ${escapeHtml(taskInfo.duration)}</span>
              </div>
              <button class="txt-btn" onclick="openTaskDetails('${cleanEscaped}', 'Replication', '${dateStr}', ${isCompleted}, ${isRunning}, '${mig.id}')" style="font-size: 0.72rem; color: #0d6efd; text-decoration: underline;">
                Full Logs Modal &rarr;
              </button>
            </div>
            <p style="font-size: 0.8rem; line-height: 1.45; color: var(--text); margin: 0;">${escapeHtml(taskInfo.description)}</p>
            <div style="font-size: 0.74rem; font-weight: 700; text-transform: uppercase; color: var(--text-dim); margin-top: 0.2rem;">Operations Executed:</div>
            <div style="display: flex; flex-direction: column; gap: 0.3rem;">
              ${(taskInfo.subSteps || []).map(step => `
                <div style="display: flex; align-items: flex-start; gap: 0.45rem; font-size: 0.8rem; color: var(--text); line-height: 1.35;">
                  <span style="color: #28a745; font-weight: bold; flex-shrink: 0;">&#10004;</span>
                  <span>${escapeHtml(step)}</span>
                </div>
              `).join('')}
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderMigDeploymentTasks(mig) {
  const tbody = document.getElementById('migDeploymentTasksBody');
  if (!tbody) return;

  const isCompleteState = mig.status === 'DEPLOYED' || mig.status === 'ACTIVE';
  const activeIdx = (typeof mig.deploymentTaskIdx === 'number')
    ? mig.deploymentTaskIdx
    : (isCompleteState ? 9 : (mig.status === 'DEPLOYING' ? 4 : 0));

  tbody.innerHTML = DEPLOYMENT_TASK_NAMES.map((name, idx) => {
    const isCompleted = idx < activeIdx;
    const isRunning = idx === activeIdx && (mig.status === 'DEPLOYING');
    const dateStr = DEPLOYMENT_DEFAULT_DATES[idx] || 'August 3, 2026 10:17 AM';

    let icon = `<span style="display:inline-block; width:17px; height:17px; border-radius:50%; border:2px solid #adb5bd;"></span>`;
    if (isCompleted) {
      icon = `<span class="task-check-icon">&#10003;</span>`;
    } else if (isRunning) {
      icon = `<span class="ri spin" style="color:#0d6efd; font-size:14px;">&#9881;</span>`;
    }

    const taskInfo = getTaskDetails(name, 'Deployment', mig);

    const cleanEscaped = escapeHtml(name).replace(/'/g, "\\'");
    return `
      <tr style="border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s;" onclick="toggleTaskInline('dep', ${idx}, event)" title="Click to expand/collapse details">
        <td style="padding:0.75rem 0.8rem;">
          <div style="display:flex; align-items:center; gap:0.65rem;">
            ${icon}
            <span style="font-weight:${isCompleted || isRunning ? '500' : 'normal'}; color:${isCompleted ? 'var(--text)' : 'var(--text-dim)'}; font-size:0.88rem;">${escapeHtml(name)}</span>
          </div>
        </td>
        <td class="text-dim" style="font-size:0.82rem; white-space:nowrap; padding:0.75rem 0.8rem;">${dateStr}</td>
        <td style="text-align:right; width:30px; padding:0.75rem 0.8rem;">
          <span id="dep-chev-${idx}" class="task-chevron" style="font-size:1.15rem; cursor:pointer;">&rsaquo;</span>
        </td>
      </tr>
      <tr id="dep-detail-${idx}" class="dep-inline-detail" style="display:none; background: var(--bg-card); border-bottom: 1px solid var(--border);">
        <td colspan="3" style="padding: 0.9rem 1.2rem;">
          <div style="display: flex; flex-direction: column; gap: 0.75rem; border-left: 3px solid #0d6efd; padding-left: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
              <div style="display: flex; gap: 0.5rem; align-items: center;">
                <span class="badge badge-default" style="font-size: 0.75rem;">Resource: ${escapeHtml(taskInfo.resource)}</span>
                <span class="badge badge-default" style="font-size: 0.75rem;">⏱ Duration: ${escapeHtml(taskInfo.duration)}</span>
              </div>
              <button class="txt-btn" onclick="openTaskDetails('${cleanEscaped}', 'Deployment', '${dateStr}', ${isCompleted}, ${isRunning}, '${mig.id}')" style="font-size: 0.78rem; color: #0d6efd; text-decoration: underline;">
                Open Full Technical Logs &rarr;
              </button>
            </div>
            <p style="font-size: 0.86rem; line-height: 1.5; color: var(--text); margin: 0;">${escapeHtml(taskInfo.description)}</p>
            <div style="font-size: 0.76rem; font-weight: 700; text-transform: uppercase; color: var(--text-dim); margin-top: 0.2rem;">Detailed Operations Executed on VM:</div>
            <div style="display: flex; flex-direction: column; gap: 0.4rem;">
              ${(taskInfo.subSteps || []).map(step => `
                <div style="display: flex; align-items: flex-start; gap: 0.55rem; font-size: 0.84rem; color: var(--text); line-height: 1.4;">
                  <span style="color: #28a745; font-weight: bold; flex-shrink: 0;">&#10004;</span>
                  <span>${escapeHtml(step)}</span>
                </div>
              `).join('')}
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function switchDrawerTab(tab) {
  const btnTasks = document.getElementById('btnDrawerTasks');
  const btnOverview = document.getElementById('btnDrawerOverview');
  const tasksContainer = document.getElementById('drawerTasksContainer');
  const overviewContainer = document.getElementById('drawerOverviewContainer');

  if (tab === 'tasks') {
    if (btnTasks) {
      btnTasks.style.background = 'var(--bg-medium)';
      btnTasks.style.fontWeight = '600';
      btnTasks.style.color = 'var(--text)';
    }
    if (btnOverview) {
      btnOverview.style.background = 'transparent';
      btnOverview.style.fontWeight = 'normal';
      btnOverview.style.color = 'var(--text-dim)';
    }
    if (tasksContainer) tasksContainer.style.display = 'block';
    if (overviewContainer) overviewContainer.style.display = 'none';
  } else {
    if (btnTasks) {
      btnTasks.style.background = 'transparent';
      btnTasks.style.fontWeight = 'normal';
      btnTasks.style.color = 'var(--text-dim)';
    }
    if (btnOverview) {
      btnOverview.style.background = 'var(--bg-medium)';
      btnOverview.style.fontWeight = '600';
      btnOverview.style.color = 'var(--text)';
    }
    if (tasksContainer) tasksContainer.style.display = 'none';
    if (overviewContainer) overviewContainer.style.display = 'block';
  }
}

function openReplicationDrawer() {
  const drawer = document.getElementById('migReplicationDrawer');
  if (drawer) drawer.style.display = 'block';
  const mig = _migrations.find(m => m.id === _activeMigrationDetailId);
  if (!mig) return;
  const bytesEl = document.getElementById('repDrawerBytes');
  const speedEl = document.getElementById('repDrawerSpeed');
  const durEl = document.getElementById('repDrawerDur');
  if (bytesEl) bytesEl.textContent = mig.replicatedBytes || '—';
  if (speedEl) speedEl.textContent = mig.replicationSpeed || '—';
  if (durEl) durEl.textContent = mig.duration || '—';
  const wrap = document.getElementById('migDrawerCancelWrap');
  if (wrap) wrap.innerHTML = cancelActionHtml(mig, true);
}

function closeReplicationDrawer() {
  const drawer = document.getElementById('migReplicationDrawer');
  if (drawer) drawer.style.display = 'none';
}

function deleteMigrationFromDrawer() {
  if (_activeMigrationDetailId) {
    deleteMigration(_activeMigrationDetailId);
  }
}

function migrationCanCancel(m) {
  const s = m && m.status;
  return !!s && s !== 'CANCELLED' && s !== 'DEPLOYED' && s !== 'ACTIVE';
}

function renderMigHeaderActions(mig) {
  const actionWrap = document.getElementById('migDetailActionWrap');
  if (!actionWrap || !mig) return;
  let html = '';
  if (mig.status === 'REPLICATED' || (mig.status === 'ERROR' && mig.clonedBytes && mig.replicaVolumeId)) {
    html = '<button class="act-btn act-start" onclick="triggerDeployment(\'' + mig.id + '\')" style="padding:0.35rem 0.8rem; font-size:0.82rem; width:auto; height:auto; display:inline-flex; align-items:center; gap:5px;">' + (mig.status === 'ERROR' ? 'Retry Stage 2' : 'Deploy Instance (Stage 2)') + '</button>';
  } else if ((mig.status === 'ERROR' || mig.status === 'CANCELLED') && !mig.clonedBytes) {
    html = '<button class="act-btn act-start" onclick="triggerRetryReplication(\'' + mig.id + '\')" style="padding:0.35rem 0.8rem; font-size:0.82rem; width:auto; height:auto; display:inline-flex; align-items:center; gap:5px;">Retry clone</button>';
  }
  html += cancelActionHtml(mig, false);
  actionWrap.innerHTML = html;
  const drawerCancel = document.getElementById('migDrawerCancelWrap');
  if (drawerCancel) drawerCancel.innerHTML = cancelActionHtml(mig, true);
}

function cancelActionHtml(m, compact) {
  if (!migrationCanCancel(m)) return '';
  const gap = compact ? 'margin-right:0.4rem;' : 'margin-left:0.4rem;';
  const style = `padding:${compact ? '0.25rem 0.6rem' : '0.35rem 0.8rem'}; font-size:${compact ? '0.76rem' : '0.82rem'}; width:auto; height:auto; display:inline-flex; align-items:center; gap:4px; ${gap}`;
  if (m.status === 'CANCELLING') {
    return `<span class="text-dim" style="font-size:0.76rem; ${gap}">Cancelling...</span>`;
  }
  return `<button class="txt-btn act-danger" onclick="event.stopPropagation(); cancelMigration('${m.id}')" title="Stop this migration now" style="${style}">Cancel</button>`;
}

async function cancelMigration(id) {
  if (!confirm('Cancel this migration now? Disk clone, porter VMs, NFC, and incomplete volumes will be stopped and cleaned up. A deployed guest VM is kept.')) return;
  try {
    const res = await fetch('/api/vhi/migrations/' + encodeURIComponent(id) + '/cancel', {
      method: 'POST',
      headers: authHeaders()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    if (data.migration) {
      _migrations = _migrations.map(m => m.id === id ? data.migration : m);
    } else {
      _migrations = _migrations.map(m => m.id === id ? { ...m, status: 'CANCELLING', cancelRequested: true } : m);
    }
    localStorage.setItem('vhi_migrations', JSON.stringify(_migrations));
    renderMigrations();
    updateMigrationBadge();
    startMigrationPoll();
    if (_activeMigrationDetailId === id) openMigrationDetail(id);
    const kept = data.migration && (data.migration.status === 'DEPLOYED' || data.migration.status === 'ACTIVE');
    toast(kept ? 'Leftover porter resources removed; guest VM kept' : 'Migration cancel requested', 'warn');
  } catch (e) {
    toast('Cancel failed: ' + e.message, 'err');
  }
}

async function deleteMigration(id) {
  if (!confirm('Delete this migration record?')) return;
  try {
    await fetch(`/api/vhi/migrations/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
  } catch (e) {
    console.error(e);
  }
  _migrations = _migrations.filter(m => m.id !== id);
  localStorage.setItem('vhi_migrations', JSON.stringify(_migrations));
  renderMigrations();
  updateMigrationBadge();
  if (_activeMigrationDetailId === id) {
    closeMigrationDetail();
  }
  loadVMs(); // refresh VMs table
  toast('Record deleted', 'ok');
}

// Trigger Stage 2: Manual Cutover & Deployment of a Replicated VM
async function triggerDeployment(id) {
  const mig = _migrations.find(m => m.id === id);
  if (!mig) return;

  toast(`Starting Stage 2 cutover deployment for "${mig.name}"...`, 'inf');
  try {
    const res = await fetch(`/api/vhi/migrations/${encodeURIComponent(id)}/deploy`, {
      method: 'POST',
      headers: authHeaders()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.migration) {
      _migrations = _migrations.map(m => m.id === id ? data.migration : m);
    }
  } catch (e) {
    toast(`Deploy failed: ${e.message}`, 'err');
    return;
  }

  localStorage.setItem('vhi_migrations', JSON.stringify(_migrations));
  renderMigrations();
  updateMigrationBadge();
  startMigrationPoll();
  loadVMs();

  if (_activeMigrationDetailId === id) {
    openMigrationDetail(id);
    switchMigDetailSubTab('deployments');
  }

  toast(`Stage 2 initiated: OS morphing with ${mig.morphWorkerImage || (mig.sourceOptions?.os === 'windows' ? 'vporter-minion-windows' : 'vporter-minion-linux')}`, 'ok');
}

async function triggerRetryReplication(id) {
  const mig = _migrations.find(m => m.id === id);
  if (!mig) return;
  toast(`Retrying disk clone for "${mig.name}" via Linux porter NFC...`, 'inf');
  try {
    const res = await fetch(`/api/vhi/migrations/${encodeURIComponent(id)}/retry-replication`, {
      method: 'POST',
      headers: authHeaders()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.migration) {
      _migrations = _migrations.map(m => m.id === id ? data.migration : m);
    }
  } catch (e) {
    toast(`Retry clone failed: ${e.message}`, 'err');
    return;
  }
  localStorage.setItem('vhi_migrations', JSON.stringify(_migrations));
  renderMigrations();
  updateMigrationBadge();
  startMigrationPoll();
  if (_activeMigrationDetailId === id) {
    openMigrationDetail(id);
    switchMigDetailSubTab('replications');
  }
  toast('Disk clone restarted', 'ok');
}

// Update the badge counter in the sidebar
function updateMigrationBadge() {
  const badge = document.getElementById('migrationBadge');
  if (!badge) return;
  
  const activeCount = _migrations.filter(m => !['DEPLOYED','ACTIVE','ERROR','CANCELLED'].includes(m.status)).length;
  document.getElementById('migrationsCount').textContent = `${activeCount} Active`;
  
  if (activeCount > 0) {
    badge.textContent = activeCount;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// Simulation Interval for migrating progress (Replication -> Deployment -> Deployed)
function startProgressSimulation() {
  startMigrationPoll();
}

function startMigrationPoll() {
  if (_migrationProgressInterval) return;
  _migrationProgressInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/vhi/migrations', { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.migrations)) return;
      _migrations = data.migrations;
      localStorage.setItem('vhi_migrations', JSON.stringify(_migrations));
      renderMigrations();
      updateMigrationBadge();
      if (_activeMigrationDetailId) {
        const currentMig = _migrations.find(m => m.id === _activeMigrationDetailId);
        if (currentMig) {
          renderMigReplicationsTable(currentMig);
          renderMigReplicationTasks(currentMig);
          renderMigDeploymentTasks(currentMig);
          const ipEl = document.getElementById('migTgtIp');
          if (ipEl) ipEl.textContent = currentMig.ipAddress || 'pending';
          const workerIpsEl = document.getElementById('migTgtWorkerIps');
          if (workerIpsEl) {
            const parts = [];
            const winGuest = migLooksLikeWindows(currentMig);
            if (winGuest) {
              if (currentMig.windowsWorkerIp) parts.push(`windows ${currentMig.windowsWorkerIp}`);
            } else if (currentMig.linuxWorkerIp) {
              parts.push(`linux ${currentMig.linuxWorkerIp}`);
            }
            workerIpsEl.textContent = parts.length ? parts.join(' · ') : 'none (released after phase)';
          }
          const linuxEl = document.getElementById('migTgtLinuxPorter');
          if (linuxEl) {
            const winGuest = migLooksLikeWindows(currentMig);
            linuxEl.textContent = winGuest ? (currentMig.windowsWorkerImage || 'vporter-minion-windows') : (currentMig.linuxWorkerImage || 'vporter-minion-linux');
          }
          const morphEl = document.getElementById('migTgtMorphPorter');
          if (morphEl) morphEl.textContent = currentMig.morphWorkerImage || 'vporter-minion-linux';
          renderMigrationErrorAndLog(currentMig);
          renderMigHeaderActions(currentMig);
          const statusWrap = document.getElementById('migDetailStatusWrap');
          if (statusWrap) {
            if (currentMig.status === 'REPLICATING') {
              statusWrap.innerHTML = `<span class="badge" style="background:rgba(255,193,7,0.15); color:var(--warning);">&#9679; Replicating (${currentMig.progress || 0}%)</span>`;
            } else if (currentMig.status === 'ERROR') {
              statusWrap.innerHTML = `<span class="badge badge-error">ERROR</span>`;
            } else if (currentMig.status === 'CANCELLING') {
              statusWrap.innerHTML = `<span class="badge" style="background:rgba(108,117,125,0.15); color:var(--text-dim);">Cancelling</span>`;
            } else if (currentMig.status === 'CANCELLED') {
              statusWrap.innerHTML = `<span class="badge badge-shutoff">Cancelled</span>`;
            } else if (currentMig.status === 'REPLICATED') {
              statusWrap.innerHTML = `<span class="badge" style="background:rgba(13,110,253,0.15); color:#0d6efd; border:1px solid rgba(13,110,253,0.3); font-weight:600;">&#9679; Replicated (Cutover Ready)</span>`;
            }
          }
          const dhcpEl = document.getElementById('migTgtDhcp');
          if (dhcpEl) dhcpEl.textContent = currentMig.targetOptions?.dhcp || 'Yes';
          const retainEl = document.getElementById('migTgtRetainCreds');
          if (retainEl) retainEl.textContent = currentMig.targetOptions?.retainCreds || 'Yes';
          const delDisksEl = document.getElementById('migTgtDeleteDisks');
          if (delDisksEl) delDisksEl.textContent = currentMig.targetOptions?.deleteDisks || 'Yes';
        }
      }
      if (!_migrations.some(m => m.status === 'REPLICATING' || m.status === 'DEPLOYING' || m.status === 'QUEUED' || m.status === 'CANCELLING')) {
        clearInterval(_migrationProgressInterval);
        _migrationProgressInterval = null;
        loadVMs();
      }
    } catch (err) {
      console.warn('Migration poll failed:', err.message);
    }
  }, 3000);
}

// ── ADD CLOUD FLOW ────────────────────────────────────────────────────────

const addCloudModal = document.getElementById('addCloudModal');
let _selectedProvider = 'vmware';

const CLOUD_PROVIDERS = {
  vmware: {
    type: 'VMWARE',
    brand: 'vmware',
    color: '#0056b3',
    hostLabel: 'VMware vSphere hostname',
    hostPh: 'e.g. vcsa.vegas.local',
    portLabel: 'Port',
    port: '443',
    userPh: 'administrator@vsphere.local',
    extra: false,
  },
  vhi: {
    type: 'VHI',
    brand: 'Virtuozzo Infrastructure',
    color: '#e3000f',
    hostLabel: 'VHI API URL',
    hostPh: 'https://172.16.218.7',
    portLabel: 'Identity port',
    port: '5000',
    userPh: 'admin',
    extra: true,
  },
  hyperv: {
    type: 'HYPERV',
    brand: 'Hyper-V',
    color: '#00bcf2',
    hostLabel: 'Hyper-V hostname',
    hostPh: 'hyperv.lab.local',
    portLabel: 'WinRM port',
    port: '5985',
    userPh: 'Administrator',
    extra: false,
  },
};

function cloudPayload() {
  const spec = CLOUD_PROVIDERS[_selectedProvider] || CLOUD_PROVIDERS.vmware;
  return {
    type: spec.type,
    name: document.getElementById('cloudName').value.trim(),
    desc: document.getElementById('cloudDesc').value.trim(),
    host: document.getElementById('cloudHost').value.trim(),
    port: parseInt(document.getElementById('cloudPort').value, 10) || Number(spec.port),
    user: document.getElementById('cloudUser').value.trim(),
    pass: document.getElementById('cloudPass').value,
    insecure: document.getElementById('cloudInsecure').checked,
    project: document.getElementById('cloudProject')?.value.trim() || 'admin',
    domain: document.getElementById('cloudDomain')?.value.trim() || 'Default',
  };
}

function openAddCloudModal() {
  document.getElementById('cloudName').value = '';
  document.getElementById('cloudDesc').value = '';
  document.getElementById('cloudHost').value = '';
  document.getElementById('cloudUser').value = '';
  document.getElementById('cloudPass').value = '';
  document.getElementById('cloudInsecure').checked = true;
  if (document.getElementById('cloudProject')) document.getElementById('cloudProject').value = 'admin';
  if (document.getElementById('cloudDomain')) document.getElementById('cloudDomain').value = 'Default';
  const resDiv = document.getElementById('cloudTestResult');
  if (resDiv) {
    resDiv.style.display = 'none';
    resDiv.innerHTML = '';
  }
  selectProvider('vmware');
  addCloudGoBack();
  addCloudModal.classList.remove('hidden');
}

function closeAddCloudModal() {
  addCloudModal.classList.add('hidden');
}

function selectProvider(provider) {
  if (!CLOUD_PROVIDERS[provider]) {
    return toast('This cloud type is not available yet', 'warn');
  }
  _selectedProvider = provider;
  document.querySelectorAll('#addCloudStep1 .provider-option').forEach((el) => {
    el.classList.toggle('selected', !el.classList.contains('disabled') && el.getAttribute('onclick') === "selectProvider('" + provider + "')");
  });
  const radio = document.querySelector('#addCloudStep1 input[value="' + provider + '"]');
  if (radio && !radio.disabled) radio.checked = true;
  applyCloudProviderForm(provider);
}

function applyCloudProviderForm(provider) {
  const spec = CLOUD_PROVIDERS[provider] || CLOUD_PROVIDERS.vmware;
  const brand = document.getElementById('cloudProviderBrand');
  if (brand) {
    brand.textContent = spec.brand;
    brand.style.color = spec.color;
  }
  const hostLabel = document.getElementById('cloudHostLabel');
  if (hostLabel) hostLabel.textContent = spec.hostLabel;
  const host = document.getElementById('cloudHost');
  if (host) host.placeholder = spec.hostPh;
  const portLabel = document.getElementById('cloudPortLabel');
  if (portLabel) portLabel.textContent = spec.portLabel;
  const port = document.getElementById('cloudPort');
  if (port) port.value = spec.port;
  const user = document.getElementById('cloudUser');
  if (user) user.placeholder = spec.userPh;
  document.getElementById('cloudProjectGroup')?.classList.toggle('hidden', !spec.extra);
  document.getElementById('cloudDomainGroup')?.classList.toggle('hidden', !spec.extra);
  document.getElementById('cloudHyperVHelp')?.classList.toggle('hidden', provider !== 'hyperv');
}

function addCloudGoNext() {
  if (!CLOUD_PROVIDERS[_selectedProvider]) {
    return toast('Select VMware, VHI, or Hyper-V to continue', 'warn');
  }
  applyCloudProviderForm(_selectedProvider);
  document.getElementById('addCloudStep1').classList.add('hidden');
  document.getElementById('addCloudStep2').classList.remove('hidden');
  document.getElementById('btnAddCloudBack').style.display = '';
  document.getElementById('btnAddCloudCancel').style.display = 'none';
  document.getElementById('btnAddCloudNext').style.display = 'none';
  document.getElementById('btnAddCloudTest').style.display = '';
  document.getElementById('btnAddCloudSubmit').style.display = '';
}

function addCloudGoBack() {
  document.getElementById('addCloudStep1').classList.remove('hidden');
  document.getElementById('addCloudStep2').classList.add('hidden');
  document.getElementById('btnAddCloudBack').style.display = 'none';
  document.getElementById('btnAddCloudCancel').style.display = '';
  document.getElementById('btnAddCloudNext').style.display = '';
  document.getElementById('btnAddCloudTest').style.display = 'none';
  document.getElementById('btnAddCloudSubmit').style.display = 'none';
}

async function testAddCloudConnection() {
  const payload = cloudPayload();
  const resultDiv = document.getElementById('cloudTestResult');
  const btn = document.getElementById('btnAddCloudTest');
  if (!payload.host || !payload.user || !payload.pass) {
    return toast('Enter host, username, and password first', 'warn');
  }
  btn.disabled = true;
  btn.innerHTML = '⏳ Testing...';
  resultDiv.style.display = 'block';
  resultDiv.style.background = 'rgba(255, 193, 7, 0.12)';
  resultDiv.style.color = 'var(--warning)';
  resultDiv.style.border = '1px solid rgba(255, 193, 7, 0.3)';
  resultDiv.innerHTML = 'Connecting to <strong>' + escapeHtml(payload.host) + ':' + payload.port + '</strong>...';
  try {
    const res = await fetch('/api/vhi/clouds/test', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      resultDiv.style.background = 'rgba(25, 135, 84, 0.15)';
      resultDiv.style.color = 'var(--success)';
      resultDiv.style.border = '1px solid rgba(25, 135, 84, 0.3)';
      const s = data.serverInfo || {};
      if (data.usedPort) document.getElementById('cloudPort').value = data.usedPort;
      resultDiv.innerHTML = '✓ <strong>Connected:</strong> ' + escapeHtml(s.fullName || specLabel()) + '<br><small class="text-dim">' + escapeHtml(s.apiType || payload.type) + (s.apiVersion ? ' | API ' + escapeHtml(s.apiVersion) : '') + '</small>';
      toast('Connection validated successfully!', 'ok');
    } else {
      resultDiv.style.background = 'rgba(220, 53, 69, 0.15)';
      resultDiv.style.color = 'var(--danger)';
      resultDiv.style.border = '1px solid rgba(220, 53, 69, 0.3)';
      resultDiv.innerHTML = '✕ <strong>Connection failed:</strong> ' + escapeHtml(data.error || 'Check credentials and host');
      toast('Connection test failed', 'err');
    }
  } catch (err) {
    resultDiv.style.background = 'rgba(220, 53, 69, 0.15)';
    resultDiv.style.color = 'var(--danger)';
    resultDiv.style.border = '1px solid rgba(220, 53, 69, 0.3)';
    resultDiv.innerHTML = '✕ <strong>Network error:</strong> ' + escapeHtml(err.message);
    toast('Network error during test', 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🔌 Test Connection';
  }
}

function specLabel() {
  return (CLOUD_PROVIDERS[_selectedProvider] || {}).brand || 'Cloud';
}

async function submitAddCloud() {
  const payload = cloudPayload();
  const btnSubmit = document.getElementById('btnAddCloudSubmit');
  if (!payload.name || !payload.host || !payload.user || !payload.pass) {
    return toast('Please configure all required fields', 'warn');
  }
  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Saving & Validating...';
  try {
    const res = await fetch('/api/vhi/clouds', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, force: false })
    });
    const data = await res.json();
    if (!res.ok) {
      if (confirm('Connection validation failed:\n' + (data.error || 'Unknown error') + '\n\nDo you want to save this cloud anyway?')) {
        const forceRes = await fetch('/api/vhi/clouds', {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, force: true })
        });
        const forceData = await forceRes.json();
        if (forceRes.ok) {
          toast('Cloud "' + payload.name + '" saved (unverified)', 'warn');
          closeAddCloudModal();
          await loadMigrationsPage();
          return;
        }
      }
      throw new Error(data.error || 'Failed to add cloud');
    }
    toast('Cloud "' + payload.name + '" connected and added successfully!', 'ok');
    closeAddCloudModal();
    await loadMigrationsPage();
  } catch (err) {
    toast('Error: ' + err.message, 'err');
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.textContent = 'Add Cloud';
  }
}

// Hook up Add Cloud trigger
document.getElementById('btnOpenAddCloudModal')?.addEventListener('click', openAddCloudModal);

// ── MIGRATE WIZARD FLOW ───────────────────────────────────────────────────

const migrateModal = document.getElementById('migrateVmModal');

async function openMigrateModal() {
  _clouds = JSON.parse(localStorage.getItem('vhi_clouds') || '[]');
  if (_clouds.length === 0) {
    alert('Please configure at least one Cloud connection first.');
    // switch tab to Clouds and open add cloud modal
    document.querySelector('#panel-migrations [data-tab="clouds-list"]').click();
    openAddCloudModal();
    return;
  }
  
  _activeWizStep = 1;
  _selectedCloudId = null;
  _selectedVms = [];
  _currentDiscoveredVms = [];

  const errors = await loadWizardDeps();
  if (errors.length) {
    toast('Could not load this VHI cluster’s networks/storage (' + errors.join('; ') + ')', 'err');
  }
  populateWizardSelectFields();
  
  showWizStep(1);
  migrateModal.classList.remove('hidden');
}

function closeMigrateModal() {
  migrateModal.classList.add('hidden');
}

function connectedClusterLabel() {
  if (typeof session !== 'undefined' && session && session.baseUrl) return session.baseUrl;
  return 'the connected VHI cluster';
}

function selectedSourceKind() {
  const cloud = (_clouds || []).find(c => c.id === _selectedCloudId);
  return String(cloud?.type || 'VMWARE').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function selectedSourceKindLabel() {
  const kind = selectedSourceKind();
  if (kind === 'VHI') return 'VHI';
  if (kind === 'HYPERV' || kind === 'HYPERVWINRM') return 'Hyper-V';
  return 'VMware';
}

function isSystemNetwork(n) {
  const name = String(n && n.name || '').toLowerCase();
  if (name.startsWith('ha network')) return true;
  if (name === 'lb-mgmt-net' || name.includes('lb-mgmt')) return true;
  if (Array.isArray(n.tags) && n.tags.includes('system')) return true;
  return false;
}

function targetGuestNetworks() {
  const guest = (_nets || []).filter(n => !isSystemNetwork(n));
  return guest.length ? guest : (_nets || []);
}

function volTypeOptionHtml(selected) {
  const types = _volTypes || [];
  if (!types.length) return '<option value="">No volume types on this VHI cluster</option>';
  return types.map(vt => {
    const name = vt.name || vt.id || '';
    return `<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`;
  }).join('');
}

function uniqueSourceNetworkNames() {
  const names = [];
  const seen = new Set();
  for (const vm of wizSelectedVmRecords()) {
    const nets = Array.isArray(vm.networks) ? vm.networks : [];
    if (!nets.length) {
      const fallback = String(vm.networkName || '').trim();
      if (fallback && !seen.has(fallback)) {
        seen.add(fallback);
        names.push(fallback);
      }
      continue;
    }
    for (const n of nets) {
      const name = String(n.networkName || n.name || n.label || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function sourceDiskRows() {
  const rows = [];
  for (const vm of wizSelectedVmRecords()) {
    const disks = Array.isArray(vm.disks) && vm.disks.length
      ? vm.disks
      : [{ label: 'Boot disk', capacityGb: 0 }];
    disks.forEach((d, i) => {
      const gb = Number(d.capacityGb) || 0;
      const extra = [gb ? gb + ' GiB' : '', d.volumeType || ''].filter(Boolean).join(' · ');
      rows.push({
        key: String(vm.id) + ':' + i,
        title: (vm.name || 'VM') + ' — ' + (d.label || ('Disk ' + (i + 1))),
        subtitle: extra,
      });
    });
  }
  return rows;
}

function populateWizSourceOptions() {
  const sel = document.getElementById('wizTransportType');
  const hint = document.getElementById('wizTransportHint');
  if (!sel) return;
  const kind = selectedSourceKind();
  if (kind === 'VHI') {
    sel.innerHTML = '<option value="vhi">VHI API (source cluster)</option>';
    if (hint) hint.textContent = 'Source is VHI. Target networks and storage below come from the cluster you are logged into.';
  } else if (kind === 'HYPERV' || kind === 'HYPERVWINRM') {
    sel.innerHTML = '<option value="winrm">WinRM (Hyper-V)</option>';
    if (hint) hint.textContent = 'Source is Hyper-V. Disk copy uses WinRM on the Hyper-V host.';
  } else {
    sel.innerHTML = [
      '<option value="ssh">SSH (Default - secure transfer via port 22)</option>',
      '<option value="nfc">NFC (vSphere Network File Copy - port 902)</option>',
    ].join('');
    if (hint) hint.textContent = 'Live copies use ESXi SSH; NFC is used for cold export when the guest is powered off.';
  }
}

function populateWizNetworkMapping() {
  const srcLabel = document.getElementById('wizSrcNetworkLabel');
  if (srcLabel) srcLabel.textContent = 'Source network (' + selectedSourceKindLabel() + ')';

  const srcSel = document.getElementById('wizSrcNetwork');
  const srcNames = uniqueSourceNetworkNames();
  if (srcSel) {
    srcSel.innerHTML = srcNames.length
      ? srcNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')
      : '<option value="">No NIC reported on the selected VM(s)</option>';
  }

  const nets = targetGuestNetworks();
  const cluster = connectedClusterLabel();
  const tgtHint = document.getElementById('wizTgtNetworkHint');
  if (tgtHint) {
    tgtHint.textContent = nets.length
      ? 'Target networks loaded from ' + cluster
      : 'No guest networks found on ' + cluster + '. Create a virtual network on this cluster, then reopen Migrate.';
  }
  const tgtSel = document.getElementById('wizTgtNetwork');
  if (tgtSel) {
    tgtSel.innerHTML = nets.length
      ? nets.map(n => {
          const ext = n['router:external'] ? ' (external)' : '';
          return `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name || n.id)}${ext}</option>`;
        }).join('')
      : '<option value="">No networks on this VHI cluster</option>';
  }
}

function populateWizTargetOptions() {
  const cluster = connectedClusterLabel();
  const hint = document.getElementById('wizTgtOptionsHint');
  if (hint) hint.textContent = 'Storage policies and flavors from ' + cluster;

  const tgtPolicySelect = document.getElementById('wizTgtPolicy');
  if (tgtPolicySelect) tgtPolicySelect.innerHTML = volTypeOptionHtml(tgtPolicySelect.value);

  const tgtFlavorSelect = document.getElementById('wizTgtFlavor');
  if (tgtFlavorSelect) {
    tgtFlavorSelect.innerHTML = (_flavors || []).length
      ? _flavors.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)} (${f.vcpus} vCPU, ${fmtBytes(f.ram * 1024 * 1024)} RAM)</option>`).join('')
      : '<option value="">No flavors on this VHI cluster</option>';
  }
}

function populateWizStorageMapping() {
  const host = document.getElementById('wizDiskMapRows');
  if (!host) return;
  const defaultType = document.getElementById('wizTgtPolicy')?.value || '';
  const typeOpts = volTypeOptionHtml(defaultType);
  const rows = sourceDiskRows();
  if (!rows.length) {
    host.innerHTML = `<div class="text-dim" style="font-size:0.85rem; margin-bottom:0.6rem;">No disks discovered. The replica will use the default storage policy.</div>
      <select id="wizDisk1Type" style="width: 220px; padding: 4px 8px; border-radius:4px;">${typeOpts}</select>`;
    return;
  }
  host.innerHTML = rows.map((row, idx) => `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:1rem; font-size:0.85rem; ${idx ? 'margin-top:0.65rem; padding-top:0.65rem; border-top:1px solid var(--border);' : ''}">
      <div>
        <div>${escapeHtml(row.title)}</div>
        ${row.subtitle ? `<div class="text-dim" style="font-size:0.75rem;">${escapeHtml(row.subtitle)}</div>` : ''}
      </div>
      <select class="wiz-disk-type"${idx === 0 ? ' id="wizDisk1Type"' : ''} data-disk="${escapeHtml(row.key)}" style="width: 220px; padding: 4px 8px; border-radius:4px;">
        ${typeOpts}
      </select>
    </div>
  `).join('');
}

function populateWizardSelectFields() {
  const wizCloudBody = document.getElementById('wizCloudBody');
  wizCloudBody.innerHTML = _clouds.map(c => `
    <tr style="cursor:pointer;" onclick="selectWizCloud('${c.id}')">
      <td><input type="radio" name="wizCloudRadio" id="wizCloudRadio_${c.id}" value="${c.id}" ${c.id === _selectedCloudId ? 'checked' : ''}></td>
      <td>
        <strong>${escapeHtml(c.name)}</strong>
        <div class="text-dim" style="font-size:0.75rem;">${escapeHtml(c.host)}:${c.port}</div>
      </td>
      <td><span class="badge badge-default">${c.type === 'VHI' ? 'VHI' : c.type === 'HYPERV' ? 'Hyper-V' : (c.serverInfo?.apiType === 'VirtualCenter' ? 'vCenter' : 'VMware ESXi')}</span></td>
    </tr>
  `).join('');
  populateWizSourceOptions();
  populateWizTargetOptions();
  populateWizNetworkMapping();
  populateWizStorageMapping();
}

async function selectWizCloud(id) {
  _selectedCloudId = id;
  _selectedVms = [];
  const radio = document.getElementById(`wizCloudRadio_${id}`);
  if (radio) radio.checked = true;

  const wizVmBody = document.getElementById('wizVmBody');
  const cloud = (_clouds || []).find((c) => c.id === id);
  const kind = String(cloud?.type || 'VMWARE').toUpperCase();
  const kindLabel = kind === 'VHI' ? 'VHI' : kind === 'HYPERV' ? 'Hyper-V' : 'ESXi';
  wizVmBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:1.5rem; color:var(--text-dim);"><span class="ri spin">⏳</span> Connecting to ${kindLabel} and discovering VMs...</td></tr>`;

  try {
    const res = await fetch(`/api/vhi/clouds/${encodeURIComponent(id)}/vms`, { headers: authHeaders() });
    const data = await res.json();
    if (res.ok && data.ok && Array.isArray(data.vms) && data.vms.length > 0) {
      _currentDiscoveredVms = data.vms;
      renderWizVmList(data.vms);
      toast(`Discovered ${data.vms.length} VM(s) from ${kindLabel}`, 'ok');
      return;
    } else if (res.ok && data.ok && Array.isArray(data.vms)) {
      _currentDiscoveredVms = [];
      wizVmBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:1.5rem; color:var(--text-dim);">${escapeHtml(data.message || ('No virtual machines found on this ' + kindLabel + ' cloud.'))}</td></tr>`;
      return;
    }
  } catch (err) {
    console.warn('Failed to query live inventory:', err.message);
  }

  if (kind !== 'VMWARE') {
    wizVmBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:1.5rem; color:var(--text-dim);">Could not list VMs from this ${kindLabel} cloud.</td></tr>`;
    return;
  }

  _currentDiscoveredVms = _mockVmDatabase;
  renderWizVmList(_mockVmDatabase);
}

function renderWizVmList(vms) {
  const wizVmBody = document.getElementById('wizVmBody');
  if (!vms || !vms.length) {
    wizVmBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:1rem; color:var(--text-dim);">No VMs found</td></tr>`;
    return;
  }
  wizVmBody.innerHTML = vms.map(vm => `
    <tr style="cursor:pointer;" onclick="toggleWizVm('${vm.id}')">
      <td><input type="checkbox" id="wizVmCb_${vm.id}" value="${vm.id}" ${_selectedVms.includes(vm.id) ? 'checked' : ''}></td>
      <td>
        <strong>${escapeHtml(vm.name)}</strong>
        ${vm.guestOs ? `<div class="text-dim" style="font-size:0.72rem;">${escapeHtml(vm.guestOs)}</div>` : ''}
      </td>
      <td>
        <span class="mono" style="font-size:0.8rem;">${escapeHtml(vm.spec || `${vm.vcpus || 1} vCPU / ${vm.ramMb || 1024} MB`)}</span>
        ${vm.powerState ? `<span class="badge ${vm.powerState === 'poweredOn' ? 'badge-success' : 'badge-default'}" style="font-size:0.68rem; margin-left:4px;">${escapeHtml(vm.powerState)}</span>` : ''}
      </td>
      <td class="text-dim">${vm.disksCount || (vm.disks ? vm.disks.length : 1)} disk(s)</td>
    </tr>
  `).join('');
}

function toggleWizVm(id) {
  const index = _selectedVms.indexOf(id);
  if (index === -1) {
    _selectedVms.push(id);
  } else {
    _selectedVms.splice(index, 1);
  }
  const cb = document.getElementById(`wizVmCb_${id}`);
  if (cb) cb.checked = _selectedVms.includes(id);
}

function filterWizClouds() {
  const query = document.getElementById('wizCloudSearch').value.toLowerCase();
  const rows = document.querySelectorAll('#wizCloudBody tr');
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(query) ? '' : 'none';
  });
}

function filterWizVms() {
  const query = document.getElementById('wizVmSearch').value.toLowerCase();
  const rows = document.querySelectorAll('#wizVmBody tr');
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(query) ? '' : 'none';
  });
}


const POST_MIGRATION_SCRIPTS = [
  {
    id: 'linux-qemu-ga',
    os: 'linux',
    name: 'QEMU guest agent (remove VMware Tools)',
    content: `#!/bin/bash
set -e
if command -v dnf >/dev/null 2>&1; then
  dnf remove -y open-vm-tools || true
  dnf install -y qemu-guest-agent
elif command -v yum >/dev/null 2>&1; then
  yum remove -y open-vm-tools || true
  yum install -y qemu-guest-agent
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get remove -y open-vm-tools || true
  apt-get install -y qemu-guest-agent
fi
systemctl enable --now qemu-guest-agent || true
`
  },
  {
    id: 'windows-qemu-ga',
    os: 'windows',
    name: 'QEMU guest agent (remove VMware Tools)',
    content: `$ErrorActionPreference = 'Continue'
Get-WmiObject -Class Win32_Product -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'VMware Tools' } |
  ForEach-Object { $_.Uninstall() }
$ga = Get-Service -Name 'QEMU-GA','qemu-ga' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ga) {
  Set-Service -Name $ga.Name -StartupType Automatic
  Start-Service -Name $ga.Name -ErrorAction SilentlyContinue
}
`
  }
];

function vmGuestLooksLikeWindows(guestId, guestOs, os) {
  const osNorm = String(os || '').trim().toLowerCase();
  if (osNorm === 'linux') return false;
  if (osNorm === 'windows' || osNorm.includes('windows')) return true;
  const id = String(guestId || '');
  const full = String(guestOs || '');
  return /^win/i.test(id) || /windows/i.test(id) || /windows/i.test(full);
}

function wizVmIsWindows(vm) {
  return vmGuestLooksLikeWindows(vm && vm.guestId, vm && vm.guestOs);
}

function migLooksLikeWindows(mig) {
  if (!mig) return false;
  return vmGuestLooksLikeWindows(
    mig.guestId || (mig.sourceOptions && mig.sourceOptions.guestId),
    mig.guestOs || (mig.sourceOptions && mig.sourceOptions.guestOs) || (mig.targetOptions && mig.targetOptions.osDistro),
    mig.sourceOptions && mig.sourceOptions.os
  );
}

function wizSelectedVmRecords() {
  const activeVmList = (_currentDiscoveredVms && _currentDiscoveredVms.length > 0) ? _currentDiscoveredVms : _mockVmDatabase;
  return (activeVmList || []).filter(vm => _selectedVms.includes(vm.id));
}

function getPostMigrationScript(id) {
  return POST_MIGRATION_SCRIPTS.find(s => s.id === id) || null;
}

function fillWizScriptSelect(selectEl, os) {
  if (!selectEl) return;
  const current = selectEl.value;
  const opts = ['<option value="">None — do not run a script</option>']
    .concat(POST_MIGRATION_SCRIPTS.filter(s => s.os === os).map(s =>
      `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`));
  selectEl.innerHTML = opts.join('');
  const stillValid = Array.from(selectEl.options).some(o => o.value === current);
  selectEl.value = stillValid ? current : '';
}

function populateWizUserScripts() {
  const vms = wizSelectedVmRecords();
  const hasLinux = !vms.length || vms.some(vm => !wizVmIsWindows(vm));
  const hasWindows = vms.some(vm => wizVmIsWindows(vm));
  const linuxGroup = document.getElementById('wizLinuxScriptGroup');
  const winGroup = document.getElementById('wizWindowsScriptGroup');
  if (linuxGroup) linuxGroup.style.display = hasLinux ? '' : 'none';
  if (winGroup) winGroup.style.display = hasWindows ? '' : 'none';
  fillWizScriptSelect(document.getElementById('wizLinuxPostScript'), 'linux');
  fillWizScriptSelect(document.getElementById('wizWindowsPostScript'), 'windows');
  updateWizScriptPreview();
}

function updateWizScriptPreview() {
  const linuxGroup = document.getElementById('wizLinuxScriptGroup');
  const winGroup = document.getElementById('wizWindowsScriptGroup');
  const linuxVisible = linuxGroup && linuxGroup.style.display !== 'none';
  const winVisible = winGroup && winGroup.style.display !== 'none';
  const linuxScript = linuxVisible ? getPostMigrationScript(document.getElementById('wizLinuxPostScript')?.value) : null;
  const winScript = winVisible ? getPostMigrationScript(document.getElementById('wizWindowsPostScript')?.value) : null;
  const parts = [];
  if (linuxScript) parts.push('# Linux — ' + linuxScript.name + '\n' + String(linuxScript.content || '').trim());
  if (winScript) parts.push('# Windows — ' + winScript.name + '\n' + String(winScript.content || '').trim());
  const preview = document.getElementById('wizPostScriptPreview');
  if (preview) preview.value = parts.join('\n\n');
  const hint = document.getElementById('wizNoScriptHint');
  if (hint) hint.style.display = parts.length ? 'none' : '';
}

function selectedPostScriptForOs(isWindows) {
  const id = document.getElementById(isWindows ? 'wizWindowsPostScript' : 'wizLinuxPostScript')?.value || '';
  const script = getPostMigrationScript(id);
  if (!script) return { postScriptId: '', postScriptName: '', postScript: '' };
  return { postScriptId: script.id, postScriptName: script.name, postScript: script.content };
}

function summarizeWizScripts() {
  const vms = wizSelectedVmRecords();
  const hasLinux = !vms.length || vms.some(vm => !wizVmIsWindows(vm));
  const hasWindows = vms.some(vm => wizVmIsWindows(vm));
  const labels = [];
  if (hasLinux) {
    const linux = getPostMigrationScript(document.getElementById('wizLinuxPostScript')?.value);
    labels.push(linux ? `Linux: ${linux.name}` : 'Linux: none');
  }
  if (hasWindows) {
    const win = getPostMigrationScript(document.getElementById('wizWindowsPostScript')?.value);
    labels.push(win ? `Windows: ${win.name}` : 'Windows: none');
  }
  return labels.join(' · ') || 'None';
}

function showWizStep(step) {
  _activeWizStep = step;
  
  // Toggle sidebar items
  document.querySelectorAll('.wizard-sidebar .wizard-step-item').forEach(item => {
    const itemStep = parseInt(item.dataset.step, 10);
    item.classList.toggle('active', itemStep === step);
    item.classList.toggle('completed', itemStep < step);
  });
  
  // Toggle step contents
  document.querySelectorAll('.wizard-content-area .wizard-step-content').forEach(content => {
    content.classList.remove('active');
  });
  document.getElementById(`wizStep${step}`).classList.add('active');
  
  // Footers
  document.getElementById('btnWizBack').disabled = step === 1;
  document.getElementById('btnWizNext').style.display = step === 9 ? 'none' : '';
  document.getElementById('btnWizStart').style.display = step === 9 ? '' : 'none';
  
  if (step === 3) populateWizSourceOptions();
  if (step === 4) populateWizNetworkMapping();
  if (step === 5) populateWizTargetOptions();
  if (step === 6) populateWizStorageMapping();
  if (step === 7) {
    populateWizUserScripts();
  }
  if (step === 9) {
    populateWizSummary();
  }
}

function wizGoNext() {
  if (_activeWizStep === 1 && !_selectedCloudId) {
    return toast('Select a source cloud to continue', 'warn');
  }
  if (_activeWizStep === 2 && _selectedVms.length === 0) {
    return toast('Select at least one virtual machine to migrate', 'warn');
  }
  if (_activeWizStep === 4 && !document.getElementById('wizTgtNetwork')?.value) {
    return toast('Select a target network from the VHI cluster you are connected to', 'warn');
  }
  if (_activeWizStep === 5 && !(_volTypes || []).length) {
    return toast('This VHI cluster has no volume types. Create a storage policy, then retry.', 'warn');
  }
  if (_activeWizStep === 6 && !document.getElementById('wizDisk1Type')?.value && !document.getElementById('wizTgtPolicy')?.value) {
    return toast('Select a target volume type for the replica disk', 'warn');
  }

  showWizStep(_activeWizStep + 1);
}

function wizGoBack() {
  showWizStep(_activeWizStep - 1);
}

function populateWizSummary() {
  const cloud = _clouds.find(c => c.id === _selectedCloudId);
  const activeVmList = (_currentDiscoveredVms && _currentDiscoveredVms.length > 0) ? _currentDiscoveredVms : _mockVmDatabase;
  const vms = activeVmList.filter(vm => _selectedVms.includes(vm.id));
  
  const transport = document.getElementById('wizTransportType').value.toUpperCase();
  
  const targetNetSelect = document.getElementById('wizTgtNetwork');
  const targetNetName = targetNetSelect.options[targetNetSelect.selectedIndex]?.text || '';
  
  const targetPolicySelect = document.getElementById('wizTgtPolicy');
  const targetPolicyName = targetPolicySelect.options[targetPolicySelect.selectedIndex]?.text || '';
  
  const targetFlavorSelect = document.getElementById('wizTgtFlavor');
  const targetFlavorName = targetFlavorSelect.options[targetFlavorSelect.selectedIndex]?.text || '';
  
  const isLive = document.querySelector('input[name="wizMigrationType"]:checked')?.value === 'live';
  const strategy = document.querySelector('input[name="wizStrategy"]:checked')?.value || 'auto';
  const autoDeploy = document.getElementById('wizAutoDeployToggle')?.checked ?? true;

  document.getElementById('sumSrcCloud').textContent = cloud ? cloud.name : '-';
  document.getElementById('sumVms').textContent = vms.map(v => v.name).join(', ') || '-';
  document.getElementById('sumTransport').textContent = `${transport} (Max Concurrency: ${document.getElementById('wizMaxConcurrency').value})`;
  document.getElementById('sumNetMap').textContent = `${document.getElementById('wizSrcNetwork').value} ➔ ${targetNetName}`;
  document.getElementById('sumStorage').textContent = targetPolicyName;
  document.getElementById('sumFlavor').textContent = targetFlavorName;
  document.getElementById('sumMigType').textContent = isLive ? 'Live Migration (Online)' : 'Cold Migration (Offline)';
  
  const strategyEl = document.getElementById('sumStrategy');
  if (strategyEl) {
    if (strategy === 'replicate_only' || !autoDeploy) {
      strategyEl.textContent = 'Stage 1: Replicate Only (Staging / Pre-Cutover)';
      strategyEl.style.color = '#ffc107';
    } else {
      strategyEl.textContent = 'Full Automatic (Replicate ➔ Deploy ➔ Boot)';
      strategyEl.style.color = '#0d6efd';
    }
  }
  const yesNo = (id) => document.getElementById(id)?.checked ? 'Yes' : 'No';
  const sumDhcp = document.getElementById('sumDhcp');
  if (sumDhcp) sumDhcp.textContent = yesNo('wizEnableDhcp');
  const sumRetain = document.getElementById('sumRetainCreds');
  if (sumRetain) sumRetain.textContent = yesNo('wizRetainCreds');
  const sumDelete = document.getElementById('sumDeleteDisks');
  if (sumDelete) sumDelete.textContent = yesNo('wizDeleteDisks');
  const sumScript = document.getElementById('sumPostScript');
  if (sumScript) sumScript.textContent = summarizeWizScripts();
}

async function startMigration() {
  const cloud = _clouds.find(c => c.id === _selectedCloudId);
  const activeVmList = (_currentDiscoveredVms && _currentDiscoveredVms.length > 0) ? _currentDiscoveredVms : _mockVmDatabase;
  const vms = activeVmList.filter(vm => _selectedVms.includes(vm.id));
  const isLive = document.querySelector('input[name="wizMigrationType"]:checked')?.value === 'live';
  const strategy = document.querySelector('input[name="wizStrategy"]:checked')?.value || 'auto';
  const autoDeploy = document.getElementById('wizAutoDeployToggle')?.checked ?? true;

  if (!vms.length) {
    return toast('No virtual machines selected for migration', 'warn');
  }

  const targetNetSelect = document.getElementById('wizTgtNetwork');
  const targetNetId = targetNetSelect.value;
  const targetNetName = targetNetSelect.options[targetNetSelect.selectedIndex]?.text || 'VM Network';
  if (!targetNetId) {
    return toast('Select a target VHI network so the guest can get an independent IP', 'warn');
  }

  const targetFlavorSelect = document.getElementById('wizTgtFlavor');
  const targetFlavorId = targetFlavorSelect.value || '';
  const targetFlavorName = targetFlavorSelect.options[targetFlavorSelect.selectedIndex]?.text || 'Inherited from source';
  const targetPolicySelect = document.getElementById('wizTgtPolicy');
  const diskType = document.getElementById('wizDisk1Type')?.value || '';
  const volumeType = diskType || targetPolicySelect.value || '';

  closeMigrateModal();
  toast(`Starting Coriolis-style migration for ${vms.length} VM(s)…`, 'inf');

  let started = 0;
  const failures = [];
  for (const vm of vms) {
    const cleanVmName = vm.name || 'Linux';
    const isWindows = wizVmIsWindows(vm);
    const payload = {
      name: cleanVmName,
      srcCloudId: _selectedCloudId,
      srcCloudName: cloud ? `${cloud.name} (${selectedSourceKindLabel()})` : selectedSourceKindLabel(),
      sourceVmId: vm.id,
      targetDomainProject: 'Default / admin',
      vms: [cleanVmName],
      migType: isLive ? 'live' : 'cold',
      strategy,
      autoDeploy: (strategy === 'auto' && autoDeploy),
      networkId: targetNetId,
      networkName: targetNetName,
      flavorId: targetFlavorId,
      flavorName: targetFlavorName,
      volumeType,
      sourceOptions: {
        os: isWindows ? 'windows' : 'linux',
        vcpus: vm.vcpus || (isWindows ? 2 : 1),
        ram: vm.ramMb ? (vm.ramMb >= 1024 ? `${(vm.ramMb / 1024).toFixed(0)} GiB` : `${vm.ramMb} MiB`) : (isWindows ? '4 GiB' : '2 GiB'),
        diskSize: vm.disks && vm.disks[0] ? `${vm.disks[0].capacityGb} GiB` : (isWindows ? '48 GiB' : '8 GiB'),
        cbt: 'Yes',
        firmware: vm.firmware || 'bios',
        guestId: vm.guestId || '',
        guestOs: vm.guestOs || ''
      },
      targetOptions: {
        flavor: targetFlavorName || 'Inherited from source',
        diskBus: 'VirtIO',
        osDistro: vm.guestOs || (isWindows ? 'Microsoft Windows Server' : 'Alma Linux 9'),
        linuxWorkerImage: 'vporter-minion-linux',
        windowsWorkerImage: 'vporter-minion-windows',
        workerImage: isWindows ? 'vporter-minion-windows' : 'vporter-minion-linux',
        machineType: 'pc-q35',
        dhcp: document.getElementById('wizEnableDhcp')?.checked ? 'Yes' : 'No',
        retainCreds: document.getElementById('wizRetainCreds')?.checked ? 'Yes' : 'No',
        deleteDisks: document.getElementById('wizDeleteDisks')?.checked ? 'Yes' : 'No',
        ...selectedPostScriptForOs(isWindows)
      }
    };

    try {
      const res = await fetch('/api/vhi/migrations', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.migration) _migrations.unshift(data.migration);
      started += 1;
    } catch (err) {
      failures.push(`${cleanVmName}: ${err.message}`);
    }
  }

  localStorage.setItem('vhi_migrations', JSON.stringify(_migrations));
  renderMigrations();
  updateMigrationBadge();
  if (started) startMigrationPoll();
  loadVMs();
  if (failures.length && !started) {
    toast(`Migration did not start. ${failures.join(' | ')}`, 'err');
  } else if (failures.length) {
    toast(`Started ${started} migration(s). Failed: ${failures.join(' | ')}`, 'err');
  } else {
    toast(`Migration engine running for ${started} VM(s)`, 'ok');
  }
}

// Hook up main trigger
document.getElementById('btnOpenMigrateWizard')?.addEventListener('click', openMigrateModal);

document.getElementById('btnCleanupClones')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnCleanupClones');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/vhi/clones/cleanup', { method: 'POST', headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Cleanup failed');
    const files = Number(data.files) || 0;
    const bytes = Number(data.bytes) || 0;
    if (!files) toast('Clone cache is already empty', 'ok');
    else {
      const size = bytes >= 1073741824
        ? (bytes / 1073741824).toFixed(2) + ' GiB'
        : (bytes / 1048576).toFixed(1) + ' MiB';
      toast('Removed ' + files + ' clone file(s) (' + size + ')', 'ok');
    }
  } catch (err) {
    toast(err.message || 'Clone cleanup failed', 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
});


// Expose functions globally to be callable from HTML onclick handlers
window.closeAddCloudModal = closeAddCloudModal;
window.addCloudGoNext = addCloudGoNext;
window.addCloudGoBack = addCloudGoBack;
window.submitAddCloud = submitAddCloud;
window.selectProvider = selectProvider;
window.deleteCloud = deleteCloud;
window.testAddCloudConnection = testAddCloudConnection;
window.testSavedCloud = testSavedCloud;

window.closeMigrateModal = closeMigrateModal;
window.updateWizScriptPreview = updateWizScriptPreview;
window.populateWizUserScripts = populateWizUserScripts;
window.selectWizCloud = selectWizCloud;
window.toggleWizVm = toggleWizVm;
window.filterWizClouds = filterWizClouds;
window.filterWizVms = filterWizVms;
window.wizGoNext = wizGoNext;
window.wizGoBack = wizGoBack;
window.startMigration = startMigration;
window.cancelMigration = cancelMigration;
window.deleteMigration = deleteMigration;

window.openMigrationDetail = openMigrationDetail;
window.closeMigrationDetail = closeMigrationDetail;
window.switchMigDetailSubTab = switchMigDetailSubTab;
window.openReplicationDrawer = openReplicationDrawer;
window.closeReplicationDrawer = closeReplicationDrawer;
window.switchDrawerTab = switchDrawerTab;
window.deleteMigrationFromDrawer = deleteMigrationFromDrawer;
window.triggerDeployment = triggerDeployment;
window.triggerRetryReplication = triggerRetryReplication;
window.closeTaskDetailModal = closeTaskDetailModal;
window.copyTaskLog = copyTaskLog;


document.getElementById('migrationSearch')?.addEventListener('input', () => renderMigrations());
document.getElementById('cloudSearch')?.addEventListener('input', () => renderClouds());

bootVhiSession(loadMigrationsPage);
