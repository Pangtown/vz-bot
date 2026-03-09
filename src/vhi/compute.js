/**
 * VHI 7.x Compute API (Nova-style) – servers list, get, start, stop, reboot, delete
 */

import { getClient } from './client.js';

const getBaseUrl = () => {
  const base = process.env.VHI_BASE_URL || 'https://172.16.218.7';
  return base.replace(/\/$/, '');
};

function computeUrl(path = '') {
  const base = getBaseUrl();
  const port = process.env.VHI_COMPUTE_PORT || 8774;
  return `${base}:${port}/v2.1${path}`;
}

export async function listServers(options = {}) {
  const { status, limit } = options;
  const client = await getClient();
  let path = '/servers/detail';
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  if (qs) path += `?${qs}`;

  const res = await client.fetch(computeUrl(path));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Compute listServers failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.servers || [];
}

export async function getServer(serverId) {
  const client = await getClient();
  const res = await client.fetch(computeUrl(`/servers/${serverId}`));
  if (!res.ok) {
    if (res.status === 404) return null;
    const text = await res.text();
    throw new Error(`VHI Compute getServer failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.server || null;
}

export async function serverAction(serverId, action, body = {}) {
  const client = await getClient();
  const res = await client.fetch(computeUrl(`/servers/${serverId}/action`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [action]: body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Compute ${action} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function startServer(serverId) {
  return serverAction(serverId, 'os-start');
}

export async function stopServer(serverId) {
  return serverAction(serverId, 'os-stop');
}

export async function rebootServer(serverId, type = 'SOFT') {
  return serverAction(serverId, 'reboot', { type: type.toUpperCase() });
}

export async function deleteServer(serverId) {
  const client = await getClient();
  const res = await client.fetch(computeUrl(`/servers/${serverId}`), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Compute deleteServer failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function createServer(options = {}) {
  const client = await getClient();
  const res = await client.fetch(computeUrl('/servers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ server: options }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Compute createServer failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.server || null;
}
