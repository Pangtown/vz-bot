import 'dotenv/config';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { getClient } from './src/vhi/client.js';

process.env.VHI_USER = process.env.VHI_USER || 'admin';
process.env.VHI_PASSWORD = process.env.VHI_PASSWORD || '';
process.env.VHI_BASE_URL = process.env.VHI_BASE_URL || 'https://172.16.218.7';

async function testModernVnc() {
  const client = await getClient();
  const base = process.env.VHI_BASE_URL;
  const projectId = client.projectId;
  
  // Server ID
  const serverId = 'eed31a11-d432-4918-99f4-c4119695ac52';
  
  // Correct endpoint for Nova 2.6+
  const url = `${base}:8774/v2.1/${projectId}/servers/${serverId}/remote-consoles`;
  
  console.log(`Hitting ${url}`);

  const payload = {
    "remote_console": {
        "protocol": "vnc",
        "type": "novnc"
    }
  };
  
  // MUST SEND MICROVERSION HEADER >= 2.6
  const res = await client.fetch(url, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'OpenStack-API-Version': 'compute 2.87'
    },
    body: JSON.stringify(payload)
  });

  console.log(`Status: ${res.status}`);
  const body = await res.text();
  console.log(`Response: ${body}`);
}

testModernVnc().catch(console.error);
