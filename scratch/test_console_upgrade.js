import 'dotenv/config';
import { getRemoteConsole } from '../src/vhi/compute.js';
import { logger, retryOperation } from '../src/utils/index.js';

process.env.VHI_USER = process.env.VHI_USER || 'admin';
process.env.VHI_PASSWORD = process.env.VHI_PASSWORD || '';
process.env.VHI_BASE_URL = process.env.VHI_BASE_URL || 'https://172.16.218.7';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const serverId = '0ab6559c-89dc-4e32-ab27-282e26cd41f0';

async function run() {
  logger.info('--- Testing VNC (Default) ---');
  try {
    const vnc = await retryOperation(() => getRemoteConsole(serverId), { maxAttempts: 3 });
    logger.info(`VNC URL: ${vnc}`);
  } catch (err) {
    logger.error('VNC Failed:', { error: err.message });
  }

  logger.info('--- Testing SPICE HTML5 ---');
  try {
    const spice = await retryOperation(() => getRemoteConsole(serverId, 'spice', 'spice-html5'), { maxAttempts: 2 });
    logger.info(`SPICE URL: ${spice}`);
  } catch (err) {
    logger.error('SPICE Failed (Expected if cluster disabled):', { error: err.message });
  }
}

run();
