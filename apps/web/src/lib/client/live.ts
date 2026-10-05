'use client';

import { useEffect, useState } from 'react';
import { coalesce } from './coalesce';
import { supabase } from './supabase';

// Reads rows the user owns straight from Postgres (RLS) and keeps them fresh
// with Realtime postgres_changes. Rows are merged by primary key `pk`.

export interface LiveOptions {
  table: string;
  select?: string;
  eq?: Record<string, string | null | undefined>;
  is?: Record<string, null>;
  inList?: { column: string; values: string[] };
  order?: { column: string; ascending?: boolean };
  limit?: number;
  pk?: string;
  /** Realtime filter column (one equality, Supabase limitation). */
  realtimeFilter?: { column: string; value: string };
  enabled?: boolean;
  /**
   * Rows are only ever added (the limit applies to each load, not to what is kept), and a reload
   * whose newest page doesn't reach what is already kept also fetches the rows in between (by the
   * order column), so a growing list like a task timeline never develops a hole.
   */
  keepAll?: boolean;
}

type Row = Record<string, unknown>;

/** Rows per request when filling a gap in a keepAll list. */
const GAP_PAGE = 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useLive<T extends object = any>(o: LiveOptions): { rows: T[]; loading: boolean; error: string | null; reload: () => void } {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(o);

  useEffect(() => {
    // The options are plain data, so the effect reads them back from the key it depends on.
    const opts = JSON.parse(key) as LiveOptions;
    if (opts.enabled === false) return; // reported as not loading below
    const sb = supabase();
    const pk = opts.pk ?? 'id';
    type R = Record<string, unknown>;
    let cancelled = false;
    const matches = (r: Row) => {
      for (const [k, v] of Object.entries(opts.eq ?? {})) if (v !== undefined && r[k] !== v) return false;
      for (const k of Object.keys(opts.is ?? {})) if (r[k] !== null && r[k] !== undefined) return false;
      if (opts.inList && !opts.inList.values.includes(String(r[opts.inList.column]))) return false;
      return true;
    };
    const sortRows = (list: T[]) => {
      if (!opts.order) return list;
      const { column, ascending = false } = opts.order;
      return [...list].sort((a, b) => {
        const x = (a as Record<string, unknown>)[column] as string | number;
        const y = (b as Record<string, unknown>)[column] as string | number;
        if (x === y) return 0;
        return (x > y ? 1 : -1) * (ascending ? 1 : -1);
      });
    };

    // keepAll: everything seen for this subscription, by primary key.
    const kept = new Map<unknown, T>();
    // keepAll: how far (by the order column) fetched pages reach without a hole. Rows that came in
    // over realtime don't count: there can be missed rows just below them.
    let fetchedTop: number | string | undefined;
    const keep = (list: T[]) => {
      for (const r of list) kept.set((r as R)[pk], r);
      setRows(sortRows([...kept.values()]));
    };
    const query = () => {
      let q = sb.from(opts.table).select(opts.select ?? '*');
      for (const [k, v] of Object.entries(opts.eq ?? {})) if (v !== undefined) q = v === null ? q.is(k, null) : q.eq(k, v);
      for (const k of Object.keys(opts.is ?? {})) q = q.is(k, null);
      if (opts.inList) q = q.in(opts.inList.column, opts.inList.values);
      return q;
    };

    // One load at a time (initial, after subscribing, after the tab comes back): an older response
    // can't land after a newer one and leave rows in between unfetched.
    const load = coalesce(async () => {
      let q = query();
      if (opts.order) q = q.order(opts.order.column, { ascending: !!opts.order.ascending });
      if (opts.limit) q = q.limit(opts.limit);
      const { data, error } = await q;
      if (cancelled) return;
      if (error) setError(error.message);
      else if (opts.keepAll && opts.order && opts.limit && (data ?? []).length) {
        const col = opts.order.column;
        const val = (r: unknown) => (r as R)[col] as number | string;
        const page = data as unknown as T[];
        const pageNewest = page.reduce((m, r) => (val(r) > m ? val(r) : m), val(page[0]));
        const pageOldest = page.reduce((m, r) => (val(r) < m ? val(r) : m), val(page[0]));
        // A full newest page that starts above what was fetched before leaves rows in between
        // (many arrived while the socket was down): fetch all of them, a page at a time.
        const gap: T[] = [];
        if (fetchedTop !== undefined && page.length >= opts.limit && pageOldest > fetchedTop) {
          let from = fetchedTop;
          for (;;) {
            const r = await query().gt(col, from).lt(col, pageOldest).order(col, { ascending: true }).limit(GAP_PAGE);
            if (cancelled) return;
            if (r.error) {
              // Keep what arrived; the hole above `from` is fetched again on the next load.
              keep([...gap, ...page]);
              fetchedTop = from;
              setError(r.error.message);
              setLoading(false);
              return;
            }
            const rows = (r.data ?? []) as unknown as T[];
            gap.push(...rows);
            if (rows.length < GAP_PAGE) break;
            from = val(rows[rows.length - 1]);
          }
        }
        keep([...gap, ...page]);
        fetchedTop = fetchedTop === undefined || pageNewest > fetchedTop ? pageNewest : fetchedTop;
        setError(null);
      } else {
        if (opts.keepAll) keep((data ?? []) as unknown as T[]);
        else setRows((data ?? []) as unknown as T[]);
        setError(null);
      }
      setLoading(false);
    });

    let channel: ReturnType<typeof sb.channel> | null = null;
    // Realtime applies RLS with the socket's token, so attach the session first.
    (async () => {
      const { data } = await sb.auth.getSession();
      if (data.session) await sb.realtime.setAuth(data.session.access_token);
      if (cancelled) return;
      channel = sb
        .channel(`live:${opts.table}:${Math.random().toString(36).slice(2)}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: opts.table, ...(opts.realtimeFilter ? { filter: `${opts.realtimeFilter.column}=eq.${opts.realtimeFilter.value}` } : {}) },
          (payload) => {
            if (opts.keepAll) {
              if (payload.eventType === 'DELETE') {
                kept.delete((payload.old as Row)[pk]);
                setRows(sortRows([...kept.values()]));
              } else if (matches(payload.new as R)) {
                const row = payload.new as T;
                const old = kept.get((row as R)[pk]);
                keep([old ? ({ ...old, ...row } as T) : row]);
              }
              return;
            }
            setRows((prev) => {
              if (payload.eventType === 'DELETE') return prev.filter((r) => (r as R)[pk] !== (payload.old as Row)[pk]);
              const row = payload.new as T;
              const exists = prev.some((r) => (r as R)[pk] === (row as R)[pk]);
              if (!matches(row as R)) return exists ? prev.filter((r) => (r as R)[pk] !== (row as R)[pk]) : prev;
              const next = exists ? prev.map((r) => ((r as R)[pk] === (row as R)[pk] ? { ...r, ...row } : r)) : [...prev, row];
              const sorted = sortRows(next);
              return opts.limit && sorted.length > opts.limit && !opts.order?.ascending ? sorted.slice(0, opts.limit) : sorted;
            });
          },
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') load();
        });
    })();
    // Catch up after the tab was hidden (mobile browsers drop sockets).
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    load();
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (channel) sb.removeChannel(channel);
    };
  }, [key, nonce]);

  return { rows, loading: o.enabled === false ? false : loading, error, reload: () => setNonce((n) => n + 1) };
}
