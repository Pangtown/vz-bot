process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { getClient } from '../src/vhi/client.js';

process.env.VHI_USER = 'admin';
process.env.VHI_PASSWORD = 'Nexpass8188!';
process.env.VHI_BASE_URL = 'https://172.16.218.7';

async function testSpice() {
  const client = await getClient();
  const base = process.env.VHI_BASE_URL;
  
  const serverId = '0ab6559c-89dc-4e32-ab27-282e26cd41f0';
  console.log(`Testing with server: ${serverId}`);

  const url = `${base}:8774/v2.1/servers/${serverId}/remote-consoles`;

  const tests = [
    {
      name: "remote-console [spice-spice]",
      headers: { 'OpenStack-API-Version': 'compute 2.87' },
      body: { 'remote_console': { protocol: 'spice', type: 'spice' } }
    },
    {
      name: "remote-console [spice-html5]",
      headers: { 'OpenStack-API-Version': 'compute 2.87' },
      body: { 'remote_console': { protocol: 'spice', type: 'spice-html5' } }
    },
    {
        name: "remote-console [vnc-novnc]",
        headers: { 'OpenStack-API-Version': 'compute 2.87' },
        body: { 'remote_console': { protocol: 'vnc', type: 'novnc' } }
    }
  ];

  for (const t of tests) {
    console.log(`\nRunning: ${t.name}`);
    try {
      const res = await client.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...t.headers },
        body: JSON.stringify(t.body)
      });
      console.log(`Status: ${res.status}`);
      const body = await res.text();
      console.log(`Response: ${body}`);
    } catch (err) {
      console.log(`Error: ${err.message}`);
    }
  }
}

testSpice().catch(console.error);
