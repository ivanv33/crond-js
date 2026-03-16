import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createLogger, type Logger } from './logger.js';
import { writePid, checkDaemon, removePid } from './pid.js';
import { parseCrontab, cronMatchDate, type CronJob } from './crontab.js';

export interface DaemonOptions {
  foreground?: boolean;
  pidFile?: string;
}

const runningJobs = new Map<number, ChildProcess>();
let lastCrontabContent = '';
let currentJobs: CronJob[] = [];
let logger: Logger;
let pidPath: string;
let crontabPath: string;
let cwd: string;
let timer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;

function floorToMinute(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

export function msToNextMinute(now?: Date): number {
  const date = now ?? new Date();
  return 60_000 - (date.getTime() % 60_000);
}

export function matchJobs(jobs: CronJob[], now: Date): CronJob[] {
  const floored = floorToMinute(now);
  return jobs.filter(job => cronMatchDate(job.cron, floored));
}

function loadCrontab(): void {
  let content: string;
  try {
    content = readFileSync(crontabPath, 'utf-8');
  } catch {
    return; // File missing or unreadable — keep current jobs
  }

  if (content === lastCrontabContent) return;

  if (lastCrontabContent !== '') {
    logger.log('RELOAD', crontabPath);
  }
  lastCrontabContent = content;
  currentJobs = parseCrontab(content);
}

export function executeJob(job: CronJob): void {
  if (runningJobs.has(job.id)) return; // Skip overlapping

  logger.log('CMD', job.command);

  const child = spawn('sh', ['-c', job.command], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  runningJobs.set(job.id, child);

  let stdoutBuf = '';
  child.stdout?.on('data', (data: Buffer) => {
    stdoutBuf += data.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop()!; // keep incomplete fragment
    for (const line of lines) {
      if (line) logger.log('CMDOUT', line);
    }
  });

  let stderrBuf = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderrBuf += data.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop()!; // keep incomplete fragment
    for (const line of lines) {
      if (line) logger.log('CMDOUT', line);
    }
  });

  child.on('error', (err) => {
    logger.log('CMDERR', `${job.command} error=${err.message}`);
    runningJobs.delete(job.id);
  });

  child.on('close', (code) => {
    if (stdoutBuf) logger.log('CMDOUT', stdoutBuf);
    if (stderrBuf) logger.log('CMDOUT', stderrBuf);
    logger.log('CMDEND', `${job.command} exit=${code ?? 'unknown'}`);
    runningJobs.delete(job.id);
  });
}

export function getRunningJobCount(): number {
  return runningJobs.size;
}

/** @internal — test-only: inject a logger without full startDaemon side-effects */
export function _setLogger(l: Logger): void {
  logger = l;
}


function tick(): void {
  loadCrontab();
  const now = new Date();
  const matched = matchJobs(currentJobs, now);
  for (const job of matched) {
    executeJob(job);
  }
}

function scheduleTick(): void {
  timer = setTimeout(() => { tick(); scheduleTick(); }, msToNextMinute());
}

function cleanup(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  // Kill all running child processes before removing PID file
  for (const [id, child] of runningJobs) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Process may have already exited
    }
  }
  runningJobs.clear();

  isRunning = false;
  removePid(pidPath);
  logger.log('SHUTDOWN', 'crond-js');
}

/** Stop the daemon and reset module state. Useful for tests. */
export function stopDaemonProcess(): void {
  cleanup();
}

export function startDaemon(crontabFile: string, options: DaemonOptions = {}): void {
  if (isRunning) {
    throw new Error('crond-js: daemon already running in this process');
  }

  crontabPath = resolve(crontabFile);
  cwd = process.cwd();
  const cronDir = dirname(crontabPath);
  const logDir = join(cronDir, 'log');
  pidPath = options.pidFile ?? join(cronDir, 'cron.pid');
  const foreground = options.foreground ?? true;

  // Check for existing daemon
  const { running, pid } = checkDaemon(pidPath);
  if (running) {
    console.error(`crond-js: daemon already running (PID ${pid})`);
    process.exit(1);
  }

  logger = createLogger(logDir, foreground);
  writePid(pidPath);
  isRunning = true;
  logger.log('STARTUP', 'crond-js 1.0.0');

  // Clean shutdown on signals — re-entrancy guard prevents double cleanup
  let cleaningUp = false;
  const onSignal = () => {
    if (cleaningUp) return;
    cleaningUp = true;
    cleanup();
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // First tick immediately
  tick();

  // Schedule next tick aligned to wall clock
  scheduleTick();
}
