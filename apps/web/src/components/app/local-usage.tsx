'use client';

import { RotateCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, EmptyState, formatTokens, Skeleton } from '@/components/ui';
import { AppLogo } from './app-logo';
import type { LimitWindow, LocalApp, LocalUsageReport, PlanLimitsReport, WrenDesktop } from '@/lib/client/desktop';
import { cx } from '@/lib/cx';
import { appLabel, formatUsd, LOCAL_APPS, summarize, type Amount, type LocalSummary } from '@/lib/local-usage';
import type { PriceTable } from '@/lib/model-prices';
import { limitPace, paceText, whenText } from '@/lib/plan-limits';
import { dayLabel } from '@/lib/usage-days';

// Usage → This Mac: what the other AI apps on this computer used, read by the desktop app from their own
// logs (window.wren.localUsage). It never leaves the computer: the page prices it here. Desktop 0.1.54+ also
// says how much of each app's plan limits is used (window.wren.planLimits), as the app itself reports it: the
// Limits view beside Tokens and Cost (as T3 Code has it), asked only while that view is open.

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];
type Measure = 'tokens' | 'cost' | 'limits';
/** Each app keeps one shade of ink: colour on Wren's screens is the agents' own. */
const SHADE: Record<LocalApp, string> = { 'claude-code': 'bg-text', codex: 'bg-text/65', antigravity: 'bg-text/42', 'grok-build': 'bg-text/28', opencode: 'bg-text/16' };
const RANGE_KEY = 'wren-local-usage-range';
const SHOW_KEY = 'wren-local-usage-show';

function storedRange(): Range {
  try {
    const n = Number(localStorage.getItem(RANGE_KEY));
    return (RANGES as readonly number[]).includes(n) ? (n as Range) : 30;
  } catch {
    return 30;
  }
}

function storedMeasure(): Measure {
  try {
    const m = localStorage.getItem(SHOW_KEY);
    return m === 'cost' || m === 'limits' ? m : 'tokens';
  } catch {
    return 'tokens';
  }
}

/** Asks the desktop for its plan limits (0.1.54+; older ones can't), keeping the last answer if one fails. */
function askLimits(bridge: Pick<WrenDesktop, 'planLimits'>, refresh: boolean, set: (f: (l: PlanLimitsReport | 'failed' | null) => PlanLimitsReport | 'failed' | null) => void) {
  return bridge.planLimits?.({ refresh }).then(
    (r) => set(() => r),
    () => set((l) => (l && l !== 'failed' ? l : 'failed')),
  );
}

export function LocalUsage({ bridge, place }: { bridge: Required<Pick<WrenDesktop, 'localUsage'>> & Pick<WrenDesktop, 'planLimits'>; place: string }) {
  const [report, setReport] = useState<LocalUsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(true);
  const [prices, setPrices] = useState<{ models: PriceTable; fetchedAt: string } | null | 'none'>(null);
  const [range, setRange] = useState<Range>(storedRange);
  const [measure, setMeasure] = useState<Measure>(storedMeasure);
  const [breakdown, setBreakdown] = useState<'model' | 'day'>('model');
  // null while the first ask is out; 'failed' when the desktop couldn't answer at all.
  const [limits, setLimits] = useState<PlanLimitsReport | 'failed' | null>(null);
  const [asking, setAsking] = useState(false);
  const limitsView = measure === 'limits' && !!bridge.planLimits;

  // Settles a read (the first one starts with `reading` already true).
  const settle = (p: Promise<LocalUsageReport>) =>
    p.then(
      (r) => (setReport(r), setError(null)),
      (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Reading usage failed.'),
    ).finally(() => setReading(false));
  const read = (refresh: boolean) => {
    setReading(true);
    void settle(bridge.localUsage({ refresh }));
  };
  // Each app is asked by running it (about a second), so only for the Limits view: when it's picked (the desktop
  // answers again from what it asked in the last minute), when the page opens on it, and on its refresh button.
  const ask = (refresh: boolean) => {
    setAsking(true);
    void Promise.resolve(askLimits(bridge, refresh, setLimits)).finally(() => setAsking(false));
  };
  useEffect(() => {
    let live = true;
    void settle(bridge.localUsage({ refresh: false }));
    if (storedMeasure() === 'limits') void askLimits(bridge, false, setLimits);
    fetch('/api/usage/prices')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { models?: PriceTable; fetchedAt?: string } | null) => live && setPrices(d?.models ? { models: d.models, fetchedAt: d.fetchedAt ?? '' } : 'none'))
      .catch(() => live && setPrices('none'));
    return () => {
      live = false;
    };
    // Once per bridge (once in practice): `settle` only sets state.
  }, [bridge]);
  const pickMeasure = (m: Measure) => {
    setMeasure(m);
    if (m === 'limits' && m !== measure) ask(false);
    try {
      localStorage.setItem(SHOW_KEY, m);
    } catch {
      /* remembered for this visit only */
    }
  };
  const pickRange = (r: Range) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, String(r));
    } catch {
      /* remembered for this visit only */
    }
  };

  const table = prices && prices !== 'none' ? prices.models : null;
  const s = useMemo(() => (report ? summarize(report, range, table) : null), [report, range, table]);
  const priced = table !== null;
  const showCost = measure === 'cost' && priced;
  const checked = (at: number | string) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const toolbar = (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {/* Limits are as they are now, so they have no range. */}
      {!limitsView && <Pills value={range} onChange={pickRange} items={RANGES.map((r) => ({ value: r, label: `${r} days` }))} label="Range" />}
      <span className="flex-1" />
      <div className="flex items-center gap-2">
        {/* Cost is listed while prices load too, so Limits doesn't move when they arrive. */}
        {(prices !== 'none' || bridge.planLimits) && (
          <Pills
            value={limitsView ? 'limits' : showCost ? 'cost' : 'tokens'}
            onChange={pickMeasure}
            items={[
              { value: 'tokens' as const, label: 'Tokens' },
              ...(prices !== 'none' ? [{ value: 'cost' as const, label: 'Cost' }] : []),
              ...(bridge.planLimits ? [{ value: 'limits' as const, label: 'Limits' }] : []),
            ]}
            label="Show"
          />
        )}
        {limitsView ? (
          <Button variant="ghost" size="sm" onClick={() => ask(true)} disabled={asking} aria-label="Check limits again" title={limits && limits !== 'failed' ? `Check again (last checked ${checked(limits.generatedAt)})` : 'Check again'}>
            <RotateCw className={cx('h-4 w-4', asking && 'animate-spin motion-reduce:animate-none')} />
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => read(true)} disabled={reading} aria-label="Read again" title={report ? `Read again (last read ${checked(report.generatedAt)})` : 'Read again'}>
            <RotateCw className={cx('h-4 w-4', reading && 'animate-spin motion-reduce:animate-none')} />
          </Button>
        )}
      </div>
    </div>
  );

  if (limitsView)
    return (
      <div>
        {toolbar}
        <PlanLimits limits={limits} place={place} onRetry={() => ask(true)} />
      </div>
    );
  if (error && !report)
    return (
      <div>
        {toolbar}
        <EmptyState title={`Couldn’t read usage on this ${place}`} action={<Button onClick={() => read(true)}>Try again</Button>}>
          {error}
        </EmptyState>
      </div>
    );
  if (!s)
    return (
      <div aria-busy="true">
        {toolbar}
        <p className="mb-4 text-sm text-muted" role="status">
          Reading the AI apps’ logs on this {place}… The first time takes a few seconds.
        </p>
        <Skeleton className="h-64 rounded-2xl" />
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-5 sm:gap-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  if (!s.apps.some((a) => a.found))
    return (
      <div>
        {toolbar}
        <EmptyState title={`No AI app logs on this ${place}`}>
          Wren reads the usage Claude Code, Codex, Grok Build, Antigravity and OpenCode record in their own folders. None of them has any here yet.
        </EmptyState>
      </div>
    );

  const value = (a: Amount) => (showCost ? a.cost : a.tokens);
  const fmt = (n: number) => (showCost ? formatUsd(n) : formatTokens(n));

  return (
    <div>
      {toolbar}
      <Card className="grid gap-6 p-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:p-6">
        <div>
          <p className="font-display text-4xl tabular-nums sm:text-5xl">{showCost ? `~${formatUsd(s.total.cost)}` : formatTokens(s.total.tokens)}</p>
          <p className="mt-1 text-sm text-muted">
            {s.total.sessions} {s.total.sessions === 1 ? 'session' : 'sessions'}
            {priced && !showCost && ` · ~${formatUsd(s.total.cost)} at API prices`}
            {showCost && ` · ${formatTokens(s.total.tokens)} tokens`}
          </p>
          <ul className="mt-5 space-y-3">
            {[...s.apps].sort((a, b) => Number(b.found) - Number(a.found) || value(b) - value(a)).map((a) => (
              <li key={a.id} className={cx('flex items-start gap-2.5', !a.found && 'opacity-55')}>
                <span aria-hidden className={cx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-[3px]', SHADE[a.id])} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    <AppLogo app={a.id} className="mr-1.5 inline-block h-[15px] w-[15px] align-[-3px]" />
                    {a.label} {a.tokens > 0 && <span className="font-normal text-faint">{a.sessions} {a.sessions === 1 ? 'session' : 'sessions'}</span>}
                  </p>
                  <p className="text-[12.5px] text-muted">{!a.found ? `Not on this ${place}` : a.tokens === 0 ? 'Nothing in this range' : `${share(a.tokens, s.total.tokens)} of tokens${priced ? ` · ${costText(a)}` : ''}`}</p>
                </div>
                {a.tokens > 0 && <p className="text-sm tabular-nums">{fmt(value(a))}</p>}
              </li>
            ))}
          </ul>
        </div>
        <DailyChart s={s} value={value} fmt={fmt} showCost={showCost} />
      </Card>

      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5">
        <Stat label="Processed tokens" value={formatTokens(s.total.tokens)} />
        <Stat label="Cached input" value={formatTokens(s.total.cacheRead)} />
        <Stat label="Uncached input" value={formatTokens(s.total.input)} />
        <Stat label="Output" value={formatTokens(s.total.output)} />
        {priced && <Stat label="Saved by caching" value={`~${formatUsd(s.total.savings)}`} />}
      </div>

      <Card className="mt-4 p-5">
        <p className="mb-3 text-sm font-medium">Tokens by type</p>
        <TypeBar s={s} />
      </Card>

      <Card className="mt-4 p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Breakdown</p>
          <Pills value={breakdown} onChange={setBreakdown} items={[{ value: 'model', label: 'By model' }, { value: 'day', label: 'By day' }]} label="Breakdown" />
        </div>
        <div className="overflow-x-auto">
          {breakdown === 'model' ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[12px] text-faint">
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium">App</th>
                  <th className="pb-2 text-right font-medium">Requests</th>
                  <th className="pb-2 text-right font-medium">Tokens</th>
                  <th className="pb-2 text-right font-medium">Share</th>
                  {priced && <th className="pb-2 text-right font-medium">Est. cost</th>}
                </tr>
              </thead>
              <tbody>
                {s.models.map((m) => (
                  <tr key={`${m.app}\0${m.model}`} className="border-t border-border">
                    <td className="max-w-[16rem] truncate py-2 pr-3 font-mono text-[12.5px]" title={m.model}>
                      {m.model}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <AppLogo app={m.app} className="h-3.5 w-3.5" />
                        {appLabel(m.app)}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums">{m.requests.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{formatTokens(m.tokens)}</td>
                    <td className="py-2 text-right text-muted tabular-nums">{share(m.tokens, s.total.tokens)}</td>
                    {priced && <td className="py-2 text-right tabular-nums">{m.unpriced === m.tokens ? <span className="text-faint">No price</span> : formatUsd(m.cost)}</td>}
                  </tr>
                ))}
                {!s.models.length && (
                  <tr>
                    <td className="py-3 text-muted" colSpan={6}>
                      Nothing in this range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[12px] text-faint">
                  <th className="pb-2 font-medium">Day</th>
                  <th className="pb-2 font-medium">Busiest app</th>
                  <th className="pb-2 text-right font-medium">Tokens</th>
                  {priced && <th className="pb-2 text-right font-medium">Est. cost</th>}
                </tr>
              </thead>
              <tbody>
                {s.daily
                  .filter((d) => d.total.tokens > 0)
                  .reverse()
                  .map((d) => {
                    const top = (Object.entries(d.apps) as [LocalApp, Amount][]).sort((a, b) => b[1].tokens - a[1].tokens)[0];
                    return (
                      <tr key={d.day} className="border-t border-border">
                        <td className="py-2 pr-3 whitespace-nowrap">{dayLabel(d.day)}</td>
                        <td className="py-2 pr-3 text-muted">
                          {top && (
                            <span className="inline-flex items-center gap-1.5">
                              <AppLogo app={top[0]} className="h-3.5 w-3.5" />
                              {appLabel(top[0])}
                            </span>
                          )}
                        </td>
                        <td className="py-2 text-right tabular-nums">{formatTokens(d.total.tokens)}</td>
                        {priced && <td className="py-2 text-right tabular-nums">{costText(d.total)}</td>}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <p className="mt-4 max-w-3xl text-[12.5px] leading-relaxed text-faint">
        Read on this {place} from the logs Claude Code, Codex, Grok Build, Antigravity and OpenCode keep. These numbers stay on this {place}: Wren’s server never receives them.{' '}
        {priced
          ? `Costs are estimates at each model’s API price (LiteLLM’s price list${prices !== 'none' && prices?.fetchedAt ? `, ${new Date(prices.fetchedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}). On a subscription plan you pay for the plan, not these amounts.`
          : prices === 'none'
            ? 'Prices couldn’t be loaded, so costs aren’t shown.'
            : ''}
        {priced && s.unpricedModels.length > 0 && ` No price is published for ${s.unpricedModels.join(', ')}, so ${s.unpricedModels.length === 1 ? 'its' : 'their'} tokens aren’t in the costs.`}
        {error && ` The last read failed (${error}); this is the one before it.`}
      </p>
    </div>
  );
}

/** The Limits view: each installed app's plan limits as the app itself reports them, one card per app. */
function PlanLimits({ limits, place, onRetry }: { limits: PlanLimitsReport | 'failed' | null; place: string; onRetry: () => void }) {
  if (limits === null)
    return (
      <div aria-busy="true" className="space-y-4">
        <p className="text-sm text-muted" role="status">
          Asking Claude Code, Codex and Grok Build…
        </p>
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-40 rounded-2xl" />
        ))}
      </div>
    );
  if (limits === 'failed')
    return (
      <EmptyState title="Couldn’t check plan limits" action={<Button onClick={onRetry}>Try again</Button>}>
        The desktop app didn’t answer.
      </EmptyState>
    );
  const apps = limits.apps.filter((a) => a.state !== 'missing');
  if (!apps.length)
    return (
      <EmptyState title={`No plan limits on this ${place}`}>
        Claude Code, Codex and Grok Build can say how much of their plan’s limits is used. None of them is installed here.
      </EmptyState>
    );
  const now = limits.generatedAt;
  const timed = apps.some((a) => a.windows.some((w) => limitPace(w, now).elapsed !== null));
  return (
    <div className="space-y-4">
      {apps.map((a) => {
        const name = appLabel(a.app);
        const about = [a.plan && `${a.plan} plan`, a.resetsBanked ? `${a.resetsBanked} full ${a.resetsBanked === 1 ? 'reset' : 'resets'} banked` : ''].filter(Boolean).join(' · ');
        return (
          <section key={a.app} aria-label={`${name} plan limits`}>
            <Card className="p-5 lg:p-6">
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="flex items-center gap-2 text-base font-semibold">
                  <AppLogo app={a.app} className="h-[18px] w-[18px]" />
                  {name}
                </h2>
                {about && <p className="text-[13px] text-muted">{about}</p>}
              </div>
              {a.state === 'ok' ? (
                <ul className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                  {a.windows.map((w) => (
                    <LimitRow key={w.id} w={w} now={now} />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">{limitsNote(a.state, name, place, a.note)}</p>
              )}
            </Card>
          </section>
        );
      })}
      <p className="text-[12px] text-faint">
        Checked {new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, as each app reports it.{timed && ' The mark on each bar is where an even pace would be by now.'}
      </p>
    </div>
  );
}

function limitsNote(state: PlanLimitsReport['apps'][number]['state'], name: string, place: string, note?: string): string {
  if (state === 'none') return note ?? `This ${name} sign-in has no plan limits${name === 'Claude Code' ? ' (an API key, Bedrock or Vertex)' : ''}.`;
  if (state === 'untrusted') return `Wren won’t run the copy of ${name} it found on this ${place}, so it can’t ask.`;
  if (state === 'old') return `Update ${name} to see its limits here.`;
  if (state === 'unavailable') return `${name} tells other apps its limits only while its background service runs, and it isn’t running now. You can see them with /usage inside ${name === 'Grok Build' ? 'Grok' : name}.`;
  return `${name} didn’t say${note ? ` (${note})` : ''}. Check that it’s signed in.`;
}

function LimitRow({ w, now }: { w: LimitWindow; now: number }) {
  const used = Math.round(w.used);
  const { elapsed, runsOutAt } = limitPace(w, now);
  const pace = paceText(w, now);
  const warn = runsOutAt !== null || w.used >= 100;
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm">{w.label}</p>
        <p className="text-sm font-medium tabular-nums">{used}% used</p>
      </div>
      <div className="relative mt-2 h-2">
        <div className="h-full overflow-hidden rounded-full bg-bg-subtle" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label={`${w.label}: ${used}% used`}>
          <div className="h-full rounded-full bg-text" style={{ width: `${Math.min(100, w.used)}%` }} />
        </div>
        {elapsed !== null && <span aria-hidden className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-muted ring-2 ring-surface" style={{ left: `${elapsed * 100}%` }} />}
      </div>
      <p className="mt-2 text-[12.5px] text-muted">
        {pace && <span className={cx(warn && 'font-medium text-text')}>{pace}. </span>}
        {w.used < 100 && w.resetsAt !== null && w.resetsAt > now && `Resets ${whenText(w.resetsAt, now)}.`}
      </p>
    </li>
  );
}

function DailyChart({ s, value, fmt, showCost }: { s: LocalSummary; value: (a: Amount) => number; fmt: (n: number) => string; showCost: boolean }) {
  const max = Math.max(1e-9, ...s.daily.map((d) => value(d.total)));
  const peak = s.daily.reduce((p, d) => (value(d.total) > value(p.total) ? d : p), s.daily[0]);
  const order = LOCAL_APPS.map((a) => a.id);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{showCost ? 'Daily cost (est.)' : 'Daily tokens'}</p>
        {peak && value(peak.total) > 0 && (
          <p className="text-[12px] text-faint">
            Busiest: {dayLabel(peak.day)} · {fmt(value(peak.total))}
          </p>
        )}
      </div>
      <div
        className={cx('flex h-44 items-end lg:h-auto lg:min-h-44 lg:flex-1', s.daily.length > 40 ? 'gap-px' : 'gap-[3px]')}
        role="img"
        aria-label={`${showCost ? 'Estimated cost' : 'Tokens'} per day over the last ${s.daily.length} days, by app.${peak && value(peak.total) > 0 ? ` Busiest day ${dayLabel(peak.day)} with ${fmt(value(peak.total))}.` : ''}`}
      >
        {s.daily.map((d) => {
          const v = value(d.total);
          return (
            <div key={d.day} className="group relative h-full flex-1">
              <div className="absolute inset-0 flex flex-col-reverse">
                {v === 0 ? (
                  <div className="h-px w-full bg-border" />
                ) : (
                  order.map((id) => {
                    const a = d.apps[id];
                    const h = a ? (value(a) / max) * 100 : 0;
                    return h > 0 ? <div key={id} className={cx('w-full first:rounded-b-[2px] last:rounded-t-[2px]', SHADE[id])} style={{ height: `max(${h}%, 1px)` }} /> : null;
                  })
                )}
              </div>
              <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-md bg-primary px-2 py-1 text-[11px] whitespace-nowrap text-primary-fg group-hover:block">
                {dayLabel(d.day)}: {fmt(v)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-faint tabular-nums" aria-hidden>
        <span>{s.daily[0] && dayLabel(s.daily[0].day)}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function TypeBar({ s }: { s: LocalSummary }) {
  const parts = [
    { label: 'Uncached input', n: s.total.input, cls: 'bg-text' },
    { label: 'Cache read', n: s.total.cacheRead, cls: 'bg-text/30' },
    { label: 'Cache write', n: s.total.cacheWrite, cls: 'bg-text/55' },
    { label: 'Output', n: s.total.output, cls: 'bg-text/80' },
  ];
  const sum = Math.max(1, s.total.tokens);
  return (
    <>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-bg-subtle" role="img" aria-label={parts.map((p) => `${p.label} ${formatTokens(p.n)}`).join(', ')}>
        {parts.map((p) => (p.n > 0 ? <div key={p.label} className={p.cls} style={{ width: `max(${(p.n / sum) * 100}%, 3px)` }} /> : null))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-muted">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-1.5">
            <span aria-hidden className={cx('h-2 w-2 rounded-[2px]', p.cls)} />
            {p.label} <span className="text-text tabular-nums">{formatTokens(p.n)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Pills<T extends string | number>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[]; label: string }) {
  return (
    <div className="flex gap-1 rounded-full border border-border bg-surface p-0.5" role="group" aria-label={label}>
      {items.map((it) => (
        <button
          key={String(it.value)}
          type="button"
          aria-pressed={value === it.value}
          onClick={() => onChange(it.value)}
          className={cx('rounded-full px-3 py-1 text-[13px] font-medium transition-colors', value === it.value ? 'bg-primary text-primary-fg' : 'text-muted hover:text-text')}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="flex flex-col justify-between p-3.5 sm:p-5">
      <p className="text-[12px] leading-snug text-muted sm:text-[13px]">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
    </Card>
  );
}

const share = (n: number, of: number) => {
  if (!of || !n) return '0%';
  const p = (n / of) * 100;
  return p < 0.1 ? '<0.1%' : `${p.toFixed(p < 10 ? 1 : 0)}%`;
};
/** Cost with a note when part of the tokens has no price. */
const costText = (a: Amount) => (a.unpriced === a.tokens && a.tokens > 0 ? 'no price' : `~${formatUsd(a.cost)}${a.unpriced > 0 ? ' + unpriced' : ''}`);
