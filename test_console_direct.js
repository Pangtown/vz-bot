process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import fs from 'fs';
import { getClient } from './src/vhi/client.js';

process.env.VHI_USER = 'admin';
process.env.VHI_PASSWORD = 'Nexpass8188!';
process.env.VHI_BASE_URL = 'https://172.16.218.7';

async function testConsole() {
  const client = await getClient();
  const base = process.env.VHI_BASE_URL;
  
  console.log("Getting servers...");
  const srvRes = await client.fetch(`${base}:8774/v2.1/servers`);
  const srvData = await srvRes.json();
  if (!srvData.servers || srvData.servers.length === 0) {
    console.log("No servers found");
    return;
  }
  const serverId = srvData.servers[0].id;
  console.log(`Testing with server: ${serverId}`);

  const url = `${base}:8774/v2.1/servers/${serverId}/action`;

  const tests = [
    {
      name: "remote-console [compute 2.6]",
      headers: { 'OpenStack-API-Version': 'compute 2.6' },
      body: { 'remote-console': { protocol: 'vnc', type: 'novnc' } }
    },
    {
      name: "remote-console [compute 2.67]",
      headers: { 'OpenStack-API-Version': 'compute 2.67' },
      body: { 'remote-console': { protocol: 'vnc', type: 'novnc' } }
    },
    {
      name: "remote-console [compute 2.87]",
      headers: { 'OpenStack-API-Version': 'compute 2.87' },
      body: { 'remote-console': { protocol: 'vnc', type: 'novnc' } }
    },
    {
      name: "remote-console [Nova 2.6]",
      headers: { 'X-OpenStack-Nova-API-Version': '2.6' },
      body: { 'remote-console': { protocol: 'vnc', type: 'novnc' } }
    },
    {
      name: "remote-console [Nova 2.87]",
      headers: { 'X-OpenStack-Nova-API-Version': '2.87' },
      body: { 'remote-console': { protocol: 'vnc', type: 'novnc' } }
    },
    {
      name: "os-getVNCConsole [no headers]",
      headers: {},
      body: { 'os-getVNCConsole': { type: 'novnc' } }
    }
  ];

  const output = [];
  for (const t of tests) {
    console.log(`Running: ${t.name}`);
    try {
      const res = await client.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...t.headers },
        body: JSON.stringify(t.body)
      });
      const body = await res.text();
      output.push({
        test: t.name,
        status: res.status,
        response: body
      });
    } catch (err) {
      output.push({
        test: t.name,
        error: err.message
      });
    }
  }

  fs.writeFileSync('vnc_diag_results.txt', JSON.stringify(output, null, 2), 'utf8');
  console.log("Diagnostic complete. Results in vnc_diag_results.txt");
}

testConsole().catch(console.error);
