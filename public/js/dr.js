'use strict';

let _drPlans = [];
let _drSelectedPlanId = null;
let _drPollTimer = null;
let _drProbe = null;
let _drProgressPlanId = null;
let _drCleanupPlanId = null;

function hostFromUrl(url) {
  return String(url || '').replace(/^https?:\/\//, '').split(/[:/]/)[0] || url || '–';
}

function clusterShort(ctx) {
  if (!ctx) return '–';
  const host = hostFromUrl(ctx.vhiBaseUrl);
  return host + ' · ' + (ctx.vhiProject || 'admin');
}

function currentSessionUrl() {
  return String(session?.baseUrl || '').replace(/\/+$/, '');
}

function normalizeClusterUrl(url) {
  let value = String(url || '').trim().replace(/\/+$/, '');
  if (value && !/^https?:\/\//i.test(value)) value = 'https://' + value;
  return value;
}

function listDrTargets() {
  const current = normalizeClusterUrl(currentSessionUrl());
  const seen = new Set();
  const out = [];
  (typeof readSavedClusters === 'function' ? readSavedClusters() : []).forEach((c) => {
    const url = normalizeClusterUrl(c.baseUrl);
    if (!url || url === current || seen.has(url)) return;
    seen.add(url);
    out.push({
      id: c.id || url,
      label: hostFromUrl(url) + ' · ' + (c.project || 'admin'),
      vhiBaseUrl: url,
      vhiUser: c.username,
      vhiPassword: c.password,
      vhiProject: c.project || 'admin',
      vhiDomain: c.userDomain || 'Default',
      vhiProjectDomain: c.projectDomain || c.userDomain || 'Default',
    });
  });
  return out;
}

function readManualDrContext() {
  return {
    vhiBaseUrl: document.getElementById('drManualHost')?.value.trim(),
    vhiUser: document.getElementById('drManualUser')?.value.trim(),
    vhiPassword: document.getElementById('drManualPass')?.value,
    vhiProject: document.getElementById('drManualProject')?.value.trim() || 'admin',
    vhiDomain: document.getElementById('drManualDomain')?.value.trim() || 'Default',
    vhiProjectDomain: document.getElementById('drManualProjDomain')?.value.trim() || 'Default',
  };
}

function selectedDrContext() {
  const sel = document.getElementById('drTargetSelect');
  if (!sel || sel.value === 'manual') return readManualDrContext();
  const hit = listDrTargets().find((t) => t.id === sel.value);
  if (!hit) return readManualDrContext();
  const overridePass = document.getElementById('drSavedPass')?.value || '';
  return {
    vhiBaseUrl: hit.vhiBaseUrl,
    vhiUser: hit.vhiUser,
    vhiPassword: overridePass || hit.vhiPassword,
    vhiProject: hit.vhiProject,
    vhiDomain: hit.vhiDomain,
    vhiProjectDomain: hit.vhiProjectDomain,
    vhiProjectId: '',
  };
}

function fillDrTargetSelect() {
  const sel = document.getElementById('drTargetSelect');
  if (!sel) return;
  const targets = listDrTargets();
  const options = targets.map((t) =>
    `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`
  );
  options.push('<option value="manual">Enter DR cluster manually…</option>');
  sel.innerHTML = options.join('');
  if (!targets.length) sel.value = 'manual';
  const hint = document.getElementById('drNoClusterHint');
  if (hint) hint.style.display = targets.length ? 'none' : 'block';
  syncDrManualFields();
}

function syncDrManualFields() {
  const wrap = document.getElementById('drManualFields');
  const sel = document.getElementById('drTargetSelect');
  if (!wrap || !sel) return;
  const manual = sel.value === 'manual';
  wrap.classList.toggle('hidden', !manual);
  const savedWrap = document.getElementById('drSavedPassWrap');
  if (savedWrap) savedWrap.classList.toggle('hidden', manual || !sel.value);
  const btn = document.getElementById('drConnectClusterBtn');
  if (btn) btn.style.display = manual ? '' : 'none';
}

function updateDrBadge() {
  const badge = document.getElementById('drBadge');
  if (!badge) return;
  const n = _drPlans.length;
  badge.textContent = n || '–';
  badge.style.display = n ? '' : 'none';
}

function drBusyStatus(status) {
  return ['syncing', 'staging', 'failing_over', 'cleaning_up'].includes(status);
}

function planProcedure(plan) {
  const vms = plan?.protected || [];
  const rows = vms.map((vm) => {
    const vols = vm.volumes || [];
    const replicas = vols.filter((v) => v.replicaVolumeId);
    return {
      name: vm.sourceServerName || vm.sourceServerId,
      synced: vols.length > 0 && replicas.length === vols.length,
      replicaId: replicas.map((v) => v.replicaVolumeId).join(', '),
      staged: !!vm.standbyServerId,
      standbyId: vm.standbyServerId || '',
      failedOver: vm.status === 'failed_over' || plan.status === 'failed_over',
      error: vm.lastError || '',
    };
  });
  return {
    rows,
    allSynced: rows.length > 0 && rows.every((r) => r.synced),
    allStaged: rows.length > 0 && rows.every((r) => r.staged),
    failedOver: plan?.status === 'failed_over',
  };
}

function showDrProcedure(id) {
  const plan = _drPlans.find((p) => p.id === id);
  if (plan) openDrGuide(plan, (plan.protected || []).length ? 'view' : 'protect');
}

async function ensureDrVms() {
  if (typeof loadVMs === 'function') {
    if (!Array.isArray(_vms) || !_vms.length) {
      try { await loadVMs(); } catch (err) { console.warn('DR load VMs:', err.message); }
    }
    return;
  }
  try {
    const data = await apiGet('/api/vhi/servers');
    window._vms = data.servers || [];
  } catch (err) {
    window._vms = [];
    console.warn('DR load VMs:', err.message);
  }
}

function openDrProgress(plan, action, note) {
  openDrGuide(plan, action, note);
}

async function openDrGuide(plan, action, note) {
  if (!plan) return;
  _drProgressPlanId = plan.id;
  await ensureDrVms();
  closeDrDrawer();
  openModal('drProgressModal');
  renderDrProgress(plan, action, note);
  startDrPoll();
}

function closeDrProgress() {
  _drProgressPlanId = null;
  closeModal('drProgressModal');
}

function renderDrProgress(plan, action, note) {
  if (!plan) return;
  const proc = planProcedure(plan);
  const title = document.getElementById('drProgressTitle');
  if (title) title.textContent = (plan.name || 'DR plan') + ' — next steps';
  const stepsEl = document.getElementById('drProgressSteps');
  const statusEl = document.getElementById('drProgressStatus');
  const logWrap = document.getElementById('drProgressLogWrap');
  const nextBtn = document.getElementById('drProgressNextBtn');
  const protectWrap = document.getElementById('drProgressProtectWrap');
  const protectList = document.getElementById('drProgressProtectList');
  const hasVms = proc.rows.length > 0;
  const protecting = !hasVms || action === 'protect';

  const syncing = plan.status === 'syncing' || action === 'sync';
  const staging = plan.status === 'staging' || action === 'stage';
  const failing = plan.status === 'failing_over' || action === 'failover';
  function cls(done, active, blocked) {
    if (done) return 'done';
    if (blocked) return 'blocked';
    if (active) return 'active';
    return 'todo';
  }
  function mark(done, active, blocked) {
    if (done) return '✓';
    if (blocked) return '!';
    if (active) return '●';
    return '○';
  }
  const vmSync = proc.rows.map((r) => escapeHtml(r.name) + ': ' + (r.synced ? ('replica ' + escapeHtml((r.replicaId || '').slice(0, 8))) : 'not copied yet')).join('<br>') || 'No protected VMs';
  const vmStage = proc.rows.map((r) => {
    if (r.staged) return escapeHtml(r.name) + ': standby ' + escapeHtml((r.standbyId || '').slice(0, 8));
    if (r.synced) return escapeHtml(r.name) + ': replica is on DR, standby VM not created';
    return escapeHtml(r.name) + ': needs Sync first';
  }).join('<br>') || 'No protected VMs';
  const failDetail = proc.failedOver
    ? 'Standbys are ACTIVE on DR'
    : (proc.allStaged ? 'Ready to start standbys on DR' : 'Blocked until every VM is staged');

  if (stepsEl) {
    stepsEl.innerHTML =
      `<li class="dr-step ${cls(hasVms, protecting && !hasVms, false)}"><span class="dr-step-mark">${mark(hasVms, protecting && !hasVms, false)}</span><div><strong>1. Add VMs</strong> choose guests on this primary to protect<div class="dr-step-detail">${hasVms ? proc.rows.map((r) => escapeHtml(r.name)).join(', ') : 'None selected yet'}</div></div></li>` +
      `<li class="dr-step ${cls(proc.allSynced, syncing, !hasVms)}"><span class="dr-step-mark">${mark(proc.allSynced, syncing, !hasVms)}</span><div><strong>2. Sync</strong> snapshot on primary, Glance copy, replica volume on DR<div class="dr-step-detail">${hasVms ? vmSync : 'Add VMs first'}</div></div></li>` +
      `<li class="dr-step ${cls(proc.allStaged, staging, !proc.allSynced)}"><span class="dr-step-mark">${mark(proc.allStaged, staging, !proc.allSynced)}</span><div><strong>3. Stage</strong> create SHUTOFF standby VMs on DR from the latest replica<div class="dr-step-detail">${hasVms ? vmStage : 'Add VMs first'}</div></div></li>` +
      `<li class="dr-step ${cls(proc.failedOver, failing, !proc.allStaged)}"><span class="dr-step-mark">${mark(proc.failedOver, failing, !proc.allStaged)}</span><div><strong>4. Failover</strong> if primary is reachable, stop the source VM; then start the DR standby<div class="dr-step-detail">${failDetail}</div></div></li>`;
  }

  const failed = plan.status === 'failed_over';
  const available = (typeof _vms !== 'undefined' ? _vms : []).filter((vm) =>
    !(plan.protected || []).some((p) => p.sourceServerId === vm.id)
  );
  if (protectWrap && protectList) {
    const showPicker = !failed && available.length > 0 && (!hasVms || action === 'protect');
    protectWrap.classList.toggle('hidden', !showPicker);
    if (showPicker) {
      protectList.innerHTML = available.map((vm) =>
        `<label class="dr-check"><input type="checkbox" value="${escapeHtml(vm.id)}"> ${escapeHtml(vm.name || vm.id)} ${statusBadge(vm.status)}</label>`
      ).join('');
    } else if (!hasVms && !failed) {
      protectWrap.classList.remove('hidden');
      protectList.innerHTML = '<p class="text-dim">No VMs loaded. Open Virtual Machines once so this list can fill, then return here.</p>';
    }
  }

  let statusText = note || '';
  if (!statusText) {
    if (plan.status === 'syncing') statusText = 'Sync in progress: copying disks from primary to DR.';
    else if (plan.status === 'staging') statusText = 'Stage in progress: creating SHUTOFF standbys on DR.';
    else if (plan.status === 'failing_over') statusText = 'Failover in progress: starting standbys on DR.';
    else if (plan.status === 'cleaning_up') statusText = 'Cleanup in progress: removing DR VM, snapshots, and volumes, then starting the primary VM.';
    else if (plan.lastError) statusText = plan.lastError;
    else if (proc.failedOver) statusText = 'Failover complete.';
    else if (!hasVms) statusText = 'Plan created. Select VMs below, then Protect selected.';
    else if (proc.allStaged) statusText = 'Synced and staged. Next step: Failover.';
    else if (proc.allSynced) statusText = 'Sync complete. Replica is on DR, but no standby VM yet. Next step: Stage.';
    else statusText = 'VMs are in the plan. Next step: Sync to copy volumes to the DR cluster.';
  }
  if (statusEl) {
    const err = plan.status === 'error' || /blocked|failed|not created|must finish/i.test(statusText);
    statusEl.className = 'dr-progress-status' + (err ? ' err' : '');
    statusEl.textContent = statusText;
  }
  if (logWrap) {
    logWrap.innerHTML = renderDrLog(plan.log, 'drProgressLogInner');
    const logEl = document.getElementById('drProgressLogInner');
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  }
  if (nextBtn) {
    nextBtn.onclick = null;
    if (drBusyStatus(plan.status) || proc.failedOver) {
      nextBtn.classList.add('hidden');
    } else if (!hasVms) {
      nextBtn.classList.remove('hidden');
      nextBtn.textContent = 'Protect selected';
      nextBtn.onclick = () => protectSelectedVms(plan.id, '#drProgressProtectList');
    } else if (!proc.allSynced) {
      nextBtn.classList.remove('hidden');
      nextBtn.textContent = 'Sync now';
      nextBtn.onclick = () => syncDrPlan(plan.id);
    } else if (!proc.allStaged) {
      nextBtn.classList.remove('hidden');
      nextBtn.textContent = 'Stage now';
      nextBtn.onclick = () => stageDrPlan(plan.id);
    } else {
      nextBtn.classList.remove('hidden');
      nextBtn.textContent = 'Failover now';
      nextBtn.onclick = () => failoverDrPlan(plan.id);
    }
  }
}

function stopDrPoll() {
  if (_drPollTimer) {
    clearInterval(_drPollTimer);
    _drPollTimer = null;
  }
}

function startDrPoll() {
  stopDrPoll();
  _drPollTimer = setInterval(async () => {
    const busy = _drPlans.some((p) => drBusyStatus(p.status)) || _drProgressPlanId;
    if (!busy) {
      stopDrPoll();
      return;
    }
    try {
      await loadDrPlans({ quiet: true });
      if (_drSelectedPlanId) {
        const plan = _drPlans.find((p) => p.id === _drSelectedPlanId);
        if (plan) renderDrDrawer(plan);
      }
      if (_drCleanupPlanId && !_drPlans.some((p) => p.id === _drCleanupPlanId)) {
        toast('DR plan deleted. DR VM, snapshots, and volumes were removed; the primary VM was started.', 'ok');
        if (_drSelectedPlanId === _drCleanupPlanId) closeDrDrawer();
        if (_drProgressPlanId === _drCleanupPlanId) {
          const statusEl = document.getElementById('drProgressStatus');
          if (statusEl) {
            statusEl.className = 'dr-progress-status';
            statusEl.textContent = 'Cleanup finished. Plan deleted.';
          }
        }
        _drCleanupPlanId = null;
        _drProgressPlanId = null;
      } else if (_drProgressPlanId) {
        const plan = _drPlans.find((p) => p.id === _drProgressPlanId);
        if (plan) renderDrProgress(plan);
      }
    } catch (err) {
      console.warn('DR poll:', err.message);
    }
  }, 2000);
}

async function loadDrPlans(opts) {
  const body = document.getElementById('drBody');
  if (body && !opts?.quiet) body.innerHTML = skeletonRows(7);
  try {
    const data = await apiGet('/api/vhi/dr');
    _drPlans = data.plans || [];
    renderDrPlans(document.getElementById('drSearch')?.value || '');
    updateDrBadge();
    if (_drPlans.some((p) => drBusyStatus(p.status)) || _drProgressPlanId) startDrPoll();
  } catch (err) {
    if (body) body.innerHTML = emptyState('🛟', err.message || 'Could not load DR plans');
    if (!opts?.quiet) toast('DR plans: ' + err.message, 'err');
  }
}

function renderDrPlans(query) {
  const body = document.getElementById('drBody');
  const count = document.getElementById('drCount');
  if (!body) return;
  const q = String(query || '').toLowerCase();
  const rows = _drPlans.filter((p) => {
    if (!q) return true;
    const hay = [p.name, p.status, clusterShort(p.primary), clusterShort(p.dr), p.lastError]
      .join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (count) count.textContent = rows.length + (rows.length === 1 ? ' plan' : ' plans');
  if (!rows.length) {
    body.innerHTML = emptyState('🛟', q ? 'No matching DR plans' : 'No DR plans yet. Pair this cluster with another VHI site.');
    return;
  }
  body.innerHTML = rows.map((p) => {
    const vms = (p.protected || []).length;
    const last = p.lastSyncAt ? fmtDate(p.lastSyncAt) : 'Never';
    const failed = p.status === 'failed_over';
    const busy = drBusyStatus(p.status);
    const proc = planProcedure(p);
    const stageLabel = (failed || proc.allStaged) ? 'Restage' : 'Stage';
    const stageTitle = failed
      ? 'Recreate the DR guest with UEFI/BIOS so it can boot (fixes a SeaBIOS hang). The replica disk is kept.'
      : (proc.allSynced ? 'Create SHUTOFF standbys on DR' : 'Sync must finish before Stage');
    const failTitle = failed ? 'Already failed over' : (proc.allStaged ? 'Start standbys on DR' : 'Stage standbys before Failover');
    return `<tr class="clickable" onclick="openDrPlan('${escapeHtml(p.id)}')">
      <td><strong>${escapeHtml(p.name || 'Untitled')}</strong></td>
      <td class="mono" style="font-size:.8rem;">${escapeHtml(clusterShort(p.primary))} → ${escapeHtml(clusterShort(p.dr))}</td>
      <td>${statusBadge(p.status)}</td>
      <td>${vms}</td>
      <td>${escapeHtml(String(p.syncIntervalMinutes || 60))} min</td>
      <td>${escapeHtml(last)}</td>
      <td onclick="event.stopPropagation()">
        <div class="row-actions">
          <button class="act-btn act-console" ${failed || busy ? 'disabled' : ''} onclick="syncDrPlan('${escapeHtml(p.id)}')">Sync</button>
          <button class="act-btn act-primary" ${busy ? 'disabled' : ''} title="${escapeHtml(stageTitle)}" onclick="stageDrPlan('${escapeHtml(p.id)}')">${stageLabel}</button>
          <button class="act-btn act-start" ${failed || busy ? 'disabled' : ''} title="${escapeHtml(failTitle)}" onclick="failoverDrPlan('${escapeHtml(p.id)}')">Failover</button>
          <button class="act-btn act-danger" ${busy ? 'disabled' : ''} onclick="deleteDrPlan('${escapeHtml(p.id)}')">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openCreateDrPlanModal() {
  if (!session) {
    toast('Connect to the primary cluster first', 'err');
    return;
  }
  document.getElementById('newDrName').value = '';
  document.getElementById('newDrInterval').value = '60';
  document.getElementById('drNetworkSelect').innerHTML = '<option value="">Probe the DR cluster to list networks</option>';
  document.getElementById('drProbeStatus').textContent = '';
  _drProbe = null;
  fillDrTargetSelect();
  openModal('createDrPlanModal');
}

async function connectDrCluster() {
  const sel = document.getElementById('drTargetSelect');
  if (sel && sel.value !== 'manual') {
    sel.value = 'manual';
    syncDrManualFields();
  }
  const ctx = readManualDrContext();
  const status = document.getElementById('drProbeStatus');
  if (!ctx.vhiBaseUrl || !ctx.vhiUser || !ctx.vhiPassword) {
    toast('Enter the DR cluster address, user, and password', 'err');
    return;
  }
  const btn = document.getElementById('drConnectClusterBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
  if (status) status.textContent = 'Authenticating to the DR cluster…';
  try {
    const data = await apiPost('/api/vhi/auth', {
      baseUrl: ctx.vhiBaseUrl,
      username: ctx.vhiUser,
      password: ctx.vhiPassword,
      project: ctx.vhiProject,
      userDomain: ctx.vhiDomain,
      projectDomain: ctx.vhiProjectDomain,
    });
    if (!data.ok) throw new Error(data.error || 'Authentication failed');
    const saved = upsertSavedCluster({
      baseUrl: data.baseUrl || ctx.vhiBaseUrl,
      username: ctx.vhiUser,
      password: ctx.vhiPassword,
      project: data.project || ctx.vhiProject,
      userDomain: ctx.vhiDomain,
      projectDomain: ctx.vhiProjectDomain,
      projectId: data.projectId || '',
    });
    refreshClusterSwitcher();
    fillDrTargetSelect();
    const sel = document.getElementById('drTargetSelect');
    if (sel) sel.value = saved.id;
    syncDrManualFields();
    toast('DR cluster connected and saved to Clusters. This session stays on the primary.', 'ok');
    await probeDrTarget();
  } catch (err) {
    if (status) status.textContent = err.message;
    toast('Connect cluster failed: ' + err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Connect cluster'; }
  }
}

function applyDrProbeResult(result) {
  const status = document.getElementById('drProbeStatus');
  const netSel = document.getElementById('drNetworkSelect');
  _drProbe = result;
  const nets = result.networks || [];
  if (netSel) {
    netSel.innerHTML = '<option value="">Auto-pick a tenant network</option>' +
      nets.map((n) => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name || n.id)}</option>`).join('');
  }
  if (status) status.textContent = `Connected. ${result.servers || 0} VMs visible on DR.`;
  toast('DR cluster reachable', 'ok');
}

function isDrAuthError(err) {
  return /401|Unauthorized|rejected|requires authentication|password/i.test(String(err?.message || ''));
}

async function probeDrTarget() {
  const status = document.getElementById('drProbeStatus');
  const ctx = selectedDrContext();
  if (!ctx.vhiBaseUrl || !ctx.vhiUser || !ctx.vhiPassword) {
    const savedWrap = document.getElementById('drSavedPassWrap');
    if (savedWrap) savedWrap.classList.remove('hidden');
    toast('DR cluster URL, user, and password are required', 'err');
    if (status) status.textContent = 'Enter the DR cluster password, then Probe DR again.';
    return;
  }
  if (status) status.textContent = 'Probing…';
  try {
    applyDrProbeResult(await apiPost('/api/vhi/dr/probe', ctx));
    return;
  } catch (err) {
    const sessionPass = session?.password || '';
    if (isDrAuthError(err) && sessionPass && sessionPass !== ctx.vhiPassword) {
      try {
        const retried = await apiPost('/api/vhi/dr/probe', { ...ctx, vhiPassword: sessionPass, vhiProjectId: '' });
        upsertSavedCluster({
          baseUrl: ctx.vhiBaseUrl,
          username: ctx.vhiUser,
          password: sessionPass,
          project: ctx.vhiProject,
          userDomain: ctx.vhiDomain,
          projectDomain: ctx.vhiProjectDomain,
        });
        applyDrProbeResult(retried);
        if (status) status.textContent = (status.textContent || '') + ' Saved the working password for this DR cluster.';
        return;
      } catch (_) { /* fall through to the original error */ }
    }
    const savedWrap = document.getElementById('drSavedPassWrap');
    if (savedWrap && isDrAuthError(err)) savedWrap.classList.remove('hidden');
    if (status) status.textContent = err.message;
    toast('Probe failed: ' + err.message, 'err');
  }
}

async function submitCreateDrPlan() {
  const name = document.getElementById('newDrName')?.value.trim();
  const interval = Number(document.getElementById('newDrInterval')?.value) || 60;
  const drNetworkId = document.getElementById('drNetworkSelect')?.value || '';
  const dr = selectedDrContext();
  if (!dr.vhiBaseUrl || !dr.vhiUser || !dr.vhiPassword) {
    toast('DR cluster credentials are incomplete', 'err');
    return;
  }
  try {
    const data = await apiPost('/api/vhi/dr', {
      name: name || undefined,
      syncIntervalMinutes: interval,
      drNetworkId,
      dr,
    });
    closeModal('createDrPlanModal');
    toast('DR plan created. Add VMs next.', 'ok');
    if (data.plan) mergeDrPlan(data.plan);
    else await loadDrPlans();
    const plan = data.plan || _drPlans[0];
    if (plan) await openDrGuide(plan, 'protect');
  } catch (err) {
    toast('Create plan failed: ' + err.message, 'err');
  }
}

async function openDrPlan(id) {
  _drSelectedPlanId = id;
  await ensureDrVms();
  const cached = _drPlans.find((p) => p.id === id);
  if (cached && !(cached.protected || []).length && cached.status !== 'failed_over') {
    await openDrGuide(cached, 'protect');
    try {
      const data = await apiGet('/api/vhi/dr/' + encodeURIComponent(id));
      if (data.plan && _drProgressPlanId === id) {
        mergeDrPlan(data.plan);
        renderDrProgress(data.plan, 'protect');
      }
    } catch (err) {
      console.warn('DR plan refresh:', err.message);
    }
    return;
  }
  if (cached) renderDrDrawer(cached);
  document.getElementById('drDrawer')?.classList.add('open');
  try {
    const data = await apiGet('/api/vhi/dr/' + encodeURIComponent(id));
    const plan = data.plan;
    if (plan) {
      mergeDrPlan(plan);
      if (_drSelectedPlanId === id && (plan.protected || []).length) renderDrDrawer(plan);
    }
  } catch (err) {
    toast('Could not load plan: ' + err.message, 'err');
  }
}

function closeDrDrawer() {
  _drSelectedPlanId = null;
  document.getElementById('drDrawer')?.classList.remove('open');
}

function renderDrDrawer(plan) {
  const nameEl = document.getElementById('drDetName');
  const body = document.getElementById('drDetBody');
  if (nameEl) nameEl.textContent = plan.name || 'DR plan';
  if (!body) return;
  const failed = plan.status === 'failed_over';
  const busy = drBusyStatus(plan.status);
  const proc = planProcedure(plan);
  const stageLabel = (failed || proc.allStaged) ? 'Restage standbys' : 'Stage standbys';
  const vms = plan.protected || [];
  const available = (typeof _vms !== 'undefined' ? _vms : []).filter((vm) =>
    !vms.some((p) => p.sourceServerId === vm.id)
  );
  const protectOptions = available.length
    ? available.map((vm) =>
        `<label class="dr-check"><input type="checkbox" value="${escapeHtml(vm.id)}"> ${escapeHtml(vm.name || vm.id)} ${statusBadge(vm.status)}</label>`
      ).join('')
    : '<p class="text-dim">All loaded VMs are already in this plan, or the VM list is empty. Open Virtual Machines first.</p>';

  const vmRows = vms.length
    ? vms.map((vm) => {
      const vols = (vm.volumes || []).map((v) =>
        `${escapeHtml((v.sourceVolumeId || '').slice(0, 8))} → ${v.replicaVolumeId ? escapeHtml(v.replicaVolumeId.slice(0, 8)) : '—'}`
      ).join('<br>');
      return `<tr>
        <td><strong>${escapeHtml(vm.sourceServerName || vm.sourceServerId)}</strong><div class="text-dim" style="font-size:.75rem;">${escapeHtml(vm.sourceServerId)}</div></td>
        <td>${statusBadge(vm.status)}</td>
        <td style="font-size:.78rem;">${vols || '—'}</td>
        <td class="mono" style="font-size:.78rem;">${escapeHtml(vm.standbyServerId || 'not staged')}</td>
        <td>${vm.lastError ? `<span class="text-dim">${escapeHtml(vm.lastError)}</span>` : '—'}</td>
        <td>${failed ? '' : `<button class="txt-btn" onclick="unprotectDrVm('${escapeHtml(plan.id)}','${escapeHtml(vm.sourceServerId)}')">Remove</button>`}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="6"><div class="empty-state"><p>No protected VMs yet.</p></div></td></tr>';

  body.innerHTML = `
    <div class="drawer-actions">
      <button class="act-btn act-console" ${failed || busy ? 'disabled' : ''} onclick="syncDrPlan('${escapeHtml(plan.id)}')">Sync now</button>
      <button class="act-btn act-primary" ${busy ? 'disabled' : ''} onclick="stageDrPlan('${escapeHtml(plan.id)}')">${stageLabel}</button>
      <button class="act-btn act-start" ${failed || busy ? 'disabled' : ''} onclick="failoverDrPlan('${escapeHtml(plan.id)}')">Failover</button>
      <button class="act-btn" onclick="showDrProcedure('${escapeHtml(plan.id)}')">Procedure</button>
      <button class="act-btn act-danger" ${busy ? 'disabled' : ''} onclick="deleteDrPlan('${escapeHtml(plan.id)}')">Delete plan</button>
    </div>
    <div class="drawer-section">
      <h4>Pair</h4>
      <div class="detail-grid">
        <div class="detail-label">Status</div><div class="detail-val">${statusBadge(plan.status)}</div>
        <div class="detail-label">Primary</div><div class="detail-val mono">${escapeHtml(clusterShort(plan.primary))}</div>
        <div class="detail-label">DR site</div><div class="detail-val mono">${escapeHtml(clusterShort(plan.dr))}</div>
        <div class="detail-label">Interval</div><div class="detail-val">${escapeHtml(String(plan.syncIntervalMinutes || 60))} minutes</div>
        <div class="detail-label">Last sync</div><div class="detail-val">${escapeHtml(plan.lastSyncAt ? fmtDate(plan.lastSyncAt) : 'Never')}</div>
        <div class="detail-label">Failover</div><div class="detail-val">${escapeHtml(plan.lastFailoverAt ? fmtDate(plan.lastFailoverAt) : '—')}</div>
        <div class="detail-label">Error</div><div class="detail-val">${escapeHtml(plan.lastError || '—')}</div>
      </div>
    </div>
    <div class="drawer-section">
      <h4>Protected VMs</h4>
      <table>
        <thead><tr><th>Source</th><th>Status</th><th>Volumes</th><th>Standby</th><th>Error</th><th></th></tr></thead>
        <tbody>${vmRows}</tbody>
      </table>
    </div>
    ${failed ? '' : `
    <div class="drawer-section">
      <h4>Add VMs from this cluster</h4>
      <div class="dr-check-list" id="drProtectList">${protectOptions}</div>
      <button class="btn btn-primary" style="margin-top:.8rem;" onclick="protectSelectedVms('${escapeHtml(plan.id)}')">Protect selected</button>
    </div>`}
    <div class="drawer-section">
      <h4>Activity log</h4>
      ${renderDrLog(plan.log)}
    </div>
    <p class="text-dim" style="font-size:.8rem; margin-top:1rem;">Full volume copy on each sync. Stage SHUTOFF standbys on the DR cluster after the first successful sync, then Failover attaches the latest replica and starts the VMs.</p>
  `;
  const logEl = document.getElementById('drActivityLog');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

function renderDrLog(log, id) {
  const rows = Array.isArray(log) ? log : [];
  if (!rows.length) {
    return '<p class="text-dim">No steps recorded yet. Start a sync to see snapshot, Glance upload, download, and replica create progress here.</p>';
  }
  const lines = rows.map((entry) => {
    const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '';
    const level = escapeHtml(entry.level || 'info');
    return `<div class="dr-log-row dr-log-${level}"><span class="dr-log-time">${escapeHtml(ts)}</span>${escapeHtml(entry.message || '')}</div>`;
  }).join('');
  return `<div class="dr-log" id="${escapeHtml(id || 'drActivityLog')}">${lines}</div>`;
}

async function protectSelectedVms(planId, listSelector) {
  const boxes = [...document.querySelectorAll((listSelector || '#drProtectList') + ' input[type=checkbox]:checked')];
  const serverIds = boxes.map((b) => b.value).filter(Boolean);
  if (!serverIds.length) {
    toast('Select at least one VM', 'warn');
    return;
  }
  try {
    const data = await apiPost('/api/vhi/dr/' + encodeURIComponent(planId) + '/protect', { serverIds });
    toast('VMs added to the plan. Next step: Sync.', 'ok');
    mergeDrPlan(data.plan);
    if (_drProgressPlanId === planId && data.plan) renderDrProgress(data.plan, 'sync');
  } catch (err) {
    toast('Protect failed: ' + err.message, 'err');
  }
}

async function unprotectDrVm(planId, serverId) {
  if (!confirm('Remove this VM from the DR plan? Existing replicas on the DR cluster are left in place.')) return;
  try {
    const data = await apiPost('/api/vhi/dr/' + encodeURIComponent(planId) + '/unprotect', { serverId });
    toast('VM removed from plan', 'ok');
    mergeDrPlan(data.plan);
  } catch (err) {
    toast('Unprotect failed: ' + err.message, 'err');
  }
}

function mergeDrPlan(plan) {
  if (!plan) return;
  const idx = _drPlans.findIndex((p) => p.id === plan.id);
  if (idx >= 0) _drPlans[idx] = plan;
  else _drPlans.unshift(plan);
  renderDrPlans(document.getElementById('drSearch')?.value || '');
  updateDrBadge();
  if (_drSelectedPlanId === plan.id) renderDrDrawer(plan);
  if (_drProgressPlanId === plan.id) renderDrProgress(plan);
}

async function syncDrPlan(id) {
  const plan = _drPlans.find((p) => p.id === id);
  if (plan) openDrProgress(plan, 'sync');
  try {
    const data = await apiPost('/api/vhi/dr/' + encodeURIComponent(id) + '/sync', {});
    mergeDrPlan(data.plan);
    if (data.plan) renderDrProgress(data.plan, 'sync');
    startDrPoll();
  } catch (err) {
    toast('Sync failed: ' + err.message, 'err');
    if (plan) renderDrProgress(plan, 'sync', err.message);
  }
}

async function stageDrPlan(id) {
  const plan = _drPlans.find((p) => p.id === id);
  const proc = planProcedure(plan);
  if (plan && !proc.allSynced) {
    openDrProgress(plan, 'stage', 'Sync must finish before Stage. ' + proc.rows.filter((r) => !r.synced).map((r) => r.name).join(', ') + ' has no replica on DR yet.');
    return;
  }
  const recreate = !!(plan && proc.allStaged);
  if (recreate && !confirm('A standby already exists. Recreate it with the source firmware (UEFI/BIOS) so it can boot? The replica disk is kept. The current DR guest (including a stuck SeaBIOS console) will be deleted.')) {
    return;
  }
  if (plan) openDrProgress(plan, 'stage', recreate
    ? 'Recreating standbys with source firmware metadata.'
    : 'Creating SHUTOFF standbys on the DR cluster from the latest replica.');
  try {
    const data = await apiPost('/api/vhi/dr/' + encodeURIComponent(id) + '/stage', { recreate });
    mergeDrPlan(data.plan);
    if (data.plan) renderDrProgress(data.plan, 'stage');
    startDrPoll();
  } catch (err) {
    toast('Stage failed: ' + err.message, 'err');
    if (plan) renderDrProgress(plan, 'stage', err.message);
  }
}

async function failoverDrPlan(id) {
  const plan = _drPlans.find((p) => p.id === id);
  const proc = planProcedure(plan);
  if (plan && !proc.allStaged) {
    const detail = proc.rows.map((r) => {
      if (r.failedOver) return r.name + ': already failed over';
      if (!r.synced) return r.name + ': no replica yet - run Sync';
      if (!r.staged) return r.name + ': replica is on DR, but no standby VM - run Stage';
      return r.name + ': ready';
    }).join('. ');
    openDrProgress(plan, 'failover', 'Failover is blocked. ' + detail);
    return;
  }
  if (!confirm('Fail over "' + (plan?.name || 'this plan') + '" now?\n\nIf the primary cluster is still up, the source VM is shut down first to avoid two copies running.\nIf the primary is down, failover continues without that stop.\nThen the DR standby is started.')) {
    return;
  }
  if (plan) openDrProgress(plan, 'failover', 'If the primary cluster is still up, the source VM is shut down first. Then the DR standby is started.');
  try {
    const data = await apiPost('/api/vhi/dr/' + encodeURIComponent(id) + '/failover', {});
    mergeDrPlan(data.plan);
    if (data.plan) renderDrProgress(data.plan, 'failover');
    startDrPoll();
  } catch (err) {
    toast('Failover failed: ' + err.message, 'err');
    if (plan) renderDrProgress(plan, 'failover', err.message);
  }
}

async function deleteDrPlan(id) {
  const plan = _drPlans.find((p) => p.id === id);
  if (!confirm('Delete DR plan "' + (plan?.name || 'this plan') + '"?')) return;
  const cleanup = confirm('Clean up the DR cluster and start the source VM on the primary?\n\nOK: delete the DR VM, snapshots, and replica volumes, then start the primary VM.\nCancel: delete the plan only and leave DR resources in place.');
  if (cleanup) {
    _drCleanupPlanId = id;
    if (plan) openDrProgress(plan, 'cleanup', 'Deleting the DR VM, snapshots, and replica volumes, then starting the primary VM.');
    try {
      const data = await apiPost('/api/vhi/dr/' + encodeURIComponent(id) + '/delete', { cleanup: true });
      if (data.plan) mergeDrPlan(data.plan);
      startDrPoll();
    } catch (err) {
      _drCleanupPlanId = null;
      toast('Cleanup failed: ' + err.message, 'err');
      if (plan) renderDrProgress(plan, 'cleanup', err.message);
    }
    return;
  }
  try {
    await apiDelete('/api/vhi/dr/' + encodeURIComponent(id));
    _drPlans = _drPlans.filter((p) => p.id !== id);
    if (_drSelectedPlanId === id) closeDrDrawer();
    renderDrPlans(document.getElementById('drSearch')?.value || '');
    updateDrBadge();
    toast('DR plan deleted. DR resources were left in place.', 'ok');
  } catch (err) {
    toast('Delete failed: ' + err.message, 'err');
  }
}

document.getElementById('drTargetSelect')?.addEventListener('change', syncDrManualFields);
document.getElementById('drSearch')?.addEventListener('input', (e) => renderDrPlans(e.target.value));
document.getElementById('drRefresh')?.addEventListener('click', () => loadDrPlans());
document.getElementById('btnCreateDrPlan')?.addEventListener('click', openCreateDrPlanModal);

if (document.body.getAttribute('data-nav') === 'dr') {
  bootVhiSession(async () => {
    if (typeof refreshClusterSwitcher === 'function') refreshClusterSwitcher();
    await ensureDrVms();
    await loadDrPlans();
  });
}
