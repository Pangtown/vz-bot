import { runWithContext } from '../context.js';
import { listNetworks, listSubnets, listPorts, getPort, updatePort, listSecurityGroups } from '../../vhi/network.js';
import { json, readBody } from './helpers.js';
import { logger } from '../../utils/index.js';

export async function handleNetworks(req, res, ctx) {
  try {
    const url = new URL(req.url || '', `http://${req.headers?.host || 'localhost'}`);
    const showAll = url.searchParams.get('all') === 'true';
    const [rawNetworks, subnets] = await runWithContext(ctx, () =>
      Promise.all([listNetworks(), listSubnets()])
    );
    // Virtuozzo Infrastructure System (V/IS) hides internal OpenStack Neutron L3 HA VRRP networks
    const networks = showAll
      ? rawNetworks
      : rawNetworks.filter(n => {
          const name = (n.name || '').toLowerCase();
          return !name.startsWith('ha network');
        });
    return json(res, 200, { networks, subnets });
  } catch (err) {
    logger.error(`handleNetworks error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleSecurityGroups(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listSecurityGroups());
    return json(res, 200, { security_groups: data });
  } catch (err) {
    logger.error(`handleSecurityGroups error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handlePortGet(req, res, ctx, id) {
  try {
    const data = await runWithContext(ctx, () => getPort(id));
    return json(res, 200, { port: data });
  } catch (err) {
    logger.error(`handlePortGet error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}
