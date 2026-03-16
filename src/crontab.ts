import { Cron } from 'croner';
import { readFile } from 'node:fs/promises';

export interface CronJob {
  schedule: string;
  command: string;
  cron: Cron;
}

/** Check if a date (floored to the minute) matches a cron schedule. */
export function cronMatchDate(cron: Cron, date: Date): boolean {
  const prev = new Date(date.getTime() - 60_000);
  const next = cron.nextRun(prev);
  if (!next) return false;
  return next.getTime() === date.getTime();
}

export function parseCrontab(content: string): CronJob[] {
  const jobs: CronJob[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // Split into 5 cron fields + command (everything after field 5)
    const parts = line.split(/\s+/);
    if (parts.length < 6) {
      console.warn(`crond-js: skipping malformed line: ${line}`);
      continue;
    }

    const schedule = parts.slice(0, 5).join(' ');
    const command = parts.slice(5).join(' ');

    try {
      const cron = new Cron(schedule, { paused: true });
      jobs.push({ schedule, command, cron });
    } catch {
      console.warn(`crond-js: skipping invalid schedule "${schedule}": ${line}`);
    }
  }
  return jobs;
}

export async function readCrontab(path: string): Promise<CronJob[]> {
  const content = await readFile(path, 'utf-8');
  return parseCrontab(content);
}
