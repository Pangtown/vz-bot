/**
 * Health poller – query VHI Compute for server list/status; optional Prometheus later
 */

import { listServers } from '../vhi/compute.js';
import { getThresholds } from './thresholds.js';

export async function runHealthPoll() {
  const servers = await listServers({ limit: 500 });
  const byStatus = {};
  const summary = { total: servers.length, byStatus: {}, alerts: [] };
  for (const s of servers) {
    const st = s.status || 'UNKNOWN';
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  summary.byStatus = byStatus;
  const errorCount = byStatus.ERROR || 0;
  if (errorCount > 0) {
    summary.alerts.push({ type: 'vm_error', count: errorCount, message: `${errorCount} VM(s) in ERROR state` });
  }
  return { summary, vms: servers.map(s => ({ id: s.id, name: s.name, status: s.status })) };
}
