import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stopDaemon, readPid, isProcessAlive } from '../../src/pid.js';

const tmpDir = join(import.meta.dirname, '../../tmp/test-cli-stop');
const pidFile = join(tmpDir, 'test.pid');

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('stopDaemon', () => {
  it('waits for the process to actually die before returning', async () => {
    mkdirSync(tmpDir, { recursive: true });

    // Spawn a real child process that sleeps for a long time
    const child = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;

    // Write a PID file to simulate a running daemon
    writeFileSync(pidFile, String(pid), 'utf-8');

    // Verify the process is alive before we stop it
    expect(isProcessAlive(pid)).toBe(true);

    // stopDaemon should send SIGTERM and wait until the process is gone
    await stopDaemon(pid, pidFile);

    // After stopDaemon returns, the process must be dead
    expect(isProcessAlive(pid)).toBe(false);

    // PID file should be cleaned up
    expect(readPid(pidFile)).toBeNull();
  });

  it('cleans up PID file even if daemon did not remove it', async () => {
    mkdirSync(tmpDir, { recursive: true });

    const child = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;

    writeFileSync(pidFile, String(pid), 'utf-8');

    await stopDaemon(pid, pidFile);

    // PID file must be gone
    expect(existsSync(pidFile)).toBe(false);
  });

  it('skips PID file removal if daemon already cleaned it up', async () => {
    mkdirSync(tmpDir, { recursive: true });

    const child = spawn('sleep', ['10'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;

    // No PID file on disk — simulates daemon cleaning up after itself
    // stopDaemon should not throw
    await stopDaemon(pid, pidFile);

    expect(isProcessAlive(pid)).toBe(false);
  });

  it('throws if process does not exit within timeout', async () => {
    mkdirSync(tmpDir, { recursive: true });

    // Use a Node script that ignores SIGTERM — more reliable cross-platform
    // than bash trap, which can behave differently under different process models.
    // The script writes "ready" to a file once the handler is installed.
    const readyFile = join(tmpDir, 'ready');
    const child = spawn(process.execPath, [
      '-e',
      `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(readyFile)}, "1"); setInterval(() => {}, 1000);`,
    ], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid!;

    // Wait for the child to signal it's ready (SIGTERM handler registered)
    const readyDeadline = Date.now() + 5000;
    while (!existsSync(readyFile)) {
      if (Date.now() >= readyDeadline) throw new Error('child never became ready');
      await new Promise((r) => setTimeout(r, 50));
    }

    writeFileSync(pidFile, String(pid), 'utf-8');

    // Verify it's alive first
    expect(isProcessAlive(pid)).toBe(true);

    await expect(
      stopDaemon(pid, pidFile, { timeoutMs: 500, intervalMs: 50 }),
    ).rejects.toThrow(/did not exit within 500ms/);

    // Clean up — force-kill since it ignored SIGTERM
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead
    }
  });
});
