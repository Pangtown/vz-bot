import { readFile, writeFile, mkdir, rename, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const CLOUDS_FILE = join(DATA_DIR, 'clouds.json');

/**
 * Ensure data directory exists
 */
async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

/**
 * Load all stored clouds
 * @param {boolean} includeSecrets Whether to return passwords or mask them
 * @returns {Promise<Array<object>>}
 */
export async function loadClouds(includeSecrets = false) {
  try {
    const data = await readFile(CLOUDS_FILE, 'utf8');
    const clouds = JSON.parse(data);
    if (!Array.isArray(clouds)) return [];
    return clouds.map(c => {
      if (includeSecrets) return c;
      return {
        ...c,
        pass: c.pass ? '********' : '',
        hasPassword: Boolean(c.pass),
      };
    });
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[CLOUD-STORAGE] Failed to load clouds: ${err.message}`);
    }
    return [];
  }
}

/**
 * Get cloud by ID
 * @param {string} id
 * @param {boolean} includeSecrets
 */
export async function getCloudById(id, includeSecrets = false) {
  const clouds = await loadClouds(true);
  const cloud = clouds.find(c => c.id === id);
  if (!cloud) return null;
  if (includeSecrets) return cloud;
  return {
    ...cloud,
    pass: cloud.pass ? '********' : '',
    hasPassword: Boolean(cloud.pass),
  };
}

/**
 * Save or update a cloud
 * @param {object} cloudData
 * @returns {Promise<object>} The saved cloud object
 */
export async function saveCloud(cloudData) {
  await ensureDataDir();
  const clouds = await loadClouds(true);
  const now = new Date().toISOString();

  let saved;
  const existingIdx = clouds.findIndex(c => c.id === cloudData.id);

  if (existingIdx >= 0) {
    const existing = clouds[existingIdx];
    saved = {
      ...existing,
      ...cloudData,
      pass: cloudData.pass && cloudData.pass !== '********' ? cloudData.pass : existing.pass,
      updated: now,
    };
    clouds[existingIdx] = saved;
  } else {
    saved = {
      id: cloudData.id || `cloud-${Math.random().toString(36).substr(2, 9)}`,
      name: cloudData.name || 'VMware Cloud',
      desc: cloudData.desc || '',
      type: cloudData.type || 'VMWARE',
      host: cloudData.host,
      port: Number(cloudData.port) || 443,
      user: cloudData.user || 'root',
      pass: cloudData.pass || '',
      insecure: cloudData.insecure !== false,
      project: cloudData.project || 'admin',
      domain: cloudData.domain || 'Default',
      serverInfo: cloudData.serverInfo || null,
      status: cloudData.status || 'CONNECTED',
      added: now,
      updated: now,
    };
    clouds.push(saved);
  }

  await writeFile(CLOUDS_FILE, JSON.stringify(clouds, null, 2), 'utf8');

  return {
    ...saved,
    pass: saved.pass ? '********' : '',
    hasPassword: Boolean(saved.pass),
  };
}

/**
 * Delete cloud by ID
 * @param {string} id
 */
export async function deleteCloud(id) {
  const clouds = await loadClouds(true);
  const filtered = clouds.filter(c => c.id !== id);
  await ensureDataDir();
  await writeFile(CLOUDS_FILE, JSON.stringify(filtered, null, 2), 'utf8');
  return true;
}

const MIGRATIONS_FILE = join(DATA_DIR, 'migrations.json');

async function atomicWriteJson(file, data) {
  const tmp = file + '.tmp';
  const body = JSON.stringify(data, null, 2);
  await writeFile(tmp, body, 'utf8');
  try {
    await rename(tmp, file);
  } catch (_) {
    await writeFile(file, body, 'utf8');
    await unlink(tmp).catch(() => {});
  }
}


/**
 * Load all stored migrations
 * @returns {Promise<Array<object>>}
 */
export async function loadMigrations() {
  try {
    const data = await readFile(MIGRATIONS_FILE, 'utf8');
    const migs = JSON.parse(data);
    return Array.isArray(migs) ? migs : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error(`[MIGRATION-STORAGE] Failed to load migrations: ${err.message}`);
    throw err;
  }
}

/**
 * Get migration by ID
 * @param {string} id
 */
export async function getMigrationById(id) {
  const migs = await loadMigrations();
  return migs.find(m => m.id === id) || null;
}

const CANCEL_STATUSES = new Set(['CANCELLED', 'CANCELLING']);
let migrationSaveChain = Promise.resolve();

function isCancelRecord(row) {
  return !!(row && (row.cancelRequested || CANCEL_STATUSES.has(row.status)));
}

/**
 * Save or update a migration record.
 * Serializes writes and ignores stale in-memory persists after cancel.
 * @param {object} migData
 */
export async function saveMigration(migData) {
  const run = () => saveMigrationNow(migData);
  const next = migrationSaveChain.then(run, run);
  migrationSaveChain = next.catch(() => {});
  return next;
}

async function saveMigrationNow(migData) {
  await ensureDataDir();
  const migs = await loadMigrations();
  const now = new Date().toISOString();

  let saved;
  const existingIdx = migs.findIndex(m => m.id === migData.id);

  if (existingIdx >= 0) {
    const existing = migs[existingIdx];
    const incomingGen = Number(migData.persistGeneration);
    const storedGen = Number(existing.persistGeneration) || 0;
    if (Number.isFinite(incomingGen) && incomingGen < storedGen) {
      return existing;
    }
    if (isCancelRecord(existing) && !isCancelRecord(migData)) {
      return existing;
    }
    saved = {
      ...existing,
      ...migData,
      persistGeneration: Math.max(storedGen, Number.isFinite(incomingGen) ? incomingGen : storedGen),
      updated: now,
    };
    if (isCancelRecord(existing) && isCancelRecord(migData)) {
      saved.cancelRequested = true;
      if (CANCEL_STATUSES.has(existing.status) && !CANCEL_STATUSES.has(migData.status)) {
        saved.status = existing.status;
      }
    }
    migs[existingIdx] = saved;
  } else {
    saved = {
      id: migData.id || `mig-${Math.random().toString(36).substr(2, 9)}`,
      name: migData.name || 'Migrate VM',
      srcCloudId: migData.srcCloudId || null,
      srcCloudName: migData.srcCloudName || 'VMware',
      targetDomainProject: migData.targetDomainProject || 'Default / admin',
      vms: Array.isArray(migData.vms) ? migData.vms : [migData.name],
      migType: migData.migType || 'live',
      status: migData.status || 'REPLICATING',
      progress: migData.progress || 0,
      replicationSpeed: migData.replicationSpeed || '',
      replicatedBytes: migData.replicatedBytes || '',
      duration: migData.duration || '',
      sourceOptions: migData.sourceOptions || {
        os: 'linux',
        vcpus: 1,
        ram: '2 GiB',
        diskSize: '8 GiB',
        cbt: 'Yes'
      },
      targetOptions: migData.targetOptions || {
        flavor: 'Inherited from source',
        diskBus: 'VirtIO',
        osDistro: 'Alma Linux 9',
        machineType: 'pc-q35',
        dhcp: 'Yes',
        retainCreds: 'Yes',
        deleteDisks: 'Yes'
      },
      replications: migData.replications || [],
      deployments: migData.deployments || [],
      ipAddress: '',
      linuxWorkerIp: '',
      windowsWorkerIp: '',
      linuxWorkerImage: 'vporter-minion-linux',
      windowsWorkerImage: 'vporter-minion-windows',
      morphWorkerImage: 'vporter-minion-linux',
      networkName: '',
      networkId: '',
      created: now,
      ...migData,
      updated: now,
    };
    if (!saved.id) saved.id = `mig-${Math.random().toString(36).substr(2, 9)}`;
    if (!saved.created) saved.created = now;
    migs.unshift(saved);
  }

  await atomicWriteJson(MIGRATIONS_FILE, migs);
  return saved;
}

/**
 * Delete a migration record
 * @param {string} id
 */
export async function deleteMigration(id) {
  const migs = await loadMigrations();
  const filtered = migs.filter(m => m.id !== id);
  await ensureDataDir();
  await atomicWriteJson(MIGRATIONS_FILE, filtered);
  return true;
}

