import { describe, it, expect } from 'vitest';
import { parseCrontab, cronMatchDate } from '../../src/crontab.js';

describe('parseCrontab', () => {
  it('parses a valid crontab line', () => {
    const jobs = parseCrontab('*/5 * * * * ./scripts/check-health.sh');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].schedule).toBe('*/5 * * * *');
    expect(jobs[0].command).toBe('./scripts/check-health.sh');
  });

  it('parses multiple lines', () => {
    const content = [
      '*/5 * * * * ./run.sh',
      '0 9 * * 1-5 ./daily.sh',
    ].join('\n');
    const jobs = parseCrontab(content);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].command).toBe('./run.sh');
    expect(jobs[1].command).toBe('./daily.sh');
    expect(jobs[1].schedule).toBe('0 9 * * 1-5');
  });

  it('skips comments and blank lines', () => {
    const content = [
      '# This is a comment',
      '',
      '  # Indented comment',
      '  ',
      '* * * * * echo hello',
    ].join('\n');
    const jobs = parseCrontab(content);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].command).toBe('echo hello');
  });

  it('skips malformed lines without crashing', () => {
    const content = [
      'not a valid line',
      '* * * * * echo valid',
      '* * *',
    ].join('\n');
    const jobs = parseCrontab(content);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].command).toBe('echo valid');
  });

  it('preserves multi-word commands', () => {
    const jobs = parseCrontab('0 * * * * rm -rf tmp/* && echo done');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].command).toBe('rm -rf tmp/* && echo done');
  });

  it('handles ranges and steps', () => {
    const jobs = parseCrontab('0 9 * * 1-5 ./weekday-only.sh');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].schedule).toBe('0 9 * * 1-5');
    // Verify the cron object was created (validates the schedule)
    expect(jobs[0].cron).toBeDefined();
  });

  it('matches dates correctly via cronMatchDate', () => {
    const jobs = parseCrontab('30 14 * * * ./afternoon.sh');
    expect(jobs).toHaveLength(1);
    // Monday March 16, 2026 at 14:30:00
    const match = new Date(2026, 2, 16, 14, 30, 0);
    const noMatch = new Date(2026, 2, 16, 14, 31, 0);
    expect(cronMatchDate(jobs[0].cron, match)).toBe(true);
    expect(cronMatchDate(jobs[0].cron, noMatch)).toBe(false);
  });

  it('matches dates with non-zero milliseconds via cronMatchDate', () => {
    const jobs = parseCrontab('30 14 * * * ./afternoon.sh');
    expect(jobs).toHaveLength(1);
    // Date with 500ms — should still match the 14:30 minute
    const dateWithMs = new Date(2026, 2, 16, 14, 30, 0, 500);
    expect(cronMatchDate(jobs[0].cron, dateWithMs)).toBe(true);
  });
});
