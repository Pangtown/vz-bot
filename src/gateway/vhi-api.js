import { extractContext, json, verifyWebPassword } from './vhi-api/helpers.js';
import { handleAuth } from './vhi-api/auth.js';
import { handleMarketplaceScripts } from './vhi-api/marketplace.js';
import { handleServers, handleServerGet, handleServerDelete, handleServerAction, handleCreateServer, handleFlavors, handleFlavorDelete, handleKeypairs, handleNodes, handleNodeGet, handleNodeAction, handleImages, handleCreateImage, handleUploadImage, handleUpdateImage, handleDeleteImage, handleServerInterfaces, handleServerVolumes, handleQuotas, handleCreateVmCatalog } from './vhi-api/compute.js';
import { handleNetworks, handleNetworkDelete, handleSubnetCreate, handleSubnetDelete, handleSecurityGroups, handleSecurityGroupDelete, handleSecurityGroupRule, handleSecurityGroupRuleDelete, handleFloatingIPs, handleRouters, handleRouterInterface, handlePorts, handlePortGet, handlePortUpdate } from './vhi-api/network.js';
import { handleVolumeTypes, handleVolumes, handleVolumeGet, handleVolumeUpdate, handleVolumeDelete, handleVolumeExtend, handleVolumeRetype, handleSnapshots, handleSnapshotAction } from './vhi-api/block.js';
import { handleProjects, handleProjectItem, handleUsers, handleDomains, handleGroups, handleRoles, handleRoleAssignments, handleProjectAccess } from './vhi-api/identity.js';
import { handleHealthStatus, handleBillingStatus, handleBillingRefresh, handleBillingExport, handleAuditLogs, handleAuditRefresh, handleGetSshSettings, handlePostSshSettings } from './vhi-api/monitoring.js';
import { handleJobs, handleJobRun } from './vhi-api/jobs.js';
import { handleDr } from './vhi-api/dr.js';
import { handleCloudTest, handleGetClouds, handleCreateCloud, handleDeleteCloud, handleGetCloudVms, handleGetMigrations, handleCreateMigration, handleGetMigration, handleDeployMigration, handleRetryReplication, handleCancelMigration, handleDeleteMigration, handleCleanupClones } from './vhi-api/clouds.js';
import { handleCloneBlob, handleCloneProgress } from '../vmware/porter-clone.js';
import { searchAlerts } from '../monitoring/alert-storage.js';
import { runAlertPoll } from '../monitoring/alert-poller.js';
import { loadGlobalSshConfig } from '../monitoring/ssh-storage.js';
import { logger } from '../utils/index.js';

export async function handleVhiApi(req, res) {
  const m = req.method || 'GET';
  const url = req.url || '';
  const p = url.split('?')[0].replace(/\/$/, '');

  // Porter clone fetch is token-authenticated; the worker has no web password.
  const cloneBlobMatch = p.match(/^\/api\/vhi\/migrations\/([^/]+)\/clone-blob$/);
  if (m === 'GET' && cloneBlobMatch) {
    await handleCloneBlob(req, res, cloneBlobMatch[1], url);
    return true;
  }
  const cloneProgressMatch = p.match(/^\/api\/vhi\/migrations\/([^/]+)\/clone-progress$/);
  if (m === 'POST' && cloneProgressMatch) {
    await handleCloneProgress(req, res, cloneProgressMatch[1], url);
    return true;
  }

  if (!verifyWebPassword(req)) {
    json(res, 401, { error: 'Unauthorized: Invalid or missing web password' });
    return true;
  }

  if (m === 'POST' && p === '/api/vhi/auth') {
    await handleAuth(req, res);
    return true;
  }

  if (p.startsWith('/api/vhi/marketplace/scripts')) {
    await handleMarketplaceScripts(req, res, m, p);
    return true;
  }

  if (m === 'GET' && p === '/api/vhi/clusters/all') {
      const allConfigs = await loadGlobalSshConfig();
      const clusterUrls = Object.keys(allConfigs);
      json(res, 200, { clusters: clusterUrls });
      return true;
  }

  // ── VMware / ESXi Clouds Management (VDDK Bypass) ─────────────────────────
  if (m === 'POST' && p === '/api/vhi/clouds/test') {
    await handleCloudTest(req, res);
    return true;
  }
  if (m === 'GET' && p === '/api/vhi/clouds') {
    await handleGetClouds(req, res);
    return true;
  }
  if (m === 'POST' && p === '/api/vhi/clouds') {
    await handleCreateCloud(req, res);
    return true;
  }
  const cloudVmsMatch = p.match(/^\/api\/vhi\/clouds\/([^/]+)\/vms$/);
  if (m === 'GET' && cloudVmsMatch) {
    await handleGetCloudVms(req, res, cloudVmsMatch[1]);
    return true;
  }
  const cloudDeleteMatch = p.match(/^\/api\/vhi\/clouds\/([^/]+)$/);
  if (m === 'DELETE' && cloudDeleteMatch) {
    await handleDeleteCloud(req, res, cloudDeleteMatch[1]);
    return true;
  }

  // ── Migrations Management (Replication & Deployment Lifecycle) ───────────
  if (m === 'GET' && p === '/api/vhi/migrations') {
    await handleGetMigrations(req, res);
    return true;
  }
  if (m === 'POST' && p === '/api/vhi/migrations') {
    await handleCreateMigration(req, res);
    return true;
  }
  const migrationItemMatch = p.match(/^\/api\/vhi\/migrations\/([^/]+)$/);
  if (m === 'GET' && migrationItemMatch) {
    await handleGetMigration(req, res, migrationItemMatch[1]);
    return true;
  }
  const migrationDeployMatch = p.match(/^\/api\/vhi\/migrations\/([^/]+)\/deploy$/);
  if (m === 'POST' && migrationDeployMatch) {
    await handleDeployMigration(req, res, migrationDeployMatch[1]);
    return true;
  }
  const migrationRetryMatch = p.match(/^\/api\/vhi\/migrations\/([^/]+)\/retry-replication$/);
  if (m === 'POST' && migrationRetryMatch) {
    await handleRetryReplication(req, res, migrationRetryMatch[1]);
    return true;
  }
  const migrationCancelMatch = p.match(/^\/api\/vhi\/migrations\/([^/]+)\/cancel$/);
  if (m === 'POST' && migrationCancelMatch) {
    await handleCancelMigration(req, res, migrationCancelMatch[1]);
    return true;
  }
  if (m === 'DELETE' && migrationItemMatch) {
    await handleDeleteMigration(req, res, migrationItemMatch[1]);
    return true;
  }
  if (m === 'POST' && p === '/api/vhi/clones/cleanup') {
    await handleCleanupClones(req, res);
    return true;
  }

  const ctx = extractContext(req);
  if (!ctx.vhiBaseUrl || !ctx.vhiUser || !ctx.vhiPassword) {
    json(res, 401, { error: 'Missing VHI credentials. Login first.' });
    return true;
  }

  try {
      if (m === 'GET' && p === '/api/vhi/servers') { await handleServers(req, res, ctx); return true; }
      
      if (m === 'GET' && p === '/api/vhi/alerts') {
          const q = new URL(url, `http://${req.headers.host}`).searchParams.get('q') || '';
          const limit = parseInt(new URL(url, `http://${req.headers.host}`).searchParams.get('limit')) || 100;
          const offset = parseInt(new URL(url, `http://${req.headers.host}`).searchParams.get('offset')) || 0;
          const logs = searchAlerts({ query: q, clusterUrl: ctx.vhiBaseUrl, limit, offset });
          json(res, 200, { alerts: logs });
          return true;
      }
      if (m === 'POST' && p === '/api/vhi/alerts-refresh') {
          await runAlertPoll(ctx);
          json(res, 200, { ok: true });
          return true;
      }
      
      if (m === 'GET' && p === '/api/vhi/health-status') { await handleHealthStatus(req, res, ctx); return true; }
      if (m === 'GET' && p === '/api/vhi/billing-status') { await handleBillingStatus(req, res, ctx); return true; }
      if (m === 'POST' && p === '/api/vhi/billing-refresh') { await handleBillingRefresh(req, res, ctx); return true; }
      if (m === 'GET' && p === '/api/vhi/billing-export') { await handleBillingExport(req, res, ctx); return true; }
      
      if (m === 'GET' && p === '/api/vhi/audit-logs') { await handleAuditLogs(req, res, ctx); return true; }
      if (m === 'POST' && p === '/api/vhi/audit-refresh') { await handleAuditRefresh(req, res, ctx); return true; }
      
      const serverGetMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)$/);
      if (m === 'GET' && serverGetMatch) { await handleServerGet(req, res, ctx, serverGetMatch[1]); return true; }
      if (m === 'DELETE' && serverGetMatch) { await handleServerDelete(req, res, ctx, serverGetMatch[1]); return true; }
      if (m === 'POST' && p === '/api/vhi/servers') { await handleCreateServer(req, res, ctx); return true; }
      const actionMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)\/action$/);
      if (m === 'POST' && actionMatch) { await handleServerAction(req, res, ctx, actionMatch[1]); return true; }
      
      const interfaceMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)\/interfaces(?:\/([^/]+))?$/);
      if (interfaceMatch) { await handleServerInterfaces(req, res, ctx, interfaceMatch[1], interfaceMatch[2]); return true; }

      const volumeAttachMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)\/volumes(?:\/([^/]+))?$/);
      if (volumeAttachMatch) { await handleServerVolumes(req, res, ctx, volumeAttachMatch[1], volumeAttachMatch[2]); return true; }

      if (m === 'GET' && p === '/api/vhi/nodes') { await handleNodes(req, res, ctx); return true; }

      const nodeGetMatch = p.match(/^\/api\/vhi\/nodes\/([^/]+)$/);
      if (m === 'GET' && nodeGetMatch) { await handleNodeGet(req, res, ctx, nodeGetMatch[1]); return true; }

      const nodeActionMatch = p.match(/^\/api\/vhi\/nodes\/([^/]+)\/action$/);
      if (m === 'POST' && nodeActionMatch) { await handleNodeAction(req, res, ctx, nodeActionMatch[1]); return true; }

      if (p === '/api/vhi/networks') { await handleNetworks(req, res, ctx); return true; }
      const netDel = p.match(/^\/api\/vhi\/networks\/([^/]+)$/);
      if (m === 'DELETE' && netDel) { await handleNetworkDelete(req, res, ctx, netDel[1]); return true; }
      if (m === 'POST' && p === '/api/vhi/subnets') { await handleSubnetCreate(req, res, ctx); return true; }
      const subDel = p.match(/^\/api\/vhi\/subnets\/([^/]+)$/);
      if (m === 'DELETE' && subDel) { await handleSubnetDelete(req, res, ctx, subDel[1]); return true; }

      if (p === '/api/vhi/security-groups') { await handleSecurityGroups(req, res, ctx); return true; }
      const sgDel = p.match(/^\/api\/vhi\/security-groups\/([^/]+)$/);
      if (m === 'DELETE' && sgDel) { await handleSecurityGroupDelete(req, res, ctx, sgDel[1]); return true; }
      const sgRule = p.match(/^\/api\/vhi\/security-groups\/([^/]+)\/rules$/);
      if (m === 'POST' && sgRule) { await handleSecurityGroupRule(req, res, ctx, sgRule[1]); return true; }
      const sgRuleDel = p.match(/^\/api\/vhi\/security-group-rules\/([^/]+)$/);
      if (m === 'DELETE' && sgRuleDel) { await handleSecurityGroupRuleDelete(req, res, ctx, sgRuleDel[1]); return true; }

      if (p === '/api/vhi/floating-ips') { await handleFloatingIPs(req, res, ctx); return true; }
      const fipMatch = p.match(/^\/api\/vhi\/floating-ips\/([^/]+)$/);
      if (fipMatch) { await handleFloatingIPs(req, res, ctx, fipMatch[1]); return true; }

      if (p === '/api/vhi/routers') { await handleRouters(req, res, ctx); return true; }
      const rtrMatch = p.match(/^\/api\/vhi\/routers\/([^/]+)$/);
      if (rtrMatch && (m === 'DELETE' || m === 'GET')) { await handleRouters(req, res, ctx, rtrMatch[1]); return true; }
      const rtrIf = p.match(/^\/api\/vhi\/routers\/([^/]+)\/(add|remove)-interface$/);
      if (m === 'POST' && rtrIf) { await handleRouterInterface(req, res, ctx, rtrIf[1], rtrIf[2]); return true; }

      if (m === 'GET' && p === '/api/vhi/ports') { await handlePorts(req, res, ctx); return true; }
      const portMatch = p.match(/^\/api\/vhi\/ports\/([^/]+)$/);
      if (m === 'GET' && portMatch) { await handlePortGet(req, res, ctx, portMatch[1]); return true; }
      if (m === 'PATCH' && portMatch) { await handlePortUpdate(req, res, ctx, portMatch[1]); return true; }

      if (m === 'GET' && p === '/api/vhi/quotas') { await handleQuotas(req, res, ctx); return true; }
      if (m === 'GET' && p === '/api/vhi/create-vm-catalog') { await handleCreateVmCatalog(req, res, ctx); return true; }
      if (p === '/api/vhi/flavors') { await handleFlavors(req, res, ctx); return true; }
      const flvDel = p.match(/^\/api\/vhi\/flavors\/([^/]+)$/);
      if (m === 'DELETE' && flvDel) { await handleFlavorDelete(req, res, ctx, flvDel[1]); return true; }

      if (p === '/api/vhi/keypairs') { await handleKeypairs(req, res, ctx); return true; }
      const kpDel = p.match(/^\/api\/vhi\/keypairs\/([^/]+)$/);
      if (m === 'DELETE' && kpDel) { await handleKeypairs(req, res, ctx, kpDel[1]); return true; }

      if (p === '/api/vhi/dr' || p.startsWith('/api/vhi/dr/')) {
        await handleDr(req, res, ctx, p.replace(/^\/api\/vhi\/dr\/?/, ''));
        return true;
      }

      if (p === '/api/vhi/jobs') { await handleJobs(req, res, ctx); return true; }
      const jobRun = p.match(/^\/api\/vhi\/jobs\/([^/]+)\/run$/);
      if (m === 'POST' && jobRun) { await handleJobRun(req, res, ctx, jobRun[1]); return true; }
      const jobMatch = p.match(/^\/api\/vhi\/jobs\/([^/]+)$/);
      if (jobMatch) { await handleJobs(req, res, ctx, jobMatch[1]); return true; }

      if (p === '/api/vhi/volumes') { await handleVolumes(req, res, ctx); return true; }
      if (p === '/api/vhi/volume-types') { await handleVolumeTypes(req, res, ctx); return true; }
      
      const volMatch = p.match(/^\/api\/vhi\/volumes\/([^/]+)$/);
      if (volMatch) {
        if (m === 'GET') { await handleVolumeGet(req, res, ctx, volMatch[1]); return true; }
        if (m === 'PATCH') { await handleVolumeUpdate(req, res, ctx, volMatch[1]); return true; }
        if (m === 'DELETE') { await handleVolumeDelete(req, res, ctx, volMatch[1]); return true; }
      }

      const volExtendMatch = p.match(/^\/api\/vhi\/volumes\/([^/]+)\/extend$/);
      if (m === 'POST' && volExtendMatch) { await handleVolumeExtend(req, res, ctx, volExtendMatch[1]); return true; }

      const volRetypeMatch = p.match(/^\/api\/vhi\/volumes\/([^/]+)\/retype$/);
      if (m === 'POST' && volRetypeMatch) { await handleVolumeRetype(req, res, ctx, volRetypeMatch[1]); return true; }

      if (p === '/api/vhi/snapshots') { await handleSnapshots(req, res, ctx); return true; }
      const snapMatch = p.match(/^\/api\/vhi\/snapshots\/([^/]+)$/);
      if (m === 'DELETE' && snapMatch) { await handleSnapshots(req, res, ctx, snapMatch[1]); return true; }
      
      const snapActionMatch = p.match(/^\/api\/vhi\/snapshots\/([^/]+)\/action$/);
      if (m === 'POST' && snapActionMatch) { await handleSnapshotAction(req, res, ctx, snapActionMatch[1]); return true; }

      if (m === 'GET' && p === '/api/vhi/images') { await handleImages(req, res, ctx); return true; }
      if (m === 'POST' && p === '/api/vhi/images') { await handleCreateImage(req, res, ctx); return true; }
      const imgFileMatch = p.match(/^\/api\/vhi\/images\/([^/]+)\/file$/);
      if (m === 'PUT' && imgFileMatch) { await handleUploadImage(req, res, ctx, imgFileMatch[1]); return true; }
      const imgMatch = p.match(/^\/api\/vhi\/images\/([^/]+)$/);
      if (m === 'PATCH' && imgMatch) { await handleUpdateImage(req, res, ctx, imgMatch[1]); return true; }
      if (m === 'DELETE' && imgMatch) { await handleDeleteImage(req, res, ctx, imgMatch[1]); return true; }

      if (m === 'GET' && p === '/api/vhi/projects') { await handleProjects(req, res, ctx); return true; }
      const projectMatch = p.match(/^\/api\/vhi\/projects\/([^/]+)$/);
      if (projectMatch) { await handleProjectItem(req, res, ctx, decodeURIComponent(projectMatch[1])); return true; }
      if (p === '/api/vhi/users') { await handleUsers(req, res, ctx); return true; }
      if (p === '/api/vhi/groups') { await handleGroups(req, res, ctx); return true; }
      if (m === 'GET' && p === '/api/vhi/roles') { await handleRoles(req, res, ctx); return true; }
      if (m === 'GET' && p === '/api/vhi/role-assignments') { await handleRoleAssignments(req, res, ctx); return true; }
      if (m === 'POST' && p === '/api/vhi/project-access') { await handleProjectAccess(req, res, ctx); return true; }
      if (p === '/api/vhi/domains') { await handleDomains(req, res, ctx); return true; }
      const domainMatch = p.match(/^\/api\/vhi\/domains\/([^/]+)$/);
      if (domainMatch) { await handleDomains(req, res, ctx, decodeURIComponent(domainMatch[1])); return true; }

      if (m === 'GET' && p === '/api/vhi/settings/ssh') { await handleGetSshSettings(req, res, ctx); return true; }
      if (m === 'POST' && p === '/api/vhi/settings/ssh') { await handlePostSshSettings(req, res, ctx); return true; }
      
  } catch(e) {
      logger.error(`Error in VHI router: ${e.message}`, { error: e.stack, path: p });
      json(res, 500, { error: e.message });
      return true;
  }

  return false;
}
