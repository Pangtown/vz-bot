import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const CONFIG_FILE = './data/ssh_config.json';

function normalizeUrl(url) {
  if (!url) return '';
  let normalized = url.trim();
  if (!normalized.startsWith('http')) {
    normalized = `https://${normalized}`;
  }
  return normalized.replace(/\/$/, '');
}

async function run() {
  try {
    const data = await readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(data);
    const normalized = {};

    for (const [key, val] of Object.entries(parsed)) {
      const newKey = normalizeUrl(key);
      normalized[newKey] = val;
    }

    await writeFile(CONFIG_FILE, JSON.stringify(normalized, null, 2), 'utf8');
    console.log('SSH config normalized successfully.');
  } catch (e) {
    console.error('Failed to normalize SSH config:', e.message);
  }
}

run();
