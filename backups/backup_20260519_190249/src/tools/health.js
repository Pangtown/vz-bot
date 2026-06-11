/**
 * Health check tool – aggregate VM status and optional thresholds
 */

import { listServers } from '../vhi/compute.js';

export async function runHealthCheck(args = {}) {
  const servers = await listServers({ limit: 200 });
  const byStatus = {};
  for (const s of servers) {
    const st = s.status || 'UNKNOWN';
    byStatus[st] = (byStatus[st] || 0) + 1;
  }
  return {
    summary: `${servers.length} VM(s) total`,
    byStatus,
    vms: servers.map(s => ({ id: s.id, name: s.name, status: s.status })),
  };
}
