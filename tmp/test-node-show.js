import { runVinfraCommand } from '../src/vhi/vinfra.js';
import fs from 'fs';

async function test() {
    try {
        // First get the node list to find a valid ID
        console.log("Fetching node list...");
        const nodes = await runVinfraCommand(['node', 'list']);
        if (!Array.isArray(nodes) || nodes.length === 0) {
            console.error("No nodes found to test with.");
            return;
        }
        
        const testNode = nodes[0];
        const id = testNode.id;
        console.log(`Testing 'node show' for ID: ${id} (${testNode.hostname})`);
        
        const details = await runVinfraCommand(['node', 'show', id]);
        console.log("RAW DETAILS KEYS:", Object.keys(details));
        
        fs.writeFileSync('tmp/node-show-raw.json', JSON.stringify(details, null, 2));
        console.log("Saved raw details to tmp/node-show-raw.json");
        
    } catch (err) {
        console.error("TEST FAILED:", err.message);
    }
}

test();
