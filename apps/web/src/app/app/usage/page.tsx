'use client';

import { ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AgentAvatar } from '@/components/agent-avatar';
import { useApp } from '@/components/app/provider';
import { Card, formatTokens, PageHeader, Skeleton } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useLive } from '@/lib/client/live';
import { sourceInfo } from '@/lib/client/sources';

/** One day × agent × source × model, summed by /api/usage. */
interface UsageRow {
  day: string;
  agent_id: string | null;
  source: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  calls: number;
}

const BILLED_BY: Record<string, string> = {
  chatgpt: 'Your ChatGPT plan',
  openai: 'OpenAI API (your key)',
  anthropic: 'Anthropic API (your key)',
  xai: 'xAI API (your key)',
  gateway: 'Vercel AI Gateway (your key)',
  platform: 'Wren credits',
  local: 'Local model (free)',
  'claude-code': 'Your Claude plan',
  'grok-build': 'Your Grok plan',
  test: 'Test model',
};

const fmtDay = (d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function UsagePage() {
  const { userId, agentById } = useApp();
  // The newest usage row (live) only tells us when to re-fetch the totals.
  const latest = useLive<{ id: string }>({ table: 'usage_records', select: 'id', eq: { user_id: userId }, order: { column: 'created_at' }, limit: 1, realtimeFilter: { column: 'user_id', value: userId } });
  const [recent, setRecent] = useState<UsageRow[] | null>(null);
  const changeKey = latest.rows.map((r) => r.id).join();
  useEffect(() => {
    let live = true;
    api<{ rows: UsageRow[] }>('/api/usage')
      .then((r) => live && setRecent(r.rows))
      .catch(() => live && setRecent((cur) => cur ?? []));
    return () => {
      live = false;
    };
  }, [changeKey]);
  const rows = { loading: recent === null };

  // "Today" as of when the page opened (read once, not on every render).
  const [now] = useState(() => Date.now());
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 29; i >= 0; i--) m.set(new Date(now - i * 86400_000).toISOString().slice(0, 10), 0);
    for (const r of recent ?? []) {
      const k = r.day;
      if (m.has(k)) m.set(k, m.get(k)! + r.input_tokens + r.output_tokens);
    }
    return [...m.entries()];
  }, [recent, now]);
  const peak = byDay.reduce((p, d) => (d[1] > p[1] ? d : p), ['', 0] as [string, number]);
  const max = Math.max(1, ...byDay.map(([, v]) => v));
  const group = (key: (r: UsageRow) => string) => {
    const m = new Map<string, { input: number; output: number; cached: number; calls: number }>();
    for (const r of recent ?? []) {
      const k = key(r);
      const cur = m.get(k) ?? { input: 0, output: 0, cached: 0, calls: 0 };
      cur.input += r.input_tokens;
      cur.output += r.output_tokens;
      cur.cached += r.cached_tokens;
      cur.calls += r.calls;
      m.set(k, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
  };
  const list = recent ?? [];
  const total = list.reduce((n, r) => n + r.input_tokens + r.output_tokens, 0);

  if (rows.loading)
    return (
      <div aria-busy="true">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="mt-2 mb-6 h-4 w-96 max-w-full" />
        <div className="grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="mt-4 h-52 rounded-2xl" />
      </div>
    );
  return (
    <div>
      <PageHeader title="Usage" subtitle="Model usage by your agents over the last 30 days. Each provider bills you directly; Wren adds nothing on top." />
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Tokens (30 days)" value={formatTokens(total)} />
        <Stat label="Model calls" value={String(list.reduce((n, r) => n + r.calls, 0))} />
        <Stat label="Cached input" value={formatTokens(list.reduce((n, r) => n + r.cached_tokens, 0))} />
      </div>

      <Card className="mt-4 p-5">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">Daily tokens</p>
          {peak[1] > 0 && <p className="text-[12px] text-faint">Busiest: {fmtDay(peak[0])} · {formatTokens(peak[1])}</p>}
        </div>
        <div
          className="flex h-32 items-end gap-[3px]"
          role="img"
          aria-label={`Tokens per day over the last ${byDay.length} days. Total ${formatTokens(byDay.reduce((n, [, v]) => n + v, 0))}${peak[1] ? `, busiest day ${fmtDay(peak[0])} with ${formatTokens(peak[1])}` : ''}.`}
        >
          {byDay.map(([d, v]) => (
            <div key={d} className="group relative flex-1">
              <div className="w-full rounded-t-[3px] bg-brand/80 transition group-hover:bg-brand" style={{ height: `${Math.max(v ? 3 : 1, (v / max) * 120)}px`, opacity: v ? 1 : 0.25 }} />
              <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md bg-primary px-2 py-1 text-[11px] whitespace-nowrap text-primary-fg group-hover:block">
                {new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: {formatTokens(v)}
              </span>
            </div>
          ))}
        </div>
        {byDay.length > 0 && (
          <div className="mt-2 flex justify-between text-[11px] text-faint tabular-nums" aria-hidden>
            <span>{fmtDay(byDay[0][0])}</span>
            <span>Today</span>
          </div>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <p className="mb-3 text-sm font-medium">By how it’s paid</p>
          <ul className="space-y-2.5">
            {group((r) => r.source).map(([k, v]) => (
              <li key={k} className="flex items-center justify-between text-sm">
                <span>
                  {BILLED_BY[k] ?? sourceInfo(k)?.label ?? k}
                  {k === 'chatgpt' && (
                    <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-0.5 text-[12px] text-muted underline">
                      Manage usage <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </span>
                <span className="text-muted tabular-nums">{formatTokens(v.input + v.output)}</span>
              </li>
            ))}
            {!list.length && <li className="text-sm text-muted">No usage yet.</li>}
          </ul>
        </Card>
        <Card className="p-5">
          <p className="mb-3 text-sm font-medium">By agent</p>
          <ul className="space-y-2.5">
            {group((r) => r.agent_id ?? '').map(([k, v]) => {
              const a = agentById(k);
              return (
                <li key={k} className="flex items-center gap-2 text-sm">
                  <AgentAvatar icon={a?.icon} color={a?.color} size={22} still />
                  <span className="flex-1 truncate">{a?.name ?? 'Deleted agent'}</span>
                  <span className="text-muted tabular-nums">{formatTokens(v.input + v.output)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
        <Card className="p-5 lg:col-span-2">
          <p className="mb-3 text-sm font-medium">By model</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[12px] text-faint">
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 text-right font-medium">Calls</th>
                  <th className="pb-2 text-right font-medium">Input</th>
                  <th className="pb-2 text-right font-medium">Output</th>
                </tr>
              </thead>
              <tbody>
                {group((r) => r.model).map(([k, v]) => (
                  <tr key={k} className="border-t border-border">
                    <td className="py-2 font-mono text-[12.5px]">{k}</td>
                    <td className="py-2 text-right tabular-nums">{v.calls}</td>
                    <td className="py-2 text-right tabular-nums">{formatTokens(v.input)}</td>
                    <td className="py-2 text-right tabular-nums">{formatTokens(v.output)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[12px] text-faint">Claude Code and Grok Build runs report usage to their own apps; their token counts aren’t visible to Wren.</p>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-5">
      <p className="text-[13px] text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}
