import type { MessageData, SessionEvent } from '@wren/core';

const ENGINE_SOURCES = new Set(['claude-code', 'grok-build']);

/**
 * What the user said that a CLI engine hasn't been given yet: messages after the last turn's
 * cursor (the newest event it had seen), or after an answer from Wren's own agent, which reads
 * the whole conversation. Several can arrive while an engine works; they all go in one prompt.
 */
export function pendingAsks(events: SessionEvent[]): SessionEvent[] {
  const msg = (e: SessionEvent) => (e.type === 'message' ? (e.data as MessageData) : null);
  const answered = (e: SessionEvent) => msg(e)?.role === 'assistant' && e.status === 'done';
  const cursor = [...events].reverse().find((e) => e.type === 'reasoning' && typeof (e.data as { consumedSeq?: unknown }).consumedSeq === 'number');
  // Sessions from before the cursor existed: everything after the last answer.
  const lastAnswer = [...events].reverse().find(answered);
  const lastOwnAnswer = [...events].reverse().find((e) => answered(e) && !ENGINE_SOURCES.has(msg(e)?.source ?? ''));
  const after = Math.max(cursor ? (cursor.data as { consumedSeq: number }).consumedSeq : (lastAnswer?.seq ?? -1), lastOwnAnswer?.seq ?? -1);
  return events.filter((e) => msg(e)?.role === 'user' && (e.seq ?? 0) > after);
}
