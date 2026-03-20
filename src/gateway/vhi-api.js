/**
 * VHI Dashboard API handler
 * Handles all /api/vhi/* requests, injecting per-request credentials via runWithContext.
 */

import { runWithContext } from './context.js';
import { listServers, getServer, serverAction, startServer, stopServer, rebootServer, createServer, listFlavors, getVncConsole, listInterfaces, attachInterface, detachInterface } from '../vhi/compute.js';
import { listNetworks, listSubnets, getPort, updatePort, deletePort, listSecurityGroups } from '../vhi/network.js';
import { listVolumes, listVolumeTypes, attachVolume, detachVolume, createVolume, deleteVolume, extendVolume, updateVolume } from '../vhi/block.js';
import { listImages } from '../vhi/image.js';
import { getToken, listProjects, listUsers } from '../vhi/identity.js';

// ── helpers ────────────────────────────────────────────────────────────────

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let buf = '';
  for await (const chunk of req) buf += chunk;
  return buf ? JSON.parse(buf) : {};
}

/**
 * Extract VHI credentials from request headers.
 * The browser sends them as X-VHI-* headers (set at login time).
 */
function extractContext(req) {
  return {
    vhiBaseUrl:     req.headers['x-vhi-base-url']     || process.env.VHI_BASE_URL       || '',
    vhiUser:        req.headers['x-vhi-user']          || process.env.VHI_USER            || '',
    vhiPassword:    req.headers['x-vhi-password']      || process.env.VHI_PASSWORD         || '',
    vhiProject:     req.headers['x-vhi-project']       || process.env.VHI_PROJECT_NAME     || 'admin',
    vhiDomain:      req.headers['x-vhi-domain']        || process.env.VHI_DOMAIN_NAME      || 'Default',
    vhiProjectId:   req.headers['x-vhi-project-id']   || process.env.VHI_PROJECT_ID       || '',
    vhiSshHost:     req.headers['x-vhi-ssh-host']     || process.env.VHI_SSH_HOST         || '',
    vhiSshUser:     req.headers['x-vhi-ssh-user']     || process.env.VHI_SSH_USER         || 'root',
    vhiSshPassword: req.headers['x-vhi-ssh-password'] || process.env.VHI_SSH_PASSWORD     || '',
  };
}

// ── route handlers ─────────────────────────────────────────────────────────

/** POST /api/vhi/auth  – verify credentials, return token & project info */
async function handleAuth(req, res) {
  const body = await readBody(req);
  let hostStr = (body.baseUrl || '').replace(/https?:\/\//, '');
  // Extract just the host/IP if a port is attached (unless it's an IPv6 without brackets but that's complex, handling basic IPv6 [::1] or IP:port)
  let baseUrl = hostStr;
  if (hostStr.includes(']')) {
    baseUrl = hostStr.split(']')[0] + ']';
  } else if (hostStr.includes(':')) {
    baseUrl = hostStr.split(':')[0];
  } else {
    baseUrl = hostStr.split('/')[0];
  }

  const username = body.username  || '';
  const password = body.password  || '';
  const project  = body.project   || 'admin';
  const userDomain    = body.userDomain    || 'Default';
  const projectDomain = body.projectDomain || 'Default';

  if (!baseUrl || !username || !password) {
    return json(res, 400, { error: 'baseUrl, username and password are required' });
  }

  // we assume HTTPS if not specified, and port 5000 for Keystone
  const fullBase = `https://${baseUrl}`;
  const tokenUrl = `${fullBase}:5000/v3/auth/tokens`;

  const authPayload = {
    auth: {
      identity: {
        methods: ['password'],
        password: {
          user: {
            name: username,
            password,
            domain: { name: userDomain },
          },
        },
      },
      scope: {
        project: {
          name: project,
          domain: { name: projectDomain },
        },
      },
    },
  };

  try {
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authPayload),
    });

    if (!r.ok) {
      const text = await r.text();
      return json(res, 401, { error: `Auth failed (${r.status}): ${text.slice(0, 200)}` });
    }

    const token = r.headers.get('x-subject-token');
    let tokenData = null;
    try { tokenData = await r.json(); } catch (_) {}

    // Extract project ID from token body (required for Cinder /v3/{project_id}/volumes)
    const projectId = tokenData?.token?.project?.id || '';

    return json(res, 200, {
      ok: true,
      token,
      projectId,
      baseUrl:  fullBase,
      username,
      project,
      userDomain,
      projectDomain,
      expiresAt: tokenData?.token?.expires_at || null,
    });
  } catch (err) {
    return json(res, 502, { error: `Cannot reach ${tokenUrl}: ${err.message}` });
  }
}

/** GET /api/vhi/servers */
async function handleServers(req, res, ctx) {
  try {
    const servers = await runWithContext(ctx, () => listServers());
    return json(res, 200, { servers });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/servers/:id */
async function handleServerGet(req, res, ctx, serverId) {
  try {
    const server = await runWithContext(ctx, () => getServer(serverId));
    if (!server) return json(res, 404, { error: 'Server not found' });
    return json(res, 200, { server });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** POST /api/vhi/servers/:id/action  body: { action: 'start'|'stop'|'reboot' } */
async function handleServerAction(req, res, ctx, serverId) {
  const body = await readBody(req);
  const action = body.action;
  try {
    let consoleUrl = null;
    await runWithContext(ctx, async () => {
      if (action === 'start')  return startServer(serverId);
      if (action === 'stop')   return stopServer(serverId);
      if (action === 'reboot') return rebootServer(serverId, body.type || 'SOFT');
      if (action === 'resize') return serverAction(serverId, 'resize', { flavorRef: body.flavorId });
      if (action === 'confirmResize') return serverAction(serverId, 'confirmResize');
      if (action === 'revertResize')  return serverAction(serverId, 'revertResize');
      if (action === 'rename') return serverAction(serverId, 'update', { name: body.name });
      if (action === 'console') {
        consoleUrl = await getVncConsole(serverId);
        return;
      }
      throw new Error(`Unknown action: ${action}`);
    });
    return json(res, 200, { ok: true, url: consoleUrl });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/volume-types */
async function handleVolumeTypes(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, async () => {
      const base = ctx.vhiBaseUrl.replace(/\/$/, '');
      const port = process.env.VHI_BLOCK_PORT || 8776;
      const { getClient } = await import('../vhi/client.js');
      const client = await getClient();

      const projectId = ctx.vhiProjectId;
      const urls = projectId
        ? [
            `${base}:${port}/v3/${projectId}/types`,
            `${base}:${port}/v3/types`,
          ]
        : [`${base}:${port}/v3/types`];

      for (const url of urls) {
        const r = await client.fetch(url);
        if (r.ok) {
          const d = await r.json();
          return d.volume_types || [];
        }
        if (r.status !== 404) {
          const t = await r.text();
          throw new Error(`VHI Block listVolumeTypes failed (${r.status}): ${t.slice(0, 200)}`);
        }
      }
      throw new Error('VHI Block listVolumeTypes: could not find types endpoint');
    });
    return json(res, 200, { volume_types: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/flavors */
async function handleFlavors(req, res, ctx) {
  try {
    const flavors = await runWithContext(ctx, () => listFlavors());
    return json(res, 200, { flavors });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/volumes – uses project-ID-aware Cinder v3 URL */
async function handleVolumes(req, res, ctx) {
  try {
    const m = req.method;
    if (m === 'GET') {
      const data = await runWithContext(ctx, async () => {
        const base = ctx.vhiBaseUrl.replace(/\/$/, '');
        const port = process.env.VHI_BLOCK_PORT || 8776;
        const { getClient } = await import('../vhi/client.js');
        const client = await getClient();

        // Cinder v3 requires project_id in the path
        // Try with project_id first, fall back to the projectless URL
        const projectId = ctx.vhiProjectId;
        const urls = projectId
          ? [
              `${base}:${port}/v3/${projectId}/volumes/detail`,
              `${base}:${port}/v3/volumes/detail`,
            ]
          : [`${base}:${port}/v3/volumes/detail`];

        for (const url of urls) {
          const r = await client.fetch(url);
          if (r.ok) {
            const d = await r.json();
            return d.volumes || [];
          }
          if (r.status !== 404) {
            const t = await r.text();
            throw new Error(`VHI Block listVolumes failed (${r.status}): ${t.slice(0, 200)}`);
          }
          // 404 → try next URL
        }
        throw new Error('VHI Block listVolumes: could not find volumes endpoint (tried with and without project_id)');
      });
      return json(res, 200, { volumes: data });
    }
    if (m === 'POST') {
      const body = await readBody(req);
      const volume = await runWithContext(ctx, () => createVolume(body));
      return json(res, 200, { volume });
    }
    throw new Error(`Unsupported method ${m} for volumes`);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handleServerInterfaces(req, res, ctx, serverId, portId) {
  try {
    const m = req.method;
    if (m === 'GET') {
      const interfaces = await runWithContext(ctx, () => listInterfaces(serverId));
      return json(res, 200, { interfaces });
    }
    if (m === 'POST') {
      const body = await readBody(req);
      const iface = await runWithContext(ctx, () => attachInterface(serverId, body.network_id));
      return json(res, 200, { interface: iface });
    }
    if (m === 'PATCH' && portId) {
      const body = await readBody(req);
      const port = await runWithContext(ctx, () => updatePort(portId, body));
      return json(res, 200, { port });
    }
    if (m === 'DELETE' && portId) {
      await runWithContext(ctx, () => detachInterface(serverId, portId));
      return json(res, 200, { ok: true });
    }
    throw new Error(`Unsupported method ${m} for interfaces`);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handleServerVolumes(req, res, ctx, serverId, attachmentId) {
  try {
    const m = req.method;
    if (m === 'POST') {
      const body = await readBody(req);
      const att = await runWithContext(ctx, () => attachVolume(serverId, body.volume_id, body.device));
      return json(res, 200, { attachment: att });
    }
    if (m === 'DELETE' && attachmentId) {
      await runWithContext(ctx, () => detachVolume(serverId, attachmentId));
      return json(res, 200, { ok: true });
    }
    throw new Error(`Unsupported method ${m} for server volumes`);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** POST /api/vhi/servers */
async function handleCreateServer(req, res, ctx) {
  try {
    const payload = await readBody(req);
    const server = await runWithContext(ctx, () => createServer(payload));
    return json(res, 200, { server });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/networks */
async function handleNetworks(req, res, ctx) {
  try {
    const [networks, subnets] = await runWithContext(ctx, () =>
      Promise.all([listNetworks(), listSubnets()])
    );
    return json(res, 200, { networks, subnets });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handleSecurityGroups(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listSecurityGroups());
    return json(res, 200, { security_groups: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handlePortGet(req, res, ctx, id) {
  try {
    const data = await runWithContext(ctx, () => getPort(id));
    return json(res, 200, { port: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/images */
async function handleImages(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listImages());
    return json(res, 200, { images: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/projects */
async function handleProjects(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listProjects());
    return json(res, 200, { projects: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/users */
async function handleUsers(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listUsers());
    return json(res, 200, { users: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** GET /api/vhi/nodes  – hypervisor/compute node list via Nova */
async function handleNodes(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, async () => {
      const base = ctx.vhiBaseUrl.replace(/\/$/, '');
      const port = process.env.VHI_COMPUTE_PORT || 8774;
      const url = `${base}:${port}/v2.1/os-hypervisors/detail`;
      const { getClient } = await import('../vhi/client.js');
      const client = await getClient();
      const r = await client.fetch(url);
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Nodes list failed (${r.status}): ${t.slice(0, 200)}`);
      }
      const d = await r.json();
      return d.hypervisors || [];
    });
    return json(res, 200, { nodes: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

/** POST /api/vhi/nodes/:id/reboot */
async function handleNodeAction(req, res, ctx, nodeId) {
  const body = await readBody(req);
  const action = body.action;
  const creds = body.creds || {};
  try {
    let result = null;
    await runWithContext(ctx, async () => {
      if (action === 'reboot') {
        const { runVinfraCommand } = await import('../vhi/vinfra.js');
        
        // 1. Put node in maintenance mode (evacuate VMs)
        // We use --wait to ensure it's safe to reboot afterwards
        console.log(`Putting node ${nodeId} into maintenance...`);
        try {
          await runVinfraCommand(['node', 'maintenance', 'start', nodeId, '--wait'], creds);
        } catch (mErr) {
          console.warn(`Maintenance start failed (continuing anyway): ${mErr.message}`);
        }

        // 2. Execute direct reboot command on the host
        console.log(`Sending direct reboot command to ${nodeId}...`);
        // We use a separate call or chain it. Chaining is safer to ensure same session if needed,
        // but runVinfraCommand handles a single command with auth.
        // We'll run 'reboot' directly.
        // NOTE: This will likely cause the SSH connection to drop, which is expected.
        try {
          // We can't use 'vinfra' for the actual reboot if it's not supported.
          // We'll run a raw shell command. 
          // I'll add a 'raw' option to runVinfraCommand or just use a raw command array.
          await runVinfraCommand(['/sbin/reboot'], creds);
        } catch (rErr) {
          // SSH often drops connection on reboot, so we ignore connection reset errors
          if (!rErr.message.includes('ECONNRESET') && !rErr.message.includes('Socket connection item')) {
             throw rErr;
          }
        }
        return;
      }
      if (action === 'help') {
        const { runVinfraCommand } = await import('../vhi/vinfra.js');
        result = await runVinfraCommand(['help', 'node'], creds);
        return;
      }
      throw new Error(`Unknown node action: ${action}`);
    });
    return json(res, 200, { ok: true, help: result });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

async function handleVolumeExtend(req, res, ctx, id) {
  try {
    const { new_size } = await readBody(req);
    if (!new_size) throw new Error('Missing new_size');
    await runWithContext(ctx, () => extendVolume(id, parseInt(new_size)));
    return json(res, 202, { status: 'Accepted' });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
}

async function handleVolumeUpdate(req, res, ctx, id) {
  try {
    const options = await readBody(req);
    const data = await runWithContext(ctx, () => updateVolume(id, options));
    return json(res, 200, { volume: data });
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
}

// ── main dispatcher ────────────────────────────────────────────────────────

/**
 * Handle a request whose URL starts with /api/vhi/
 * @returns {boolean} true if handled, false to fall through to 404
 */
export async function handleVhiApi(req, res) {
  const m = req.method || 'GET';
  const url = req.url || '';

  // Strip query string
  const p = url.split('?')[0].replace(/\/$/, '');

  // Auth endpoint – no credentials needed up-front
  if (m === 'POST' && p === '/api/vhi/auth') {
    await handleAuth(req, res);
    return true;
  }

  // All other endpoints require credentials via headers
  const ctx = extractContext(req);
  if (!ctx.vhiBaseUrl || !ctx.vhiUser || !ctx.vhiPassword) {
    json(res, 401, { error: 'Missing VHI credentials. Login first.' });
    return true;
  }

  // Compute
  if (m === 'GET' && p === '/api/vhi/servers') return handleServers(req, res, ctx);
  
  const serverGetMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)$/);
  if (m === 'GET' && serverGetMatch) return handleServerGet(req, res, ctx, serverGetMatch[1]);
  if (m === 'POST' && p === '/api/vhi/servers') return handleCreateServer(req, res, ctx);
  const actionMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)\/action$/);
  if (m === 'POST' && actionMatch) return handleServerAction(req, res, ctx, actionMatch[1]);
  
  const interfaceMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)\/interfaces(?:\/([^/]+))?$/);
  if (interfaceMatch) return handleServerInterfaces(req, res, ctx, interfaceMatch[1], interfaceMatch[2]);

  const volumeAttachMatch = p.match(/^\/api\/vhi\/servers\/([^/]+)\/volumes(?:\/([^/]+))?$/);
  if (volumeAttachMatch) return handleServerVolumes(req, res, ctx, volumeAttachMatch[1], volumeAttachMatch[2]);

  if (m === 'GET' && p === '/api/vhi/flavors') return handleFlavors(req, res, ctx);
  if (m === 'GET' && p === '/api/vhi/nodes') return handleNodes(req, res, ctx);

  const nodeActionMatch = p.match(/^\/api\/vhi\/nodes\/([^/]+)\/action$/);
  if (m === 'POST' && nodeActionMatch) return handleNodeAction(req, res, ctx, nodeActionMatch[1]);

  // Network
  if (m === 'GET' && p === '/api/vhi/networks') return handleNetworks(req, res, ctx);
  if (m === 'GET' && p === '/api/vhi/security-groups') return handleSecurityGroups(req, res, ctx);
  
  const portMatch = p.match(/^\/api\/vhi\/ports\/([^/]+)$/);
  if (m === 'GET' && portMatch) return handlePortGet(req, res, ctx, portMatch[1]);

  // Block Storage
  if (p === '/api/vhi/volumes') return handleVolumes(req, res, ctx);
  if (p === '/api/vhi/volume-types') return handleVolumeTypes(req, res, ctx);
  
  const volMatch = p.match(/^\/api\/vhi\/volumes\/([^/]+)$/);
  if (m === 'PATCH' && volMatch) return handleVolumeUpdate(req, res, ctx, volMatch[1]);

  const volExtendMatch = p.match(/^\/api\/vhi\/volumes\/([^/]+)\/extend$/);
  if (m === 'POST' && volExtendMatch) return handleVolumeExtend(req, res, ctx, volExtendMatch[1]);

  // Image
  if (m === 'GET' && p === '/api/vhi/images') return handleImages(req, res, ctx);

  // Identity
  if (m === 'GET' && p === '/api/vhi/projects') return handleProjects(req, res, ctx);
  if (m === 'GET' && p === '/api/vhi/users') return handleUsers(req, res, ctx);

  return false; // not handled here
}
