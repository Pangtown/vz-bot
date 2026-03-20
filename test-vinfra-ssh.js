import { Client } from 'ssh2';
import dotenv from 'dotenv';
dotenv.config();

// We'll read from .env or just use the known ones
const host = process.env.VHI_SSH_HOST || '172.16.218.7';
const username = process.env.VHI_SSH_USER || 'root';
const password = process.env.VHI_SSH_PASSWORD || 'VirtuozzoD3m0!';

function execSsh(cmd) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            console.log(`Running: ${cmd}`);
            conn.exec(cmd, (err, stream) => {
                if (err) return reject(err);
                let stdout = '', stderr = '';
                stream.on('close', (code) => {
                    conn.end();
                    resolve({ code, stdout, stderr });
                }).on('data', (data) => stdout += data).stderr.on('data', (data) => stderr += data);
            });
        }).on('error', reject).connect({ host, port: 22, username, password, readyTimeout: 10000 });
    });
}

async function main() {
    try {
        console.log('Testing without any env vars...');
        const res1 = await execSsh('vinfra cluster list -f json');
        console.log('Code:', res1.code);
        console.log('Stdout:', res1.stdout.substring(0, 100));
        console.log('Stderr:', res1.stderr);

        console.log('\nTesting with VINFRA_USERNAME=admin VINFRA_PASSWORD=... VINFRA_PROJECT_NAME=admin...');
        const res2 = await execSsh('VINFRA_USERNAME="admin" VINFRA_PASSWORD="VirtuozzoD3m0!" VINFRA_DOMAIN="Default" VINFRA_PROJECT_NAME="admin" vinfra cluster list -f json');
        console.log('Code:', res2.code);
        console.log('Stdout:', res2.stdout.substring(0, 100));
        console.log('Stderr:', res2.stderr);

    } catch (e) {
        console.error(e);
    }
}
main();
