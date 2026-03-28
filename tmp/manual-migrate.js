import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

const DB_PATH = './data/alerts.db';
const db = new DatabaseSync(DB_PATH);

try {
    console.log('Attempting to add cluster_url to alerts...');
    db.exec(`ALTER TABLE alerts ADD COLUMN cluster_url TEXT`);
    console.log('Success!');
} catch (e) {
    console.error('Migration failed:', e.message);
}

try {
    console.log('Attempting to add index...');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_cluster ON alerts (cluster_url)`);
    console.log('Success!');
} catch (e) {
    console.error('Index failed:', e.message);
}
