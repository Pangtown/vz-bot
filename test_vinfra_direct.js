import { Client } from 'ssh2';

const host = '172.16.218.7';
const username = 'root';
const password = 'Nexpass8188!';

function execSsh(cmd) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
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
        const env = "export VINFRA_PORTAL='172.16.218.7'; export VINFRA_USERNAME='admin'; export VINFRA_PASSWORD='Nexpass8188!'";
        const ids = [2751, 2750, 2749];
        
        // Build batch command
        const subcmds = ids.map(id => `vinfra cluster auditlog show ${id} -f json`).join('; echo "===SPLIT==="; ');
        const fullCmd = `${env}; ${subcmds}`;
        
        console.log("Executing batch SSH command...");
        const start = Date.now();
        const res = await execSsh(fullCmd);
        const end = Date.now();
        
        console.log(`Executed in ${end - start}ms!`);
        console.log("Code:", res.code);
        console.log("Stderr:", res.stderr);
        
        if (res.stdout) {
            const chunks = res.stdout.split("===SPLIT===");
            chunks.forEach((chunk, i) => {
                try {
                    const parsed = JSON.parse(chunk.trim());
                    console.log(`Chunk ${i}: SUCCESS (ID: ${parsed.id}, Component: ${parsed.component})`);
                } catch (err) {
                    console.log(`Chunk ${i}: FAILED to parse JSON: ${err.message}. Content: ${chunk.trim()}`);
                }
            });
        }
    } catch (e) {
        console.error(e);
    }
}
main();
