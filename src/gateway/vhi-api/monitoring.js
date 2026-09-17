import { runWithContext } from '../context.js';
import { getLastHealth, getLastBilling } from '../scheduler.js';
import * as healthPoller from '../../monitoring/health-poller.js';
import * as billingStorage from '../../monitoring/billing-storage.js';
import { searchEvents } from '../../monitoring/audit-storage.js';
import { runAuditPoll } from '../../monitoring/audit-poller.js';
import { searchAlerts } from '../../monitoring/alert-storage.js';
import { runAlertPoll } from '../../monitoring/alert-poller.js';
import { loadGlobalSshConfig, saveGlobalSshConfig } from '../../monitoring/ssh-storage.js';
import { json, readBody } from './helpers.js';
import { logger } from '../../utils/index.js';

export async function handleHealthStatus(req, res, ctx) {
  try {
    let health = getLastHealth();
    if (!health.result) {
      const result = await runWithContext(ctx, () => healthPoller.runHealthPoll());
      health = { result, time: new Date().toISOString() };
    }
    return json(res, 200, health);
  } catch (err) {
    logger.error(`handleHealthStatus error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleBillingStatus(req, res, ctx) {
  try {
    let billing = getLastBilling();
    if (!billing.result) {
      const { calculateHourlyConsumption } = await import('../../monitoring/billing-meter.js');
      const result = await runWithContext(ctx, () => calculateHourlyConsumption());
      billing = { result, time: new Date().toISOString() };
    }
    return json(res, 200, billing);
  } catch (err) {
    logger.error(`handleBillingStatus error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleBillingRefresh(req, res, ctx) {
  try {
    const { forceBillingRefresh } = await import('../scheduler.js');
    const result = await forceBillingRefresh(ctx);
    logger.info('Billing data refreshed forcibly');
    return json(res, 200, { ok: true, ...result });
  } catch (err) {
    logger.error(`handleBillingRefresh error: ${err.message}`, { error: err.message });
    return json(res, 500, { error: err.message });
  }
}

export async function handleBillingExport(req, res, ctx) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    
    const records = await billingStorage.getHistory(from, to);
    
    const headers = ['Timestamp', 'vCPU', 'RAM (GB)', 'Storage (GB)', 'Network Traffic'];
    const rows = records.map(r => [
      r.timestamp,
      r.vCpu,
      r.ramGb,
      r.storageGb,
      `"${r.networkTraffic}"`
    ]);

    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="billing-export-${new Date().toISOString().slice(0,10)}.csv"`
    });
    res.end(csv);
  } catch (err) {
    logger.error(`handleBillingExport error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleAuditLogs(req, res, ctx) {
    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const query = url.searchParams.get('q');
        const user = url.searchParams.get('user');
        const action = url.searchParams.get('action');
        const status = url.searchParams.get('status');
        const limit = parseInt(url.searchParams.get('limit')) || 100;
        const offset = parseInt(url.searchParams.get('offset')) || 0;
        
        const logs = await searchEvents({ query, user, action, status, clusterUrl: ctx.vhiBaseUrl, limit, offset });
        return json(res, 200, { logs });
    } catch (err) {
        logger.error(`handleAuditLogs error: ${err.message}`, { error: err.message });
        return json(res, 500, { error: err.message });
    }
}

export async function handleAuditRefresh(req, res, ctx) {
    try {
        const result = await runWithContext(ctx, () => runAuditPoll(ctx));
        logger.info('Audit logs refreshed forcibly');
        return json(res, 200, { ok: true, ...result });
    } catch (err) {
        logger.error(`handleAuditRefresh error: ${err.message}`, { error: err.message });
        return json(res, 500, { error: err.message });
    }
}

export async function handleGetSshSettings(req, res, ctx) {
  try {
    const config = await loadGlobalSshConfig(ctx.vhiBaseUrl);
    const sanitized = {
      host: config.host || '',
      username: config.username || 'root',
      authMethod: config.authMethod || (config.privateKey ? 'key' : 'password'),
      hasPassword: !!config.password,
      hasPrivateKey: !!config.privateKey,
      hasPassphrase: !!config.passphrase,
    };
    return json(res, 200, sanitized);
  } catch (err) {
    logger.error(`handleGetSshSettings error: ${err.message}`, { error: err.message });
    return json(res, 500, { error: err.message });
  }
}

export async function handlePostSshSettings(req, res, ctx) {
  try {
    const config = await readBody(req);
    const existing = await loadGlobalSshConfig(ctx.vhiBaseUrl);

    // If secrets were not provided but previously configured, retain the existing values
    if (!config.password && config.hasPassword && existing.password) {
      config.password = existing.password;
    }
    if (!config.privateKey && config.hasPrivateKey && existing.privateKey) {
      config.privateKey = existing.privateKey;
    }
    if (!config.passphrase && config.hasPassphrase && existing.passphrase) {
      config.passphrase = existing.passphrase;
    }

    delete config.hasPassword;
    delete config.hasPrivateKey;
    delete config.hasPassphrase;

    await saveGlobalSshConfig(config, ctx.vhiBaseUrl);
    logger.info('Saved global SSH settings');
    return json(res, 200, { ok: true });
  } catch (err) {
    logger.error(`handlePostSshSettings error: ${err.message}`, { error: err.message });
    return json(res, 500, { error: err.message });
  }
}
