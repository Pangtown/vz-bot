/**
 * VHI 7.x Block Storage API (Cinder-style) – volumes list, create, delete, attach, detach
 */

import { getClient } from './client.js';
import { getContextValue } from '../gateway/context.js';

const getBaseUrl = () => {
  const base = getContextValue('vhiBaseUrl', 'VHI_BASE_URL') || 'https://172.16.218.7';
  return base.replace(/\/$/, '');
};

async function blockUrl(path = '') {
  const base = getBaseUrl();
  const port = process.env.VHI_BLOCK_PORT || 8776;
  const client = await getClient();
  const projectId = client.projectId;
  if (projectId) {
    return `${base}:${port}/v3/${projectId}/volumes${path}`;
  }
  return `${base}:${port}/v3/volumes${path}`;
}

export async function listVolumes() {
  const client = await getClient();
  const res = await client.fetch(await blockUrl('/detail'));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block listVolumes failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.volumes || [];
}

export async function listVolumeTypes() {
  const client = await getClient();
  const res = await client.fetch(await blockUrl('/types'));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block listVolumeTypes failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.volume_types || [];
}

export async function getVolume(volumeId) {
  const client = await getClient();
  const res = await client.fetch(await blockUrl(`/${volumeId}`));
  if (!res.ok) {
    if (res.status === 404) return null;
    const text = await res.text();
    throw new Error(`VHI Block getVolume failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.volume || null;
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
