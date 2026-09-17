/**
 * VHI 7.x Identity API v3 (Keystone-style) – token auth
 * Never log or store credentials; use env only.
 */

import { getContextValue } from '../gateway/context.js';
import { registerInsecureHost } from '../utils/tls.js';

const getBaseUrl = () => {
  const base = getContextValue('vhiBaseUrl', 'VHI_BASE_URL');
  if (!base) {
    throw new Error('VHI Base URL is not configured. Please provide vhiBaseUrl in context or set VHI_BASE_URL.');
  }
  // Every VHI API call flows through here — allow this host's self-signed cert
  registerInsecureHost(base);
  return base.replace(/\/$/, '');
};

export async function getToken() {
  const base = getBaseUrl();
  const port = getContextValue('vhiIdentityPort') || process.env.VHI_IDENTITY_PORT || 5000;
  const url = `${base}:${port}/v3/auth/tokens`;
  const user = getContextValue('vhiUser', 'VHI_USER');
  const password = getContextValue('vhiPassword', 'VHI_PASSWORD');
  const projectName = getContextValue('vhiProject', 'VHI_PROJECT_NAME') || 'admin';
  const domainName = getContextValue('vhiDomain', 'VHI_DOMAIN_NAME') || 'Default';
  const projectDomain = getContextValue('vhiProjectDomain') || domainName;

  if (!user || !password) {
    throw new Error('VHI_USER and VHI_PASSWORD must be set in environment');
  }

  const body = {
    auth: {
      identity: {
        methods: ['password'],
        password: {
          user: {
            name: user,
            domain: { name: domainName },
            password,
          },
        },
      },
      scope: {
        project: {
          name: projectName,
          domain: { name: projectDomain },
        },
      },
    },
  };

  console.log('Fetching', url, 'for user', user);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Identity auth failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const token = res.headers.get('x-subject-token');
  if (!token) throw new Error('VHI Identity did not return x-subject-token');

  let expiresAt = null;
  let projectId = null;
  try {
    const data = await res.json();
    expiresAt = data.token?.expires_at || null;
    projectId = data.token?.project?.id || null;
  } catch (_) { }

  return { token, expiresAt, projectId };
}

export function getIdentityUrl(path = '') {
  const base = getBaseUrl();
  const port = getContextValue('vhiIdentityPort') || process.env.VHI_IDENTITY_PORT || 5000;
  return `${base}:${port}/v3${path}`;
}

async function identityFetch(path, opts = {}) {
  const { getClient } = await import('./client.js');
  const client = await getClient();
  const res = await client.fetch(getIdentityUrl(path), opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Identity ${opts.method || 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) return null;
  return res.json();
}

function withQuery(path, params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export async function listDomains() {
  const data = await identityFetch('/domains');
  return data.domains || [];
}

export async function getDomain(id) {
  const data = await identityFetch(`/domains/${encodeURIComponent(id)}`);
  return data.domain || null;
}

export async function updateDomain(id, options = {}) {
  const data = await identityFetch(`/domains/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain: options }),
  });
  return data?.domain || null;
}

export async function listProjects(options = {}) {
  const data = await identityFetch(withQuery('/projects', { domain_id: options.domain_id }));
  return data.projects || [];
}

export async function listUsers(options = {}) {
  const data = await identityFetch(withQuery('/users', { domain_id: options.domain_id }));
  return data.users || [];
}

export async function listGroups(options = {}) {
  const data = await identityFetch(withQuery('/groups', { domain_id: options.domain_id }));
  return data.groups || [];
}

export async function createDomain(options = {}) {
  const data = await identityFetch('/domains', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      domain: {
        name: options.name,
        description: options.description || '',
        enabled: options.enabled !== false,
      },
    }),
  });
  return data?.domain || null;
}

export async function createUser(options = {}) {
  const user = {
    name: options.name,
    domain_id: options.domain_id,
    enabled: options.enabled !== false,
  };
  if (options.password) user.password = options.password;
  if (options.email) user.email = options.email;
  if (options.description) user.description = options.description;
  const data = await identityFetch('/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user }),
  });
  return data?.user || null;
}

export async function createGroup(options = {}) {
  const data = await identityFetch('/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      group: {
        name: options.name,
        domain_id: options.domain_id,
        description: options.description || '',
      },
    }),
  });
  return data?.group || null;
}

export async function listRoleAssignments(options = {}) {
  const data = await identityFetch(withQuery('/role_assignments', {
    'scope.domain.id': options.domain_id,
    'scope.project.id': options.project_id,
    include_names: true,
  }));
  return data.role_assignments || [];
}

export async function listRoles() {
  const data = await identityFetch('/roles');
  return data.roles || [];
}

export async function assignRole(options = {}) {
  const userId = encodeURIComponent(options.user_id);
  const roleId = encodeURIComponent(options.role_id);
  const path = options.project_id
    ? `/projects/${encodeURIComponent(options.project_id)}/users/${userId}/roles/${roleId}`
    : `/domains/${encodeURIComponent(options.domain_id)}/users/${userId}/roles/${roleId}`;
  await identityFetch(path, { method: 'PUT' });
}

export async function updateProject(id, options = {}) {
  const patch = {};
  if (options.name !== undefined) patch.name = options.name;
  if (options.description !== undefined) patch.description = options.description;
  if (options.enabled !== undefined) patch.enabled = !!options.enabled;
  const data = await identityFetch(`/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: patch }),
  });
  return data?.project || null;
}

export async function deleteProject(id) {
  await identityFetch(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
