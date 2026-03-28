import { runAlertPoll } from '../src/monitoring/alert-poller.js';
import { runAuditPoll } from '../src/monitoring/audit-poller.js';
import { appendFileSync, writeFileSync } from 'fs';
import 'dotenv/config';

const logFile = './tmp/poll-log.txt';
writeFileSync(logFile, '--- Poll Test Start ---\n');

function log(msg) {
    console.log(msg);
    appendFileSync(logFile, msg + '\n');
}

async function test() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
        log('--- Testing Audit Poll ---');
        const auditResult = await runAuditPoll();
        log('Audit Result: ' + JSON.stringify(auditResult, null, 2));
    } catch (e) {
        log('Audit Poll Failed: ' + (e.stack || e.message || String(e)));
    }

    try {
        log('\n--- Testing Alert Poll ---');
        const alertResult = await runAlertPoll();
        log('Alert Result: ' + JSON.stringify(alertResult, null, 2));
    } catch (e) {
        log('Alert Poll Failed: ' + (e.stack || e.message || String(e)));
    }
}

test();
