import { runVinfraCommand, runVinfraBatch } from '../vhi/vinfra.js';
import { saveAlerts, getLastTimestamp } from './alert-storage.js';
import { getLastValidContext } from '../gateway/context.js';
import { loadGlobalSshConfig, normalizeUrl } from './ssh-storage.js';

export async function runAlertPoll(ctx = null) {
    if (!ctx) {
        // Background poll: get all clusters
        const configs = await loadGlobalSshConfig();
        // If it's a map (new format), iterate
        if (configs && !configs.host) {
            for (const [baseUrl, config] of Object.entries(configs)) {
                try {
                    await runAlertPoll({ vhiBaseUrl: baseUrl, ...config });
                } catch(e) {
                    console.error(`[ALERTS] Failed to poll cluster ${baseUrl}:`, e.message);
                }
            }
            return;
        }
        // Fallback or legacy (singleton)
        ctx = getLastValidContext() || configs;
    }

    let context = ctx;
    if (!context || (!context.host && !context.vhiSshHost && !process.env.VHI_SSH_HOST)) {
        return null;
    }

    const clusterUrl = normalizeUrl(context.vhiBaseUrl) || 'default';

    try {
        const lastTs = getLastTimestamp(clusterUrl);
        // 1. Get current alerts
        const alerts = await runVinfraCommand(['cluster', 'alert', 'list'], context || {});
        
        if (!Array.isArray(alerts) || alerts.length === 0) {
            return { count: 0 };
        }

        // 2. Enrich alerts with full details (Component, Message)
        const enriched = [];
        console.log(`[ALERTS] Enriching ${alerts.length} alerts for ${clusterUrl}...`);
        
        try {
            const batchCmds = alerts.map(alert => ['cluster', 'alert', 'show', alert.id]);
            const batchResults = await runVinfraBatch(batchCmds, context || {});
            
            alerts.forEach((alert, i) => {
                const details = batchResults[i];
                if (details && typeof details === 'object') {
                    enriched.push({ ...alert, ...details });
                } else {
                    console.error(`[ALERTS] Failed to enrich alert ${alert.id}: invalid response`);
                    enriched.push(alert);
                }
            });
        } catch (err) {
            console.error(`[ALERTS] Failed to run batch enrichment:`, err.message);
            // Fallback to un-enriched alerts
            alerts.forEach(alert => enriched.push(alert));
        }

        // 3. Save to storage
        saveAlerts(enriched, clusterUrl);
        console.log(`[ALERTS] Synced ${enriched.length} alerts for ${clusterUrl}`);
        
        return { count: enriched.length };
    } catch (err) {
        console.error(`[ALERTS] Poll error for ${clusterUrl}:`, err.message);
        throw err;
    }
}
