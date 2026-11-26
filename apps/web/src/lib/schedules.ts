import { CronExpressionParser } from 'cron-parser';
import type { ScheduleRequest, ScheduleResult } from '@wren/core';
import { z } from 'zod';
import { HttpError } from './auth';
import { db } from './db';

// Schedules use standard 5-field cron expressions evaluated in the user's
// timezone. The UI offers friendly presets that compile to cron. A schedule can
// instead run once (`run_at`, migration 0017): set by the user, or by an agent
// with the user's approval (task.schedule). The cron deletes a one-off schedule
// once its task has started.

/** Schedules an account can have. */
export const MAX_SCHEDULES = 50;
/** A one-off schedule starts at least this far ahead, and at most a year ahead. */
const RUN_AT_MIN_MS = 60_000;
const RUN_AT_MAX_MS = 366 * 86_400_000;

/** Checks a one-off schedule's time. */
export function validateRunAt(at: Date, now = new Date()): void {
  if (!Number.isFinite(at.getTime())) throw new HttpError(400, 'That isn’t a date and time Wren understands.', 'invalid');
  if (at.getTime() < now.getTime() + RUN_AT_MIN_MS) throw new HttpError(400, 'Pick a time at least a minute from now.', 'invalid');
  if (at.getTime() > now.getTime() + RUN_AT_MAX_MS) throw new HttpError(400, 'Pick a time within a year from now.', 'invalid');
}

/**
 * An agent's `when` (task.schedule): ISO 8601 with a UTC offset or Z, so it can't be read in the wrong time
 * zone; null when it isn't one.
 */
export function parseWhen(when: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i.test(when.trim())) return null;
  const at = new Date(when.trim());
  return Number.isFinite(at.getTime()) ? at : null;
}

export interface NewSchedule {
  userId: string;
  agentId: string;
  name: string;
  prompt: string;
  cron: string | null;
  runAt: Date | null;
  timezone: string;
  enabled: boolean;
  /** The task an agent set it in (task.schedule). */
  sourceSessionId?: string;
}

/** Adds a schedule, counted under the account's lock so creating several at once can't pass the limit. */
export async function insertSchedule(n: NewSchedule) {
  const next = !n.enabled ? null : n.runAt ?? nextRun(n.cron!, n.timezone);
  const row = await db().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${'wren-schedules:' + n.userId}))`;
    if (n.sourceSessionId && n.runAt) {
      // The same request again from the same task (a call run again after a crash) finds the one it set.
      const [same] = await tx`select * from public.schedules where user_id = ${n.userId} and source_session_id = ${n.sourceSessionId} and run_at = ${n.runAt} and prompt = ${n.prompt}`;
      if (same) return same;
    }
    const [c] = await tx`select count(*)::int as n from public.schedules where user_id = ${n.userId}`;
    if (c.n >= MAX_SCHEDULES) return null;
    const [r] = await tx`
      insert into public.schedules (user_id, agent_id, name, prompt, cron, run_at, timezone, enabled, next_run_at, source_session_id)
      values (${n.userId}, ${n.agentId}, ${n.name}, ${n.prompt}, ${n.cron}, ${n.runAt}, ${n.timezone}, ${n.enabled}, ${next}, ${n.sourceSessionId ?? null})
      returning *`;
    return r;
  });
  if (!row) throw new HttpError(400, `You can have up to ${MAX_SCHEDULES} schedules.`, 'limit');
  return row;
}

/** An agent's task.schedule, approved by the user: a one-off schedule for this agent, from this task. */
export async function createReminder(r: { userId: string; agentId: string; sessionId: string } & ScheduleRequest): Promise<ScheduleResult> {
  const sql = db();
  const [p] = await sql`select timezone from public.profiles where id = ${r.userId}`;
  const timezone = knownTimeZone(String(p?.timezone ?? '')) ? String(p!.timezone) : 'UTC';
  const at = parseWhen(r.when);
  if (!at) return { error: `“${r.when.slice(0, 64)}” isn’t a date and time with its UTC offset. Give one like 2026-11-27T17:00:00+11:00 (the user’s time zone is ${timezone}).` };
  const prompt = r.task.trim().slice(0, 8000);
  const name = (r.title?.trim() || prompt.split('\n')[0]).slice(0, 80);
  if (!prompt) return { error: 'Say what the task is.' };
  try {
    validateRunAt(at);
    const row = await insertSchedule({ userId: r.userId, agentId: r.agentId, name, prompt, cron: null, runAt: at, timezone, enabled: true, sourceSessionId: r.sessionId });
    return { id: String(row.id), at: formatAt(at, timezone), name: String(row.name) };
  } catch (e) {
    if (e instanceof HttpError) return { error: e.message };
    throw e;
  }
}

/** A time as the user reads it, in their time zone ("Thursday, 27 November 2026 at 5:00 pm (Australia/Melbourne)"). */
export function formatAt(at: Date, timezone: string): string {
  try {
    return `${at.toLocaleString('en-AU', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' })} (${timezone})`;
  } catch {
    return at.toISOString();
  }
}

export function nextRun(cron: string, timezone: string, from = new Date()): Date {
  try {
    const it = CronExpressionParser.parse(cron, { tz: timezone, currentDate: from });
    return it.next().toDate();
  } catch (e) {
    throw new HttpError(400, `Invalid schedule: ${(e as Error).message}`, 'invalid');
  }
}

/** Schedules run at most this often. */
const MIN_GAP_MS = 15 * 60 * 1000;

/** Whether this is a time zone the server knows (cron-parser reports an unknown one as "unhandled timestamp"). */
export function knownTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return !!timezone;
  } catch {
    return false;
  }
}

export function validateCron(cron: string, timezone: string, from = new Date()) {
  if (!knownTimeZone(timezone)) throw new HttpError(400, 'Unknown time zone.', 'invalid');
  if (cron.trim().split(/\s+/).length !== 5) throw new HttpError(400, 'Use a 5-field cron expression (minute hour day month weekday).', 'invalid');
  // Every gap over the coming year, not just the next one: "0,1 0,12 * * *" looks like twice a
  // day from just after midnight, but runs at 12:00 and again at 12:01.
  nextRun(cron, timezone, from); // reports an invalid expression
  const it = CronExpressionParser.parse(cron, { tz: timezone, currentDate: from });
  let prev = it.next().getTime();
  const end = prev + 400 * 86_400_000;
  for (let i = 0; i < 6000 && prev < end; i++) {
    const next = it.next().getTime();
    if (next - prev < MIN_GAP_MS) throw new HttpError(400, 'Schedules can run at most every 15 minutes.', 'invalid');
    prev = next;
  }
}

/**
 * When a schedule runs next, having just started for the occurrence `slot`: the first occurrence
 * at least 15 minutes after that slot and after this start (allowing a minute for the cron's own
 * delay). Enforced here as well as when saving, so starts never bunch up, even after an outage.
 */
export function nextRunAfter(cron: string, timezone: string, slot: Date, now = new Date()): Date {
  return nextRun(cron, timezone, new Date(Math.max(slot.getTime(), now.getTime() - 60_000) + MIN_GAP_MS - 1000));
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

/** A repeating schedule has `cron`; a one-off one has `runAt` (ISO 8601). */
export const ScheduleSchema = z
  .object({
    agentId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(8000),
    cron: z.string().trim().max(100).optional(),
    runAt: z.string().datetime({ offset: true }).optional(),
    timezone: z.string().max(64).default('UTC'),
    enabled: z.boolean().default(true),
  })
  .refine((b) => !b.cron !== !b.runAt, { message: 'Give either a repeat (cron) or a time (runAt).' });

/** `cron` makes it repeat and `runAt` makes it run once (the other is cleared). */
export const SchedulePatchSchema = z
  .object({
    agentId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    prompt: z.string().trim().min(1).max(8000).optional(),
    cron: z.string().trim().max(100).optional(),
    runAt: z.string().datetime({ offset: true }).optional(),
    timezone: z.string().max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => !(b.cron && b.runAt), { message: 'Give a repeat (cron) or a time (runAt), not both.' });
