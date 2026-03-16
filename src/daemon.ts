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

const runningJobs = new Map<string, ChildProcess>();
let lastCrontabContent = '';
let currentJobs: CronJob[] = [];
let logger: Logger;
let pidPath: string;
let crontabPath: string;
let cwd: string;
let interval: ReturnType<typeof setInterval> | null = null;

function floorToMinute(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
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

function executeJob(job: CronJob): void {
  if (runningJobs.has(job.command)) return; // Skip overlapping

  logger.log('CMD', job.command);

  const child = spawn('sh', ['-c', job.command], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  runningJobs.set(job.command, child);

  const handleOutput = (data: Buffer) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line) logger.log('CMDOUT', line);
    }
  };

  child.stdout?.on('data', handleOutput);
  child.stderr?.on('data', handleOutput);

  child.on('close', (code) => {
    logger.log('CMDEND', `${job.command} exit=${code ?? 'unknown'}`);
    runningJobs.delete(job.command);
  });
}

function tick(): void {
  loadCrontab();
  const now = new Date();
  const matched = matchJobs(currentJobs, now);
  for (const job of matched) {
    executeJob(job);
  }
}

function cleanup(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  removePid(pidPath);
  logger.log('SHUTDOWN', 'crond-js');
}

export function startDaemon(crontabFile: string, options: DaemonOptions = {}): void {
  crontabPath = resolve(crontabFile);
  cwd = dirname(crontabPath);
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
  logger.log('STARTUP', 'crond-js 1.0.0');

  // Clean shutdown on signals
  const onSignal = () => {
    cleanup();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // First tick immediately
  tick();

  // Then every 60 seconds
  interval = setInterval(tick, 60_000);
}
