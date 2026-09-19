import { json, readBody, extractContext } from './helpers.js';
import { testEsxiConnection, getEsxiVmInventory } from '../../vmware/esxi-client.js';
import { testVhiConnection, testHyperVConnection, listVhiCloudVms, listHyperVCloudVms } from '../../vmware/cloud-connectors.js';
import { loadClouds, getCloudById, saveCloud, deleteCloud, loadMigrations, getMigrationById, deleteMigration } from '../../vmware/cloud-storage.js';
import { createAndStartMigration, startDeployment, retryReplication, cancelMigration, cleanupMigrationResources } from '../../vmware/migration-engine.js';
import { sweepIdleCloneStore } from '../../vmware/windows-replica-fill.js';
import { logger } from '../../utils/index.js';

/**
 * POST /api/vhi/clouds/test
 * Test connection to an ESXi or vCenter host
 */

function cloudKind(type) {
  return String(type || 'VMWARE').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function testCloudConnection(body) {
  const kind = cloudKind(body.type);
  const host = body.host;
  const port = body.port;
  const user = body.user;
  const pass = body.pass;
  const insecure = body.insecure !== false;
  if (!host || !user || !pass) {
    return { ok: false, error: 'Host, username, and password are required.' };
  }
  if (kind === 'VHI' || kind === 'VZINFRA' || kind === 'VIRTUOZZOINFRASTRUCTURE') {
    return testVhiConnection({
      host,
      port: Number(port) || 5000,
      user,
      pass,
      insecure,
      project: body.project || 'admin',
      domain: body.domain || 'Default',
    });
  }
  if (kind === 'HYPERV' || kind === 'HYPERVWINRM') {
    return testHyperVConnection({
      host,
      port: Number(port) || 5986,
      user,
      pass,
      insecure,
    });
  }
  return testEsxiConnection({
    host,
    port: Number(port) || 443,
    username: user,
    password: pass,
    insecure,
  });
}

export async function handleCloudTest(req, res) {
  try {
    const body = await readBody(req);
    const result = await testCloudConnection(body);
    json(res, result.ok ? 200 : 400, result);
  } catch (err) {
    logger.error('Error in handleCloudTest: ' + err.message, { error: err });
    json(res, 500, { ok: false, error: err.message || 'Internal connection test failure' });
  }
}

export async function handleGetClouds(req, res) {
  try {
    const clouds = await loadClouds(false);
    json(res, 200, { clouds });
  } catch (err) {
    logger.error(`Error in handleGetClouds: ${err.message}`);
    json(res, 500, { error: 'Failed to load clouds' });
  }
}

/**
 * POST /api/vhi/clouds
 * Save and optionally validate an ESXi / vCenter cloud connection
 */
export async function handleCreateCloud(req, res) {
  try {
    const body = await readBody(req);
    const { name, desc, host, port, user, pass, insecure = true, force = false } = body;
    const type = cloudKind(body.type);

    if (!name || !host || !user || !pass) {
      json(res, 400, { error: 'Name, host, username, and password are required.' });
      return;
    }

    let serverInfo = null;
    let status = 'CONNECTED';
    const defaultPort = type === 'HYPERV' ? 5986 : type === 'VHI' ? 5000 : 443;

    if (!force) {
      const testResult = await testCloudConnection({ ...body, type });
      if (!testResult.ok) {
        json(res, 400, {
          error: 'Connection validation failed: ' + testResult.error,
          validationDetails: testResult,
        });
        return;
      }
      serverInfo = testResult.serverInfo;
      if (testResult.usedPort) body.port = testResult.usedPort;
    }

    const saved = await saveCloud({
      name,
      desc,
      type,
      host,
      port: Number(body.port || port) || defaultPort,
      user,
      pass,
      insecure: insecure !== false,
      project: body.project || 'admin',
      domain: body.domain || 'Default',
      serverInfo,
      status,
    });

    json(res, 201, { ok: true, cloud: saved });
  } catch (err) {
    logger.error(`Error in handleCreateCloud: ${err.message}`, { error: err });
    json(res, 500, { error: err.message || 'Failed to save cloud' });
  }
}

/**
 * DELETE /api/vhi/clouds/:id
 * Remove a cloud connection
 */
export async function handleDeleteCloud(req, res, cloudId) {
  try {
    await deleteCloud(cloudId);
    json(res, 200, { ok: true, message: 'Cloud deleted successfully' });
  } catch (err) {
    logger.error(`Error in handleDeleteCloud: ${err.message}`);
    json(res, 500, { error: 'Failed to delete cloud' });
  }
}

/**
 * GET /api/vhi/clouds/:id/vms
 * Connect directly to the ESXi host and retrieve live VM inventory
 */
export async function handleGetCloudVms(req, res, cloudId) {
  try {
    const cloud = await getCloudById(cloudId, true);
    if (!cloud) {
      json(res, 404, { error: 'Cloud connection not found' });
      return;
    }

    const kind = cloudKind(cloud.type);
    let vms = [];
    if (kind === 'VHI') {
      logger.info('Fetching VM inventory from VHI ' + cloud.host + ' for cloud ' + cloud.name);
      vms = await listVhiCloudVms(cloud);
    } else if (kind === 'HYPERV' || kind === 'HYPERVWINRM') {
      logger.info('Fetching VM inventory from Hyper-V ' + cloud.host + ' for cloud ' + cloud.name);
      vms = await listHyperVCloudVms(cloud);
    } else {
      logger.info('Fetching live VM inventory from ESXi host ' + cloud.host + ' for cloud ' + cloud.name);
      vms = await getEsxiVmInventory({
        host: cloud.host,
        port: cloud.port,
        username: cloud.user,
        password: cloud.pass,
        insecure: cloud.insecure,
      });
    }

    json(res, 200, {
      ok: true,
      cloudId: cloud.id,
      cloudName: cloud.name,
      host: cloud.host,
      count: vms.length,
      vms,
    });
  } catch (err) {
    logger.error(`Failed to retrieve VMs from cloud ${cloudId}: ${err.message}`);
    json(res, 502, {
      ok: false,
      error: `Failed to query cloud inventory: ${err.message}`,
    });
  }
}

/**
 * GET /api/vhi/migrations
 */
export async function handleGetMigrations(req, res) {
  try {
    const migrations = await loadMigrations();
    json(res, 200, { migrations: migrations.map(sanitizeMigration) });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * POST /api/vhi/migrations
 */
export async function handleCreateMigration(req, res) {
  try {
    const body = await readBody(req);
    const ctx = extractContext(req);
    const saved = await createAndStartMigration(body, ctx);
    json(res, 201, { ok: true, migration: sanitizeMigration(saved) });
  } catch (err) {
    logger.error(`handleCreateMigration error: ${err.message}`);
    json(res, 400, { error: err.message });
  }
}

/**
 * GET /api/vhi/migrations/:id
 */
export async function handleGetMigration(req, res, id) {
  try {
    const migration = await getMigrationById(id);
    if (!migration) return json(res, 404, { error: 'Migration not found' });
    json(res, 200, { migration: sanitizeMigration(migration) });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * POST /api/vhi/migrations/:id/deploy
 */
export async function handleDeployMigration(req, res, id) {
  try {
    const saved = await startDeployment(id);
    json(res, 200, { ok: true, migration: sanitizeMigration(saved) });
  } catch (err) {
    logger.error(`handleDeployMigration error: ${err.message}`);
    json(res, 400, { error: err.message });
  }
}

/**
 * POST /api/vhi/migrations/:id/retry-replication
 */
export async function handleRetryReplication(req, res, id) {
  try {
    const saved = await retryReplication(id);
    json(res, 200, { ok: true, migration: sanitizeMigration(saved) });
  } catch (err) {
    logger.error(`handleRetryReplication error: ${err.message}`);
    json(res, 400, { error: err.message });
  }
}

/**
 * POST /api/vhi/migrations/:id/cancel
 */
export async function handleCancelMigration(req, res, id) {
  try {
    const saved = await cancelMigration(id);
    json(res, 200, { ok: true, migration: sanitizeMigration(saved) });
  } catch (err) {
    logger.error(`handleCancelMigration error: ${err.message}`);
    json(res, 400, { error: err.message });
  }
}

/**
 * DELETE /api/vhi/migrations/:id
 */
export async function handleDeleteMigration(req, res, id) {
  try {
    await cleanupMigrationResources(id, { keepTarget: true });
    await deleteMigration(id);
    json(res, 200, { ok: true, message: 'Migration deleted successfully' });
  } catch (err) {
    logger.error(`handleDeleteMigration error: ${err.message}`);
    json(res, 500, { error: err.message });
  }
}

/**
 * POST /api/vhi/clones/cleanup
 * Delete idle clone cache files (.raw / .qcow2 / .ok) not used by an in-flight migration.
 * Retryable ERROR/CANCELLED caches are removed here; the scheduled sweep leaves them for retry.
 */
export async function handleCleanupClones(req, res) {
  try {
    const result = await sweepIdleCloneStore({ keepRetryable: false });
    json(res, 200, { ok: true, files: result.files, bytes: result.bytes });
  } catch (err) {
    logger.error(`handleCleanupClones error: ${err.message}`);
    json(res, 500, { error: err.message });
  }
}

function sanitizeMigration(mig) {
  if (!mig) return mig;
  const { context, ...rest } = mig;
  return {
    ...rest,
    hasCredentials: !!(context && context.vhiPassword),
  };
}

