
import { runVinfraCommand } from './src/vhi/vinfra.js';

async function probe() {
    const creds = {
        host: 'demo.nexvantage.com',
        username: 'root',
        password: 'Virtuozzo123!'
    };
    
    // We assume VHA credentials might also be needed for help if it's protected
    // but usually help is not.
    
    console.log("--- vinfra help ---");
    try {
        const help = await runVinfraCommand(['help'], creds);
        console.log(help);
    } catch (e) {
        console.error("Help failed:", e.message);
    }

    console.log("\n--- vinfra node help ---");
    try {
        const nodeHelp = await runVinfraCommand(['node', '--help'], creds);
        console.log(nodeHelp);
    } catch (e) {
        console.error("Node help failed:", e.message);
    }
}

probe();
