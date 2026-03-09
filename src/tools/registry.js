/**
 * Tool registry – execute tool by name with allowlist check
 */

import * as vmLifecycle from './vm-lifecycle.js';
import * as storage from './storage.js';
import * as health from './health.js';

const TOOLS = {
  list_vms: vmLifecycle.listVms,
  get_vm: vmLifecycle.getVm,
  reboot_vm: vmLifecycle.rebootVm,
  start_vm: vmLifecycle.startVm,
  stop_vm: vmLifecycle.stopVm,
  create_vm: vmLifecycle.createVm,
  run_health_check: health.runHealthCheck,
  list_volumes: storage.listVolumes,
  list_networks: storage.listNetworks,
  create_volume: storage.createVolume,
  create_network: storage.createNetwork,
};

const ALLOWED_WITHOUT_CONFIRM = new Set(['list_vms', 'get_vm', 'run_health_check', 'list_volumes', 'list_networks']);

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
