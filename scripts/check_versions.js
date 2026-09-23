// Disable TLS verification for testing
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fetch from 'node-fetch';
import { getClient } from '../src/vhi/client.js';
import { getContextValue } from '../src/gateway/context.js';

// Mock context for the script
process.env.VHI_BASE_URL = 'https://172.16.218.7';
// Note: real credentials should be in env or provided by user

async function checkVersions() {
  const client = await getClient();
  const base = process.env.VHI_BASE_URL;
  
  // Get token info including catalog
  const { getToken } = await import('../src/vhi/identity.js');
  // We need the full token response to see the catalog
  // Modified getToken in mind... wait, getToken only returns token and expiresAt.
  // I'll just fetch the catalog directly here.
  
  const authUrl = `${base}:5000/v3/auth/tokens`;
  const user = process.env.VHI_USER;
  const password = process.env.VHI_PASSWORD;
  
  const body = {
    auth: {
      identity: {
        methods: ['password'],
        password: {
          user: {
            name: user,
            domain: { name: 'Default' },
            password,
          },
        },
      },
      scope: {
        project: {
          name: 'admin',
          domain: { name: 'Default' },
        },
      },
    },
  };

  const authRes = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await authRes.json();
  console.log("Service Catalog:");
  data.token.catalog.forEach(s => {
    console.log(`- Service: ${s.type} (${s.name})`);
    s.endpoints.forEach(e => {
      console.log(`  - ${e.interface}: ${e.url}`);
    });
  });

  const computeUrl = data.token.catalog.find(s => s.type === 'compute')?.endpoints.find(e => e.interface === 'public')?.url;
  console.log(`\nDetected Compute URL: ${computeUrl}`);

  if (computeUrl) {
    const rootUrl = computeUrl.split('/v2.1')[0] + '/';
    console.log(`\nChecking root versions at ${rootUrl}`);
    const resRoot = await client.fetch(rootUrl);
    if (resRoot.ok) {
      console.dir(await resRoot.json(), { depth: null });
    } else {
      console.log(`Root check failed: ${resRoot.status}`);
    }

    const v21Url = computeUrl.split('/aeba')[0]; // Try to get /v2.1 root
    console.log(`\nChecking v2.1 versions at ${v21Url}`);
    const resV21 = await client.fetch(v21Url);
    if (resV21.ok) {
      console.dir(await resV21.json(), { depth: null });
    } else {
      console.log(`v2.1 check failed: ${resV21.status}`);
    }
  }
}

checkVersions().catch(console.error);
