import 'dotenv/config';
import { listServers } from '../src/vhi/compute.js';

process.env.VHI_USER = process.env.VHI_USER || 'admin';
process.env.VHI_PASSWORD = process.env.VHI_PASSWORD || '';
process.env.VHI_BASE_URL = process.env.VHI_BASE_URL || 'https://172.16.218.7';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function run() {
  try {
    const servers = await listServers();
    console.log(`Found ${servers.length} servers`);
    if (servers.length > 0) {
      console.log('First server ID:', servers[0].id);
      console.log('First server name:', servers[0].name);
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
