/**
 * VHI 7.x Block Storage API (Cinder-style) – volumes list, create, delete, attach, detach
 */

import { getClient } from './client.js';
import { getContextValue } from '../gateway/context.js';

const getBaseUrl = () => {
  const base = getContextValue('vhiBaseUrl', 'VHI_BASE_URL') || 'https://172.16.218.7';
  return base.replace(/\/$/, '');
};

function blockUrl(path = '') {
  const base = getBaseUrl();
  const port = process.env.VHI_BLOCK_PORT || 8776;
  return `${base}:${port}/v3/volumes${path}`;
}

export async function listVolumes() {
  const client = await getClient();
  const res = await client.fetch(blockUrl('/detail'));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Block listVolumes failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.volumes || [];
}

export async function getVolume(volumeId) {
  const client = await getClient();
  const res = await client.fetch(blockUrl(`/${volumeId}`));
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
  const res = await client.fetch(blockUrl(''), {
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

export async function deleteVolume(volumeId) {
  const client = await getClient();
  const res = await client.fetch(blockUrl(`/${volumeId}`), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Block deleteVolume failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

function computeUrl(path = '') {
  const base = getBaseUrl();
  const port = process.env.VHI_COMPUTE_PORT || 8774;
  return `${base}:${port}/v2.1${path}`;
}

export async function attachVolume(serverId, volumeId, device) {
  const client = await getClient();
  const body = { volumeAttachment: { volumeId } };
  if (device) body.volumeAttachment.device = device;

  const res = await client.fetch(computeUrl(`/servers/${serverId}/os-volume_attachments`), {
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
  const res = await client.fetch(computeUrl(`/servers/${serverId}/os-volume_attachments/${attachmentId}`), {
    method: 'DELETE'
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Volume detach failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}
