import { timingSafeEqual } from 'crypto';
import { normalizeUrl } from '../../monitoring/ssh-storage.js';
import { registerInsecureHost } from '../../utils/tls.js';
import { tokenFromRequest, touchConsoleSession } from '../console-session.js';
import { clusterContext, clusterId } from '../cluster-store.js';

export function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function readBody(req) {
  let buf = '';
  for await (const chunk of req) buf += chunk;
  return buf ? JSON.parse(buf) : {};
}

export function safeEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyWebPassword(req) {
  const expected = process.env.WEB_PASSWORD;
  if (!expected) return false;
  const provided = req.headers['x-web-password'] 
    || (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7).trim() : null);
  return safeEqual(provided, expected);
}

export function extractContext(req) {
  const sess = touchConsoleSession(tokenFromRequest(req));
  const h = req.headers || {};
  const savedId = h['x-vhi-cluster-id'];
  if (savedId && (sess || verifyWebPassword(req))) {
    const saved = clusterContext(savedId);
    if (saved) {
      registerInsecureHost(saved.vhiBaseUrl);
      return { ...saved, vhiSshHost: '', vhiSshUser: 'root', vhiSshPassword: '' };
    }
  }
  if (sess) {
    const vhiBaseUrl = normalizeUrl(h['x-vhi-base-url'] || sess.baseUrl);
    if (vhiBaseUrl) registerInsecureHost(vhiBaseUrl);
    const sameCluster = vhiBaseUrl === normalizeUrl(sess.baseUrl);
    const project = h['x-vhi-project'] || sess.project || 'admin';
    const otherPassword = sameCluster ? '' : (h['x-vhi-password']
      || clusterContext(clusterId(vhiBaseUrl, project))?.vhiPassword || '');
    return {
      vhiBaseUrl,
      vhiUser: h['x-vhi-user'] || sess.username,
      vhiPassword: sameCluster ? sess.password : otherPassword,
      vhiProject: project,
      vhiDomain: h['x-vhi-domain'] || sess.userDomain || 'Default',
      vhiProjectDomain: h['x-vhi-project-domain'] || sess.projectDomain || sess.userDomain || 'Default',
      vhiProjectId: h['x-vhi-project-id'] || sess.projectId || '',
      vhiSshHost: h['x-vhi-ssh-host'] || '',
      vhiSshUser: h['x-vhi-ssh-user'] || 'root',
      vhiSshPassword: h['x-vhi-ssh-password'] || '',
    };
  }
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
