/**
 * VHI 7.x Image API (Glance-style) – images list, get
 */

import { createReadStream, createWriteStream } from 'fs';
import { stat } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Agent } from 'undici';
import { getClient } from './client.js';
import { getContextValue } from '../gateway/context.js';

const longBodyAgent = new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connectTimeout: 120000,
});


const getBaseUrl = () => {
    const base = getContextValue('vhiBaseUrl', 'VHI_BASE_URL');
    if (!base) {
        throw new Error('VHI Base URL is not configured. Please provide vhiBaseUrl in context or set VHI_BASE_URL.');
    }
    return base.replace(/\/$/, '');
};

function imageUrl(path = '') {
    const base = getBaseUrl();
    const port = process.env.VHI_IMAGE_PORT || 9292;
    return `${base}:${port}/v2/images${path}`;
}

export async function listImages(options = {}) {
    const { limit, name, status } = options;
    const client = await getClient();
    let path = '';
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (name) params.set('name', name);
    if (status) params.set('status', status);
    const qs = params.toString();
    if (qs) path += `?${qs}`;

    const res = await client.fetch(imageUrl(path));
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`VHI Image listImages failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    return data.images || [];
}

export async function getImage(imageId) {
    const client = await getClient();
    const res = await client.fetch(imageUrl(`/${imageId}`));
    if (!res.ok) {
        if (res.status === 404) return null;
        const text = await res.text();
        throw new Error(`VHI Image getImage failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    return data || null;
}

/**
 * Create an image record (metadata only — no data yet). Returns the queued image.
 * visibility=public requires the Glance `publicize_image` policy (admin); a
 * non-admin request for public visibility is rejected by VHI with 403.
 */
export async function createImage(options = {}) {
    const client = await getClient();
    const body = {
        name: options.name,
        disk_format: options.disk_format || 'qcow2',
        container_format: options.container_format || 'bare',
        visibility: options.visibility === 'public' ? 'public' : 'private',
    };
    if (options.os_distro) body.os_distro = options.os_distro;
    if (options.min_disk) body.min_disk = Number(options.min_disk);
    if (options.hw_firmware_type) body.hw_firmware_type = options.hw_firmware_type;
    if (options.hw_disk_bus) body.hw_disk_bus = options.hw_disk_bus;
    if (options.hw_machine_type) body.hw_machine_type = options.hw_machine_type;
    if (options.vmware_disktype) body.vmware_disktype = options.vmware_disktype;
    if (options.vmware_adaptertype) body.vmware_adaptertype = options.vmware_adaptertype;

    const res = await client.fetch(imageUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`VHI Image createImage failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
}

/**
 * Stream binary image data into a queued image via PUT .../file.
 * `bodyStream` is a Node Readable (the incoming request) streamed straight
 * through to Glance so multi-GB uploads never buffer in memory.
 */
export async function uploadImageData(imageId, bodyStream, contentLength) {
    const client = await getClient();
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (contentLength) headers['Content-Length'] = String(contentLength);

    const res = await client.fetch(imageUrl(`/${imageId}/file`), {
        method: 'PUT',
        headers,
        body: bodyStream,
        duplex: 'half',
        dispatcher: longBodyAgent,
    });
    if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => '');
        throw new Error(`VHI Image upload failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return { ok: true };
}

/**
 * Change image visibility via JSON-patch. value must be 'public' or 'private'.
 * Setting 'public' requires admin; VHI returns 403 otherwise.
 */
export async function updateImageVisibility(imageId, visibility) {
    const client = await getClient();
    const patch = [{ op: 'replace', path: '/visibility', value: visibility === 'public' ? 'public' : 'private' }];
    const res = await client.fetch(imageUrl(`/${imageId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/openstack-images-v2.1-json-patch' },
        body: JSON.stringify(patch),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`VHI Image visibility change failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
}

export async function deleteImage(imageId) {
    const client = await getClient();
    const res = await client.fetch(imageUrl(`/${imageId}`), { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => '');
        throw new Error(`VHI Image deleteImage failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return { ok: true };
}

export async function importImageFromUrl(imageId, uri) {
    const client = await getClient();
    const res = await client.fetch(imageUrl(`/${imageId}/import`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            method: { name: 'web-download', uri },
        }),
        dispatcher: longBodyAgent,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`VHI Image web-download import failed (${res.status}): ${text.slice(0, 400)}`);
    }
    return { ok: true };
}

export async function downloadImageToFile(imageId, destPath) {
    const client = await getClient();
    const res = await client.fetch(imageUrl(`/${imageId}/file`), { dispatcher: longBodyAgent });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Glance download failed (${res.status}): ${text.slice(0, 300)}`);
    }
    await pipeline(res.body, createWriteStream(destPath));
    return destPath;
}

export async function uploadImageFromFile(imageId, filePath) {
    const info = await stat(filePath);
    return uploadImageData(imageId, createReadStream(filePath), info.size);
}

export async function waitImage(imageId, statuses, timeoutMs = 2 * 60 * 60 * 1000) {
    const want = new Set((statuses || ['active']).map((s) => String(s).toLowerCase()));
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const img = await getImage(imageId);
        if (!img) throw new Error(`Glance image ${imageId} disappeared`);
        const st = String(img.status || '').toLowerCase();
        if (want.has(st)) return img;
        if (st === 'killed' || st === 'deleted' || st === 'error') {
            throw new Error(`Glance image ${imageId} ended in ${img.status}`);
        }
        await new Promise((r) => setTimeout(r, 8000));
    }
    throw new Error(`Glance image ${imageId} did not reach ${[...want].join('/')} within ${timeoutMs}ms`);
}
