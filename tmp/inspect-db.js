import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

const DB_PATH = './data/alerts.db';
const db = new DatabaseSync(DB_PATH);

try {
    const tableInfo = db.prepare("PRAGMA table_info(alerts)").all();
    console.log('Table Info for "alerts":', JSON.stringify(tableInfo, null, 2));
    
    const indexes = db.prepare("PRAGMA index_list(alerts)").all();
    console.log('Indexes for "alerts":', JSON.stringify(indexes, null, 2));

    const master = db.prepare("SELECT sql FROM sqlite_master WHERE name='alerts'").get();
    console.log('Original SQL:', master.sql);
} catch (e) {
    console.error('Failed to inspect database:', e.message);
}
