import { describe, it, expect } from 'vitest';
import { matchJobs } from '../../src/daemon.js';
import { parseCrontab } from '../../src/crontab.js';

describe('matchJobs', () => {
  it('matches a job at the right time', () => {
    const jobs = parseCrontab('30 9 * * * ./run.sh');
    // Monday March 16, 2026 09:30:00
    const now = new Date(2026, 2, 16, 9, 30, 0);
    const matched = matchJobs(jobs, now);
    expect(matched).toHaveLength(1);
    expect(matched[0].command).toBe('./run.sh');
  });

  it('does not match a job at the wrong time', () => {
    const jobs = parseCrontab('30 9 * * * ./run.sh');
    // Monday March 16, 2026 09:31:00
    const now = new Date(2026, 2, 16, 9, 31, 0);
    const matched = matchJobs(jobs, now);
    expect(matched).toHaveLength(0);
  });

  it('respects day-of-week (weekday only)', () => {
    const jobs = parseCrontab('0 9 * * 1-5 ./weekday.sh');
    // Monday March 16, 2026 09:00
    const monday = new Date(2026, 2, 16, 9, 0, 0);
    // Sunday March 15, 2026 09:00
    const sunday = new Date(2026, 2, 15, 9, 0, 0);

    expect(matchJobs(jobs, monday)).toHaveLength(1);
    expect(matchJobs(jobs, sunday)).toHaveLength(0);
  });

  it('matches every-minute job at any minute', () => {
    const jobs = parseCrontab('* * * * * echo tick');
    const now = new Date(2026, 2, 16, 14, 23, 0);
    expect(matchJobs(jobs, now)).toHaveLength(1);
  });

  it('floors seconds when matching', () => {
    const jobs = parseCrontab('30 9 * * * ./run.sh');
    // 09:30:45 — should still match 09:30
    const now = new Date(2026, 2, 16, 9, 30, 45);
    expect(matchJobs(jobs, now)).toHaveLength(1);
  });

  it('matches multiple jobs at the same time', () => {
    const content = [
      '* * * * * echo a',
      '* * * * * echo b',
    ].join('\n');
    const jobs = parseCrontab(content);
    const now = new Date(2026, 2, 16, 10, 0, 0);
    expect(matchJobs(jobs, now)).toHaveLength(2);
  });

  it('handles step expressions', () => {
    const jobs = parseCrontab('*/5 * * * * ./every-five.sh');
    const at0 = new Date(2026, 2, 16, 10, 0, 0);
    const at3 = new Date(2026, 2, 16, 10, 3, 0);
    const at5 = new Date(2026, 2, 16, 10, 5, 0);
    expect(matchJobs(jobs, at0)).toHaveLength(1);
    expect(matchJobs(jobs, at3)).toHaveLength(0);
    expect(matchJobs(jobs, at5)).toHaveLength(1);
  });
});
