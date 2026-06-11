import { listServers, getServer, rebootServer, startServer, stopServer, createServer, deleteServer, listFlavors as fetchFlavors } from '../vhi/compute.js';
import { resolveId } from './resolver.js';

export async function listFlavors(args = {}) {
  const flavors = await fetchFlavors();
  return {
    count: (flavors || []).length,
    flavors: (flavors || []).map(f => ({
      name: f.name,
      vcpus: f.vcpus,
      ram: f.ram,
      disk: f.disk,
      id: f.id,
    })),
  };
}

export async function listVms(args = {}) {
  const servers = await listServers({
    status: args.status,
    limit: args.limit || 50,
  });
  return {
    count: servers.length,
    vms: servers.map(s => ({
      name: s.name,
      status: s.status,
      created: s.created,
      id: s.id,
    })),
  };
}

export async function getVm(args) {
  const serverId = await resolveId('server', args.server_id);
  if (!serverId) throw new Error('server_id required');
  const s = await getServer(serverId);
  if (!s) return { found: false, server_id: serverId };
  return { 
    found: true, 
    server: { 
      id: s.id, 
      name: s.name, 
      status: s.status, 
      created: s.created,
      vcpus: s.vcpus,
      ram: s.ram,
      disk: s.disk
    } 
  };
}

export async function rebootVm(args) {
  const serverId = await resolveId('server', args.server_id);
  if (!serverId) throw new Error('server_id required');
  await rebootServer(serverId, args.type || 'SOFT');
  return { ok: true, action: 'reboot', server_id: serverId };
}

export async function startVm(args) {
  const serverId = await resolveId('server', args.server_id);
  if (!serverId) throw new Error('server_id required');
  await startServer(serverId);
  return { ok: true, action: 'start', server_id: serverId };
}

export async function stopVm(args) {
  const serverId = await resolveId('server', args.server_id);
  if (!serverId) throw new Error('server_id required');
  await stopServer(serverId);
  return { ok: true, action: 'stop', server_id: serverId };
}

export async function createVm(args) {
  if (!args.name || !args.imageRef || !args.flavorRef) {
    throw new Error('name, imageRef, and flavorRef are required to create a VM');
  }
  
  // Resolve names to IDs
  const imageId = await resolveId('image', args.imageRef);
  const flavorId = await resolveId('flavor', args.flavorRef);
  
  const createArgs = { 
    ...args, 
    imageRef: imageId, 
    flavorRef: flavorId 
  };

  // Resolve network names
  if (args.networks && Array.isArray(args.networks)) {
    createArgs.networks = await Promise.all(args.networks.map(async net => ({
      uuid: await resolveId('network', net.uuid)
    })));
  }

  const server = await createServer(createArgs);
  return { ok: true, action: 'create_vm', server_id: server.id, server };
}

export async function deleteVm(args) {
  const serverId = await resolveId('server', args.server_id);
  if (!serverId) throw new Error('server_id required');
  await deleteServer(serverId);
  return { ok: true, action: 'delete_vm', server_id: serverId };
}
