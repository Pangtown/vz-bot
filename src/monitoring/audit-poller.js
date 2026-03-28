import { runVinfraCommand } from '../vhi/vinfra.js';
import { saveEvents, getLastTimestamp } from './audit-storage.js';
import { getLastValidContext } from '../gateway/context.js';
import { loadGlobalSshConfig, normalizeUrl } from './ssh-storage.js';

export async function runAuditPoll(ctx = null) {
    if (!ctx) {
        // Background poll: get all clusters
        const configs = await loadGlobalSshConfig();
        // If it's a map (new format), iterate
        if (configs && !configs.host) {
            for (const [baseUrl, config] of Object.entries(configs)) {
                try {
                    await runAuditPoll({ vhiBaseUrl: baseUrl, ...config });
                } catch(e) {
                    console.error(`[AUDIT] Failed to poll cluster ${baseUrl}:`, e.message);
                }
            }
            return;
        }
        // Fallback or legacy (singleton)
        ctx = getLastValidContext() || configs;
    }

    let context = ctx;
    if (!context || (!context.host && !context.vhiSshHost && !process.env.VHI_SSH_HOST)) {
        // console.log('[AUDIT] No valid context or env vars for audit poll yet');
        return null;
    }

    const clusterUrl = normalizeUrl(context.vhiBaseUrl) || 'default';

    try {
        const lastTs = getLastTimestamp(clusterUrl);
        const args = ['cluster', 'auditlog', 'list'];
        
        // vinfra cluster auditlog list doesn't seem to have a --since flag in all versions, 
        // but we can fetch them all or the last N and filter.
        // For efficiency, we fetch the last 1000 events.
        args.push('--limit', '1000');
        
        const events = await runVinfraCommand(args, context || {});
        
        if (!Array.isArray(events)) {
            throw new Error('Audit log list did not return an array');
        }

        // Filter for new events only
        const newEvents = lastTs 
            ? events.filter(e => {
                const ts = e.timestamp || e.created_at;
                return ts && ts > lastTs;
            })
            : events;

        if (newEvents.length > 0) {
            console.log(`[AUDIT] Enriching ${newEvents.length} new events for ${clusterUrl}...`);
            const enrichedEvents = [];
            // Limit enrichment to avoid long SSH hangs
            const toFetch = newEvents.slice(0, 50);

            for (const event of toFetch) {
                try {
                    // Fetch full details (Component, Description, etc.)
                    const details = await runVinfraCommand(['cluster', 'auditlog', 'show', event.id], context || {});
                    enrichedEvents.push({ ...event, ...details });
                } catch (err) {
                    console.error(`[AUDIT] Failed to enrich event ${event.id}:`, err.message);
                    enrichedEvents.push(event); // Fallback
                }
            }

            saveEvents(enrichedEvents, clusterUrl);
            console.log(`[AUDIT] Saved ${enrichedEvents.length} enriched events for ${clusterUrl}`);
        }
        
        return { totalFetched: events.length, newSaved: newEvents.length };
    } catch (err) {
        console.error(`[AUDIT] Poll error for ${clusterUrl}:`, err.message);
        throw err;
    }
}
