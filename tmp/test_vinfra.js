import { runVinfraCommand } from '../src/vhi/vinfra.js';

async function test() {
    console.log('Testing vinfra command with NO credentials (should use fallback)...');
    try {
        const result = await runVinfraCommand(['service', 'compute', 'server', 'list']);
        console.log('SUCCESS!');
        console.log('Result:', JSON.stringify(result, null, 2).slice(0, 500) + '...');
    } catch (err) {
        console.error('FAILED:', err.message);
    }
}

test();
