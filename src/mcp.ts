#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Cron } from 'croner';
import { checkDaemon, readPid, isProcessAlive } from './pid.js';
import { parseCrontab } from './crontab.js';

// Parse args
const args = process.argv.slice(2);
let crontabPath: string | null = null;
let pidFile: string | null = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-p' || arg === '--pidfile') {
    pidFile = args[++i];
  } else if (!arg.startsWith('-')) {
    crontabPath = arg;
  }
}

if (!crontabPath) {
  console.error('Usage: crond-mcp <crontab-path> [-p|--pidfile <path>]');
  process.exit(1);
}

const resolvedCrontab = resolve(crontabPath);
const cronDir = dirname(resolvedCrontab);
const resolvedPidFile = pidFile ? resolve(pidFile) : join(cronDir, 'cron.pid');
const logDir = join(cronDir, 'log');

// Ensure daemon is running
const { running } = checkDaemon(resolvedPidFile);
if (!running) {
  // Fork daemon using CLI entry point — preserve tsx/loader args
  const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const child = spawn(process.execPath, [...process.execArgv, cliPath, resolvedCrontab, '-p', resolvedPidFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  // Brief wait for PID file to appear
  await new Promise(r => setTimeout(r, 500));
}

// Parse today's log for last run info
function parseLogForJobs(): Map<string, { lastRun: string; lastExitCode: string }> {
  const results = new Map<string, { lastRun: string; lastExitCode: string }>();
  const now = new Date();
  const dateSlug = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const logFile = join(logDir, `${dateSlug}.log`);

  let content: string;
  try {
    content = readFileSync(logFile, 'utf-8');
  } catch {
    return results;
  }

  for (const line of content.split('\n')) {
    const cmdMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) crond-js\[\d+\]: CMD \((.+)\)$/);
    if (cmdMatch) {
      results.set(cmdMatch[2], { lastRun: cmdMatch[1], lastExitCode: 'running' });
      continue;
    }
    const endMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) crond-js\[\d+\]: CMDEND \((.+) exit=(.+)\)$/);
    if (endMatch) {
      const cmd = endMatch[2];
      const existing = results.get(cmd);
      if (existing) {
        existing.lastExitCode = endMatch[3];
      }
    }
  }

  return results;
}

// MCP Server
const server = new McpServer({
  name: 'crond-mcp',
  version: '1.0.0',
});

server.tool('cron_status', 'Check daemon status, scheduled jobs, last/next run times', {}, async () => {
  const pid = readPid(resolvedPidFile);
  const alive = pid !== null && isProcessAlive(pid);
  const logInfo = parseLogForJobs();

  let jobs: Array<{
    schedule: string;
    command: string;
    last_run: string | null;
    last_exit_code: string | null;
    next_run: string | null;
  }> = [];

  try {
    const parsed = parseCrontab(readFileSync(resolvedCrontab, 'utf-8'));
    jobs = parsed.map(job => {
      const info = logInfo.get(job.command);
      const nextRun = job.cron.nextRun();
      return {
        schedule: job.schedule,
        command: job.command,
        last_run: info?.lastRun ?? null,
        last_exit_code: info?.lastExitCode ?? null,
        next_run: nextRun ? nextRun.toISOString() : null,
      };
    });
  } catch {
    // Crontab unreadable
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        daemon_pid: alive ? pid : null,
        daemon_running: alive,
        jobs,
      }, null, 2),
    }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
