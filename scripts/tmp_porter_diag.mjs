import { getMigrationById } from '../src/vmware/cloud-storage.js';
import { runWithContext } from '../src/gateway/context.js';
import { getImage } from '../src/vhi/image.js';
import { getServer, getConsoleOutput } from '../src/vhi/compute.js';

const id = '9343780e-9304-dd6c-60b1-df61562eb8cb';
const mig = await getMigrationById(id);
if (!mig?.context?.vhiPassword) {
  console.error('migration or credentials missing');
  process.exit(1);
}
const porterId = mig.windowsWorkerId || '4fff2056-6bb2-4af7-a429-a99bdfdc7c29';
const imageId = mig.windowsImageId || '58e62ff7-c8c3-402a-b2e9-0604b405a57a';
await runWithContext(mig.context, async () => {
  const img = await getImage(imageId);
  const keep = {};
  for (const [k, v] of Object.entries(img || {})) {
    if (['file', 'self', 'schema', 'direct_url', 'locations'].includes(k)) continue;
    keep[k] = v;
  }
  console.log('IMAGE', JSON.stringify(keep, null, 2));
  const srv = await getServer(porterId);
  console.log('SERVER', JSON.stringify({
    id: srv?.id,
    status: srv?.status,
    name: srv?.name,
    metadata: srv?.metadata,
    image: srv?.image,
    config_drive: srv?.config_drive,
    addresses: srv?.addresses,
    flavor: srv?.flavor,
  }, null, 2));
  try {
    const out = await getConsoleOutput(porterId, 16000);
    console.log('CONSOLE_LEN', String(out || '').length);
    console.log('CONSOLE', String(out || '').slice(-2000));
  } catch (err) {
    console.log('CONSOLE_ERR', err.message);
  }
});
