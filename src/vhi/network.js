/**
 * VHI 7.x Network API (Neutron-style) – networks and ports (stub for VM creation)
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

export async function getPort(portId) {
  const client = await getClient();
  const res = await client.fetch(networkUrl(`/ports/${portId}`));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Network getPort failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.port || null;
}

export async function updatePort(portId, options = {}) {
  const client = await getClient();
  const res = await client.fetch(networkUrl(`/ports/${portId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: options }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Network updatePort failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.port || null;
}

export async function deletePort(portId) {
  const client = await getClient();
  const res = await client.fetch(networkUrl(`/ports/${portId}`), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Network deletePort failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function createNetwork(options = {}) {
  const client = await getClient();
  
  // Map 'external' to 'router:external' for VHI/OpenStack
  const payload = { ...options };
  if (payload.external !== undefined) {
    payload['router:external'] = payload.external;
    delete payload.external;
  }

  const res = await client.fetch(networkUrl('/networks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ network: payload }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Network createNetwork failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.network || null;
}

export async function getNetwork(networkId) {
  const client = await getClient();
  const res = await client.fetch(networkUrl(`/networks/${networkId}`));
  if (!res.ok) {
    if (res.status === 404) return null;
    const text = await res.text();
    throw new Error(`VHI Network getNetwork failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.network || null;
}

export async function deleteNetwork(networkId) {
  const client = await getClient();
  const res = await client.fetch(networkUrl(`/networks/${networkId}`), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Network deleteNetwork failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function listSubnets(options = {}) {
  const client = await getClient();
  let path = '/subnets';
  const params = new URLSearchParams();
  if (options.network_id) params.set('network_id', options.network_id);
  const qs = params.toString();
  if (qs) path += `?${qs}`;

  const res = await client.fetch(networkUrl(path));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Network listSubnets failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.subnets || [];
}

export async function createSubnet(options = {}) {
  const client = await getClient();
  const res = await client.fetch(networkUrl('/subnets'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subnet: options }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Network createSubnet failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.subnet || null;
}

export async function deleteSubnet(subnetId) {
  const client = await getClient();
  const res = await client.fetch(networkUrl(`/subnets/${subnetId}`), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Network deleteSubnet failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function listSecurityGroups() {
  const client = await getClient();
  const res = await client.fetch(networkUrl('/security-groups'));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Network listSecurityGroups failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.security_groups || [];
}

async function neutron(method, path, wrapKey, payload) {
  const client = await getClient();
  const opts = { method };
  if (payload !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(wrapKey ? { [wrapKey]: payload } : payload);
  }
  const res = await client.fetch(networkUrl(path), opts);
  if (method === 'DELETE') {
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(`VHI Network ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return true;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Network ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return true;
  const data = await res.json();
  if (wrapKey && data[wrapKey] !== undefined) return data[wrapKey];
  return data;
}

export async function createSecurityGroup(options = {}) {
  return neutron('POST', '/security-groups', 'security_group', options);
}

export async function deleteSecurityGroup(id) {
  return neutron('DELETE', `/security-groups/${id}`);
}

export async function createSecurityGroupRule(options = {}) {
  return neutron('POST', '/security-group-rules', 'security_group_rule', options);
}

export async function deleteSecurityGroupRule(id) {
  return neutron('DELETE', `/security-group-rules/${id}`);
}

export async function listFloatingIPs() {
  const data = await neutron('GET', '/floatingips');
  return data.floatingips || [];
}

export async function createFloatingIP(options = {}) {
  return neutron('POST', '/floatingips', 'floatingip', options);
}

export async function updateFloatingIP(id, options = {}) {
  return neutron('PUT', `/floatingips/${id}`, 'floatingip', options);
}

export async function deleteFloatingIP(id) {
  return neutron('DELETE', `/floatingips/${id}`);
}

export async function listRouters() {
  const data = await neutron('GET', '/routers');
  return data.routers || [];
}

export async function createRouter(options = {}) {
  return neutron('POST', '/routers', 'router', options);
}

export async function deleteRouter(id) {
  return neutron('DELETE', `/routers/${id}`);
}

export async function addRouterInterface(routerId, options = {}) {
  return neutron('PUT', `/routers/${routerId}/add_router_interface`, null, options);
}

export async function removeRouterInterface(routerId, options = {}) {
  return neutron('PUT', `/routers/${routerId}/remove_router_interface`, null, options);
}
