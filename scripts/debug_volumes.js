import { listVolumes, getVolume } from '../src/vhi/block.js';
import { runWithContext } from '../src/gateway/context.js';
import { getClient } from '../src/vhi/client.js';

const ctx = {
  vhiBaseUrl: process.env.VHI_BASE_URL,
  vhiUser: process.env.VHI_USER,
  vhiPassword: process.env.VHI_PASSWORD,
  vhiProject: 'admin'
};

async function debug() {
  console.log('--- STARTING VERBOSE DEBUG ---');
  console.log('Context Base URL:', ctx.vhiBaseUrl);
  
  try {
    await runWithContext(ctx, async () => {
      const client = await getClient();
      console.log('Token Scope Project ID:', client.projectId);
      
      console.log('Fetching volumes list...');
      const volumes = await listVolumes();
      console.log(`Found ${volumes.length} volumes`);
      
      if (volumes.length > 0) {
        const sampleId = volumes[0].id;
        console.log(`\nTesting getVolume for ID: ${sampleId}`);
        const vol = await getVolume(sampleId);
        if (vol) {
          console.log('SUCCESS: Got volume:', JSON.stringify(vol, null, 2).slice(0, 200));
        } else {
          console.log('FAILURE: getVolume returned null');
        }
      }
    });
  } catch (err) {
    console.error('CRITICAL ERROR:', err.stack);
  }
  console.log('--- DEBUG FINISHED ---');
}

debug();
