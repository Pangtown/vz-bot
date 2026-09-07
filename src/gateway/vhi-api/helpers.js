import { normalizeUrl } from '../../monitoring/ssh-storage.js';
import { registerInsecureHost } from '../../utils/tls.js';

export function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function readBody(req) {
  let buf = '';
  for await (const chunk of req) buf += chunk;
  return buf ? JSON.parse(buf) : {};
}

export function verifyWebPassword(req) {
  const expected = process.env.WEB_PASSWORD;
  if (!expected) return true;
  const provided = req.headers['x-web-password'] 
    || (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);
  return !!provided && provided === expected;
}

export function extractContext(req) {
  const isWebAuthed = verifyWebPassword(req);
  const rawBase = req.headers['x-vhi-base-url'] || (isWebAuthed ? process.env.VHI_BASE_URL : '') || '';
  const vhiBaseUrl = normalizeUrl(rawBase);
  if (vhiBaseUrl) {
    registerInsecureHost(vhiBaseUrl); // self-signed VHI cert allowed for this host only
  }
  return {
    vhiBaseUrl,
    vhiUser:        req.headers['x-vhi-user']          || (isWebAuthed ? process.env.VHI_USER : '')            || '',
    vhiPassword:    req.headers['x-vhi-password']      || (isWebAuthed ? process.env.VHI_PASSWORD : '')         || '',
    vhiProject:     req.headers['x-vhi-project']       || (isWebAuthed ? process.env.VHI_PROJECT_NAME : '')     || 'admin',
    vhiDomain:      req.headers['x-vhi-domain']        || (isWebAuthed ? process.env.VHI_DOMAIN_NAME : '')      || 'Default',
    vhiProjectDomain: req.headers['x-vhi-project-domain'] || req.headers['x-vhi-domain'] || (isWebAuthed ? process.env.VHI_DOMAIN_NAME : '') || 'Default',
    vhiProjectId:   req.headers['x-vhi-project-id']   || (isWebAuthed ? process.env.VHI_PROJECT_ID : '')       || '',
    vhiSshHost:     req.headers['x-vhi-ssh-host']     || (isWebAuthed ? process.env.VHI_SSH_HOST : '')         || '',
    vhiSshUser:     req.headers['x-vhi-ssh-user']     || (isWebAuthed ? process.env.VHI_SSH_USER : '')         || 'root',
    vhiSshPassword: req.headers['x-vhi-ssh-password'] || (isWebAuthed ? process.env.VHI_SSH_PASSWORD : '')     || '',
  };
}
