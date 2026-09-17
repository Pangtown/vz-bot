/**
 * Clone a VMware disk onto a Cinder replica.
 *
 * vporter-minion-linux does not ship qemu-img, and Glance PUT of multi-GB
 * VMDKs fails on this cluster. Convert with the local Windows qemu-img,
 * then have the guest-matching porter write the raw image onto the replica volume.
 * Linux guests use vporter-minion-linux. Windows guests use vporter-minion-windows only.
 */

import { createReadStream, existsSync, statSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { throwIfCancelled, isCancelled } from './migration-cancel.js';
import { copyLiveDiskOverSsh } from './esxi-client.js';
import { PorterScriptNotStartedError, convertedRawPath, findExistingRaw, fillReplicaFromConvertedRaw, markRawComplete } from './windows-replica-fill.js';

const cloneBlobs = new Map();
const inflight = new Map();

export function abortInFlightClone(id) {
  const rec = inflight.get(id);
  if (rec?.qemuChild) try { rec.qemuChild.kill(); } catch (_) {}
  if (rec?.nfcStream) try { rec.nfcStream.destroy(new Error('Migration cancelled')); } catch (_) {}
  if (rec?.sshStream) try { rec.sshStream.destroy(new Error('Migration cancelled')); } catch (_) {}
  inflight.delete(id);
  clearCloneBlob(id);
}

export function formatBytes(n) {
  const num = Number(n) || 0;
  if (num >= 1024 * 1024 * 1024) return `${(num / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  return `${(num / 1024 / 1024).toFixed(1)} MiB`;
}

export function getCloneBlob(id, token) {
  const rec = cloneBlobs.get(id);
  if (!rec || !token || rec.token !== token) return null;
  return rec;
}

export function clearCloneBlob(id, { keepRaw = true } = {}) {
  const rec = cloneBlobs.get(id);
  cloneBlobs.delete(id);
  if (rec?.vmdk) try { unlinkSync(rec.vmdk); } catch (_) {}
  if (!keepRaw && rec?.path) try { unlinkSync(rec.path); } catch (_) {}
}

async function sleepCancel(mig, ms, sleep) {
  const step = 400;
  let left = ms;
  while (left > 0) {
    throwIfCancelled(mig);
    const chunk = Math.min(step, left);
    await sleep(chunk);
    left -= chunk;
  }
}

function clonePublicBases() {
  return String(process.env.CLONE_PUBLIC_URL || process.env.VZBOT_PUBLIC_URL || '')
    .split(/[\s,]+/)
    .map((base) => base.replace(/\/$/, ''))
    .filter(Boolean);
}

function clonePublicFetchUrls(migrationId, token, kind = 'clone-blob') {
  return clonePublicBases().map((base) => (
    `${base}/api/vhi/migrations/${encodeURIComponent(migrationId)}/${kind}?token=${token}`
  ));
}

function qemuImgExists(bin) {
  if (!bin) return Promise.resolve(false);
  if (bin.includes('/') || bin.includes('\\')) {
    if (!existsSync(bin)) return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const r = spawn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    r.on('error', () => resolve(false));
    r.on('close', (code) => resolve(code === 0));
  });
}

async function resolveQemuImg() {
  const candidates = [
    process.env.QEMU_IMG,
    'C:/Files/Tools/qemuing/qemu-img.exe',
    'C:/Users/Mike/Downloads/qemuing/qemu-img.exe',
    join(process.env.ProgramFiles || 'C:/Program Files', 'qemu', 'qemu-img.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'qemu', 'qemu-img.exe'),
    'qemu-img.exe',
    'qemu-img',
  ].filter(Boolean);
  for (const bin of candidates) {
    if (await qemuImgExists(bin)) return bin;
  }
  return null;
}

function runQemuConvert(qemu, src, dest, onProgress, migId) {
  return new Promise((resolve, reject) => {
    const child = spawn(qemu, ['convert', '-p', '-f', 'vmdk', '-O', 'raw', src, dest], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const prev = inflight.get(migId) || {};
    inflight.set(migId, { ...prev, qemuChild: child });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => {
      err += s;
      const m = String(s).match(/(\d+(?:\.\d+)?)\s*\/\s*100/);
      if (m && onProgress) onProgress(Number(m[1]));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`qemu-img convert failed (${code}): ${err.slice(-400)}`));
    });
  });
}

export function buildPorterDdUserData({ urls }) {
  const urlsB64 = Buffer.from((urls || []).join('\n'), 'utf8').toString('base64');
  const script = [
    '#!/bin/bash',
    'set -eu',
    'clog() { echo "$1"; echo "$1" > /dev/console 2>/dev/null || true; }',
    'clog VZBOT_CLONE_START',
    `URLS=$(printf '%s' '${urlsB64}' | base64 -d 2>/dev/null || printf '%s' '${urlsB64}' | base64 --decode)`,
    'TARGET=""',
    'for d in /dev/vdb /dev/sdb /dev/nvme1n1 /dev/vdc /dev/sdc; do',
    '  [ -b "$d" ] || continue',
    '  TARGET="$d"',
    '  break',
    'done',
    'if [ -z "$TARGET" ]; then',
    '  for i in $(seq 1 90); do',
    '    for d in /dev/vdb /dev/sdb /dev/nvme1n1; do',
    '      [ -b "$d" ] || continue',
    '      TARGET="$d"',
    '      break 2',
    '    done',
    '    sleep 2',
    '  done',
    'fi',
    'if [ ! -b "$TARGET" ]; then',
    '  clog "VZBOT_CLONE_FAIL missing replica disk"',
    '  lsblk -o NAME,SIZE,TYPE || true',
    '  exit 1',
    'fi',
    'clog "VZBOT_CLONE_TARGET $TARGET"',
    'if ! command -v curl >/dev/null 2>&1; then',
    '  clog "VZBOT_CLONE_FAIL curl missing on porter image"',
    '  exit 1',
    'fi',
    'OK=0',
    'while IFS= read -r u; do',
    '  [ -n "$u" ] || continue',
    '  clog "VZBOT_CLONE_FETCH $u"',
    '  if curl -f -L --retry 3 --retry-delay 4 -o "$TARGET" -w "VZBOT_CLONE_DOWNLOADED %{size_download}\\n" "$u"; then',
    '    OK=1',
    '    break',
    '  fi',
    '  clog "VZBOT_CLONE_FETCH_FAIL $u"',
    'done <<EOF',
    '$URLS',
    'EOF',
    'if [ "$OK" -ne 1 ]; then',
    '  clog "VZBOT_CLONE_FAIL porter could not download converted disk from vz-bot HTTP"',
    '  exit 1',
    'fi',
    'sync',
    'clog VZBOT_CLONE_OK',
  ].join('\n');
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return [
    '#cloud-config',
    'package_update: false',
    'write_files:',
    '  - path: /usr/local/bin/vzbot-clone.sh',
    '    encoding: b64',
    "    permissions: '0755'",
    `    content: ${b64}`,
    'runcmd:',
    '  - [ /usr/local/bin/vzbot-clone.sh ]',
  ].join('\n');
}

export function buildWindowsPorterCloneUserData({ urls, progressUrls }) {
  const quote = (u) => String(u).replace(/'/g, "''");
  const blobPs = (urls || []).map(quote).filter(Boolean).map((u) => "  '" + u + "'").join(",\r\n");
  const progPs = (progressUrls || []).map(quote).filter(Boolean).map((u) => "  '" + u + "'").join(",\r\n");
  // Cloudbase-Init on vporter-minion-windows runs #ps1_sysnative only.
  // Linux cloud-config runcmd is ignored, and Nova console is empty unless we write COM1.
  const ps1 = [
    '$ErrorActionPreference = "Continue"',
    '[Net.ServicePointManager]::Expect100Continue = $false',
    '$script:progressUrls = @(',
    progPs || "  ''",
    ')',
    '$script:blobUrls = @(',
    blobPs || "  ''",
    ')',
    'function Serial([string]$m) {',
    '  Write-Output $m',
    "  try { cmd.exe /c ('echo ' + $m + '>COM1') | Out-Null } catch {}",
    "  try { Add-Content -Path 'C:\\vzbot-clone.log' -Value $m -Encoding ASCII } catch {}",
    '}',
    'function Report([string]$event, [int64]$bytes = 0) {',
    '  Serial $event',
    '  $safe = [string]$event',
    '  if ($safe.Length -gt 180) { $safe = $safe.Substring(0, 180) }',
    "  $safe = $safe.Replace('\"', '').Replace('\\', '/')",
    '  $json = (\'{"event":"\' + $safe + \'","bytes":\' + $bytes + \'}\')',
    '  $sent = $false',
    '  foreach ($u in $script:progressUrls) {',
    '    if (-not $u) { continue }',
    '    try {',
    '      curl.exe -sS -m 20 -X POST -H "Content-Type: application/json" --data-binary $json $u | Out-Null',
    '      if ($LASTEXITCODE -eq 0) { $sent = $true }',
    '    } catch {}',
    '    if ($sent) { continue }',
    '    try {',
    '      $req = [Net.HttpWebRequest]::Create($u)',
    '      $req.Method = "POST"',
    '      $req.Timeout = 20000',
    '      $req.ContentType = "application/json"',
    '      $payload = [Text.Encoding]::UTF8.GetBytes($json)',
    '      $req.ContentLength = $payload.Length',
    '      $rs = $req.GetRequestStream(); $rs.Write($payload, 0, $payload.Length); $rs.Close()',
    '      $resp = $req.GetResponse(); $resp.Close()',
    '      $sent = $true',
    '    } catch {}',
    '  }',
    '  return $sent',
    '}',
    '$heard = $false',
    'for ($i = 0; $i -lt 90; $i++) {',
    '  if (Report "VZBOT_CLONE_START" 0) { $heard = $true; break }',
    '  Start-Sleep -Seconds 4',
    '}',
    'if (-not $heard) { Serial "VZBOT_CLONE_START still trying HTTP heartbeat" }',
    '$diskNo = $null',
    'for ($i = 0; $i -lt 120; $i++) {',
    '  $list = "list disk"',
    '  $out = $list | diskpart.exe 2>&1 | Out-String',
    '  if ($out -match "Disk\\s+1") { $diskNo = 1; break }',
    '  Report "VZBOT_CLONE_WAIT_DISK" 0 | Out-Null',
    '  Start-Sleep -Seconds 3',
    '}',
    'if ($null -eq $diskNo) { Report "VZBOT_CLONE_FAIL missing replica disk" 0 | Out-Null; exit 1 }',
    '$prep = "select disk 1`r`noffline disk`r`nattributes disk clear readonly"',
    '$prep | diskpart.exe | Out-Null',
    '$dest = "\\\\.\\PhysicalDrive1"',
    'Report ("VZBOT_CLONE_TARGET " + $dest) 0 | Out-Null',
    '$cloneOk = $false',
    '$total = [int64]0',
    'foreach ($u in $script:blobUrls) {',
    '  if (-not $u) { continue }',
    '  Report ("VZBOT_CLONE_FETCH " + $u) 0 | Out-Null',
    '  try {',
    '    $req = [Net.HttpWebRequest]::Create($u)',
    '    $req.Method = "GET"',
    '    $req.Timeout = 7200000',
    '    $req.ReadWriteTimeout = 7200000',
    '    $req.AllowAutoRedirect = $true',
    '    $resp = $req.GetResponse()',
    '    $src = $resp.GetResponseStream()',
    '    $file = New-Object IO.FileStream($dest, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Write)',
    '    $buf = New-Object byte[] 4194304',
    '    $total = [int64]0',
    '    while (($n = $src.Read($buf, 0, $buf.Length)) -gt 0) {',
    '      $file.Write($buf, 0, $n)',
    '      $total += $n',
    '      if (($total -shr 26) -ne (($total - $n) -shr 26)) { Report "VZBOT_CLONE_DOWNLOADED" $total | Out-Null }',
    '    }',
    '    $file.Flush(); $file.Dispose(); $src.Dispose(); $resp.Close()',
    '    Report "VZBOT_CLONE_DOWNLOADED" $total | Out-Null',
    '    $cloneOk = $true',
    '    break',
    '  } catch {',
    '    Report ("VZBOT_CLONE_FETCH_FAIL " + $u + " " + $_.Exception.Message) 0 | Out-Null',
    '  }',
    '}',
    'if (-not $cloneOk) { Report "VZBOT_CLONE_FAIL porter could not download converted disk from vz-bot HTTP" 0 | Out-Null; exit 1 }',
    'Report "VZBOT_CLONE_OK" $total | Out-Null',
  ].join("\r\n");
  return "#ps1_sysnative\r\n" + ps1 + "\r\n";
}

export function getCloneStatus(id) {
  return cloneBlobs.get(id) || null;
}

export async function waitForPorterClone(mig, serverId, ctx) {
  const { getConsoleOutput, appendLog, persist, sleep } = ctx;
  const timeoutMs = ctx.timeoutMs || 3 * 60 * 60 * 1000;
  const start = Date.now();
  let sawStart = false;
  let lastBytes = 0;
  let lastConsole = '';
  while (Date.now() - start < timeoutMs) {
    throwIfCancelled(mig);
    const rec = cloneBlobs.get(mig.id);
    if (rec?.scriptFail) throw new Error(rec.scriptFail);
    const httpBytes = Number(rec?.reportedBytes || 0);
    if (rec?.scriptStarted) sawStart = true;
    if (httpBytes > lastBytes) {
      lastBytes = httpBytes;
      mig.replicatedBytes = formatBytes(lastBytes);
      const elapsedSec = Math.max(1, (Date.now() - start) / 1000);
      mig.replicationSpeed = `${(lastBytes / 1024 / 1024 / elapsedSec).toFixed(1)} MiB/s`;
    }
    const size = Number(rec?.size || 0);
    if (rec?.scriptOk) {
      mig.clonedBytes = lastBytes || size || 1;
      mig.replicatedBytes = formatBytes(mig.clonedBytes);
      const elapsedSec = Math.max(1, Math.round((Date.now() - start) / 1000));
      const mins = Math.floor(elapsedSec / 60);
      const secs = elapsedSec % 60;
      mig.duration = mins ? `${mins} minute${mins === 1 ? '' : 's'}, ${secs} seconds` : `${secs} seconds`;
      appendLog(mig, `Porter clone finished (${mig.replicatedBytes}, ${mig.duration})`);
      await persist(mig);
      return { bytes: mig.clonedBytes };
    }
    let output = '';
    try {
      output = await getConsoleOutput(serverId, 8000);
    } catch (err) {
      const msg = String(err.message || '');
      if (/404|could not be found/i.test(msg)) {
        throwIfCancelled(mig);
        if (ctx.windows) {
          appendLog(mig, 'Windows porter console unavailable (Cloudbase-Init boot/reboot). Waiting...');
          await persist(mig);
          await sleepCancel(mig, 15000, sleep);
          continue;
        }
        throw new Error(`Clone porter ${serverId} disappeared during clone: ${msg}`);
      }
      appendLog(mig, `Porter console not ready yet: ${msg}`);
      await persist(mig);
      await sleepCancel(mig, 8000, sleep);
      continue;
    }
    lastConsole = String(output || '');
    if (/VZBOT_CLONE_START/.test(lastConsole)) sawStart = true;
    const downloaded = lastConsole.match(/VZBOT_CLONE_DOWNLOADED\s+(\d+)/);
    if (downloaded) {
      lastBytes = Number(downloaded[1]) || lastBytes;
      mig.replicatedBytes = formatBytes(lastBytes);
      const elapsedSec = Math.max(1, (Date.now() - start) / 1000);
      mig.replicationSpeed = `${(lastBytes / 1024 / 1024 / elapsedSec).toFixed(1)} MiB/s`;
    }
    if (/VZBOT_CLONE_FAIL/.test(lastConsole)) {
      const fail = (lastConsole.match(/VZBOT_CLONE_FAIL[^\n]*/g) || []).pop();
      throw new Error(fail || 'Porter clone script failed');
    }
    if (/VZBOT_CLONE_OK/.test(lastConsole)) {
      mig.clonedBytes = lastBytes || 1;
      mig.replicatedBytes = lastBytes ? formatBytes(lastBytes) : (mig.replicatedBytes || 'cloned');
      const elapsedSec = Math.max(1, Math.round((Date.now() - start) / 1000));
      const mins = Math.floor(elapsedSec / 60);
      const secs = elapsedSec % 60;
      mig.duration = mins ? `${mins} minute${mins === 1 ? '' : 's'}, ${secs} seconds` : `${secs} seconds`;
      appendLog(mig, `Porter clone finished (${mig.replicatedBytes}, ${mig.duration})`);
      await persist(mig);
      return { bytes: mig.clonedBytes };
    }
    const tail = lastConsole.trim().split(/\n/).slice(-3).join(' | ');
    const via = rec?.scriptStarted ? 'heartbeat' : 'console';
    appendLog(mig, sawStart
      ? `Porter clone in progress via ${via}${lastBytes ? ' ' + formatBytes(lastBytes) : ''}${tail ? ': ' + tail.slice(0, 120) : ''}`
      : `Waiting for ${ctx.windows ? 'Windows' : 'Linux'} porter clone script (console ${lastConsole ? 'has output' : 'empty'})`);
    await persist(mig);
    const startLimit = ctx.windows ? 2 * 60 * 1000 : 15 * 60 * 1000;
    if (!sawStart && Date.now() - start > startLimit) {
      throw new (ctx.windows ? PorterScriptNotStartedError : Error)(`${ctx.windows ? 'Windows' : 'Linux'} porter did not start the clone script in time. Console: ${lastConsole.slice(-400) || '(empty)'}. No HTTP download/heartbeat from the porter.`);
    }
    await sleepCancel(mig, 8000, sleep);
  }
  throw new Error(`Porter clone timed out. Console: ${lastConsole.slice(-400) || '(empty)'}`);
}

export async function cloneGuestDisk(mig, ctx) {
  const {
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
    completeHttpNfcLease,
    abortHttpNfcLease,
    ensureVolumeBootable,
    getConsoleOutput,
    sleep,
  } = ctx;

  if (!mig.srcCloudId || !mig.sourceVmId) {
    throw new Error('Source cloud and VM id are required to copy the guest disk. The replica is otherwise empty and will not boot.');
  }
  if (!mig.replicaVolumeId) {
    throw new Error('Replica volume is missing; cannot clone onto an empty disk');
  }
  const cloud = await getCloudById(mig.srcCloudId, true);
  if (!cloud) throw new Error('Source cloud connection not found');

  const windows = typeof isWindowsGuest === 'function' ? !!isWindowsGuest(mig) : String(mig?.sourceOptions?.os || '').toLowerCase() === 'windows';
  const porterImageName = windows ? WINDOWS_PORTER_IMAGE : LINUX_PORTER_IMAGE;
  if (windows && !WINDOWS_PORTER_IMAGE) throw new Error('Windows porter image name is not configured');
  const porterImage = await findImageByName(porterImageName);
  if (!porterImage) {
    throw new Error(windows
      ? `Glance image "${WINDOWS_PORTER_IMAGE}" is required for Windows disk replication. Linux porter is never used for Windows guests.`
      : `Glance image "${LINUX_PORTER_IMAGE}" is required for disk replication`);
  }
  const flavors = await listFlavors();
  const flavor = pickFlavor(flavors, { minRamMb: windows ? 4096 : 2048, minVcpus: windows ? 2 : 1 });
  if (!flavor) throw new Error(`No compute flavor available for the ${windows ? 'Windows' : 'Linux'} clone porter`);

  const leftoverIds = windows
    ? [mig.windowsWorkerId, mig.linuxWorkerId]
    : [mig.linuxWorkerId];
  for (const leftover of leftoverIds.filter(Boolean)) {
    appendLog(mig, `Cleaning leftover porter ${leftover} before clone`);
    await detachNamedVolume(leftover, mig.replicaVolumeId);
    await safeDeleteServer(leftover);
  }
  mig.linuxWorkerId = null;
  mig.windowsWorkerId = windows ? null : mig.windowsWorkerId;
  if (windows && mig.linuxWorkerPortId) {
    await safeDeletePort(mig.linuxWorkerPortId);
    mig.linuxWorkerPortId = null;
    mig.linuxWorkerIp = '';
  }
  const workerPortId = windows ? mig.windowsWorkerPortId : mig.linuxWorkerPortId;
  if (workerPortId) {
    await safeDeletePort(workerPortId);
  }
  if (windows) {
    mig.windowsWorkerPortId = null;
    mig.windowsWorkerIp = '';
  } else {
    mig.linuxWorkerPortId = null;
    mig.linuxWorkerIp = '';
  }
  await waitVolume(mig.replicaVolumeId, ['available']).catch(() => {});

  const firmware = guestFirmware(mig);
  const diskBus = guestDiskBus(mig);
  mig.firmware = firmware;
  mig.diskBus = diskBus;
  mig.targetOptions = { ...mig.targetOptions, diskBus: diskBus === 'sata' ? 'SATA (AHCI)' : 'VirtIO' };

  const existingRaw = findExistingRaw(mig.id);
  const vmdk = join(tmpdir(), `vzbot-nfc-${mig.id}.vmdk`);
  const raw = existingRaw || convertedRawPath(mig.id);
  let lease = null;
  let reusedRaw = !!existingRaw;
  let rawSt = existingRaw ? statSync(raw) : null;
  try {
    if (reusedRaw) {
      appendLog(mig, `Reusing converted raw disk ${formatBytes(rawSt.size)} at ${raw} (skipping NFC + qemu-img)`);
      mig.convertedRawPath = raw;
      await persist(mig);
    } else {
    const live = String(mig.migType || 'live').toLowerCase() !== 'cold';
    let lastLog = 0;
    let lastPersist = 0;
    const expected = Math.max(
      256 * 1024 * 1024,
      (Number(mig.replicaSizeGb) || parseInt(String(mig.sourceOptions?.diskSize || '10'), 10) || 10) * 1024 * 1024 * 1024
    );
    if (live) {
      appendLog(mig, `Live SSH disk copy from ${cloud.host} VM ${mig.sourceVmId} (snapshot + vmkfstools, not NFC)`);
      await persist(mig);
      await copyLiveDiskOverSsh({
        host: cloud.host,
        port: cloud.port,
        sshPort: cloud.sshPort || 22,
        username: cloud.user,
        password: cloud.pass,
        insecure: cloud.insecure,
        vmId: mig.sourceVmId,
        destPath: raw,
        shouldAbort: () => isCancelled(mig.id) || mig.cancelRequested,
        onAbortStream: (stream) => {
          const prev = inflight.get(mig.id) || {};
          inflight.set(mig.id, { ...prev, sshStream: stream });
        },
        onProgress: (bytes) => {
          throwIfCancelled(mig);
          const now = Date.now();
          mig.replicatedBytes = formatBytes(bytes);
          mig.progress = Math.min(48, 36 + Math.floor((bytes / expected) * 12));
          if (now - lastPersist >= 3000) {
            lastPersist = now;
            void persist(mig);
          }
          if (now - lastLog < 15000) return;
          lastLog = now;
          appendLog(mig, `SSH disk copy ${formatBytes(bytes)}`);
        },
      });
      rawSt = statSync(raw);
      if (!rawSt.size || rawSt.size < 1024) throw new Error('SSH disk copy produced an empty raw disk');
      appendLog(mig, `SSH disk copy complete: ${formatBytes(rawSt.size)}`);
      await persist(mig);
    } else {
    const qemu = await resolveQemuImg();
    if (!qemu) {
      throw new Error('qemu-img is missing on the porter image and was not found on this Windows host. Install QEMU (qemu-img.exe) or set QEMU_IMG.');
    }
    appendLog(mig, `Cold NFC export from ${cloud.host} VM ${mig.sourceVmId}, then local qemu-img convert (${qemu})`);
    await persist(mig);
    lease = await acquireHttpNfcLease({
      host: cloud.host,
      port: cloud.port,
      username: cloud.user,
      password: cloud.pass,
      insecure: cloud.insecure,
      vmId: mig.sourceVmId,
      live: false,
    });
    const disk = lease.disks[0];
    if (!disk?.url) throw new Error('NFC lease has no disk URL');
    mig.nfcLeaseId = lease.leaseId || null;
    appendLog(mig, `NFC lease ready: ${disk.url}`);
    await persist(mig);
    await downloadNfcDisk(lease, vmdk, {
      shouldAbort: () => isCancelled(mig.id) || mig.cancelRequested,
      onAbortStream: (stream) => {
        const prev = inflight.get(mig.id) || {};
        inflight.set(mig.id, { ...prev, nfcStream: stream });
      },
      onProgress: (bytes) => {
        throwIfCancelled(mig);
        const now = Date.now();
        mig.replicatedBytes = formatBytes(bytes);
        mig.progress = Math.min(48, 36 + Math.floor((bytes / expected) * 12));
        if (now - lastPersist >= 3000) {
          lastPersist = now;
          void persist(mig);
        }
        if (now - lastLog < 15000) return;
        lastLog = now;
        appendLog(mig, `NFC download ${formatBytes(bytes)}`);
      },
    });
    await completeHttpNfcLease(lease);
    lease = null;
    const vmdkSt = statSync(vmdk);
    if (!vmdkSt.size || vmdkSt.size < 1024) throw new Error('NFC download produced an empty VMDK');
    appendLog(mig, `NFC download complete: ${formatBytes(vmdkSt.size)}. Converting VMDK to raw...`);
    await persist(mig);

    throwIfCancelled(mig);
    await runQemuConvert(qemu, vmdk, raw, (pct) => {
      throwIfCancelled(mig);
      if (Date.now() - lastLog < 8000) return;
      lastLog = Date.now();
      mig.progress = Math.min(49, 46 + Math.floor(Number(pct) / 50));
      appendLog(mig, `qemu-img convert ${pct.toFixed(0)}%`);
      void persist(mig);
    }, mig.id);
    rawSt = statSync(raw);
    if (!rawSt.size || rawSt.size < 1024) throw new Error('qemu-img produced an empty raw disk');
    try { unlinkSync(vmdk); } catch (_) {}
    } // cold NFC+qemu
    } // not reusedRaw

    mig.convertedRawPath = raw;
    mig.convertedRawBytes = rawSt.size;
    markRawComplete(raw, rawSt.size);

    const token = randomBytes(16).toString('hex');
    cloneBlobs.set(mig.id, { token, path: raw, size: rawSt.size, bytesSent: 0, reportedBytes: 0, scriptStarted: false, scriptOk: false, scriptFail: '' });
    const urls = clonePublicFetchUrls(mig.id, token, 'clone-blob');
    const progressUrls = clonePublicFetchUrls(mig.id, token, 'clone-progress');

    if (!urls.length) {
      appendLog(mig, `Converted raw disk ${formatBytes(rawSt.size)}. Filling replica via Glance/Cinder from vz-bot (set CLONE_PUBLIC_URL if a porter on VHI should HTTP-download the disk).`);
      await persist(mig);
      await fillReplicaFromConvertedRaw(mig, raw, {
        ...ctx,
        clonePublicUrls: urls,
      });
      appendLog(mig, `Replica volume ${mig.replicaVolumeId} filled (${formatBytes(rawSt.size)}, firmware=${firmware}, bus=${diskBus})`);
      await persist(mig);
      return;
    }

    appendLog(mig, `Converted raw disk ${formatBytes(rawSt.size)}. Porter will download from CLONE_PUBLIC_URL`);
    await persist(mig);

    const porterPort = await allocatePort(
      mig.networkId,
      `vzbot-${windows ? 'windows' : 'linux'}-clone-${shortId(mig.id)}`,
      `${windows ? 'Windows' : 'Linux'} porter clone IP - independent of guest`
    );
    if (windows) {
      mig.windowsWorkerPortId = porterPort.id;
      mig.windowsWorkerIp = portIp(porterPort);
    } else {
      mig.linuxWorkerPortId = porterPort.id;
      mig.linuxWorkerIp = portIp(porterPort);
    }
    const userData = windows ? buildWindowsPorterCloneUserData({ urls, progressUrls }) : buildPorterDdUserData({ urls });
    const workerIp = windows ? mig.windowsWorkerIp : mig.linuxWorkerIp;
    appendLog(mig, `Spawning ${porterImageName} at ${workerIp || 'dhcp'} with replica ${mig.replicaVolumeId} attached${windows ? ' (Cloudbase-Init #ps1_sysnative, HTTP heartbeat, COM1 log)' : ''}`);
    await persist(mig);

    const porter = await spawnPorter({
      image: porterImage,
      flavor,
      portId: porterPort.id,
      name: `vzbot-${windows ? 'windows' : 'linux'}-clone-${shortId(mig.id)}`,
      volumeType: mig.volumeType,
      minDisk: windows ? 40 : 10,
      replicaVolumeId: mig.replicaVolumeId,
      userData,
    });
    if (windows) mig.windowsWorkerId = porter.id;
    else mig.linuxWorkerId = porter.id;
    const refreshed = await getPort(porterPort.id).catch(() => porterPort);
    if (windows) mig.windowsWorkerIp = portIp(refreshed) || mig.windowsWorkerIp;
    else mig.linuxWorkerIp = portIp(refreshed) || mig.linuxWorkerIp;
    appendLog(mig, `${windows ? 'Windows' : 'Linux'} porter ${porter.id} ACTIVE at ${(windows ? mig.windowsWorkerIp : mig.linuxWorkerIp) || 'dhcp'}; writing raw disk onto replica`);
    await persist(mig);

    try {
      await waitForPorterClone(mig, porter.id, { getConsoleOutput, appendLog, persist, sleep, windows });
    } catch (err) {
      if (windows && err instanceof PorterScriptNotStartedError) {
        appendLog(mig, err.message);
        await fillReplicaFromConvertedRaw(mig, raw, {
          ...ctx,
          clonePublicUrls: urls,
        });
        appendLog(mig, `Replica volume ${mig.replicaVolumeId} filled (${formatBytes(rawSt.size)}, firmware=${firmware}, bus=${diskBus})`);
        await persist(mig);
        return;
      }
      throw err;
    }

    await detachNamedVolume(porter.id, mig.replicaVolumeId);
    await waitVolume(mig.replicaVolumeId, ['available']);
    await ensureVolumeBootable(mig.replicaVolumeId);
    if (!mig.clonedBytes) mig.clonedBytes = rawSt.size;
    mig.replicatedBytes = mig.replicatedBytes || formatBytes(rawSt.size);
    appendLog(mig, `Replica volume ${mig.replicaVolumeId} filled (${mig.replicatedBytes}, firmware=${firmware}, bus=${diskBus})`);
    await persist(mig);
  } catch (err) {
    if (lease) await abortHttpNfcLease(lease);
    throw err;
  } finally {
    clearCloneBlob(mig.id, { keepRaw: true });
  }
}

export async function handleCloneBlob(req, res, id, fullUrl) {
  let token = '';
  try {
    token = new URL(fullUrl, 'http://localhost').searchParams.get('token') || '';
  } catch (_) {}
  const rec = getCloneBlob(id, token);
  if (!rec) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Clone blob not found' }));
    return;
  }
  rec.bytesSent = 0;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(rec.size),
  });
  const stream = createReadStream(rec.path);
  stream.on('data', (chunk) => {
    rec.bytesSent += chunk.length;
    rec.lastProgressAt = Date.now();
  });
  stream.on('end', () => { rec.finishedAt = Date.now(); });
  stream.pipe(res);
}

export async function handleCloneProgress(req, res, id, fullUrl) {
  let token = '';
  try {
    token = new URL(fullUrl, 'http://localhost').searchParams.get('token') || '';
  } catch (_) {}
  const rec = cloneBlobs.get(id);
  if (!rec || rec.token !== token) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Clone progress not found' }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { body = {}; }
  const event = String(body.event || body.message || '');
  rec.scriptStarted = true;
  rec.lastEvent = event;
  rec.lastProgressAt = Date.now();
  rec.reportedBytes = Number(body.bytes) || rec.reportedBytes || 0;
  if (/VZBOT_CLONE_OK/.test(event)) rec.scriptOk = true;
  if (/VZBOT_CLONE_FAIL/.test(event)) rec.scriptFail = event;
  res.writeHead(204);
  res.end();
}