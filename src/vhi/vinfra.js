import { Client } from 'ssh2';
import { getContextValue } from '../gateway/context.js';

export async function runVinfraCommand(args, creds = {}) {
    const host     = creds.host     || getContextValue('vhiSshHost', 'VHI_SSH_HOST');
    const username = creds.username || getContextValue('vhiSshUser', 'VHI_SSH_USER') || 'root';
    const password = creds.password || getContextValue('vhiSshPassword', 'VHI_SSH_PASSWORD');
    const privateKey = creds.privateKey || getContextValue('vhiSshPrivateKey', 'VHI_SSH_PRIVATE_KEY');
    const passphrase = creds.passphrase || getContextValue('vhiSshPassphrase', 'VHI_SSH_PASSPHRASE');

    const vhiUser = getContextValue('vhiUser', 'VHI_USER');
    const vhiPassword = getContextValue('vhiPassword', 'VHI_PASSWORD');
    const vhiDomain = getContextValue('vhiDomain', 'VHI_DOMAIN_NAME') || 'Default';
    const vhiProject = getContextValue('vhiProject', 'VHI_PROJECT');

    if (!host) {
        throw new Error('Node SSH Host must be configured to run vinfra commands.');
    }
    if (!password && !privateKey) {
        throw new Error('Node SSH Password or Private Key must be provided.');
    }

    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            // Use environment variables for authentication to avoid shell quoting issues with flags.
            const envVars = [];
            if (vhiUser)     envVars.push(`export VHA_USER='${vhiUser.replace(/'/g, "'\\''")}'`);
            if (vhiPassword) envVars.push(`export VHA_PASSWORD='${vhiPassword.replace(/'/g, "'\\''")}'`);
            if (vhiDomain)   envVars.push(`export VHA_DOMAIN='${vhiDomain.replace(/'/g, "'\\''")}'`);
            
            const quotedArgs = args.map(a => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
            
            // If the first argument is an absolute path or 'reboot', treat as raw command
            const isRaw = args[0].startsWith('/') || args[0] === 'reboot';
            const command = isRaw 
              ? `${envVars.join('; ')}; ${quotedArgs}`
              : `${envVars.join('; ')}; vinfra ${quotedArgs} -f json`;

            conn.exec(command, (err, stream) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }

                let stdout = '';
                let stderr = '';

                stream.on('close', (code, signal) => {
                    conn.end();
                    if (code !== 0) {
                        return reject(new Error(`vinfra command failed with code ${code}: ${stderr.trim() || stdout.trim()}`));
                    }
                    try {
                        const parsed = JSON.parse(stdout);
                        resolve(parsed);
                    } catch (e) {
                        // If output isn't json, just return raw string
                        resolve(stdout.trim() || stderr.trim());
                    }
                }).on('data', (data) => {
                    stdout += data;
                }).stderr.on('data', (data) => {
                    stderr += data;
                });
            });
        }).on('error', (err) => {
            reject(new Error(`SSH Connection Error: ${err.message}`));
        }).connect({
            host,
            port: 22,
            username,
            password,
            privateKey,
            passphrase,
            readyTimeout: 10000
        });
    });
}
export function openSshShell(creds, onData, onClose) {
    const host     = creds.host;
    const username = creds.username || 'root';
    const password = creds.password;
    const privateKey = creds.privateKey;
    const passphrase = creds.passphrase;

    const conn = new Client();
    conn.on('ready', () => {
        conn.shell((err, stream) => {
            if (err) {
                conn.end();
                return onClose(err);
            }
            stream.on('data', (data) => onData(data));
            stream.on('close', () => {
                conn.end();
                onClose();
            });
            // Provide the stream back so the caller can write to it
            creds.stream = stream;
        });
    }).on('error', (err) => {
        onClose(err);
    }).connect({
        host,
        port: 22,
        username,
        password,
        privateKey,
        passphrase,
        readyTimeout: 10000
    });

    return {
        write: (data) => {
            if (creds.stream) creds.stream.write(data);
        },
        resize: (cols, rows) => {
            if (creds.stream) creds.stream.setWindow(rows, cols);
        },
        close: () => {
            conn.end();
        }
    };
}
