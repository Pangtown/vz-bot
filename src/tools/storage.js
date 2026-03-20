/**
 * Storage tools – get, list, create, delete, attach, detach volumes
 */

import {
  listVolumes as fetchVolumes,
  getVolume as fetchVolume,
  createVolume as apiCreateVolume,
  deleteVolume as apiDeleteVolume,
  attachVolume as apiAttachVolume,
  detachVolume as apiDetachVolume,
  listVolumeTypes as fetchVolumeTypes
} from '../vhi/block.js';

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

export async function listVolumeTypes(args = {}) {
  const types = await fetchVolumeTypes();
  return {
    count: types.length,
    volume_types: (types || []).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      is_public: t.is_public,
    })),
  };
}

export async function getVolume(args) {
  if (!args.volume_id) throw new Error('volume_id required');
  const volume = await fetchVolume(args.volume_id);
  if (!volume) return { found: false, volume_id: args.volume_id };
  return { found: true, volume };
}

export async function createVolume(args) {
  if (!args.name || !args.size) throw new Error('name and size required');
  const volume = await apiCreateVolume(args);
  return { ok: true, action: 'create_volume', volume_id: volume.id, volume };
}

export async function deleteVolume(args) {
  if (!args.volume_id) throw new Error('volume_id required');
  await apiDeleteVolume(args.volume_id);
  return { ok: true, action: 'delete_volume', volume_id: args.volume_id };
}

export async function attachVolume(args) {
  if (!args.server_id || !args.volume_id) throw new Error('server_id and volume_id required');
  const attachment = await apiAttachVolume(args.server_id, args.volume_id, args.device);
  return { ok: true, action: 'attach_volume', attachment };
}

export async function detachVolume(args) {
  if (!args.server_id || !args.attachment_id) throw new Error('server_id and attachment_id required');
  await apiDetachVolume(args.server_id, args.attachment_id);
  return { ok: true, action: 'detach_volume', server_id: args.server_id };
}
