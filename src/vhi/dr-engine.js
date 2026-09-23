/**
 * Warm-standby DR: snapshot on primary, copy volumes to a second VHI cluster,
 * keep SHUTOFF standbys, and fail over by attaching the latest replica + start.
 */

import { mkdir, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runWithContext } from '../gateway/context.js';
import { registerInsecureHost } from '../utils/tls.js';
import { logger } from '../utils/index.js';
import { listServers, getServer, createServer, startServer, stopServer, deleteServer, listFlavors, createFlavor } from './compute.js';
import { getVolume, createVolume, deleteVolume, createSnapshot, waitVolume, waitSnapshot, uploadVolumeToImage, setVolumeBootable, setVolumeImageMetadata, attachVolume, detachVolume, forceDetachVolume, listSnapshots, deleteSnapshot } from './block.js';
import { createImage, waitImage, downloadImageToFile, uploadImageFromFile, deleteImage, listImages, getImage } from './image.js';
import { listNetworks } from './network.js';
import { getPlan, listPlans, savePlan, updatePlan, deletePlan, toContext, sanitizePlan } from './dr-store.js';

const XFER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'dr-xfer');
const inFlight = new Set();

const LOG_MAX = 200;

async function appendPlanLog(planId, level, message) {
  const line = `[DR] ${message}`;
  if (level === 'error') logger.error(line);
  else if (level === 'warn') logger.warn(line);
  else logger.info(line);
  if (!planId) return;
  await updatePlan(planId, (current) => {
    const log = Array.isArray(current.log) ? current.log.slice() : [];
    log.push({ ts: new Date().toISOString(), level: level || 'info', message: String(message) });
    current.log = log.slice(-LOG_MAX);
    return current;
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitServerGone(serverId, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const server = await getServer(serverId);
    if (!server) return;
    await sleep(3000);
  }
  throw new Error(`Server ${serverId} was not deleted`);
}

async function destroyStandby(drCtx, planId, serverId) {
  await runWithContext(drCtx, async () => {
    const existing = await getServer(serverId);
    if (!existing) return;
    const st = String(existing.status || '').toUpperCase();
    if (st !== 'SHUTOFF' && st !== 'STOPPED' && st !== 'ERROR') {
      await appendPlanLog(planId, 'info', `Stopping DR guest ${serverId} (${st}) before recreate`);
      await stopServer(serverId).catch(() => {});
      await waitServer(serverId, ['SHUTOFF'], 3 * 60 * 1000).catch(() => {});
    }
    await deleteServer(serverId);
    await waitServerGone(serverId);
  });
}

function requireCtx(ctx, label) {
  const next = toContext(ctx);
  if (!next.vhiBaseUrl || !next.vhiUser || !next.vhiPassword) {
    throw new Error(`${label} cluster credentials are incomplete`);
  }
  registerInsecureHost(next.vhiBaseUrl);
  return next;
}

async function waitServer(serverId, statuses, timeoutMs = 15 * 60 * 1000) {
  const want = new Set((statuses || ['ACTIVE']).map((s) => String(s).toUpperCase()));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const server = await getServer(serverId);
    if (!server) throw new Error(`Server ${serverId} disappeared`);
    const st = String(server.status || '').toUpperCase();
    if (want.has(st)) return server;
    if (st === 'ERROR') throw new Error(`Server ${serverId} entered ERROR`);
    await sleep(4000);
  }
  throw new Error(`Server ${serverId} did not reach ${[...want].join('/')}`);
}

function attachedVolumeIds(server) {
  const raw = server?.['os-extended-volumes:volumes_attached'] || server?.volumes_attached || [];
  return raw.map((v) => (typeof v === 'string' ? v : v.id)).filter(Boolean);
}

function serverNetworkNames(server) {
  return Object.keys(server?.addresses || {});
}

async function matchFlavor(srcServer) {
  const flavors = await listFlavors();
  const srcId = srcServer.flavor?.id;
  const srcMeta = flavors.find((f) => f.id === srcId);
  const vcpus = Number(srcServer.flavor?.vcpus || srcMeta?.vcpus) || 1;
  const ram = Number(srcServer.flavor?.ram || srcMeta?.ram) || 1024;
  const disk = Number(srcMeta?.disk) || 0;
  const name = srcMeta?.name || srcServer.flavor?.original_name || '';
  const exact = flavors.find((f) => f.name === name)
    || flavors.find((f) => Number(f.vcpus) === vcpus && Number(f.ram) === ram);
  if (exact) return exact;
  return createFlavor({
    name: `dr-${name || `${vcpus}c-${ram}m`}`.slice(0, 60),
    vcpus,
    ram,
    disk,
  });
}

async function pickDrNetwork(preferredId) {
  const nets = await listNetworks();
  if (preferredId) {
    const hit = nets.find((n) => n.id === preferredId);
    if (hit) return hit;
  }
  return nets.find((n) => !n['router:external'] && !/lb-mgmt|octavia/i.test(n.name || '')) || nets[0] || null;
}


async function detectFirmware(primaryCtx, vm, srcServer) {
  const hits = [
    srcServer?.metadata?.hw_firmware_type,
    srcServer?.image?.hw_firmware_type,
    srcServer?.image?.properties?.hw_firmware_type,
  ];
  for (const raw of hits) {
    const fw = String(raw || '').toLowerCase();
    if (fw.includes('uefi') || fw.includes('efi')) return 'uefi';
    if (fw.includes('bios')) return 'bios';
  }
  const imageId = srcServer?.image?.id;
  if (imageId && imageId !== '' && imageId !== 'N/A') {
    const img = await runWithContext(primaryCtx, () => getImage(imageId)).catch(() => null);
    const fw = String(img?.hw_firmware_type || '').toLowerCase();
    if (fw.includes('uefi') || fw.includes('efi')) return 'uefi';
    if (fw.includes('bios')) return 'bios';
  }
  const volId = vm.volumes?.[0]?.sourceVolumeId;
  if (volId) {
    const vol = await runWithContext(primaryCtx, () => getVolume(volId)).catch(() => null);
    const md = vol?.volume_image_metadata || {};
    const fw = String(md.hw_firmware_type || '').toLowerCase();
    if (fw.includes('uefi') || fw.includes('efi')) return 'uefi';
    if (fw.includes('bios')) return 'bios';
  }
  return 'uefi';
}

async function stampReplicaFirmware(drCtx, volumeId, firmware) {
  const metadata = {
    hw_firmware_type: firmware,
    hw_machine_type: firmware === 'uefi' ? 'q35' : 'pc',
    hw_disk_bus: 'virtio',
    hw_vif_model: 'virtio',
  };
  await runWithContext(drCtx, () => setVolumeImageMetadata(volumeId, metadata));
  await runWithContext(drCtx, () => setVolumeBootable(volumeId, true));
  return metadata;
}

async function stopPrimaryIfReachable(planId, plan, vm) {
  try {
    const primary = requireCtx(plan.primary, 'Primary');
    const server = await runWithContext(primary, () => getServer(vm.sourceServerId));
    if (!server) {
      await appendPlanLog(planId, 'info', `Primary VM ${vm.sourceServerName} is gone; treating the site as down`);
      return;
    }
    const st = String(server.status || '').toUpperCase();
    if (st === 'SHUTOFF' || st === 'STOPPED' || st === 'SHELVED_OFFLOADED') {
      await appendPlanLog(planId, 'info', `Primary ${vm.sourceServerName} is already ${st}`);
      return;
    }
    await appendPlanLog(planId, 'info', `Primary cluster is reachable; stopping ${vm.sourceServerName} to avoid split-brain`);
    await runWithContext(primary, () => stopServer(vm.sourceServerId));
    await runWithContext(primary, () => waitServer(vm.sourceServerId, ['SHUTOFF'], 5 * 60 * 1000));
    await appendPlanLog(planId, 'info', `Primary ${vm.sourceServerName} is SHUTOFF`);
  } catch (err) {
    await appendPlanLog(planId, 'warn', `Could not stop primary ${vm.sourceServerName} (${err.message}). Continuing failover; this is expected if the primary site is down.`);
  }
}

async function startPrimaryIfReachable(planId, plan, vm) {
  try {
    const primary = requireCtx(plan.primary, 'Primary');
    const server = await runWithContext(primary, () => getServer(vm.sourceServerId));
    if (!server) {
      await appendPlanLog(planId, 'warn', `Primary VM ${vm.sourceServerName} is gone; cannot start it`);
      return;
    }
    const st = String(server.status || '').toUpperCase();
    if (st === 'ACTIVE') {
      await appendPlanLog(planId, 'info', `Primary ${vm.sourceServerName} is already ACTIVE`);
      return;
    }
    await appendPlanLog(planId, 'info', `Starting primary ${vm.sourceServerName} (${st})`);
    await runWithContext(primary, () => startServer(vm.sourceServerId));
    await runWithContext(primary, () => waitServer(vm.sourceServerId, ['ACTIVE'], 5 * 60 * 1000));
    await appendPlanLog(planId, 'info', `Primary ${vm.sourceServerName} is ACTIVE`);
  } catch (err) {
    await appendPlanLog(planId, 'warn', `Could not start primary ${vm.sourceServerName} (${err.message})`);
  }
}

async function deleteTrackedSnapshot(ctx, planId, snapshotId, label) {
  if (!snapshotId) return;
  try {
    await runWithContext(ctx, () => deleteSnapshot(snapshotId));
    await appendPlanLog(planId, 'info', `Deleted ${label} snapshot ${snapshotId}`);
  } catch (err) {
    await appendPlanLog(planId, 'warn', `Could not delete ${label} snapshot ${snapshotId}: ${err.message}`);
  }
}

async function cleanupReplicaVolume(drCtx, planId, volumeId) {
  if (!volumeId) return;
  await runWithContext(drCtx, async () => {
    const vol = await getVolume(volumeId);
    if (!vol) {
      await appendPlanLog(planId, 'info', `Replica volume ${volumeId} is already gone`);
      return;
    }
    for (const att of vol.attachments || []) {
      const attId = att.id || att.attachment_id || volumeId;
      await forceDetachVolume(volumeId, attId).catch(() => {});
    }
    await waitVolume(volumeId, ['available'], 5 * 60 * 1000).catch(() => {});
    await deleteVolume(volumeId);
    await appendPlanLog(planId, 'info', `Deleted replica volume ${volumeId}`);
  });
}

async function replicateVolume(primaryCtx, drCtx, sourceVolumeId, planId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let snapshot;
  let tempVol;
  let srcImageId;
  let destImageId;
  const destPath = join(XFER_DIR, `${planId}-${sourceVolumeId}-${stamp}.img`);
  const imageName = `dr-${sourceVolumeId}-${stamp}`.slice(0, 220);
  await mkdir(XFER_DIR, { recursive: true });
  const log = (level, message) => appendPlanLog(planId, level, message);

  try {
    const source = await runWithContext(primaryCtx, () => getVolume(sourceVolumeId));
    if (!source) throw new Error(`Source volume ${sourceVolumeId} not found`);
    const size = Number(source.size) || 1;
    await log('info', `Volume ${source.name || sourceVolumeId}: ${size} GiB (id ${sourceVolumeId})`);

    await log('info', `Creating snapshot of ${sourceVolumeId} on primary`);
    snapshot = await runWithContext(primaryCtx, () => createSnapshot(
      `dr-${source.name || sourceVolumeId}-${stamp}`.slice(0, 220),
      sourceVolumeId,
      'DR warm-standby snapshot',
    ));
    await log('info', `Snapshot ${snapshot.id} created; waiting until available`);
    await runWithContext(primaryCtx, () => waitSnapshot(snapshot.id, ['available']));
    await log('info', `Snapshot ${snapshot.id} is available`);

    await log('info', `Creating transfer volume from snapshot ${snapshot.id}`);
    tempVol = await runWithContext(primaryCtx, () => createVolume({
      name: `dr-xfer-${sourceVolumeId}`.slice(0, 220),
      size,
      snapshot_id: snapshot.id,
    }));
    await log('info', `Transfer volume ${tempVol.id} created; waiting until available`);
    await runWithContext(primaryCtx, () => waitVolume(tempVol.id, ['available']));
    await log('info', `Transfer volume ${tempVol.id} is available`);

    await log('info', `Uploading transfer volume to Glance as ${imageName}`);
    const uploaded = await runWithContext(primaryCtx, () => uploadVolumeToImage(tempVol.id, {
      image_name: imageName,
      disk_format: 'qcow2',
    }));
    srcImageId = uploaded?.image_id || uploaded?.glance_image_id || '';
    if (!srcImageId) {
      await log('warn', 'Cinder response had no image_id; looking up Glance image by name');
      const found = await runWithContext(primaryCtx, () => listImages({ name: imageName }));
      srcImageId = found[0]?.id || '';
    }
    if (!srcImageId) {
      throw new Error('Cinder did not return an image id for volume upload and Glance has no matching image');
    }
    await log('info', `Primary Glance image ${srcImageId}; waiting until active (Cinder is copying the disk)`);
    await runWithContext(primaryCtx, () => waitImage(srcImageId, ['active']));
    await log('info', `Primary image ${srcImageId} is active; downloading to gateway`);
    await runWithContext(primaryCtx, () => downloadImageToFile(srcImageId, destPath));
    await log('info', `Downloaded image to ${destPath}`);

    await log('info', 'Creating empty image on DR cluster');
    const destImage = await runWithContext(drCtx, () => createImage({
      name: `dr-${source.name || sourceVolumeId}-${stamp}`.slice(0, 220),
      disk_format: 'qcow2',
      min_disk: size,
    }));
    destImageId = destImage.id;
    await log('info', `Uploading image file to DR Glance ${destImageId}`);
    await runWithContext(drCtx, () => uploadImageFromFile(destImageId, destPath));
    await runWithContext(drCtx, () => waitImage(destImageId, ['active']));
    await log('info', `DR image ${destImageId} is active`);

    await log('info', `Creating replica volume on DR from image ${destImageId}`);
    const replica = await runWithContext(drCtx, () => createVolume({
      name: `dr-replica-${source.name || sourceVolumeId}`.slice(0, 220),
      size,
      imageRef: destImageId,
    }));
    await log('info', `Replica volume ${replica.id} created; waiting until available`);
    await runWithContext(drCtx, () => waitVolume(replica.id, ['available']));
    await runWithContext(drCtx, () => setVolumeBootable(replica.id, true));
    await log('info', `Replica volume ${replica.id} ready (${size} GiB)`);

    return {
      replicaVolumeId: replica.id,
      lastSnapshotId: snapshot.id,
      size,
    };
  } finally {
    await unlink(destPath).catch(() => {});
    if (destImageId) {
      await runWithContext(drCtx, () => deleteImage(destImageId)).catch((err) => {
        logger.debug(`[DR] dest image cleanup: ${err.message}`);
      });
    }
    if (srcImageId) {
      await runWithContext(primaryCtx, () => deleteImage(srcImageId)).catch((err) => {
        logger.debug(`[DR] source image cleanup: ${err.message}`);
      });
    }
    if (tempVol?.id) {
      await runWithContext(primaryCtx, () => deleteVolume(tempVol.id)).catch((err) => {
        logger.debug(`[DR] temp volume cleanup: ${err.message}`);
      });
    }
  }
}

export async function createPlan(body, primaryCtx) {
  const primary = requireCtx(primaryCtx, 'Primary');
  const dr = requireCtx(body.dr || {}, 'DR');
  if (primary.vhiBaseUrl === dr.vhiBaseUrl) {
    throw new Error('DR cluster must be a different VHI URL than the primary');
  }
  await runWithContext(dr, () => listServers({ limit: 1 }));
  const plan = {
    id: undefined,
    name: body.name || `DR ${primary.vhiBaseUrl} -> ${dr.vhiBaseUrl}`,
    enabled: body.enabled !== false,
    syncIntervalMinutes: Math.max(15, Number(body.syncIntervalMinutes) || 60),
    drNetworkId: body.drNetworkId || '',
    primary,
    dr,
    protected: [],
    status: 'idle',
    lastSyncAt: null,
    lastError: '',
    log: [],
  };
  const saved = await savePlan(plan);
  await appendPlanLog(saved.id, 'info', `Plan created: ${saved.name} (${primary.vhiBaseUrl} -> ${dr.vhiBaseUrl}), interval ${saved.syncIntervalMinutes} min`);
  return sanitizePlan(await getPlan(saved.id));
}

export async function protectServers(planId, serverIds) {
  const ids = (serverIds || []).map(String).filter(Boolean);
  if (!ids.length) throw new Error('Select at least one VM to protect');
  const plan = await getPlan(planId);
  if (!plan) throw new Error('DR plan not found');
  const primary = requireCtx(plan.primary, 'Primary');

  const added = [];
  await runWithContext(primary, async () => {
    for (const serverId of ids) {
      if (plan.protected.some((p) => p.sourceServerId === serverId)) continue;
      const server = await getServer(serverId);
      if (!server) throw new Error(`VM ${serverId} not found on primary`);
      const volIds = attachedVolumeIds(server);
      if (!volIds.length) throw new Error(`${server.name || serverId} has no attached volumes`);
      added.push({
        sourceServerId: server.id,
        sourceServerName: server.name || server.id,
        sourceNetworks: serverNetworkNames(server),
        sourceFlavorId: server.flavor?.id || '',
        volumes: volIds.map((id) => ({
          sourceVolumeId: id,
          replicaVolumeId: '',
          lastSnapshotId: '',
          lastSyncAt: null,
        })),
        standbyServerId: '',
        status: 'idle',
        lastError: '',
      });
    }
  });

  const saved = await updatePlan(planId, (current) => {
    current.protected = [...current.protected, ...added];
    return current;
  });
  for (const row of added) {
    await appendPlanLog(planId, 'info', `Protected ${row.sourceServerName} (${row.volumes.length} volume(s))`);
  }
  return sanitizePlan(await getPlan(planId));
}

export async function unprotectServer(planId, serverId) {
  const saved = await updatePlan(planId, (current) => {
    current.protected = current.protected.filter((p) => p.sourceServerId !== serverId);
    return current;
  });
  if (!saved) throw new Error('DR plan not found');
  await appendPlanLog(planId, 'info', `Removed ${serverId} from the plan`);
  return sanitizePlan(await getPlan(planId));
}

async function detachReplicaVolume(drCtx, serverId, volumeId) {
  const vol = await runWithContext(drCtx, () => getVolume(volumeId)).catch(() => null);
  const attachment = (vol?.attachments || []).find((a) => a.server_id === serverId);
  const attachmentId = attachment?.id || attachment?.attachment_id || volumeId;
  try {
    await runWithContext(drCtx, () => detachVolume(serverId, attachmentId));
  } catch (err) {
    logger.warn(`[DR] Detach ${volumeId} from ${serverId} failed (${err.message}); force-detaching`);
    await runWithContext(drCtx, () => forceDetachVolume(volumeId, attachmentId));
  }
}

async function swapReplica(drCtx, protectedVm, vol, newReplicaId) {
  const oldId = vol.replicaVolumeId;
  if (protectedVm.standbyServerId && oldId) {
    const standby = await runWithContext(drCtx, () => getServer(protectedVm.standbyServerId));
    const attached = attachedVolumeIds(standby || {});
    if (attached.includes(oldId)) {
      await detachReplicaVolume(drCtx, protectedVm.standbyServerId, oldId);
      await sleep(3000);
      await runWithContext(drCtx, () => attachVolume(protectedVm.standbyServerId, newReplicaId));
    }
  }
  if (oldId && oldId !== newReplicaId) {
    await runWithContext(drCtx, () => deleteVolume(oldId)).catch((err) => {
      logger.warn(`[DR] Could not delete old replica ${oldId}: ${err.message}`);
    });
  }
}

export async function syncPlan(planId) {
  if (inFlight.has(planId)) {
    return sanitizePlan(await getPlan(planId));
  }
  inFlight.add(planId);
  try {
    let plan = await getPlan(planId);
    if (!plan) throw new Error('DR plan not found');
    if (plan.status === 'failed_over') throw new Error('Plan has already failed over');
    const primary = requireCtx(plan.primary, 'Primary');
    const dr = requireCtx(plan.dr, 'DR');

    await updatePlan(planId, (current) => {
      current.status = 'syncing';
      current.lastError = '';
      return current;
    });
    await appendPlanLog(planId, 'info', `Sync started for ${plan.protected.length} VM(s)`);

    for (const vm of plan.protected) {
      await updatePlan(planId, (current) => {
        const row = current.protected.find((p) => p.sourceServerId === vm.sourceServerId);
        if (row) {
          row.status = 'syncing';
          row.lastError = '';
        }
        return current;
      });
      try {
        for (const vol of vm.volumes) {
          await appendPlanLog(planId, 'info', `Replicating ${vm.sourceServerName} volume ${vol.sourceVolumeId}`);
          const copied = await replicateVolume(primary, dr, vol.sourceVolumeId, planId);
          await appendPlanLog(planId, 'info', `Replica ready ${copied.replicaVolumeId}; swapping onto standby if staged`);
          await swapReplica(dr, vm, vol, copied.replicaVolumeId);
          vol.replicaVolumeId = copied.replicaVolumeId;
          vol.lastSnapshotId = copied.lastSnapshotId;
          vol.lastSyncAt = new Date().toISOString();
        }
        await updatePlan(planId, (current) => {
          const row = current.protected.find((p) => p.sourceServerId === vm.sourceServerId);
          if (row) {
            row.volumes = vm.volumes;
            row.status = 'ready';
            row.lastError = '';
          }
          return current;
        });
      } catch (err) {
        await appendPlanLog(planId, 'error', `Sync failed for ${vm.sourceServerName}: ${err.message}`);
        await updatePlan(planId, (current) => {
          const row = current.protected.find((p) => p.sourceServerId === vm.sourceServerId);
          if (row) {
            row.status = 'error';
            row.lastError = err.message;
          }
          current.lastError = err.message;
          return current;
        });
      }
    }

    const saved = await updatePlan(planId, (current) => {
      const anyError = current.protected.some((p) => p.status === 'error');
      current.status = anyError ? 'error' : 'ready';
      current.lastSyncAt = new Date().toISOString();
      return current;
    });
    await appendPlanLog(planId, saved.status === 'error' ? 'error' : 'info', `Sync finished with status ${saved.status}`);
    return sanitizePlan(await getPlan(planId));
  } finally {
    inFlight.delete(planId);
  }
}

function vmBlockers(vm) {
  const vols = vm.volumes || [];
  const missingReplica = !vols.length || vols.some((v) => !v.replicaVolumeId);
  const missingStandby = !vm.standbyServerId;
  const reasons = [];
  if (missingReplica) reasons.push('no replica volume yet - run Sync');
  else reasons.push(`replica ${vols.map((v) => v.replicaVolumeId).filter(Boolean).join(', ')}`);
  if (missingStandby) reasons.push('standby VM not created - run Stage');
  else reasons.push(`standby ${vm.standbyServerId}`);
  return {
    name: vm.sourceServerName || vm.sourceServerId,
    missingReplica,
    missingStandby,
    blocked: missingReplica || missingStandby,
    summary: `${vm.sourceServerName || vm.sourceServerId}: ${reasons.join('; ')}`,
  };
}

export async function stagePlan(planId, opts = {}) {
  if (inFlight.has(planId)) {
    return sanitizePlan(await getPlan(planId));
  }
  inFlight.add(planId);
  try {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('DR plan not found');
  const resumeFailedOver = plan.status === 'failed_over'
    || (plan.protected || []).some((v) => v.status === 'failed_over');
  const primary = requireCtx(plan.primary, 'Primary');
  const dr = requireCtx(plan.dr, 'DR');
  await updatePlan(planId, (current) => {
    current.status = 'staging';
    current.lastError = '';
    return current;
  });
  await appendPlanLog(planId, 'info', 'Staging SHUTOFF standbys on the DR cluster');

  const recreate = !!opts.recreate;
  for (const vm of plan.protected) {
    if (vm.standbyServerId && recreate) {
      await appendPlanLog(planId, 'info', `Recreating standby for ${vm.sourceServerName}; replica volume is kept`);
      try {
        await destroyStandby(dr, planId, vm.standbyServerId);
      } catch (err) {
        await appendPlanLog(planId, 'warn', `Could not delete old standby ${vm.standbyServerId}: ${err.message}`);
      }
      vm.standbyServerId = '';
      await updatePlan(planId, (current) => {
        const row = current.protected.find((p) => p.sourceServerId === vm.sourceServerId);
        if (row) row.standbyServerId = '';
        return current;
      });
      const replicaId = vm.volumes?.[0]?.replicaVolumeId;
      if (replicaId) {
        await sleep(4000);
        await runWithContext(dr, () => waitVolume(replicaId, ['available'])).catch(() => {});
      }
    }
    if (vm.standbyServerId) continue;
    const boot = vm.volumes[0];
    if (!boot?.replicaVolumeId) {
      const msg = `${vm.sourceServerName}: no replica volume on DR yet. Sync must finish before Stage can create a SHUTOFF standby.`;
      await appendPlanLog(planId, 'error', msg);
      throw new Error(msg);
    }
    let src = {};
    let firmware = vm.firmware || 'uefi';
    try {
      src = await runWithContext(primary, () => getServer(vm.sourceServerId)) || {};
      firmware = await detectFirmware(primary, vm, src);
    } catch (err) {
      await appendPlanLog(planId, 'warn', `Could not read primary ${vm.sourceServerName} (${err.message}); using firmware=${firmware}`);
    }
    await stampReplicaFirmware(dr, boot.replicaVolumeId, firmware);
    await appendPlanLog(planId, 'info', `Stamped replica ${boot.replicaVolumeId} firmware=${firmware} so the DR guest matches the source boot mode`);
    const flavor = await runWithContext(dr, () => matchFlavor({
      ...src,
      flavor: { ...(src.flavor || {}), id: src.flavor?.id || vm.sourceFlavorId },
    }));
    const net = await runWithContext(dr, () => pickDrNetwork(plan.drNetworkId));
    if (!net) throw new Error('No network available on the DR cluster');

    const extraDisks = vm.volumes.slice(1)
      .filter((v) => v.replicaVolumeId)
      .map((v, idx) => ({
        boot_index: idx + 1,
        uuid: v.replicaVolumeId,
        source_type: 'volume',
        destination_type: 'volume',
        delete_on_termination: false,
      }));

    const server = await runWithContext(dr, () => createServer({
      name: `dr-${vm.sourceServerName}`.slice(0, 220),
      flavorRef: flavor.id,
      networks: [{ uuid: net.id }],
      metadata: {
        hw_firmware_type: firmware,
        hw_machine_type: firmware === 'uefi' ? 'q35' : 'pc',
      },
      block_device_mapping_v2: [
        {
          boot_index: 0,
          uuid: boot.replicaVolumeId,
          source_type: 'volume',
          destination_type: 'volume',
          delete_on_termination: false,
          disk_bus: 'virtio',
        },
        ...extraDisks,
      ],
    }));
    await appendPlanLog(planId, 'info', `Created standby ${server.id} for ${vm.sourceServerName}; waiting for ACTIVE/SHUTOFF`);
    await runWithContext(dr, () => waitServer(server.id, ['ACTIVE', 'SHUTOFF']));
    if (!resumeFailedOver) {
      try {
        await runWithContext(dr, () => stopServer(server.id));
        await runWithContext(dr, () => waitServer(server.id, ['SHUTOFF']));
        await appendPlanLog(planId, 'info', `Standby ${server.id} is SHUTOFF`);
      } catch (err) {
        await appendPlanLog(planId, 'warn', `Could not stop staged ${server.id}: ${err.message}`);
      }
    }

    vm.standbyServerId = server.id;
    vm.standbyFlavorId = flavor.id;
    vm.standbyNetworkId = net.id;
    await updatePlan(planId, (current) => {
      const row = current.protected.find((p) => p.sourceServerId === vm.sourceServerId);
      if (row) {
        row.standbyServerId = server.id;
        row.standbyFlavorId = flavor.id;
        row.standbyNetworkId = net.id;
        row.firmware = firmware;
      }
      return current;
    });
  }

  if (resumeFailedOver) {
    await appendPlanLog(planId, 'info', 'Restage after failover: starting the corrected DR guests');
    for (const vm of plan.protected) {
      if (!vm.standbyServerId) continue;
      await runWithContext(dr, async () => {
        await startServer(vm.standbyServerId);
        await waitServer(vm.standbyServerId, ['ACTIVE']);
      });
      await appendPlanLog(planId, 'info', `DR guest ${vm.sourceServerName} is ACTIVE after restage`);
      await updatePlan(planId, (current) => {
        const row = current.protected.find((p) => p.sourceServerId === vm.sourceServerId);
        if (row) row.status = 'failed_over';
        return current;
      });
    }
    await updatePlan(planId, (current) => {
      current.status = 'failed_over';
      return current;
    });
    await appendPlanLog(planId, 'info', 'Restage finished - DR guests are ACTIVE with source firmware');
    return sanitizePlan(await getPlan(planId));
  }

  await updatePlan(planId, (current) => {
    current.status = 'ready';
    return current;
  });
  await appendPlanLog(planId, 'info', 'Staging finished - standbys are SHUTOFF on DR');
  return sanitizePlan(await getPlan(planId));
  } catch (err) {
    await appendPlanLog(planId, 'error', `Stage failed: ${err.message}`);
    await updatePlan(planId, (current) => {
      current.status = 'error';
      current.lastError = err.message;
      return current;
    });
    throw err;
  } finally {
    inFlight.delete(planId);
  }
}

export async function failoverPlan(planId) {
  if (inFlight.has(planId)) {
    return sanitizePlan(await getPlan(planId));
  }
  inFlight.add(planId);
  try {
  const plan = await getPlan(planId);
  if (!plan) throw new Error('DR plan not found');
  const blockers = (plan.protected || []).map(vmBlockers);
  const blocked = blockers.filter((b) => b.blocked);
  if (blocked.length) {
    for (const row of blocked) {
      await appendPlanLog(planId, 'error', `Failover blocked - ${row.summary}`);
    }
    throw new Error(blocked.map((b) => b.summary).join(' | '));
  }
  await updatePlan(planId, (current) => {
    current.status = 'failing_over';
    current.lastError = '';
    return current;
  });
  await appendPlanLog(planId, 'info', 'Failover started - stop primary if reachable, then start standbys on DR');
  const dr = requireCtx(plan.dr, 'DR');

  for (const vm of plan.protected) {
    await stopPrimaryIfReachable(planId, plan, vm);
    await runWithContext(dr, async () => {
      const server = await getServer(vm.standbyServerId);
      if (!server) throw new Error(`Standby ${vm.sourceServerName} is missing on DR`);
      const attached = attachedVolumeIds(server);
      const bootId = vm.volumes[0].replicaVolumeId;
      if (bootId && !attached.includes(bootId)) {
        await attachVolume(vm.standbyServerId, bootId);
        await sleep(2000);
      }
      await appendPlanLog(planId, 'info', `Starting standby ${vm.standbyServerId} (${vm.sourceServerName})`);
      await startServer(vm.standbyServerId);
      await waitServer(vm.standbyServerId, ['ACTIVE']);
      await appendPlanLog(planId, 'info', `Standby ${vm.sourceServerName} is ACTIVE on DR`);
    });
    await updatePlan(planId, (current) => {
      const row = current.protected.find((p) => p.sourceServerId === vm.sourceServerId);
      if (row) row.status = 'failed_over';
      return current;
    });
  }

  const saved = await updatePlan(planId, (current) => {
    current.status = 'failed_over';
    current.lastFailoverAt = new Date().toISOString();
    return current;
  });
  await appendPlanLog(planId, 'info', 'Failover finished - standbys are ACTIVE on DR');
  return sanitizePlan(saved);
  } catch (err) {
    await appendPlanLog(planId, 'error', `Failover failed: ${err.message}`);
    await updatePlan(planId, (current) => {
      if (current.status !== 'failed_over') {
        current.status = current.protected?.some((p) => p.standbyServerId) ? 'ready' : 'error';
        current.lastError = err.message;
      }
      return current;
    });
    throw err;
  } finally {
    inFlight.delete(planId);
  }
}

export async function teardownAndDeletePlan(planId) {
  if (inFlight.has(planId)) {
    throw new Error('A DR operation is already running for this plan. Wait for it to finish, then delete.');
  }
  inFlight.add(planId);
  try {
    const plan = await getPlan(planId);
    if (!plan) throw new Error('DR plan not found');
    await updatePlan(planId, (current) => {
      current.status = 'cleaning_up';
      current.lastError = '';
      return current;
    });
    await appendPlanLog(planId, 'info', 'Cleanup started: remove DR VM, snapshots, and replica volumes, then start the primary VM');

    const dr = requireCtx(plan.dr, 'DR');
    let primaryOk = true;
    try {
      requireCtx(plan.primary, 'Primary');
    } catch (err) {
      primaryOk = false;
      await appendPlanLog(planId, 'warn', `Primary credentials incomplete (${err.message}); DR cleanup still continues`);
    }

    for (const vm of plan.protected || []) {
      if (vm.standbyServerId) {
        await destroyStandby(dr, planId, vm.standbyServerId);
        await appendPlanLog(planId, 'info', `Deleted DR guest ${vm.standbyServerId} (${vm.sourceServerName})`);
      }

      const replicaIds = (vm.volumes || []).map((v) => v.replicaVolumeId).filter(Boolean);
      try {
        const snaps = await runWithContext(dr, () => listSnapshots());
        for (const snap of snaps || []) {
          const volId = snap.volume_id || snap.volumeId;
          if (volId && replicaIds.includes(volId)) {
            await deleteTrackedSnapshot(dr, planId, snap.id, 'DR');
          }
        }
      } catch (err) {
        await appendPlanLog(planId, 'warn', `Could not list DR snapshots: ${err.message}`);
      }

      for (const vol of vm.volumes || []) {
        if (primaryOk) {
          await deleteTrackedSnapshot(requireCtx(plan.primary, 'Primary'), planId, vol.lastSnapshotId, 'primary');
        }
        try {
          await cleanupReplicaVolume(dr, planId, vol.replicaVolumeId);
        } catch (err) {
          await appendPlanLog(planId, 'error', `Could not delete replica volume ${vol.replicaVolumeId}: ${err.message}`);
          throw err;
        }
      }

      if (primaryOk) {
        await startPrimaryIfReachable(planId, plan, vm);
      }
    }

    await deletePlan(planId);
    logger.info(`[DR] Plan ${planId} deleted after cleanup`);
    return { ok: true, deleted: true };
  } catch (err) {
    await appendPlanLog(planId, 'error', `Cleanup failed: ${err.message}`);
    await updatePlan(planId, (current) => {
      if (!current) return current;
      current.status = 'error';
      current.lastError = err.message;
      return current;
    }).catch(() => {});
    throw err;
  } finally {
    inFlight.delete(planId);
  }
}

export async function tickDueDrPlans() {
  const plans = await listPlans();
  for (const plan of plans) {
    if (!plan.enabled || plan.status === 'failed_over' || plan.status === 'cleaning_up' || !plan.protected?.length) continue;
    if (inFlight.has(plan.id)) continue;
    const intervalMs = Math.max(15, Number(plan.syncIntervalMinutes) || 60) * 60 * 1000;
    if (plan.lastSyncAt && Date.now() - new Date(plan.lastSyncAt).getTime() < intervalMs) continue;
    logger.info(`[DR] Scheduled sync for plan ${plan.name}`);
    appendPlanLog(plan.id, 'info', 'Scheduled sync is due').catch(() => {});
    syncPlan(plan.id).catch((err) => logger.error(`[DR] Scheduled sync failed: ${err.message}`));
  }
}

export async function probeDrContext(body) {
  const dr = requireCtx(body || {}, 'DR');
  dr.vhiProjectId = '';
  try {
    const servers = await runWithContext(dr, () => listServers({ limit: 5 }));
    const networks = await runWithContext(dr, () => listNetworks());
    return {
      ok: true,
      vhiBaseUrl: dr.vhiBaseUrl,
      servers: servers.length,
      networks: networks.map((n) => ({ id: n.id, name: n.name })),
    };
  } catch (err) {
    const msg = String(err.message || '');
    if (/401|Unauthorized|requires authentication/i.test(msg)) {
      const host = String(dr.vhiBaseUrl || '').replace(/^https?:\/\//, '');
      throw new Error(`DR cluster Keystone rejected ${dr.vhiUser} on project ${dr.vhiProject} (${host}). Re-enter the DR password — the saved password may be stale, or this user has no role on that project.`);
    }
    throw err;
  }
}
