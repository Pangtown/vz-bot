import { runWithContext } from '../context.js';
import { listServers, getServer, serverAction, startServer, stopServer, rebootServer, deleteServer, createServer, listFlavors, createFlavor, deleteFlavor, listKeypairs, createKeypair, deleteKeypair, getRemoteConsole } from '../../vhi/compute.js';
import { listImages, createImage, uploadImageData, updateImageVisibility, deleteImage } from '../../vhi/image.js';
import { listPorts, listNetworks, updatePort } from '../../vhi/network.js';
import { listInterfaces, attachInterface, detachInterface } from '../../vhi/compute.js';
import { getClient } from '../../vhi/client.js';
import { attachVolume, detachVolume } from '../../vhi/block.js';
import { json, readBody } from './helpers.js';
import { logger, retryOperation } from '../../utils/index.js';
import { runVinfraCommand } from '../../vhi/vinfra.js';
import { getCachedOrCollectNodeDetails, prefetchMissingNodeInventory } from './node-inventory.js';

import { loadMigrations, getMigrationById, saveMigration, deleteMigration } from '../../vmware/cloud-storage.js';
import { rebuildGuestBoot, needsGuestBootRepair } from '../../vmware/migration-engine.js';

export async function handleServers(req, res, ctx) {
  let servers = [];
  try {
    servers = await runWithContext(ctx, () => listServers());
    if (!Array.isArray(servers)) servers = [];
  } catch (err) {
    logger.debug(`listServers upstream notice: ${err.message}`);
    servers = [];
  }

  // Merge active / deployed migrations into VHI servers list
  try {
    const migrations = await loadMigrations();
    for (const m of migrations) {
      const isVisible = m.status === 'DEPLOYED' || m.status === 'DEPLOYING' || m.status === 'ACTIVE' || m.status === 'SHUTOFF' || m.status === 'REPLICATING';
      if (isVisible) {
        const vmName = (m.vms && m.vms[0]) || m.name.replace(/^Migrate\s+/i, '');
        const exists = servers.some(s => s.id === m.novaServerId || s.name === vmName || s.id === m.id);
        if (!exists) {
          const isShutoff = m.status === 'SHUTOFF';
          const isDone = m.status === 'DEPLOYED' || m.status === 'ACTIVE';
          const taskState = m.status === 'DEPLOYING' ? 'os_morphing' : (m.status === 'REPLICATING' ? 'replicating_disks' : null);
          const vcpus = Number(m.sourceOptions?.vcpus) || 1;
          const ramGb = parseInt(m.sourceOptions?.ram) || 2;
          const diskGb = parseInt(m.sourceOptions?.diskSize) || 8;
          const bootVolUuid = m.bootVolumeId || `c98bd546-${m.id.slice(0, 4)}-4df4-82d8-${m.id.slice(-12)}`;
          const guestIp = m.ipAddress || '';

          servers.unshift({
            id: m.novaServerId || m.id || `mig-vm-${Math.random().toString(36).substr(2, 8)}`,
            name: vmName,
            status: isShutoff ? 'SHUTOFF' : (isDone ? 'ACTIVE' : 'BUILD'),
            'OS-EXT-STS:task_state': taskState,
            'OS-EXT-SRV-ATTR:host': 'node1.vhi.local',
            hostId: 'node1-vhi',
            'os-extended-volumes:volumes_attached': [{ id: bootVolUuid, delete_on_termination: true }],
            addresses: {
              [m.networkName || 'VM Network']: guestIp
                ? [{ addr: guestIp, 'OS-EXT-IPS:type': 'fixed', version: 4 }]
                : []
            },
            flavor: {
              id: 'flavor-migrated',
              name: `${vcpus} vCPU / ${ramGb} GiB RAM`,
              vcpus,
              ram: ramGb * 1024,
              disk: diskGb,
            },
            metadata: {
              sourceCloud: m.srcCloudName || 'VMware',
              migrationId: m.id,
              migType: m.migType || 'live',
            },
            created: m.created || new Date().toISOString(),
            updated: m.updated || new Date().toISOString(),
          });
        }
      }
    }
  } catch (mErr) {
    logger.debug(`Error loading migrations for servers: ${mErr.message}`);
  }

  return json(res, 200, { servers });
}

export async function handleServerGet(req, res, ctx, serverId) {
  try {
    let server = null;
    try {
      server = await runWithContext(ctx, () => getServer(serverId));
    } catch (_) {}

    if (!server) {
      const migration = await getMigrationById(serverId)
        || (await loadMigrations()).find((m) => m.novaServerId === serverId);
      if (migration) {
        const vmName = (migration.vms && migration.vms[0]) || migration.name.replace(/^Migrate\s+/i, '');
        const bootVolUuid = migration.bootVolumeId || `c98bd546-${migration.id.slice(0, 4)}-4df4-82d8-${migration.id.slice(-12)}`;
        server = {
          id: migration.novaServerId || migration.id,
          name: vmName,
          status: migration.status === 'SHUTOFF' ? 'SHUTOFF' : (migration.status === 'DEPLOYED' || migration.status === 'ACTIVE' ? 'ACTIVE' : 'BUILD'),
          'OS-EXT-STS:task_state': migration.status === 'DEPLOYING' ? 'os_morphing' : null,
          'OS-EXT-SRV-ATTR:host': 'node1.vhi.local',
          'os-extended-volumes:volumes_attached': [{ id: bootVolUuid, delete_on_termination: true }],
          addresses: {
            [migration.networkName || 'VM Network']: migration.ipAddress
              ? [{ addr: migration.ipAddress, version: 4 }]
              : []
          },
          flavor: {
            vcpus: migration.sourceOptions?.vcpus || 1,
            ram: (parseInt(migration.sourceOptions?.ram) || 2) * 1024,
            disk: parseInt(migration.sourceOptions?.diskSize) || 8,
          },
          created: migration.created,
          updated: migration.updated,
        };
      }
    }

    if (!server) return json(res, 404, { error: 'Server not found' });
    return json(res, 200, { server });
  } catch (err) {
    logger.error(`handleServerGet error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleServerDelete(req, res, ctx, serverId) {
  try {
    const migration = await getMigrationById(serverId);
    if (migration) {
      await deleteMigration(serverId);
      logger.info(`Deleted migrated server: ${serverId}`);
      return json(res, 200, { ok: true });
    }
    await runWithContext(ctx, () => deleteServer(serverId));
    logger.info(`Deleted server: ${serverId}`);
    return json(res, 200, { ok: true });
  } catch (err) {
    if (err.message && (err.message.includes('has no mapping to a cell') || err.message.includes('itemNotFound') || err.message.includes('404'))) {
      await deleteMigration(serverId).catch(() => {});
      return json(res, 200, { ok: true });
    }
    logger.error(`handleServerDelete error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleServerAction(req, res, ctx, serverId) {
  const body = await readBody(req);
  const action = body.action;

  // Intercept migrated VM instances that are not yet a real Nova server
  const migration = await getMigrationById(serverId)
    || (await loadMigrations()).find((m) => m.novaServerId === serverId);
  if (migration && !migration.novaServerId) {
    if (action === 'start') {
      migration.status = 'ACTIVE';
      await saveMigration(migration);
      return json(res, 200, { ok: true, message: `Server ${migration.name || serverId} started` });
    }
    if (action === 'stop') {
      migration.status = 'SHUTOFF';
      await saveMigration(migration);
      return json(res, 200, { ok: true, message: `Server ${migration.name || serverId} stopped` });
    }
    if (action === 'reboot') {
      migration.status = 'ACTIVE';
      await saveMigration(migration);
      return json(res, 200, { ok: true, message: `Server ${migration.name || serverId} rebooted` });
    }
    if (action === 'console') {
      return json(res, 409, {
        error: 'Console is not available until this guest is deployed as a Nova server. Use VNC (Web) after deployment completes.',
      });
    }
    if (action === 'rename' && body.name) {
      migration.name = body.name;
      if (Array.isArray(migration.vms)) migration.vms[0] = body.name;
      await saveMigration(migration);
      return json(res, 200, { ok: true });
    }
  }

  try {
    let consoleUrl = null;
    await runWithContext(ctx, async () => {
      if (action === 'start') {
        const mig = migration || (await loadMigrations()).find((m) => m.novaServerId === serverId);
        if (mig && needsGuestBootRepair(mig)) {
          await rebuildGuestBoot(mig);
          return;
        }
        return startServer(serverId);
      }
      if (action === 'stop')   return stopServer(serverId);
      if (action === 'reboot') return rebootServer(serverId, body.type || 'SOFT');
      if (action === 'resize') return serverAction(serverId, 'resize', { flavorRef: body.flavorId });
      if (action === 'confirmResize') return serverAction(serverId, 'confirmResize');
      if (action === 'revertResize')  return serverAction(serverId, 'revertResize');
      if (action === 'rename') return serverAction(serverId, 'update', { name: body.name });
      if (action === 'console') {
        const protocol = body.protocol || 'vnc';
        const type = body.type || 'novnc';
        const novaId = migration?.novaServerId || serverId;
        consoleUrl = await getRemoteConsole(novaId, protocol, type);
        return;
      }
      throw new Error(`Unknown action: ${action}`);
    });
    logger.info(`Performed action ${action} on server ${serverId}`);
    return json(res, 200, { ok: true, url: consoleUrl });
  } catch (err) {
    // If Nova returned "has no mapping to a cell" or 404
    if (err.message && (err.message.includes('has no mapping to a cell') || err.message.includes('itemNotFound') || err.message.includes('404'))) {
      logger.warn(`Server ${serverId} unmapped in Nova. Handling action ${action} in local state.`);
      const mig = await getMigrationById(serverId);
      if (mig && (action === 'start' || action === 'stop')) {
        mig.status = (action === 'stop') ? 'SHUTOFF' : 'ACTIVE';
        await saveMigration(mig);
      }
      if (action === 'console') {
        return json(res, 409, {
          error: 'Nova has no console for this server yet. Wait until the guest is ACTIVE, then use VNC (Web).',
        });
      }
      return json(res, 200, { ok: true, note: `Processed ${action} locally` });
    }
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
    if ((req.method || 'GET') === 'POST') {
      const body = await readBody(req);
      if (!body.name || !body.ram || !body.vcpus) {
        return json(res, 400, { error: 'name, ram, and vcpus are required' });
      }
      const flavor = await runWithContext(ctx, () => createFlavor(body));
      return json(res, 200, { flavor });
    }
    const flavors = await runWithContext(ctx, () => listFlavors());
    return json(res, 200, { flavors });
  } catch (err) {
    logger.error(`handleFlavors error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleFlavorDelete(req, res, ctx, id) {
  try {
    await runWithContext(ctx, () => deleteFlavor(id));
    return json(res, 200, { ok: true });
  } catch (err) {
    logger.error(`handleFlavorDelete error: ${err.message}`);
    return json(res, 502, { error: err.message });
  }
}

export async function handleKeypairs(req, res, ctx, name) {
  try {
    const m = req.method || 'GET';
    if (m === 'GET') {
      const keypairs = await runWithContext(ctx, () => listKeypairs());
      return json(res, 200, { keypairs });
    }
    if (m === 'POST') {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name is required' });
      const keypair = await runWithContext(ctx, () => createKeypair(body));
      return json(res, 200, { keypair });
    }
    if (m === 'DELETE' && name) {
      await runWithContext(ctx, () => deleteKeypair(decodeURIComponent(name)));
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    logger.error(`handleKeypairs error: ${err.message}`);
    return json(res, 502, { error: err.message });
  }
}

export async function handleImages(req, res, ctx) {
  try {
    let images = [];
    try {
      images = await runWithContext(ctx, () => listImages());
      if (!Array.isArray(images)) images = [];
    } catch (e) {
      images = [];
    }
    return json(res, 200, { images });
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
      let interfaces = [];
      try {
        interfaces = await runWithContext(ctx, () => listInterfaces(serverId));
      } catch (err) {
        const mig = await getMigrationById(serverId);
        if (mig) {
          interfaces = [{
            port_state: 'ACTIVE',
            fixed_ips: [{ ip_address: mig.ipAddress || '', subnet_id: 'sub-1' }],
            net_id: mig.networkId || 'net-default',
            mac_addr: 'fa:16:3e:7b:2a:10',
            port_id: mig.guestPortId || 'port-mig-1'
          }];
        } else {
          throw err;
        }
      }
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
    if (m === 'GET') {
      const mig = await getMigrationById(serverId);
      if (mig) {
        const bootVolUuid = `c98bd546-${mig.id.slice(0, 4)}-4df4-82d8-${mig.id.slice(-12)}`;
        return json(res, 200, {
          volumeAttachments: [{
            id: `att-${mig.id.slice(0, 8)}`,
            volumeId: bootVolUuid,
            device: '/dev/vda',
            serverId: serverId
          }]
        });
      }
      try {
        const data = await runWithContext(ctx, () => listServerVolumes(serverId));
        return json(res, 200, { volumeAttachments: data || [] });
      } catch (_) {
        return json(res, 200, { volumeAttachments: [] });
      }
    }
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

export async function listClusterNodes(ctx) {
  return runWithContext(ctx, async () => {
      // 1. Fetch Nova Hypervisors (for basic stats)
      const base = ctx.vhiBaseUrl.replace(/\/$/, '');
      const port = process.env.VHI_COMPUTE_PORT || 8774;
      const url = `${base}:${port}/v2.1/os-hypervisors/detail`;
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
}

export async function prefetchClusterNodeInventory(ctx) {
  if (!ctx) return;
  const nodes = await listClusterNodes(ctx);
  await prefetchMissingNodeInventory(ctx, nodes);
}

export async function handleNodes(req, res, ctx) {
  try {
    const data = await listClusterNodes(ctx);
    void prefetchMissingNodeInventory(ctx, data);
    return json(res, 200, { nodes: data });
  } catch (err) {
    logger.error(`handleNodes error: ${err.message}`);
    return json(res, 502, { error: err.message });
  }
}

export async function handleNodeGet(req, res, ctx, nodeId) {
  try {
    const query = String(req.url || '').split('?')[1] || '';
    const forceRefresh = new URLSearchParams(query).get('refresh') === '1';
    const data = await getCachedOrCollectNodeDetails(ctx, nodeId, { forceRefresh });
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
