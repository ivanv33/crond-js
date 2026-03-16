import { describe, it, expect, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const tmpDir = join(import.meta.dirname, '../../tmp/test-logger');

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createLogger', () => {
  it('writes a log line matching crond format', () => {
    const logger = createLogger(tmpDir, false);
    logger.log('CMD', './run.sh');

    const files = readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.log$/);

    const content = readFileSync(join(tmpDir, files[0]), 'utf-8');
    const lineRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} crond-js\[\d+\]: CMD \(\.\/run\.sh\)$/m;
    expect(content).toMatch(lineRegex);
  });

  it('creates the log directory recursively', () => {
    const nested = join(tmpDir, 'deep/nested');
    const logger = createLogger(nested, false);
    logger.log('STARTUP', 'crond-js 1.0.0');

    const files = readdirSync(nested);
    expect(files).toHaveLength(1);
  });

  it('re-creates the log directory if deleted while running', () => {
    const logger = createLogger(tmpDir, false);
    logger.log('CMD', './first.sh');

    // Simulate the log directory being deleted externally
    rmSync(tmpDir, { recursive: true, force: true });

    // Second write should NOT throw — directory should be re-created
    expect(() => logger.log('CMD', './second.sh')).not.toThrow();

    const files = readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    const content = readFileSync(join(tmpDir, files[0]), 'utf-8');
    expect(content).toContain('./second.sh');
  });

  it('appends multiple log lines to the same file', () => {
    const logger = createLogger(tmpDir, false);
    logger.log('CMD', './a.sh');
    logger.log('CMDEND', './a.sh');

    const files = readdirSync(tmpDir);
    const content = readFileSync(join(tmpDir, files[0]), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('CMD');
    expect(lines[1]).toContain('CMDEND');
  });
});
