import { getClient } from '../src/vhi/client.js';

async function test() {
    try {
        const baseUrl = 'https://172.16.218.7';
        process.env.VHI_USER = 'admin';
        process.env.VHI_PASSWORD = 'Nexpass8188!';
        process.env.VHI_DOMAIN_NAME = 'Default';
        process.env.VHI_BASE_URL = baseUrl;

        const client = await getClient();
        console.log("SERVICE CATALOG:");
        console.log(JSON.stringify(client.catalog, null, 2));
    } catch (err) {
        console.error("TEST FAILED:", err.message);
    }
}

test();
