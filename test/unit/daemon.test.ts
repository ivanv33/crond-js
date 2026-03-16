import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { matchJobs, msToNextMinute, executeJob, getRunningJobCount, _setLogger, startDaemon, stopDaemonProcess } from '../../src/daemon.js';
import { parseCrontab } from '../../src/crontab.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/pid.js', () => ({
  checkDaemon: vi.fn(() => ({ running: false, pid: undefined })),
  writePid: vi.fn(),
  removePid: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  createLogger: vi.fn(() => ({ log: vi.fn() })),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));


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

describe('msToNextMinute', () => {
  it('returns ms remaining until the next minute boundary', () => {
    // 14:30:45.200 → 14800ms until 14:31:00.000
    const now = new Date(2026, 2, 16, 14, 30, 45, 200);
    expect(msToNextMinute(now)).toBe(14800);
  });

  it('returns 60000 when exactly on a minute boundary', () => {
    const now = new Date(2026, 2, 16, 14, 30, 0, 0);
    expect(msToNextMinute(now)).toBe(60_000);
  });

  it('returns 1 when 1ms before the next minute', () => {
    const now = new Date(2026, 2, 16, 14, 30, 59, 999);
    expect(msToNextMinute(now)).toBe(1);
  });

  it('handles mid-second times', () => {
    // 14:30:30.000 → 30000ms remaining
    const now = new Date(2026, 2, 16, 14, 30, 30, 0);
    expect(msToNextMinute(now)).toBe(30_000);
  });
});

describe('executeJob', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _setLogger({ log: vi.fn() });
    stopDaemonProcess(); // clear runningJobs between tests
  });

  it('removes job from runningJobs when spawn emits an error', async () => {
    const { spawn } = await import('node:child_process');
    const mockedSpawn = vi.mocked(spawn);

    // Create a fake child process as an EventEmitter with stdout/stderr
    const fakeChild = new EventEmitter() as any;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    mockedSpawn.mockReturnValue(fakeChild);

    const job = { id: 0, cron: {} as any, command: 'failing-command' };
    executeJob(job);

    expect(getRunningJobCount()).toBe(1);

    // Simulate a spawn error (e.g., ENOENT)
    fakeChild.emit('error', new Error('spawn ENOENT'));

    expect(getRunningJobCount()).toBe(0);
  });

  it('logs the error via CMDERR tag', async () => {
    const { spawn } = await import('node:child_process');
    const mockedSpawn = vi.mocked(spawn);
    const logFn = vi.fn();
    _setLogger({ log: logFn });

    const fakeChild = new EventEmitter() as any;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    mockedSpawn.mockReturnValue(fakeChild);

    const job = { id: 0, cron: {} as any, command: 'bad-cmd' };
    executeJob(job);

    fakeChild.emit('error', new Error('spawn ENOENT'));

    expect(logFn).toHaveBeenCalledWith('CMDERR', 'bad-cmd error=spawn ENOENT');
  });

  it('buffers partial lines across chunks before logging', async () => {
    const { spawn } = await import('node:child_process');
    const mockedSpawn = vi.mocked(spawn);
    const logFn = vi.fn();
    _setLogger({ log: logFn });

    const fakeChild = new EventEmitter() as any;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    mockedSpawn.mockReturnValue(fakeChild);

    const job = { id: 0, cron: {} as any, command: 'echo hello world' };
    executeJob(job);

    // Simulate two chunks that split mid-line
    fakeChild.stdout.emit('data', Buffer.from('hello wo'));
    fakeChild.stdout.emit('data', Buffer.from('rld\n'));

    const cmdoutCalls = logFn.mock.calls.filter(
      ([tag]: [string]) => tag === 'CMDOUT',
    );
    expect(cmdoutCalls).toHaveLength(1);
    expect(cmdoutCalls[0][1]).toBe('hello world');
  });

  it('flushes remaining buffer on close', async () => {
    const { spawn } = await import('node:child_process');
    const mockedSpawn = vi.mocked(spawn);
    const logFn = vi.fn();
    _setLogger({ log: logFn });

    const fakeChild = new EventEmitter() as any;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    mockedSpawn.mockReturnValue(fakeChild);

    const job = { id: 99, cron: {} as any, command: 'echo no-newline' };
    executeJob(job);

    // Emit data without a trailing newline
    fakeChild.stdout.emit('data', Buffer.from('partial'));
    fakeChild.emit('close', 0);

    const cmdoutCalls = logFn.mock.calls.filter(
      ([tag]: [string]) => tag === 'CMDOUT',
    );
    expect(cmdoutCalls).toHaveLength(1);
    expect(cmdoutCalls[0][1]).toBe('partial');
  });

  it('does not block other jobs when one job is long-running', async () => {
    const { spawn } = await import('node:child_process');
    const mockedSpawn = vi.mocked(spawn);
    const logFn = vi.fn();
    _setLogger({ log: logFn });

    const makeFakeChild = () => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    };

    const longChild = makeFakeChild();
    const shortChild = makeFakeChild();
    mockedSpawn.mockReturnValueOnce(longChild);
    mockedSpawn.mockReturnValueOnce(shortChild);

    const longJob = { id: 0, cron: {} as any, command: 'sleep 300' };
    const shortJob = { id: 1, cron: {} as any, command: 'echo fast' };

    // Start long-running job
    executeJob(longJob);
    expect(getRunningJobCount()).toBe(1);

    // Short job starts fine even though long job is still running
    executeJob(shortJob);
    expect(getRunningJobCount()).toBe(2);

    // Short job completes
    shortChild.emit('close', 0);
    expect(getRunningJobCount()).toBe(1);

    // Long job is still running — re-executing it should be skipped (no overlap)
    mockedSpawn.mockReturnValueOnce(makeFakeChild());
    executeJob(longJob);
    expect(getRunningJobCount()).toBe(1); // still 1, not 2
    expect(mockedSpawn).toHaveBeenCalledTimes(2); // no new spawn

    // Long job finally completes
    longChild.emit('close', 0);
    expect(getRunningJobCount()).toBe(0);
  });

  it('allows two jobs with the same command but different IDs to run concurrently', async () => {
    const { spawn } = await import('node:child_process');
    const mockedSpawn = vi.mocked(spawn);

    const makeFakeChild = () => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    };

    mockedSpawn.mockReturnValueOnce(makeFakeChild());
    mockedSpawn.mockReturnValueOnce(makeFakeChild());

    const jobA = { id: 0, cron: {} as any, command: 'echo hello' };
    const jobB = { id: 1, cron: {} as any, command: 'echo hello' };

    executeJob(jobA);
    executeJob(jobB);

    expect(getRunningJobCount()).toBe(2);
  });
});

describe('cleanup kills running children', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _setLogger({ log: vi.fn() });
    // Clear any leftover state from previous tests
    stopDaemonProcess();
  });

  it('sends SIGTERM to all running child processes on stopDaemonProcess', async () => {
    const { spawn } = await import('node:child_process');
    const mockedSpawn = vi.mocked(spawn);

    const makeFakeChild = () => {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      return child;
    };

    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    mockedSpawn.mockReturnValueOnce(child1);
    mockedSpawn.mockReturnValueOnce(child2);

    const jobA = { id: 10, cron: {} as any, command: 'sleep 100' };
    const jobB = { id: 11, cron: {} as any, command: 'sleep 200' };

    executeJob(jobA);
    executeJob(jobB);
    expect(getRunningJobCount()).toBe(2);

    stopDaemonProcess();

    expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child2.kill).toHaveBeenCalledWith('SIGTERM');
    expect(getRunningJobCount()).toBe(0);
  });
});

describe('startDaemon guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Reset state so other tests aren't affected
    try { stopDaemonProcess(); } catch { /* may not be running */ }
    vi.useRealTimers();
  });

  it('throws when called twice without stopping', () => {
    startDaemon('/tmp/fake-crontab', { foreground: true });

    expect(() => startDaemon('/tmp/fake-crontab', { foreground: true }))
      .toThrow('crond-js: daemon already running in this process');
  });

  it('allows restart after stopDaemonProcess', () => {
    startDaemon('/tmp/fake-crontab', { foreground: true });
    stopDaemonProcess();

    expect(() => startDaemon('/tmp/fake-crontab', { foreground: true }))
      .not.toThrow();
  });
});
