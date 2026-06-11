import { normalizeUrl } from '../../monitoring/ssh-storage.js';

export function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function readBody(req) {
  let buf = '';
  for await (const chunk of req) buf += chunk;
  return buf ? JSON.parse(buf) : {};
}

export function extractContext(req) {
  const rawBase = req.headers['x-vhi-base-url'] || process.env.VHI_BASE_URL || '';
  return {
    vhiBaseUrl:     normalizeUrl(rawBase),
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
