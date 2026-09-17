/**
 * VHI 7.x Block Storage API (Cinder-style) – volumes list, create, delete, attach, detach
 */

import { getClient } from './client.js';
import { getContextValue } from '../gateway/context.js';

const getBaseUrl = () => {
  const base = getContextValue('vhiBaseUrl', 'VHI_BASE_URL');
  if (!base) {
    throw new Error('VHI Base URL is not configured. Please provide vhiBaseUrl in context or set VHI_BASE_URL.');
  }
  return base.replace(/\/$/, '');
};

async function blockUrl(path = '', resourceType = 'volumes') {
  const base = getBaseUrl();
  const port = process.env.VHI_BLOCK_PORT || 8776;
  const client = await getClient();
  const projectId = client.projectId;
  
  if (path.startsWith('/types')) {
    if (projectId) return `${base}:${port}/v3/${projectId}${path}`;
    return `${base}:${port}/v3${path}`;
  }

  const prefix = projectId ? `/v3/${projectId}/${resourceType}` : `/v3/${resourceType}`;
  return `${base}:${port}${prefix}${path}`;
}

async function listBlockCollection(resourceType, extraParams = {}) {
  const client = await getClient();
  const collected = [];
  const seen = new Set();
  const pageSize = 200;
  let marker = null;

  for (let page = 0; page < 40; page++) {
    const params = new URLSearchParams();
    params.set('limit', String(pageSize));
    for (const [k, v] of Object.entries(extraParams)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    if (marker) params.set('marker', marker);

    const url = await blockUrl(`/detail?${params.toString()}`, resourceType);
    const res = await client.fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`VHI Block list ${resourceType} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const items = data[resourceType] || [];
    for (const item of items) {
      if (item?.id && !seen.has(item.id)) {
        seen.add(item.id);
        collected.push(item);
      }
    }
    if (items.length < pageSize) break;
    marker = items[items.length - 1].id;
    if (!marker) break;
  }
  return collected;
}

export async function listVolumes() {
  return listBlockCollection('volumes');
}

export async function listVolumeTypes() {
  const client = await getClient();
  const urlWithProject = await blockUrl('/types');
  const urlWithoutProject = urlWithProject.replace(/\/v3\/[^/]+\/types/, '/v3/types');
  const urls = [urlWithoutProject, urlWithProject];

  for (const url of urls) {
    try {
      const res = await client.fetch(url);
      if (res.ok) {
        const data = await res.json();
        return data.volume_types || [];
      }
    } catch (_) {}
  }
  throw new Error('VHI Block listVolumeTypes failed to retrieve types from any endpoint');
}

export async function getVolume(volumeId) {
  const client = await getClient();
  const urlWithProject = await blockUrl(`/${volumeId}`);
  const urlWithoutProject = urlWithProject.replace(/\/v3\/[^/]+\/volumes/, '/v3/volumes');
  const urls = [urlWithoutProject, urlWithProject];

  for (const url of urls) {
    try {
      const res = await client.fetch(url);
      if (res.ok) {
        const data = await res.json();
        return data.volume || null;
      }
      if (res.status === 404 && url === urls[urls.length - 1]) return null;
    } catch (_) {}
  }
  return null;
}

export async function createVolume(options = {}) {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: options }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block createVolume failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.volume || null;
}

export async function extendVolume(volumeId, newSize) {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(`/${volumeId}/action`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'os-extend': { new_size: newSize } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block extendVolume failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function retypeVolume(volumeId, newType, migrationPolicy = 'never') {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(`/${volumeId}/action`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      'os-retype': {
        new_type: newType,
        migration_policy: migrationPolicy
      }
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block retypeVolume failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function revertSnapshot(volumeId, snapshotId) {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(`/${volumeId}/action`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'os-revert': { snapshot_id: snapshotId } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block revertSnapshot failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function uploadVolumeToImage(volumeId, options = {}) {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(`/${volumeId}/action`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'os-volume_upload_image': {
      image_name: options.image_name,
      disk_format: options.disk_format || 'qcow2',
      container_format: options.container_format || 'bare'
    } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block uploadVolumeToImage failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.os_volume_upload_image || null;
}

export async function updateVolume(volumeId, options = {}) {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(`/${volumeId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: options }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block updateVolume failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.volume || null;
}

export async function setVolumeBootable(volumeId, bootable = true) {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(`/${volumeId}/action`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'os-set_bootable': { bootable: !!bootable } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block setVolumeBootable failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function setVolumeImageMetadata(volumeId, metadata) {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(`/${volumeId}/action`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 'os-set_image_metadata': { metadata } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block setVolumeImageMetadata failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function deleteVolume(volumeId) {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(`/${volumeId}`), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Block deleteVolume failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

async function computeUrl(path = '') {
  const base = getBaseUrl();
  const port = process.env.VHI_COMPUTE_PORT || 8774;
  const client = await getClient();
  const projectId = client.projectId;
  if (projectId) {
    return `${base}:${port}/v2.1/${projectId}${path}`;
  }
  return `${base}:${port}/v2.1${path}`;
}

export async function attachVolume(serverId, volumeId, device) {
  const client = await getClient();
  const body = { volumeAttachment: { volumeId } };
  if (device) body.volumeAttachment.device = device;

  const res = await client.fetch(await computeUrl(`/servers/${serverId}/os-volume_attachments`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Volume attach failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.volumeAttachment || null;
}

export async function forceDetachVolume(volumeId, attachmentId) {
  const client = await getClient();
  const payload = attachmentId
    ? { 'os-force_detach': { attachment_id: attachmentId } }
    : { 'os-force_detach': {} };
  const res = await client.fetch(await blockUrl(`/${volumeId}/action`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 202 && res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(`VHI Block forceDetach failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function detachVolume(serverId, attachmentId) {
  const client = await getClient();
  const res = await client.fetch(await computeUrl(`/servers/${serverId}/os-volume_attachments/${attachmentId}`), {
    method: 'DELETE'
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Volume detach failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

// ── Snapshots ─────────────────────────────────────────────────────────────

export async function listSnapshots() {
  return listBlockCollection('snapshots');
}

export async function getSnapshot(snapshotId) {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(`/${snapshotId}`, 'snapshots'));
  if (!res.ok) {
    if (res.status === 404) return null;
    const text = await res.text();
    throw new Error(`VHI Block getSnapshot failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.snapshot || null;
}

export async function createSnapshot(name, volumeId, description = '') {
  const client = await getClient();
  const res = await client.fetch(await blockUrl('', 'snapshots'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snapshot: {
        name,
        volume_id: volumeId,
        description,
        force: true // snapshot even if in-use
      }
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block createSnapshot failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.snapshot || null;
}

export async function deleteSnapshot(snapshotId) {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(`/${snapshotId}`, 'snapshots'), {
    method: 'DELETE'
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Block deleteSnapshot failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}
