'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CalendarClock, Play, Plus, Trash2 } from 'lucide-react';
import { Suspense, useState } from 'react';
import { AgentAvatar } from '@/components/agent-avatar';
import { useApp } from '@/components/app/provider';
import { Button, Dialog, EmptyState, Input, Label, PageHeader, Select, Spinner, Switch, Textarea, timeAgo, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';
import { describeCronClient, presetToCron, type Preset } from '@/lib/client/cron';
import { useLive } from '@/lib/client/live';
import type { Schedule } from '@/lib/client/types';

export default function SchedulesPage() {
  return (
    <Suspense fallback={<Spinner className="mx-auto mt-24" />}>
      <Schedules />
    </Suspense>
  );
}

function Schedules() {
  const { userId, agents, agentById, profile } = useApp();
  const params = useSearchParams();
  const toast = useToast();
  const s = useLive<Schedule>({ table: 'schedules', eq: { user_id: userId }, order: { column: 'created_at' }, realtimeFilter: { column: 'user_id', value: userId } });
  const [open, setOpen] = useState(!!params.get('agent'));
  const [editing, setEditing] = useState<Schedule | null>(null);

  return (
    <div>
      <PageHeader
        title="Schedules"
        subtitle="Recurring tasks your agents run on their own — daily briefings, weekly reports, monitoring."
        actions={
          <Button onClick={() => (setEditing(null), setOpen(true))} disabled={!agents.length}>
            <Plus className="h-4 w-4" /> New schedule
          </Button>
        }
      />
      {s.loading ? (
        <Spinner />
      ) : !s.rows.length ? (
        <EmptyState icon={<CalendarClock className="h-6 w-6" />} title="No schedules yet" action={agents.length ? <Button onClick={() => setOpen(true)}>Create a schedule</Button> : <Link href="/app/agents/new"><Button>Create an agent first</Button></Link>}>
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
                    {describeCronClient(x.cron)} · {a?.name ?? 'Agent removed'}
                    {x.enabled && x.next_run_at && ` · next ${new Date(x.next_run_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`}
                    {x.last_run_at && ` · last ${timeAgo(x.last_run_at)}`}
                  </p>
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Run now"
                  aria-label="Run now"
                  onClick={async () => {
                    try {
                      await api(`/api/schedules/${x.id}/run`, { body: {} });
                      toast('Started — check Home for progress.');
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
  const [busy, setBusy] = useState(false);
  const cron = presetToCron(preset, time, weekday, dom, custom);

  const save = async () => {
    setBusy(true);
    try {
      const body = { agentId, name: name || prompt.slice(0, 60), prompt, cron, timezone: schedule?.timezone ?? timezone };
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
                await api(`/api/schedules/${schedule.id}`, { method: 'DELETE' });
                onSaved();
                onClose();
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
          <Label htmlFor="sch-prompt" hint="What should the agent do each time?">
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
            {preset === 'monthly' && <Input type="number" min={1} max={28} value={dom} onChange={(e) => setDom(Number(e.target.value))} aria-label="Day of month" />}
            {preset === 'custom' && <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="0 8 * * 1-5" aria-label="Cron expression" className="font-mono" />}
          </div>
          <p className="mt-1.5 text-[12.5px] text-muted">
            {describeCronClient(cron)} ({schedule?.timezone ?? timezone})
          </p>
        </div>
      </div>
    </Dialog>
  );
}
