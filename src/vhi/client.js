/**
 * VHI 7.x API client – token cache and authenticated fetch
 */

import { getToken } from './identity.js';

let cached = null;
const REFRESH_BEFORE_SEC = 60;

function isExpiringSoon(expiresAt) {
  if (!expiresAt) return true;
  const t = new Date(expiresAt).getTime() - REFRESH_BEFORE_SEC * 1000;
  return Date.now() >= t;
}

export async function getClient() {
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
  return {
    token,
    async fetch(url, opts = {}) {
      const headers = { ...opts.headers, 'X-Auth-Token': token };
      return fetch(url, { ...opts, headers });
    },
  };
}

export function clearTokenCache() {
  cached = null;
}
