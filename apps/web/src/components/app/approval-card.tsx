'use client';

import Link from 'next/link';
import { Check, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/client/api';
import { desktop } from '@/lib/client/desktop';
import type { Approval } from '@/lib/client/types';
import { AgentAvatar } from '../agent-avatar';
import { Button, cx, Input, timeAgo, useToast } from '../ui';
import { useApp } from './provider';
import { CodeText } from '@/components/app/code-text';

const RISK = {
  low: { label: 'Low risk', cls: 'text-muted' },
  medium: { label: 'Medium risk', cls: 'text-info' },
  high: { label: 'High risk', cls: 'text-warning' },
  critical: { label: 'Critical', cls: 'text-danger' },
} as const;

function preview(args: Record<string, unknown> | undefined) {
  if (!args) return '';
  if (typeof args.command === 'string') return args.command;
  // task.schedule: what starts, and when on this device's clock.
  if (typeof args.task === 'string' && typeof args.when === 'string') {
    const at = new Date(args.when);
    const when = Number.isFinite(at.getTime()) ? at.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }) : args.when;
    return `Starts on its own: ${when}\n\n${args.task.slice(0, 1200)}`;
  }
  if (typeof args.path === 'string' && typeof args.content === 'string') return `${args.path}\n\n${String(args.content).slice(0, 600)}`;
  return JSON.stringify(args, null, 2).slice(0, 900);
}

export function ApprovalCard({ approval, showAgent = true, compact }: { approval: Approval; showAgent?: boolean; compact?: boolean }) {
  const { agentById } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  // Decided here: said so until the approval's row goes (the live list drops it a moment later).
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);
  // "Deny with a reason": what the user types goes to the agent with the denial.
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const agent = agentById(approval.agent_id);
  const r = RISK[approval.risk];
  const decide = async (approve: boolean, reason?: string) => {
    setBusy(approve ? 'approve' : 'deny');
    try {
      const why = reason?.trim() || undefined;
      await api(`/api/approvals/${approval.id}`, { body: { approve, note: why, via: window.matchMedia('(max-width: 640px)').matches ? 'mobile' : 'web' } });
      setDecided(approve ? 'approved' : 'denied');
      setAsking(false);
      toast(approve ? 'Approved — the agent is continuing.' : why ? 'Denied. The agent has your reason.' : 'Denied. The agent will try another way.');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  // Remote approvals are off on the computer running this: only a native prompt there counts.
  const localOnly = !!approval.detail?.localOnly;
  const bridge = desktop();
  const answerHere = async () => {
    setBusy('approve');
    try {
      const r = await bridge!.decideApproval!(approval.run_id, approval.id);
      if (r.error) toast(r.error, 'error');
    } finally {
      setBusy(null);
    }
  };
  const body = preview(approval.detail?.args);
  return (
    <div className={cx('rounded-2xl border bg-surface p-4 shadow-card', approval.risk === 'critical' ? 'border-danger/40' : 'border-warning/40')}>
      <div className="flex items-start gap-3">
        {showAgent && agent ? <AgentAvatar icon={agent.icon} color={agent.color} size={36} mood="waiting" seed={agent.id} /> : <ShieldAlert className="h-6 w-6 text-warning" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
            {showAgent && agent ? (
              <span>
                <span className="font-semibold">{agent.name}</span> <span className="text-muted">needs your approval</span>
              </span>
            ) : (
              <span className="text-muted">Needs your approval</span>
            )}
            <span className={cx('font-medium', r.cls)}>· {r.label}</span>
            <span className="text-faint">· {timeAgo(approval.created_at)}</span>
          </div>
          <p className="mt-1 text-[15px] font-medium break-words"><CodeText text={approval.title} /></p>
          {approval.detail?.reason && <p className="mt-0.5 text-[13px] text-muted">This {approval.detail.reason}.</p>}
          {body && !compact && <pre className="mt-2.5 max-h-48 overflow-auto rounded-xl border border-border bg-bg-subtle p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{body}</pre>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {decided ? (
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted" role="status">
                <Check className="h-4 w-4" aria-hidden /> {decided === 'approved' ? 'Approved. The agent carries on.' : 'Denied.'}
              </p>
            ) : localOnly && bridge?.decideApproval ? (
              <Button size="sm" onClick={answerHere} loading={busy === 'approve'} disabled={!!busy}>
                <ShieldCheck className="h-4 w-4" /> Answer on this computer
              </Button>
            ) : localOnly ? (
              <p className="text-[13px] text-muted">Remote approvals are off for that computer — answer in the Wren app on it.</p>
            ) : asking ? (
              <form
                className="flex w-full flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void decide(false, note);
                }}
              >
                <Input
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}
                  maxLength={500}
                  placeholder="Why not, or what to do instead"
                  aria-label={`Your reason for denying, sent to ${agent?.name ?? 'the agent'}`}
                  className="min-w-0 flex-1 basis-56"
                  disabled={!!busy}
                />
                <Button size="sm" variant="secondary" type="submit" loading={busy === 'deny'} disabled={!!busy}>
                  Deny
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setAsking(false)} disabled={!!busy}>
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <Button size="sm" onClick={() => decide(true)} loading={busy === 'approve'} disabled={!!busy}>
                  <ShieldCheck className="h-4 w-4" /> Approve
                </Button>
                <Button size="sm" variant="secondary" onClick={() => decide(false)} loading={busy === 'deny'} disabled={!!busy}>
                  Deny
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAsking(true)} disabled={!!busy}>
                  Deny with a reason
                </Button>
              </>
            )}
            {showAgent && !asking && (
              <Link href={`/app/s/${approval.session_id}`} className="ml-auto text-[13px] text-muted hover:text-text">
                Open task
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
