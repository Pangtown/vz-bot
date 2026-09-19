/**
 * Collect and cache physical node hardware. Inventory is gathered once
 * per node id (or when ?refresh=1) and reused for the details drawer.
 */

import { runWithContext } from '../context.js';
import { getHypervisor, listHypervisors } from '../../vhi/compute.js';
import { listPorts, listNetworks } from '../../vhi/network.js';
import { logger, retryOperation } from '../../utils/index.js';
import { runVinfraCommand, runVinfraBatch } from '../../vhi/vinfra.js';
import { normalizeNodeDetails, applySshInventory, mergeHypervisorIntoNode, normalizeDisks } from './node-details.js';
import {
  clusterKey,
  getNodeInventory,
  listCachedNodeIds,
  saveNodeInventory,
  updateManyNodeLiveStats,
} from '../../vhi/node-inventory-store.js';

const inFlight = new Map();
const liveByKey = new Map();
let prefetchChain = Promise.resolve();

function withTimeout(promise, ms, label = 'timed out') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms)),
  ]);
}

function liveKey(baseUrl, nodeId) {
  return `${clusterKey(baseUrl)}:${String(nodeId)}`;
}

export function pickLiveStats(node) {
  if (!node || typeof node !== 'object') return {};
  const live = {};
  for (const field of [
    'status', 'state', 'vcpus', 'vcpus_used', 'memory_mb', 'free_ram_mb',
    'running_vms', 'local_gb', 'free_disk_gb', 'host_ip', 'external_ip',
  ]) {
    if (node[field] != null) live[field] = node[field];
  }
  return live;
}

export function rememberLiveStats(baseUrl, nodes) {
  for (const node of nodes || []) {
    if (!node?.id) continue;
    liveByKey.set(liveKey(baseUrl, node.id), pickLiveStats(node));
  }
}

function presentRecord(rec, baseUrl, nodeId, cached) {
  const memLive = liveByKey.get(liveKey(baseUrl, nodeId)) || {};
  return {
    ...(rec.hardware || {}),
    ...(rec.live || {}),
    ...memLive,
    collectedAt: rec.collectedAt || null,
    _cached: cached,
  };
}

async function findNeutronNodeIps(hostname) {
  try {
    const [ports, networks] = await Promise.race([
      Promise.all([listPorts(), listNetworks()]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Neutron discovery timed out (4s)')), 4000)),
    ]);

    const netMap = {};
    networks.forEach((n) => { netMap[n.id] = n.name; });

    const nodePorts = ports.filter((p) => p['binding:host_id'] === hostname || p['binding:host_id'] === hostname.split('.')[0]);
    return nodePorts.map((p) => ({
      name: netMap[p.network_id] || p.name || p.id.slice(0, 8),
      type: p.device_owner,
      mac: p.mac_address,
      ips: (p.fixed_ips || []).map((f) => f.ip_address),
    }));
  } catch (err) {
    logger.error(`[VHI-API] findNeutronNodeIps failed for ${hostname}: ${err.message}`);
    return [];
  }
}

export async function collectNodeHardware(nodeId) {
  let nodeDetails;
  try {
    nodeDetails = await withTimeout(
      retryOperation(() => runVinfraCommand(['node', 'show', nodeId]), { maxAttempts: 2 }),
      15000,
      'Vinfra node show timed out',
    );
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
      _host_ip: hNode.host_ip,
    };
  }

  nodeDetails = normalizeNodeDetails(nodeDetails);

  try {
    const vDisks = await withTimeout(runVinfraCommand(['node', 'disk', 'list', '--node', nodeId]), 10000, 'Vinfra disk list timed out');
    const extra = normalizeDisks(Array.isArray(vDisks) ? vDisks : (vDisks && (vDisks.disks || vDisks.items)));
    if (extra.length) {
      nodeDetails.disks = extra;
    }
  } catch (diskErr) {
    logger.debug(`[VHI-API] vinfra node disk list skipped: ${diskErr.message}`);
  }

  try {
    const hypervisors = await listHypervisors();
    const host = String(nodeDetails.hostname || '').toLowerCase();
    const short = host.split('.')[0];
    const hv = (hypervisors || []).find((h) => {
      const hh = String(h.hypervisor_hostname || '').toLowerCase();
      return hh === host || hh.split('.')[0] === short || String(h.id) === String(nodeId);
    });
    if (hv) mergeHypervisorIntoNode(nodeDetails, hv);
  } catch (hvErr) {
    logger.debug(`[VHI-API] hypervisor merge skipped: ${hvErr.message}`);
  }

  let discoveredIps = false;

  try {
    logger.debug(`[VHI-API] Fetching Virtuozzo logical network configuration for node ${nodeId}...`);
    const [clusterNets, nodeIfaces] = await Promise.all([
      withTimeout(retryOperation(() => runVinfraCommand(['cluster', 'network', 'list']), { maxAttempts: 2 }), 10000, 'cluster network list timed out'),
      withTimeout(retryOperation(() => runVinfraCommand(['node', 'iface', 'list', '--node', nodeId]), { maxAttempts: 2 }), 10000, 'node iface list timed out'),
    ]);

    if (Array.isArray(clusterNets) && Array.isArray(nodeIfaces)) {
      const netMap = {};
      clusterNets.forEach((net) => {
        netMap[net.id] = net;
      });

      const logicalNetworks = nodeIfaces
        .filter((iface) => iface.state === 'up')
        .map((iface) => {
          const logicalNet = iface.network ? netMap[iface.network] : null;
          const netName = logicalNet ? logicalNet.name : (iface.network ? 'Unknown' : 'Unassigned');
          const trafficTypes = logicalNet ? (logicalNet.traffic_types || []) : [];
          const cleanIps = (iface.ipv4 || []).map((ip) => ip.split('/')[0]);

          return {
            name: netName,
            ifname: iface.name,
            mac: iface.mac || iface.address || null,
            ips: cleanIps,
            traffic_types: trafficTypes,
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

  if (!discoveredIps) {
    try {
      const sshHost = nodeDetails.external_ip || nodeDetails._host_ip || nodeDetails.hostname;
      if (sshHost) {
        logger.debug(`[VHI-API] Fetching real network state via SSH for ${sshHost}...`);
        const rawInterfaces = await withTimeout(
          retryOperation(() => runVinfraCommand(['/sbin/ip', '-j', 'addr'], { host: sshHost }), { maxAttempts: 2 }),
          10000,
          'SSH ip addr timed out',
        );

        if (Array.isArray(rawInterfaces)) {
          const realNetworks = rawInterfaces
            .filter((iface) => iface.ifname !== 'lo')
            .map((iface) => ({
              name: iface.ifname,
              mac: iface.address,
              ips: (iface.addr_info || []).map((a) => a.local).filter(Boolean),
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

  if (!discoveredIps || (nodeDetails.networks || []).length <= 1) {
    const hostname = nodeDetails.hostname || nodeDetails.hypervisor_hostname;
    if (hostname) {
      logger.debug(`[VHI-API] Fetching network state via Neutron for ${hostname}...`);
      const neutronNetworks = await findNeutronNodeIps(hostname);
      if (neutronNetworks.length > 0) {
        const publicNet = neutronNetworks.find((n) =>
          /public|external|internet/i.test(n.name) ||
          (n.ips || []).some((ip) => !ip.startsWith('10.') && !ip.startsWith('192.168.') && !ip.startsWith('172.')));
        if (publicNet && publicNet.ips && publicNet.ips.length > 0) {
          nodeDetails.external_ip = publicNet.ips[0];
        }
      }
    }
  }

  const hwHost = nodeDetails.external_ip || nodeDetails.host_ip || nodeDetails._host_ip;
  if (hwHost) {
    try {
      const hw = await withTimeout(runVinfraBatch([
        ['/usr/sbin/dmidecode', '-t', 'system'],
        ['/usr/sbin/dmidecode', '-t', 'bios'],
        ['/usr/sbin/dmidecode', '-t', 'processor'],
        ['/usr/sbin/dmidecode', '-t', 'memory'],
        ['/usr/bin/lsblk', '-J', '-b', '-o', 'NAME,SIZE,TYPE,MODEL,SERIAL,ROTA,TRAN,VENDOR'],
      ], { host: hwHost }), 20000, 'SSH hardware inventory timed out');
      applySshInventory(nodeDetails, hw);
    } catch (hwErr) {
      logger.debug(`[VHI-API] SSH hardware inventory skipped: ${hwErr.message}`);
    }
  }

  return normalizeNodeDetails(nodeDetails);
}

async function collectAndStore(ctx, nodeId) {
  const hardware = await runWithContext(ctx, () => collectNodeHardware(nodeId));
  await saveNodeInventory(ctx.vhiBaseUrl, nodeId, hardware, pickLiveStats(hardware));
  const rec = await getNodeInventory(ctx.vhiBaseUrl, nodeId);
  logger.info(`[VHI-API] Cached physical inventory for node ${nodeId} (${hardware.hostname || nodeId})`);
  return presentRecord(rec || { hardware, collectedAt: new Date().toISOString() }, ctx.vhiBaseUrl, nodeId, false);
}

export async function getCachedOrCollectNodeDetails(ctx, nodeId, { forceRefresh = false } = {}) {
  const id = String(nodeId);
  const key = liveKey(ctx.vhiBaseUrl, id);

  if (!forceRefresh) {
    const rec = await getNodeInventory(ctx.vhiBaseUrl, id);
    if (rec?.hardware) {
      return presentRecord(rec, ctx.vhiBaseUrl, id, true);
    }
  }

  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const work = collectAndStore(ctx, id).finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}

async function prefetchMissingInner(ctx, nodes) {
  const list = (nodes || []).filter((n) => n && n.id);
  rememberLiveStats(ctx.vhiBaseUrl, list);
  await updateManyNodeLiveStats(
    ctx.vhiBaseUrl,
    list.map((n) => ({ nodeId: n.id, live: pickLiveStats(n) })),
  );

  const cached = await listCachedNodeIds(ctx.vhiBaseUrl);
  const missing = list.filter((n) => !cached.has(String(n.id)));
  if (!missing.length) return;

  logger.info(`[VHI-API] Prefetching physical inventory for ${missing.length} new node(s)`);
  for (const node of missing) {
    try {
      await getCachedOrCollectNodeDetails(ctx, node.id);
    } catch (err) {
      logger.warn(`[VHI-API] Prefetch inventory failed for ${node.id}: ${err.message}`);
    }
  }
}

export function prefetchMissingNodeInventory(ctx, nodes) {
  if (!ctx || !nodes?.length) return prefetchChain;
  prefetchChain = prefetchChain
    .then(() => prefetchMissingInner(ctx, nodes))
    .catch((err) => logger.warn(`[VHI-API] Node inventory prefetch: ${err.message}`));
  return prefetchChain;
}
