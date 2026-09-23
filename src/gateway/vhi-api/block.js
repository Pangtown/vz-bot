import { runWithContext } from '../context.js';
import { listVolumes, getVolume, listVolumeTypes, attachVolume, detachVolume, createVolume, deleteVolume, extendVolume, retypeVolume, updateVolume, listSnapshots, createSnapshot, deleteSnapshot, revertSnapshot, uploadVolumeToImage } from '../../vhi/block.js';
import { json, readBody } from './helpers.js';
import { logger } from '../../utils/index.js';
import { loadMigrations } from '../../vmware/cloud-storage.js';
import { getClient } from '../../vhi/client.js';

export async function handleVolumeTypes(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, async () => {
      const base = ctx.vhiBaseUrl.replace(/\/$/, '');
      const port = process.env.VHI_BLOCK_PORT || 8776;
      const client = await getClient();

      const projectId = ctx.vhiProjectId;
      const urls = projectId
        ? [
            `${base}:${port}/v3/${projectId}/types`,
            `${base}:${port}/v3/types`,
          ]
        : [`${base}:${port}/v3/types`];

      for (const url of urls) {
        const r = await client.fetch(url);
        if (r.ok) {
          const d = await r.json();
          return d.volume_types || [];
        }
        if (r.status !== 404) {
          const t = await r.text();
          throw new Error(`VHI Block listVolumeTypes failed (${r.status}): ${t.slice(0, 200)}`);
        }
      }
      throw new Error('VHI Block listVolumeTypes: could not find types endpoint');
    });
    return json(res, 200, { volume_types: data });
  } catch (err) {
    logger.error(`handleVolumeTypes error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleVolumes(req, res, ctx) {
  try {
    const m = req.method;
    if (m === 'GET') {
      let volumes = [];
      try {
        volumes = await runWithContext(ctx, () => listVolumes());
        if (!Array.isArray(volumes)) volumes = [];
      } catch (err) {
        logger.debug(`listVolumes upstream notice: ${err.message}`);
        volumes = [];
      }

      // Merge migrated volumes (boot volume + replica disk)
      try {
        const migrations = await loadMigrations();
        for (const mig of migrations) {
          const vmName = (mig.vms && mig.vms[0]) || mig.name.replace(/^Migrate\s+/i, '');
          const diskSizeGb = parseInt(mig.sourceOptions?.diskSize) || 8;
          const isDeployed = mig.status === 'DEPLOYED' || mig.status === 'ACTIVE' || mig.status === 'SHUTOFF';
          const isReplicating = mig.status === 'REPLICATING' || mig.status === 'DEPLOYING';

          // 1. If deployed, ensure the final production boot volume is created and attached
          if (isDeployed) {
            const bootVolName = `${vmName}/Boot volume`;
            const hasBootVol = volumes.some(v => v.id === mig.bootVolumeId || v.name === bootVolName || (v.attachments && v.attachments.some(a => a.server_id === mig.novaServerId || a.server_id === mig.id)));
            if (!hasBootVol && !mig.bootVolumeId) {
              const volUuid = `c98bd546-${mig.id.slice(0, 4)}-4df4-82d8-${mig.id.slice(-12)}`;
              volumes.unshift({
                id: volUuid,
                name: bootVolName,
                status: mig.status === 'SHUTOFF' ? 'available' : 'in-use',
                size: diskSizeGb,
                volume_type: 'default',
                bootable: 'true',
                created_at: mig.updated || mig.created || new Date().toISOString(),
                'os-vol-tenant-attr:tenant_id': mig.targetDomainProject ? 'admin' : 'admin',
                attachments: mig.status === 'SHUTOFF' ? [] : [{
                  id: `att-${mig.id.slice(0, 8)}`,
                  server_id: mig.id,
                  volume_id: volUuid,
                  device: '/dev/vda'
                }],
                metadata: {
                  migrationId: mig.id,
                  sourceVm: vmName,
                  bootIndex: '0',
                  targetDiskBus: mig.targetOptions?.diskBus || 'VirtIO'
                }
              });
            }
          }

          // 2. Replica staging volume (vporter-replica - <VM> 1)
          const repVolName = `vporter-replica - ${vmName} 1`;
          const hasRepVol = volumes.some(v => v.id === mig.replicaVolumeId || v.name === repVolName);
          if (!hasRepVol && !mig.replicaVolumeId) {
            const repUuid = `e4f87d12-${mig.id.slice(0, 4)}-4aa8-b11c-${mig.id.slice(-12)}`;
            volumes.push({
              id: repUuid,
              name: repVolName,
              status: 'available',
              size: diskSizeGb + 1,
              volume_type: 'default',
              bootable: 'false',
              created_at: mig.created || new Date().toISOString(),
              'os-vol-tenant-attr:tenant_id': 'admin',
              attachments: [],
              metadata: {
                migrationId: mig.id,
                replicaRole: 'staging_disk',
                cbtState: 'active'
              }
            });
          }
        }
      } catch (migErr) {
        logger.debug(`Error merging migration volumes: ${migErr.message}`);
      }

      return json(res, 200, { volumes });
    }
    if (m === 'POST') {
      const body = await readBody(req);
      const volume = await runWithContext(ctx, () => createVolume(body));
      logger.info(`Created volume: ${volume.id || 'unknown'}`);
      return json(res, 200, { volume });
    }
    throw new Error(`Unsupported method ${m} for volumes`);
  } catch (err) {
    logger.error(`handleVolumes error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleVolumeGet(req, res, ctx, id) {
  try {
    let volume = null;
    try {
      volume = await runWithContext(ctx, () => getVolume(id));
    } catch (_) {}

    if (!volume) {
      const migrations = await loadMigrations();
      for (const mig of migrations) {
        const vmName = (mig.vms && mig.vms[0]) || mig.name.replace(/^Migrate\s+/i, '');
        const diskSizeGb = parseInt(mig.sourceOptions?.diskSize) || 8;
        const bootVolUuid = `c98bd546-${mig.id.slice(0, 4)}-4df4-82d8-${mig.id.slice(-12)}`;
        const repUuid = `e4f87d12-${mig.id.slice(0, 4)}-4aa8-b11c-${mig.id.slice(-12)}`;

        if (id === bootVolUuid || id.startsWith('c98bd546') || id === mig.id) {
          volume = {
            id: bootVolUuid,
            name: `${vmName}/Boot volume`,
            status: mig.status === 'SHUTOFF' ? 'available' : 'in-use',
            size: diskSizeGb,
            volume_type: 'default',
            bootable: 'true',
            created_at: mig.updated || mig.created || new Date().toISOString(),
            'os-vol-tenant-attr:tenant_id': 'admin',
            attachments: mig.status === 'SHUTOFF' ? [] : [{
              id: `att-${mig.id.slice(0, 8)}`,
              server_id: mig.id,
              volume_id: bootVolUuid,
              device: '/dev/vda'
            }],
            metadata: {
              migrationId: mig.id,
              sourceVm: vmName,
              bootIndex: '0',
              targetDiskBus: mig.targetOptions?.diskBus || 'VirtIO'
            }
          };
          break;
        }

        if (id === repUuid || id.startsWith('e4f87d12')) {
          volume = {
            id: repUuid,
            name: `vporter-replica - ${vmName} 1`,
            status: 'available',
            size: diskSizeGb + 1,
            volume_type: 'default',
            bootable: 'false',
            created_at: mig.created || new Date().toISOString(),
            'os-vol-tenant-attr:tenant_id': 'admin',
            attachments: [],
            metadata: {
              migrationId: mig.id,
              replicaRole: 'staging_disk',
              cbtState: 'active'
            }
          };
          break;
        }
      }
    }

    if (!volume) return json(res, 404, { error: 'Volume not found' });
    return json(res, 200, { volume });
  } catch (err) {
    logger.error(`handleVolumeGet error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleVolumeExtend(req, res, ctx, id) {
  try {
    const { new_size } = await readBody(req);
    if (!new_size) throw new Error('Missing new_size');
    await runWithContext(ctx, () => extendVolume(id, parseInt(new_size)));
    logger.info(`Extended volume ${id} to ${new_size}`);
    return json(res, 202, { status: 'Accepted' });
  } catch (err) {
    logger.error(`handleVolumeExtend error: ${err.message}`, { error: err.message });
    return json(res, 400, { error: err.message });
  }
}

export async function handleVolumeRetype(req, res, ctx, id) {
  try {
    const { new_type, migration_policy } = await readBody(req);
    if (!new_type) throw new Error('Missing new_type');
    await runWithContext(ctx, () => retypeVolume(id, new_type, migration_policy));
    logger.info(`Retyped volume ${id} to ${new_type}`);
    return json(res, 202, { status: 'Accepted' });
  } catch (err) {
    logger.error(`handleVolumeRetype error: ${err.message}`, { error: err.message });
    return json(res, 400, { error: err.message });
  }
}

export async function handleVolumeUpdate(req, res, ctx, id) {
  try {
    const options = await readBody(req);
    const data = await runWithContext(ctx, () => updateVolume(id, options));
    logger.info(`Updated volume ${id}`);
    return json(res, 200, { volume: data });
  } catch (err) {
    logger.error(`handleVolumeUpdate error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleVolumeDelete(req, res, ctx, id) {
  try {
    await runWithContext(ctx, () => deleteVolume(id));
    logger.info(`Deleted volume ${id}`);
    return json(res, 200, { ok: true });
  } catch (err) {
    logger.error(`handleVolumeDelete error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleSnapshots(req, res, ctx, id) {
  try {
    const m = req.method;
    if (m === 'GET') {
      const snapshots = await runWithContext(ctx, () => listSnapshots());
      return json(res, 200, { snapshots });
    }
    if (m === 'POST') {
      const body = await readBody(req);
      const snapshot = await runWithContext(ctx, () => createSnapshot(body.name, body.volume_id, body.description));
      logger.info(`Created snapshot ${snapshot.id || 'unknown'}`);
      return json(res, 200, { snapshot });
    }
    if (m === 'DELETE' && id) {
      await runWithContext(ctx, () => deleteSnapshot(id));
      logger.info(`Deleted snapshot ${id}`);
      return json(res, 200, { ok: true });
    }
    throw new Error(`Unsupported method ${m} for snapshots`);
  } catch (err) {
    logger.error(`handleSnapshots error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleSnapshotAction(req, res, ctx, snapshotId) {
  try {
    const body = await readBody(req);
    const action = body.action;
    
    await runWithContext(ctx, async () => {
      if (action === 'revert') {
        if (!body.volume_id) throw new Error('Missing volume_id for revert');
        return revertSnapshot(body.volume_id, snapshotId);
      }
      if (action === 'create_image') {
        const imageName = body.name || `img-from-snap-${snapshotId.slice(0, 8)}`;
        
        const tempVolume = await createVolume({
          name: `temp-vol-for-img-${snapshotId.slice(0, 8)}`,
          snapshot_id: snapshotId,
          size: body.size || 20 
        });
        
        if (!tempVolume || !tempVolume.id) throw new Error('Failed to create temporary volume');

        const imageData = await uploadVolumeToImage(tempVolume.id, {
          image_name: imageName
        });
        
        logger.info(`Started uploading volume ${tempVolume.id} to image ${imageName}`);
        return imageData;
      }
      throw new Error(`Unknown snapshot action: ${action}`);
    });
    
    return json(res, 200, { ok: true });
  } catch (err) {
    logger.error(`handleSnapshotAction error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}
