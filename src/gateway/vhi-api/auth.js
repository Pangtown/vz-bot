import { validateRequiredString, validateUrl } from '../../utils/validation.js';
import { logger } from '../../utils/index.js';
import { registerInsecureHost } from '../../utils/tls.js';
import { json, readBody } from './helpers.js';

export async function handleAuth(req, res) {
  const body = await readBody(req);
  
  // Validate required fields
  const baseUrlError = validateRequiredString(body.baseUrl, 'baseUrl');
  const usernameError = validateRequiredString(body.username, 'username');
  const passwordError = validateRequiredString(body.password, 'password');
  
  if (baseUrlError || usernameError || passwordError) {
    return json(res, 400, { error: [baseUrlError, usernameError, passwordError].filter(Boolean).join(', ') });
  }

  // Auto-prepend https:// if they only entered an IP address
  if (body.baseUrl && !body.baseUrl.startsWith('http://') && !body.baseUrl.startsWith('https://')) {
    body.baseUrl = `https://${body.baseUrl}`;
  }
  
  // Validate URL format
  const urlError = validateUrl(body.baseUrl, 'baseUrl');
  if (urlError) {
    return json(res, 400, { error: urlError });
  }
  
  let hostStr = body.baseUrl.replace(/https?:\/\//, '');
  let baseUrl = hostStr;
  if (hostStr.includes(']')) {
    baseUrl = hostStr.split(']')[0] + ']';
  } else if (hostStr.includes(':')) {
    baseUrl = hostStr.split(':')[0];
  } else {
    baseUrl = hostStr.split('/')[0];
  }

  const username = body.username;
  const password = body.password;
  const project  = body.project || 'admin';
  const userDomain    = body.userDomain || 'Default';
  const projectDomain = body.projectDomain || 'Default';

  const fullBase = `https://${baseUrl}`;
  const tokenUrl = `${fullBase}:5000/v3/auth/tokens`;
  registerInsecureHost(fullBase); // self-signed VHI cert allowed for this cluster only

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
    logger.debug(`Attempting authentication for user ${username} at ${baseUrl}`);
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authPayload),
    });

    if (!r.ok) {
      const text = await r.text();
      logger.warn(`Authentication failed for user ${username}: ${r.status}`, { status: r.status });
      return json(res, 401, { error: `Auth failed (${r.status}): ${text.slice(0, 200)}` });
    }

    const token = r.headers.get('x-subject-token');
    let tokenData = null;
    try { tokenData = await r.json(); } catch (_) {}

    const projectId = tokenData?.token?.project?.id || '';

    logger.info(`Authentication successful for user ${username}`, { projectId });
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
    logger.error(`Authentication failed: ${err.message}`, { error: err.message, tokenUrl });
    return json(res, 502, { error: `Cannot reach ${tokenUrl}: ${err.message}` });
  }
}
