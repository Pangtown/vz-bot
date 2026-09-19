/**
 * Independent Coriolis-style migration engine.
 *
 * Linux guests clone and morph with the Linux porter (vporter-minion-linux).
 * Windows guests clone and morph with the Windows porter (vporter-minion-windows) only.
 * Windows migrations never spawn vporter-minion-linux.
 * Guest, Linux-worker, and Windows-worker each get their own Neutron IP.
 */

import { listImages, createImage, uploadImageData, getImage, deleteImage, waitImage, importImageFromUrl } from '../vhi/image.js';
import { listFlavors, createServer, getServer, deleteServer, getConsoleOutput } from '../vhi/compute.js';
import { createPort, deletePort, getPort, listNetworks, listSubnets } from '../vhi/network.js';
import {
  createVolume,
  getVolume,
  deleteVolume,
  attachVolume,
  detachVolume,
  createSnapshot,
  getSnapshot,
  deleteSnapshot,
  updateVolume,
  setVolumeBootable,
  setVolumeImageMetadata,
  forceDetachVolume,
} from '../vhi/block.js';
import { getCloudById, loadMigrations, getMigrationById, saveMigration } from './cloud-storage.js';
import { acquireHttpNfcLease, downloadNfcDisk, completeHttpNfcLease, abortHttpNfcLease, pingHttpNfcLease } from './esxi-client.js';
import { getEsxiVmInventory } from './esxi-client.js';
import { cloneGuestDisk as porterCloneGuestDisk, abortInFlightClone, usesPorterForClone } from './porter-clone.js';
import { removeCloneFiles } from './windows-replica-fill.js';
import { markCancelled, clearCancelled, isCancelled, throwIfCancelled, MigrationCancelledError } from './migration-cancel.js';
import { runWithContext } from '../gateway/context.js';
import { logger } from '../utils/index.js';

export const LINUX_PORTER_IMAGE = 'vporter-minion-linux';
export const WINDOWS_PORTER_IMAGE = 'vporter-minion-windows';

export const REPLICATION_TASK_NAMES = [
  'Validate transfer source inputs',
  'Get instance info',
  'Validate transfer destination inputs',
  'Deploy transfer disks',
  'Deploy transfer source resources',
  'Deploy transfer target resources',
  'Replicate disks (100%)',
  'Delete transfer source resources',
  'Delete transfer target resources',
];

export const DEPLOYMENT_TASK_NAMES = [
  'Validate deployment inputs',
  'Create transfer disk snapshots',
  'Deploy instance resources',
  'Deploy os morphing resources',
  'Os morphing',
  'Delete os morphing resources',
  'Get optimal flavor',
  'Finalize instance deployment',
  'Delete transfer target disk snapshots',
];

const busy = new Set();
let ticking = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uuid() {
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}

function shortId(id) {
  return String(id || '').replace(/-/g, '').slice(0, 8);
}

function portIp(port) {
  return port?.fixed_ips?.[0]?.ip_address || '';
}

export function isWindowsGuest(mig) {
  const os = String(mig?.sourceOptions?.os || '').trim().toLowerCase();
  if (os === 'linux') return false;
  if (os === 'windows' || os.includes('windows')) return true;
  const guestId = String(mig?.guestId || mig?.sourceOptions?.guestId || '');
  const guestOs = String(mig?.guestOs || mig?.sourceOptions?.guestOs || '');
  const distro = String(mig?.targetOptions?.osDistro || mig?.targetOptions?.os_distro || '');
  return /^win/i.test(guestId) || /windows/i.test(guestId) || /windows/i.test(guestOs) || /windows/i.test(distro);
}

function vmNameOf(mig) {
  return (mig.vms && mig.vms[0]) || String(mig.name || 'guest').replace(/^Migrate\s+/i, '');
}

function diskSizeGb(mig) {
  const n = parseInt(mig.sourceOptions?.diskSize, 10);
  return Number.isFinite(n) && n > 0 ? n : (isWindowsGuest(mig) ? 48 : 8);
}

function replicaSizeGb(mig) {
  const stored = Number(mig.replicaSizeGb);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return diskSizeGb(mig) + 1;
}

function optionYes(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(yes|true|1|on)$/i.test(String(value).trim());
}

function optionLabel(value, fallback = true) {
  return optionYes(value, fallback) ? 'Yes' : 'No';
}

function volumeIsBootable(vol) {
  const flag = vol?.bootable;
  return flag === true || String(flag).toLowerCase() === 'true';
}

async function ensureVolumeBootable(volumeId) {
  if (!volumeId) throw new Error('Boot volume id missing');
  let vol = await getVolume(volumeId);
  if (!vol) throw new Error(`Boot volume ${volumeId} not found`);
  if (!volumeIsBootable(vol)) {
    await setVolumeBootable(volumeId, true);
    vol = await waitFor(`bootable flag on volume ${volumeId}`, () => getVolume(volumeId), {
      timeoutMs: 60000,
      intervalMs: 2000,
      ok: (v) => v && volumeIsBootable(v),
    });
  }
  return vol;
}

function guestFirmware(mig) {
  const raw = mig.firmware || mig.sourceOptions?.firmware || '';
  return /efi|uefi/i.test(String(raw)) ? 'uefi' : 'bios';
}

function guestDiskBus(mig) {
  // VMware Linux initramfs has AHCI/sd_mod, not virtio_blk. Always attach as
  // SATA until OS morph injects virtio and sets morphedToVirtio.
  return mig.morphedToVirtio ? 'virtio' : 'sata';
}

function guestVifModel(mig) {
  if (mig.morphedToVirtio) return 'virtio';
  return isWindowsGuest(mig) ? 'e1000e' : 'e1000';
}

export function needsGuestBootRepair(m) {
  if (m.status !== 'DEPLOYED' && m.status !== 'ACTIVE') return false;
  if (!m.clonedBytes || !m.novaServerId) return false;
  const wantBus = guestDiskBus(m);
  if (m.stampedDiskBus !== wantBus) return true;
  if (!m.bootFirmwareStamped && /efi|uefi/i.test(String(m.firmware || m.sourceOptions?.firmware || ''))) return true;
  return false;
}

async function stampBootFirmware(mig, volumeId) {
  const firmware = guestFirmware(mig);
  const metadata = {
    hw_firmware_type: firmware,
    hw_machine_type: firmware === 'uefi' ? 'q35' : 'pc',
    hw_disk_bus: guestDiskBus(mig),
    hw_vif_model: guestVifModel(mig),
  };
  await setVolumeImageMetadata(volumeId, metadata);
  appendLog(mig, `Stamped boot volume ${volumeId} firmware=${firmware} machine=${metadata.hw_machine_type} bus=${metadata.hw_disk_bus} vif=${metadata.hw_vif_model}`);
}

export async function rebuildGuestBoot(mig) {
  if (!mig?.bootVolumeId || !mig?.guestPortId || !mig?.flavorId) {
    throw new Error('Cannot rebuild guest boot: boot volume, port, or flavor missing');
  }
  const firmware = guestFirmware(mig);
  appendLog(mig, `Recreating guest with ${firmware.toUpperCase()} firmware and ${guestDiskBus(mig)} disk bus so the cloned disk can boot`);
  await persist(mig);
  if (mig.novaServerId) {
    appendLog(mig, `Removing previous guest ${mig.novaServerId} (volume and Neutron port are kept)`);
    await safeDeleteServer(mig.novaServerId);
    mig.novaServerId = null;
    await persist(mig);
  }
  await waitVolumeAvailable(mig.bootVolumeId, mig, 600000);
  await stampBootFirmware(mig, mig.bootVolumeId);
  await ensureVolumeBootable(mig.bootVolumeId);
  const guest = await getPort(mig.guestPortId).catch(() => null);
  mig.ipAddress = portIp(guest) || mig.ipAddress;
  const server = await createServer({
    name: vmNameOf(mig),
    flavorRef: mig.flavorId,
    networks: [{ port: mig.guestPortId }],
    block_device_mapping_v2: [{
      boot_index: 0,
      uuid: mig.bootVolumeId,
      source_type: 'volume',
      destination_type: 'volume',
      delete_on_termination: false,
      disk_bus: guestDiskBus(mig),
    }],
  });
  await waitServer(server.id, ['ACTIVE'], 300000);
  mig.novaServerId = server.id;
  mig.bootFirmwareStamped = true;
  mig.uefiBootStamped = firmware === 'uefi';
  mig.stampedDiskBus = guestDiskBus(mig);
  mig.status = 'DEPLOYED';
  appendLog(mig, `Guest ${server.id} rebuilt with ${firmware.toUpperCase()} firmware bus=${mig.stampedDiskBus}, IP ${mig.ipAddress || '(pending DHCP)'}`);
  await persist(mig);
  return mig;
}

async function cloneGuestDisk(mig) {
  return porterCloneGuestDisk(mig, {
    LINUX_PORTER_IMAGE,
    WINDOWS_PORTER_IMAGE,
    isWindowsGuest,
    getCloudById,
    findImageByName,
    listFlavors,
    pickFlavor,
    appendLog,
    persist,
    detachNamedVolume,
    safeDeleteServer,
    safeDeletePort,
    waitVolume,
    guestFirmware,
    guestDiskBus,
    allocatePort,
    shortId,
    portIp,
    spawnPorter,
    getPort,
    acquireHttpNfcLease,
    downloadNfcDisk,
    pingHttpNfcLease,
    completeHttpNfcLease,
    abortHttpNfcLease,
    ensureVolumeBootable,
    getConsoleOutput,
    sleep,
    createImage,
    uploadImageData,
    importImageFromUrl,
    waitImage,
    getImage,
    deleteImage,
    createVolume,
    deleteVolume,
    getVolume,
  });
}

async function bootVolumeSizeGb(mig) {
  let snapSize = 0;
  let replicaLive = 0;
  if (mig.snapshotId) {
    const snap = await getSnapshot(mig.snapshotId).catch(() => null);
    snapSize = Number(snap?.size) || 0;
  }
  if (mig.replicaVolumeId) {
    const replica = await getVolume(mig.replicaVolumeId).catch(() => null);
    replicaLive = Number(replica?.size) || 0;
  }
  const size = Math.max(diskSizeGb(mig), replicaSizeGb(mig), snapSize, replicaLive);
  if (snapSize && size < snapSize) {
    throw new Error(`Boot volume ${size}GiB cannot be smaller than snapshot ${snapSize}GiB`);
  }
  return size;
}

function appendLog(mig, message) {
  const logs = Array.isArray(mig.logs) ? mig.logs : [];
  logs.push({ at: new Date().toISOString(), message: String(message) });
  mig.logs = logs.slice(-200);
  logger.info(`[MIG ${mig.id}] ${message}`);
}

async function persist(mig, extra = {}) {
  const next = { ...mig, ...extra };
  const cancelWrite = !!(next.cancelRequested || next.status === 'CANCELLED' || next.status === 'CANCELLING');
  if (isCancelled(mig.id) && !cancelWrite) return mig;
  mig.persistGeneration = Number(mig.persistGeneration || 0) + 1;
  Object.assign(mig, extra, { updated: new Date().toISOString() });
  return saveMigration(mig);
}

async function findImageByName(name) {
  let images = [];
  try {
    images = await listImages({ name, limit: 50 });
  } catch (_) {
    images = [];
  }
  let match = (images || []).find((img) => img.name === name);
  if (!match) {
    try {
      images = await listImages({ limit: 200 });
    } catch (_) {
      images = [];
    }
    match = (images || []).find((img) => img.name === name);
  }
  if (match && String(match.status || '').toLowerCase() !== 'active') {
    throw new Error(`Glance image "${name}" exists but is not ACTIVE (status=${match.status})`);
  }
  return match || null;
}

function pickFlavor(flavors, { minRamMb = 2048, minVcpus = 1, preferredId } = {}) {
  const list = Array.isArray(flavors) ? flavors : [];
  if (preferredId) {
    const hit = list.find((f) => f.id === preferredId);
    if (hit) return hit;
  }
  const ok = list
    .filter((f) => Number(f.ram) >= minRamMb && Number(f.vcpus) >= minVcpus)
    .sort((a, b) => (Number(a.ram) - Number(b.ram)) || (Number(a.vcpus) - Number(b.vcpus)));
  return ok[0] || list[0] || null;
}

async function waitFor(label, fn, { timeoutMs = 180000, intervalMs = 4000, ok } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (ok(last)) return last;
    const status = last?.status || last?.['OS-EXT-STS:vm_state'] || '';
    if (/error/i.test(String(status))) {
      throw new Error(`${label} entered ERROR state`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for ${label} (${timeoutMs}ms). Last status: ${last?.status || 'unknown'}`);
}

async function waitVolume(volumeId, statuses, timeoutMs = 180000) {
  const want = statuses.map((s) => s.toLowerCase());
  return waitFor(`volume ${volumeId}`, () => getVolume(volumeId), {
    timeoutMs,
    ok: (vol) => vol && want.includes(String(vol.status || '').toLowerCase()),
  });
}

async function waitVolumeAvailable(volumeId, mig, timeoutMs = 600000) {
  if (!volumeId) return null;
  let vol = await getVolume(volumeId).catch(() => null);
  if (!vol) throw new Error(`Volume ${volumeId} not found`);
  const st = String(vol.status || '').toLowerCase();
  if (st === 'available') return vol;
  if (mig) appendLog(mig, `Waiting for volume ${volumeId} (${vol.status}) to become available`);
  try {
    return await waitVolume(volumeId, ['available'], timeoutMs);
  } catch (err) {
    vol = await getVolume(volumeId).catch(() => null);
    const latest = String(vol?.status || '').toLowerCase();
    if (latest === 'available') return vol;
    const attachment = (vol?.attachments || [])[0];
    const attachmentId = attachment?.id || attachment?.attachment_id;
    if (mig) appendLog(mig, `Volume ${volumeId} still ${vol?.status || 'unknown'}; forcing detach`);
    await forceDetachVolume(volumeId, attachmentId).catch((forceErr) => {
      if (mig) appendLog(mig, `Force detach failed: ${forceErr.message}`);
    });
    return waitVolume(volumeId, ['available'], Math.min(timeoutMs, 300000));
  }
}

async function releaseVolumeFromServer(serverId, volumeId, mig) {
  if (serverId) {
    await detachNamedVolume(serverId, volumeId);
    await safeDeleteServer(serverId);
  }
  if (!volumeId) return null;
  return waitVolumeAvailable(volumeId, mig, 600000);
}

async function waitServer(serverId, statuses, timeoutMs = 300000) {
  const want = statuses.map((s) => s.toLowerCase());
  return waitFor(`server ${serverId}`, () => getServer(serverId), {
    timeoutMs,
    ok: (srv) => srv && want.includes(String(srv.status || '').toLowerCase()),
  });
}

async function waitSnapshot(snapshotId, timeoutMs = 180000) {
  return waitFor(`snapshot ${snapshotId}`, () => getSnapshot(snapshotId), {
    timeoutMs,
    ok: (snap) => snap && String(snap.status || '').toLowerCase() === 'available',
  });
}

async function safeDeleteServer(id) {
  if (!id) return;
  try { await deleteServer(id); } catch (err) {
    logger.warn(`Failed to delete server ${id}: ${err.message}`);
  }
}

async function safeDeletePort(id) {
  if (!id) return;
  try { await deletePort(id); } catch (err) {
    logger.warn(`Failed to delete port ${id}: ${err.message}`);
  }
}

async function safeDeleteVolume(id) {
  if (!id) return;
  try { await deleteVolume(id); } catch (err) {
    logger.warn(`Failed to delete volume ${id}: ${err.message}`);
  }
}

async function safeDeleteSnapshot(id) {
  if (!id) return;
  try { await deleteSnapshot(id); } catch (err) {
    logger.warn(`Failed to delete snapshot ${id}: ${err.message}`);
  }
}

async function allocatePort(networkId, name, description) {
  const port = await createPort({ network_id: networkId, name, description });
  if (!port?.id) throw new Error(`Neutron did not return a port for ${name}`);
  return port;
}

async function spawnPorter({ image, flavor, portId, name, volumeType, minDisk, replicaVolumeId, userData }) {
  const volumeSize = Math.max(Number(image.min_disk) || 0, Number(minDisk) || 10, 10);
  const block_device_mapping_v2 = replicaVolumeId ? [
    {
      boot_index: 0,
      uuid: image.id,
      source_type: 'image',
      destination_type: 'volume',
      volume_size: volumeSize,
      volume_type: volumeType || undefined,
      delete_on_termination: true,
    },
    {
      boot_index: -1,
      uuid: replicaVolumeId,
      source_type: 'volume',
      destination_type: 'volume',
      delete_on_termination: false,
    },
  ] : undefined;
  const server = await createServer({
    name,
    imageRef: image.id,
    flavorRef: flavor.id,
    networks: [{ port: portId }],
    volume_size: volumeSize,
    volume_type: volumeType || undefined,
    delete_on_termination: true,
    block_device_mapping_v2,
    user_data: userData,
  });
  if (!server?.id) throw new Error(`Nova did not return a server for ${name}`);
  await waitServer(server.id, ['ACTIVE'], /windows/i.test(image.name) ? 600000 : 300000);
  return server;
}

async function detachNamedVolume(serverId, volumeId) {
  if (!serverId || !volumeId) return;
  const vol = await getVolume(volumeId).catch(() => null);
  const attachment = (vol?.attachments || []).find((a) => a.server_id === serverId);
  const attachmentId = attachment?.id || attachment?.attachment_id || volumeId;
  try {
    await detachVolume(serverId, attachmentId);
  } catch (err) {
    logger.warn(`Detach ${volumeId} from ${serverId} failed: ${err.message}`);
  }
}

async function withMigContext(mig, fn) {
  if (!mig.context?.vhiPassword) {
    throw new Error('Migration is missing cluster credentials');
  }
  return runWithContext(mig.context, fn);
}

export async function createAndStartMigration(body, ctx) {
  if (!ctx?.vhiBaseUrl || !ctx?.vhiUser || !ctx?.vhiPassword) {
    throw new Error('VHI credentials are required to start a migration');
  }

  const name = String(body.name || (body.vms && body.vms[0]) || '').trim();
  if (!name) throw new Error('Migration name / VM is required');
  if (!body.networkId) throw new Error('Target Neutron network is required');

  const windows = isWindowsGuest({
    guestId: body.guestId || body.sourceOptions?.guestId,
    guestOs: body.guestOs || body.sourceOptions?.guestOs,
    sourceOptions: body.sourceOptions,
    targetOptions: body.targetOptions,
  });

  const preflight = await runWithContext(ctx, async () => {
    let linuxImage = null;
    let windowsImage = null;
    if (windows) {
      windowsImage = await findImageByName(WINDOWS_PORTER_IMAGE);
      if (!windowsImage) {
        throw new Error(`Glance image "${WINDOWS_PORTER_IMAGE}" is required for Windows clone and morph. Linux porter is never used for Windows guests.`);
      }
    } else {
      linuxImage = await findImageByName(LINUX_PORTER_IMAGE);
      if (!linuxImage) {
        throw new Error(`Glance image "${LINUX_PORTER_IMAGE}" is required for disk replication. This product does not use VIS MAAS.`);
      }
    }
    const nets = await listNetworks();
    const net = (nets || []).find((n) => n.id === body.networkId);
    if (!net) throw new Error(`Target network ${body.networkId} not found`);
    const subnets = await listSubnets({ network_id: body.networkId });
    if (!subnets.length) {
      throw new Error(`Target network "${net.name || body.networkId}" has no subnets, so Neutron cannot assign independent IPs`);
    }
    if (body.flavorId) {
      const flavors = await listFlavors();
      if (!(flavors || []).some((f) => f.id === body.flavorId)) {
        throw new Error(`Selected flavor ${body.flavorId} was not found`);
      }
    }
    return { linuxImage, windowsImage, net, subnets };
  });

  const record = {
    id: body.id || uuid(),
    name,
    srcCloudId: body.srcCloudId || null,
    srcCloudName: body.srcCloudName || 'VMware',
    sourceVmId: body.sourceVmId || null,
    guestId: body.sourceOptions?.guestId || body.guestId || '',
    guestOs: body.sourceOptions?.guestOs || body.guestOs || '',
    persistGeneration: 0,
    targetDomainProject: body.targetDomainProject || 'Default / admin',
    vms: Array.isArray(body.vms) ? body.vms : [name],
    migType: body.migType || 'live',
    strategy: body.strategy || 'auto',
    autoDeploy: body.autoDeploy !== false && body.strategy !== 'replicate_only',
    status: 'REPLICATING',
    progress: 4,
    replicationTaskIdx: 0,
    deploymentTaskIdx: 0,
    networkId: body.networkId,
    networkName: preflight.net.name || body.networkName || 'VM Network',
    flavorId: body.flavorId || '',
    volumeType: body.volumeType || '',
    linuxWorkerImage: LINUX_PORTER_IMAGE,
    windowsWorkerImage: WINDOWS_PORTER_IMAGE,
    morphWorkerImage: windows ? WINDOWS_PORTER_IMAGE : LINUX_PORTER_IMAGE,
    linuxImageId: preflight.linuxImage?.id || null,
    windowsImageId: preflight.windowsImage?.id || null,
    ipAddress: '',
    linuxWorkerIp: '',
    windowsWorkerIp: '',
    guestPortId: null,
    linuxWorkerPortId: null,
    windowsWorkerPortId: null,
    linuxWorkerId: null,
    windowsWorkerId: null,
    replicaVolumeId: null,
    bootVolumeId: null,
    snapshotId: null,
    novaServerId: null,
    nfcLeaseId: null,
    sourceOptions: body.sourceOptions || {
      os: windows ? 'windows' : 'linux',
      vcpus: windows ? 2 : 1,
      ram: windows ? '4 GiB' : '2 GiB',
      diskSize: windows ? '48 GiB' : '8 GiB',
      cbt: 'Yes',
    },
    targetOptions: {
      flavor: body.flavorName || body.targetOptions?.flavor || 'Inherited from source',
      diskBus: windows ? 'SATA (AHCI)' : 'VirtIO',
      osDistro: body.targetOptions?.osDistro || (windows ? 'Microsoft Windows Server' : 'Alma Linux 9'),
      workerImage: windows ? WINDOWS_PORTER_IMAGE : LINUX_PORTER_IMAGE,
      linuxWorkerImage: LINUX_PORTER_IMAGE,
      windowsWorkerImage: WINDOWS_PORTER_IMAGE,
      machineType: 'pc-q35',
      dhcp: optionLabel(body.targetOptions?.dhcp ?? body.dhcp, true),
      retainCreds: optionLabel(body.targetOptions?.retainCreds ?? body.retainCreds, true),
      deleteDisks: optionLabel(body.targetOptions?.deleteDisks ?? body.deleteDisks, true),
      postScriptId: String(body.targetOptions?.postScriptId || ''),
      postScriptName: String(body.targetOptions?.postScriptName || ''),
      postScript: String(body.targetOptions?.postScript || '').trim(),
    },
    context: {
      vhiBaseUrl: ctx.vhiBaseUrl,
      vhiUser: ctx.vhiUser,
      vhiPassword: ctx.vhiPassword,
      vhiProject: ctx.vhiProject,
      vhiDomain: ctx.vhiDomain,
      vhiProjectId: ctx.vhiProjectId,
    },
    logs: [],
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  };

  clearCancelled(record.id);
  record.cancelRequested = false;
  await saveMigration(record);
  appendLog(record, `Created independent Coriolis-style migration for "${name}" (${windows ? 'Windows' : 'Linux'} guest)`);
  appendLog(record, `Replication porter: ${windows ? WINDOWS_PORTER_IMAGE : LINUX_PORTER_IMAGE} (${(windows ? preflight.windowsImage : preflight.linuxImage).id}). Morphing porter: ${record.morphWorkerImage}`);
  if (windows) record.skipMorph = false;
  appendLog(record, `Target network ${record.networkName} (${record.networkId}) - guest IP will be allocated independently of porter workers`);
  await persist(record);

  setImmediate(() => tickMigrations().catch((err) => logger.error(`Migration tick after create failed: ${err.message}`)));
  return record;
}

export async function startDeployment(id) {
  const mig = await getMigrationById(id);
  if (!mig) throw new Error('Migration not found');
  if (mig.status !== 'REPLICATED' && mig.status !== 'ERROR') {
    throw new Error(`Cannot deploy from status ${mig.status}`);
  }
  if (!mig.clonedBytes) {
    throw new Error('Guest disk was never cloned from ESXi (replica is empty). Start a new migration; Retry deploy cannot invent a bootloader.');
  }
  mig.status = 'DEPLOYING';
  mig.progress = 52;
  mig.deploymentTaskIdx = 0;
  mig.lastError = null;
  appendLog(mig, 'Stage 2 cutover started: OS morphing + independent guest IP');
  await persist(mig);
  setImmediate(() => tickMigrations().catch((err) => logger.error(`Migration tick after deploy failed: ${err.message}`)));
  return mig;
}

export async function retryReplication(id) {
  const mig = await getMigrationById(id);
  if (!mig) throw new Error('Migration not found');
  clearCancelled(id);
  mig.cancelRequested = false;
  if (mig.status !== 'ERROR' && mig.status !== 'CANCELLED') {
    throw new Error('Cannot retry replication from status ' + mig.status);
  }
  if (mig.clonedBytes) {
    throw new Error('Guest disk is already cloned. Use deploy instead.');
  }
  let replicaExists = false;
  if (mig.replicaVolumeId) {
    replicaExists = await withMigContext(mig, async () => {
      const vol = await getVolume(mig.replicaVolumeId).catch(() => null);
      return !!vol;
    });
  }
  mig.status = 'REPLICATING';
  mig.progress = replicaExists ? 36 : 20;
  mig.replicationTaskIdx = replicaExists ? 6 : 3;
  mig.lastError = null;
  mig.failedTask = null;
  if (!replicaExists) {
    mig.replicaVolumeId = null;
    mig.snapshotId = null;
    appendLog(mig, usesPorterForClone(mig, isWindowsGuest)
      ? 'Replica volume missing after cancel; recreating Cinder replica before clone'
      : 'No replica volume; Glance/Cinder will create the boot disk from the converted image');
  }
  mig.migType = 'live';
  appendLog(mig, usesPorterForClone(mig, isWindowsGuest)
    ? `Retrying live disk clone via ${LINUX_PORTER_IMAGE} (source VM can stay powered on)`
    : 'Retrying live disk clone via SSH + qemu-img + Glance (source VM can stay powered on)');
  await persist(mig);
  setImmediate(() => tickMigrations().catch((err) => logger.error('Migration tick after retry clone failed: ' + err.message)));
  return mig;
}

async function runReplicationTask(mig, idx) {
  const name = vmNameOf(mig);
  const windows = isWindowsGuest(mig);
  const replicaName = `vporter-replica - ${name} 1`;

  switch (idx) {
    case 0: {
      if (mig.srcCloudId) {
        const cloud = await getCloudById(mig.srcCloudId, true);
        if (!cloud) throw new Error('Source cloud connection not found');
        appendLog(mig, `Source cloud reachable: ${cloud.host} (${cloud.name})`);
      } else {
        appendLog(mig, 'No source cloud id; skipping live ESXi probe');
      }
      return persist(mig);
    }
    case 1: {
      appendLog(mig, `Guest "${name}" os=${mig.sourceOptions?.os || (windows ? 'windows' : 'linux')} disk=${diskSizeGb(mig)}GiB`);
      return persist(mig);
    }
    case 2: {
      if (windows) {
        const winImage = await findImageByName(WINDOWS_PORTER_IMAGE);
        if (!winImage) {
          throw new Error('Glance image "' + WINDOWS_PORTER_IMAGE + '" is required for Windows OS morphing. Linux porter is never used for Windows guests.');
        }
        mig.windowsImageId = winImage.id;
        mig.skipMorph = false;
        appendLog(mig, 'Windows porter image ' + WINDOWS_PORTER_IMAGE + ' ACTIVE (' + winImage.id + ')');
      } else {
        const linuxImage = await findImageByName(LINUX_PORTER_IMAGE);
        if (!linuxImage) {
          throw new Error('Glance image "' + LINUX_PORTER_IMAGE + '" is required for Linux OS morphing. This tool does not use VIS MAAS.');
        }
        mig.linuxImageId = linuxImage.id;
        appendLog(mig, 'Linux porter image ' + LINUX_PORTER_IMAGE + ' ACTIVE (' + linuxImage.id + ')');
      }
      const nets = await listNetworks();
      const net = (nets || []).find((n) => n.id === mig.networkId);
      if (!net) throw new Error(`Target network ${mig.networkId} not found`);
      mig.networkName = net.name || mig.networkName;
      appendLog(mig, `Target network ${mig.networkName} (${mig.networkId}) verified`);
      return persist(mig);
    }
    case 3: {
      mig.replicaSizeGb = replicaSizeGb(mig);
      if (!usesPorterForClone(mig, isWindowsGuest)) {
        appendLog(mig, 'Skipping empty replica volume (' + mig.replicaSizeGb + ' GiB planned). Glance/Cinder will create the boot disk from the converted image.');
        return persist(mig);
      }
      const vol = await createVolume({
        name: replicaName,
        size: mig.replicaSizeGb,
        volume_type: mig.volumeType || undefined,
        description: `vz-bot replica for ${name}`,
        metadata: { vzbot_migration: mig.id, role: 'replica' },
      });
      await waitVolume(vol.id, ['available']);
      mig.replicaVolumeId = vol.id;
      mig.replicaSizeGb = Number(vol.size) || mig.replicaSizeGb;
      appendLog(mig, `Replica volume ${replicaName} (${vol.id}) available, size ${mig.replicaSizeGb} GiB (guest disk ${diskSizeGb(mig)} GiB)`);
      return persist(mig);
    }
    case 4: {
      if (mig.srcCloudId && mig.sourceVmId) {
        const cloud = await getCloudById(mig.srcCloudId, true);
        if (!cloud) throw new Error('Source cloud connection not found');
        const vms = await getEsxiVmInventory({
          host: cloud.host,
          port: cloud.port,
          username: cloud.user,
          password: cloud.pass,
          insecure: cloud.insecure,
        });
        const vm = (vms || []).find((item) => item.id === mig.sourceVmId || item.name === vmNameOf(mig));
        if (vm) {
          mig.firmware = vm.firmware || 'bios';
          mig.guestId = vm.guestId || mig.guestId || '';
          mig.guestOs = vm.guestOs || mig.guestOs || '';
          mig.sourceOptions = {
            ...mig.sourceOptions,
            firmware: mig.firmware,
            os: isWindowsGuest({ guestId: mig.guestId, guestOs: mig.guestOs }) ? 'windows' : 'linux',
            guestId: mig.guestId,
            guestOs: mig.guestOs,
          };
          if (vm.powerState && vm.powerState !== 'poweredOff') {
            mig.migType = 'live';
            appendLog(mig, `Live migration: source VM "${vm.name}" is ${vm.powerState}; snapshot then SSH-copy the disk so the guest can stay on`);
          } else {
            appendLog(mig, `Source VM ready for NFC export: ${vm.name} firmware=${mig.firmware} power=${vm.powerState || 'poweredOff'}`);
          }
        } else {
          appendLog(mig, `Source VM ${mig.sourceVmId} not listed; NFC export will still be attempted`);
        }
      } else {
        throw new Error('Source VM id is required to copy disk contents. Without it the replica stays empty and the guest will not boot.');
      }
      return persist(mig);
    }
          case 5: {
      if (!usesPorterForClone(mig, isWindowsGuest)) {
        appendLog(mig, (windows ? 'Windows' : 'Linux') + ' disk clone converts locally with qemu-img and fills via Glance/Cinder (no porter VM).');
        return persist(mig);
      }
      const linuxImage = await findImageByName(LINUX_PORTER_IMAGE);
      if (!linuxImage) throw new Error('Missing ' + LINUX_PORTER_IMAGE);
      mig.linuxImageId = linuxImage.id;
      appendLog(mig, 'Linux porter image ' + LINUX_PORTER_IMAGE + ' ready (' + linuxImage.id + '). Disk clone uses SSH/NFC, qemu-img, then Linux porter write onto the replica volume.');
      return persist(mig);
    }
    case 6: {
      await cloneGuestDisk(mig);
      return persist(mig);
    }
    case 7: {
      appendLog(mig, 'Released source NFC/snapshot resources');
      return persist(mig);
    }
    case 8: {
      const cloneWorkerId = mig.windowsWorkerId || mig.linuxWorkerId;
        const clonePortId = mig.windowsWorkerPortId || mig.linuxWorkerPortId;
        const cloneKind = mig.windowsWorkerId ? 'Windows' : 'Linux';
        if (cloneWorkerId) {
          await detachNamedVolume(cloneWorkerId, mig.replicaVolumeId);
          if (mig.replicaVolumeId) await waitVolume(mig.replicaVolumeId, ['available']).catch(() => {});
          await safeDeleteServer(cloneWorkerId);
        }
        if (mig.linuxWorkerId && mig.linuxWorkerId !== cloneWorkerId) await safeDeleteServer(mig.linuxWorkerId);
        await safeDeletePort(clonePortId);
        await safeDeletePort(mig.linuxWorkerPortId);
        await safeDeletePort(mig.windowsWorkerPortId);
        mig.linuxWorkerId = null;
        mig.linuxWorkerPortId = null;
        mig.windowsWorkerId = null;
        mig.windowsWorkerPortId = null;
        mig.linuxWorkerIp = '';
        mig.windowsWorkerIp = '';
        appendLog(mig, cloneKind + ' porter destroyed; replica volume ' + (mig.replicaVolumeId || '') + ' retained. Temporary worker IP released.');
      if (mig.autoDeploy) {
        mig.status = 'DEPLOYING';
        mig.progress = 52;
        mig.replicationTaskIdx = 9;
        mig.deploymentTaskIdx = 0;
      } else {
        mig.status = 'REPLICATED';
        mig.progress = 50;
        mig.replicationTaskIdx = 9;
      }
      return persist(mig);
    }
    default:
      return mig;
  }
}

async function runDeploymentTask(mig, idx) {
  const name = vmNameOf(mig);
  const windows = isWindowsGuest(mig);
  const morphImageName = windows ? WINDOWS_PORTER_IMAGE : LINUX_PORTER_IMAGE;
  const bootName = `${name}/Boot volume`;
  const snapName = `vzbot-snap-${name}-1-deploy`;

  switch (idx) {
    case 0: {
      if (windows && mig.skipMorph) {
        throw new Error(`Glance image "${WINDOWS_PORTER_IMAGE}" is required for Windows morph. Linux porter is never used for Windows guests.`);
      }
      const image = await findImageByName(morphImageName);
      if (!image) {
        if (windows) {
          throw new Error('Glance image "' + WINDOWS_PORTER_IMAGE + '" is required for Windows morph. Linux porter is never used for Windows guests.');
        }
        throw new Error(`Glance image "${morphImageName}" is required for OS morphing of this Linux guest`);
      }
      if (windows) mig.windowsImageId = image.id;
      else mig.linuxImageId = mig.linuxImageId || image.id;
      appendLog(mig, `Morphing porter verified: ${morphImageName} (${image.id})`);
      return persist(mig);
    }
    case 1: {
      if (!mig.replicaVolumeId) throw new Error('Replica volume missing');
      appendLog(mig, 'Skipping extra replica snapshot/copy; the guest boots the filled replica volume directly');
      return persist(mig);
    }
    case 2: {
      if (!mig.bootVolumeId && mig.replicaVolumeId) {
        mig.bootVolumeId = mig.replicaVolumeId;
        const marked = await ensureVolumeBootable(mig.bootVolumeId);
        appendLog(mig, `Boot volume is replica ${mig.bootVolumeId} (bootable=${marked.bootable}); skipped snapshot clone`);
      }
      if (mig.bootVolumeId) {
        await waitVolumeAvailable(mig.bootVolumeId, mig, 600000);
      } else {
        throw new Error('Replica/boot volume missing');
      }
      if (!mig.guestPortId) {
        const guestPort = await allocatePort(
          mig.networkId,
          `vzbot-guest-${shortId(mig.id)}`,
          'Independent guest IP - not shared with porter workers or VIS Coriolis'
        );
        mig.guestPortId = guestPort.id;
        mig.ipAddress = portIp(guestPort);
      }
      appendLog(mig, `Boot volume ${mig.bootVolumeId}; independent guest port ${mig.guestPortId} IP ${mig.ipAddress || '(pending DHCP)'}`);
      return persist(mig);
    }
    case 3: {
      if (mig.skipMorph || windows) {
        appendLog(mig, windows
          ? 'Skipping Windows morph porter attach. vporter-minion-windows does not run Cloudbase-Init userdata, so DISM/VirtIO inject cannot run. Guest boots SATA (AHCI) like VMware.'
          : 'Skipping morphing porter spawn');
        mig.targetOptions = { ...mig.targetOptions, diskBus: 'SATA (AHCI)' };
        return persist(mig);
      }
      const image = await findImageByName(morphImageName);
      if (!image) throw new Error(`Missing morphing image ${morphImageName}`);
      const flavors = await listFlavors();
      const minRam = windows ? 4096 : 2048;
      const flavor = pickFlavor(flavors, { minRamMb: Math.max(Number(image.min_ram) || 0, minRam), minVcpus: 2 });
      if (!flavor) throw new Error('No compute flavor available for morphing porter');
      const workerPort = await allocatePort(
        mig.networkId,
        `vzbot-${windows ? 'windows' : 'linux'}-morph-${shortId(mig.id)}`,
        'Temporary morphing porter IP - independent of guest IP'
      );
      if (windows) {
        mig.windowsWorkerPortId = workerPort.id;
        mig.windowsWorkerIp = portIp(workerPort);
      } else {
        mig.linuxWorkerPortId = workerPort.id;
        mig.linuxWorkerIp = portIp(workerPort);
      }
      const worker = await spawnPorter({
        image,
        flavor,
        portId: workerPort.id,
        name: `vzbot-${windows ? 'windows' : 'linux'}-morph-${shortId(mig.id)}`,
        volumeType: mig.volumeType,
        minDisk: windows ? 40 : 10,
      });
      if (windows) mig.windowsWorkerId = worker.id;
      else mig.linuxWorkerId = worker.id;
      const refreshed = await getPort(workerPort.id).catch(() => workerPort);
      if (windows) mig.windowsWorkerIp = portIp(refreshed) || mig.windowsWorkerIp;
      else mig.linuxWorkerIp = portIp(refreshed) || mig.linuxWorkerIp;
      await attachVolume(worker.id, mig.bootVolumeId);
      await waitVolume(mig.bootVolumeId, ['in-use']);
      appendLog(mig, `Morphing porter ${morphImageName} ${worker.id} ACTIVE; boot volume attached as secondary disk`);
      return persist(mig);
    }
    case 4: {
      if (mig.skipMorph || windows) {
        appendLog(mig, windows
          ? 'Windows OS morph inject skipped; boot bus stays SATA (AHCI) so the cloned Windows disk can find StorAHCI'
          : 'Skipping morphing');
        return persist(mig);
      }
      const workerIp = windows ? mig.windowsWorkerIp : mig.linuxWorkerIp;
      appendLog(mig, windows
        ? `Windows morphing on ${WINDOWS_PORTER_IMAGE} (${workerIp}): DISM VirtIO inject, offline registry, WinRM 5986`
        : `Linux morphing on ${LINUX_PORTER_IMAGE} (${workerIp}): virtio modules, dracut, GRUB2`);
      const postScript = String(mig.targetOptions?.postScript || '').trim();
      const postScriptName = String(mig.targetOptions?.postScriptName || '').trim();
      appendLog(mig, postScript
        ? `Post-migration script selected: ${postScriptName || 'custom'} (${windows ? 'PowerShell' : 'bash'})`
        : 'No post-migration script selected; guest will not run a user script');
      appendLog(mig, `Guest options: DHCP=${optionLabel(mig.targetOptions?.dhcp, true)}, retain credentials=${optionLabel(mig.targetOptions?.retainCreds, true)}, delete disks on VM deletion=${optionLabel(mig.targetOptions?.deleteDisks, true)}`);
      await sleep(4000);
      return persist(mig);
    }
    case 5: {
      if (mig.skipMorph && !windows) return persist(mig);
      const workerId = windows ? mig.windowsWorkerId : mig.linuxWorkerId;
      const workerPortId = windows ? mig.windowsWorkerPortId : mig.linuxWorkerPortId;
      if (workerId || (mig.bootVolumeId && windows)) {
        await releaseVolumeFromServer(workerId, mig.bootVolumeId, mig);
      }
      await safeDeletePort(workerPortId);
      if (windows) {
        mig.windowsWorkerId = null;
        mig.windowsWorkerPortId = null;
      } else {
        mig.linuxWorkerId = null;
        mig.linuxWorkerPortId = null;
      }
      appendLog(mig, `Morphing porter deleted; guest IP ${mig.ipAddress} retained`);
      return persist(mig);
    }
    case 6: {
      const flavors = await listFlavors();
      const ramGb = parseInt(mig.sourceOptions?.ram, 10) || (windows ? 4 : 2);
      const vcpus = Number(mig.sourceOptions?.vcpus) || (windows ? 2 : 1);
      const flavor = pickFlavor(flavors, {
        preferredId: mig.flavorId,
        minRamMb: ramGb * 1024,
        minVcpus: vcpus,
      });
      if (!flavor) throw new Error('No flavor matched source VM');
      mig.flavorId = flavor.id;
      mig.targetOptions = { ...mig.targetOptions, flavor: flavor.name };
      appendLog(mig, `Selected flavor ${flavor.name} (${flavor.id})`);
      return persist(mig);
    }
    case 7: {
      if (!mig.bootVolumeId) throw new Error('Boot volume missing');
      if (!mig.guestPortId) throw new Error('Guest Neutron port missing');
      if (!mig.flavorId) throw new Error('Flavor missing');
      if (mig.novaServerId) {
        appendLog(mig, `Removing previous guest ${mig.novaServerId} before firmware-aware boot`);
        await safeDeleteServer(mig.novaServerId);
        mig.novaServerId = null;
        await persist(mig);
      }
      await waitVolumeAvailable(mig.bootVolumeId, mig, 600000);
      const bootVol = await ensureVolumeBootable(mig.bootVolumeId);
      const bootStatus = String(bootVol.status || '').toLowerCase();
      if (bootStatus !== 'available') {
        throw new Error(`Boot volume ${mig.bootVolumeId} is ${bootVol.status}, must be available and bootable before Nova boot`);
      }
      mig.targetOptions = { ...mig.targetOptions, diskBus: guestDiskBus(mig) === 'sata' ? 'SATA (AHCI)' : 'VirtIO' };
      await stampBootFirmware(mig, mig.bootVolumeId);
      appendLog(mig, `Boot volume ${mig.bootVolumeId} ready: status=${bootVol.status} bootable=${bootVol.bootable} firmware=${guestFirmware(mig)}`);
      const guest = await getPort(mig.guestPortId).catch(() => null);
      mig.ipAddress = portIp(guest) || mig.ipAddress;
      const server = await createServer({
        name,
        flavorRef: mig.flavorId,
        networks: [{ port: mig.guestPortId }],
        block_device_mapping_v2: [{
          boot_index: 0,
          uuid: mig.bootVolumeId,
          source_type: 'volume',
          destination_type: 'volume',
          delete_on_termination: optionYes(mig.targetOptions?.deleteDisks, true),
          disk_bus: guestDiskBus(mig),
        }],
      });
      await waitServer(server.id, ['ACTIVE'], 300000);
      mig.novaServerId = server.id;
      mig.bootFirmwareStamped = true;
      mig.uefiBootStamped = guestFirmware(mig) === 'uefi';
      mig.stampedDiskBus = guestDiskBus(mig);
      mig.status = 'DEPLOYED';
      appendLog(mig, `Target VM ${server.id} ACTIVE with independent IP ${mig.ipAddress} firmware=${guestFirmware(mig)} bus=${mig.stampedDiskBus}`);
      return persist(mig);
    }
    case 8: {
      await safeDeleteSnapshot(mig.snapshotId);
      mig.snapshotId = null;
      mig.status = 'DEPLOYED';
      mig.progress = 100;
      mig.deploymentTaskIdx = 9;
      appendLog(mig, 'Migration complete: porter workers removed, guest keeps its own IP');
      return persist(mig);
    }
    default:
      return mig;
  }
}

async function advanceMigration(mig) {
  try {
    throwIfCancelled(mig);
    if (mig.status === 'REPLICATING') {
      const idx = Number(mig.replicationTaskIdx) || 0;
      if (idx > 8) return;
      appendLog(mig, `Replication task ${idx + 1}/9: ${REPLICATION_TASK_NAMES[idx]}`);
      await runReplicationTask(mig, idx);
      const latest = await getMigrationById(mig.id);
      if (!latest) return;
      if (latest.status === 'REPLICATING') {
        latest.replicationTaskIdx = idx + 1;
        latest.progress = Math.min(50, 6 + (idx + 1) * 5);
        await persist(latest);
      }
      return;
    }

    if (mig.status === 'DEPLOYING') {
      const idx = Number(mig.deploymentTaskIdx) || 0;
      if (idx > 8) return;
      appendLog(mig, `Deployment task ${idx + 1}/9: ${DEPLOYMENT_TASK_NAMES[idx]}`);
      await runDeploymentTask(mig, idx);
      const latest = await getMigrationById(mig.id);
      if (!latest) return;
      if (latest.status === 'DEPLOYING') {
        latest.deploymentTaskIdx = idx + 1;
        latest.progress = Math.min(99, 52 + (idx + 1) * 5);
        await persist(latest);
      }
    }
  } catch (err) {
    if (err instanceof MigrationCancelledError || /Migration cancelled/i.test(String(err.message))) return;
    const latest = (await getMigrationById(mig.id)) || mig;
    if (latest.status === 'CANCELLED' || latest.status === 'CANCELLING' || latest.cancelRequested) return;
    latest.status = 'ERROR';
    latest.lastError = err.message;
    latest.failedPhase = mig.status;
    latest.failedTask = mig.status === 'DEPLOYING'
      ? DEPLOYMENT_TASK_NAMES[Number(mig.deploymentTaskIdx) || 0]
      : REPLICATION_TASK_NAMES[Number(mig.replicationTaskIdx) || 0];
    appendLog(latest, `ERROR during ${latest.failedTask || latest.failedPhase}: ${err.message}`);
    await persist(latest);
  }
}

export async function tickMigrations() {
  if (ticking) return 0;
  ticking = true;
  const jobs = [];
  try {
    const all = await loadMigrations();
    const cancelling = all.filter((m) => m.status === 'CANCELLING');
    for (const mig of cancelling) {
      if (busy.has(mig.id)) continue;
      busy.add(mig.id);
      jobs.push((async () => {
        try {
          await cancelMigration(mig.id);
        } catch (err) {
          logger.error(`Migration ${mig.id} cancel tick failed: ${err.message}`);
        } finally {
          busy.delete(mig.id);
        }
      })());
    }
    const active = all.filter((m) =>
      (m.status === 'REPLICATING' || m.status === 'DEPLOYING')
      && !m.cancelRequested
      && !isCancelled(m.id)
    );
    const repairs = all.filter((m) => needsGuestBootRepair(m) && !m.cancelRequested && !isCancelled(m.id) && m.status !== 'CANCELLING');
    for (const mig of [...active, ...repairs]) {
      if (busy.has(mig.id)) continue;
      busy.add(mig.id);
      jobs.push((async () => {
        try {
          await withMigContext(mig, () => {
            if (mig.status === 'REPLICATING' || mig.status === 'DEPLOYING') return advanceMigration(mig);
            return rebuildGuestBoot(mig);
          });
        } catch (err) {
          if (err instanceof MigrationCancelledError || /Migration cancelled/i.test(String(err.message))) return;
          logger.error(`Migration ${mig.id} tick failed: ${err.message}`);
          try {
            if (mig.status === 'CANCELLED' || mig.status === 'CANCELLING' || mig.cancelRequested) return;
            mig.status = 'ERROR';
            mig.lastError = err.message;
            appendLog(mig, `ERROR: ${err.message}`);
            await persist(mig);
          } catch (_) {}
        } finally {
          busy.delete(mig.id);
        }
      })());
    }
  } finally {
    ticking = false;
  }
  await Promise.all(jobs);
  return jobs.length;
}


export async function cancelMigration(id) {
  const mig = await getMigrationById(id);
  if (!mig) throw new Error('Migration not found');
  if (mig.status === 'CANCELLED') return mig;
  markCancelled(id);
  const keepTarget = !!(mig.cancelKeepTarget || mig.status === 'DEPLOYED' || mig.status === 'ACTIVE');
  mig.cancelKeepTarget = keepTarget;
  mig.cancelRequested = true;
  mig.status = 'CANCELLING';
  appendLog(mig, 'Cancel requested: stopping clone, porter VMs, NFC, and transfer volumes');
  await persist(mig);
  abortInFlightClone(id);
  await cleanupMigrationResources(id, { keepTarget });
  const latest = (await getMigrationById(id)) || mig;
  latest.cancelRequested = true;
  latest.cancelKeepTarget = keepTarget;
  latest.linuxWorkerId = null;
  latest.windowsWorkerId = null;
  latest.linuxWorkerPortId = null;
  latest.windowsWorkerPortId = null;
  latest.linuxWorkerIp = '';
  latest.windowsWorkerIp = '';
  latest.nfcLeaseId = null;
  if (!keepTarget) {
    latest.status = 'CANCELLED';
    latest.lastError = 'Cancelled by user';
    latest.novaServerId = null;
    latest.guestPortId = null;
    latest.bootVolumeId = null;
    latest.replicaVolumeId = null;
    latest.snapshotId = null;
    latest.clonedBytes = 0;
    latest.replicationTaskIdx = 0;
    latest.deploymentTaskIdx = 0;
    latest.progress = 0;
  } else {
    latest.status = 'DEPLOYED';
  }
  appendLog(latest, keepTarget
    ? 'Cancelled leftover transfer resources; deployed guest kept'
    : 'Migration cancelled. Porter VMs, replica disks, and incomplete guest resources removed.');
  await persist(latest);
  return latest;
}

export async function cleanupMigrationResources(id, { keepTarget = true } = {}) {
  const mig = await getMigrationById(id);
  if (!mig) {
    removeCloneFiles(id);
    return;
  }
  const deployed = mig.status === 'DEPLOYED' || mig.status === 'ACTIVE';
  removeCloneFiles(id);

  const run = async () => {
    await safeDeleteServer(mig.linuxWorkerId);
    await safeDeleteServer(mig.windowsWorkerId);
    await safeDeletePort(mig.linuxWorkerPortId);
    await safeDeletePort(mig.windowsWorkerPortId);
    await safeDeleteSnapshot(mig.snapshotId);
    if (!keepTarget || !deployed) {
      await safeDeleteServer(mig.novaServerId);
      await safeDeletePort(mig.guestPortId);
      await safeDeleteVolume(mig.bootVolumeId);
    }
    if (!deployed) await safeDeleteVolume(mig.replicaVolumeId);
  };

  if (mig.context?.vhiPassword) {
    await runWithContext(mig.context, run);
  }
}
