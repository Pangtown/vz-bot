/**
 * VM lifecycle tools – list, get, reboot, start, stop
 */

import { listServers, getServer, rebootServer, startServer, stopServer, createServer } from '../vhi/compute.js';

export async function listVms(args = {}) {
  const servers = await listServers({
    status: args.status,
    limit: args.limit || 50,
  });
  return {
    count: servers.length,
    vms: servers.map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      created: s.created,
    })),
  };
}

export async function getVm(args) {
  if (!args.server_id) throw new Error('server_id required');
  const s = await getServer(args.server_id);
  if (!s) return { found: false, server_id: args.server_id };
  return { found: true, server: { id: s.id, name: s.name, status: s.status, created: s.created } };
}

export async function rebootVm(args) {
  if (!args.server_id) throw new Error('server_id required');
  await rebootServer(args.server_id, args.type || 'SOFT');
  return { ok: true, action: 'reboot', server_id: args.server_id };
}

export async function startVm(args) {
  if (!args.server_id) throw new Error('server_id required');
  await startServer(args.server_id);
  return { ok: true, action: 'start', server_id: args.server_id };
}

export async function stopVm(args) {
  if (!args.server_id) throw new Error('server_id required');
  await stopServer(args.server_id);
  return { ok: true, action: 'stop', server_id: args.server_id };
}

export async function createVm(args) {
  if (!args.name || !args.imageRef || !args.flavorRef) {
    throw new Error('name, imageRef, and flavorRef are required to create a VM');
  }
  const server = await createServer(args);
  return { ok: true, action: 'create_vm', server_id: server.id, server };
}
