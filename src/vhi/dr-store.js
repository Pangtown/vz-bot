/**
 * Persist VHI cross-cluster DR plans (primary + DR contexts and protected VMs).
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { normalizeUrl } from '../monitoring/ssh-storage.js';

const STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'dr-plans.json');

let writeChain = Promise.resolve();

function withWriteLock(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function readStore() {
  try {
    const parsed = JSON.parse(await readFile(STORE_PATH, 'utf8'));
    if (Array.isArray(parsed)) return { plans: parsed };
    if (parsed && Array.isArray(parsed.plans)) return parsed;
    return { plans: [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { plans: [] };
    throw err;
  }
}

async function writeStore(store) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

export function sanitizeContext(ctx = {}) {
  return {
    vhiBaseUrl: normalizeUrl(ctx.vhiBaseUrl || ctx.host || ''),
    vhiUser: ctx.vhiUser || ctx.user || '',
    vhiProject: ctx.vhiProject || ctx.project || 'admin',
    vhiDomain: ctx.vhiDomain || ctx.userDomain || 'Default',
    vhiProjectDomain: ctx.vhiProjectDomain || ctx.projectDomain || ctx.vhiDomain || 'Default',
    hasPassword: !!(ctx.vhiPassword || ctx.password),
  };
}

export function toContext(ctx = {}) {
  return {
    vhiBaseUrl: normalizeUrl(ctx.vhiBaseUrl || ctx.host || ''),
    vhiUser: ctx.vhiUser || ctx.user || '',
    vhiPassword: ctx.vhiPassword || ctx.password || '',
    vhiProject: ctx.vhiProject || ctx.project || 'admin',
    vhiDomain: ctx.vhiDomain || ctx.userDomain || 'Default',
    vhiProjectDomain: ctx.vhiProjectDomain || ctx.projectDomain || ctx.vhiDomain || 'Default',
    vhiProjectId: ctx.vhiProjectId || ctx.projectId || '',
    persistLast: false,
  };
}

export function sanitizePlan(plan) {
  if (!plan) return null;
  return {
    ...plan,
    primary: sanitizeContext(plan.primary),
    dr: sanitizeContext(plan.dr),
  };
}

export async function listPlans() {
  const store = await readStore();
  return store.plans;
}

export async function getPlan(id) {
  const store = await readStore();
  return store.plans.find((p) => p.id === id) || null;
}

export async function savePlan(plan) {
  return withWriteLock(async () => {
    const store = await readStore();
    const now = new Date().toISOString();
    const idx = store.plans.findIndex((p) => p.id === plan.id);
    const next = { ...plan, updatedAt: now };
    if (!next.id) next.id = randomUUID();
    if (!next.createdAt) next.createdAt = now;
    if (idx >= 0) store.plans[idx] = next;
    else store.plans.push(next);
    await writeStore(store);
    return next;
  });
}

export async function deletePlan(id) {
  return withWriteLock(async () => {
    const store = await readStore();
    const before = store.plans.length;
    store.plans = store.plans.filter((p) => p.id !== id);
    if (store.plans.length === before) return false;
    await writeStore(store);
    return true;
  });
}

export async function updatePlan(id, mutator) {
  return withWriteLock(async () => {
    const store = await readStore();
    const idx = store.plans.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const next = await mutator({ ...store.plans[idx] });
    if (!next) return store.plans[idx];
    next.updatedAt = new Date().toISOString();
    store.plans[idx] = next;
    await writeStore(store);
    return next;
  });
}
