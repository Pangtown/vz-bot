/**
 * VHI 7.x Identity API v3 (Keystone-style) – token auth
 * Never log or store credentials; use env only.
 */

const getBaseUrl = () => {
  const base = process.env.VHI_BASE_URL || 'https://172.16.218.7';
  return base.replace(/\/$/, '');
};

export async function getToken() {
  const base = getBaseUrl();
  const port = process.env.VHI_IDENTITY_PORT || 5000;
  const url = `${base}:${port}/v3/auth/tokens`;
  const user = process.env.VHI_USER || '';
  const password = process.env.VHI_PASSWORD || '';
  const projectName = process.env.VHI_PROJECT_NAME || 'admin';
  const domainName = process.env.VHI_DOMAIN_NAME || 'Default';

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
          domain: { name: domainName },
        },
      },
    },
  };

  console.log('Fetching', url, 'for user', user, 'and project', projectName);
  console.dir(body, { depth: null });
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
  try {
    const data = await res.json();
    expiresAt = data.token?.expires_at || null;
  } catch (_) { }

  return { token, expiresAt };
}

export function getIdentityUrl(path = '') {
  const base = getBaseUrl();
  const port = process.env.VHI_IDENTITY_PORT || 5000;
  return `${base}:${port}/v3${path}`;
}
