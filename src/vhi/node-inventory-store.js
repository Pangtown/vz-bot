/**
 * Persist physical-node hardware inventory per cluster so the UI
 * can open node details without re-probing the host.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { normalizeUrl } from '../monitoring/ssh-storage.js';

const STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'node-inventory.json');

let writeChain = Promise.resolve();

function withWriteLock(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

export function clusterKey(baseUrl) {
  return normalizeUrl(baseUrl) || 'default';
}

async function readStore() {
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeStore(store) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store), 'utf8');
}

export async function getNodeInventory(baseUrl, nodeId) {
  const store = await readStore();
  const cluster = store[clusterKey(baseUrl)] || {};
  return cluster[String(nodeId)] || null;
}

export async function listCachedNodeIds(baseUrl) {
  const store = await readStore();
  return new Set(Object.keys(store[clusterKey(baseUrl)] || {}));
}

export async function saveNodeInventory(baseUrl, nodeId, hardware, live = {}) {
  return withWriteLock(async () => {
    const store = await readStore();
    const key = clusterKey(baseUrl);
    if (!store[key]) store[key] = {};
    const prev = store[key][String(nodeId)] || {};
    store[key][String(nodeId)] = {
      collectedAt: new Date().toISOString(),
      hostname: hardware?.hostname || hardware?.hypervisor_hostname || prev.hostname || '',
      hardware,
      live: { ...(prev.live || {}), ...live },
    };
    await writeStore(store);
  });
}

export async function updateManyNodeLiveStats(baseUrl, entries) {
  if (!entries?.length) return;
  return withWriteLock(async () => {
    const store = await readStore();
    const key = clusterKey(baseUrl);
    if (!store[key]) return;
    const now = new Date().toISOString();
    let changed = false;
    for (const { nodeId, live } of entries) {
      const rec = store[key][String(nodeId)];
      if (!rec) continue;
      rec.live = { ...(rec.live || {}), ...live };
      rec.liveUpdatedAt = now;
      changed = true;
    }
    if (changed) await writeStore(store);
  });
}
