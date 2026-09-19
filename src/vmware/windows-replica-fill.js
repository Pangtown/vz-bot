/**
 * Fill a Cinder replica from a converted disk without the porter VM.
 * Used for Windows guests, and for Linux guests when CLONE_PUBLIC_URL is unset.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { throwIfCancelled } from './migration-cancel.js';
import { loadMigrations } from './cloud-storage.js';
import { logger } from '../utils/index.js';

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

const IN_FLIGHT_CLONE_STATUSES = new Set(['REPLICATING', 'DEPLOYING', 'CANCELLING']);
const RETRYABLE_CLONE_STATUSES = new Set(['REPLICATING', 'DEPLOYING', 'CANCELLING', 'ERROR', 'CANCELLED']);

function cloneTempPaths(prefix) {
  const names = ['.raw', '.raw.ok', '.raw.gz', '.qcow2', '.qcow2.ok', '.vmdk'];
  const dirs = [tmpdir(), process.env.TEMP || '', process.env.TMP || ''].filter(Boolean);
  const out = [];
  for (const dir of dirs) {
    for (const ext of names) out.push(join(dir, 'vzbot-nfc-' + prefix + ext));
  }
  return out;
}

function tryUnlink(filePath) {
  try {
    const st = statSync(filePath);
    unlinkSync(filePath);
    return { files: 1, bytes: Number(st.size) || 0 };
  } catch (_) {
    return { files: 0, bytes: 0 };
  }
}

function cloneIdFromFilename(name) {
  const n = String(name || '');
  if (/\.qcow2\.ok$/i.test(n)) return n.slice(0, -9);
  if (/\.raw\.gz\.ok$/i.test(n)) return n.slice(0, -10);
  if (/\.raw\.ok$/i.test(n)) return n.slice(0, -7);
  if (/\.raw\.gz$/i.test(n)) return n.slice(0, -7);
  if (/\.qcow2$/i.test(n)) return n.slice(0, -6);
  if (/\.raw$/i.test(n)) return n.slice(0, -4);
  if (/\.vmdk$/i.test(n)) return n.slice(0, -5);
  if (/\.ok$/i.test(n)) return n.replace(/\.ok$/i, '');
  return n;
}

export function removeCloneFiles(id) {
  const prefix = String(id || '').trim();
  if (!prefix) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const add = (r) => { files += r.files; bytes += r.bytes; };
  try {
    const dir = cloneStoreDir();
    for (const name of readdirSync(dir)) {
      if (name === prefix || name.startsWith(prefix + '.') || name.startsWith(prefix + '-')) {
        add(tryUnlink(join(dir, name)));
      }
    }
  } catch (_) {}
  const seen = new Set();
  for (const p of cloneTempPaths(prefix)) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    add(tryUnlink(p));
  }
  return { files, bytes };
}

export function removeIncompleteCloneFiles(id) {
  const prefix = String(id || '').trim();
  if (!prefix) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const add = (r) => { files += r.files; bytes += r.bytes; };
  const consider = (filePath) => {
    if (!filePath || !existsSync(filePath)) return;
    if (/\.ok$/i.test(filePath)) return;
    if (/\.vmdk$/i.test(filePath) || !rawLooksComplete(filePath)) {
      add(tryUnlink(filePath));
      add(tryUnlink(String(filePath) + '.ok'));
    }
  };
  try {
    const dir = cloneStoreDir();
    for (const name of readdirSync(dir)) {
      if (name === prefix || name.startsWith(prefix + '.') || name.startsWith(prefix + '-')) {
        consider(join(dir, name));
      }
    }
  } catch (_) {}
  const seen = new Set();
  for (const p of cloneTempPaths(prefix)) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    consider(p);
  }
  return { files, bytes };
}

export function sweepIdleCloneFiles(keepIds) {
  const keep = new Set((keepIds || []).map(String).filter(Boolean));
  let files = 0;
  let bytes = 0;
  let names = [];
  try {
    names = readdirSync(cloneStoreDir());
  } catch (_) {
    return { files: 0, bytes: 0 };
  }
  const seen = new Set();
  for (const name of names) {
    const id = cloneIdFromFilename(name);
    if (!id || keep.has(id) || seen.has(id)) continue;
    seen.add(id);
    const r = removeCloneFiles(id);
    files += r.files;
    bytes += r.bytes;
  }
  return { files, bytes };
}

export async function sweepIdleCloneStore({ keepRetryable = true } = {}) {
  const keepStatuses = keepRetryable ? RETRYABLE_CLONE_STATUSES : IN_FLIGHT_CLONE_STATUSES;
  const migs = await loadMigrations();
  const keepIds = migs
    .filter((m) => keepStatuses.has(String(m.status || '').toUpperCase()))
    .map((m) => m.id);
  const result = sweepIdleCloneFiles(keepIds);
  if (result.files) {
    logger.info('Clone cache cleanup: removed ' + result.files + ' file(s) (' + formatBytes(result.bytes) + ')');
  }
  return result;
}

export function convertedRawPath(id) {
  return join(cloneStoreDir(), String(id) + '.raw');
}

export function convertedQcowPath(id) {
  return join(cloneStoreDir(), String(id) + '.qcow2');
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

export function findExistingClone(id, prefer = 'qcow2') {
  const qcow = convertedQcowPath(id);
  const qcowReady = rawLooksComplete(qcow);
  const raw = findExistingRaw(id);
  if (prefer === 'raw') {
    if (raw) return { path: raw, format: 'raw' };
    if (qcowReady) return { path: qcow, format: 'qcow2' };
    return null;
  }
  if (qcowReady) return { path: qcow, format: 'qcow2' };
  if (raw) return { path: raw, format: 'raw' };
  return null;
}

async function destroyClonePorter(mig, ctx) {
  const { detachNamedVolume, safeDeleteServer, safeDeletePort, waitVolume, appendLog, persist } = ctx;
  for (const key of ['windowsWorkerId', 'linuxWorkerId']) {
    const porterId = mig[key];
    if (!porterId) continue;
    appendLog(mig, 'Stopping clone porter ' + porterId + ' so the replica can be filled from vz-bot');
    if (mig.replicaVolumeId) await detachNamedVolume(porterId, mig.replicaVolumeId);
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
    if (fmtOut === 'qcow2') args.push('-c');
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

function qemuVirtualSizeBytes(qemu, src) {
  return new Promise((resolve) => {
    const child = spawn(qemu, ['info', '--output=json', src], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => { out += s; });
    child.on('error', () => resolve(0));
    child.on('close', (code) => {
      if (code !== 0) return resolve(0);
      try {
        const info = JSON.parse(out);
        const n = Number(info['virtual-size'] || info.virtual_size || 0);
        resolve(Number.isFinite(n) && n > 0 ? n : 0);
      } catch (_) {
        resolve(0);
      }
    });
  });
}

async function maybeCompressForGlance(rawPath, mig, appendLog, persist) {
  const srcSt = statSync(rawPath);
  if (/\.qcow2$/i.test(String(rawPath))) {
    return { path: rawPath, format: 'qcow2', size: srcSt.size };
  }
  const qemu = await resolveQemuImg();
  if (!qemu) return { path: rawPath, format: 'raw', size: srcSt.size };
  const qcow = String(rawPath).replace(/\.raw$/i, '.qcow2');
  appendLog(mig, 'Converting raw to compressed qcow2 so Glance upload skips empty space (' + formatBytes(srcSt.size) + ' raw)');
  await persist(mig);
  await qemuConvert(qemu, rawPath, qcow, 'raw', 'qcow2');
  const qSt = statSync(qcow);
  if (qSt.size > 0) {
    appendLog(mig, 'qcow2 is ' + formatBytes(qSt.size) + ' vs raw ' + formatBytes(srcSt.size) + '; uploading qcow2');
    await persist(mig);
    try { unlinkSync(rawPath); } catch (_) {}
    try { unlinkSync(String(rawPath) + '.ok'); } catch (_) {}
    markRawComplete(qcow, qSt.size);
    return { path: qcow, format: 'qcow2', size: qSt.size };
  }
  appendLog(mig, 'qcow2 convert produced an empty file; uploading raw');
  try { unlinkSync(qcow); } catch (_) {}
  return { path: rawPath, format: 'raw', size: srcSt.size };
}

function gbFromBytes(n) {
  return Math.max(1, Math.ceil((Number(n) || 0) / (1024 * 1024 * 1024)));
}

function virtualSizeGb(mig, filePath, fileSize) {
  const fromMig = Math.max(
    Number(mig.replicaSizeGb) || 0,
    parseInt(String(mig.sourceOptions && mig.sourceOptions.diskSize || '0'), 10) || 0
  );
  const fromFile = gbFromBytes(fileSize);
  if (/\.qcow2$/i.test(String(filePath))) return Math.max(1, fromMig);
  return Math.max(1, fromFile, fromMig);
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
    throw new Error('Converted disk is missing or incomplete; cannot fill the replica');
  }
  const rawSt = statSync(rawPath);
  let liveSize = 0;
  if (mig.replicaVolumeId && typeof ctx.getVolume === 'function') {
    const cur = await ctx.getVolume(mig.replicaVolumeId).catch(() => null);
    liveSize = Number(cur && cur.size) || 0;
  }
  let qemuGb = 0;
  const qemu = await resolveQemuImg();
  if (qemu) {
    const virtBytes = await qemuVirtualSizeBytes(qemu, rawPath);
    if (virtBytes) qemuGb = gbFromBytes(virtBytes);
  }
  const volSize = Math.max(virtualSizeGb(mig, rawPath, rawSt.size), liveSize, qemuGb);
  if (qemuGb) {
    appendLog(mig, 'Replica size from qemu-img virtual size: ' + qemuGb + ' GiB');
  }
  const fromMig = Math.max(
    Number(mig.replicaSizeGb) || 0,
    parseInt(String(mig.sourceOptions && mig.sourceOptions.diskSize || '0'), 10) || 0
  );
  if (/\.qcow2$/i.test(String(rawPath)) && !qemuGb && !fromMig && !liveSize) {
    throw new Error('Could not determine qcow2 virtual size; qemu-img info failed and replica/disk size is missing');
  }
  const firmware = typeof guestFirmware === 'function' ? guestFirmware(mig) : (mig.firmware || 'uefi');

  await destroyClonePorter(mig, ctx);
  throwIfCancelled(mig);

  const imageName = 'vzbot-clone-' + (typeof shortId === 'function' ? shortId(mig.id) : String(mig.id).slice(0, 8));
  appendLog(mig, 'Filling replica from converted disk via Glance/Cinder (' + formatBytes(rawSt.size) + '). vz-bot uploads to VHI; no porter VM is used for this clone.');
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
  appendLog(mig, 'Glance image ' + img.id + ' queued (' + imageName + ', ' + upload.format + ', ' + volSize + ' GiB min disk)');

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
    description: 'vz-bot replica filled from converted disk (Glance)',
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
      appendLog(mig, 'Deleted empty porter replica ' + oldReplica);
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
  const cleaned = removeCloneFiles(mig.id);
  if (cleaned.files) {
    appendLog(mig, 'Removed local clone cache (' + cleaned.files + ' file(s), ' + formatBytes(cleaned.bytes) + ')');
  }
  await persist(mig);
}

