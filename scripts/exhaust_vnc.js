import 'dotenv/config';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { getClient } from '../src/vhi/client.js';
import fs from 'fs';

process.env.VHI_USER = process.env.VHI_USER || 'admin';
process.env.VHI_PASSWORD = process.env.VHI_PASSWORD || '';
process.env.VHI_BASE_URL = process.env.VHI_BASE_URL || 'https://172.16.218.7';

async function exhaustVnc() {
  const client = await getClient();
  const base = process.env.VHI_BASE_URL;
  const projectId = client.projectId;
  
  // Hardcoded server ID from previous logs
  const serverId = 'eed31a11-d432-4918-99f4-c4119695ac52';
  const url = `${base}:8774/v2.1/${projectId}/servers/${serverId}/action`;

  const results = [];
  const versions = [
    '2.1', '2.6', '2.25', '2.38', '2.53', '2.67', '2.72', '2.87', '2.90'
  ];
  const headerKeys = ['OpenStack-API-Version', 'X-OpenStack-Nova-API-Version'];

  for (const v of versions) {
    for (const key of headerKeys) {
      const val = key === 'OpenStack-API-Version' ? `compute ${v}` : v;
      console.log(`Testing ${key}: ${val}`);
      
      const res = await client.fetch(url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          [key]: val
        },
        body: JSON.stringify({ 'remote-console': { protocol: 'vnc', type: 'novnc' } })
      });
      
      const body = await res.text();
      results.push({ version: v, header: key, value: val, status: res.status, response: body });
      
      if (res.ok) {
        console.log(`   SUCCESS!`);
      } else {
        console.log(`   Failed (${res.status})`);
      }
    }
  }

  fs.writeFileSync('vnc_exhaust_results.json', JSON.stringify(results, null, 2));
}

exhaustVnc().catch(console.error);
