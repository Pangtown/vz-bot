import { getClient } from '../src/vhi/client.js';

async function test() {
    try {
        const baseUrl = 'https://172.16.218.7';
        // Provide credentials to the client for this test
        process.env.VHI_USER = 'admin';
        process.env.VHI_PASSWORD = 'Nexpass8188!';
        process.env.VHI_DOMAIN_NAME = 'Default';
        process.env.VHI_BASE_URL = baseUrl;

        const client = await getClient();
        
        // Neutron API usually runs on port 9696
        const url = `${baseUrl}:9696/v2.0/ports`;
        console.log(`Fetching Neutron ports from ${url}...`);
        
        const res = await client.fetch(url);
        if (!res.ok) {
            console.error(`Status ${res.status}: ${await res.text()}`);
            return;
        }
        
        const data = await res.json();
        const ports = data.ports || [];
        console.log(`Found ${ports.length} total ports in Neutron.`);
        
        // Group by Host ID
        const hostMap = {};
        ports.forEach(p => {
            const hostId = p['binding:host_id'];
            if (!hostId) return;
            if (!hostMap[hostId]) hostMap[hostId] = [];
            
            hostMap[hostId].push({
                name: p.name || p.id.slice(0, 8),
                type: p.device_owner,
                ips: (p.fixed_ips || []).map(f => f.ip_address),
                mac: p.mac_address
            });
        });
        
        console.log("HOSTS FOUND IN NEUTRON:", Object.keys(hostMap));
        
        // Log details for a few hosts
        Object.keys(hostMap).forEach(h => {
            console.log(`\nHost Account: ${h}`);
            hostMap[h].forEach(p => {
                console.log(`  - [${p.type}] ${p.name}: ${p.ips.join(', ')} (${p.mac})`);
            });
        });
        
    } catch (err) {
        console.error("TEST FAILED:", err.message);
    }
}

test();
