import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { HttpError } from './auth';

// Schedules use standard 5-field cron expressions evaluated in the user's
// timezone. The UI offers friendly presets that compile to cron.

export function nextRun(cron: string, timezone: string, from = new Date()): Date {
  try {
    const it = CronExpressionParser.parse(cron, { tz: timezone, currentDate: from });
    return it.next().toDate();
  } catch (e) {
    throw new HttpError(400, `Invalid schedule: ${(e as Error).message}`, 'invalid');
  }
}

export function validateCron(cron: string, timezone: string) {
  if (cron.trim().split(/\s+/).length !== 5) throw new HttpError(400, 'Use a 5-field cron expression (minute hour day month weekday).', 'invalid');
  const a = nextRun(cron, timezone);
  const b = nextRun(cron, timezone, a);
  if (b.getTime() - a.getTime() < 15 * 60 * 1000) throw new HttpError(400, 'Schedules can run at most every 15 minutes.', 'invalid');
}

export function describeCron(cron: string): string {
  const [m, h, dom, mon, dow] = cron.split(/\s+/);
  const time = /^\d+$/.test(h) && /^\d+$/.test(m) ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (time && dom === '*' && mon === '*') {
    if (dow === '*') return `Every day at ${time}`;
    if (dow === '1-5') return `Weekdays at ${time}`;
    if (dow === '0,6' || dow === '6,0') return `Weekends at ${time}`;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    if (/^\d$/.test(dow)) return `Every ${days[Number(dow)]} at ${time}`;
  }
  if (time && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `Monthly on day ${dom} at ${time}`;
  if (m === '0' && h.startsWith('*/')) return `Every ${h.slice(2)} hours`;
  if (h === '*' && /^\d+$/.test(m)) return `Every hour at :${m.padStart(2, '0')}`;
  return cron;
}

export const ScheduleSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(8000),
  cron: z.string().trim().max(100),
  timezone: z.string().max(64).default('UTC'),
  enabled: z.boolean().default(true),
});

export const SchedulePatchSchema = z.object({
  agentId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80).optional(),
  prompt: z.string().trim().min(1).max(8000).optional(),
  cron: z.string().trim().max(100).optional(),
  timezone: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
});
