import fs from 'fs';
import os from 'os';
import fetch from 'node-fetch';
import crypto from 'crypto';

// Disable TLS verification for testing
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function testConsoles() {
  const base = process.env.VHI_BASE_URL || 'https://172.16.218.7';
  const user = process.env.VHI_USER || 'admin';
  const pass = process.env.VHI_PASSWORD || '';
  const domain = 'Default';

  console.log('Authenticating...');
  const authRes = await fetch(`${base}:5000/v3/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth: {
        identity: { methods: ['password'], password: { user: { domain: { name: domain }, name: user, password: pass } } },
        scope: { project: { domain: { name: domain }, name: 'admin' } }
      }
    })
  });

  if (!authRes.ok) {
    console.error('Auth failed', authRes.status, await authRes.text());
    return;
  }
  const token = authRes.headers.get('X-Subject-Token');
  console.log('Got token');

  // get a server id
  const srvRes = await fetch(`${base}:8774/v2.1/servers/detail`, {
    headers: { 'X-Auth-Token': token }
  });
  const srvData = await srvRes.json();
  if (!srvData.servers || srvData.servers.length === 0) {
    console.error('No servers found');
    return;
  }
  const serverId = srvData.servers[0].id;
  console.log(`Testing with server ${serverId} (${srvData.servers[0].name})`);

  const url = `${base}:8774/v2.1/servers/${serverId}/action`;

  const combinations = [
    { name: 'os-getVNCConsole no header', headers: {}, body: { 'os-getVNCConsole': { type: 'novnc' } } },
    { name: 'remote-console no header', headers: {}, body: { 'remote-console': { protocol: 'vnc', type: 'novnc' } } },
    { name: 'remote-console compute 2.6', headers: { 'Openstack-Api-Version': 'compute 2.6' }, body: { 'remote-console': { protocol: 'vnc', type: 'novnc' } } },
    { name: 'remote-console compute 2.67', headers: { 'Openstack-Api-Version': 'compute 2.67' }, body: { 'remote-console': { protocol: 'vnc', type: 'novnc' } } },
    { name: 'remote-console compute 2.90', headers: { 'Openstack-Api-Version': 'compute 2.90' }, body: { 'remote-console': { protocol: 'vnc', type: 'novnc' } } },
    { name: 'os-getVNCConsole compute 2.1', headers: { 'Openstack-Api-Version': 'compute 2.1' }, body: { 'os-getVNCConsole': { type: 'novnc' } } }
  ];

  for (const combo of combinations) {
    console.log(`\n--- Testing ${combo.name} ---`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token, ...combo.headers },
      body: JSON.stringify(combo.body)
    });
    
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Response: ${text.slice(0, 300)}`);
  }
}

testConsoles().catch(console.error);
