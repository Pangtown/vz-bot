import { runWithContext } from '../context.js';
import { listServers, getServer, serverAction, startServer, stopServer, rebootServer, deleteServer, createServer, listFlavors, getRemoteConsole } from '../../vhi/compute.js';
import { listImages, createImage, uploadImageData, updateImageVisibility, deleteImage } from '../../vhi/image.js';
import { listPorts, listNetworks, updatePort } from '../../vhi/network.js';
import { listInterfaces, attachInterface, detachInterface, getHypervisor } from '../../vhi/compute.js';
import { attachVolume, detachVolume } from '../../vhi/block.js';
import { json, readBody } from './helpers.js';
import { logger, retryOperation } from '../../utils/index.js';

export async function handleServers(req, res, ctx) {
  try {
    const servers = await runWithContext(ctx, () => listServers());
    return json(res, 200, { servers });
  } catch (err) {
    logger.error(`handleServers error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleServerGet(req, res, ctx, serverId) {
  try {
    const server = await runWithContext(ctx, () => getServer(serverId));
    if (!server) return json(res, 404, { error: 'Server not found' });
    return json(res, 200, { server });
  } catch (err) {
    logger.error(`handleServerGet error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleServerDelete(req, res, ctx, serverId) {
  try {
    await runWithContext(ctx, () => deleteServer(serverId));
    logger.info(`Deleted server: ${serverId}`);
    return json(res, 200, { ok: true });
  } catch (err) {
    logger.error(`handleServerDelete error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleServerAction(req, res, ctx, serverId) {
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
        const protocol = body.protocol || 'vnc';
        const type = body.type || 'novnc';
        consoleUrl = await getRemoteConsole(serverId, protocol, type);
        return;
      }
      throw new Error(`Unknown action: ${action}`);
    });
    logger.info(`Performed action ${action} on server ${serverId}`);
    return json(res, 200, { ok: true, url: consoleUrl });
  } catch (err) {
    logger.error(`handleServerAction error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleCreateServer(req, res, ctx) {
  try {
    const payload = await readBody(req);
    const server = await runWithContext(ctx, () => createServer(payload));
    logger.info(`Created server: ${server.id || 'unknown'}`);
    return json(res, 200, { server });
  } catch (err) {
    logger.error(`handleCreateServer error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleFlavors(req, res, ctx) {
  try {
    const flavors = await runWithContext(ctx, () => listFlavors());
    return json(res, 200, { flavors });
  } catch (err) {
    logger.error(`handleFlavors error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleImages(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listImages());
    return json(res, 200, { images: data });
  } catch (err) {
    logger.error(`handleImages error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

// POST /api/vhi/images — create image metadata record (returns queued image)
export async function handleCreateImage(req, res, ctx) {
  try {
    const body = await readBody(req);
    if (!body.name || !String(body.name).trim()) {
      return json(res, 400, { error: 'Image name is required' });
    }
    const image = await runWithContext(ctx, () => createImage(body));
    logger.info(`Created image record: ${image.id || 'unknown'}`);
    return json(res, 200, { image });
  } catch (err) {
    logger.error(`handleCreateImage error: ${err.message}`, { error: err.message });
    // Surface Glance's 403 for non-admin public requests as a clear message
    const status = /403/.test(err.message) ? 403 : 502;
    return json(res, status, { error: err.message });
  }
}

// PUT /api/vhi/images/:id/file — stream binary image data into a queued image
export async function handleUploadImage(req, res, ctx, imageId) {
  try {
    const contentLength = req.headers['content-length'];
    await runWithContext(ctx, () => uploadImageData(imageId, req, contentLength));
    logger.info(`Uploaded data for image ${imageId}`);
    return json(res, 200, { ok: true });
  } catch (err) {
    logger.error(`handleUploadImage error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

// PATCH /api/vhi/images/:id — change visibility (public requires admin)
export async function handleUpdateImage(req, res, ctx, imageId) {
  try {
    const body = await readBody(req);
    const image = await runWithContext(ctx, () => updateImageVisibility(imageId, body.visibility));
    logger.info(`Set image ${imageId} visibility to ${body.visibility}`);
    return json(res, 200, { image });
  } catch (err) {
    logger.error(`handleUpdateImage error: ${err.message}`, { error: err.message });
    const status = /403/.test(err.message) ? 403 : 502;
    return json(res, status, { error: err.message });
  }
}

// DELETE /api/vhi/images/:id
export async function handleDeleteImage(req, res, ctx, imageId) {
  try {
    await runWithContext(ctx, () => deleteImage(imageId));
    logger.info(`Deleted image ${imageId}`);
    return json(res, 200, { ok: true });
  } catch (err) {
    logger.error(`handleDeleteImage error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleServerInterfaces(req, res, ctx, serverId, portId) {
  try {
    const m = req.method;
    if (m === 'GET') {
      const interfaces = await runWithContext(ctx, () => listInterfaces(serverId));
      return json(res, 200, { interfaces });
    }
    if (m === 'POST') {
      const body = await readBody(req);
      const iface = await runWithContext(ctx, () => attachInterface(serverId, body.network_id));
      logger.info(`Attached interface to server ${serverId}`);
      return json(res, 200, { interface: iface });
    }
    if (m === 'PATCH' && portId) {
      const body = await readBody(req);
      const port = await runWithContext(ctx, () => updatePort(portId, body));
      return json(res, 200, { port });
    }
    if (m === 'DELETE' && portId) {
      await runWithContext(ctx, () => detachInterface(serverId, portId));
      logger.info(`Detached interface ${portId} from server ${serverId}`);
      return json(res, 200, { ok: true });
    }
    throw new Error(`Unsupported method ${m} for interfaces`);
  } catch (err) {
    logger.error(`handleServerInterfaces error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleServerVolumes(req, res, ctx, serverId, attachmentId) {
  try {
    const m = req.method;
    if (m === 'POST') {
      const body = await readBody(req);
      const att = await runWithContext(ctx, () => attachVolume(serverId, body.volume_id, body.device));
      logger.info(`Attached volume ${body.volume_id} to server ${serverId}`);
      return json(res, 200, { attachment: att });
    }
    if (m === 'DELETE' && attachmentId) {
      await runWithContext(ctx, () => detachVolume(serverId, attachmentId));
      logger.info(`Detached volume attachment ${attachmentId} from server ${serverId}`);
      return json(res, 200, { ok: true });
    }
    throw new Error(`Unsupported method ${m} for server volumes`);
  } catch (err) {
    logger.error(`handleServerVolumes error: ${err.message}`, { error: err.message });
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
    logger.error(`[VHI-API] findNeutronNodeIps failed for ${hostname}: ${err.message}`);
    return [];
  }
}

export async function handleNodes(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, async () => {
      // 1. Fetch Nova Hypervisors (for basic stats)
      const base = ctx.vhiBaseUrl.replace(/\/$/, '');
      const port = process.env.VHI_COMPUTE_PORT || 8774;
      const url = `${base}:${port}/v2.1/os-hypervisors/detail`;
      const { getClient } = await import('../../vhi/client.js');
      const client = await getClient();
      const r = await client.fetch(url);
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Nodes list failed (${r.status}): ${t.slice(0, 200)}`);
      }
      const d = await r.json();
      const hypervisors = d.hypervisors || [];

      // 2. Fetch Vinfra Nodes (with retries for resilience)
      try {
        const { runVinfraCommand } = await import('../../vhi/vinfra.js');
        const withTimeout = (promise, ms, fallback) => 
          Promise.race([promise, new Promise(res => setTimeout(() => res(fallback), ms))]);

        const [vNodes, computeSvc] = await Promise.all([
          withTimeout(retryOperation(() => runVinfraCommand(['node', 'list']), { maxAttempts: 3 }), 4000, []),
          withTimeout(retryOperation(() => runVinfraCommand(['service', 'compute', 'show']), { maxAttempts: 2 }), 4000, {})
        ]);

        const safeVNodes = Array.isArray(vNodes) ? vNodes : [];
        if (safeVNodes.length > 0) {
          logger.debug(`[VHI-API] First vinfra node raw:`, { node: safeVNodes[0] });
        }
        const safeComputeSvc = (computeSvc && typeof computeSvc === 'object') ? computeSvc : {};
        const cpuRatio = safeComputeSvc.config?.cpu_allocation_ratio || 16.0;

        let finalNodes = [];

        if (safeVNodes.length > 0) {
          finalNodes = safeVNodes.map(vn => {
            const vName = vn.hostname || vn.host || vn.name || vn.id || 'unknown';
            const vAddr = Array.isArray(vn.address) ? vn.address[0] : (vn.address || vn.ip || vn.host_ip || null);
            const h = hypervisors.find(hv => 
              (hv.hypervisor_hostname && vName && (
                hv.hypervisor_hostname.toLowerCase() === vName.toLowerCase() || 
                hv.hypervisor_hostname.split('.')[0].toLowerCase() === vName.split('.')[0].toLowerCase()
              )) || 
              (hv.id && String(hv.id) === String(vn.id)) ||
              (hv.host_ip && hv.host_ip === vAddr)
            );
            
            if (!h) {
              logger.debug(`[VHI-API] No compute match for vinfra node: ${vName} (${vAddr}) - tagging as Management`);
            } else {
              logger.debug(`[VHI-API] Matched vinfra node ${vName} to hypervisor ${h.hypervisor_hostname}`);
            }

            return {
              ...(h || {}),
              id: vn.id,
              hypervisor_hostname: vName || vn.id || 'unknown',
              state: vn.state || h?.state || 'unknown',
              status: vn.status || h?.status || 'unknown',
              external_ip: vAddr || h?.host_ip || null,
              cpu_allocation_ratio: cpuRatio,
              is_compute: !!h
            };
          });
        } else {
          finalNodes = hypervisors.map(h => {
            return {
              ...h,
              external_ip: h.host_ip || null,
              cpu_allocation_ratio: cpuRatio,
              is_compute: true
            };
          });
        }

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
          logger.warn(`[VHI-API] Bulk Neutron discovery skipped: ${netErr.message}`);
        }
        return finalNodes;
      } catch (vErr) {
        logger.warn(`[VHI-API] Failed to enrich nodes with vinfra: ${vErr.message}`);
        return hypervisors.map(h => ({ ...h, cpu_allocation_ratio: 16.0, is_compute: true }));
      }
    });
    return json(res, 200, { nodes: data });
  } catch (err) {
    logger.error(`handleNodes error: ${err.message}`);
    return json(res, 502, { error: err.message });
  }
}

export async function handleNodeGet(req, res, ctx, nodeId) {
  try {
    const data = await runWithContext(ctx, async () => {
      const { runVinfraCommand } = await import('../../vhi/vinfra.js');
      
      const withTimeout = (promise, ms) => 
        Promise.race([
          promise, 
          new Promise((_, rej) => setTimeout(() => rej(new Error('Vinfra node show timed out')), ms))
        ]);

      let nodeDetails;
      try {
        // Primary source: Vinfra (with retries)
        nodeDetails = await withTimeout(retryOperation(() => runVinfraCommand(['node', 'show', nodeId]), { maxAttempts: 2 }), 15000);
      } catch (vErr) {
        logger.info(`[VHI-API] Vinfra node show failed for ${nodeId}, falling back to Nova: ${vErr.message}`);
        const hNode = await getHypervisor(nodeId);
        if (!hNode) throw new Error(`Node not found in Vinfra or Nova: ${nodeId}`);
        
        nodeDetails = {
          id: hNode.id,
          hostname: hNode.hypervisor_hostname,
          status: hNode.status,
          state: hNode.state,
          cpu_model: hNode.cpu_info?.model || 'Generic',
          cpus: hNode.vcpus,
          ram_size: hNode.memory_mb * 1024 * 1024,
          roles: ['compute'],
          services: [{ name: 'nova-compute', status: hNode.state }],
          networks: [{ name: 'Internal (Nova)', ips: [hNode.host_ip] }],
          _is_fallback: true,
          _host_ip: hNode.host_ip
        };
      }

      let discoveredIps = false;
      
      // 1. Try Virtuozzo Logical Network mapping via Vinfra
      try {
        logger.debug(`[VHI-API] Fetching Virtuozzo logical network configuration for node ${nodeId}...`);
        const [clusterNets, nodeIfaces] = await Promise.all([
          withTimeout(retryOperation(() => runVinfraCommand(['cluster', 'network', 'list']), { maxAttempts: 2 }), 10000),
          withTimeout(retryOperation(() => runVinfraCommand(['node', 'iface', 'list', '--node', nodeId]), { maxAttempts: 2 }), 10000)
        ]);

        if (Array.isArray(clusterNets) && Array.isArray(nodeIfaces)) {
          const netMap = {};
          clusterNets.forEach(net => {
            netMap[net.id] = net;
          });

          const logicalNetworks = nodeIfaces
            .filter(iface => iface.state === 'up')
            .map(iface => {
              const logicalNet = iface.network ? netMap[iface.network] : null;
              const netName = logicalNet ? logicalNet.name : (iface.network ? 'Unknown' : 'Unassigned');
              const trafficTypes = logicalNet ? (logicalNet.traffic_types || []) : [];
              const cleanIps = (iface.ipv4 || []).map(ip => ip.split('/')[0]);

              return {
                name: netName, // e.g., "Public", "Private", "overlay"
                ifname: iface.name,
                mac: iface.mac || iface.address || null,
                ips: cleanIps,
                traffic_types: trafficTypes
              };
            });

          if (logicalNetworks.length > 0) {
            nodeDetails.networks = logicalNetworks;
            discoveredIps = true;
            logger.info(`[VHI-API] Successfully mapped ${logicalNetworks.length} logical networks for node ${nodeId}`);
          }
        }
      } catch (logicalErr) {
        logger.warn(`[VHI-API] Virtuozzo logical network mapping failed: ${logicalErr.message}. Falling back to SSH/Neutron...`);
      }

      // 2. Fallback to SSH /sbin/ip if Vinfra mapping was unsuccessful
      if (!discoveredIps) {
        try {
          const sshHost = nodeDetails.external_ip || nodeDetails._host_ip || nodeDetails.hostname;
          if (sshHost) {
            logger.debug(`[VHI-API] Fetching real network state via SSH for ${sshHost}...`);
            const rawInterfaces = await withTimeout(retryOperation(() => runVinfraCommand(['/sbin/ip', '-j', 'addr'], { host: sshHost }), { maxAttempts: 2 }), 10000);
            
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
          logger.debug(`[VHI-API] Real IP discovery via SSH failed for ${nodeId}: ${sshErr.message}`);
        }
      }

      // 3. Fallback to Neutron to resolve public external_ip if needed
      if (!discoveredIps || (nodeDetails.networks || []).length <= 1) {
        const hostname = nodeDetails.hostname || nodeDetails.hypervisor_hostname;
        if (hostname) {
          logger.debug(`[VHI-API] Fetching network state via Neutron for ${hostname}...`);
          const neutronNetworks = await findNeutronNodeIps(hostname);
          if (neutronNetworks.length > 0) {
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
    logger.error(`[VHI-API] handleNodeGet fail for ${nodeId}: ${err.message}`);
    return json(res, 500, { error: err.message });
  }
}

export async function handleNodeAction(req, res, ctx, nodeId) {
  const body = await readBody(req);
  const action = body.action;
  const creds = body.creds || {};
  try {
    let result = null;
    await runWithContext(ctx, async () => {
      if (action === 'reboot') {
        const { runVinfraCommand } = await import('../../vhi/vinfra.js');
        logger.info(`Putting node ${nodeId} into maintenance...`);
        try {
          await runVinfraCommand(['node', 'maintenance', 'start', nodeId, '--wait'], creds);
        } catch (mErr) {
          logger.warn(`Maintenance start failed (continuing anyway): ${mErr.message}`);
        }
        logger.info(`Sending direct reboot command to ${nodeId}...`);
        try {
          // Wrapped raw SSH command implicitly in runVinfraCommand
          await runVinfraCommand(['/sbin/reboot'], creds);
        } catch (rErr) {
          if (!rErr.message.includes('ECONNRESET') && !rErr.message.includes('Socket connection item')) {
             throw rErr;
          }
        }
      }
    });
    return json(res, 200, { ok: true, result });
  } catch (err) {
    logger.error(`handleNodeAction error: ${err.message}`, { error: err.message });
    return json(res, 500, { error: err.message });
  }
}
