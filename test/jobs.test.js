import { isJobDue, cronMatches, sanitizeJob } from '../src/gateway/jobs.js';

describe('scheduled jobs', () => {
  test('cronMatches understands 5-field expressions', () => {
    const d = new Date(2026, 8, 7, 2, 0, 0); // Sep 7 2026 02:00
    expect(cronMatches('0 2 * * *', d)).toBe(true);
    expect(cronMatches('0 3 * * *', d)).toBe(false);
    expect(cronMatches('*/5 * * * *', d)).toBe(true);
    expect(cronMatches('1 2 * * *', d)).toBe(false);
  });

  test('isJobDue for interval waits until minutes elapse', () => {
    const createdAt = new Date('2026-09-07T08:00:00Z');
    const job = {
      enabled: true,
      createdAt: createdAt.toISOString(),
      lastRunAt: null,
      schedule: { kind: 'interval', minutes: 30 },
    };
    expect(isJobDue(job, new Date('2026-09-07T08:10:00Z'))).toBe(false);
    expect(isJobDue(job, new Date('2026-09-07T08:31:00Z'))).toBe(true);
  });

  test('isJobDue for once fires once then stops', () => {
    const job = {
      enabled: true,
      lastRunAt: null,
      schedule: { kind: 'once', at: '2026-09-07T09:00:00Z' },
    };
    expect(isJobDue(job, new Date('2026-09-07T08:59:00Z'))).toBe(false);
    expect(isJobDue(job, new Date('2026-09-07T09:00:01Z'))).toBe(true);
    job.lastRunAt = '2026-09-07T09:00:01Z';
    expect(isJobDue(job, new Date('2026-09-07T09:05:00Z'))).toBe(false);
  });

  test('sanitizeJob strips credentials', () => {
    const out = sanitizeJob({
      id: 'job_1',
      name: 'nightly',
      context: { vhiBaseUrl: 'https://cluster', vhiPassword: 'secret' },
    });
    expect(out.context).toBeUndefined();
    expect(out.hasCredentials).toBe(true);
    expect(out.clusterUrl).toBe('https://cluster');
  });
});
