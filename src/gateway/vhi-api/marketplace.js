/**
 * Marketplace script repository — predefined cloud-init scripts for
 * post-provisioning VMs deployed from the marketplace page.
 *
 * Storage: data/marketplace_scripts.json (seeded with defaults on first use).
 * Routes (no cluster credentials required — repository is local to vz-bot):
 *   GET    /api/vhi/marketplace/scripts       list scripts
 *   POST   /api/vhi/marketplace/scripts       create (or update when body.id given)
 *   DELETE /api/vhi/marketplace/scripts/:id   delete
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { json, readBody } from './helpers.js';
import { logger } from '../../utils/index.js';

const STORE_PATH = join(process.cwd(), 'data', 'marketplace_scripts.json');
// Nova rejects user_data over 65535 bytes base64; keep raw content well under that
const MAX_CONTENT_BYTES = 48000;

const SEED_SCRIPTS = [
  {
    name: 'Base setup (updates + guest agent)',
    description: 'Update packages and enable the QEMU guest agent so the cluster can see the VM state.',
    content: `#cloud-config
package_update: true
package_upgrade: true
packages:
  - qemu-guest-agent
runcmd:
  - systemctl enable --now qemu-guest-agent
`,
  },
  {
    name: 'Install Docker',
    description: 'Install Docker Engine via the official convenience script and start it on boot.',
    content: `#cloud-config
package_update: true
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
`,
  },
  {
    name: 'Install NGINX web server',
    description: 'Install and start NGINX.',
    content: `#cloud-config
package_update: true
packages:
  - nginx
runcmd:
  - systemctl enable --now nginx
`,
  },
  {
    name: 'Create admin user with SSH key',
    description: 'Create a sudo-capable vzadmin user. Replace the placeholder with your real public key before deploying.',
    content: `#cloud-config
users:
  - name: vzadmin
    groups: sudo
    shell: /bin/bash
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    ssh_authorized_keys:
      - ssh-ed25519 AAAA_REPLACE_WITH_YOUR_PUBLIC_KEY user@host
`,
  },
];

let cache = null;

async function loadScripts() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(STORE_PATH, 'utf8'));
  } catch (_) {
    // First use: seed with defaults
    const now = new Date().toISOString();
    cache = SEED_SCRIPTS.map((s) => ({ id: randomUUID(), ...s, createdAt: now, updatedAt: now }));
    await saveScripts(cache);
  }
  return cache;
}

async function saveScripts(scripts) {
  cache = scripts;
  await mkdir(join(process.cwd(), 'data'), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(scripts, null, 2), 'utf8');
}

function validate(body) {
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  if (!body.content || typeof body.content !== 'string' || !body.content.trim()) return 'content is required';
  if (Buffer.byteLength(body.content, 'utf8') > MAX_CONTENT_BYTES) {
    return `content too large (max ${MAX_CONTENT_BYTES} bytes — cloud-init user_data is capped at 64 KB)`;
  }
  return null;
}

/** Router entry — returns true when the request was handled. */
export async function handleMarketplaceScripts(req, res, method, path) {
  try {
    const scripts = await loadScripts();

    if (method === 'GET' && path === '/api/vhi/marketplace/scripts') {
      return json(res, 200, { scripts });
    }

    if (method === 'POST' && path === '/api/vhi/marketplace/scripts') {
      const body = await readBody(req);
      const err = validate(body);
      if (err) return json(res, 400, { error: err });

      const now = new Date().toISOString();
      if (body.id) {
        const existing = scripts.find((s) => s.id === body.id);
        if (!existing) return json(res, 404, { error: 'Script not found' });
        existing.name = body.name.trim();
        existing.description = (body.description || '').trim();
        existing.content = body.content;
        existing.updatedAt = now;
        await saveScripts(scripts);
        logger.info(`Marketplace script updated: ${existing.name}`);
        return json(res, 200, { script: existing });
      }

      const script = {
        id: randomUUID(),
        name: body.name.trim(),
        description: (body.description || '').trim(),
        content: body.content,
        createdAt: now,
        updatedAt: now,
      };
      scripts.push(script);
      await saveScripts(scripts);
      logger.info(`Marketplace script created: ${script.name}`);
      return json(res, 200, { script });
    }

    const delMatch = path.match(/^\/api\/vhi\/marketplace\/scripts\/([a-f0-9-]+)$/);
    if (method === 'DELETE' && delMatch) {
      const idx = scripts.findIndex((s) => s.id === delMatch[1]);
      if (idx === -1) return json(res, 404, { error: 'Script not found' });
      const [removed] = scripts.splice(idx, 1);
      await saveScripts(scripts);
      logger.info(`Marketplace script deleted: ${removed.name}`);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'Unknown marketplace route' });
  } catch (err) {
    logger.error(`Marketplace scripts error: ${err.message}`, { error: err.message });
    return json(res, 500, { error: err.message });
  }
}
