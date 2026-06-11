/**
 * Scoped TLS bypass for self-signed VHI endpoints.
 *
 * Previously the app set NODE_TLS_REJECT_UNAUTHORIZED=0 globally, which
 * disabled certificate verification for ALL outbound HTTPS traffic,
 * including LLM API calls. This module instead disables verification only
 * for registered VHI hosts; every other host gets full verification.
 *
 * Set VHI_VERIFY_TLS=1 to disable the bypass entirely (e.g. when VHI has a
 * trusted certificate, or you provide one via NODE_EXTRA_CA_CERTS).
 */

import { fetch as undiciFetch, Agent } from 'undici';

const insecureHosts = new Set();
let insecureDispatcher = null;
let installed = false;

/** Register a host (by base URL) whose self-signed cert should be accepted. */
export function registerInsecureHost(baseUrl) {
  if (!baseUrl) return;
  try {
    insecureHosts.add(new URL(baseUrl).hostname);
  } catch (_) {
    /* ignore malformed URLs */
  }
}

/**
 * Wrap global fetch so requests to registered VHI hosts skip certificate
 * verification, while all other requests verify normally.
 */
export function installVhiTlsBypass() {
  if (installed || process.env.VHI_VERIFY_TLS === '1') return;
  installed = true;

  registerInsecureHost(process.env.VHI_BASE_URL);
  registerInsecureHost(process.env.PROMETHEUS_URL);

  insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    try {
      const u = typeof input === 'string' || input instanceof URL
        ? new URL(input)
        : new URL(input.url);
      if (u.protocol === 'https:' && insecureHosts.has(u.hostname)) {
        return undiciFetch(input, { ...init, dispatcher: insecureDispatcher });
      }
    } catch (_) {
      /* fall through to native fetch */
    }
    return nativeFetch(input, init);
  };
}
