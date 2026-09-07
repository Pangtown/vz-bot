import { listJobs, createJob } from '../gateway/jobs.js';
import { getContextValue } from '../gateway/context.js';

function currentContext() {
  return {
    vhiBaseUrl: getContextValue('vhiBaseUrl', 'VHI_BASE_URL'),
    vhiUser: getContextValue('vhiUser', 'VHI_USER'),
    vhiPassword: getContextValue('vhiPassword', 'VHI_PASSWORD'),
    vhiProject: getContextValue('vhiProject', 'VHI_PROJECT_NAME') || 'admin',
    vhiDomain: getContextValue('vhiDomain', 'VHI_DOMAIN_NAME') || 'Default',
    vhiProjectId: getContextValue('vhiProjectId', 'VHI_PROJECT_ID') || '',
  };
}

export async function listScheduledJobs() {
  const jobs = await listJobs();
  return { count: jobs.length, jobs };
}

export async function createScheduledJob(args = {}) {
  if (!args.name || !args.action || !args.targetId) {
    throw new Error('name, action, and targetId are required');
  }
  const schedule = args.schedule || {
    kind: args.cron ? 'cron' : 'interval',
    expr: args.cron,
    minutes: args.minutes || 60,
  };
  const job = await createJob({
    name: args.name,
    action: args.action,
    targetId: args.targetId,
    targetName: args.target_name || args.targetName,
    schedule,
  }, currentContext());
  return { ok: true, job };
}
