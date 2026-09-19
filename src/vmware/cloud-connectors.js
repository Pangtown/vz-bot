/**
 * Connection tests for source clouds other than VMware (VHI, Hyper-V).
 */
import net from 'net';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runWithContext } from '../gateway/context.js';
import { getToken } from '../vhi/identity.js';
import { listServers } from '../vhi/compute.js';
import { listVolumes } from '../vhi/block.js';
import { registerInsecureHost } from '../utils/tls.js';

const HYPERV_WINRM_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'hyperv-winrm.ps1');

function normalizeHttpBase(host) {
  let base = String(host || '').trim();
  if (!base) return '';
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/$/, '');
}

function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: Number(port), timeout: timeoutMs }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function runHyperVScript(action, extraEnv = {}, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File',
      HYPERV_WINRM_SCRIPT,
    ], {
      env: { ...process.env, ...extraEnv, VZBOT_HV_ACTION: action },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, out, err: err || 'WinRM request timed out' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

function hyperVHint(message, port, hostname) {
  const msg = String(message || '');
  if (/TrustedHosts/i.test(msg)) {
    return msg + ` On this vz-bot PC run (elevated PowerShell): Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value ${hostname} -Concatenate -Force`;
  }
  if (/Access is denied|AccessDenied|401|logon failure|user name or password/i.test(msg)) {
    return 'WinRM answered but the account was rejected. Use a local admin on the Hyper-V host (HOST\\user or .\\user for workgroup).';
  }
  if (/Hyper-V/i.test(msg) && /module|not found|is not installed/i.test(msg)) {
    return 'The Hyper-V PowerShell module is missing on the host. Install the Hyper-V role, then retry.';
  }
  if (/SSL|certificate|trust/i.test(msg) && Number(port) === 5986) {
    return 'HTTPS WinRM needs a certificate, or turn on Disable SSL checks. HTTP WinRM on 5985 is often easier.';
  }
  return msg;
}

function hyperVTarget({ host, port, user, pass }) {
  const hostname = String(host || '').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  const requested = Number(port) || 5986;
  return { hostname, requested, user, pass };
}

function hyperVEnv(hostname, port, user, pass, useSsl) {
  return {
    VZBOT_HV_HOST: hostname,
    VZBOT_HV_PORT: String(port),
    VZBOT_HV_USER: user,
    VZBOT_HV_PASS: pass,
    VZBOT_HV_SSL: useSsl ? '1' : '0',
  };
}

async function resolveHyperVPort(hostname, requested) {
  const httpsOpen = await tcpProbe(hostname, 5986);
  const httpOpen = await tcpProbe(hostname, 5985);
  if (await tcpProbe(hostname, requested)) return { port: requested, httpsOpen, httpOpen };
  if (requested === 5986 && httpOpen) return { port: 5985, httpsOpen, httpOpen };
  if (requested === 5985 && httpsOpen) return { port: 5986, httpsOpen, httpOpen };
  return {
    error: [
      `Nothing is listening on ${hostname}:${requested}.`,
      httpsOpen ? 'HTTPS WinRM (5986) is open — set the port to 5986.' : 'HTTPS WinRM (5986) is closed.',
      httpOpen ? 'HTTP WinRM (5985) is open — set the port to 5985.' : 'HTTP WinRM (5985) is closed.',
      'On the Hyper-V host (elevated PowerShell): Enable-PSRemoting -Force; winrm quickconfig',
    ].join(' '),
  };
}

function parseHyperVFail(combined, fallback) {
  return ((combined.match(/VZBOT_HV_FAIL\s+([\s\S]+)/) || [])[1] || fallback || 'WinRM request failed').trim();
}

function parseHyperVVmList(combined) {
  const block = combined.match(/VZBOT_HV_VMS_BEGIN\s*([\s\S]*?)\s*VZBOT_HV_VMS_END/);
  if (!block) throw new Error(parseHyperVFail(combined, 'Hyper-V did not return a VM list'));
  const raw = String(block[1] || '').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : (parsed.vms || []);
  return (Array.isArray(rows) ? rows : []).map((vm) => {
    const vcpus = Number(vm.vcpus) || 1;
    const ramMb = Number(vm.ramMb) || 1024;
    const disks = Array.isArray(vm.disks) ? vm.disks : [];
    const ramStr = ramMb >= 1024 ? `${Math.round(ramMb / 1024)} GB RAM` : `${ramMb} MB RAM`;
    return {
      id: String(vm.id || vm.name || '').replace(/[{}]/g, ''),
      name: vm.name || 'Unnamed VM',
      powerState: vm.powerState === 'poweredOn' ? 'poweredOn' : 'poweredOff',
      vcpus,
      ramMb,
      spec: vm.spec || `${vcpus} vCPU${vcpus > 1 ? 's' : ''} / ${ramStr}`,
      disksCount: Number(vm.disksCount) || disks.length || 1,
      disks: disks.length ? disks : [{ label: 'Hard disk 1', capacityGb: 20, thinProvisioned: true, backingFileName: '' }],
      networks: Array.isArray(vm.networks) ? vm.networks : [],
      guestOs: vm.guestOs || 'Hyper-V guest',
      firmware: vm.firmware === 'uefi' ? 'uefi' : 'bios',
      guestId: vm.guestId || '',
    };
  });
}

export async function testVhiConnection({
  host,
  port,
  user,
  pass,
  insecure = true,
  project = 'admin',
  domain = 'Default',
}) {
  const base = normalizeHttpBase(host);
  if (!base || !user || !pass) {
    return { ok: false, error: 'VHI URL, username, and password are required.' };
  }
  if (insecure !== false) registerInsecureHost(base);

  try {
    const result = await runWithContext({
      vhiBaseUrl: base,
      vhiUser: user,
      vhiPassword: pass,
      vhiProject: project || 'admin',
      vhiDomain: domain || 'Default',
      vhiIdentityPort: port ? String(port) : '',
    }, async () => {
      const tok = await getToken();
      let vmCount = 0;
      try {
        const servers = await listServers();
        vmCount = Array.isArray(servers) ? servers.length : 0;
      } catch (_) {}
      return { projectId: tok.projectId, vmCount };
    });

    return {
      ok: true,
      serverInfo: {
        apiType: 'VHI',
        fullName: 'Virtuozzo Infrastructure',
        name: new URL(base).hostname,
        apiVersion: '7',
      },
      projectId: result.projectId || null,
      vmCount: result.vmCount,
    };
  } catch (err) {
    return { ok: false, error: err.message || 'VHI authentication failed' };
  }
}

export async function testHyperVConnection({
  host,
  port,
  user,
  pass,
  insecure = true,
}) {
  const { hostname, requested } = hyperVTarget({ host, port, user, pass });
  if (!hostname || !user || !pass) {
    return { ok: false, error: 'Hyper-V host, username, and password are required.' };
  }

  const resolved = await resolveHyperVPort(hostname, requested);
  if (resolved.error) return { ok: false, error: resolved.error };
  const activePort = resolved.port;
  const useSsl = activePort === 5986;
  if (useSsl && insecure !== false) registerInsecureHost(`https://${hostname}:${activePort}`);

  const ps = await runHyperVScript('test', hyperVEnv(hostname, activePort, user, pass, useSsl));
  const combined = `${ps.out}\n${ps.err}`;
  if (/VZBOT_HV_OK/.test(combined)) {
    return {
      ok: true,
      serverInfo: {
        apiType: 'HyperV',
        fullName: `Microsoft Hyper-V (WinRM ${useSsl ? 'HTTPS' : 'HTTP'} ${activePort})`,
        name: hostname,
        apiVersion: String(activePort),
      },
      usedPort: activePort,
    };
  }

  const hint = hyperVHint(parseHyperVFail(combined, ps.err || ps.out), activePort, hostname);
  const switched = activePort !== requested
    ? `Port ${requested} was closed; tried ${activePort}. `
    : '';
  return { ok: false, error: switched + hint };
}

export async function listHyperVCloudVms(cloud) {
  const { hostname, requested, user, pass } = hyperVTarget(cloud);
  if (!hostname || !user || !pass) {
    throw new Error('Hyper-V host, username, and password are required.');
  }
  const resolved = await resolveHyperVPort(hostname, requested);
  if (resolved.error) throw new Error(resolved.error);
  const activePort = resolved.port;
  const useSsl = activePort === 5986;
  if (useSsl && cloud.insecure !== false) registerInsecureHost(`https://${hostname}:${activePort}`);

  const ps = await runHyperVScript('list', hyperVEnv(hostname, activePort, user, pass, useSsl), 90000);
  const combined = `${ps.out}\n${ps.err}`;
  try {
    return parseHyperVVmList(combined);
  } catch (err) {
    throw new Error(hyperVHint(err.message, activePort, hostname));
  }
}

export async function listVhiCloudVms(cloud) {
  const base = normalizeHttpBase(cloud.host);
  if (cloud.insecure !== false) registerInsecureHost(base);
  return runWithContext({
    vhiBaseUrl: base,
    vhiUser: cloud.user,
    vhiPassword: cloud.pass,
    vhiProject: cloud.project || 'admin',
    vhiDomain: cloud.domain || 'Default',
    vhiIdentityPort: cloud.port ? String(cloud.port) : '',
  }, async () => {
    const servers = await listServers();
    let volumes = [];
    try {
      volumes = await listVolumes();
    } catch (_) {
      volumes = [];
    }
    const volById = new Map((volumes || []).map((v) => [v.id, v]));
    return (servers || []).map((s) => {
      const vcpus = Number(s.flavor?.vcpus) || 1;
      const ramMb = Number(s.flavor?.ram) || 1024;
      const ramStr = ramMb >= 1024 ? `${Math.round(ramMb / 1024)} GB RAM` : `${ramMb} MB RAM`;
      const addresses = s.addresses && typeof s.addresses === 'object' ? s.addresses : {};
      const networks = Object.keys(addresses).map((netName) => {
        const first = Array.isArray(addresses[netName]) ? addresses[netName][0] : null;
        return {
          label: netName,
          networkName: netName,
          macAddress: (first && (first['OS-EXT-IPS-MAC:mac_addr'] || first.mac_addr)) || '',
        };
      });
      const attached = Array.isArray(s['os-extended-volumes:volumes_attached'])
        ? s['os-extended-volumes:volumes_attached']
        : [];
      const disks = attached.map((item, idx) => {
        const vol = volById.get(item.id) || {};
        return {
          label: vol.name || `Disk ${idx + 1}`,
          capacityGb: Number(vol.size) || 0,
          volumeId: item.id,
          volumeType: vol.volume_type || '',
        };
      });
      return {
        id: s.id,
        name: s.name,
        guestOs: s.metadata?.os_distro || s.image?.name || '',
        powerState: s.status || '',
        vcpus,
        ramMb,
        spec: `${vcpus} vCPU${vcpus > 1 ? 's' : ''} / ${ramStr}`,
        disksCount: disks.length || 1,
        disks: disks.length ? disks : [{ label: 'Boot disk', capacityGb: 0, volumeId: '', volumeType: '' }],
        networks,
        firmware: String(s.image?.hw_firmware_type || s.metadata?.hw_firmware_type || 'bios').toLowerCase().includes('uefi') ? 'uefi' : 'bios',
        guestId: '',
      };
    });
  });
}
