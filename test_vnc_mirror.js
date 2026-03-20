process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { getClient } from './src/vhi/client.js';

process.env.VHI_USER = 'admin';
process.env.VHI_PASSWORD = 'Nexpass8188!';
process.env.VHI_BASE_URL = 'https://172.16.218.7';

async function mirrorPython() {
  const client = await getClient();
  const base = process.env.VHI_BASE_URL;
  
  // Get token and catalog to find the EXACT compute URL
  const authUrl = `${base}:5000/v3/auth/tokens`;
  const authRes = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth: {
        identity: { methods: ['password'], password: { user: { domain: { name: 'Default' }, name: 'admin', password: 'Nexpass8188!' } } },
        scope: { project: { domain: { name: 'Default' }, name: 'admin' } }
      }
    })
  });
  const authData = await authRes.json();
  const computeUrl = authData.token.catalog.find(s => s.type === 'compute')?.endpoints.find(e => e.interface === 'public')?.url;
  const token = authRes.headers.get('x-subject-token');

  console.log(`Detected Catalog Compute URL: ${computeUrl}`);

  // Server ID
  const serverId = 'eed31a11-d432-4918-99f4-c4119695ac52';
  const api_url = `${computeUrl}/servers/${serverId}/action`;
  
  console.log(`Hitting ${api_url}`);

  const payload = { "os-getVNCConsole": { "type": "novnc" } };
  
  const res = await fetch(api_url, {
    method: 'POST',
    headers: { 
      'X-Auth-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  console.log(`Status: ${res.status}`);
  console.log(`Response: ${await res.text()}`);
}

mirrorPython().catch(console.error);
