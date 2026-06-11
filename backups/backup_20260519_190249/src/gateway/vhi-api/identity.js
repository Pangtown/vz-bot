import { runWithContext } from '../context.js';
import { listProjects, listUsers } from '../../vhi/identity.js';
import { json } from './helpers.js';
import { logger } from '../../utils/index.js';

export async function handleProjects(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listProjects());
    return json(res, 200, { projects: data });
  } catch (err) {
    logger.error(`handleProjects error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}

export async function handleUsers(req, res, ctx) {
  try {
    const data = await runWithContext(ctx, () => listUsers());
    return json(res, 200, { users: data });
  } catch (err) {
    logger.error(`handleUsers error: ${err.message}`, { error: err.message });
    return json(res, 502, { error: err.message });
  }
}
