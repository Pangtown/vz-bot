import { mkdtempSync, readFileSync, rmSync, existsSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  clusterContext,
  decryptSecret,
  deleteCluster,
  encryptSecret,
  listClusters,
  resetClusterStoreForTests,
  upsertCluster,
} from '../src/gateway/cluster-store.js';
import { extractContext } from '../src/gateway/vhi-api/helpers.js';

const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'clusters.json');

describe('cluster store', () => {
  const origEnv = { ...process.env };
  let backupDir;

  beforeAll(() => {
    backupDir = mkdtempSync(join(tmpdir(), 'vzbot-clusters-'));
    if (existsSync(STORE)) copyFileSync(STORE, join(backupDir, 'clusters.json'));
  });

  afterAll(() => {
    const saved = join(backupDir, 'clusters.json');
    if (existsSync(saved)) copyFileSync(saved, STORE);
    else rmSync(STORE, { force: true });
    rmSync(backupDir, { recursive: true, force: true });
    resetClusterStoreForTests();
  });

  beforeEach(() => {
    process.env.CLUSTER_SECRET_KEY = 'test-key-for-cluster-store';
    rmSync(STORE, { force: true });
    resetClusterStoreForTests();
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test('passwords are encrypted at rest and never listed', () => {
    upsertCluster({ baseUrl: 'dr.example.com', username: 'admin', password: 'dr-secret', project: 'admin' });
    const raw = readFileSync(STORE, 'utf8');
    expect(raw).not.toContain('dr-secret');

    const [listed] = listClusters();
    expect(listed.id).toBe('dr.example.com_admin');
    expect(listed.hasPassword).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('dr-secret');

    expect(clusterContext('dr.example.com_admin').vhiPassword).toBe('dr-secret');
  });

  test('saving without a password keeps the existing one', () => {
    upsertCluster({ baseUrl: 'https://a.local', username: 'admin', password: 'first' });
    upsertCluster({ baseUrl: 'https://a.local', username: 'admin', userDomain: 'Corp' });
    const ctx = clusterContext('a.local_admin');
    expect(ctx.vhiPassword).toBe('first');
    expect(ctx.vhiDomain).toBe('Corp');
    expect(deleteCluster('a.local_admin')).toBe(true);
    expect(clusterContext('a.local_admin')).toBeNull();
  });

  test('a different key cannot read saved passwords', () => {
    const blob = encryptSecret('value');
    process.env.CLUSTER_SECRET_KEY = 'another-key';
    expect(decryptSecret(blob)).toBe('');
  });

  test('X-VHI-Cluster-Id uses saved credentials only for authorized requests', () => {
    process.env.WEB_PASSWORD = 'console-pw';
    upsertCluster({ baseUrl: 'https://b.local', username: 'svc', password: 'b-secret' });

    const denied = extractContext({ headers: { 'x-vhi-cluster-id': 'b.local_admin' } });
    expect(denied.vhiPassword).toBe('');

    const allowed = extractContext({ headers: { 'x-vhi-cluster-id': 'b.local_admin', 'x-web-password': 'console-pw' } });
    expect(allowed.vhiBaseUrl).toBe('https://b.local');
    expect(allowed.vhiUser).toBe('svc');
    expect(allowed.vhiPassword).toBe('b-secret');
  });
});
