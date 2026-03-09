/**
 * VHI 7.x Network API (Neutron-style) – networks and ports (stub for VM creation)
 */

import { getClient } from './client.js';

const getBaseUrl = () => {
  const base = process.env.VHI_BASE_URL || 'https://172.16.218.7';
  return base.replace(/\/$/, '');
};

function networkUrl(path = '') {
  const base = getBaseUrl();
  const port = process.env.VHI_NETWORK_PORT || 9696;
  return `${base}:${port}/v2.0${path}`;
}

export async function listNetworks() {
  const client = await getClient();
  const res = await client.fetch(networkUrl('/networks'));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Network listNetworks failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.networks || [];
}

export async function listPorts() {
  const client = await getClient();
  const res = await client.fetch(networkUrl('/ports'));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Network listPorts failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.ports || [];
}

export async function createNetwork(options = {}) {
  const client = await getClient();
  const res = await client.fetch(networkUrl('/networks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network: options }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Network createNetwork failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.network || null;
}
