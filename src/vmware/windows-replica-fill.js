/**
 * Fill a Cinder replica from a converted raw disk without the porter VM.
 * Used when vporter-minion-windows does not run Cloudbase-Init userdata.
 * Never uses the Linux porter.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { throwIfCancelled } from './migration-cancel.js';

export class PorterScriptNotStartedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PorterScriptNotStartedError';
  }
}

const CLONE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'clones');

function formatBytes(n) {
  const num = Number(n) || 0;
  if (num >= 1024 * 1024 * 1024) return (num / 1024 / 1024 / 1024).toFixed(2) + ' GiB';
  return (num / 1024 / 1024).toFixed(1) + ' MiB';
}

export function cloneStoreDir() {
  mkdirSync(CLONE_DIR, { recursive: true });
  return CLONE_DIR;
}

export function convertedRawPath(id) {
  return join(cloneStoreDir(), String(id) + '.raw');
}

export function markRawComplete(path, size) {
  writeFileSync(String(path) + '.ok', String(size), 'utf8');
}

export function rawLooksComplete(path, expectedBytes) {
  try {
    const st = statSync(path);
    if (!st.size) return false;
    let expected = Number(expectedBytes) || 0;
    try {
      const marked = Number(readFileSync(String(path) + '.ok', 'utf8').trim());
      if (Number.isFinite(marked) && marked > 0) expected = marked;
    } catch (_) {}
    if (expected > 0) return st.size === expected;
    return false;
  } catch (_) {
    return false;
  }
}

export function findExistingRaw(id) {
  const canonical = convertedRawPath(id);
  if (rawLooksComplete(canonical)) return canonical;
  const temps = [
    join(tmpdir(), 'vzbot-nfc-' + id + '.raw'),
    join(process.env.TEMP || '', 'vzbot-nfc-' + id + '.raw'),
    join(process.env.TMP || '', 'vzbot-nfc-' + id + '.raw'),
  ].filter(Boolean);
  for (const tmp of temps) {
    if (!tmp || tmp === canonical) continue;
    if (!rawLooksComplete(tmp)) continue;
    try {
      mkdirSync(dirname(canonical), { recursive: true });
      renameSync(tmp, canonical);
      return canonical;
    } catch (_) {
      return tmp;
    }
  }
  return null;
}

async function destroyClonePorter(mig, ctx) {
  const { detachNamedVolume, safeDeleteServer, safeDeletePort, waitVolume, appendLog, persist } = ctx;
  for (const key of ['windowsWorkerId', 'linuxWorkerId']) {
    const porterId = mig[key];
    if (!porterId) continue;
    appendLog(mig, 'Stopping clone porter ' + porterId + ' so the replica can be filled from vz-bot');
    await detachNamedVolume(porterId, mig.replicaVolumeId);
    await safeDeleteServer(porterId);
    mig[key] = null;
  }
  if (mig.windowsWorkerPortId) {
    await safeDeletePort(mig.windowsWorkerPortId);
    mig.windowsWorkerPortId = null;
    mig.windowsWorkerIp = '';
  }
  if (mig.linuxWorkerPortId) {
    await safeDeletePort(mig.linuxWorkerPortId);
    mig.linuxWorkerPortId = null;
    mig.linuxWorkerIp = '';
  }
  if (mig.replicaVolumeId) await waitVolume(mig.replicaVolumeId, ['available']).catch(() => {});
  await persist(mig);
}

/**
 * Upload converted raw to Glance, create a Cinder volume from that image, swap replica.
 */

async function resolveQemuImg() {
  const candidates = [
    process.env.QEMU_IMG,
    'C:/Files/Tools/qemuing/qemu-img.exe',
    join(process.env.ProgramFiles || 'C:/Program Files', 'qemu', 'qemu-img.exe'),
    'qemu-img.exe',
    'qemu-img',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      if (bin && existsSync(bin)) return bin;
    } catch (_) {}
  }
  return candidates.find((bin) => bin === 'qemu-img' || bin === 'qemu-img.exe') || null;
}

function qemuConvert(qemu, src, dest, fmtIn, fmtOut) {
  return new Promise((resolve, reject) => {
    const args = ['convert', '-p'];
    if (fmtIn) args.push('-f', fmtIn);
    args.push('-O', fmtOut, src, dest);
    const child = spawn(qemu, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => { err += s; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('qemu-img convert failed (' + code + '): ' + err.slice(-400)));
    });
  });
}

async function maybeCompressForGlance(rawPath, mig, appendLog, persist) {
  const rawSt = statSync(rawPath);
  const qemu = await resolveQemuImg();
  if (!qemu) return { path: rawPath, format: 'raw', size: rawSt.size };
  const qcow = String(rawPath).replace(/\.raw$/i, '.qcow2');
  appendLog(mig, 'Converting raw to sparse qcow2 so Glance upload skips empty space (' + formatBytes(rawSt.size) + ' raw)');
  await persist(mig);
  await qemuConvert(qemu, rawPath, qcow, 'raw', 'qcow2');
  const qSt = statSync(qcow);
  if (qSt.size > 0 && qSt.size < rawSt.size * 0.85) {
    appendLog(mig, 'qcow2 is ' + formatBytes(qSt.size) + ' vs raw ' + formatBytes(rawSt.size) + '; uploading qcow2');
    await persist(mig);
    return { path: qcow, format: 'qcow2', size: qSt.size };
  }
  appendLog(mig, 'qcow2 not smaller than raw; uploading raw');
  return { path: rawPath, format: 'raw', size: rawSt.size };
}

export async function fillReplicaFromConvertedRaw(mig, rawPath, ctx) {
  const {
    appendLog,
    persist,
    waitVolume,
    createImage,
    uploadImageData,
    importImageFromUrl,
    waitImage,
    deleteImage,
    createVolume,
    deleteVolume,
    ensureVolumeBootable,
    guestFirmware,
    shortId,
    sleep,
  } = ctx;

  if (!rawLooksComplete(rawPath, Number(mig.convertedRawBytes) || undefined)) {
    throw new Error('Converted raw disk is missing or incomplete; cannot fill the replica without NFC');
  }
  const rawSt = statSync(rawPath);
  const sizeGb = Math.max(1, Math.ceil(rawSt.size / (1024 * 1024 * 1024)));
  let liveSize = 0;
  if (mig.replicaVolumeId && typeof ctx.getVolume === 'function') {
    const cur = await ctx.getVolume(mig.replicaVolumeId).catch(() => null);
    liveSize = Number(cur && cur.size) || 0;
  }
  const volSize = Math.max(sizeGb, sizeGb + 1, liveSize, Number(mig.replicaSizeGb) || 0, parseInt(String(mig.sourceOptions && mig.sourceOptions.diskSize || '0'), 10) || 0);
  const firmware = typeof guestFirmware === 'function' ? guestFirmware(mig) : (mig.firmware || 'uefi');

  await destroyClonePorter(mig, ctx);
  throwIfCancelled(mig);

  const imageName = 'vzbot-clone-' + (typeof shortId === 'function' ? shortId(mig.id) : String(mig.id).slice(0, 8));
  appendLog(mig, 'Filling replica from converted raw via Glance/Cinder (' + formatBytes(rawSt.size) + '). vz-bot uploads to VHI; the porter does not pull from this host.');
  await persist(mig);

  const upload = await maybeCompressForGlance(rawPath, mig, appendLog, persist);
  const img = await createImage({
    name: imageName,
    disk_format: upload.format,
    container_format: 'bare',
    min_disk: volSize,
    hw_firmware_type: firmware,
  });
  if (!img?.id) throw new Error('Glance createImage returned no id');
  mig.cloneImageId = img.id;
  await persist(mig);
  appendLog(mig, 'Glance image ' + img.id + ' queued (' + imageName + ', raw, ' + volSize + ' GiB min disk)');

  let imported = false;
  const publicUrls = Array.isArray(ctx.clonePublicUrls) ? ctx.clonePublicUrls.filter(Boolean) : [];
  if (typeof importImageFromUrl === 'function' && publicUrls[0]) {
    try {
      throwIfCancelled(mig);
      appendLog(mig, 'Asking Glance to web-download the converted disk from CLONE_PUBLIC_URL');
      await importImageFromUrl(img.id, publicUrls[0]);
      imported = true;
    } catch (err) {
      appendLog(mig, 'Glance web-download not available (' + err.message + '); uploading from vz-bot instead');
    }
  }

  if (!imported) {
    throwIfCancelled(mig);
    appendLog(mig, 'Uploading ' + upload.format + ' to Glance (' + formatBytes(upload.size) + ')');
    const stream = createReadStream(upload.path);
    let sent = 0;
    let last = 0;
    stream.on('data', (chunk) => {
      sent += chunk.length;
      const now = Date.now();
      if (now - last < 15000) return;
      last = now;
      mig.replicatedBytes = formatBytes(sent);
      mig.progress = Math.min(48, 36 + Math.floor((sent / upload.size) * 12));
      appendLog(mig, 'Glance upload ' + formatBytes(sent) + ' / ' + formatBytes(upload.size));
      void persist(mig);
    });
    await uploadImageData(img.id, stream, upload.size);
  }

  throwIfCancelled(mig);
  appendLog(mig, 'Waiting for Glance image ' + img.id + ' to become ACTIVE');
  await waitImage(img.id, ['active'], 2 * 60 * 60 * 1000);
  appendLog(mig, 'Glance image ACTIVE. Creating Cinder replica from image (Cinder copies onto ' + volSize + ' GiB)');
  await persist(mig);

  const oldReplica = mig.replicaVolumeId;
  const vol = await createVolume({
    name: 'vporter-replica - ' + String(mig.name || 'guest') + ' 1',
    size: volSize,
    volume_type: mig.volumeType || undefined,
    imageRef: img.id,
    description: 'vz-bot Windows replica filled from converted raw (Glance)',
    metadata: { vzbot_migration: mig.id, role: 'replica' },
  });
  if (!vol?.id) throw new Error('Cinder createVolume from Glance image returned no id');
  appendLog(mig, 'Cinder volume ' + vol.id + ' creating from image ' + img.id);
  await persist(mig);
  const filled = await waitVolume(vol.id, ['available'], 2 * 60 * 60 * 1000);
  mig.replicaVolumeId = filled.id || vol.id;
  mig.replicaSizeGb = Number(filled.size) || volSize;
  mig.clonedBytes = rawSt.size;
  mig.replicatedBytes = formatBytes(rawSt.size);
  mig.cloneImageId = img.id;
  await persist(mig);
  appendLog(mig, 'Replica volume ' + mig.replicaVolumeId + ' available, filled from Glance (' + formatBytes(rawSt.size) + ')');

  if (oldReplica && oldReplica !== mig.replicaVolumeId) {
    try {
      await deleteVolume(oldReplica);
      appendLog(mig, 'Deleted empty Windows porter replica ' + oldReplica);
    } catch (err) {
      appendLog(mig, 'Could not delete old replica ' + oldReplica + ': ' + err.message);
    }
  }
  try {
    await deleteImage(img.id);
    mig.cloneImageId = null;
    appendLog(mig, 'Deleted temporary Glance clone image ' + img.id);
  } catch (err) {
    appendLog(mig, 'Could not delete Glance clone image ' + img.id + ': ' + err.message);
  }
  await ensureVolumeBootable(mig.replicaVolumeId);
  await persist(mig);
}

export function keepConvertedRawOnCancel() {
  return true;
}

