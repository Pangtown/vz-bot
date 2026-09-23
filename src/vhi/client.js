/**
 * VHI 7.x API client – token cache and authenticated fetch
 */

import { getToken } from './identity.js';
import { getContextValue } from '../gateway/context.js';

const cache = new Map();
const inFlightTokens = new Map();
const REFRESH_BEFORE_SEC = 60;

function getCacheKey() {
  const base = getContextValue('vhiBaseUrl', 'VHI_BASE_URL') || 'default';
  const user = getContextValue('vhiUser', 'VHI_USER') || 'default';
  const project = getContextValue('vhiProject', 'VHI_PROJECT_NAME') || 'default';
  const projectId = getContextValue('vhiProjectId', 'VHI_PROJECT_ID') || '';
  return `${base}:${user}:${projectId || project}`;
}

function isExpiringSoon(expiresAt) {
  if (!expiresAt) return true;
  const t = new Date(expiresAt).getTime() - REFRESH_BEFORE_SEC * 1000;
  return Date.now() >= t;
}

function fetchToken(key) {
  let tokenPromise = inFlightTokens.get(key);
  if (!tokenPromise) {
    tokenPromise = getToken()
      .then((res) => {
        cache.set(key, res);
        return res;
      })
      .finally(() => {
        inFlightTokens.delete(key);
      });
    inFlightTokens.set(key, tokenPromise);
  }
  return tokenPromise;
}

function canReplayBody(body) {
  return body === undefined || body === null || typeof body === 'string'
    || body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

export async function getClient() {
  const key = getCacheKey();
  const cached = cache.get(key);
  let current = cached && !isExpiringSoon(cached.expiresAt) ? cached : await fetchToken(key);

  return {
    get token() { return current.token; },
    get projectId() { return current.projectId; },
    async fetch(url, opts = {}) {
      const send = (token) => fetch(url, { ...opts, headers: { ...opts.headers, 'X-Auth-Token': token } });
      const res = await send(current.token);
      if (res.status !== 401 || !canReplayBody(opts.body)) return res;
      if (cache.get(key)?.token === current.token) cache.delete(key);
      current = await fetchToken(key);
      await res.body?.cancel().catch(() => {});
      return send(current.token);
    },
  };
}

export function clearTokenCache() {
  cache.clear();
  inFlightTokens.clear();
}
