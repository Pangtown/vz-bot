import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

const DBs = [
    { path: './data/alerts.db', table: 'alerts', schema: `
        CREATE TABLE alerts (
            id TEXT PRIMARY KEY,
            cluster_url TEXT,
            timestamp TEXT NOT NULL,
            severity TEXT,
            name TEXT,
            component TEXT,
            description TEXT,
            details TEXT
        );
        CREATE INDEX idx_alerts_timestamp ON alerts (timestamp);
        CREATE INDEX idx_alerts_cluster ON alerts (cluster_url);
    `},
    { path: './data/audit_log.db', table: 'audit_events', schema: `
        CREATE TABLE audit_events (
            id TEXT PRIMARY KEY,
            cluster_url TEXT,
            timestamp TEXT NOT NULL,
            user TEXT,
            action TEXT,
            resource TEXT,
            status TEXT,
            component TEXT,
            description TEXT,
            result TEXT,
            details TEXT
        );
        CREATE INDEX idx_audit_timestamp ON audit_events (timestamp);
        CREATE INDEX idx_audit_cluster ON audit_events (cluster_url);
    `}
];

for (const dbConfig of DBs) {
    console.log(`Recreating ${dbConfig.path}...`);
    try {
        const db = new DatabaseSync(dbConfig.path);
        // Rename old table to backup instead of dropping immediately
        try {
            db.exec(`ALTER TABLE ${dbConfig.table} RENAME TO ${dbConfig.table}_old`);
            console.log(`Renamed old ${dbConfig.table} to ${dbConfig.table}_old`);
        } catch (e) {
            console.log(`Old ${dbConfig.table} not found or rename failed: ${e.message}`);
        }
        
        db.exec(dbConfig.schema);
        console.log(`Created new ${dbConfig.table} with correct schema.`);
        
        // Try to move data if old table exists
        try {
            // Get columns of new table (excluding rowid)
            const cols = db.prepare(`PRAGMA table_info(${dbConfig.table})`).all().map(c => c.name);
            const oldCols = db.prepare(`PRAGMA table_info(${dbConfig.table}_old)`).all().map(c => c.name);
            const common = cols.filter(c => oldCols.includes(c));
            
            if (common.length > 0) {
                const colStr = common.join(', ');
                db.exec(`INSERT INTO ${dbConfig.table} (${colStr}) SELECT ${colStr} FROM ${dbConfig.table}_old`);
                console.log(`Migrated data for columns: ${colStr}`);
            }
        } catch (e) {
            console.log(`Data migration failed (likely no old table): ${e.message}`);
        }
    } catch (e) {
        console.error(`Failed to recreate ${dbConfig.path}:`, e.message);
    }
}
