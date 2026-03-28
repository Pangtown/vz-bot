import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

const DATA_DIR = './data';
const DBs = ['audit_log.db', 'alerts.db'];
const TABLE_MAP = {
  'audit_log.db': { table: 'audit_events', col: 'cluster_url' },
  'alerts.db': { table: 'alerts', col: 'cluster_url' }
};

function normalizeUrl(url) {
  if (!url) return 'default';
  let normalized = url.trim();
  if (!normalized.startsWith('http')) {
    normalized = `https://${normalized}`;
  }
  return normalized.replace(/\/$/, '');
}

for (const dbName of DBs) {
  const dbPath = join(DATA_DIR, dbName);
  console.log(`Processing ${dbPath}...`);
  try {
    const db = new DatabaseSync(dbPath);
    const info = TABLE_MAP[dbName];
    
    const rows = db.prepare(`SELECT DISTINCT ${info.col} FROM ${info.table}`).all();
    console.log(`Found distinct URLs:`, rows.map(r => r[info.col]));
    
    for (const row of rows) {
      const oldUrl = row[info.col];
      const newUrl = normalizeUrl(oldUrl);
      if (oldUrl !== newUrl) {
         console.log(`Normalizing: [${oldUrl}] -> [${newUrl}]`);
         const update = db.prepare(`UPDATE ${info.table} SET ${info.col} = ? WHERE ${info.col} = ?`);
         update.run(newUrl, oldUrl);
      }
    }
  } catch (e) {
    console.error(`Failed to process ${dbName}:`, e.message);
  }
}
