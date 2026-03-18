import { readFileSync, writeFileSync, unlinkSync, openSync, writeSync, closeSync, constants } from 'node:fs';

/**
 * Atomically create a PID file using O_EXCL to prevent races.
 * If a stale PID file exists (process dead), removes it and retries once.
 */
export function writePid(pidPath: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(pidPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // File exists — check if the owning process is still alive
      const existingPid = readPid(pidPath);
      if (existingPid !== null && isProcessAlive(existingPid)) {
        throw new Error(`crond-js: PID file ${pidPath} held by live process ${existingPid}`);
      }
      // Stale PID file — remove and retry
      removePid(pidPath);
    }
  }
  throw new Error(`crond-js: failed to acquire PID file ${pidPath} after 2 attempts`);
}

export function readPid(pidPath: string): number | null {
  try {
    const content = readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
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
