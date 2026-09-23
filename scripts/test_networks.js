import { runVinfraCommand } from '../src/vhi/vinfra.js';
import dotenv from 'dotenv';
dotenv.config();

async function test() {
    try {
        const creds = {
            host: process.env.VHI_SSH_HOST || '172.16.218.7',
            username: process.env.VHI_SSH_USER || 'root',
            password: process.env.VHI_SSH_PASSWORD || process.env.VHI_PASSWORD || ''
        };
        console.log("Fetching cluster network list...");
        const nets = await runVinfraCommand(['cluster', 'network', 'list'], creds);
        console.log("Networks:", JSON.stringify(nets, null, 2));

        console.log("Fetching node list...");
        const nodes = await runVinfraCommand(['node', 'list'], creds);
        console.log("Nodes:", JSON.stringify(nodes, null, 2));

        if (nodes && nodes.length > 0) {
            const firstId = nodes[0].id;
            console.log(`Fetching node show for ${firstId}...`);
            const nodeShow = await runVinfraCommand(['node', 'show', firstId], creds);
            console.log("Node Show:", JSON.stringify(nodeShow, null, 2));
        }
    } catch (e) {
        console.error("Error running test:", e);
    }
}

test();
