import { runWithContext } from '../context.js';
import { listNetworks, listSubnets, listPorts, getPort, updatePort, listSecurityGroups } from '../../vhi/network.js';
import { json, readBody } from './helpers.js';
import { logger } from '../../utils/index.js';

export async function handleNetworks(req, res, ctx) {
  try {
    const [networks, subnets] = await runWithContext(ctx, () =>
      Promise.all([listNetworks(), listSubnets()])
    );
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
