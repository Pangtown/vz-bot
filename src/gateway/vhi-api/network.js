import { runWithContext } from '../context.js';
import {
  listNetworks, listSubnets, listPorts, getPort, updatePort, listSecurityGroups,
  createNetwork, deleteNetwork, createSubnet, deleteSubnet,
  createSecurityGroup, deleteSecurityGroup, createSecurityGroupRule, deleteSecurityGroupRule,
  listFloatingIPs, createFloatingIP, updateFloatingIP, deleteFloatingIP,
  listRouters, createRouter, deleteRouter, addRouterInterface, removeRouterInterface,
} from '../../vhi/network.js';
import { json, readBody } from './helpers.js';
import { logger } from '../../utils/index.js';

function wrap(name, fn) {
  return async (req, res, ctx, ...rest) => {
    try {
      return await fn(req, res, ctx, ...rest);
    } catch (err) {
      logger.error(`${name} error: ${err.message}`, { error: err.message });
      return json(res, 502, { error: err.message });
    }
  };
}

export const handleNetworks = wrap('handleNetworks', async (req, res, ctx) => {
  const m = req.method || 'GET';
  if (m === 'POST') {
    const body = await readBody(req);
    const network = await runWithContext(ctx, () => createNetwork(body));
    if (body.cidr) {
      const subnet = await runWithContext(ctx, () => createSubnet({
        network_id: network.id,
        cidr: body.cidr,
        ip_version: body.ip_version || 4,
        name: body.subnet_name || `${body.name || 'net'}-subnet`,
        gateway_ip: body.gateway_ip || undefined,
        enable_dhcp: body.enable_dhcp !== false,
      }));
      return json(res, 200, { network, subnet });
    }
    return json(res, 200, { network });
  }
  const url = new URL(req.url || '', `http://${req.headers?.host || 'localhost'}`);
  const showAll = url.searchParams.get('all') === 'true';
  const [rawNetworks, subnets] = await runWithContext(ctx, () =>
    Promise.all([listNetworks(), listSubnets()])
  );
  const networks = showAll
    ? rawNetworks
    : rawNetworks.filter(n => !(n.name || '').toLowerCase().startsWith('ha network'));
  return json(res, 200, { networks, subnets });
});

export const handleNetworkDelete = wrap('handleNetworkDelete', async (req, res, ctx, id) => {
  await runWithContext(ctx, () => deleteNetwork(id));
  return json(res, 200, { ok: true });
});

export const handleSubnetCreate = wrap('handleSubnetCreate', async (req, res, ctx) => {
  const body = await readBody(req);
  const subnet = await runWithContext(ctx, () => createSubnet(body));
  return json(res, 200, { subnet });
});

export const handleSubnetDelete = wrap('handleSubnetDelete', async (req, res, ctx, id) => {
  await runWithContext(ctx, () => deleteSubnet(id));
  return json(res, 200, { ok: true });
});

export const handleSecurityGroups = wrap('handleSecurityGroups', async (req, res, ctx) => {
  if ((req.method || 'GET') === 'POST') {
    const body = await readBody(req);
    const security_group = await runWithContext(ctx, () => createSecurityGroup(body));
    return json(res, 200, { security_group });
  }
  const data = await runWithContext(ctx, () => listSecurityGroups());
  return json(res, 200, { security_groups: data });
});

export const handleSecurityGroupDelete = wrap('handleSecurityGroupDelete', async (req, res, ctx, id) => {
  await runWithContext(ctx, () => deleteSecurityGroup(id));
  return json(res, 200, { ok: true });
});

export const handleSecurityGroupRule = wrap('handleSecurityGroupRule', async (req, res, ctx, sgId) => {
  const body = await readBody(req);
  const rule = await runWithContext(ctx, () => createSecurityGroupRule({
    ...body,
    security_group_id: sgId,
  }));
  return json(res, 200, { security_group_rule: rule });
});

export const handleSecurityGroupRuleDelete = wrap('handleSecurityGroupRuleDelete', async (req, res, ctx, id) => {
  await runWithContext(ctx, () => deleteSecurityGroupRule(id));
  return json(res, 200, { ok: true });
});

export const handleFloatingIPs = wrap('handleFloatingIPs', async (req, res, ctx, id) => {
  const m = req.method || 'GET';
  if (m === 'GET') {
    const floatingips = await runWithContext(ctx, () => listFloatingIPs());
    return json(res, 200, { floatingips });
  }
  if (m === 'POST') {
    const body = await readBody(req);
    const floatingip = await runWithContext(ctx, () => createFloatingIP(body));
    return json(res, 200, { floatingip });
  }
  if (m === 'PATCH' && id) {
    const body = await readBody(req);
    const floatingip = await runWithContext(ctx, () => updateFloatingIP(id, body));
    return json(res, 200, { floatingip });
  }
  if (m === 'DELETE' && id) {
    await runWithContext(ctx, () => deleteFloatingIP(id));
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'Method not allowed' });
});

export const handleRouters = wrap('handleRouters', async (req, res, ctx, id) => {
  const m = req.method || 'GET';
  if (m === 'GET') {
    const routers = await runWithContext(ctx, () => listRouters());
    return json(res, 200, { routers });
  }
  if (m === 'POST') {
    const body = await readBody(req);
    const router = await runWithContext(ctx, () => createRouter(body));
    return json(res, 200, { router });
  }
  if (m === 'DELETE' && id) {
    await runWithContext(ctx, () => deleteRouter(id));
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'Method not allowed' });
});

export const handleRouterInterface = wrap('handleRouterInterface', async (req, res, ctx, id, op) => {
  const body = await readBody(req);
  if (op === 'add') {
    const result = await runWithContext(ctx, () => addRouterInterface(id, body));
    return json(res, 200, { interface: result });
  }
  const result = await runWithContext(ctx, () => removeRouterInterface(id, body));
  return json(res, 200, { interface: result });
});

export const handlePorts = wrap('handlePorts', async (req, res, ctx) => {
  const ports = await runWithContext(ctx, () => listPorts());
  return json(res, 200, { ports });
});

export const handlePortGet = wrap('handlePortGet', async (req, res, ctx, id) => {
  const data = await runWithContext(ctx, () => getPort(id));
  return json(res, 200, { port: data });
});

export const handlePortUpdate = wrap('handlePortUpdate', async (req, res, ctx, id) => {
  const body = await readBody(req);
  const port = await runWithContext(ctx, () => updatePort(id, body));
  return json(res, 200, { port });
});
