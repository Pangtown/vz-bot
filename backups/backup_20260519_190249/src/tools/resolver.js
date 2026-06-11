/**
 * Helper to resolve resource names to IDs
 */
import { listImages } from '../vhi/image.js';
import { listFlavors, listServers } from '../vhi/compute.js';
import { listNetworks, listSubnets } from '../vhi/network.js';
import { listVolumeTypes, listVolumes } from '../vhi/block.js';

export async function resolveId(type, nameOrId) {
  if (!nameOrId) return null;
  
  // If it looks like a UUID, assume it's an ID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(nameOrId)) return nameOrId;

  console.log(`[RESOLVER] Resolving ${type} by name: "${nameOrId}"`);

  let list = [];
  switch (type) {
    case 'image':
      list = await listImages();
      break;
    case 'flavor':
      list = await listFlavors();
      break;
    case 'network':
      list = await listNetworks();
      break;
    case 'policy':
    case 'volume_type':
      list = await listVolumeTypes();
      break;
    case 'volume':
      list = await listVolumes();
      break;
    case 'subnet':
      list = await listSubnets();
      break;
    case 'vm':
    case 'server':
      list = await listServers();
      break;
    default:
      throw new Error(`Unsupported resource type for resolution: ${type}`);
  }

  // Case-insensitive name matching
  const needle = nameOrId.toLowerCase();
  const found = list.find(item => 
    (item.name && item.name.toLowerCase() === needle) || 
    (item.label && item.label.toLowerCase() === needle) ||
    item.id === nameOrId
  );

  if (!found) {
    // Try partial match as fallback
    const partial = list.find(item =>
      (item.name && item.name.toLowerCase().includes(needle)) ||
      (item.label && item.label.toLowerCase().includes(needle))
    );
    if (partial) {
      console.log(`[RESOLVER] Partial match: "${nameOrId}" → "${partial.name}" (${partial.id})`);
      return partial.id;
    }
    console.warn(`[RESOLVER] Could not find ${type} by name: "${nameOrId}"`);
    return nameOrId; // Fallback to original value
  }

  console.log(`[RESOLVER] Resolved "${nameOrId}" → "${found.name}" (${found.id})`);
  return found.id;
}
