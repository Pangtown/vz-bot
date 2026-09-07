/**
 * User-scheduled jobs – persist to data/scheduled_jobs.json and tick from the cron scheduler.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runWithContext } from './context.js';
import { startServer, stopServer, rebootServer } from '../vhi/compute.js';
import { createSnapshot } from '../vhi/block.js';
import { logger } from '../utils/index.js';

const JOBS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'scheduled_jobs.json');

const ALLOWED_ACTIONS = new Set(['start_vm', 'stop_vm', 'reboot_vm', 'snapshot_volume']);

function sameMinute(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
    && a.getHours() === b.getHours()
    && a.getMinutes() === b.getMinutes();
}

function fieldMatches(field, value) {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const n = parseInt(field.slice(2), 10);
    return Number.isFinite(n) && n > 0 && value % n === 0;
  }
  return field.split(',').some((part) => {
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      return value >= lo && value <= hi;
    }
    return Number(part) === value;
  });
}

export function cronMatches(expr, date) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const vals = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  return parts.every((field, i) => fieldMatches(field, vals[i]));
}

export function isJobDue(job, now = new Date()) {
  if (!job || job.enabled === false) return false;
  const last = job.lastRunAt ? new Date(job.lastRunAt) : null;
  if (last && Number.isNaN(last.getTime())) return false;
  const schedule = job.schedule || {};

  if (schedule.kind === 'once') {
    if (last) return false;
    const at = new Date(schedule.at);
    return !Number.isNaN(at.getTime()) && now >= at;
  }

  if (schedule.kind === 'interval') {
    const ms = Math.max(1, Number(schedule.minutes) || 60) * 60 * 1000;
    const baseline = last || (job.createdAt ? new Date(job.createdAt) : now);
    return now - baseline >= ms;
  }

  if (schedule.kind === 'cron') {
    if (!cronMatches(schedule.expr, now)) return false;
    if (last && sameMinute(last, now)) return false;
    return true;
  }

  return false;
}

export function sanitizeJob(job) {
  const { context, ...rest } = job || {};
  return {
    ...rest,
    clusterUrl: job?.clusterUrl || context?.vhiBaseUrl || '',
    hasCredentials: !!(context && context.vhiPassword),
  };
}

async function readJobsFile() {
  try {
    const raw = await readFile(JOBS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeJobsFile(jobs) {
  await mkdir(dirname(JOBS_PATH), { recursive: true });
  await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2));
}

export async function listJobs() {
  const jobs = await readJobsFile();
  return jobs.map(sanitizeJob);
}

export async function getJob(id) {
  const jobs = await readJobsFile();
  return jobs.find((j) => j.id === id) || null;
}

export async function createJob(payload, ctx) {
  const name = String(payload.name || '').trim();
  const action = String(payload.action || '').trim();
  if (!name) throw new Error('Job name is required');
  if (!ALLOWED_ACTIONS.has(action)) throw new Error(`Unsupported action: ${action}`);
  if (!payload.targetId) throw new Error('targetId is required');
  const schedule = payload.schedule || {};
  if (!['cron', 'interval', 'once'].includes(schedule.kind)) {
    throw new Error('schedule.kind must be cron, interval, or once');
  }
  if (schedule.kind === 'cron' && !cronMatches(schedule.expr, new Date())) {
    const parts = String(schedule.expr || '').trim().split(/\s+/);
    if (parts.length !== 5) throw new Error('cron expression must have 5 fields (min hour day month weekday)');
  }
  if (schedule.kind === 'once' && Number.isNaN(new Date(schedule.at).getTime())) {
    throw new Error('schedule.at must be a valid datetime');
  }

  const job = {
    id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    enabled: payload.enabled !== false,
    action,
    targetId: payload.targetId,
    targetName: payload.targetName || payload.targetId,
    schedule,
    clusterUrl: ctx.vhiBaseUrl,
    context: {
      vhiBaseUrl: ctx.vhiBaseUrl,
      vhiUser: ctx.vhiUser,
      vhiPassword: ctx.vhiPassword,
      vhiProject: ctx.vhiProject,
      vhiDomain: ctx.vhiDomain,
      vhiProjectId: ctx.vhiProjectId,
    },
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: new Date().toISOString(),
  };
  const jobs = await readJobsFile();
  jobs.push(job);
  await writeJobsFile(jobs);
  return sanitizeJob(job);
}

export async function updateJob(id, patch) {
  const jobs = await readJobsFile();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return null;
  const current = jobs[idx];
  if (patch.name !== undefined) current.name = String(patch.name).trim();
  if (patch.enabled !== undefined) current.enabled = !!patch.enabled;
  if (patch.schedule !== undefined) current.schedule = patch.schedule;
  if (patch.targetId !== undefined) current.targetId = patch.targetId;
  if (patch.targetName !== undefined) current.targetName = patch.targetName;
  jobs[idx] = current;
  await writeJobsFile(jobs);
  return sanitizeJob(current);
}

export async function deleteJob(id) {
  const jobs = await readJobsFile();
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return false;
  await writeJobsFile(next);
  return true;
}

async function runAction(job) {
  if (job.action === 'start_vm') return startServer(job.targetId);
  if (job.action === 'stop_vm') return stopServer(job.targetId);
  if (job.action === 'reboot_vm') return rebootServer(job.targetId, 'SOFT');
  if (job.action === 'snapshot_volume') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return createSnapshot(`${job.targetName || 'volume'}-${stamp}`, job.targetId, 'Scheduled snapshot');
  }
  throw new Error(`Unsupported action: ${job.action}`);
}

export async function executeJobById(id) {
  const jobs = await readJobsFile();
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error('Job not found');
  if (!job.context?.vhiPassword) throw new Error('Job is missing cluster credentials');

  try {
    await runWithContext(job.context, () => runAction(job));
    job.lastRunAt = new Date().toISOString();
    job.lastStatus = 'ok';
    job.lastError = null;
    if (job.schedule?.kind === 'once') job.enabled = false;
    await writeJobsFile(jobs);
    logger.info(`Scheduled job ${job.name} (${job.action}) completed`);
    return sanitizeJob(job);
  } catch (err) {
    job.lastRunAt = new Date().toISOString();
    job.lastStatus = 'error';
    job.lastError = err.message;
    await writeJobsFile(jobs);
    logger.error(`Scheduled job ${job.name} failed: ${err.message}`);
    throw err;
  }
}

export async function tickDueJobs(now = new Date()) {
  const jobs = await readJobsFile();
  const due = jobs.filter((j) => isJobDue(j, now));
  for (const job of due) {
    try {
      await executeJobById(job.id);
    } catch (err) {
      logger.error(`Job tick error for ${job.id}: ${err.message}`);
    }
  }
  return due.length;
}
