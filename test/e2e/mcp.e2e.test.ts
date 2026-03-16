import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '../..');
const mcpPath = join(projectRoot, 'src/mcp.ts');
const tsxPath = join(projectRoot, 'node_modules/.bin/tsx');

let tmpDirs: string[] = [];

function makeTmpDir(name: string): string {
  const dir = join(projectRoot, 'tmp', `e2e-mcp-${name}-${Date.now()}`);
  mkdirSync(join(dir, '.cron'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
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
  for (const dir of tmpDirs) {
    const pid = pidFromFile(dir);
    if (pid && isAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('mcp e2e', () => {
  it('daemon survives MCP server exit', async () => {
    const dir = makeTmpDir('survive');
    writeFileSync(join(dir, '.cron/crontab'), '* * * * * echo mcp-test');

    // Start MCP server (which auto-starts daemon)
    const mcpChild = spawn(tsxPath, [mcpPath, join(dir, '.cron/crontab')], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for daemon to start
    await sleep(3000);

    const daemonPid = pidFromFile(dir);
    expect(daemonPid).not.toBeNull();
    expect(isAlive(daemonPid!)).toBe(true);

    // Kill MCP server
    mcpChild.kill('SIGTERM');
    await sleep(1000);

    // Daemon should still be alive
    expect(isAlive(daemonPid!)).toBe(true);

    // Clean up daemon
    process.kill(daemonPid!, 'SIGTERM');
    await sleep(500);
  }, 30_000);
});
