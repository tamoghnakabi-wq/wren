'use client';

import { ArrowUp, ChevronDown, Cloud, Laptop, Loader2, Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { sourceInfo } from '@/lib/client/sources';
import { isLiveDevice, type Agent } from '@/lib/client/types';
import { AgentAvatar } from '../agent-avatar';
import { cx, formatBytes, useToast } from '../ui';
import { useApp } from './provider';
import { ChatGPTPlanBadge, useUsesChatGPTPlan } from './chatgpt-ui';

interface Attachment {
  artifactId: string;
  name: string;
  mime: string;
  size: number;
}

export function Composer({
  agent,
  onAgentChange,
  sessionId,
  placeholder,
  autoFocus,
  onSent,
  compact,
}: {
  agent?: Agent;
  onAgentChange?: (a: Agent) => void;
  sessionId?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onSent?: (r: { sessionId: string; runId: string }) => void;
  compact?: boolean;
}) {
  const { agents, devices } = useApp();
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [pickAgent, setPickAgent] = useState(false);
  const [runtime, setRuntime] = useState<'cloud' | 'desktop' | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLDivElement>(null);

  // The agent list closes on a click elsewhere or Escape (focus goes back to its button).
  useEffect(() => {
    if (!pickAgent) return;
    const away = (e: PointerEvent) => !picker.current?.contains(e.target as Node) && setPickAgent(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPickAgent(false);
      picker.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    picker.current?.querySelector<HTMLElement>('[aria-selected="true"], [role="option"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [pickAgent]);

  useEffect(() => {
    if (autoFocus) ta.current?.focus();
  }, [autoFocus]);
  // A different agent starts from its own default runtime.
  const [runtimeFor, setRuntimeFor] = useState(agent?.id);
  if (runtimeFor !== agent?.id) {
    setRuntimeFor(agent?.id);
    setRuntime(undefined);
  }

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);

  const desktopOnly = !!sourceInfo(agent?.model?.source)?.desktopOnly;
  const effectiveRuntime = desktopOnly ? 'desktop' : runtime ?? agent?.runtime ?? 'cloud';
  const device = devices.find((d) => d.id === agent?.device_id) ?? devices[0];
  const deviceOnline = device ? isLiveDevice(device) : false;
  const usesPlan = useUsesChatGPTPlan(agent, effectiveRuntime);

  async function upload(list: FileList | null) {
    if (!list) return;
    for (const f of Array.from(list).slice(0, 10 - files.length)) {
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.append('file', f);
        const a = await api<Attachment>('/api/files', { form });
        setFiles((cur) => [...cur, a]);
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  // Starting a task opens its page, which would drop anything typed here meanwhile, so the box holds
  // still until then. In a task, a follow-up leaves the box at once and the next one can be written.
  const holding = busy && !sessionId;

  async function send() {
    if (!agent || busy || (!text.trim() && !files.length) || uploading) return;
    setBusy(true);
    // What's being sent leaves the box right away, so anything typed or attached meanwhile is a new
    // draft that the answer can't wipe. If sending fails, it comes back (ahead of the new draft).
    const sentText = text;
    const sentFiles = files;
    if (sessionId) {
      setText('');
      setFiles([]);
    }
    try {
      const r = await api<{ sessionId: string; runId: string }>('/api/tasks', {
        body: { agentId: agent.id, sessionId, text: sentText, attachments: sentFiles, runtime: sessionId ? undefined : runtime },
      });
      if (!sessionId) {
        setText('');
        setFiles([]);
      }
      onSent?.(r);
    } catch (e) {
      if (sessionId) {
        setText((cur) => (cur.trim() ? `${sentText}\n\n${cur}` : sentText));
        setFiles((cur) => [...sentFiles, ...cur.filter((f) => !sentFiles.some((s) => s.artifactId === f.artifactId))].slice(0, 10));
      }
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cx(
        'rounded-[22px] border bg-surface shadow-card transition-[border-color,box-shadow] duration-200 focus-within:border-border-strong focus-within:shadow-pop',
        dragging ? 'border-brand ring-4 ring-[var(--ring)]' : 'border-border',
        compact ? 'p-2' : 'p-3',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        if (!holding && e.dataTransfer.types.includes('Files')) setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!holding) upload(e.dataTransfer.files);
      }}
    >
      {dragging && <p className="px-2 pb-1 text-[12.5px] font-medium text-brand-ink">Drop to attach</p>}
      {!!files.length && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-1">
          {files.map((f) => (
            <span key={f.artifactId} className="pop-in inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-subtle py-1 pr-1.5 pl-2.5 text-[12.5px]">
              <span className="max-w-[160px] truncate">{f.name}</span>
              <span className="text-faint">{formatBytes(f.size)}</span>
              <button onClick={() => setFiles((c) => c.filter((x) => x !== f))} disabled={holding} className="text-faint hover:text-text disabled:opacity-50" aria-label={`Remove ${f.name}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
            e.preventDefault();
            send();
          }
        }}
        rows={compact ? 1 : 2}
        placeholder={placeholder ?? (agent ? `What should ${agent.name} do?` : 'Create an agent to get started')}
        className="block w-full resize-none bg-transparent px-2 py-1.5 text-[15px] leading-relaxed text-text placeholder:text-faint focus:outline-none"
        aria-label="Task description"
        disabled={!agent}
        readOnly={holding}
        aria-busy={holding || undefined}
      />
      <div className="mt-1 flex items-center gap-1.5">
        {!sessionId && onAgentChange && (
          <div className="relative" ref={picker}>
            <button
              type="button"
              onClick={() => setPickAgent((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={pickAgent}
              aria-label={agent ? `Agent: ${agent.name}. Change agent` : 'Choose agent'}
              className="flex h-8 items-center gap-1.5 rounded-full border border-border px-1.5 pr-2.5 text-[13px] font-medium whitespace-nowrap transition-colors hover:bg-bg-subtle"
              disabled={!agents.length}
            >
              {agent ? <AgentAvatar icon={agent.icon} color={agent.color} size={22} seed={agent.id} /> : null}
              <span className="max-w-[90px] truncate sm:max-w-[140px]">{agent?.name ?? 'Choose agent'}</span>
              <ChevronDown className={cx('h-3.5 w-3.5 text-faint transition-transform', pickAgent && 'rotate-180')} aria-hidden />
            </button>
            {pickAgent && (
              <div
                role="listbox"
                aria-label="Choose an agent"
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                  e.preventDefault();
                  const list = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
                  const i = list.indexOf(document.activeElement as HTMLElement);
                  list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
                }}
                className="pop-in absolute bottom-10 left-0 z-20 max-h-80 w-64 origin-bottom-left overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-pop scrollbar-thin"
              >
                {agents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="option"
                    aria-selected={a.id === agent?.id}
                    onClick={() => {
                      onAgentChange(a);
                      setPickAgent(false);
                    }}
                    className={cx('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-bg-subtle focus:outline-none focus-visible:bg-bg-subtle', a.id === agent?.id && 'bg-bg-subtle')}
                  >
                    <AgentAvatar icon={a.icon} color={a.color} size={28} seed={a.id} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{a.name}</span>
                      <span className="block truncate text-[12px] text-faint">{a.runtime === 'desktop' ? 'On your computer' : 'Cloud computer'}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!sessionId && agent && (
          <button
            type="button"
            onClick={() => !desktopOnly && setRuntime(effectiveRuntime === 'cloud' ? 'desktop' : 'cloud')}
            title={desktopOnly ? 'This model only runs on your computer' : 'Where this task runs'}
            aria-label={desktopOnly ? `Runs on ${device?.name ?? 'your computer'} (this model only runs there)` : `Runs on ${effectiveRuntime === 'cloud' ? 'the cloud computer' : device?.name ?? 'your computer'}. Switch to ${effectiveRuntime === 'cloud' ? 'your computer' : 'the cloud'}`}
            className="flex h-8 min-w-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-[13px] whitespace-nowrap text-muted transition-colors hover:bg-bg-subtle hover:text-text"
          >
            {effectiveRuntime === 'cloud' ? <Cloud className="h-3.5 w-3.5 shrink-0" /> : <Laptop className="h-3.5 w-3.5 shrink-0" />}
            <span className="max-w-[110px] truncate sm:max-w-[180px]">{effectiveRuntime === 'cloud' ? 'Cloud' : device?.name ?? 'Computer'}</span>
            {effectiveRuntime === 'desktop' && <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', deviceOnline ? 'bg-success' : 'bg-border-strong')} />}
          </button>
        )}
        <button type="button" onClick={() => fileInput.current?.click()} disabled={holding} className="flex h-8 w-8 items-center justify-center rounded-full text-faint transition-colors hover:bg-bg-subtle hover:text-text disabled:opacity-50" aria-label={uploading ? 'Uploading files' : 'Attach files'} title="Attach files">
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        <div className="flex-1" />
        <button
          type="button"
          onClick={send}
          disabled={!agent || busy || (!text.trim() && !files.length) || !!uploading}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-fg transition-[opacity,transform] duration-150 hover:opacity-90 enabled:active:scale-90 disabled:opacity-30"
          aria-label={busy ? 'Sending' : 'Send'}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4.5 w-4.5" strokeWidth={2.4} />}
        </button>
      </div>
      {usesPlan && <ChatGPTPlanBadge />}
      {!sessionId && agent && effectiveRuntime === 'desktop' && !deviceOnline && (
        <p className="mt-2 px-2 text-[12.5px] text-warning">{device ? `${device.name} is offline — the task will start when it comes online.` : 'No computer is linked yet — install the desktop app to run tasks locally.'}</p>
      )}
    </div>
  );
}
