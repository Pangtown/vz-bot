import 'dotenv/config';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import * as tools from '../src/tools/registry.js';

async function test() {
    try {
        console.log("Running list_vms...");
        const result = await tools.run("list_vms", {});
        console.log("Tool result length:", result.count);
    } catch (err) {
        console.error("Tool ERROR:", err.message);
    }
}

test();
