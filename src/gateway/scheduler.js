/**
 * Scheduler – cron/heartbeat for periodic health check and optional proactive summary
 */

import cron from 'node-cron';
import * as healthPoller from '../monitoring/health-poller.js';
import * as alerts from '../monitoring/alerts.js';

let healthJob = null;

export function start(config = {}) {
  const intervalMinutes = config.healthPollIntervalMinutes || 5;
  if (healthJob) return;
  healthJob = cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
    if (!process.env.VHI_USER || !process.env.VHI_PASSWORD) {
      return; // Skip health poll if credentials are not set in the environment
    }
    try {
      const result = await healthPoller.runHealthPoll();
      await alerts.emitAlerts(result);
    } catch (err) {
      console.error('Health poll error:', err.message);
    }
  });
  console.log(`Scheduler: health poll every ${intervalMinutes} min`);
}

export function stop() {
  if (healthJob) {
    healthJob.stop();
    healthJob = null;
  }
}
