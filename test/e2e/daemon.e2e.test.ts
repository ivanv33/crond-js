import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '../..');
const cliPath = join(projectRoot, 'src/cli.ts');
const tsxPath = join(projectRoot, 'node_modules/.bin/tsx');

let tmpDirs: string[] = [];

function makeTmpDir(name: string): string {
  const dir = join(projectRoot, 'tmp', `e2e-${name}-${Date.now()}`);
  mkdirSync(join(dir, '.cron'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function writeCrontab(dir: string, content: string): void {
  writeFileSync(join(dir, '.cron/crontab'), content);
}

function readOutput(dir: string, filename: string): string {
  const path = join(dir, '.cron', filename);
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function pidFromFile(dir: string): number | null {
  try {
    return parseInt(readFileSync(join(dir, '.cron/cron.pid'), 'utf-8').trim(), 10);
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

afterEach(() => {
  // Kill any leftover daemons and clean up
  for (const dir of tmpDirs) {
    const pid = pidFromFile(dir);
    if (pid && isAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('daemon e2e', () => {
  it('executes a job on the first tick', async () => {
    const dir = makeTmpDir('exec');
    const outputFile = join(dir, 'output.txt');
    writeCrontab(dir, `* * * * * echo hello >> ${outputFile}`);

    const child = spawn(tsxPath, [cliPath, join(dir, '.cron/crontab')], {
      cwd: dir,
      stdio: 'pipe',
    });

    // Wait for first tick (immediate)
    await sleep(2000);

    child.kill('SIGTERM');
    await sleep(500);

    expect(existsSync(outputFile)).toBe(true);
    const content = readFileSync(outputFile, 'utf-8');
    expect(content.trim()).toBe('hello');
  }, 15_000);

  it('detects crontab changes (RELOAD)', async () => {
    const dir = makeTmpDir('reload');
    const outputFile1 = join(dir, 'out1.txt');
    const outputFile2 = join(dir, 'out2.txt');
    writeCrontab(dir, `* * * * * echo first >> ${outputFile1}`);

    const child = spawn(tsxPath, [cliPath, join(dir, '.cron/crontab')], {
      cwd: dir,
      stdio: 'pipe',
    });

    await sleep(2000);

    // Modify crontab
    writeCrontab(dir, `* * * * * echo second >> ${outputFile2}`);

    // Wait for next tick (up to 62 seconds)
    await sleep(62_000);

    child.kill('SIGTERM');
    await sleep(500);

    // Check logs for RELOAD
    const logDir = join(dir, '.cron/log');
    const logs = readFileSync(join(logDir, existsSync(logDir) ? require('fs').readdirSync(logDir)[0] : ''), 'utf-8');
    expect(logs).toContain('RELOAD');
    expect(existsSync(outputFile2)).toBe(true);
  }, 90_000);

  it('prevents duplicate daemon', async () => {
    const dir = makeTmpDir('dup');
    writeCrontab(dir, '* * * * * echo hi');

    const child1 = spawn(tsxPath, [cliPath, join(dir, '.cron/crontab')], {
      cwd: dir,
      stdio: 'pipe',
    });

    await sleep(1500);

    // Second instance should exit with error
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = '';
      const child2 = spawn(tsxPath, [cliPath, join(dir, '.cron/crontab')], {
        cwd: dir,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child2.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child2.on('close', (code) => resolve({ code, stderr }));
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('already running');

    child1.kill('SIGTERM');
    await sleep(500);
  }, 15_000);

  it('clean stop via --stop flag', async () => {
    const dir = makeTmpDir('stop');
    writeCrontab(dir, '* * * * * echo tick');

    // Start in daemon mode
    const child = spawn(tsxPath, [cliPath, join(dir, '.cron/crontab'), '-d'], {
      cwd: dir,
      stdio: 'pipe',
    });

    await sleep(2000);
    const pid = pidFromFile(dir);
    expect(pid).not.toBeNull();
    expect(isAlive(pid!)).toBe(true);

    // Stop it
    const stopChild = spawn(tsxPath, [cliPath, join(dir, '.cron/crontab'), '-k'], {
      cwd: dir,
      stdio: 'pipe',
    });

    await new Promise(r => stopChild.on('close', r));
    await sleep(500);

    // PID file should be gone, process should be dead
    expect(existsSync(join(dir, '.cron/cron.pid'))).toBe(false);
    if (pid) expect(isAlive(pid)).toBe(false);
  }, 15_000);

  it('log format matches crond style', async () => {
    const dir = makeTmpDir('logfmt');
    writeCrontab(dir, '* * * * * echo logtest');

    const child = spawn(tsxPath, [cliPath, join(dir, '.cron/crontab')], {
      cwd: dir,
      stdio: 'pipe',
    });

    await sleep(2000);
    child.kill('SIGTERM');
    await sleep(500);

    const logDir = join(dir, '.cron/log');
    const files = require('fs').readdirSync(logDir) as string[];
    expect(files.length).toBeGreaterThan(0);

    const logContent = readFileSync(join(logDir, files[0]), 'utf-8');
    const linePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} crond-js\[\d+\]: \w+ \(.+\)$/m;
    expect(logContent).toMatch(linePattern);
    expect(logContent).toContain('STARTUP');
    expect(logContent).toContain('CMD');
  }, 15_000);
});
