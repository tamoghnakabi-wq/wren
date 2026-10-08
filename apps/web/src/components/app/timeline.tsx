'use client';

import { AlertTriangle, Brain, Check, ChevronRight, CircleHelp, CircleX, Code2, Copy, FileText, FolderTree, Globe, Hand, Info, ListChecks, Loader2, MousePointerClick, Plug, Search, Share2, Terminal, X, Bell, Monitor, Keyboard, ArrowDownUp, Camera, Undo2, Pencil } from 'lucide-react';
import { GithubMark as Github } from '../brand';
import { createContext, useContext, useId, useMemo, useState } from 'react';
import type { Approval, EventRow, PlanItem } from '@/lib/client/types';
import { AgentAvatar } from '../agent-avatar';
import { Markdown } from '../markdown';
import { cx, formatBytes } from '../ui';
import { ApprovalCard } from './approval-card';
import { CodeText } from '@/components/app/code-text';

const TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'computer.shell': Terminal,
  'computer.shell_status': Terminal,
  'computer.read_file': FileText,
  'computer.write_file': Pencil,
  'computer.edit_file': Pencil,
  'computer.list_files': FolderTree,
  'computer.share_file': Share2,
  'browser.navigate': Globe,
  'browser.snapshot': Monitor,
  'browser.click': MousePointerClick,
  'browser.type': Keyboard,
  'browser.press': Keyboard,
  'browser.scroll': ArrowDownUp,
  'browser.screenshot': Camera,
  'browser.back': Undo2,
  'web.fetch': Globe,
  'web.search': Search,
  'github.request': Github,
  'memory.remember': Brain,
  'memory.forget': Brain,
  'task.update_plan': ListChecks,
  'task.ask_user': CircleHelp,
  'task.notify': Bell,
  'screen.capture': Camera,
};

interface ToolData {
  callId: string;
  name: string;
  title: string;
  args: Record<string, unknown>;
  risk: string;
  approvalId?: string;
  result?: { output: string; isError?: boolean; images?: { artifactId?: string; mime: string }[]; artifacts?: { id: string; name: string }[] };
  startedAt?: number;
  endedAt?: number;
  turnId?: string;
  engine?: boolean;
}

type Item =
  | { kind: 'user'; ev: EventRow }
  | { kind: 'assistant'; ev: EventRow; tools: EventRow[]; streaming?: EventRow }
  | { kind: 'tools'; tools: EventRow[] }
  | { kind: 'status'; ev: EventRow }
  | { kind: 'plan'; ev: EventRow }
  | { kind: 'stopped'; runId: string };

const itemRuns = (it: Item): (string | null | undefined)[] =>
  it.kind === 'tools' ? it.tools.map((t) => t.run_id) : it.kind === 'assistant' ? [it.ev.run_id, ...it.tools.map((t) => t.run_id)] : it.kind === 'stopped' ? [] : [it.ev.run_id];

/** After the last thing a stopped run did, a line says it was stopped. */
/**
 * Runs that have ended, and whether their cleanup is still pending. A step of theirs still marked running
 * never reported how it went (a crash, or history an engine replayed): it shows "Didn't finish" rather than
 * spinning forever, and "Stopping…" while the run's commands aren't confirmed stopped (W-119).
 */
const EndedRuns = createContext<Map<string, 'ended' | 'stopping'>>(new Map());

function markStopped(items: Item[], stopped: Set<string>): Item[] {
  if (!stopped.size) return items;
  const lastIndex = new Map<string, number>();
  items.forEach((it, i) => itemRuns(it).forEach((r) => r && stopped.has(r) && lastIndex.set(r, i)));
  const out: Item[] = [];
  items.forEach((it, i) => {
    out.push(it);
    for (const [run, at] of lastIndex) if (at === i) out.push({ kind: 'stopped', runId: run });
  });
  return out;
}

function group(events: EventRow[]): Item[] {
  const items: Item[] = [];
  const byTurn = new Map<string, Extract<Item, { kind: 'assistant' }>>();
  for (const ev of events) {
    if (ev.type === 'message') {
      if (ev.data.role === 'user') items.push({ kind: 'user', ev });
      else {
        // Consecutive tool-only turns read better as one block of steps.
        const last = items[items.length - 1];
        const hasText = !!String(ev.data.text ?? '').trim();
        if (!hasText && last?.kind === 'assistant') {
          byTurn.set(ev.id, last);
          if (ev.status === 'streaming') last.streaming = ev;
          continue;
        }
        const it = { kind: 'assistant' as const, ev, tools: [] as EventRow[] };
        byTurn.set(ev.id, it);
        items.push(it);
      }
    } else if (ev.type === 'tool') {
      const d = ev.data as unknown as ToolData;
      const owner = d.turnId ? byTurn.get(d.turnId) : undefined;
      if (owner) owner.tools.push(ev);
      else {
        const last = items[items.length - 1];
        if (last?.kind === 'tools') last.tools.push(ev);
        else if (last?.kind === 'assistant') last.tools.push(ev);
        else items.push({ kind: 'tools', tools: [ev] });
      }
    } else if (ev.type === 'status') items.push({ kind: 'status', ev });
    else if (ev.type === 'plan') items.push({ kind: 'plan', ev });
  }
  return items;
}

export function Timeline({ events, agent, approvals, working, waitingFor, stoppedRuns, endedRuns, cleaningRuns }: { events: EventRow[]; agent?: { name: string; icon: string; color: string }; approvals: Approval[]; working: boolean; /** The (offline) computer a queued task waits for. */ waitingFor?: string; stoppedRuns?: string[]; endedRuns?: string[]; /** Ended runs whose commands aren't confirmed stopped yet. */ cleaningRuns?: string[] }) {
  const stoppedKey = (stoppedRuns ?? []).join(',');
  const endedKey = (endedRuns ?? []).join(',');
  const cleaningKey = (cleaningRuns ?? []).join(',');
  const ended = useMemo(() => {
    const cleaning = new Set(cleaningKey ? cleaningKey.split(',') : []);
    return new Map((endedKey ? endedKey.split(',') : []).map((id) => [id, cleaning.has(id) ? ('stopping' as const) : ('ended' as const)]));
  }, [endedKey, cleaningKey]);
  const items = useMemo(() => markStopped(group(events), new Set(stoppedKey ? stoppedKey.split(',') : [])), [events, stoppedKey]);
  const last = events[events.length - 1];
  const showThinking = working && !(last?.type === 'message' && last.status === 'streaming' && String(last.data.text ?? ''));
  const toolRunning = events.some((e) => e.type === 'tool' && e.status === 'running');
  return (
    <EndedRuns.Provider value={ended}>
    <div className="space-y-5">
      {items.map((it, i) => {
        switch (it.kind) {
          case 'user':
            return <UserBubble key={it.ev.id} ev={it.ev} />;
          case 'assistant':
            return <AssistantTurn key={it.ev.id} ev={it.ev} tools={it.tools} agent={agent} approvals={approvals} thinkingEv={it.streaming} />;
          case 'tools':
            return (
              <div key={`t${i}`} className="pl-11">
                <Steps tools={it.tools} approvals={approvals} />
              </div>
            );
          case 'status':
            return <StatusLine key={it.ev.id} ev={it.ev} />;
          case 'plan':
            return null;
          case 'stopped':
            return (
              <div key={`stopped-${it.runId}`} className="flex items-center gap-3 text-[12.5px] text-faint" role="note">
                <span className="h-px flex-1 bg-border" />
                <span className="flex items-center gap-1.5">
                  <CircleX className="h-3.5 w-3.5" aria-hidden /> Stopped
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            );
        }
      })}
      {showThinking && waitingFor && (
        <div className="fade-in flex items-center gap-3 pl-1" role="status">
          {agent && <AgentAvatar icon={agent.icon} color={agent.color} size={32} mood="idle" still seed={agent.name} />}
          <span className="text-sm text-muted">Waiting for {waitingFor} to come online. The task starts as soon as it does.</span>
        </div>
      )}
      {showThinking && !waitingFor && (
        <div className="fade-in flex items-center gap-3 pl-1" role="status">
          {agent && <AgentAvatar icon={agent.icon} color={agent.color} size={32} mood={toolRunning ? 'working' : 'thinking'} seed={agent.name} />}
          <span className="text-shimmer text-sm font-medium">{toolRunning ? 'Working…' : 'Thinking…'}</span>
        </div>
      )}
    </div>
    </EndedRuns.Provider>
  );
}

function UserBubble({ ev }: { ev: EventRow }) {
  const text = String(ev.data.text ?? '').replace(/\n\n\[Attached files: [^\]]*\]$/, '');
  const atts = (ev.data.attachments as { artifactId: string; name: string; mime: string; size: number }[] | undefined) ?? [];
  const answered = !!ev.data.answersCallId;
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] sm:max-w-[75%]">
        {answered && <p className="mb-1 text-right text-[11.5px] text-faint">Your answer</p>}
        <div className="rounded-[20px] rounded-br-md bg-primary px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-primary-fg">{text}</div>
        {atts.length > 0 && (
          <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
            {atts.map((a) =>
              a.mime.startsWith('image/') ? (
                <a key={a.artifactId} href={`/api/files/${a.artifactId}`} target="_blank" rel="noreferrer">
                  <img src={`/api/files/${a.artifactId}`} alt={a.name} className="h-20 w-20 rounded-xl border border-border object-cover" />
                </a>
              ) : (
                <a key={a.artifactId} href={`/api/files/${a.artifactId}?download`} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-[12.5px]">
                  <FileText className="h-3.5 w-3.5" /> {a.name} <span className="text-faint">{formatBytes(a.size)}</span>
                </a>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantTurn({ ev, tools, agent, approvals, thinkingEv }: { ev: EventRow; tools: EventRow[]; agent?: { name: string; icon: string; color: string }; approvals: Approval[]; thinkingEv?: EventRow }) {
  const text = String(ev.data.text ?? '');
  const streaming = ev.status === 'streaming';
  const failed = ev.status === 'failed';
  const src = thinkingEv?.status === 'streaming' ? thinkingEv : ev;
  const thinking = typeof src.data.thinking === 'string' ? (src.data.thinking as string) : '';
  const visible = tools.filter((t) => (t.data as unknown as ToolData).name !== 'task.update_plan');
  if (!text && !visible.length && !streaming && !failed && !thinking) return null;
  return (
    <div className="flex gap-3">
      <div className="w-8 shrink-0 pt-0.5">{agent && <AgentAvatar icon={agent.icon} color={agent.color} size={32} mood={streaming ? 'thinking' : 'idle'} still={!streaming} seed={agent.name} />}</div>
      <div className="min-w-0 flex-1 space-y-2.5">
        {(streaming || thinkingEv?.status === 'streaming') && thinking && <p className="line-clamp-2 text-[13px] text-faint italic">{thinking.slice(-220)}</p>}
        {text && (
          <div className={cx('group/answer relative', failed && 'opacity-60')}>
            <Markdown>{text + (streaming ? ' ▍' : '')}</Markdown>
            {!streaming && !failed && <CopyButton text={text} />}
          </div>
        )}
        {failed && !text && <p className="text-sm text-faint">The model call failed.</p>}
        {visible.length > 0 && <Steps tools={visible} approvals={approvals} />}
      </div>
    </div>
  );
}

/** Copies an answer; shown on hover with a mouse, always on touch screens. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-faint transition-[opacity,color,background-color] hover:bg-bg-subtle hover:text-text focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/answer:opacity-100"
      aria-label={copied ? 'Copied' : 'Copy answer'}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function Steps({ tools, approvals }: { tools: EventRow[]; approvals: Approval[] }) {
  const [open, setOpen] = useState(false);
  const visible = tools.filter((t) => (t.data as unknown as ToolData).name !== 'task.update_plan');
  const attention = visible.filter((t) => t.status === 'awaiting_approval' || t.status === 'awaiting_input');
  const collapsible = visible.length > 4 && !attention.length;
  const shown = collapsible && !open ? visible.slice(-3) : visible;
  return (
    <div className="space-y-1.5">
      {collapsible && !open && (
        <button type="button" onClick={() => setOpen(true)} className="text-[12.5px] text-faint transition-colors hover:text-text">
          Show {visible.length - 3} earlier steps
        </button>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {shown.map((t) => (
          <Step key={t.id} ev={t} approval={approvals.find((a) => a.event_id === t.id)} />
        ))}
      </div>
    </div>
  );
}

function Step({ ev, approval }: { ev: EventRow; approval?: Approval }) {
  const d = ev.data as unknown as ToolData;
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const Icon = d.name?.startsWith('mcp_') ? Plug : TOOL_ICONS[d.name] ?? Code2;
  const ended = useContext(EndedRuns);
  const raw = ev.status ?? 'pending';
  const runEnded = ev.run_id ? ended.get(ev.run_id) : undefined;
  const status = (raw === 'running' || raw === 'pending') && runEnded ? (runEnded === 'stopping' ? 'stopping' : 'unfinished') : raw;
  const dur = d.startedAt && d.endedAt ? Math.max(0, Math.round((d.endedAt - d.startedAt) / 100) / 10) : null;
  const images = d.result?.images?.filter((i) => i.artifactId) ?? [];
  const artifacts = d.result?.artifacts ?? [];

  if (status === 'awaiting_input') {
    return (
      <div className="border-b border-border bg-info-soft/60 px-3.5 py-3 last:border-0">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-info">
          <CircleHelp className="h-4 w-4" /> Question for you
        </p>
        <p className="mt-1 text-[15px]">{String(d.args.question ?? '')}</p>
        <p className="mt-1 text-[12.5px] text-muted">Reply below to continue.</p>
      </div>
    );
  }

  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={detailsId}
        className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
      >
        <Icon className="h-4 w-4 shrink-0 text-faint" aria-hidden />
        <span className={cx('min-w-0 flex-1 truncate text-[13.5px]', status === 'running' ? 'text-text' : 'text-muted')}><CodeText text={d.title || d.name} /></span>
        {dur !== null && status === 'done' && <span className="text-[11.5px] text-faint tabular-nums">{dur}s</span>}
        <StepStatus status={status} />
        <ChevronRight className={cx('h-3.5 w-3.5 text-faint transition-transform duration-200', open && 'rotate-90')} aria-hidden />
      </button>
      {status === 'awaiting_approval' && approval && (
        <div className="px-3 pb-3">
          <ApprovalCard approval={approval} showAgent={false} />
        </div>
      )}
      {status === 'awaiting_approval' && !approval && <p className="px-3.5 pb-2.5 text-[12.5px] text-warning">Waiting for approval…</p>}
      {(images.length > 0 || artifacts.length > 0) && (
        <div className="flex flex-wrap gap-2 px-3.5 pb-2.5">
          {images.map((im) => (
            <a key={im.artifactId} href={`/api/files/${im.artifactId}`} target="_blank" rel="noreferrer">
              <img src={`/api/files/${im.artifactId}`} alt="Screenshot" className="h-28 rounded-lg border border-border object-cover" loading="lazy" />
            </a>
          ))}
          {artifacts.map((a) => (
            <a key={a.id} href={`/api/files/${a.id}?download`} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-subtle px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-surface-2">
              <Share2 className="h-3.5 w-3.5" /> {a.name}
            </a>
          ))}
        </div>
      )}
      {open && (
        <div id={detailsId} className="fade-in space-y-2 border-t border-border bg-bg-subtle/60 px-3.5 py-2.5">
          <pre className="max-h-40 overflow-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">{JSON.stringify(d.args, null, 2)}</pre>
          {d.result && <pre className={cx('max-h-72 overflow-auto rounded-lg border border-border bg-surface p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap', d.result.isError ? 'text-danger' : 'text-text')}>{d.result.output}</pre>}
        </div>
      )}
    </div>
  );
}

function StepStatus({ status }: { status: string }) {
  const sr = (label: string) => <span className="sr-only">{label}</span>;
  if (status === 'running' || status === 'pending') return <span className="flex">{sr('Running')}<Loader2 className="h-3.5 w-3.5 animate-spin text-success" aria-hidden /></span>;
  if (status === 'done') return <span className="flex">{sr('Done')}<Check className="h-3.5 w-3.5 text-success" aria-hidden /></span>;
  if (status === 'awaiting_approval') return <span className="flex">{sr('Waiting for approval')}<Hand className="h-3.5 w-3.5 text-warning" aria-hidden /></span>;
  if (status === 'denied') return <span className="text-[11.5px] font-medium text-warning">Denied</span>;
  if (status === 'cancelled') return <span className="text-[11.5px] text-faint">Stopped</span>;
  if (status === 'unfinished') return <span className="text-[11.5px] text-faint">Didn’t finish</span>;
  if (status === 'stopping') return <span className="text-[11.5px] text-faint">Stopping…</span>;
  return <span className="flex">{sr('Failed')}<X className="h-3.5 w-3.5 text-danger" aria-hidden /></span>;
}

function StatusLine({ ev }: { ev: EventRow }) {
  const level = String(ev.data.level ?? 'info');
  const Icon = level === 'error' ? AlertTriangle : level === 'warn' ? AlertTriangle : Info;
  return (
    <div className={cx('mx-auto flex max-w-xl items-start justify-center gap-2 rounded-xl px-3 py-2 text-center text-[13px]', level === 'error' ? 'bg-danger-soft text-danger' : level === 'warn' ? 'bg-warning-soft text-warning' : 'text-muted')}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {String(ev.data.text ?? '')}
        {/^subscription_sharing_/.test(String(ev.data.code ?? '')) && (
          <>
            {' '}
            <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" className="font-medium underline">
              Manage usage
            </a>
          </>
        )}
      </span>
    </div>
  );
}

export function PlanCard({ items }: { items: PlanItem[] }) {
  const done = items.filter((i) => i.status === 'done').length;
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ListChecks className="h-4 w-4 text-faint" /> Plan
        </h3>
        <span className="text-[12px] text-faint tabular-nums">
          {done}/{items.length}
        </span>
      </div>
      <ol className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2.5 text-[13.5px]">
            <span className={cx('mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border', it.status === 'done' ? 'border-success bg-success text-bg' : it.status === 'in_progress' ? 'border-success' : 'border-border-strong')}>
              {it.status === 'done' ? <Check className="h-3 w-3" strokeWidth={3} /> : it.status === 'in_progress' ? <span className="h-2 w-2 animate-wren-pulse rounded-full bg-success" /> : null}
            </span>
            <span className={cx(it.status === 'done' ? 'text-faint line-through' : it.status === 'in_progress' ? 'font-medium' : 'text-muted')}>{it.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

