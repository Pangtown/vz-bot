/**
 * VHI 7.x Image API (Glance-style) – images list, get
 */

import { getClient } from './client.js';
import { getContextValue } from '../gateway/context.js';

const getBaseUrl = () => {
    const base = getContextValue('vhiBaseUrl', 'VHI_BASE_URL') || 'https://172.16.218.7';
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
