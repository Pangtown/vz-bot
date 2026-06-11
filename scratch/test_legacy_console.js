process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { getClient } from '../src/vhi/client.js';

process.env.VHI_USER = 'admin';
process.env.VHI_PASSWORD = 'Nexpass8188!';
process.env.VHI_BASE_URL = 'https://172.16.218.7';

const serverId = '0ab6559c-89dc-4e32-ab27-282e26cd41f0';

async function testLegacyConsoles() {
  const client = await getClient();
  const base = process.env.VHI_BASE_URL;
  const url = `${base}:8774/v2.1/servers/${serverId}/action`;

  const tests = [
    {
      name: "os-getSPICEConsole",
      body: { "os-getSPICEConsole": { type: "spice-html5" } }
    },
    {
      name: "os-getVNCConsole",
      body: { "os-getVNCConsole": { type: "novnc" } }
    }
  ];

  for (const t of tests) {
    console.log(`\nTesting: ${t.name}`);
    try {
      const res = await client.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

testLegacyConsoles().catch(console.error);
