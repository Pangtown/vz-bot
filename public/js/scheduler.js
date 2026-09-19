'use strict';

let _jobs = [];
let _vms = [];
let _vols = [];

function jobScheduleLabel(j) {
  const s = j.schedule || {};
  if (s.kind === 'cron') return s.expr || 'cron';
  if (s.kind === 'interval') return 'every ' + (s.minutes || 60) + 'm';
  if (s.kind === 'once') return s.at ? new Date(s.at).toLocaleString() : 'once';
  return '–';
}

async function loadSchedulerCatalog() {
  const [vms, vols] = await Promise.all([
    apiGet('/api/vhi/servers').catch(() => ({ servers: [] })),
    apiGet('/api/vhi/volumes').catch(() => ({ volumes: [] })),
  ]);
  _vms = vms.servers || [];
  _vols = vols.volumes || [];
}

async function loadJobs() {
  const tbody = document.getElementById('jobBody');
  if (tbody) tbody.innerHTML = skeletonRows(7);
  try {
    const data = await apiGet('/api/vhi/jobs');
    _jobs = data.jobs || [];
    renderJobs(document.getElementById('jobSearch')?.value || '');
  } catch (err) {
    if (tbody) tbody.innerHTML = emptyState('⚠️', 'Could not load jobs: ' + err.message);
  }
}

function renderJobs(query) {
  const tbody = document.getElementById('jobBody');
  if (!tbody) return;
  const rows = (_jobs || []).map((j) => `<tr>
    <td><strong>${escapeHtml(j.name)}</strong></td>
    <td>${escapeHtml((j.action || '').replace(/_/g, ' '))}</td>
    <td class="text-dim">${escapeHtml(j.targetName || j.targetId || '–')}</td>
    <td class="mono">${escapeHtml(jobScheduleLabel(j))}</td>
    <td class="text-dim">${j.lastRunAt ? escapeHtml(new Date(j.lastRunAt).toLocaleString()) : '–'}${j.lastStatus ? ' · ' + escapeHtml(j.lastStatus) : ''}${j.lastError ? '<br><span class="text-dim">' + escapeHtml(j.lastError) + '</span>' : ''}</td>
    <td>${j.enabled === false ? '<span class="badge badge-error">Off</span>' : '<span class="badge badge-active">On</span>'}</td>
    <td style="text-align:right;">
      <button class="act-btn" onclick="runJobNow('${j.id}')">Run</button>
      <button class="act-btn" onclick="toggleJob('${j.id}', ${j.enabled === false})">${j.enabled === false ? 'Enable' : 'Disable'}</button>
      <button class="act-btn act-danger" onclick="deleteJobRow('${j.id}')">Delete</button>
    </td>
  </tr>`);
  const filtered = filterRows(rows, query);
  tbody.innerHTML = filtered.length ? filtered.join('') : emptyState('⏱', 'No scheduled jobs');
  const c = document.getElementById('jobCount');
  if (c) c.textContent = `${_jobs.length} jobs`;
}

function syncJobScheduleFields() {
  const kind = document.getElementById('newJobKind').value;
  document.getElementById('jobCronWrap').classList.toggle('hidden', kind !== 'cron');
  document.getElementById('jobIntervalWrap').classList.toggle('hidden', kind !== 'interval');
  document.getElementById('jobOnceWrap').classList.toggle('hidden', kind !== 'once');
  if (kind === 'once') {
    const dateEl = document.getElementById('newJobDate');
    const timeEl = document.getElementById('newJobTime');
    if (!dateEl.value || !timeEl.value) setJobOncePreset('15m');
    else updateJobOncePreview();
  }
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fillJobOnceFromDate(d) {
  document.getElementById('newJobDate').value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  document.getElementById('newJobTime').value = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const dateInput = document.getElementById('newJobDate');
  const today = new Date();
  dateInput.min = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  updateJobOncePreview();
}

function getJobOnceDate() {
  const date = document.getElementById('newJobDate')?.value;
  const time = document.getElementById('newJobTime')?.value;
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function updateJobOncePreview() {
  const el = document.getElementById('jobOncePreview');
  if (!el) return;
  const d = getJobOnceDate();
  if (!d) {
    el.textContent = 'Pick a date and time, or use a shortcut.';
    return;
  }
  const local = d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  el.textContent = d.getTime() < Date.now()
    ? `That time is in the past (${local}). Choose a future time.`
    : `Runs at ${local} (local time).`;
}

function setJobOncePreset(kind) {
  const d = new Date();
  d.setSeconds(0, 0);
  if (kind === '15m') d.setMinutes(d.getMinutes() + 15);
  else if (kind === '1h') d.setHours(d.getHours() + 1);
  else if (kind === 'tomorrow9') {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  } else if (kind === '2am') {
    d.setHours(2, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  }
  fillJobOnceFromDate(d);
}

function fillJobTargets() {
  const action = document.getElementById('newJobAction').value;
  const sel = document.getElementById('newJobTarget');
  if (action === 'snapshot_volume') {
    sel.innerHTML = (_vols || []).map((v) =>
      `<option value="${v.id}">${escapeHtml(v.name || v.id)}</option>`
    ).join('') || '<option value="">No volumes</option>';
  } else {
    sel.innerHTML = (_vms || []).map((v) =>
      `<option value="${v.id}">${escapeHtml(v.name || v.id)}</option>`
    ).join('') || '<option value="">No VMs</option>';
  }
}

function openCreateJobModal() {
  document.getElementById('newJobName').value = '';
  document.getElementById('newJobKind').value = 'cron';
  document.getElementById('newJobCron').value = '0 2 * * *';
  syncJobScheduleFields();
  fillJobTargets();
  openModal('createJobModal');
}

async function submitCreateJob() {
  const name = document.getElementById('newJobName').value.trim();
  const action = document.getElementById('newJobAction').value;
  const targetId = document.getElementById('newJobTarget').value;
  if (!name || !targetId) return toast('Name and target are required', 'warn');
  const targetSel = document.getElementById('newJobTarget');
  const targetName = targetSel.options[targetSel.selectedIndex]?.text || targetId;
  const kind = document.getElementById('newJobKind').value;
  const schedule = { kind };
  if (kind === 'cron') schedule.expr = document.getElementById('newJobCron').value.trim();
  if (kind === 'interval') schedule.minutes = Number(document.getElementById('newJobMinutes').value) || 60;
  if (kind === 'once') {
    const d = getJobOnceDate();
    if (!d) return toast('Pick a date and time', 'warn');
    if (d.getTime() < Date.now() - 30000) return toast('Choose a future date and time', 'warn');
    schedule.at = d.toISOString();
  }
  try {
    await apiPost('/api/vhi/jobs', { name, action, targetId, targetName, schedule });
    closeModal('createJobModal');
    toast('Job scheduled', 'ok');
    loadJobs();
  } catch (err) {
    toast('Create failed: ' + err.message, 'err');
  }
}

async function runJobNow(id) {
  try {
    await apiPost('/api/vhi/jobs/' + id + '/run', {});
    toast('Job started', 'ok');
    loadJobs();
  } catch (err) {
    toast('Run failed: ' + err.message, 'err');
  }
}

async function toggleJob(id, enable) {
  try {
    await apiPatch('/api/vhi/jobs/' + id, { enabled: !!enable });
    loadJobs();
  } catch (err) {
    toast('Update failed: ' + err.message, 'err');
  }
}

async function deleteJobRow(id) {
  if (!confirm('Delete this scheduled job?')) return;
  try {
    await apiDelete('/api/vhi/jobs/' + id);
    toast('Job deleted', 'ok');
    loadJobs();
  } catch (err) {
    toast('Delete failed: ' + err.message, 'err');
  }
}

document.getElementById('newJobAction')?.addEventListener('change', fillJobTargets);
document.getElementById('jobSearch')?.addEventListener('input', (e) => renderJobs(e.target.value));

window.openCreateJobModal = openCreateJobModal;
window.submitCreateJob = submitCreateJob;
window.syncJobScheduleFields = syncJobScheduleFields;
window.updateJobOncePreview = updateJobOncePreview;
window.setJobOncePreset = setJobOncePreset;
window.runJobNow = runJobNow;
window.toggleJob = toggleJob;
window.deleteJobRow = deleteJobRow;
window.loadJobs = loadJobs;

if (document.body.getAttribute('data-nav') === 'scheduler') {
  bootVhiSession(async () => {
    if (typeof refreshClusterSwitcher === 'function') refreshClusterSwitcher();
    await loadSchedulerCatalog();
    await loadJobs();
  });
}
