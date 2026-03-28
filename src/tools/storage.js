import {
  listVolumes as fetchVolumes,
  getVolume as fetchVolume,
  createVolume as apiCreateVolume,
  deleteVolume as apiDeleteVolume,
  attachVolume as apiAttachVolume,
  detachVolume as apiDetachVolume,
  listVolumeTypes as fetchVolumeTypes
} from '../vhi/block.js';
import { resolveId } from './resolver.js';

export async function listVolumes(args = {}) {
  const volumes = await fetchVolumes();
  return {
    count: (volumes || []).length,
    volumes: (volumes || []).map(v => ({
      name: v.name,
      status: v.status,
      size: v.size,
      id: v.id,
    })),
  };
}

export async function listVolumeTypes(args = {}) {
  const types = await fetchVolumeTypes();
  return {
    count: (types || []).length,
    volume_types: (types || []).map(t => ({
      name: t.name,
      description: t.description,
      is_public: t.is_public,
      id: t.id,
    })),
  };
}

export async function getVolume(args) {
  const volumeId = await resolveId('volume', args.volume_id);
  if (!volumeId) throw new Error('volume_id required');
  const volume = await fetchVolume(volumeId);
  if (!volume) return { found: false, volume_id: volumeId };
  return { found: true, volume };
}

export async function createVolume(args) {
  if (!args.name || !args.size) throw new Error('name and size required');
  
  const createArgs = { ...args };
  if (args.volume_type) {
    createArgs.volume_type = await resolveId('policy', args.volume_type);
  }

  const volume = await apiCreateVolume(createArgs);
  return { ok: true, action: 'create_volume', volume_id: volume.id, volume };
}

export async function deleteVolume(args) {
  const volumeId = await resolveId('volume', args.volume_id);
  if (!volumeId) throw new Error('volume_id required');
  await apiDeleteVolume(volumeId);
  return { ok: true, action: 'delete_volume', volume_id: volumeId };
}

export async function attachVolume(args) {
  const serverId = await resolveId('server', args.server_id);
  const volumeId = await resolveId('volume', args.volume_id);
  
  if (!serverId || !volumeId) throw new Error('server_id and volume_id required');
  const attachment = await apiAttachVolume(serverId, volumeId, args.device);
  return { ok: true, action: 'attach_volume', attachment };
}

export async function detachVolume(args) {
  const serverId = await resolveId('server', args.server_id);
  // attachment_id is usually a specific ID from the attachment, not easily resolvable by "name"
  // but we should still handle the server resolution.
  if (!serverId || !args.attachment_id) throw new Error('server_id and attachment_id required');
  await apiDetachVolume(serverId, args.attachment_id);
  return { ok: true, action: 'detach_volume', server_id: serverId };
}
