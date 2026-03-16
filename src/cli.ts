#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDaemon, removePid, readPid, isProcessAlive } from './pid.js';
import { startDaemon } from './daemon.js';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const flags = new Set<string>();
let crontabPath: string | null = null;
let pidFile: string | null = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-p' || arg === '--pidfile') {
    pidFile = args[++i];
  } else if (arg.startsWith('-')) {
    flags.add(arg);
  } else {
    crontabPath = arg;
  }
}

if (!crontabPath) {
  console.error('Usage: crond-js <crontab-path> [-d|--daemon] [-s|--status] [-k|--stop] [-p|--pidfile <path>]');
  process.exit(1);
}

const resolvedCrontab = resolve(crontabPath);
const cronDir = dirname(resolvedCrontab);
const resolvedPidFile = pidFile ? resolve(pidFile) : join(cronDir, 'cron.pid');

// --status
if (flags.has('-s') || flags.has('--status')) {
  const { running, pid } = checkDaemon(resolvedPidFile);
  if (running) {
    console.log(`crond-js is running (PID ${pid})`);
  } else {
    console.log('crond-js is not running');
  }
  process.exit(0);
}

// --stop
if (flags.has('-k') || flags.has('--stop')) {
  const pid = readPid(resolvedPidFile);
  if (pid === null || !isProcessAlive(pid)) {
    console.log('crond-js is not running');
    process.exit(0);
  }
  process.kill(pid, 'SIGTERM');
  removePid(resolvedPidFile);
  console.log(`crond-js stopped (PID ${pid})`);
  process.exit(0);
}

// --daemon (fork and exit)
if (flags.has('-d') || flags.has('--daemon')) {
  const thisFile = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [thisFile, resolvedCrontab, '-p', resolvedPidFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`crond-js started in background (PID ${child.pid})`);
  process.exit(0);
}

// Foreground mode (default)
startDaemon(resolvedCrontab, { foreground: true, pidFile: resolvedPidFile });
