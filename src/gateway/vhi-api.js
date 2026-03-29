/**
 * VHI Dashboard API handler
 * Handles all /api/vhi/* requests, injecting per-request credentials via runWithContext.
 */

import { runWithContext } from './context.js';
import { listServers, getServer, serverAction, startServer, stopServer, rebootServer, deleteServer, createServer, listFlavors, getVncConsole, listInterfaces, attachInterface, detachInterface } from '../vhi/compute.js';
import { listNetworks, listSubnets, listPorts, getPort, updatePort, deletePort, listSecurityGroups } from '../vhi/network.js';
import { listVolumes, getVolume, listVolumeTypes, attachVolume, detachVolume, createVolume, deleteVolume, extendVolume, retypeVolume, updateVolume, listSnapshots, createSnapshot, deleteSnapshot, revertSnapshot, uploadVolumeToImage } from '../vhi/block.js';
import { listImages } from '../vhi/image.js';
import { getToken, listProjects, listUsers } from '../vhi/identity.js';
import { getLastHealth, getLastBilling } from './scheduler.js';
import * as healthPoller from '../monitoring/health-poller.js';
import * as billingStorage from '../monitoring/billing-storage.js';
import { searchEvents } from '../monitoring/audit-storage.js';
import { runAuditPoll } from '../monitoring/audit-poller.js';
import { searchAlerts } from '../monitoring/alert-storage.js';
import { runAlertPoll } from '../monitoring/alert-poller.js';
import { loadGlobalSshConfig, saveGlobalSshConfig, normalizeUrl } from '../monitoring/ssh-storage.js';

// ── helpers ────────────────────────────────────────────────────────────────

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let buf = '';
  for await (const chunk of req) buf += chunk;
  return buf ? JSON.parse(buf) : {};
}

/**
 * Extract VHI credentials from request headers.
 * The browser sends them as X-VHI-* headers (set at login time).
 */
function extractContext(req) {
  const rawBase = req.headers['x-vhi-base-url'] || process.env.VHI_BASE_URL || '';
  return {
    vhiBaseUrl:     normalizeUrl(rawBase),
    vhiUser:        req.headers['x-vhi-user']          || process.env.VHI_USER            || '',
    vhiPassword:    req.headers['x-vhi-password']      || process.env.VHI_PASSWORD         || '',
    vhiProject:     req.headers['x-vhi-project']       || process.env.VHI_PROJECT_NAME     || 'admin',
    vhiDomain:      req.headers['x-vhi-domain']        || process.env.VHI_DOMAIN_NAME      || 'Default',
    vhiProjectId:   req.headers['x-vhi-project-id']   || process.env.VHI_PROJECT_ID       || '',
    vhiSshHost:     req.headers['x-vhi-ssh-host']     || process.env.VHI_SSH_HOST         || '',
    vhiSshUser:     req.headers['x-vhi-ssh-user']     || process.env.VHI_SSH_USER         || 'root',
    vhiSshPassword: req.headers['x-vhi-ssh-password'] || process.env.VHI_SSH_PASSWORD     || '',
  };
}

// ── route handlers ─────────────────────────────────────────────────────────

/** POST /api/vhi/auth  – verify credentials, return token & project info */
async function handleAuth(req, res) {
  const body = await readBody(req);
  let hostStr = (body.baseUrl || '').replace(/https?:\/\//, '');
  // Extract just the host/IP if a port is attached (unless it's an IPv6 without brackets but that's complex, handling basic IPv6 [::1] or IP:port)
  let baseUrl = hostStr;
  if (hostStr.includes(']')) {
    baseUrl = hostStr.split(']')[0] + ']';
  } else if (hostStr.includes(':')) {
    baseUrl = hostStr.split(':')[0];
  } else {
    baseUrl = hostStr.split('/')[0];
  }

  const username = body.username  || '';
  const password = body.password  || '';
  const project  = body.project   || 'admin';
  const userDomain    = body.userDomain    || 'Default';
  const projectDomain = body.projectDomain || 'Default';

  if (!baseUrl || !username || !password) {
    return json(res, 400, { error: 'baseUrl, username and password are required' });
  }

  // we assume HTTPS if not specified, and port 5000 for Keystone
  const fullBase = `https://${baseUrl}`;
  const tokenUrl = `${fullBase}:5000/v3/auth/tokens`;

  const authPayload = {
    auth: {
      identity: {
        methods: ['password'],
        password: {
          user: {
            name: username,
            password,
            domain: { name: userDomain },
          },
        },
      },
      scope: {
        project: {
          name: project,
          domain: { name: projectDomain },
        },
      },
    },
  };

  try {
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authPayload),
    });

    if (!r.ok) {
      const text = await r.text();
      return json(res, 401, { error: `Auth failed (${r.status}): ${text.slice(0, 200)}` });
    }

    const token = r.headers.get('x-subject-token');
    let tokenData = null;
    try { tokenData = await r.json(); } catch (_) {}

    // Extract project ID from token body (required for Cinder /v3/{project_id}/volumes)
    const projectId = tokenData?.token?.project?.id || '';

    return json(res, 200, {
      ok: true,
      token,
      projectId,
      baseUrl:  fullBase,
      username,
      project,
      userDomain,
      projectDomain,
      expiresAt: tokenData?.token?.expires_at || null,
    });
  } catch (err) {
    return json(res, 502, { error: `Cannot reach ${tokenUrl}: ${err.message}` });
  }
}

/** GET /api/vhi/servers */
async function handleServers(req, res, ctx) {
  try {
    const servers = await runWithContext(ctx, () => listServers());
    return json(res, 200, { servers });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/health-status */
async function handleHealthStatus(req, res, ctx) {
  try {
    let health = getLastHealth();
    if (!health.result) {
      const result = await runWithContext(ctx, () => healthPoller.runHealthPoll());
      health = { result, time: new Date().toISOString() };
    }
    return json(res, 200, health);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/billing-status */
async function handleBillingStatus(req, res, ctx) {
  try {
    let billing = getLastBilling();
    if (!billing.result) {
      const { calculateHourlyConsumption } = await import('../monitoring/billing-meter.js');
      const result = await runWithContext(ctx, () => calculateHourlyConsumption());
      billing = { result, time: new Date().toISOString() };
    }
    return json(res, 200, billing);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** POST /api/vhi/billing-refresh */
async function handleBillingRefresh(req, res, ctx) {
  try {
    const { forceBillingRefresh } = await import('./scheduler.js');
    const result = await forceBillingRefresh(ctx);
    return json(res, 200, { ok: true, ...result });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

/** GET /api/vhi/billing-export?from=...&to=... */
async function handleBillingExport(req, res, ctx) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    
    const records = await billingStorage.getHistory(from, to);
    
    // Generate CSV
    const headers = ['Timestamp', 'vCPU', 'RAM (GB)', 'Storage (GB)', 'Network Traffic'];
    const rows = records.map(r => [
      r.timestamp,
      r.vCpu,
      r.ramGb,
      r.storageGb,
      `"${r.networkTraffic}"`
    ]);

    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="billing-export-${new Date().toISOString().slice(0,10)}.csv"`
    });
    res.end(csv);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/audit-logs?q=...&user=...&action=...&status=...&limit=...&offset=... */
async function handleAuditLogs(req, res, ctx) {
    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const query = url.searchParams.get('q');
        const user = url.searchParams.get('user');
        const action = url.searchParams.get('action');
        const status = url.searchParams.get('status');
        const limit = parseInt(url.searchParams.get('limit')) || 100;
        const offset = parseInt(url.searchParams.get('offset')) || 0;
        
        const logs = await searchEvents({ query, user, action, status, clusterUrl: ctx.vhiBaseUrl, limit, offset });
        return json(res, 200, { logs });
    } catch (err) {
        return json(res, 500, { error: err.message });
    }
}

/** POST /api/vhi/audit-refresh  – trigger manual poll */
async function handleAuditRefresh(req, res, ctx) {
    try {
        const result = await runWithContext(ctx, () => runAuditPoll(ctx));
        return json(res, 200, { ok: true, ...result });
    } catch (err) {
        return json(res, 500, { error: err.message });
    }
}

/** GET /api/vhi/servers/:id */
async function handleServerGet(req, res, ctx, serverId) {
  try {
    const server = await runWithContext(ctx, () => getServer(serverId));
    if (!server) return json(res, 404, { error: 'Server not found' });
    return json(res, 200, { server });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** DELETE /api/vhi/servers/:id */
async function handleServerDelete(req, res, ctx, serverId) {
  try {
    await runWithContext(ctx, () => deleteServer(serverId));
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** POST /api/vhi/servers/:id/action  body: { action: 'start'|'stop'|'reboot' } */
async function handleServerAction(req, res, ctx, serverId) {
  const body = await readBody(req);
  const action = body.action;
  try {
    let consoleUrl = null;
    await runWithContext(ctx, async () => {
      if (action === 'start')  return startServer(serverId);
      if (action === 'stop')   return stopServer(serverId);
      if (action === 'reboot') return rebootServer(serverId, body.type || 'SOFT');
      if (action === 'resize') return serverAction(serverId, 'resize', { flavorRef: body.flavorId });
      if (action === 'confirmResize') return serverAction(serverId, 'confirmResize');
      if (action === 'revertResize')  return serverAction(serverId, 'revertResize');
      if (action === 'rename') return serverAction(serverId, 'update', { name: body.name });
      if (action === 'console') {
        consoleUrl = await getVncConsole(serverId);
        return;
      }
      throw new Error(`Unknown action: ${action}`);
    });
    return json(res, 200, { ok: true, url: consoleUrl });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/volume-types */
async function handleVolumeTypes(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, async () => {
      const base = ctx.vhiBaseUrl.replace(/\/$/, '');
      const port = process.env.VHI_BLOCK_PORT || 8776;
      const { getClient } = await import('../vhi/client.js');
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
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/flavors */
async function handleFlavors(req, res, ctx) {
  try {
    const flavors = await runWithContext(ctx, () => listFlavors());
    return json(res, 200, { flavors });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/volumes – uses project-ID-aware Cinder v3 URL */
async function handleVolumes(req, res, ctx) {
  try {
    const m = req.method;
    if (m === 'GET') {
      const volumes = await runWithContext(ctx, () => listVolumes());
      return json(res, 200, { volumes });
    }
    if (m === 'POST') {
      const body = await readBody(req);
      const volume = await runWithContext(ctx, () => createVolume(body));
      return json(res, 200, { volume });
    }
    throw new Error(`Unsupported method ${m} for volumes`);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/volumes/:id */
async function handleVolumeGet(req, res, ctx, id) {
  try {
    const volume = await runWithContext(ctx, () => getVolume(id));
    if (!volume) return json(res, 404, { error: 'Volume not found' });
    return json(res, 200, { volume });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handleServerInterfaces(req, res, ctx, serverId, portId) {
  try {
    const m = req.method;
    if (m === 'GET') {
      const interfaces = await runWithContext(ctx, () => listInterfaces(serverId));
      return json(res, 200, { interfaces });
    }
    if (m === 'POST') {
      const body = await readBody(req);
      const iface = await runWithContext(ctx, () => attachInterface(serverId, body.network_id));
      return json(res, 200, { interface: iface });
    }
    if (m === 'PATCH' && portId) {
      const body = await readBody(req);
      const port = await runWithContext(ctx, () => updatePort(portId, body));
      return json(res, 200, { port });
    }
    if (m === 'DELETE' && portId) {
      await runWithContext(ctx, () => detachInterface(serverId, portId));
      return json(res, 200, { ok: true });
    }
    throw new Error(`Unsupported method ${m} for interfaces`);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handleServerVolumes(req, res, ctx, serverId, attachmentId) {
  try {
    const m = req.method;
    if (m === 'POST') {
      const body = await readBody(req);
      const att = await runWithContext(ctx, () => attachVolume(serverId, body.volume_id, body.device));
      return json(res, 200, { attachment: att });
    }
    if (m === 'DELETE' && attachmentId) {
      await runWithContext(ctx, () => detachVolume(serverId, attachmentId));
      return json(res, 200, { ok: true });
    }
    throw new Error(`Unsupported method ${m} for server volumes`);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** POST /api/vhi/servers */
async function handleCreateServer(req, res, ctx) {
  try {
    const payload = await readBody(req);
    const server = await runWithContext(ctx, () => createServer(payload));
    return json(res, 200, { server });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/networks */
async function handleNetworks(req, res, ctx) {
  try {
    const [networks, subnets] = await runWithContext(ctx, () =>
      Promise.all([listNetworks(), listSubnets()])
    );
    return json(res, 200, { networks, subnets });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handleSecurityGroups(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listSecurityGroups());
    return json(res, 200, { security_groups: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handlePortGet(req, res, ctx, id) {
  try {
    const data = await runWithContext(ctx, () => getPort(id));
    return json(res, 200, { port: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/images */
async function handleImages(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listImages());
    return json(res, 200, { images: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/projects */
async function handleProjects(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listProjects());
    return json(res, 200, { projects: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/users */
async function handleUsers(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listUsers());
    return json(res, 200, { users: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/nodes  – hypervisor/compute node list via Nova */
async function handleNodes(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, async () => {
      // 1. Fetch Nova Hypervisors (for basic stats)
      const base = ctx.vhiBaseUrl.replace(/\/$/, '');
      const port = process.env.VHI_COMPUTE_PORT || 8774;
      const url = `${base}:${port}/v2.1/os-hypervisors/detail`;
      const { getClient } = await import('../vhi/client.js');
      const client = await getClient();
      const r = await client.fetch(url);
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Nodes list failed (${r.status}): ${t.slice(0, 200)}`);
      }
      const d = await r.json();
      const hypervisors = d.hypervisors || [];

      // 2. Fetch Vinfra Nodes (for external IPs) & Compute Config (for overcommitment)
      try {
        const { runVinfraCommand } = await import('../vhi/vinfra.js');
        
        // Use a timeout to avoid blocking the whole API if SSH hangs
        const withTimeout = (promise, ms, fallback) => 
          Promise.race([promise, new Promise(res => setTimeout(() => res(fallback), ms))]);

        const [vNodes, computeSvc] = await Promise.all([
          withTimeout(runVinfraCommand(['node', 'list']).catch(() => []), 4000, []),
          withTimeout(runVinfraCommand(['service', 'compute', 'show']).catch(() => ({})), 4000, {})
        ]);

        // Ensure we have expected types
        const safeVNodes = Array.isArray(vNodes) ? vNodes : [];
        if (safeVNodes.length > 0) {
          console.log(`[VHI-API] First vinfra node keys: ${Object.keys(safeVNodes[0]).join(', ')}`);
          console.log(`[VHI-API] First vinfra node raw:`, JSON.stringify(safeVNodes[0]));
        }
        const safeComputeSvc = (computeSvc && typeof computeSvc === 'object') ? computeSvc : {};
        const cpuRatio = safeComputeSvc.config?.cpu_allocation_ratio || 16.0;

        let finalNodes = [];

        if (safeVNodes.length > 0) {
          // 3. If vinfra gave us nodes, use them as primary source
          finalNodes = safeVNodes.map(vn => {
            const vName = vn.hostname || vn.host || vn.name || vn.id || 'unknown';
            // Vinfra address can be an array in some versions - handle both
            const vAddr = Array.isArray(vn.address) ? vn.address[0] : (vn.address || vn.ip || vn.host_ip || null);
            
            // Find hypervisor for this vinfra node by hostname, ID, or IP match
            // We use string conversion for IDs to handle Integer vs UUID scenarios
            const h = hypervisors.find(hv => 
              (hv.hypervisor_hostname && vName && (
                hv.hypervisor_hostname.toLowerCase() === vName.toLowerCase() || 
                hv.hypervisor_hostname.split('.')[0].toLowerCase() === vName.split('.')[0].toLowerCase()
              )) || 
              (hv.id && String(hv.id) === String(vn.id)) ||
              (hv.host_ip && hv.host_ip === vAddr)
            );
            
            if (!h) {
              console.log(`[VHI-API] No compute match for vinfra node: ${vName} (${vAddr}) - tagging as Management`);
            } else {
              console.log(`[VHI-API] Matched vinfra node ${vName} to hypervisor ${h.hypervisor_hostname} (ID: ${h.id})`);
            }

            return {
              ...(h || {}),
              id: vn.id,
              hypervisor_hostname: vName || vn.id || 'unknown',
              state: vn.state || h?.state || 'unknown',
              status: vn.status || h?.status || 'unknown',
              external_ip: vAddr || h?.host_ip || null,
              cpu_allocation_ratio: cpuRatio,
              // Flag to indicate if this is a compute node
              is_compute: !!h
            };
          });
        } else {
          // 4. Fallback to Nova hypervisors if vinfra failed/timed out
          finalNodes = hypervisors.map(h => {
            return {
              ...h,
              external_ip: h.host_ip || null,
              cpu_allocation_ratio: cpuRatio,
              is_compute: true
            };
          });
        }

        // ────────────────────────────────────────────────────────────────
        // ENHANCEMENT: Supplement Nova/Vinfra list with Neutron IP data
        // ────────────────────────────────────────────────────────────────
        try {
          const [ports, networks] = await withTimeout(Promise.all([listPorts(), listNetworks()]), 3000).catch(() => [[], []]);
          const netMap = {};
          networks.forEach(n => { netMap[n.id] = n.name; });
          
          const hostPortMap = {};
          ports.forEach(p => {
            const hid = p['binding:host_id'];
            if (!hid) return;
            if (!hostPortMap[hid]) hostPortMap[hid] = [];
            hostPortMap[hid].push({
              name: netMap[p.network_id] || p.name || p.id.slice(0, 8),
              ips: (p.fixed_ips || []).map(f => f.ip_address)
            });
          });

          finalNodes = finalNodes.map(n => {
            const hostname = n.hypervisor_hostname || n.hostname || n.name;
            const hostPorts = hostPortMap[hostname] || hostPortMap[hostname?.split('.')[0]] || [];
            if (hostPorts.length > 0) {
              n._all_ips = hostPorts;
              // Best external IP heuristic: look for Public/External or routable IP
              const publicNet = hostPorts.find(hp => 
                /public|external|internet/i.test(hp.name) || 
                (hp.ips || []).some(ip => !ip.startsWith('10.') && !ip.startsWith('192.168.') && !ip.startsWith('172.'))
              );
              if (publicNet && publicNet.ips && publicNet.ips.length > 0) {
                n.external_ip = publicNet.ips[0];
              } else if (!n.external_ip && hostPorts[0].ips.length > 0) {
                n.external_ip = hostPorts[0].ips[0];
              }
            }
            return n;
          });
        } catch (netErr) {
          console.log(`[VHI-API] Bulk Neutron discovery skipped: ${netErr.message}`);
        }

        console.log(`[VHI-API] handleNodes returning ${finalNodes.length} nodes:`, JSON.stringify(finalNodes.map(n => ({ host: n.hypervisor_hostname, ext: n.external_ip, compute: n.is_compute })), null, 2));
        return finalNodes;
      } catch (vErr) {
        console.warn(`[VHI-API] Failed to enrich nodes with vinfra: ${vErr.message}`);
        return hypervisors.map(h => ({ ...h, cpu_allocation_ratio: 16.0, is_compute: true }));
      }
    });
    return json(res, 200, { nodes: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function findNeutronNodeIps(hostname) {
  try {
    const [ports, networks] = await Promise.race([
      Promise.all([listPorts(), listNetworks()]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Neutron discovery timed out (4s)')), 4000))
    ]);

    const netMap = {};
    networks.forEach(n => { netMap[n.id] = n.name; });

    const nodePorts = ports.filter(p => p['binding:host_id'] === hostname || p['binding:host_id'] === hostname.split('.')[0]);
    return nodePorts.map(p => ({
      name: netMap[p.network_id] || p.name || p.id.slice(0, 8),
      type: p.device_owner,
      mac: p.mac_address,
      ips: (p.fixed_ips || []).map(f => f.ip_address)
    }));
  } catch (err) {
    console.error(`[VHI-API] findNeutronNodeIps failed for ${hostname}:`, err.message);
    return [];
  }
}

/** GET /api/vhi/nodes/:id */
async function handleNodeGet(req, res, ctx, nodeId) {
  try {
    const data = await runWithContext(ctx, async () => {
      const { runVinfraCommand } = await import('../vhi/vinfra.js');
      const { getHypervisor } = await import('../vhi/compute.js');
      
      const withTimeout = (promise, ms) => 
        Promise.race([
          promise, 
          new Promise((_, rej) => setTimeout(() => rej(new Error('Vinfra node show timed out (5s)')), ms))
        ]);

      let nodeDetails;
      try {
        // Primary source: Vinfra (deep hardware/service info)
        nodeDetails = await withTimeout(runVinfraCommand(['node', 'show', nodeId]), 5000);
      } catch (vErr) {
        console.log(`[VHI-API] Vinfra node show failed for ${nodeId}, falling back to Nova: ${vErr.message}`);
        
        // Fallback: Nova Hypervisor (basic compute info)
        const hNode = await getHypervisor(nodeId);
        if (!hNode) throw new Error(`Node not found in Vinfra or Nova: ${nodeId}`);
        
        nodeDetails = {
          id: hNode.id,
          hostname: hNode.hypervisor_hostname,
          status: hNode.status,
          state: hNode.state,
          cpu_model: hNode.cpu_info?.model || 'Generic',
          cpus: hNode.vcpus,
          ram_size: hNode.memory_mb * 1024 * 1024, // Convert MB to bytes
          roles: ['compute'],
          services: [{ name: 'nova-compute', status: hNode.state }],
          networks: [{ name: 'Management', ips: [hNode.host_ip] }],
          _is_fallback: true,
          _host_ip: hNode.host_ip
        };
      }

      // ────────────────────────────────────────────────────────────────
      // ENHANCEMENT: Discover ALL IP addresses via SSH 'ip -j addr'
      // ────────────────────────────────────────────────────────────────
      let discoveredIps = false;
      try {
        const sshHost = nodeDetails.external_ip || nodeDetails._host_ip || nodeDetails.hostname;
        if (sshHost) {
          console.log(`[VHI-API] Fetching real network state via SSH for ${sshHost}...`);
          const rawInterfaces = await withTimeout(runVinfraCommand(['/sbin/ip', '-j', 'addr'], { host: sshHost }), 3000);
          
          if (Array.isArray(rawInterfaces)) {
            const realNetworks = rawInterfaces
              .filter(iface => iface.ifname !== 'lo')
              .map(iface => ({
                name: iface.ifname,
                mac: iface.address,
                ips: (iface.addr_info || []).map(a => a.local).filter(Boolean)
              }));
            
            if (realNetworks.length > 0) {
              nodeDetails.networks = realNetworks;
              discoveredIps = true;
            }
          }
        }
      } catch (sshErr) {
        console.log(`[VHI-API] Real IP discovery via SSH failed: ${sshErr.message}`);
      }

      // ────────────────────────────────────────────────────────────────
      // SECOND FALLBACK: Discover IP addresses via Neutron Ports
      // ────────────────────────────────────────────────────────────────
      if (!discoveredIps || (nodeDetails.networks || []).length <= 1) {
        const hostname = nodeDetails.hostname || nodeDetails.hypervisor_hostname;
        if (hostname) {
          console.log(`[VHI-API] Fetching network state via Neutron for ${hostname}...`);
          const neutronNetworks = await findNeutronNodeIps(hostname);
          if (neutronNetworks.length > 0) {
            // Merge or replace if Neutron has more info
            if (!nodeDetails.networks || nodeDetails.networks.length <= 1) {
              nodeDetails.networks = neutronNetworks;
            } else {
              // Supplement existing ones
              neutronNetworks.forEach(nn => {
                if (!nodeDetails.networks.find(en => en.mac === nn.mac)) {
                  nodeDetails.networks.push(nn);
                }
              });
            }

            // HEURISTIC: Find the "best" external IP for SSH/Console
            // Look for networks named Public, External, or those with routable IPs
            const publicNet = neutronNetworks.find(n => 
              /public|external|internet/i.test(n.name) || 
              (n.ips || []).some(ip => !ip.startsWith('10.') && !ip.startsWith('192.168.') && !ip.startsWith('172.'))
            );
            if (publicNet && publicNet.ips && publicNet.ips.length > 0) {
              nodeDetails.external_ip = publicNet.ips[0];
            }
          }
        }
      }

      return nodeDetails;
    });
    return json(res, 200, data);
  } catch (err) {
    console.error(`[VHI-API] handleNodeGet fail for ${nodeId}: ${err.message}`);
    return json(res, 500, { error: err.message });
  }
}

/** POST /api/vhi/nodes/:id/action */
async function handleNodeAction(req, res, ctx, nodeId) {
  const body = await readBody(req);
  const action = body.action;
  const creds = body.creds || {};
  try {
    let result = null;
    await runWithContext(ctx, async () => {
      if (action === 'reboot') {
        const { runVinfraCommand } = await import('../vhi/vinfra.js');
        
        // 1. Put node in maintenance mode (evacuate VMs)
        // We use --wait to ensure it's safe to reboot afterwards
        console.log(`Putting node ${nodeId} into maintenance...`);
        try {
          await runVinfraCommand(['node', 'maintenance', 'start', nodeId, '--wait'], creds);
        } catch (mErr) {
          console.warn(`Maintenance start failed (continuing anyway): ${mErr.message}`);
        }

        // 2. Execute direct reboot command on the host
        console.log(`Sending direct reboot command to ${nodeId}...`);
        try {
          // We'll run a raw shell command. 
          await runVinfraCommand(['/sbin/reboot'], creds);
        } catch (rErr) {
          // SSH often drops connection on reboot, so we ignore connection reset errors
          if (!rErr.message.includes('ECONNRESET') && !rErr.message.includes('Socket connection item')) {
             throw rErr;
          }
        }
      }
    });
    return json(res, 200, { ok: true, result });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

async function handleVolumeExtend(req, res, ctx, id) {
  try {
    const { new_size } = await readBody(req);
    if (!new_size) throw new Error('Missing new_size');
    await runWithContext(ctx, () => extendVolume(id, parseInt(new_size)));
    return json(res, 202, { status: 'Accepted' });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
}

async function handleVolumeRetype(req, res, ctx, id) {
  try {
    const { new_type, migration_policy } = await readBody(req);
    if (!new_type) throw new Error('Missing new_type');
    await runWithContext(ctx, () => retypeVolume(id, new_type, migration_policy));
    return json(res, 202, { status: 'Accepted' });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
}

async function handleVolumeUpdate(req, res, ctx, id) {
  try {
    const options = await readBody(req);
    const data = await runWithContext(ctx, () => updateVolume(id, options));
    return json(res, 200, { volume: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handleVolumeDelete(req, res, ctx, id) {
  try {
    await runWithContext(ctx, () => deleteVolume(id));
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handleSnapshots(req, res, ctx, id) {
  try {
    const m = req.method;
    if (m === 'GET') {
      const snapshots = await runWithContext(ctx, () => listSnapshots());
      return json(res, 200, { snapshots });
    }
    if (m === 'POST') {
      const body = await readBody(req);
      const snapshot = await runWithContext(ctx, () => createSnapshot(body.name, body.volume_id, body.description));
      return json(res, 200, { snapshot });
    }
    if (m === 'DELETE' && id) {
      await runWithContext(ctx, () => deleteSnapshot(id));
      return json(res, 200, { ok: true });
    }
    throw new Error(`Unsupported method ${m} for snapshots`);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handleSnapshotAction(req, res, ctx, snapshotId) {
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
        
        // 1. Create a temporary volume from the snapshot
        const tempVolume = await createVolume({
          name: `temp-vol-for-img-${snapshotId.slice(0, 8)}`,
          snapshot_id: snapshotId,
          size: body.size || 20 // Default or from body
        });
        
        if (!tempVolume || !tempVolume.id) throw new Error('Failed to create temporary volume');

        // Note: In a real production environment, we'd wait for the volume to be 'available'
        // before calling uploadVolumeToImage. For this implementation, we'll assume the client
        // handles polling or we provide the temp volume ID for them to manage.
        // To keep it simple but functional, we'll return the temp volume ID.
        const imageData = await uploadVolumeToImage(tempVolume.id, {
          image_name: imageName
        });
        
        return imageData;
      }
      throw new Error(`Unknown snapshot action: ${action}`);
    });
    
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handleGetSshSettings(req, res, ctx) {
  try {
    const config = await loadGlobalSshConfig(ctx.vhiBaseUrl);
    return json(res, 200, config);
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

async function handlePostSshSettings(req, res, ctx) {
  try {
    const config = await readBody(req);
    await saveGlobalSshConfig(config, ctx.vhiBaseUrl);
    return json(res, 200, { ok: true });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

// ── main dispatcher ────────────────────────────────────────────────────────

/**
 * Handle a request whose URL starts with /api/vhi/
 * @returns {boolean} true if handled, false to fall through to 404
 */
export async function handleVhiApi(req, res) {
  const m = req.method || 'GET';
  const url = req.url || '';

  // Strip query string
  const p = url.split('?')[0].replace(/\/$/, '');

  // Auth endpoint – no credentials needed up-front
  if (m === 'POST' && p === '/api/vhi/auth') {
    await handleAuth(req, res);
    return true;
  }

  // Cluster Registry Sync (Unauthenticated, for multi-cluster dashboard)
  if (m === 'GET' && p === '/api/vhi/clusters/all') {
      const allConfigs = await loadGlobalSshConfig();
      const clusterUrls = Object.keys(allConfigs);
      return json(res, 200, { clusters: clusterUrls });
  }

  // All other endpoints require credentials via headers
  const ctx = extractContext(req);
  if (!ctx.vhiBaseUrl || !ctx.vhiUser || !ctx.vhiPassword) {
    json(res, 401, { error: 'Missing VHI credentials. Login first.' });
    return true;
  }

  // Compute
  if (m === 'GET' && p === '/api/vhi/servers') return handleServers(req, res, ctx);


  // --- ALERTS ---
  if (m === 'GET' && p === '/api/vhi/alerts') {
      const q = new URL(url, `http://${req.headers.host}`).searchParams.get('q') || '';
      const limit = parseInt(new URL(url, `http://${req.headers.host}`).searchParams.get('limit')) || 100;
      const offset = parseInt(new URL(url, `http://${req.headers.host}`).searchParams.get('offset')) || 0;
      
      const logs = searchAlerts({ query: q, clusterUrl: ctx.vhiBaseUrl, limit, offset });
      return json(res, 200, { alerts: logs });
  }
  if (m === 'POST' && p === '/api/vhi/alerts-refresh') {
      await runAlertPoll(ctx);
      return json(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/api/vhi/health-status') return handleHealthStatus(req, res, ctx);
  if (m === 'GET' && p === '/api/vhi/billing-status') return handleBillingStatus(req, res, ctx);
  if (m === 'POST' && p === '/api/vhi/billing-refresh') return handleBillingRefresh(req, res, ctx);
  if (m === 'GET' && p === '/api/vhi/billing-export') return handleBillingExport(req, res, ctx);
  
  if (m === 'GET' && p === '/api/vhi/audit-logs') return handleAuditLogs(req, res, ctx);
  if (m === 'POST' && p === '/api/vhi/audit-refresh') return handleAuditRefresh(req, res, ctx);
  
  const serverGetMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)$/);
  if (m === 'GET' && serverGetMatch) return handleServerGet(req, res, ctx, serverGetMatch[1]);
  if (m === 'DELETE' && serverGetMatch) return handleServerDelete(req, res, ctx, serverGetMatch[1]);
  if (m === 'POST' && p === '/api/vhi/servers') return handleCreateServer(req, res, ctx);
  const actionMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)\/action$/);
  if (m === 'POST' && actionMatch) return handleServerAction(req, res, ctx, actionMatch[1]);
  
  const interfaceMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)\/interfaces(?:\/([^/]+))?$/);
  if (interfaceMatch) return handleServerInterfaces(req, res, ctx, interfaceMatch[1], interfaceMatch[2]);

  const volumeAttachMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)\/volumes(?:\/([^/]+))?$/);
  if (volumeAttachMatch) return handleServerVolumes(req, res, ctx, volumeAttachMatch[1], volumeAttachMatch[2]);

  if (m === 'GET' && p === '/api/vhi/flavors') return handleFlavors(req, res, ctx);
  if (m === 'GET' && p === '/api/vhi/nodes') return handleNodes(req, res, ctx);

  const nodeGetMatch = p.match(/^\/api\/vhi\/nodes\/([^/]+)$/);
  if (m === 'GET' && nodeGetMatch) return handleNodeGet(req, res, ctx, nodeGetMatch[1]);

  const nodeActionMatch = p.match(/^\/api\/vhi\/nodes\/([^/]+)\/action$/);
  if (m === 'POST' && nodeActionMatch) return handleNodeAction(req, res, ctx, nodeActionMatch[1]);

  // Network
  if (m === 'GET' && p === '/api/vhi/networks') return handleNetworks(req, res, ctx);
  if (m === 'GET' && p === '/api/vhi/security-groups') return handleSecurityGroups(req, res, ctx);
  
  const portMatch = p.match(/^\/api\/vhi\/ports\/([^/]+)$/);
  if (m === 'GET' && portMatch) return handlePortGet(req, res, ctx, portMatch[1]);

  // Block Storage
  if (p === '/api/vhi/volumes') { await handleVolumes(req, res, ctx); return true; }
  if (p === '/api/vhi/volume-types') { await handleVolumeTypes(req, res, ctx); return true; }
  
  const volMatch = p.match(/^\/api\/vhi\/volumes\/([^/]+)$/);
  if (volMatch) {
    if (m === 'GET') { await handleVolumeGet(req, res, ctx, volMatch[1]); return true; }
    if (m === 'PATCH') { await handleVolumeUpdate(req, res, ctx, volMatch[1]); return true; }
    if (m === 'DELETE') { await handleVolumeDelete(req, res, ctx, volMatch[1]); return true; }
  }

  const volExtendMatch = p.match(/^\/api\/vhi\/volumes\/([^/]+)\/extend$/);
  if (m === 'POST' && volExtendMatch) { await handleVolumeExtend(req, res, ctx, volExtendMatch[1]); return true; }

  const volRetypeMatch = p.match(/^\/api\/vhi\/volumes\/([^/]+)\/retype$/);
  if (m === 'POST' && volRetypeMatch) { await handleVolumeRetype(req, res, ctx, volRetypeMatch[1]); return true; }

  // Snapshots
  if (p === '/api/vhi/snapshots') { await handleSnapshots(req, res, ctx); return true; }
  const snapMatch = p.match(/^\/api\/vhi\/snapshots\/([^/]+)$/);
  if (m === 'DELETE' && snapMatch) { await handleSnapshots(req, res, ctx, snapMatch[1]); return true; }
  
  const snapActionMatch = p.match(/^\/api\/vhi\/snapshots\/([^/]+)\/action$/);
  if (m === 'POST' && snapActionMatch) { await handleSnapshotAction(req, res, ctx, snapActionMatch[1]); return true; }

  // Image
  if (m === 'GET' && p === '/api/vhi/images') return handleImages(req, res, ctx);

  // Identity
  if (m === 'GET' && p === '/api/vhi/projects') return handleProjects(req, res, ctx);
  if (m === 'GET' && p === '/api/vhi/users') return handleUsers(req, res, ctx);

  // Global Settings
  if (m === 'GET' && p === '/api/vhi/settings/ssh') return handleGetSshSettings(req, res, ctx);
  if (m === 'POST' && p === '/api/vhi/settings/ssh') return handlePostSshSettings(req, res, ctx);

  return false; // not handled here
}
