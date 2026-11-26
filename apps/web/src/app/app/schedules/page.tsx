'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CalendarClock, Play, Plus, Trash2 } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { AgentAvatar } from '@/components/agent-avatar';
import { useApp } from '@/components/app/provider';
import { Button, ButtonLink, cx, Dialog, EmptyState, Input, Label, PageHeader, Select, SkeletonList, Switch, Textarea, timeAgo, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';
import { describeCronClient, presetToCron, type Preset } from '@/lib/client/cron';
import { useLive } from '@/lib/client/live';
import type { Schedule } from '@/lib/client/types';

export default function SchedulesPage() {
  return (
    <Suspense fallback={<SkeletonList rows={3} avatar={false} className="mt-24" />}>
      <Schedules />
    </Suspense>
  );
}

function Schedules() {
  const { userId, agents, agentById, profile } = useApp();
  const params = useSearchParams();
  const toast = useToast();
  const s = useLive<Schedule>({ table: 'schedules', eq: { user_id: userId }, order: { column: 'created_at' }, realtimeFilter: { column: 'user_id', value: userId } });
  // A one-off schedule is switched off as the cron starts it and deleted once its task has started, and deletions
  // don't come through the live list: look again once, so one that did start isn't shown as "didn't start".
  const switchedOff = s.rows.filter((x) => !x.cron && !x.enabled).map((x) => x.id).join(',');
  const reload = s.reload;
  useEffect(() => {
    if (!switchedOff) return;
    const t = setTimeout(reload, 5000);
    return () => clearTimeout(t);
  }, [switchedOff, reload]);
  const [open, setOpen] = useState(!!params.get('agent'));
  const [editing, setEditing] = useState<Schedule | null>(null);

  return (
    <div>
      <PageHeader
        title="Schedules"
        subtitle="Tasks your agents start on their own: daily briefings, weekly reports, or once at a time you pick. Agents can set one too, when you approve it."
        actions={
          <Button onClick={() => (setEditing(null), setOpen(true))} disabled={!agents.length}>
            <Plus className="h-4 w-4" /> New schedule
          </Button>
        }
      />
      {s.loading ? (
        <SkeletonList rows={3} avatar={false} />
      ) : !s.rows.length ? (
        <EmptyState icon={<CalendarClock className="h-6 w-6" />} title="No schedules yet" action={agents.length ? <Button onClick={() => setOpen(true)}>Create a schedule</Button> : <ButtonLink href="/app/agents/new">Create an agent first</ButtonLink>}>
          For example: “Every weekday at 8am, summarise my GitHub notifications and the news I care about.”
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {s.rows.map((x) => {
            const a = agentById(x.agent_id);
            return (
              <li key={x.id} className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 shadow-card">
                <AgentAvatar icon={a?.icon} color={a?.color} size={36} seed={a?.id} />
                <button className="min-w-0 flex-1 text-left" onClick={() => (setEditing(x), setOpen(true))}>
                  <p className="truncate font-medium">{x.name}</p>
                  <p className="truncate text-[12.5px] text-muted">
                    {x.cron ? describeCronClient(x.cron) : x.run_at && x.enabled ? `Once, ${onceLabel(x.run_at)}` : 'Didn’t start: set a new time'} · {a?.name ?? 'Agent removed'}
                    {x.cron && x.enabled && x.next_run_at && ` · next ${new Date(x.next_run_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`}
                    {x.last_run_at && ` · last ${timeAgo(x.last_run_at)}`}
                  </p>
                </button>
                {x.source_session_id && (
                  <Link href={`/app/s/${x.source_session_id}`} className="hidden shrink-0 text-[12px] text-faint underline decoration-border-strong underline-offset-2 hover:text-text sm:inline" title="The task it was set in">
                    Set by {a?.name ?? 'an agent'}
                  </Link>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  title="Run now"
                  aria-label="Run now"
                  onClick={async () => {
                    try {
                      await api(`/api/schedules/${x.id}/run`, { body: {} });
                      toast('Started — check Home for progress.');
                      // A one-off schedule is gone once started (deletions don't come through the live list).
                      if (!x.cron) s.reload();
                    } catch (e) {
                      toast((e as Error).message, 'error');
                    }
                  }}
                >
                  <Play className="h-4 w-4" />
                </Button>
                <Switch
                  label="Enabled"
                  checked={x.enabled}
                  onChange={async (v) => {
                    try {
                      await api(`/api/schedules/${x.id}`, { method: 'PATCH', body: { enabled: v } });
                    } catch (e) {
                      toast((e as Error).message, 'error');
                    }
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
      {open && <ScheduleDialog key={editing?.id ?? 'new'} schedule={editing} defaultAgent={params.get('agent') ?? agents[0]?.id} timezone={profile?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} onClose={() => setOpen(false)} onSaved={s.reload} />}
    </div>
  );
}

/** "Thu 27 Nov, 5:00 pm" on this device's clock (the year too when it isn't this one). */
function onceLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });
}

/** A date as an <input type="datetime-local"> value on this device's clock. */
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ScheduleDialog({ schedule, defaultAgent, timezone, onClose, onSaved }: { schedule: Schedule | null; defaultAgent?: string; timezone: string; onClose: () => void; onSaved: () => void }) {
  const { agents } = useApp();
  const toast = useToast();
  const [agentId, setAgentId] = useState(schedule?.agent_id ?? defaultAgent ?? '');
  const [name, setName] = useState(schedule?.name ?? '');
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const [preset, setPreset] = useState<Preset>(schedule ? 'custom' : 'weekdays');
  const [time, setTime] = useState('08:00');
  const [weekday, setWeekday] = useState(1);
  const [dom, setDom] = useState(1);
  const [custom, setCustom] = useState(schedule?.cron ?? '0 8 * * 1-5');
  // Once: a date and time on this device's clock (an <input type="datetime-local"> value).
  const [once, setOnce] = useState(!!schedule && !schedule.cron);
  const [at, setAt] = useState(() => localInput(schedule?.run_at ? new Date(schedule.run_at) : new Date(Date.now() + 3_600_000)));
  const [busy, setBusy] = useState(false);
  const cron = presetToCron(preset, time, weekday, dom, custom);
  const atDate = new Date(at);

  const save = async () => {
    setBusy(true);
    try {
      if (once && !Number.isFinite(atDate.getTime())) throw new Error('Pick a date and time.');
      const when = once ? { runAt: atDate.toISOString(), ...(schedule ? { enabled: true } : {}) } : { cron };
      const body = { agentId, name: name || prompt.slice(0, 60), prompt, ...when, timezone: schedule?.timezone ?? timezone };
      if (schedule) await api(`/api/schedules/${schedule.id}`, { method: 'PATCH', body });
      else await api('/api/schedules', { body: { ...body, enabled: true } });
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={schedule ? 'Edit schedule' : 'New schedule'}
      footer={
        <>
          {schedule && (
            <Button
              variant="ghost"
              className="mr-auto text-danger"
              onClick={async () => {
                try {
                  await api(`/api/schedules/${schedule.id}`, { method: 'DELETE' });
                  onSaved();
                  onClose();
                } catch (e) {
                  toast((e as Error).message, 'error');
                }
              }}
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!agentId || !prompt.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="sch-agent">Agent</Label>
          <Select id="sch-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="sch-prompt" hint={once ? 'What should the agent do then?' : 'What should the agent do each time?'}>
            Task
          </Label>
          <Textarea id="sch-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Check Hacker News and my GitHub notifications, then send me a 5-bullet briefing." />
        </div>
        <div>
          <Label htmlFor="sch-name">Name</Label>
          <Input id="sch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning briefing" maxLength={80} />
        </div>
        <div>
          <Label>When</Label>
          <div className="mb-2 flex gap-1 rounded-full border border-border bg-surface p-0.5" role="group" aria-label="Repeats or once">
            {[
              { v: false, label: 'Repeats' },
              { v: true, label: 'Once' },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                aria-pressed={once === o.v}
                onClick={() => setOnce(o.v)}
                className={cx('flex-1 rounded-full px-3 py-1 text-[13px] font-medium transition-colors', once === o.v ? 'bg-primary text-primary-fg' : 'text-muted hover:text-text')}
              >
                {o.label}
              </button>
            ))}
          </div>
          {once ? (
            <>
              <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="Date and time" />
              <p className="mt-1.5 text-[12.5px] text-muted">{Number.isFinite(atDate.getTime()) ? `Once, ${onceLabel(atDate.toISOString())}. It’s removed from this list after it starts.` : 'Pick a date and time.'}</p>
            </>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <Select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} aria-label="Repeat">
                  <option value="daily">Every day</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="weekly">Every week</option>
                  <option value="monthly">Every month</option>
                  <option value="hourly">Every hour</option>
                  <option value="every-6h">Every 6 hours</option>
                  <option value="custom">Custom (cron)</option>
                </Select>
                {['daily', 'weekdays', 'weekly', 'monthly'].includes(preset) && <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />}
                {preset === 'weekly' && (
                  <Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} aria-label="Weekday">
                    {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </Select>
                )}
                {preset === 'monthly' && <Input type="number" min={1} max={28} value={dom} onChange={(e) => setDom(Math.min(28, Math.max(1, Math.round(Number(e.target.value)) || 1)))} aria-label="Day of month" />}
                {preset === 'custom' && <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="0 8 * * 1-5" aria-label="Cron expression" className="font-mono" />}
              </div>
              <p className="mt-1.5 text-[12.5px] text-muted">
                {describeCronClient(cron)} ({schedule?.timezone ?? timezone})
              </p>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
