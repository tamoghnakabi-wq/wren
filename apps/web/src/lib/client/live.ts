'use client';

import { useEffect, useRef, useState } from 'react';
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
}

type Row = Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useLive<T extends object = any>(o: LiveOptions): { rows: T[]; loading: boolean; error: string | null; reload: () => void } {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(o);
  const optsRef = useRef(o);
  optsRef.current = o;

  useEffect(() => {
    const opts = optsRef.current;
    if (opts.enabled === false) {
      setLoading(false);
      return;
    }
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

    const load = async () => {
      let q = sb.from(opts.table).select(opts.select ?? '*');
      for (const [k, v] of Object.entries(opts.eq ?? {})) if (v !== undefined) q = v === null ? q.is(k, null) : q.eq(k, v);
      for (const k of Object.keys(opts.is ?? {})) q = q.is(k, null);
      if (opts.inList) q = q.in(opts.inList.column, opts.inList.values);
      if (opts.order) q = q.order(opts.order.column, { ascending: !!opts.order.ascending });
      if (opts.limit) q = q.limit(opts.limit);
      const { data, error } = await q;
      if (cancelled) return;
      if (error) setError(error.message);
      else {
        setRows((data ?? []) as unknown as T[]);
        setError(null);
      }
      setLoading(false);
    };

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

  return { rows, loading, error, reload: () => setNonce((n) => n + 1) };
}
