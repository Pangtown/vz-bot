/**
 * Scheduler – cron/heartbeat for periodic health check and optional proactive summary
 */

import cron from 'node-cron';
import * as healthPoller from '../monitoring/health-poller.js';
import * as alerts from '../monitoring/alerts.js';
import * as billingMeter from '../monitoring/billing-meter.js';
import * as billingStorage from '../monitoring/billing-storage.js';
import { runAuditPoll } from '../monitoring/audit-poller.js';
import { runAlertPoll } from '../monitoring/alert-poller.js';
import { tickDueJobs } from './jobs.js';
import { tickMigrations } from '../vmware/migration-engine.js';
import { sweepIdleCloneStore } from '../vmware/windows-replica-fill.js';
import { runWithContext } from './context.js';
import { allClusterContexts, primaryClusterContext } from './cluster-store.js';
import { prefetchClusterNodeInventory } from './vhi-api/compute.js';
import { tickDueDrPlans } from '../vhi/dr-engine.js';

let healthJob = null;
let lastHealthResult = null;
let lastHealthTime = null;

let billingJob = null;
let lastBillingResult = null;
let lastBillingTime = null;

let auditJob = null;

export function getLastHealth() {
  return { result: lastHealthResult, time: lastHealthTime };
}

export function getLastBilling() {
  return { result: lastBillingResult, time: lastBillingTime };
}

function hasEnvCredentials() {
  return !!(process.env.VHI_BASE_URL && process.env.VHI_USER && process.env.VHI_PASSWORD);
}

/** Run a background poll against the first saved cluster, or the .env cluster when none is saved. */
function onPrimaryCluster(fn) {
  const ctx = primaryClusterContext();
  if (ctx) return runWithContext(ctx, fn);
  if (hasEnvCredentials()) return fn();
  return null;
}

export function start(config = {}) {
  // Clamp to 1–59: cron `*/N` syntax is invalid for N > 59
  const intervalMinutes = Math.min(59, Math.max(1, Number(config.healthPollIntervalMinutes) || 5));
  if (healthJob) return;
  healthJob = cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
    try {
      const result = await onPrimaryCluster(() => healthPoller.runHealthPoll());
      if (!result) return;
      lastHealthResult = result;
      lastHealthTime = new Date().toISOString();
      await alerts.emitAlerts(result);
    } catch (err) {
      const cause = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
      console.error(`Health poll error: ${err.message}${cause}`);
    }
  });
  console.log(`Scheduler: health poll every ${intervalMinutes} min`);

  if (!billingJob) {
    billingJob = cron.schedule('0 * * * *', async () => {
      try {
        const result = await onPrimaryCluster(() => billingMeter.calculateHourlyConsumption());
        if (!result) return;
        lastBillingResult = result;
        lastBillingTime = new Date().toISOString();
        await billingStorage.saveSnapshot(result);
      } catch (err) {
        console.error('Billing poll error:', err.message);
      }
    });

    setInterval(async () => {
      if (lastBillingResult) return;
      try {
        const result = await onPrimaryCluster(() => billingMeter.calculateHourlyConsumption());
        if (!result) return;
        lastBillingResult = result;
        lastBillingTime = new Date().toISOString();
        await billingStorage.saveSnapshot(result);
      } catch (e) {}
    }, 10000);
    console.log(`Scheduler: billing meter active (hourly)`);
  }

  if (!auditJob) {
    // Audit Logger
    cron.schedule('*/5 * * * *', async () => {
        try {
            await runAuditPoll();
        } catch (e) {
            console.error('Audit poll background error:', e.message);
        }
    });

    // Alerts
    cron.schedule('*/5 * * * *', async () => {
        try {
            await runAlertPoll();
        } catch (e) {
            console.error('Alert poll background error:', e.message);
        }
    });

    // Start with one run after delay
    setTimeout(() => {
        runAuditPoll().catch(() => {});
        runAlertPoll().catch(() => {});
    }, 15000);
    console.log(`Scheduler: audit & alert poll every 5 min`);
  }

  cron.schedule('* * * * *', async () => {
    try {
      await tickDueJobs();
    } catch (e) {
      console.error('User job tick error:', e.message);
    }
  });
  console.log('Scheduler: user jobs tick every minute');

  setInterval(() => {
    tickMigrations().catch((err) => console.error('Migration tick error:', err.message));
  }, 4000);
  console.log('Scheduler: Coriolis-style migration engine tick every 4s');

  setTimeout(() => {
    sweepIdleCloneStore().catch((err) => console.error('Clone cache sweep error:', err.message));
  }, 2500);
  cron.schedule('*/5 * * * *', async () => {
    try {
      await sweepIdleCloneStore();
    } catch (e) {
      console.error('Clone cache sweep error:', e.message);
    }
  });
  console.log('Scheduler: clone cache sweep on start and every 5 min (keeps retryable caches)');

  const prefetchAllNodeInventory = async () => {
    for (const ctx of allClusterContexts()) {
      try {
        await prefetchClusterNodeInventory(ctx);
      } catch (err) {
        console.error(`Node inventory prefetch (${ctx.vhiBaseUrl}):`, err.message);
      }
    }
  };
  setTimeout(() => { prefetchAllNodeInventory(); }, 8000);
  cron.schedule('*/15 * * * *', prefetchAllNodeInventory);
  console.log('Scheduler: node hardware inventory prefetch on start and every 15 min (new nodes only)');

  cron.schedule('* * * * *', async () => {
    try {
      await tickDueDrPlans();
    } catch (err) {
      console.error('DR sync tick error:', err.message);
    }
  });
  console.log('Scheduler: DR warm-standby sync tick every minute');
}

/**
 * Force a manual refresh of billing metrics for a specific cluster context.
 */
export async function forceBillingRefresh(ctx) {
  console.log(`[Billing] Manual refresh triggered for ${ctx.vhiBaseUrl}`);
  const result = await runWithContext(ctx, () => billingMeter.calculateHourlyConsumption());
  
  // Update the process-global cache with the fresh data
  lastBillingResult = result;
  lastBillingTime = new Date().toISOString();
  
  // Also save a snapshot for export history
  try {
    await billingStorage.saveSnapshot(result);
  } catch (err) {
    console.warn('[Billing] Failed to save snapshot during refresh:', err.message);
  }
  
  return { result, time: lastBillingTime };
}

export function stop() {
  if (healthJob) {
    healthJob.stop();
    healthJob = null;
  }
  if (billingJob) {
    billingJob.stop();
    billingJob = null;
  }
  if (auditJob) {
    auditJob.stop();
    auditJob = null;
  }
}
