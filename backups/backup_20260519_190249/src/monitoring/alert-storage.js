import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'alerts.db');

const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
}

let db = null;

function getDb() {
    if (db) return db;
    db = new DatabaseSync(DB_PATH);
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY,
            cluster_url TEXT,
            timestamp TEXT NOT NULL,
            severity TEXT,
            name TEXT,
            component TEXT,
            description TEXT,
            details TEXT
        );
        
        CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts (timestamp);
        CREATE INDEX IF NOT EXISTS idx_alerts_cluster ON alerts (cluster_url);
    `);
    
    // Migration for existing table
    const columns = ['cluster_url'];
    for (const col of columns) {
        try {
            db.exec(`ALTER TABLE alerts ADD COLUMN ${col} TEXT`);
        } catch (e) {}
    }

    db.exec(`
        DROP TABLE IF EXISTS alerts_fts;
        CREATE VIRTUAL TABLE alerts_fts USING fts5(
            severity, name, component, description, details,
            content='alerts',
            content_rowid='rowid'
        );
        
        DROP TRIGGER IF EXISTS alerts_ai;
        CREATE TRIGGER alerts_ai AFTER INSERT ON alerts BEGIN
            INSERT INTO alerts_fts(rowid, severity, name, component, description, details) 
            VALUES (new.rowid, new.severity, new.name, new.component, new.description, new.details);
        END;

        -- Re-populate FTS
        INSERT INTO alerts_fts(rowid, severity, name, component, description, details)
        SELECT rowid, severity, name, component, description, details FROM alerts;
    `);
    
    return db;
}

export function saveAlerts(alertList, clusterUrl = 'default') {
    const database = getDb();
    const insert = database.prepare(`
        INSERT OR REPLACE INTO alerts (id, cluster_url, timestamp, severity, name, component, description, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    database.exec('BEGIN TRANSACTION');
    try {
        for (const alert of alertList) {
            insert.run(
                String(alert.id),
                clusterUrl,
                alert.datetime || alert.timestamp || new Date().toISOString(),
                alert.severity || 'info',
                alert.type || alert.name || 'unknown',
                alert.component || 'cluster',
                alert.message || alert.description || '',
                JSON.stringify(alert)
            );
        }
        database.exec('COMMIT');
    } catch (err) {
        database.exec('ROLLBACK');
        throw err;
    }
}

export function searchAlerts({ query, clusterUrl, limit = 100, offset = 0 }) {
    const database = getDb();
    let sql = `SELECT * FROM alerts`;
    const params = [];
    const where = [];

    if (query) {
        sql = `
            SELECT e.* 
            FROM alerts e
            JOIN alerts_fts f ON e.rowid = f.rowid
        `;
        where.push('alerts_fts MATCH ?');
        params.push(query);
    }
    
    if (clusterUrl) {
        where.push('cluster_url = ?');
        params.push(clusterUrl);
    }

    if (where.length > 0) {
        if (!sql.includes('WHERE')) sql += ' WHERE ' + where.join(' AND ');
        else sql += ' AND ' + where.join(' AND ');
    }
    
    sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return database.prepare(sql).all(...params);
}

export function getLastTimestamp(clusterUrl = 'default') {
    const database = getDb();
    const row = database.prepare('SELECT MAX(timestamp) as ts FROM alerts WHERE cluster_url = ?').get(clusterUrl);
    return row ? row.ts : null;
}
