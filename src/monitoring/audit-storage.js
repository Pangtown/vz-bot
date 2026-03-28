import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'audit_log.db');

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
}

let db = null;

function getDb() {
    if (db) return db;
    db = new DatabaseSync(DB_PATH);
    
    // Create tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
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
        
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events (timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_cluster ON audit_events (cluster_url);
    `);

    // Migrations for existing tables
    const columns = ['component', 'description', 'result', 'cluster_url'];
    for (const col of columns) {
        try {
            db.exec(`ALTER TABLE audit_events ADD COLUMN ${col} TEXT`);
        } catch (e) {
            // Column likely exists
        }
    }

    db.exec(`
        -- Virtual table for Full-Text Search
        -- FTS5 tables cannot be altered; we must drop and recreate them if schema changes
        DROP TABLE IF EXISTS audit_fts;
        CREATE VIRTUAL TABLE audit_fts USING fts5(
            user, action, resource, status, component, description, details,
            content='audit_events',
            content_rowid='rowid'
        );
        
        -- Triggers to keep FTS in sync
        DROP TRIGGER IF EXISTS audit_ai;
        CREATE TRIGGER audit_ai AFTER INSERT ON audit_events BEGIN
            INSERT INTO audit_fts(rowid, user, action, resource, status, component, description, details) 
            VALUES (new.rowid, new.user, new.action, new.resource, new.status, new.component, new.description, new.details);
        END;
        
        -- Re-populate FTS from existing data if any
        INSERT INTO audit_fts(rowid, user, action, resource, status, component, description, details)
        SELECT rowid, user, action, resource, status, component, description, details FROM audit_events;
    `);
    
    return db;
}

export function saveEvents(events, clusterUrl = 'default') {
    const database = getDb();
    const insert = database.prepare(`
        INSERT OR IGNORE INTO audit_events (id, cluster_url, timestamp, user, action, resource, status, component, description, result, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    database.exec('BEGIN TRANSACTION');
    try {
        for (const event of events) {
            insert.run(
                event.id || event.uuid || Math.random().toString(36).substring(7),
                clusterUrl,
                event.timestamp || event.created_at || new Date().toISOString(),
                event.user || event.username || 'system',
                event.activity || event.action || event.event_type || 'unknown',
                event.resource || event.resource_name || 'cluster',
                event.result || event.status || 'OK',
                event.component || 'system',
                event.message || event.description || '',
                event.result || '',
                JSON.stringify(event)
            );
        }
        database.exec('COMMIT');
    } catch (err) {
        database.exec('ROLLBACK');
        throw err;
    }
}

export function searchEvents({ query, user, action, status, clusterUrl, limit = 100, offset = 0 }) {
    const database = getDb();
    let sql = `
        SELECT e.* 
        FROM audit_events e
    `;
    const params = [];
    const where = [];

    if (query) {
        sql = `
            SELECT e.* 
            FROM audit_events e
            JOIN audit_fts f ON e.rowid = f.rowid
        `;
        where.push('audit_fts MATCH ?');
        params.push(query);
    }

    if (clusterUrl) {
        where.push('e.cluster_url = ?');
        params.push(clusterUrl);
    }

    if (user) {
        where.push('e.user = ?');
        params.push(user);
    }
    if (action) {
        where.push('e.action = ?');
        params.push(action);
    }
    if (status) {
        where.push('e.status = ?');
        params.push(status);
    }

    if (where.length > 0) {
        sql += ' WHERE ' + where.join(' AND ');
    }

    sql += ' ORDER BY e.timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return database.prepare(sql).all(...params);
}

export function getLastTimestamp(clusterUrl = 'default') {
    const database = getDb();
    const row = database.prepare('SELECT MAX(timestamp) as ts FROM audit_events WHERE cluster_url = ?').get(clusterUrl);
    return row ? row.ts : null;
}
