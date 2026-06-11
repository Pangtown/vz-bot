import fetch from 'node-fetch';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function testAuth(password, project) {
    const url = 'https://172.16.218.7:5000/v3/auth/tokens';
    const body = {
        auth: {
            identity: {
                methods: ['password'],
                password: {
                    user: { name: 'admin', domain: { name: 'Default' }, password: password }
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
        console.log(`Password: ${password}, Project: ${project} => Status: ${res.status}`);
        if (res.status === 201) {
            console.log("SUCCESS!");
        }
    } catch (e) {
        console.error("Error:", e.message);
    }
}

async function run() {
    console.log("Testing password: Nexpass8188!");
    await testAuth('Nexpass8188!', 'admin');
    await testAuth('Nexpass8188!', 'Default');
}
run();
