import { runWithContext } from '../context.js';
import { getToken } from '../../vhi/identity.js';
import { clusterContext, deleteCluster, getCluster, listClusters, upsertCluster } from '../cluster-store.js';
import { createConsoleSession } from '../console-session.js';
import { registerInsecureHost } from '../../utils/tls.js';
import { json, readBody } from './helpers.js';

export async function handleListClusters(req, res) {
  return json(res, 200, { clusters: listClusters() });
}

export async function handleSaveCluster(req, res) {
  const body = await readBody(req);
  try {
    const saved = upsertCluster(body);
    return json(res, 200, { ok: true, cluster: saved });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
}

export async function handleDeleteCluster(req, res, id) {
  if (!deleteCluster(id)) return json(res, 404, { error: 'Cluster not found' });
  return json(res, 200, { ok: true });
}

export async function handleConnectCluster(req, res, id) {
  const ctx = clusterContext(id);
  if (!ctx) return json(res, 404, { error: 'Cluster not found' });
  if (!ctx.vhiPassword) return json(res, 409, { error: 'No saved password for this cluster', needsPassword: true });
  registerInsecureHost(ctx.vhiBaseUrl);
  try {
    const tok = await runWithContext(ctx, () => getToken());
    const projectId = tok.projectId || ctx.vhiProjectId || '';
    if (projectId && projectId !== ctx.vhiProjectId) upsertCluster({ ...getCluster(id), projectId });
    const sessionToken = createConsoleSession({
      baseUrl: ctx.vhiBaseUrl,
      username: ctx.vhiUser,
      password: ctx.vhiPassword,
      project: ctx.vhiProject,
      projectId,
      userDomain: ctx.vhiDomain,
      projectDomain: ctx.vhiProjectDomain,
      isAdmin: true,
    });
    return json(res, 200, {
      ok: true,
      sessionToken,
      clusterId: id,
      baseUrl: ctx.vhiBaseUrl,
      username: ctx.vhiUser,
      project: ctx.vhiProject,
      projectId,
      userDomain: ctx.vhiDomain,
      projectDomain: ctx.vhiProjectDomain,
    });
  } catch (err) {
    const status = /\(401\)/.test(err.message) ? 401 : 502;
    return json(res, status, { error: err.message, needsPassword: status === 401 });
  }
}
