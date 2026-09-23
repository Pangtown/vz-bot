import { randomBytes } from 'crypto';

const IDLE_MS = 30 * 60 * 1000;
const sessions = new Map();

setInterval(() => {
  const cutoff = Date.now() - IDLE_MS;
  for (const [token, row] of sessions) {
    if (row.lastActivity < cutoff) sessions.delete(token);
  }
}, 5 * 60 * 1000).unref();

export function createConsoleSession(record) {
  const sessionToken = randomBytes(32).toString('hex');
  sessions.set(sessionToken, {
    baseUrl: record.baseUrl || '',
    username: record.username || '',
    password: record.password || '',
    project: record.project || 'admin',
    projectId: record.projectId || '',
    userDomain: record.userDomain || 'Default',
    projectDomain: record.projectDomain || 'Default',
    isAdmin: !!record.isAdmin,
    lastActivity: Date.now(),
  });
  return sessionToken;
}

export function touchConsoleSession(sessionToken) {
  if (!sessionToken) return null;
  const row = sessions.get(sessionToken);
  if (!row) return null;
  if (Date.now() - row.lastActivity > IDLE_MS) {
    sessions.delete(sessionToken);
    return null;
  }
  row.lastActivity = Date.now();
  return row;
}

export function destroyConsoleSession(sessionToken) {
  if (sessionToken) sessions.delete(sessionToken);
}

export function tokenFromRequest(req) {
  const auth = req.headers?.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return (req.headers?.['x-session-token'] || '').trim();
}

export function publicSession(row) {
  return {
    ok: true,
    baseUrl: row.baseUrl,
    username: row.username,
    project: row.project,
    projectId: row.projectId,
    userDomain: row.userDomain,
    projectDomain: row.projectDomain,
    isAdmin: row.isAdmin,
  };
}
