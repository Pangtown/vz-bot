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
  const port = process.env.VHI_IDENTITY_PORT || 5000;
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
  const port = process.env.VHI_IDENTITY_PORT || 5000;
  return `${base}:${port}/v3${path}`;
}

export async function listProjects() {
  const { getClient } = await import('./client.js');
  const client = await getClient();
  const res = await client.fetch(getIdentityUrl('/projects'));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Identity listProjects failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.projects || [];
}

export async function listUsers() {
  const { getClient } = await import('./client.js');
  const client = await getClient();
  const res = await client.fetch(getIdentityUrl('/users'));
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VHI Identity listUsers failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.users || [];
}
