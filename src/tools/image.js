/**
 * Image tools – list, get
 */

import { listImages as fetchImages, getImage as fetchImage } from '../vhi/image.js';

export async function listImages(args = {}) {
    const images = await fetchImages({
        limit: args.limit || 50,
        name: args.name,
        status: args.status,
    });
    return {
        count: images.length,
        images: images.map(i => ({
            id: i.id,
            name: i.name,
            status: i.status,
            size: i.size,
            created_at: i.created_at,
        })),
    };
}

export async function getImage(args) {
    if (!args.image_id) throw new Error('image_id required');
    const image = await fetchImage(args.image_id);
    if (!image) return { found: false, image_id: args.image_id };
    return {
        found: true,
        image: {
            id: image.id,
            name: image.name,
            status: image.status,
            size: image.size,
            created_at: image.created_at
        }
    };
}
