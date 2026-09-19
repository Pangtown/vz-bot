import { json, readBody } from './helpers.js';
import { logger } from '../../utils/index.js';
import { listPlans, getPlan, deletePlan, sanitizePlan } from '../../vhi/dr-store.js';
import { createPlan, protectServers, unprotectServer, syncPlan, stagePlan, failoverPlan, probeDrContext, teardownAndDeletePlan } from '../../vhi/dr-engine.js';

export async function handleDr(req, res, ctx, rest) {
  const m = req.method || 'GET';
  const parts = String(rest || '').split('/').filter(Boolean);

  try {
    if (m === 'POST' && parts[0] === 'probe') {
      const body = await readBody(req);
      const result = await probeDrContext(body);
      return json(res, 200, result);
    }

    if (m === 'GET' && parts.length === 0) {
      const plans = await listPlans();
      return json(res, 200, { plans: plans.map(sanitizePlan) });
    }

    if (m === 'POST' && parts.length === 0) {
      const body = await readBody(req);
      const plan = await createPlan(body, ctx);
      return json(res, 200, { plan });
    }

    const planId = parts[0];
    if (!planId) return json(res, 404, { error: 'Not found' });

    if (m === 'GET' && parts.length === 1) {
      const plan = await getPlan(planId);
      if (!plan) return json(res, 404, { error: 'DR plan not found' });
      return json(res, 200, { plan: sanitizePlan(plan) });
    }

    if (m === 'DELETE' && parts.length === 1) {
      const ok = await deletePlan(planId);
      if (!ok) return json(res, 404, { error: 'DR plan not found' });
      return json(res, 200, { ok: true });
    }

    if (m === 'POST' && parts[1] === 'protect') {
      const body = await readBody(req);
      const plan = await protectServers(planId, body.serverIds || [body.serverId].filter(Boolean));
      return json(res, 200, { plan });
    }

    if (m === 'POST' && parts[1] === 'unprotect') {
      const body = await readBody(req);
      const plan = await unprotectServer(planId, body.serverId);
      return json(res, 200, { plan });
    }

    if (m === 'POST' && parts[1] === 'sync') {
      void syncPlan(planId).catch((err) => logger.error(`[DR] sync ${planId}: ${err.message}`));
      const plan = sanitizePlan(await getPlan(planId));
      return json(res, 202, { plan, started: true });
    }

    if (m === 'POST' && parts[1] === 'stage') {
      const body = await readBody(req);
      void stagePlan(planId, { recreate: !!body?.recreate }).catch((err) => logger.error(`[DR] stage ${planId}: ${err.message}`));
      const plan = sanitizePlan(await getPlan(planId));
      return json(res, 202, { plan, started: true });
    }

    if (m === 'POST' && parts[1] === 'failover') {
      void failoverPlan(planId).catch((err) => logger.error(`[DR] failover ${planId}: ${err.message}`));
      const plan = sanitizePlan(await getPlan(planId));
      return json(res, 202, { plan, started: true });
    }

    if (m === 'POST' && parts[1] === 'delete') {
      const body = await readBody(req);
      if (body?.cleanup) {
        void teardownAndDeletePlan(planId).catch((err) => logger.error(`[DR] cleanup ${planId}: ${err.message}`));
        const plan = sanitizePlan(await getPlan(planId));
        return json(res, 202, { plan, started: true, cleanup: true });
      }
      const ok = await deletePlan(planId);
      if (!ok) return json(res, 404, { error: 'DR plan not found' });
      return json(res, 200, { ok: true, deleted: true, cleanup: false });
    }

    return json(res, 404, { error: 'Unknown DR route' });
  } catch (err) {
    logger.error(`[DR] ${m} /${parts.join('/')}: ${err.message}`);
    return json(res, 502, { error: err.message });
  }
}
