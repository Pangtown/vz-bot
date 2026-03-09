/**
 * VHI 7.x Block Storage API (Cinder-style) – volumes list, create, delete, attach, detach
 */

import { getClient } from './client.js';

const getBaseUrl = () => {
  const base = process.env.VHI_BASE_URL || 'https://172.16.218.7';
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
