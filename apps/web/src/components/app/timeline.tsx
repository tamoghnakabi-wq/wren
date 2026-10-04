'use client';

import { AlertTriangle, Brain, Check, ChevronRight, CircleHelp, Code2, FileText, FolderTree, Globe, Hand, Info, ListChecks, Loader2, MousePointerClick, Plug, Search, Share2, Terminal, X, Bell, Monitor, Keyboard, ArrowDownUp, Camera, Undo2, Pencil } from 'lucide-react';
import { GithubMark as Github } from '../brand';
import { useMemo, useState } from 'react';
import type { Approval, EventRow, PlanItem } from '@/lib/client/types';
import { AgentAvatar } from '../agent-avatar';
import { Markdown } from '../markdown';
import { cx, formatBytes } from '../ui';
import { ApprovalCard } from './approval-card';

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
  | { kind: 'plan'; ev: EventRow };

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

export function Timeline({ events, agent, approvals, working }: { events: EventRow[]; agent?: { name: string; icon: string; color: string }; approvals: Approval[]; working: boolean }) {
  const items = useMemo(() => group(events), [events]);
  const last = events[events.length - 1];
  const showThinking = working && !(last?.type === 'message' && last.status === 'streaming' && String(last.data.text ?? ''));
  return (
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
        }
      })}
      {showThinking && (
        <div className="flex items-center gap-3 pl-1">
          {agent && <AgentAvatar icon={agent.icon} color={agent.color} size={30} live="running" />}
          <span className="text-shimmer text-sm font-medium">Working…</span>
        </div>
      )}
    </div>
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
      <div className="w-8 shrink-0 pt-0.5">{agent && <AgentAvatar icon={agent.icon} color={agent.color} size={30} />}</div>
      <div className="min-w-0 flex-1 space-y-2.5">
        {(streaming || thinkingEv?.status === 'streaming') && thinking && <p className="line-clamp-2 text-[13px] text-faint italic">{thinking.slice(-220)}</p>}
        {text && (
          <div className={cx(failed && 'opacity-60')}>
            <Markdown>{text + (streaming ? ' ▍' : '')}</Markdown>
          </div>
        )}
        {failed && !text && <p className="text-sm text-faint">The model call failed.</p>}
        {visible.length > 0 && <Steps tools={visible} approvals={approvals} />}
      </div>
    </div>
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
        <button onClick={() => setOpen(true)} className="text-[12.5px] text-faint hover:text-text">
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
  const Icon = d.name?.startsWith('mcp_') ? Plug : TOOL_ICONS[d.name] ?? Code2;
  const status = ev.status ?? 'pending';
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
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left hover:bg-surface-2">
        <Icon className="h-4 w-4 shrink-0 text-faint" />
        <span className={cx('min-w-0 flex-1 truncate text-[13.5px]', status === 'running' ? 'text-text' : 'text-muted')}>{d.title || d.name}</span>
        {dur !== null && status === 'done' && <span className="text-[11.5px] text-faint tabular-nums">{dur}s</span>}
        <StepStatus status={status} />
        <ChevronRight className={cx('h-3.5 w-3.5 text-faint transition', open && 'rotate-90')} />
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
        <div className="space-y-2 border-t border-border bg-bg-subtle/60 px-3.5 py-2.5">
          <pre className="max-h-40 overflow-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">{JSON.stringify(d.args, null, 2)}</pre>
          {d.result && <pre className={cx('max-h-72 overflow-auto rounded-lg border border-border bg-surface p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap', d.result.isError ? 'text-danger' : 'text-text')}>{d.result.output}</pre>}
        </div>
      )}
    </div>
  );
}

function StepStatus({ status }: { status: string }) {
  if (status === 'running' || status === 'pending') return <Loader2 className="h-3.5 w-3.5 animate-spin text-success" />;
  if (status === 'done') return <Check className="h-3.5 w-3.5 text-success" />;
  if (status === 'awaiting_approval') return <Hand className="h-3.5 w-3.5 text-warning" />;
  if (status === 'denied') return <span className="text-[11.5px] font-medium text-warning">Denied</span>;
  if (status === 'cancelled') return <span className="text-[11.5px] text-faint">Stopped</span>;
  return <X className="h-3.5 w-3.5 text-danger" />;
}

function StatusLine({ ev }: { ev: EventRow }) {
  const level = String(ev.data.level ?? 'info');
  const Icon = level === 'error' ? AlertTriangle : level === 'warn' ? AlertTriangle : Info;
  return (
    <div className={cx('mx-auto flex max-w-xl items-start justify-center gap-2 rounded-xl px-3 py-2 text-center text-[13px]', level === 'error' ? 'bg-danger-soft text-danger' : level === 'warn' ? 'bg-warning-soft text-warning' : 'text-muted')}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{String(ev.data.text ?? '')}</span>
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
            <span className={cx('mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border', it.status === 'done' ? 'border-success bg-success text-white' : it.status === 'in_progress' ? 'border-success' : 'border-border-strong')}>
              {it.status === 'done' ? <Check className="h-3 w-3" strokeWidth={3} /> : it.status === 'in_progress' ? <span className="h-2 w-2 animate-wren-pulse rounded-full bg-success" /> : null}
            </span>
            <span className={cx(it.status === 'done' ? 'text-faint line-through' : it.status === 'in_progress' ? 'font-medium' : 'text-muted')}>{it.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

