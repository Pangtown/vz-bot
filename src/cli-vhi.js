#!/usr/bin/env node
/**
 * CLI to test VHI 7.x client: list VMs, reboot VM
 * Usage: node src/cli-vhi.js list | reboot <server-id>
 */

import 'dotenv/config';
import { listServers, rebootServer, getServer } from './vhi/compute.js';

const [,, cmd, id] = process.argv;

async function main() {
  if (cmd === 'list') {
    const servers = await listServers({ limit: 50 });
    console.log(JSON.stringify(servers.map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      created: s.created,
    })), null, 2));
    return;
  }
  if (cmd === 'reboot' && id) {
    await rebootServer(id);
    console.log('Reboot requested for server', id);
    return;
  }
  if (cmd === 'get' && id) {
    const s = await getServer(id);
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  console.log('Usage: node src/cli-vhi.js list | get <id> | reboot <server-id>');
  process.exit(1);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
