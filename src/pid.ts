import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

export function writePid(pidPath: string): void {
  writeFileSync(pidPath, String(process.pid), 'utf-8');
}

export function readPid(pidPath: string): number | null {
  try {
    const content = readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function checkDaemon(pidPath: string): { running: boolean; pid: number | null } {
  const pid = readPid(pidPath);
  if (pid === null) return { running: false, pid: null };
  if (isProcessAlive(pid)) return { running: true, pid };
  // Stale PID file — clean it up
  removePid(pidPath);
  return { running: false, pid: null };
}

export function removePid(pidPath: string): void {
  try {
    unlinkSync(pidPath);
  } catch {
    // Already gone
  }
}

/**
 * Send SIGTERM to a daemon and wait for it to exit.
 * Polls isProcessAlive every `intervalMs` up to `timeoutMs`.
 * Only removes the PID file if the daemon's own cleanup didn't.
 * Throws if the process doesn't exit within the timeout.
 */
export async function stopDaemon(
  pid: number,
  pidPath: string,
  { timeoutMs = 5000, intervalMs = 100 } = {},
): Promise<void> {
  process.kill(pid, 'SIGTERM');

  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms after SIGTERM`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // Clean up PID file only if the daemon didn't remove it itself
  if (readPid(pidPath) !== null) {
    removePid(pidPath);
  }
}
