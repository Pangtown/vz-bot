import { runVinfraCommand } from './src/vhi/vinfra.js';

async function testVinfra() {
    try {
        console.log('--- Fetching Node List via Vinfra ---');
        // We'll pass empty creds to use the global ones
        const nodes = await runVinfraCommand(['node', 'list']);
        console.log('Nodes:', JSON.stringify(nodes, null, 2));
    } catch (e) {
        console.error('Vinfra failed:', e.message);
    }
}

testVinfra();
