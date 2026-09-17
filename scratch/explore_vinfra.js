import 'dotenv/config';
import { Client } from 'ssh2';
import { logger, retryOperation } from '../src/utils/index.js';

const host = process.env.VHI_SSH_HOST || '172.16.218.7';
const username = process.env.VHI_SSH_USER || 'root';
const password = process.env.VHI_SSH_PASSWORD || process.env.VHI_PASSWORD || '';

async function run() {
    await retryOperation(async () => {
        return new Promise((resolve, reject) => {
            const conn = new Client();
            conn.on('ready', () => {
                logger.info('SSH Ready');
                conn.exec("vinfra --insecure --help", (err, stream) => {
                    if (err) {
                        conn.end();
                        return reject(err);
                    }
                    let stdout = '';
                    stream.on('close', (code, signal) => {
                        logger.info(`Exit code: ${code}`);
                        const truncated = stdout.length > 500 ? stdout.substring(0, 500) + '...' : stdout;
                        logger.info(truncated);
                        conn.end();
                        resolve();
                    }).on('data', (data) => {
                        stdout += data;
                    });
                });
            }).on('error', (err) => {
                logger.error(`SSH Error: ${err.message}`, { error: err.message });
                reject(err);
            }).connect({
                host,
                port: 22,
                username,
                password,
                readyTimeout: 10000
            });
        });
    }, { maxAttempts: 3, baseDelay: 1000 });
}

run().catch(err => logger.error('Final failure', { error: err.message }));
