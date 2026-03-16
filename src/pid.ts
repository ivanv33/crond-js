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
