/**
 * Tool registry – execute tool by name with allowlist check
 */

import * as vmLifecycle from './vm-lifecycle.js';
import * as storage from './storage.js';
import * as network from './network.js';
import * as image from './image.js';
import * as health from './health.js';
import * as vinfra from './vinfra.js';

const TOOLS = {
  // VM
  list_vms: vmLifecycle.listVms,
  get_vm: vmLifecycle.getVm,
  reboot_vm: vmLifecycle.rebootVm,
  start_vm: vmLifecycle.startVm,
  stop_vm: vmLifecycle.stopVm,
  create_vm: vmLifecycle.createVm,
  delete_vm: vmLifecycle.deleteVm,

  // Storage
  list_volumes: storage.listVolumes,
  list_volume_types: storage.listVolumeTypes,
  get_volume: storage.getVolume,
  create_volume: storage.createVolume,
  delete_volume: storage.deleteVolume,
  attach_volume: storage.attachVolume,
  detach_volume: storage.detachVolume,

  // Network
  list_networks: network.listNetworks,
  get_network: network.getNetwork,
  create_network: network.createNetwork,
  delete_network: network.deleteNetwork,
  list_subnets: network.listSubnets,
  create_subnet: network.createSubnet,
  delete_subnet: network.deleteSubnet,

  // Image
  list_images: image.listImages,
  get_image: image.getImage,

  // Health
  run_health_check: health.runHealthCheck,

  // Vinfra CLI
  execute_vinfra_cli: vinfra.vinfraCli.execute,
};

const ALLOWED_WITHOUT_CONFIRM = new Set([
  'list_vms', 'get_vm',
  'list_volumes', 'get_volume', 'list_volume_types',
  'list_networks', 'get_network', 'list_subnets',
  'list_images', 'get_image',
  'run_health_check'
]);

export function isAllowed(name, confirmed = false) {
  if (ALLOWED_WITHOUT_CONFIRM.has(name)) return true;
  if (confirmed) return true;
  return false;
}

export async function run(name, args) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(args || {});
}

export function listToolNames() {
  return Object.keys(TOOLS);
}
