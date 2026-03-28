import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const SSH_CONFIG_FILE = join(DATA_DIR, 'ssh_config.json');

/**
 * Normalize a URL to a consistent format for use as a storage key.
 * @param {string} url 
 * @returns {string} Normalized URL (e.g., https://10.10.10.10)
 */
export function normalizeUrl(url) {
  if (!url) return '';
  let normalized = url.trim();
  if (!normalized.startsWith('http')) {
    normalized = `https://${normalized}`;
  }
  return normalized.replace(/\/$/, '');
}

/**
 * Load the SSH configuration for a specific cluster or all clusters if no host is provided.
 * @param {string} [baseUrl] The base URL of the cluster to load config for.
 * @returns {Promise<object>} The config for the specific cluster, or the entire map if no baseUrl.
 */
export async function loadGlobalSshConfig(baseUrl) {
  const targetUrl = baseUrl ? normalizeUrl(baseUrl) : null;
  try {
    const data = await readFile(SSH_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(data);
    
    // Migration: if the file contains a singleton config (has .host but is not a map, or map has wrong key format),
    // convert it to the new format.
    if (parsed && parsed.host && !targetUrl && !parsed[normalizeUrl(parsed.host)]) {
      const key = normalizeUrl(parsed.host);
      const migrated = { [key]: parsed };
      if (!targetUrl) return migrated;
      if (targetUrl === key) return parsed;
      return {};
    }

    if (targetUrl) {
      return parsed[targetUrl] || {};
    }
    return parsed || {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[SSH-STORAGE] Failed to load SSH config from ${SSH_CONFIG_FILE}:`, err.message);
    }
    return {};
  }
}

/**
 * Save the SSH configuration for a specific cluster.
 * @param {object} config { host, username, password, ... }
 * @param {string} baseUrl The base URL of the cluster.
 */
export async function saveGlobalSshConfig(config, baseUrl) {
  if (!baseUrl) {
    throw new Error('baseUrl is required to save cluster-specific SSH config');
  }
  const targetUrl = normalizeUrl(baseUrl);
  try {
    const currentMap = await loadGlobalSshConfig();
    currentMap[targetUrl] = config;

    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(SSH_CONFIG_FILE, JSON.stringify(currentMap, null, 2), 'utf8');
    console.log(`[SSH-STORAGE] SSH config for ${targetUrl} saved to ${SSH_CONFIG_FILE}`);
  } catch (err) {
    console.error(`[SSH-STORAGE] Failed to save SSH config for ${targetUrl}:`, err.message);
    throw err;
  }
}
