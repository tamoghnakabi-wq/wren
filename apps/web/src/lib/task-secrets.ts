// Secrets the user gave a task when its agent asked (task.request_secret, migration 0017). Each is encrypted
// for the account (lib/crypto.ts), kept for SECRET_TTL_MS, handed to the task's commands as an environment
// variable (cloud ticks here, desktop runs through the device API), and blanked out of everything the task
// saves (DbRunStore and finishRun call `scrubForSession`). Never sent to a browser.

import { scrubSecrets, SECRET_MAX_CHARS, SECRET_MIN_CHARS, SECRET_TTL_MS, secretNameProblem, type TaskSecret } from '@wren/core';
import { HttpError } from './auth';
import { decryptSecret, encryptSecret } from './crypto';
import { db, type Json } from './db';
import { kickRun, taskTx } from './runs';

/** The task's secrets that haven't expired (one that can't be decrypted is left out). */
export async function loadTaskSecrets(sessionId: string, userId: string): Promise<TaskSecret[]> {
  const rows = await db()`select name, ciphertext from public.task_secrets where session_id = ${sessionId} and user_id = ${userId} and expires_at > now() order by name`;
  const out: TaskSecret[] = [];
  for (const r of rows) {
    try {
      out.push({ name: String(r.name), value: decryptSecret(String(r.ciphertext), userId) });
    } catch {
      /* written with another key: as good as gone */
    }
  }
  return out;
}

/** `data` with the task's secrets blanked out; reads them once per `cache` (one per store or request). */
export async function scrubForSession<T>(data: T, sessionId: string, userId: string, cache?: { secrets?: Promise<TaskSecret[]> }): Promise<T> {
  const secrets = await (cache ? (cache.secrets ??= loadTaskSecrets(sessionId, userId)) : loadTaskSecrets(sessionId, userId));
  return scrubSecrets(data, secrets);
}

/**
 * The user's answer to a secret card: the value, saved for the task, or a refusal. Written on the asking step
 * (`secretAnswer`), which the agent loop reads when the run carries on; a run waiting for it is woken. Only
 * for a step of this account's task that is still waiting for this answer.
 */
export async function answerSecret(userId: string, sessionId: string, eventId: string, answer: { value: string } | { decline: true }): Promise<{ ok: true }> {
  const value = 'value' in answer ? answer.value.trim() : null;
  if (value !== null && (value.length < SECRET_MIN_CHARS || value.length > SECRET_MAX_CHARS)) {
    throw new HttpError(400, `A secret here is ${SECRET_MIN_CHARS} to ${SECRET_MAX_CHARS.toLocaleString('en-US')} characters.`, 'invalid');
  }
  const r = await taskTx(async (tx) => {
    // The task's lock first, as finishRun takes it: a run switching to "waiting" sees this answer, or waits.
    await tx`select id from public.sessions where id = ${sessionId} and user_id = ${userId} for no key update`;
    const [ev] = await tx`select id, run_id, status, data from public.events where id = ${eventId} and session_id = ${sessionId} and user_id = ${userId} and type = 'tool' for update`;
    if (!ev || (ev.data as { name?: unknown }).name !== 'task.request_secret') throw new HttpError(404, 'That request isn’t in this task.', 'not_found');
    if (ev.status !== 'awaiting_secret' || (ev.data as { secretAnswer?: unknown }).secretAnswer) throw new HttpError(409, 'That request was already answered, or the task moved on.', 'conflict');
    const name = String((ev.data as { args?: { name?: unknown } }).args?.name ?? '');
    if (secretNameProblem(name)) throw new HttpError(400, 'That request names no usable variable.', 'invalid');
    if (value !== null) {
      const ciphertext = encryptSecret(value, userId);
      await tx`insert into public.task_secrets (user_id, session_id, name, ciphertext, expires_at)
        values (${userId}, ${sessionId}, ${name}, ${ciphertext}, now() + make_interval(secs => ${SECRET_TTL_MS / 1000}))
        on conflict (session_id, name) do update set ciphertext = excluded.ciphertext, created_at = now(), expires_at = excluded.expires_at`;
    }
    await tx`update public.events set data = data || ${tx.json({ secretAnswer: value !== null ? 'saved' : 'declined' } as Json)} where id = ${eventId}`;
    const [run] = await tx`update public.runs set status = 'queued' where id = ${ev.run_id} and status = 'waiting' returning id`;
    if (run) await tx`update public.sessions set status = 'queued' where id = ${sessionId}`;
    return { runId: String(ev.run_id), kick: !!run };
  });
  if (r.kick) await kickRun(r.runId);
  return { ok: true };
}

/** Deletes one of the task's secrets now (the card's Remove). */
export async function removeSecret(userId: string, sessionId: string, name: string): Promise<void> {
  await db()`delete from public.task_secrets where session_id = ${sessionId} and user_id = ${userId} and name = ${name}`;
}
