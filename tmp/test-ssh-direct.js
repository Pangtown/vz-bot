import { Client } from 'ssh2';
import { loadGlobalSshConfig } from '../src/monitoring/ssh-storage.js';

async function testSsh() {
    const config = await loadGlobalSshConfig();
    console.log("Config Host:", config.host);
    
    if (!config.host) {
        console.error("No SSH host configured.");
        return;
    }
    
    const conn = new Client();
    conn.on('ready', () => {
        console.log("SSH READY!");
        conn.exec('uptime', (err, stream) => {
            if (err) throw err;
            stream.on('close', () => {
                console.log("UPTIME DONE");
                conn.end();
            }).on('data', (data) => {
                console.log("STDOUT: " + data);
            });
        });
    }).on('error', (err) => {
        console.error("SSH ERROR:", err.message);
    }).connect({
        host: config.host,
        port: 22,
        username: config.username || 'root',
        password: config.password,
        readyTimeout: 5000
    });
}

testSsh();
