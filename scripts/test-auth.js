import 'dotenv/config';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const base = process.env.VHI_BASE_URL || 'https://demo.nexvantage.com';
const url = `${base}:5000/v3/auth/tokens`;

async function testAuth(project) {
    const body = {
        auth: {
            identity: {
                methods: ['password'],
                password: {
                    user: { name: process.env.VHI_USER || 'admin', domain: { name: 'Default' }, password: process.env.VHI_PASSWORD || '' }
                }
            },
            scope: {
                project: { name: project, domain: { name: 'Default' } }
            }
        }
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    console.log(`Project ${project}: ${res.status}`);
}

async function run() {
    await testAuth('admin');
    await testAuth('Default');
}
run();
