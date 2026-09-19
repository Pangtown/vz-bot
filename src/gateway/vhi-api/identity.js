import { runWithContext } from '../context.js';
import { listProjects, listUsers, listDomains, getDomain, updateDomain, listGroups, createDomain, createUser, createGroup, listRoleAssignments, listRoles, assignRole, updateProject, deleteProject } from '../../vhi/identity.js';
import { clearTokenCache } from '../../vhi/client.js';
import { json, readBody } from './helpers.js';
import { logger } from '../../utils/index.js';

function query(req) {
  return new URL(req.url || '', 'http://localhost').searchParams;
}

export async function handleDomains(req, res, ctx, id) {
  const m = req.method || 'GET';
  try {
    if (m === 'GET' && !id) {
      const domains = await runWithContext(ctx, () => listDomains());
      return json(res, 200, { domains });
    }
    if (m === 'POST' && !id) {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name is required' });
      const domain = await runWithContext(ctx, () => createDomain(body));
      return json(res, 200, { domain });
    }
    if (m === 'GET' && id) {
      const domain = await runWithContext(ctx, () => getDomain(id));
      if (!domain) return json(res, 404, { error: 'Domain not found' });
      return json(res, 200, { domain });
    }
    if (m === 'PATCH' && id) {
      const body = await readBody(req);
      const patch = {};
      if (body.description !== undefined) patch.description = body.description;
      if (body.enabled !== undefined) patch.enabled = !!body.enabled;
      const domain = await runWithContext(ctx, () => updateDomain(id, patch));
      return json(res, 200, { domain });
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    logger.error(`handleDomains error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleProjects(req, res, ctx) {
  try {
    const domain_id = query(req).get('domain_id');
    const data = await runWithContext(ctx, () => listProjects(domain_id ? { domain_id } : {}));
    return json(res, 200, { projects: data });
  } catch (err) {
    logger.error(`handleProjects error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleProjectItem(req, res, ctx, id) {
  const m = req.method || 'GET';
  try {
    if (m === 'PATCH') {
      const body = await readBody(req);
      const project = await runWithContext(ctx, () => updateProject(id, body));
      return json(res, 200, { project });
    }
    if (m === 'DELETE') {
      await runWithContext(ctx, () => deleteProject(id));
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    logger.error(`handleProjectItem error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleUsers(req, res, ctx) {
  try {
    if ((req.method || 'GET') === 'POST') {
      const body = await readBody(req);
      if (!body.name || !body.domain_id) return json(res, 400, { error: 'name and domain_id are required' });
      const user = await runWithContext(ctx, () => createUser(body));
      let role_error = null;
      if (body.role_id && user?.id) {
        try {
          await runWithContext(ctx, () => assignRole({
            user_id: user.id,
            role_id: body.role_id,
            domain_id: body.domain_id,
            project_id: body.project_id,
          }));
        } catch (err) {
          role_error = err.message;
        }
      }
      return json(res, 200, { user, role_error });
    }
    const domain_id = query(req).get('domain_id');
    const data = await runWithContext(ctx, () => listUsers(domain_id ? { domain_id } : {}));
    return json(res, 200, { users: data });
  } catch (err) {
    logger.error(`handleUsers error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleGroups(req, res, ctx) {
  try {
    if ((req.method || 'GET') === 'POST') {
      const body = await readBody(req);
      if (!body.name || !body.domain_id) return json(res, 400, { error: 'name and domain_id are required' });
      const group = await runWithContext(ctx, () => createGroup(body));
      return json(res, 200, { group });
    }
    const domain_id = query(req).get('domain_id');
    const data = await runWithContext(ctx, () => listGroups(domain_id ? { domain_id } : {}));
    return json(res, 200, { groups: data });
  } catch (err) {
    logger.error(`handleGroups error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleRoles(req, res, ctx) {
  try {
    const roles = await runWithContext(ctx, () => listRoles());
    return json(res, 200, { roles });
  } catch (err) {
    logger.error(`handleRoles error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleRoleAssignments(req, res, ctx) {
  try {
    const q = query(req);
    const domain_id = q.get('domain_id');
    const project_id = q.get('project_id');
    const includeProjects = q.get('include_projects') === '1' || q.get('include_projects') === 'true';
    const assignments = await runWithContext(ctx, async () => {
      const out = [];
      if (domain_id) out.push(...await listRoleAssignments({ domain_id }));
      if (project_id) out.push(...await listRoleAssignments({ project_id }));
      if (includeProjects && domain_id) {
        const projects = await listProjects({ domain_id });
        for (const p of projects) {
          try { out.push(...await listRoleAssignments({ project_id: p.id })); } catch (_) { /* skip */ }
        }
      }
      return out;
    });
    return json(res, 200, { role_assignments: assignments });
  } catch (err) {
    logger.error(`handleRoleAssignments error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

function pickProjectRole(roles) {
  const order = ['admin', 'project_admin', 'member', 'user', '_member_'];
  for (const name of order) {
    const hit = (roles || []).find((r) => String(r.name || '').toLowerCase() === name);
    if (hit) return hit;
  }
  return (roles || [])[0] || null;
}

async function findUserByName(userName) {
  const named = await listUsers({ name: userName }).catch(() => []);
  let user = named.find((u) => u.name === userName);
  if (user) return user;
  const all = await listUsers({}).catch(() => []);
  return all.find((u) => u.name === userName) || null;
}

export async function handleProjectAccess(req, res, ctx) {
  try {
    const body = await readBody(req);
    const projectId = body.project_id;
    if (!projectId) return json(res, 400, { error: 'project_id is required' });
    const result = await runWithContext(ctx, async () => {
      const userName = ctx.vhiUser;
      if (!userName) throw new Error('No VHI user in this session');
      const user = await findUserByName(userName);
      if (!user) throw new Error(`Could not find user ${userName} in Keystone`);
      const roles = await listRoles();
      const role = pickProjectRole(roles);
      if (!role) throw new Error('No admin or member role exists to assign');
      const existing = await listRoleAssignments({ project_id: projectId });
      const already = existing.some((a) =>
        a.user?.id === user.id || a.user_id === user.id || a.user?.name === userName
      );
      if (!already) {
        await assignRole({ user_id: user.id, role_id: role.id, project_id: projectId });
      }
      return { ok: true, granted: !already, user_id: user.id, role: role.name };
    });
    clearTokenCache();
    return json(res, 200, result);
  } catch (err) {
    logger.error(`handleProjectAccess error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}
