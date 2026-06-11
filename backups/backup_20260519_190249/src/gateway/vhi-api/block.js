import { runWithContext } from '../context.js';
import { listVolumes, getVolume, listVolumeTypes, attachVolume, detachVolume, createVolume, deleteVolume, extendVolume, retypeVolume, updateVolume, listSnapshots, createSnapshot, deleteSnapshot, revertSnapshot, uploadVolumeToImage } from '../../vhi/block.js';
import { json, readBody } from './helpers.js';
import { logger } from '../../utils/index.js';

export async function handleVolumeTypes(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, async () => {
      const base = ctx.vhiBaseUrl.replace(/\/$/, '');
      const port = process.env.VHI_BLOCK_PORT || 8776;
      const { getClient } = await import('../../vhi/client.js');
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
      const volumes = await runWithContext(ctx, () => listVolumes());
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
    const volume = await runWithContext(ctx, () => getVolume(id));
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
