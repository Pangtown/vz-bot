/**
 * Storage and network tools – list volumes, list networks
 */

import { listVolumes as fetchVolumes, createVolume as apiCreateVolume } from '../vhi/block.js';
import { listNetworks as fetchNetworks, createNetwork as apiCreateNetwork } from '../vhi/network.js';

export async function listVolumes(args = {}) {
  const volumes = await fetchVolumes();
  return {
    count: volumes.length,
    volumes: (volumes || []).map(v => ({
      id: v.id,
      name: v.name,
      status: v.status,
      size: v.size,
    })),
  };
}

export async function listNetworks(args = {}) {
  const networks = await fetchNetworks();
  return {
    count: (networks || []).length,
    networks: (networks || []).map(n => ({
      id: n.id,
      name: n.name,
      status: n.status,
    })),
  };
}

export async function createVolume(args) {
  if (!args.name || !args.size) throw new Error('name and size required');
  const volume = await apiCreateVolume(args);
  return { ok: true, action: 'create_volume', volume_id: volume.id, volume };
}

export async function createNetwork(args) {
  if (!args.name) throw new Error('name required');
  const network = await apiCreateNetwork(args);
  return { ok: true, action: 'create_network', network_id: network.id, network };
}
