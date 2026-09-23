import 'dotenv/config';
import { runAuditPoll } from '../src/monitoring/audit-poller.js';
import { runAlertPoll } from '../src/monitoring/alert-poller.js';

async function main() {
    console.log("==================================================");
    console.log("STARTING OPTIMIZED BATCHED POLLERS TEST...");
    console.log("==================================================");

    const context = {
        vhiBaseUrl: process.env.VHI_BASE_URL || 'https://172.16.218.7',
        host: process.env.VHI_SSH_HOST || '172.16.218.7',
        username: 'root',
        password: process.env.VHI_SSH_PASSWORD || process.env.VHI_PASSWORD || '',
    };

    console.log(`Target Host: ${context.host}`);
    console.log(`Cluster API: ${context.vhiBaseUrl}`);
    console.log("--------------------------------------------------");

    // 1. Audit Poller
    try {
        console.log("[TEST] Running optimized Audit Poller...");
        const auditStart = Date.now();
        const auditResult = await runAuditPoll(context);
        const auditEnd = Date.now();
        
        console.log(`[TEST] Audit Poller completed in ${auditEnd - auditStart}ms!`);
        console.log("[TEST] Audit Result:", auditResult);
    } catch (err) {
        console.error("[TEST] Audit Poller failed:", err.message);
    }

    console.log("--------------------------------------------------");

    // 2. Alert Poller
    try {
        console.log("[TEST] Running optimized Alert Poller...");
        const alertStart = Date.now();
        const alertResult = await runAlertPoll(context);
        const alertEnd = Date.now();
        
        console.log(`[TEST] Alert Poller completed in ${alertEnd - alertStart}ms!`);
        console.log("[TEST] Alert Result:", alertResult);
    } catch (err) {
        console.error("[TEST] Alert Poller failed:", err.message);
    }

    console.log("==================================================");
}

main().catch(console.error);
