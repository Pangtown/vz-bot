/**
 * VHI 7.x API client – token cache and authenticated fetch
 */

import { getToken } from './identity.js';
import { getContextValue } from '../gateway/context.js';

const cache = new Map();
const REFRESH_BEFORE_SEC = 60;

function getCacheKey() {
  const base = getContextValue('vhiBaseUrl', 'VHI_BASE_URL') || 'default';
  const user = getContextValue('vhiUser', 'VHI_USER') || 'default';
  const project = getContextValue('vhiProject', 'VHI_PROJECT_NAME') || 'default';
  return `${base}:${user}:${project}`;
}

function isExpiringSoon(expiresAt) {
  if (!expiresAt) return true;
  const t = new Date(expiresAt).getTime() - REFRESH_BEFORE_SEC * 1000;
  return Date.now() >= t;
}

export async function getClient() {
  const key = getCacheKey();
  let cached = cache.get(key);

  if (cached && !isExpiringSoon(cached.expiresAt)) {
    return {
      token: cached.token,
      async fetch(url, opts = {}) {
        const headers = { ...opts.headers, 'X-Auth-Token': cached.token };
        return fetch(url, { ...opts, headers });
      },
    };
  }
  const { token, expiresAt } = await getToken();
  cached = { token, expiresAt };
  cache.set(key, cached);
  return {
    token,
    async fetch(url, opts = {}) {
      const headers = { ...opts.headers, 'X-Auth-Token': token };
      return fetch(url, { ...opts, headers });
    },
  };
}

export function clearTokenCache() {
  cache.clear();
}
