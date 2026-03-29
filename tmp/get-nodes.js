import 'dotenv/config';
import { runVinfraCommand } from '../src/vhi/vinfra.js';
import { writeFile } from 'fs/promises';

async function main() {
    try {
        console.log('Running vinfra node list...');
        const creds = {
            host: '172.16.218.7',
            username: 'root',
            password: 'Nexpass8188!',
            vhiBaseUrl: 'https://172.16.218.7'
        };
        const nodes = await runVinfraCommand(['node', 'list'], creds);
        await writeFile('tmp/vNodes_raw.json', JSON.stringify(nodes, null, 2));
        console.log('Saved to tmp/vNodes_raw.json');
        
        if (Array.isArray(nodes) && nodes.length > 0) {
            console.log('First node keys:', Object.keys(nodes[0]).join(', '));
            console.log('First node data:', JSON.stringify(nodes[0], null, 2));
        } else {
            console.log('No nodes returned or not an array:', typeof nodes);
            console.log('Raw output:', nodes);
        }
    } catch (err) {
        console.error('Error:', err.message);
    }
}

main();
