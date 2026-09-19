'use strict';

let _vmModalDomains = [];
let _vmModalProjects = [];
let _vmCreateCatalog = { images: [], flavors: [], networks: [], volumeTypes: [], volumes: [], keypairs: [] };
let _vmHasProjectRole = true;

function vmCreateTarget() {
  const projSel = document.getElementById('newVmProject');
  const opt = projSel?.selectedOptions?.[0];
  if (!opt || !opt.value) return null;
  return {
    project: opt.dataset.name || opt.textContent.trim(),
    projectId: opt.value,
    projectDomain: opt.dataset.domainName || session?.projectDomain || session?.userDomain || 'Default',
    userDomain: session?.userDomain || 'Default',
  };
}

function formatQuotaSlot(slot, unit) {
  if (!slot) return '';
  const used = slot.in_use;
  const limit = slot.limit;
  const unitLabel = unit ? ` ${unit}` : '';
  if (limit == null || Number(limit) < 0) {
    return used == null ? '' : `${used}${unitLabel} used`;
  }
  const usedLabel = used == null ? '–' : used;
  return `${usedLabel} / ${limit}${unitLabel}`;
}

function renderVmQuota(quota) {
  const el = document.getElementById('vmCreateQuota');
  if (!el) return;
  if (!quota) {
    el.textContent = 'Could not read project quota. Flavors, networks, and volumes below are still from this tenant.';
    return;
  }
  const parts = [];
  const inst = formatQuotaSlot(quota.compute?.instances, 'VMs');
  const cores = formatQuotaSlot(quota.compute?.cores, 'vCPU');
  let ram = '';
  if (quota.compute?.ram) {
    const slot = quota.compute.ram;
    const usedGi = slot.in_use == null ? null : Math.round(Number(slot.in_use) / 1024);
    const limitGi = slot.limit == null || Number(slot.limit) < 0 ? null : Math.round(Number(slot.limit) / 1024);
    if (limitGi != null) ram = `${usedGi == null ? '–' : usedGi} / ${limitGi} GiB RAM`;
  }
  const vols = formatQuotaSlot(quota.volume?.volumes, 'volumes');
  const gigs = formatQuotaSlot(quota.volume?.gigabytes, 'GiB storage');
  if (inst) parts.push(inst);
  if (cores) parts.push(cores);
  if (ram) parts.push(ram);
  if (vols) parts.push(vols);
  if (gigs) parts.push(gigs);
  el.textContent = parts.length ? ('Quota: ' + parts.join(' · ')) : 'Project quota is unlimited or not published.';
}

function fillVmSelect(sel, placeholder, rows) {
  if (!sel) return;
  sel.innerHTML = `<option value="">${placeholder}</option>` + (rows || []).join('');
}

function syncVmDiskSourceFields() {
  const source = document.getElementById('newVmDiskSource')?.value || 'image';
  const image = source === 'image';
  document.getElementById('vmImageGroup')?.classList.toggle('hidden', !image);
  document.getElementById('vmPolicyGroup')?.classList.toggle('hidden', !image);
  document.getElementById('vmDiskSizeGroup')?.classList.toggle('hidden', !image);
  document.getElementById('vmVolumeGroup')?.classList.toggle('hidden', image);
}

function applyVmCreateCatalog(cat) {
  _vmCreateCatalog = cat || _vmCreateCatalog;
  const images = _vmCreateCatalog.images || [];
  const flavors = (_vmCreateCatalog.flavors || []).slice().sort((a, b) => (a.vcpus - b.vcpus) || (a.ram - b.ram));
  const nets = (_vmCreateCatalog.networks || []).filter((n) => !(n.name || '').toLowerCase().startsWith('ha network'));
  const types = _vmCreateCatalog.volumeTypes || [];
  const vols = (_vmCreateCatalog.volumes || []).filter((v) => {
    const st = String(v.status || '').toLowerCase();
    return st === 'available';
  });
  const keys = _vmCreateCatalog.keypairs || [];

  fillVmSelect(document.getElementById('newVmImage'), 'Select Image...', images.map((i) =>
    `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name || i.id)} (${fmtBytes(i.size)})</option>`
  ));
  fillVmSelect(document.getElementById('newVmFlavor'), 'Select Flavor...', flavors.map((f) =>
    `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)} (${f.vcpus} vCPU, ${fmtBytes(f.ram * 1024 * 1024)} RAM)</option>`
  ));
  fillVmSelect(document.getElementById('newVmPolicy'), 'Select Storage Policy...', types.map((vt) =>
    `<option value="${escapeHtml(vt.name)}">${escapeHtml(vt.name)}</option>`
  ));
  fillVmSelect(document.getElementById('newVmNetwork'), 'Select Network...', nets.map((n) =>
    `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name || n.id)}</option>`
  ));
  fillVmSelect(document.getElementById('newVmVolume'), vols.length ? 'Select boot volume...' : 'No available volumes in this project', vols.map((v) => {
    const boot = String(v.bootable) === 'true' ? ' · bootable' : '';
    return `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name || v.id)} (${v.size} GiB${boot})</option>`;
  }));
  const kpSel = document.getElementById('newVmKeypair');
  if (kpSel) {
    kpSel.innerHTML = '<option value="">None</option>' + keys.map((k) => {
      const name = k.name || k.keypair?.name || '';
      return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
    }).join('');
  }
  syncVmDiskSourceFields();
}

function fillVmDomainSelect() {
  const sel = document.getElementById('newVmDomain');
  if (!sel) return;
  const current = session?.projectDomain || session?.userDomain || 'Default';
  const rows = _vmModalDomains.map((d) =>
    `<option value="${escapeHtml(d.id)}" data-name="${escapeHtml(d.name || '')}" ${String(d.name).toLowerCase() === String(current).toLowerCase() ? 'selected' : ''}>${escapeHtml(d.name || d.id)}</option>`
  );
  sel.innerHTML = rows.join('') || `<option value="">${escapeHtml(current)}</option>`;
  if (![...sel.options].some((o) => o.selected) && sel.options.length) sel.selectedIndex = 0;
}

function fillVmProjectSelect() {
  const domainSel = document.getElementById('newVmDomain');
  const projSel = document.getElementById('newVmProject');
  if (!projSel) return;
  const domainId = domainSel?.value || '';
  const domainName = domainSel?.selectedOptions?.[0]?.dataset?.name || '';
  let rows = _vmModalProjects.filter((p) => p.enabled !== false && !['service', 'services'].includes(String(p.name || '').toLowerCase()));
  if (domainId) rows = rows.filter((p) => !p.domain_id || p.domain_id === domainId);
  const currentId = session?.projectId || '';
  const currentName = session?.project || '';
  projSel.innerHTML = rows.map((p) => {
    const selected = (currentId && p.id === currentId) || (!currentId && p.name === currentName) ? 'selected' : '';
    return `<option value="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name || '')}" data-domain-name="${escapeHtml(domainName)}" ${selected}>${escapeHtml(p.name || p.id)}</option>`;
  }).join('') || `<option value="${escapeHtml(currentId)}" data-name="${escapeHtml(currentName)}" data-domain-name="${escapeHtml(domainName)}">${escapeHtml(currentName || 'Current project')}</option>`;
}

async function loadVmCreateIdentity() {
  try {
    const [domData, projData] = await Promise.all([
      apiGet('/api/vhi/domains'),
      apiGet('/api/vhi/projects'),
    ]);
    const hidden = (d) => typeof isHiddenServiceDomain === 'function' && isHiddenServiceDomain(d);
    _vmModalDomains = (domData.domains || []).filter((d) => !hidden(d) && d.enabled !== false);
    _vmModalProjects = projData.projects || [];
  } catch (err) {
    _vmModalDomains = [{ id: 'current', name: session?.projectDomain || session?.userDomain || 'Default' }];
    _vmModalProjects = [{
      id: session?.projectId || session?.project || 'admin',
      name: session?.project || 'admin',
      domain_id: _vmModalDomains[0]?.id,
      enabled: true,
    }];
    toast('Could not list domains/projects: ' + err.message, 'warn');
  }
  fillVmDomainSelect();
  fillVmProjectSelect();
}

function setVmGrantVisible(show) {
  const wrap = document.getElementById('vmGrantAccessWrap');
  if (wrap) wrap.classList.toggle('hidden', !show);
}

async function loadVmCreateCatalog() {
  const target = vmCreateTarget();
  const quotaEl = document.getElementById('vmCreateQuota');
  setVmGrantVisible(false);
  if (!target?.projectId && !target?.project) {
    if (quotaEl) quotaEl.textContent = 'Select a project to load flavors, networks, and volumes.';
    return;
  }
  if (quotaEl) quotaEl.textContent = 'Loading flavors, networks, volumes, and quota for ' + (target.project || 'this project') + '…';
  fillVmSelect(document.getElementById('newVmFlavor'), 'Loading…', []);
  fillVmSelect(document.getElementById('newVmNetwork'), 'Loading…', []);
  fillVmSelect(document.getElementById('newVmImage'), 'Loading…', []);
  fillVmSelect(document.getElementById('newVmPolicy'), 'Loading…', []);
  fillVmSelect(document.getElementById('newVmVolume'), 'Loading…', []);
  try {
    const data = await apiGet('/api/vhi/create-vm-catalog?project_id=' + encodeURIComponent(target.projectId));
    _vmHasProjectRole = !!data.has_project_role;
    applyVmCreateCatalog({
      flavors: data.flavors || [],
      networks: data.networks || [],
      images: data.images || [],
      volumeTypes: data.volume_types || [],
      volumes: data.volumes || [],
      keypairs: data.keypairs || [],
    });
    renderVmQuota(data.quotas || null);
    if (!_vmHasProjectRole) setVmGrantVisible(true);
    if (_vmHasProjectRole) {
      const keys = await apiGetAs('/api/vhi/keypairs', target).catch(() => ({ keypairs: [] }));
      const kpSel = document.getElementById('newVmKeypair');
      if (kpSel) {
        kpSel.innerHTML = '<option value="">None</option>' + (keys.keypairs || []).map((k) => {
          const name = k.name || k.keypair?.name || '';
          return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
        }).join('');
      }
    }
  } catch (err) {
    if (quotaEl) quotaEl.textContent = err.message;
    toast('Could not load project resources: ' + err.message, 'err');
  }
}

async function grantVmProjectAccess() {
  const target = vmCreateTarget();
  if (!target?.projectId) return toast('Select a project first', 'warn');
  if (!confirm('Grant this admin user a role on "' + target.project + '" so Keystone will issue a token for that tenant?\n\nThis is required to create a VM in the project. The role is assigned on this project only.')) return;
  const btn = document.getElementById('vmGrantAccessBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Granting…'; }
  try {
    const data = await apiPost('/api/vhi/project-access', { project_id: target.projectId });
    toast(data.granted === false
      ? 'This user already has a role on ' + target.project
      : 'Granted ' + (data.role || 'a role') + ' on ' + target.project, 'ok');
    await loadVmCreateCatalog();
  } catch (err) {
    toast('Grant access failed: ' + err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Grant access'; }
  }
}

async function openVmModal() {
  document.getElementById('newVmName').value = '';
  document.getElementById('newVmDiskSize').value = 60;
  document.getElementById('newVmDiskSource').value = 'image';
  syncVmDiskSourceFields();
  document.getElementById('createVmModal').classList.remove('hidden');
  document.getElementById('newVmName').focus();
  await loadVmCreateIdentity();
  await loadVmCreateCatalog();
}

function closeVmModal() {
  document.getElementById('createVmModal')?.classList.add('hidden');
}

async function submitVmForm() {
  const name = document.getElementById('newVmName')?.value.trim();
  const flavorRef = document.getElementById('newVmFlavor')?.value;
  const networkUuid = document.getElementById('newVmNetwork')?.value;
  const source = document.getElementById('newVmDiskSource')?.value || 'image';
  const imageRef = document.getElementById('newVmImage')?.value;
  const volumeId = document.getElementById('newVmVolume')?.value;
  const volumeType = document.getElementById('newVmPolicy')?.value;
  const diskSize = parseInt(document.getElementById('newVmDiskSize')?.value, 10);
  const target = vmCreateTarget();
  const submitBtn = document.getElementById('submitVmBtn');

  if (!target?.project) return toast('Select a domain and project', 'warn');
  if (!_vmHasProjectRole) {
    const ok = confirm('This admin user has no role on "' + target.project + '". Grant a project role now so the VM can be created there?');
    if (!ok) return;
    try {
      await apiPost('/api/vhi/project-access', { project_id: target.projectId });
      _vmHasProjectRole = true;
    } catch (err) {
      return toast('Grant access failed: ' + err.message, 'err');
    }
  }
  if (!name || !flavorRef || !networkUuid) return toast('Name, flavor, and network are required', 'warn');
  if (source === 'image' && (!imageRef || !volumeType || !diskSize)) {
    return toast('Image, storage policy, and disk size are required', 'warn');
  }
  if (source === 'volume' && !volumeId) return toast('Select an available volume in this project', 'warn');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating...';
  try {
    const payload = {
      name,
      flavorRef,
      networks: [{ uuid: networkUuid }],
      min_count: 1,
      max_count: 1,
    };
    if (source === 'volume') {
      payload.block_device_mapping_v2 = [{
        boot_index: 0,
        uuid: volumeId,
        source_type: 'volume',
        destination_type: 'volume',
        delete_on_termination: false,
      }];
    } else {
      payload.imageRef = imageRef;
      payload.volume_size = diskSize;
      payload.volume_type = volumeType;
      payload.block_device_mapping_v2 = [{
        boot_index: 0,
        uuid: imageRef,
        source_type: 'image',
        destination_type: 'volume',
        volume_size: diskSize,
        volume_type: volumeType,
        delete_on_termination: true,
      }];
    }
    const keyName = document.getElementById('newVmKeypair')?.value;
    if (keyName) payload.key_name = keyName;

    await apiPostAs('/api/vhi/servers', payload, target);
    toast('VM "' + name + '" is being created in ' + target.project, 'ok');
    closeVmModal();
    if (typeof loadVMs === 'function') loadVMs();
  } catch (err) {
    toast('Creation failed: ' + err.message, 'err');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create';
  }
}

document.getElementById('btnCreateVm')?.addEventListener('click', openVmModal);
document.getElementById('closeVmModal')?.addEventListener('click', closeVmModal);
document.getElementById('cancelVmBtn')?.addEventListener('click', closeVmModal);
document.getElementById('submitVmBtn')?.addEventListener('click', submitVmForm);
document.getElementById('newVmDomain')?.addEventListener('change', async () => {
  fillVmProjectSelect();
  await loadVmCreateCatalog();
});
document.getElementById('newVmProject')?.addEventListener('change', () => loadVmCreateCatalog());
document.getElementById('newVmDiskSource')?.addEventListener('change', syncVmDiskSourceFields);
document.getElementById('vmGrantAccessBtn')?.addEventListener('click', grantVmProjectAccess);