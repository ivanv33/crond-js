#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDaemon, removePid, readPid, isProcessAlive, stopDaemon } from './pid.js';
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
  try {
    await stopDaemon(pid, resolvedPidFile);
  } catch (err) {
    console.error(`Failed to stop crond-js: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`crond-js stopped (PID ${pid})`);
  process.exit(0);
}

// --daemon (fork and exit)
if (flags.has('-d') || flags.has('--daemon')) {
  // Re-invoke with the same argv[0..1] so tsx/node/bun all work
  // Strip debug/inspect flags to avoid exposing a debug port on the background daemon
  const safeExecArgv = process.execArgv.filter(arg => !arg.startsWith('--inspect') && !arg.startsWith('--debug'));
  const execArgs = [...safeExecArgv, fileURLToPath(import.meta.url), resolvedCrontab, '-p', resolvedPidFile];
  const child = spawn(process.execPath, execArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`crond-js started in background (PID ${child.pid})`);
  process.exit(0);
}

// Foreground mode (default)
startDaemon(resolvedCrontab, { foreground: true, pidFile: resolvedPidFile });
