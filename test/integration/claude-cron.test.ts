import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, readFileSync, rmSync,
  existsSync, readdirSync, copyFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { readPid, isProcessAlive } from '../../src/pid.js';

const projectRoot = resolve(import.meta.dirname, '../..');
const fixturesDir = join(import.meta.dirname, 'fixtures');
const srcDir = join(projectRoot, 'src');

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = join(projectRoot, 'tmp', `integration-${Date.now()}`);
  mkdirSync(join(dir, '.cron'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function setupTestDir(dir: string): void {
  // Empty crontab
  writeFileSync(join(dir, '.cron/crontab'), '');

  // Copy and template .mcp.json
  const mcpTemplate = readFileSync(join(fixturesDir, 'mcp.json'), 'utf-8');
  writeFileSync(join(dir, '.mcp.json'), mcpTemplate.replace('{{SRC_DIR}}', srcDir));

  // Copy CLAUDE.md
  copyFileSync(join(fixturesDir, 'CLAUDE.md'), join(dir, 'CLAUDE.md'));
}

function claude(cwd: string, prompt: string): string {
  return execSync(
    `claude -p ${JSON.stringify(prompt)} --dangerously-skip-permissions`,
    { cwd, encoding: 'utf-8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function readLogLines(dir: string): string[] {
  const logDir = join(dir, '.cron/log');
  if (!existsSync(logDir)) return [];
  const files = readdirSync(logDir).filter(f => f.endsWith('.log'));
  return files.flatMap(f => readFileSync(join(logDir, f), 'utf-8').trim().split('\n'));
}

afterEach(() => {
  for (const dir of tmpDirs) {
    const pidPath = join(dir, '.cron/cron.pid');
    const pid = readPid(pidPath);
    if (pid !== null && isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('claude + crond-js integration', () => {
  it('schedules and executes a cron job from a natural task prompt', async () => {
    const dir = makeTmpDir();
    setupTestDir(dir);

    // Step 1: Give Claude a task that requires cron
    const prompt =
      'I need to monitor disk usage in this directory. Set up a scheduled job that ' +
      "runs every minute and appends the output of 'du -sh .' to a file called " +
      'disk-usage.log in this directory. Verify the cron daemon is running after you set it up.';

    const output = claude(dir, prompt);
    console.log('Claude output (tail):', output.slice(-500));

    // Step 2: Verify Claude wrote the crontab
    const crontab = readFileSync(join(dir, '.cron/crontab'), 'utf-8');
    console.log('Crontab:', crontab);
    expect(crontab.length).toBeGreaterThan(0);
    expect(crontab).toMatch(/du|disk.usage/);

    // Step 3: Verify daemon is running
    const pid = readPid(join(dir, '.cron/cron.pid'));
    expect(pid).not.toBeNull();
    expect(isProcessAlive(pid!)).toBe(true);

    // Step 4: Wait for the job to execute
    const outputFile = join(dir, 'disk-usage.log');
    let waited = 0;
    const maxWait = 90_000;
    while (waited < maxWait) {
      if (existsSync(outputFile)) break;
      await sleep(5_000);
      waited += 5_000;
    }

    expect(existsSync(outputFile)).toBe(true);

    const content = readFileSync(outputFile, 'utf-8');
    console.log('disk-usage.log:', content);
    expect(content).toMatch(/\d/); // contains a number (the size)

    // Step 5: Verify daemon logs
    const logs = readLogLines(dir);
    console.log('Logs:', logs.join('\n'));
    expect(logs.some(l => l.includes('STARTUP'))).toBe(true);
    expect(logs.some(l => l.includes('CMD'))).toBe(true);
    expect(logs.some(l => l.includes('CMDEND'))).toBe(true);
  }, 180_000);
});
