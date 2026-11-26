'use client';

import { preloadLive, type LiveOptions } from './live';

// The live queries a task's page reads (app/app/s/[id]), in one place, so a list can load a task's data the
// moment the pointer rests on it (preloadTask) under exactly the keys the page then reads (useLive remembers
// rows by its options): the page opens with its conversation already there.

/** Events per page of task history. */
export const TASK_EVENTS_PAGE = 500;

export function taskQueries(id: string) {
  const live = { column: 'session_id', value: id };
  return {
    session: { table: 'sessions', eq: { id }, realtimeFilter: { column: 'id', value: id } },
    events: { table: 'events', eq: { session_id: id }, order: { column: 'seq', ascending: false }, limit: TASK_EVENTS_PAGE, keepAll: true, realtimeFilter: live },
    plan: { table: 'events', eq: { session_id: id, type: 'plan' }, order: { column: 'seq', ascending: false }, limit: 1, realtimeFilter: live },
    runs: { table: 'runs', eq: { session_id: id }, order: { column: 'created_at' }, limit: 20, realtimeFilter: live },
    live: { table: 'run_live', eq: { session_id: id }, pk: 'run_id', realtimeFilter: live },
    files: { table: 'artifacts', eq: { session_id: id }, order: { column: 'created_at' }, realtimeFilter: live },
  } satisfies Record<string, LiveOptions>;
}

/** Loads a task's data ahead of a click (once per task within a short while; the page loads it again anyway). */
export function preloadTask(id: string): void {
  for (const q of Object.values(taskQueries(id))) void preloadLive(q);
}
