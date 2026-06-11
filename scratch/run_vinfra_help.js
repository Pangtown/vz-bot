import { runVinfraCommand } from '../src/vhi/vinfra.js';

process.env.VHI_USER = 'admin';
process.env.VHI_PASSWORD = 'Nexpass8188!';
process.env.VHI_BASE_URL = 'https://172.16.218.7';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.VHI_SSH_HOST = '172.16.218.7';
process.env.VHI_SSH_USER = 'root';
process.env.VHI_SSH_PASSWORD = 'Nexpass8188!';

async function run() {
  try {
    console.log('Running vinfra service compute server --help...');
    const help = await runVinfraCommand(['service', 'compute', 'server', '--help']);
    process.stdout.write(help);
  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
