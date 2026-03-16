import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Logger {
  log(tag: string, detail: string): void;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dateSlug(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function createLogger(logDir: string, foreground: boolean): Logger {
  const pid = process.pid;

  return {
    log(tag: string, detail: string) {
      const line = `${timestamp()} crond-js[${pid}]: ${tag} (${detail})\n`;

      if (foreground) {
        process.stdout.write(line);
      }

      mkdirSync(logDir, { recursive: true });

      const logFile = join(logDir, `${dateSlug()}.log`);
      appendFileSync(logFile, line);
    },
  };
}
