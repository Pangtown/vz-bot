/**
 * VHI 7.x Compute API (Nova-style) – servers list, get, start, stop, reboot, delete
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

export async function listServers(options = {}) {
  const { status, limit } = options;
  const client = await getClient();
  let path = '/servers/detail';
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (limit) params.set('limit', String(limit));
  
  // As an admin, we want to see all VMs across all projects/domains.
  // We include both all_projects (modern) and all_tenants (legacy) for maximum compatibility.
  params.set('all_projects', 'true');
  params.set('all_tenants', 'true');

  const url = await computeUrl(path);
  const fullUrl = params.toString() ? `${url}?${params.toString()}` : url;
  const res = await client.fetch(fullUrl);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Compute listServers failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.servers || [];
}

export async function getServer(serverId) {
  const client = await getClient();
  const res = await client.fetch(await computeUrl(`/servers/${serverId}`));
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
  const res = await client.fetch(await computeUrl(`/servers/${serverId}/action`), {
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
  const res = await client.fetch(await computeUrl(`/servers/${serverId}`), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Compute deleteServer failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function createServer(options = {}) {
  const client = await getClient();
  
  // Extract BDM options if present
  const bdm = Array.isArray(options.block_device_mapping_v2) ? options.block_device_mapping_v2[0] : null;
  const imageRef = options.imageRef || (bdm?.source_type === 'image' ? bdm.uuid : undefined);
  const volumeSize = options.volume_size || bdm?.volume_size || 50;
  const volumeType = options.volume_type || bdm?.volume_type;

  // Abstraction for easier LLM use
  const payload = {
    name: options.name,
    imageRef: imageRef,
    flavorRef: options.flavorRef,
    networks: options.networks || [],
    min_count: options.min_count || 1,
    max_count: options.max_count || 1,
  };

  // If networks is just a string (ID), convert to object
  if (typeof payload.networks === 'string') {
    payload.networks = [{ uuid: payload.networks }];
  }

  // Post-provision script via cloud-init: Nova expects base64 user_data (max 65535 bytes)
  if (options.user_data) {
    const encoded = Buffer.from(String(options.user_data), 'utf8').toString('base64');
    if (encoded.length > 65535) {
      throw new Error('user_data too large: cloud-init payload must be under 64 KB');
    }
    payload.user_data = encoded;
    // Deliver user_data via config drive so cloud-init works even on networks
    // where the Nova metadata service (169.254.169.254) is unreachable.
    payload.config_drive = true;
  }

  if (options.key_name) {
    payload.key_name = options.key_name;
  }

  // Default to Boot from Volume (block_device_mapping_v2) if an image or volume specs are provided
  // to avoid MaxRetriesExceeded scheduling errors on compute nodes without ephemeral storage.
  if (volumeSize || volumeType || imageRef) {
    payload.block_device_mapping_v2 = [{
      boot_index: 0,
      uuid: imageRef,
      source_type: 'image',
      destination_type: 'volume',
      volume_size: volumeSize,
      volume_type: volumeType || undefined,
      delete_on_termination: options.delete_on_termination !== false
    }];
  }

  console.log('[CREATE_VM] Payload:', JSON.stringify({ server: payload }, null, 2));

  const res = await client.fetch(await computeUrl('/servers'), {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Openstack-Api-Version': 'compute 2.67' 
    },
    body: JSON.stringify({ server: payload }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[CREATE_VM] FAILED (${res.status}):`, text);
    throw new Error(`VHI Compute createServer failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.server || null;
}

export async function getRemoteConsole(serverId, protocol = 'vnc', type = 'novnc') {
  const client = await getClient();
  const url = await computeUrl(`/servers/${serverId}/remote-consoles`);
  console.log(`[DEBUG] Attempting VNC Console for ${serverId} at ${url}`);

  const payload = {
    remote_console: {
      protocol: protocol,
      type: type
    }
  };

  const res = await client.fetch(url, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'OpenStack-API-Version': 'compute 2.87'
    },
    body: JSON.stringify(payload)
  });
  
  if (res.ok) {
    const data = await res.json();
    let consoleUrl = data.remote_console?.url || null;
    
    // If the base URL uses a domain name (not an IP), ensure the console URL uses it too.
    // This avoids certificate common name mismatch errors (e.g., NET::ERR_CERT_COMMON_NAME_INVALID).
    if (consoleUrl) {
      try {
        const base = getBaseUrl();
        const baseUri = new URL(base);
        const baseHostname = baseUri.hostname;
        
        console.log(`[DEBUG] Overriding console hostname to target VHI endpoint: ${baseHostname}`);
        // Replace scheme + hostname returned by Nova (e.g., https://demo.nexvantage.net:6080/...) with reachable base hostname
        consoleUrl = consoleUrl.replace(/https?:\/\/[^:/]+(:[0-9]+)/, `${baseUri.protocol}//${baseHostname}$1`);
      } catch (err) {
        console.error('[DEBUG] Failed to override VNC URL hostname:', err.message);
      }
    }
    
    return consoleUrl;
  }
  
  const textErr = await res.text();
  if (res.status === 400 || textErr.includes('Unavailable console type') || textErr.includes('Invalid input') || textErr.includes('Invalid console type')) {
    throw new Error(`Console type '${type}' (${protocol}) is not enabled on this VHI cluster. Only VNC (noVNC) is currently configured in Nova.`);
  }
  throw new Error(`Console negotiation failed (${res.status}): ${textErr.slice(0, 200)}`);
}

export async function listFlavors() {
  const client = await getClient();
  const res = await client.fetch(await computeUrl('/flavors/detail?is_public=None'));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Compute listFlavors failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.flavors || [];
}

export async function createFlavor(options = {}) {
  const client = await getClient();
  const payload = {
    name: options.name,
    ram: Number(options.ram),
    vcpus: Number(options.vcpus),
    disk: Number(options.disk) || 0,
    'os-flavor-access:is_public': options.is_public !== false,
  };
  const res = await client.fetch(await computeUrl('/flavors'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flavor: payload }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Compute createFlavor failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.flavor || null;
}

export async function deleteFlavor(flavorId) {
  const client = await getClient();
  const res = await client.fetch(await computeUrl(`/flavors/${flavorId}`), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Compute deleteFlavor failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function listKeypairs() {
  const client = await getClient();
  const res = await client.fetch(await computeUrl('/os-keypairs'));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Compute listKeypairs failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.keypairs || []).map((k) => k.keypair || k);
}

export async function createKeypair(options = {}) {
  const client = await getClient();
  const body = { name: options.name };
  if (options.public_key) body.public_key = options.public_key;
  const res = await client.fetch(await computeUrl('/os-keypairs'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keypair: body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Compute createKeypair failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.keypair || null;
}

export async function deleteKeypair(name) {
  const client = await getClient();
  const res = await client.fetch(await computeUrl(`/os-keypairs/${encodeURIComponent(name)}`), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Compute deleteKeypair failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}

export async function listHypervisors() {
  const client = await getClient();
  const res = await client.fetch(await computeUrl('/os-hypervisors/detail'));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Compute listHypervisors failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.hypervisors || [];
}

export async function getHypervisor(id) {
  const client = await getClient();
  const res = await client.fetch(await computeUrl(`/os-hypervisors/${id}`));
  if (!res.ok) {
    if (res.status === 404) return null;
    const text = await res.text();
    throw new Error(`VHI Compute getHypervisor failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.hypervisor || null;
}

export async function listInterfaces(serverId) {
  const client = await getClient();
  const res = await client.fetch(await computeUrl(`/servers/${serverId}/os-interface`));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Compute listInterfaces failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.interfaceAttachments || [];
}

export async function attachInterface(serverId, networkId) {
  const client = await getClient();
  const res = await client.fetch(await computeUrl(`/servers/${serverId}/os-interface`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interfaceAttachment: { net_id: networkId } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Compute attachInterface failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.interfaceAttachment || null;
}

export async function detachInterface(serverId, portId) {
  const client = await getClient();
  const res = await client.fetch(await computeUrl(`/servers/${serverId}/os-interface/${portId}`), {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`VHI Compute detachInterface failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return true;
}
