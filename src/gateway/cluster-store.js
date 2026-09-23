/**
 * Saved VHI clusters, persisted to data/clusters.json with passwords encrypted at rest.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { normalizeUrl } from '../monitoring/ssh-storage.js';

const STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'clusters.json');

let clusters = null;

function secretKey() {
  const raw = process.env.CLUSTER_SECRET_KEY || '';
  if (!raw) throw new Error('CLUSTER_SECRET_KEY is not set. Add it to .env and restart.');
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(plain) {
  if (!plain) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(blob) {
  if (!blob) return '';
  const [version, iv, tag, data] = String(blob).split(':');
  if (version !== 'v1' || !iv || !tag || !data) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function load() {
  if (clusters) return clusters;
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    clusters = Array.isArray(parsed?.clusters) ? parsed.clusters : [];
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    clusters = [];
  }
  return clusters;
}

function persist() {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify({ clusters }, null, 2), 'utf8');
}

export function clusterId(baseUrl, project) {
  const host = normalizeUrl(baseUrl).replace(/^https?:\/\//, '');
  return `${host}_${project || 'admin'}`;
}

function publicCluster(c) {
  return {
    id: c.id,
    baseUrl: c.baseUrl,
    username: c.username,
    project: c.project,
    projectId: c.projectId || '',
    userDomain: c.userDomain,
    projectDomain: c.projectDomain,
    hasPassword: !!c.passwordEnc,
    updatedAt: c.updatedAt,
  };
}

export function listClusters() {
  return load().map(publicCluster);
}

export function getCluster(id) {
  const c = load().find((x) => x.id === id);
  return c ? publicCluster(c) : null;
}

export function clusterContext(id) {
  const c = load().find((x) => x.id === id);
  if (!c) return null;
  return {
    vhiBaseUrl: c.baseUrl,
    vhiUser: c.username,
    vhiPassword: decryptSecret(c.passwordEnc),
    vhiProject: c.project,
    vhiProjectId: c.projectId || '',
    vhiDomain: c.userDomain,
    vhiProjectDomain: c.projectDomain,
  };
}

export function allClusterContexts() {
  return load().map((c) => clusterContext(c.id)).filter((ctx) => ctx.vhiUser && ctx.vhiPassword);
}

export function primaryClusterContext() {
  return allClusterContexts()[0] || null;
}

export function upsertCluster(rec) {
  const list = load();
  const baseUrl = normalizeUrl(rec.baseUrl);
  if (!baseUrl || !rec.username) throw new Error('baseUrl and username are required');
  const project = rec.project || 'admin';
  const id = clusterId(baseUrl, project);
  const idx = list.findIndex((x) => x.id === id);
  const prev = idx >= 0 ? list[idx] : {};
  const next = {
    id,
    baseUrl,
    username: rec.username,
    project,
    projectId: rec.projectId || prev.projectId || '',
    userDomain: rec.userDomain || prev.userDomain || 'Default',
    projectDomain: rec.projectDomain || rec.userDomain || prev.projectDomain || 'Default',
    passwordEnc: rec.password ? encryptSecret(rec.password) : (prev.passwordEnc || ''),
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  persist();
  return publicCluster(next);
}

export function deleteCluster(id) {
  const list = load();
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return false;
  list.splice(idx, 1);
  persist();
  return true;
}

export function resetClusterStoreForTests() {
  clusters = null;
}
