import { describe, it, expect, afterEach } from 'vitest';
import { writePid, readPid, isProcessAlive, checkDaemon, removePid } from '../../src/pid.js';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const tmpDir = join(import.meta.dirname, '../../tmp/test-pid');
const pidFile = join(tmpDir, 'test.pid');

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('pid', () => {
  it('writes and reads back the current PID', () => {
    mkdirSync(tmpDir, { recursive: true });
    writePid(pidFile);
    const pid = readPid(pidFile);
    expect(pid).toBe(process.pid);
  });

  it('returns null for missing PID file', () => {
    expect(readPid(pidFile)).toBeNull();
  });

  it('detects current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('detects dead process', () => {
    // PID 99999 is almost certainly not running
    expect(isProcessAlive(99999)).toBe(false);
  });

  it('checkDaemon returns running for current process', () => {
    mkdirSync(tmpDir, { recursive: true });
    writePid(pidFile);
    const result = checkDaemon(pidFile);
    expect(result.running).toBe(true);
    expect(result.pid).toBe(process.pid);
  });

  it('checkDaemon cleans up stale PID file', () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(pidFile, '99999', 'utf-8');
    const result = checkDaemon(pidFile);
    expect(result.running).toBe(false);
    expect(result.pid).toBeNull();
    // PID file should be removed
    expect(readPid(pidFile)).toBeNull();
  });

  it('removePid handles missing file gracefully', () => {
    expect(() => removePid(pidFile)).not.toThrow();
  });
});
