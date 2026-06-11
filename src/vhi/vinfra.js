import { Client } from 'ssh2';
import { getContextValue } from '../gateway/context.js';
import { loadGlobalSshConfig } from '../monitoring/ssh-storage.js';

export async function runVinfraCommand(args, creds = {}) {
    let host = creds.host || getContextValue('vhiSshHost', 'VHI_SSH_HOST');
    let username = creds.username || getContextValue('vhiSshUser', 'VHI_SSH_USER') || 'root';
    let password = creds.password || getContextValue('vhiSshPassword', 'VHI_SSH_PASSWORD');
    let privateKey = creds.privateKey || getContextValue('vhiSshPrivateKey', 'VHI_SSH_PRIVATE_KEY');
    let passphrase = creds.passphrase || getContextValue('vhiSshPassphrase', 'VHI_SSH_PASSPHRASE');

    let vhiUser = getContextValue('vhiUser', 'VHI_USER');
    let vhiPassword = getContextValue('vhiPassword', 'VHI_PASSWORD');
    let vhiDomain = getContextValue('vhiDomain', 'VHI_DOMAIN_NAME') || 'Default';
    let vhiProject = getContextValue('vhiProject', 'VHI_PROJECT');
    let vhiBaseUrl = getContextValue('vhiBaseUrl', 'VHI_BASE_URL');

    // Fallback logic
    if (!host) {
        const baseUrl = creds.vhiBaseUrl || vhiBaseUrl;
        const persistentConfig = await loadGlobalSshConfig(baseUrl);
        if (persistentConfig.host) {
            console.log(`[VINFRA] Using persistent SSH config for ${persistentConfig.host} (cluster: ${baseUrl || 'default'})`);
            host = persistentConfig.host;
            if (!username || username === 'root') username = persistentConfig.username || 'root';
            if (!password) password = persistentConfig.password;
            if (!privateKey) privateKey = persistentConfig.privateKey;
            if (!passphrase) passphrase = persistentConfig.passphrase;
        }
    }

    if (!host && vhiBaseUrl) {
        try {
            console.log(`[VINFRA] Falling back to cluster API host for SSH`);
            host = new URL(vhiBaseUrl).hostname;
        } catch (e) {
            // ignore malformed URLs
        }
    }
    if (!password && !privateKey && vhiPassword) {
        password = vhiPassword;
    }

    if (!host) {
        const debugConfig = await loadGlobalSshConfig();
        const configKeys = Object.keys(debugConfig).join(', ');
        throw new Error(`Node SSH Host must be configured to run vinfra commands. Server-side fallback attempted but found keys: [${configKeys}]. Please ensure global SSH settings are saved in the dashboard.`);
    }
    if (!password && !privateKey) {
        throw new Error('Node SSH Password or Private Key must be provided.');
    }

    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            // Use standard vinfra environment variables for authentication
            const envVars = [];
            if (vhiBaseUrl) {
                envVars.push(`export VINFRA_URL='${vhiBaseUrl.replace(/'/g, "'\\''")}'`);
                try {
                    const portal = new URL(vhiBaseUrl).hostname;
                    envVars.push(`export VINFRA_PORTAL='${portal.replace(/'/g, "'\\''")}'`);
                } catch (e) {}
            }
            if (vhiUser)     envVars.push(`export VINFRA_USERNAME='${vhiUser.replace(/'/g, "'\\''")}'`);
            if (vhiPassword) envVars.push(`export VINFRA_PASSWORD='${vhiPassword.replace(/'/g, "'\\''")}'`);
            // Do not export VINFRA_DOMAIN, VINFRA_PROJECT, or VINFRA_PROJECT_NAME for Vinfra CLI
            // as global admin accounts are forbidden from specifying project scopes for system queries on this cluster.
            
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

export async function runVinfraBatch(commands, creds = {}) {
    if (!Array.isArray(commands) || commands.length === 0) return [];
    
    // Chunk commands to keep CLI command lengths and SSH buffers balanced
    const batchSize = 25;
    const results = [];
    
    for (let i = 0; i < commands.length; i += batchSize) {
        const chunk = commands.slice(i, i + batchSize);
        console.log(`[VINFRA-BATCH] Executing batch chunk ${i / batchSize + 1} with ${chunk.length} commands...`);
        const chunkResults = await runVinfraBatchChunk(chunk, creds);
        results.push(...chunkResults);
    }
    return results;
}

async function runVinfraBatchChunk(commands, creds = {}) {
    let host = creds.host || getContextValue('vhiSshHost', 'VHI_SSH_HOST');
    let username = creds.username || getContextValue('vhiSshUser', 'VHI_SSH_USER') || 'root';
    let password = creds.password || getContextValue('vhiSshPassword', 'VHI_SSH_PASSWORD');
    let privateKey = creds.privateKey || getContextValue('vhiSshPrivateKey', 'VHI_SSH_PRIVATE_KEY');
    let passphrase = creds.passphrase || getContextValue('vhiSshPassphrase', 'VHI_SSH_PASSPHRASE');

    let vhiUser = getContextValue('vhiUser', 'VHI_USER');
    let vhiPassword = getContextValue('vhiPassword', 'VHI_PASSWORD');
    let vhiBaseUrl = getContextValue('vhiBaseUrl', 'VHI_BASE_URL');

    // Fallback logic
    if (!host) {
        const baseUrl = creds.vhiBaseUrl || vhiBaseUrl;
        const persistentConfig = await loadGlobalSshConfig(baseUrl);
        if (persistentConfig.host) {
            host = persistentConfig.host;
            if (!username || username === 'root') username = persistentConfig.username || 'root';
            if (!password) password = persistentConfig.password;
            if (!privateKey) privateKey = persistentConfig.privateKey;
            if (!passphrase) passphrase = persistentConfig.passphrase;
        }
    }

    if (!host && vhiBaseUrl) {
        try {
            host = new URL(vhiBaseUrl).hostname;
        } catch (e) {}
    }
    if (!password && !privateKey && vhiPassword) {
        password = vhiPassword;
    }

    if (!host) {
        throw new Error('Node SSH Host must be configured to run vinfra commands.');
    }
    if (!password && !privateKey) {
        throw new Error('Node SSH Password or Private Key must be provided.');
    }

    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            const envVars = [];
            if (vhiBaseUrl) {
                envVars.push(`export VINFRA_URL='${vhiBaseUrl.replace(/'/g, "'\\''")}'`);
                try {
                    const portal = new URL(vhiBaseUrl).hostname;
                    envVars.push(`export VINFRA_PORTAL='${portal.replace(/'/g, "'\\''")}'`);
                } catch (e) {}
            }
            if (vhiUser)     envVars.push(`export VINFRA_USERNAME='${vhiUser.replace(/'/g, "'\\''")}'`);
            if (vhiPassword) envVars.push(`export VINFRA_PASSWORD='${vhiPassword.replace(/'/g, "'\\''")}'`);

            const subcmds = commands.map(args => {
                const quotedArgs = args.map(a => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
                const isRaw = args[0].startsWith('/') || args[0] === 'reboot';
                return isRaw ? quotedArgs : `vinfra ${quotedArgs} -f json`;
            });

            // Semicolon chains execution regardless of individual successes
            const batchCmd = subcmds.join('; echo "===SPLIT==="; ');
            const command = `${envVars.join('; ')}; ${batchCmd}`;

            conn.exec(command, (err, stream) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }

                let stdout = '';
                let stderr = '';

                stream.on('close', (code, signal) => {
                    conn.end();
                    const chunks = stdout.split('===SPLIT===');
                    const results = chunks.map(chunk => {
                        const trimmed = chunk.trim();
                        if (!trimmed) return null;
                        try {
                            return JSON.parse(trimmed);
                        } catch (e) {
                            return trimmed;
                        }
                    });

                    // Ensure the results array matches the commands length
                    while (results.length < commands.length) {
                        results.push(null);
                    }
                    resolve(results.slice(0, commands.length));
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

