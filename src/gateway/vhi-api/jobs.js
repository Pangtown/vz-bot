import { runWithContext } from '../context.js';
import { listJobs, createJob, updateJob, deleteJob, executeJobById } from '../jobs.js';
import { json, readBody } from './helpers.js';
import { logger } from '../../utils/index.js';

export async function handleJobs(req, res, ctx, jobId) {
  const m = req.method || 'GET';
  try {
    if (m === 'GET' && !jobId) {
      const jobs = await listJobs();
      return json(res, 200, { jobs });
    }
    if (m === 'POST' && !jobId) {
      const body = await readBody(req);
      const job = await createJob(body, ctx);
      logger.info(`Created scheduled job ${job.name}`);
      return json(res, 200, { job });
    }
    if (m === 'PATCH' && jobId) {
      const body = await readBody(req);
      const job = await updateJob(jobId, body);
      if (!job) return json(res, 404, { error: 'Job not found' });
      return json(res, 200, { job });
    }
    if (m === 'DELETE' && jobId) {
      const ok = await deleteJob(jobId);
      if (!ok) return json(res, 404, { error: 'Job not found' });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    logger.error(`handleJobs error: ${err.message}`);
    return json(res, 502, { error: err.message });
  }
}

export async function handleJobRun(req, res, ctx, jobId) {
  try {
    const job = await executeJobById(jobId);
    return json(res, 200, { job });
  } catch (err) {
    logger.error(`handleJobRun error: ${err.message}`);
    const status = /not found/i.test(err.message) ? 404 : 502;
    return json(res, status, { error: err.message });
  }
}
