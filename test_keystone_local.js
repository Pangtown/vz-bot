import 'dotenv/config';
import fetch from 'node-fetch';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function testAuth(password, project) {
    const url = (process.env.VHI_BASE_URL || 'https://172.16.218.7') + ':5000/v3/auth/tokens';
    const body = {
        auth: {
            identity: {
                methods: ['password'],
                password: {
                    user: { name: process.env.VHI_USER || 'admin', domain: { name: 'Default' }, password: password }
                }
            },
            scope: {
                project: { name: project, domain: { name: 'Default' } }
            }
        }
    };
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        console.log(`Project: ${project} => Status: ${res.status}`);
        if (res.status === 201) {
            console.log("SUCCESS!");
        }
    } catch (e) {
        console.error("Error:", e.message);
    }
}

async function run() {
    const pass = process.env.VHI_PASSWORD || '';
    await testAuth(pass, 'admin');
    await testAuth(pass, 'Default');
}
run();
