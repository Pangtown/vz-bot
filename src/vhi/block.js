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

export async function listVolumes() {
  const client = await getClient();
  // Try multiple URL patterns for administrative visibility
  const urlWithProject = await blockUrl('/detail?all_tenants=1');
  const urlWithoutProject = urlWithProject.replace(/\/v3\/[^/]+\/volumes/, '/v3/volumes');
  
  const urls = [urlWithoutProject, urlWithProject];
  let lastError = null;

  for (const url of urls) {
    try {
      const res = await client.fetch(url);
      if (res.ok) {
        const data = await res.json();
        // If we got results, great. If not, maybe try the next one.
        if (data.volumes && data.volumes.length > 0) return data.volumes;
        if (url === urls[urls.length - 1]) return data.volumes || [];
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('VHI Block listVolumes failed to retrieve any volumes');
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
  const client = await getClient();
  const url = await blockUrl('/detail', 'snapshots');
  const res = await client.fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block listSnapshots failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.snapshots || [];
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
