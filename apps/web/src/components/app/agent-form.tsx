'use client';

import Link from 'next/link';
import { Check, Cloud, Info, Laptop, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client/api';
import { useLive } from '@/lib/client/live';
import { ENGINE_MODELS, SOURCES, sourceInfo } from '@/lib/client/sources';
import type { Agent, Connection } from '@/lib/client/types';
import { AGENT_COLORS, AGENT_ICONS, AgentAvatar } from '../agent-avatar';
import { Badge, Card, cx, Input, Label, Select, Spinner, Switch, Textarea } from '../ui';
import { useApp } from './provider';

export interface AgentDraft {
  name: string;
  icon: string;
  color: string;
  instructions: string;
  model: { source: string; model: string; connectionId?: string; effort?: 'low' | 'medium' | 'high' };
  runtime: 'cloud' | 'desktop';
  deviceId: string | null;
  tools: { computer: boolean; browser: boolean; web: boolean; github: boolean; memory: boolean; notify: boolean; screen: boolean; mcp: string[] };
  autonomy: 'careful' | 'balanced' | 'autonomous';
  memoryEnabled: boolean;
}

export const emptyDraft = (): AgentDraft => ({
  name: '',
  icon: 'sparkles',
  color: 'violet',
  instructions: '',
  model: { source: '', model: '' },
  runtime: 'cloud',
  deviceId: null,
  tools: { computer: true, browser: true, web: true, github: false, memory: true, notify: true, screen: false, mcp: [] },
  autonomy: 'balanced',
  memoryEnabled: true,
});

export function draftFromAgent(a: Agent): AgentDraft {
  const d = emptyDraft();
  return {
    name: a.name,
    icon: a.icon,
    color: a.color,
    instructions: a.instructions,
    model: { source: a.model?.source ?? '', model: a.model?.model ?? '', connectionId: a.model?.connectionId, effort: a.model?.effort },
    runtime: a.runtime,
    deviceId: a.device_id,
    tools: { ...d.tools, ...(a.tools as object) } as AgentDraft['tools'],
    autonomy: a.autonomy,
    memoryEnabled: a.memory_enabled,
  };
}

export function toPayload(d: AgentDraft) {
  return {
    name: d.name,
    icon: d.icon,
    color: d.color,
    instructions: d.instructions,
    model: d.model.source && d.model.model ? { source: d.model.source, model: d.model.model, ...(d.model.connectionId ? { connectionId: d.model.connectionId } : {}), ...(d.model.effort ? { effort: d.model.effort } : {}) } : undefined,
    runtime: d.runtime,
    deviceId: d.deviceId,
    tools: d.tools,
    autonomy: d.autonomy,
    memoryEnabled: d.memoryEnabled,
  };
}

const AUTONOMY = [
  { id: 'careful', title: 'Careful', body: 'Asks before anything that changes files, sends data, or acts on websites.' },
  { id: 'balanced', title: 'Balanced', body: 'Works freely; asks before deleting, publishing, sending, pushing or spending.' },
  { id: 'autonomous', title: 'Autonomous', body: 'Only stops for critical actions like credentials, payments or system changes.' },
] as const;

const TOOLS: { key: keyof AgentDraft['tools']; title: string; body: string; desktopOnly?: boolean }[] = [
  { key: 'computer', title: 'Computer', body: 'Terminal, code execution and files' },
  { key: 'browser', title: 'Browser', body: 'Browse and use websites' },
  { key: 'web', title: 'Web research', body: 'Read pages and search the web' },
  { key: 'github', title: 'GitHub', body: 'Issues, PRs and repos (connect GitHub first)' },
  { key: 'notify', title: 'Notifications', body: 'Message you about milestones' },
  { key: 'screen', title: 'Screen capture', body: 'See your screen (always asks)', desktopOnly: true },
];

export function AgentForm({ draft, onChange }: { draft: AgentDraft; onChange: (d: AgentDraft) => void }) {
  const { devices, userId } = useApp();
  const set = <K extends keyof AgentDraft>(k: K, v: AgentDraft[K]) => onChange({ ...draft, [k]: v });
  const src = sourceInfo(draft.model.source);
  const connections = useLive<Connection>({ table: 'connections', eq: { user_id: userId } });
  const mcp = connections.rows.filter((c) => c.provider === 'mcp');

  useEffect(() => {
    if (src?.desktopOnly && draft.runtime !== 'desktop') onChange({ ...draft, runtime: 'desktop' });
  }, [src?.desktopOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex items-center gap-4">
          <AgentAvatar icon={draft.icon} color={draft.color} size={56} />
          <div className="flex-1">
            <Label htmlFor="agent-name">Name</Label>
            <Input id="agent-name" value={draft.name} maxLength={60} placeholder="e.g. Scout" onChange={(e) => set('name', e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(AGENT_ICONS).map(([k, Icon]) => (
            <button key={k} type="button" onClick={() => set('icon', k)} className={cx('flex h-9 w-9 items-center justify-center rounded-xl border transition', draft.icon === k ? 'border-text bg-surface' : 'border-transparent text-muted hover:bg-bg-subtle')} aria-label={k}>
              <Icon className="h-4.5 w-4.5" />
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(AGENT_COLORS).map(([k, c]) => (
            <button key={k} type="button" onClick={() => set('color', k)} className={cx('h-7 w-7 rounded-full ring-offset-2 ring-offset-bg transition', draft.color === k && 'ring-2')} style={{ background: c.bg, ['--tw-ring-color' as string]: c.ring }} aria-label={k} />
          ))}
        </div>
        <div>
          <Label htmlFor="agent-instructions" hint="Who this agent is, how it should work, and anything it should always or never do.">
            Instructions
          </Label>
          <Textarea id="agent-instructions" value={draft.instructions} rows={5} maxLength={20000} onChange={(e) => set('instructions', e.target.value)} placeholder="You are my research assistant. Always cite sources…" />
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-base font-semibold">Brain</h3>
        <p className="mb-3 text-[13px] text-muted">Which model the agent uses and who pays for it.</p>
        <ModelPicker draft={draft} onChange={onChange} connections={connections.rows} loadingConnections={connections.loading} />
      </section>

      <section>
        <h3 className="mb-1 text-base font-semibold">Where it works</h3>
        <p className="mb-3 text-[13px] text-muted">Each agent has its own cloud computer, or it can work on your Mac or PC.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <ChoiceCard on={draft.runtime === 'cloud'} disabled={!!src?.desktopOnly} onClick={() => set('runtime', 'cloud')} icon={<Cloud className="h-5 w-5" />} title="Cloud computer" body="Keeps working when your computer is off. Isolated Linux VM with a browser." />
          <ChoiceCard on={draft.runtime === 'desktop'} onClick={() => set('runtime', 'desktop')} icon={<Laptop className="h-5 w-5" />} title="Your computer" body="Uses your files and apps with your permission. Needs the desktop app." />
        </div>
        {src?.desktopOnly && <p className="mt-2 text-[12.5px] text-muted">{src.label} runs on your computer, so this agent works there.</p>}
        {draft.runtime === 'desktop' && (
          <div className="mt-3">
            {devices.length ? (
              <Select value={draft.deviceId ?? ''} onChange={(e) => set('deviceId', e.target.value || null)} aria-label="Computer">
                <option value="">Most recently active computer</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning">
                No computer linked yet. <Link href="/download" className="underline">Install the desktop app</Link> and sign in to link it.
              </p>
            )}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-base font-semibold">Tools</h3>
        <p className="mb-3 text-[13px] text-muted">What the agent is allowed to use.</p>
        <Card className="divide-y divide-border">
          {TOOLS.filter((t) => !t.desktopOnly || draft.runtime === 'desktop').map((t) => (
            <div key={t.key} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1">
                <p className="text-sm font-medium">{t.title}</p>
                <p className="text-[12.5px] text-muted">{t.body}</p>
              </div>
              <Switch label={t.title} checked={!!draft.tools[t.key]} onChange={(v) => set('tools', { ...draft.tools, [t.key]: v })} />
            </div>
          ))}
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1">
              <p className="text-sm font-medium">Memory</p>
              <p className="text-[12.5px] text-muted">Remembers your preferences across tasks</p>
            </div>
            <Switch label="Memory" checked={draft.memoryEnabled} onChange={(v) => onChange({ ...draft, memoryEnabled: v, tools: { ...draft.tools, memory: v } })} />
          </div>
          {mcp.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1">
                <p className="text-sm font-medium">{c.label}</p>
                <p className="text-[12.5px] text-muted">Connected MCP server · {Array.isArray(c.config.tools) ? c.config.tools.length : 0} tools</p>
              </div>
              <Switch
                label={c.label}
                checked={draft.tools.mcp.includes(c.id)}
                onChange={(v) => set('tools', { ...draft.tools, mcp: v ? [...draft.tools.mcp, c.id] : draft.tools.mcp.filter((x) => x !== c.id) })}
              />
            </div>
          ))}
        </Card>
      </section>

      <section>
        <h3 className="mb-1 flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="h-4.5 w-4.5" /> Approvals
        </h3>
        <p className="mb-3 text-[13px] text-muted">When the agent must stop and ask you first. You can approve from your phone.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {AUTONOMY.map((a) => (
            <ChoiceCard key={a.id} on={draft.autonomy === a.id} onClick={() => set('autonomy', a.id)} title={a.title} body={a.body} />
          ))}
        </div>
        <p className="mt-2 text-[12.5px] text-faint">Agents can never type passwords or card numbers, complete payments, or run catastrophic commands — whatever the setting.</p>
      </section>
    </div>
  );
}

function ChoiceCard({ on, onClick, icon, title, body, disabled }: { on: boolean; onClick: () => void; icon?: React.ReactNode; title: string; body: string; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={cx('relative flex items-start gap-3 rounded-2xl border p-3.5 text-left transition disabled:opacity-40', on ? 'border-text bg-surface shadow-card' : 'border-border hover:border-border-strong')}>
      {icon && <span className="mt-0.5 text-muted">{icon}</span>}
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{body}</span>
      </span>
      {on && <Check className="absolute top-3 right-3 h-4 w-4" />}
    </button>
  );
}

function ModelPicker({ draft, onChange, connections, loadingConnections }: { draft: AgentDraft; onChange: (d: AgentDraft) => void; connections: Connection[]; loadingConnections: boolean }) {
  const { devices, desktop: desk, profile, flags } = useApp();
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const source = draft.model.source;
  const keyFor = (p: string) => connections.find((c) => c.provider === p && c.kind === 'model');
  const chatgptModels = useMemo(() => devices.flatMap((d) => d.capabilities?.chatgpt?.models ?? []), [devices]);
  const localModels = useMemo(() => devices.flatMap((d) => d.capabilities?.local?.models ?? []), [devices]);
  const anyDevice = devices.length > 0;

  const available = SOURCES.filter((s) => {
    if (s.id === 'test') return flags.testModel;
    if (s.id === 'platform') return flags.platform;
    return true;
  });

  useEffect(() => {
    let cancel = false;
    setNote(null);
    if (!source) return;
    const engines = ENGINE_MODELS[source];
    if (engines) {
      setModels(engines);
      return;
    }
    if (source === 'local') {
      setModels(localModels);
      if (!localModels.length) setNote('No local models found. Start LM Studio or Ollama on your computer, then check Settings in the desktop app.');
      return;
    }
    setLoading(true);
    const params = new URLSearchParams({ source: source === 'openai' && !keyFor('openai') ? 'openai' : source });
    if (draft.model.connectionId) params.set('connectionId', draft.model.connectionId);
    const wantApi = source !== 'openai' || keyFor('openai');
    (wantApi ? api<{ models: { id: string; name: string }[]; error?: string; needsConnection?: boolean }>(`/api/models?${params}`) : Promise.resolve({ models: [] as { id: string; name: string }[], needsConnection: true, error: undefined }))
      .then((r) => {
        if (cancel) return;
        let list = r.models;
        if (source === 'openai') {
          const seen = new Set(list.map((m) => m.id));
          list = [...chatgptModels.filter((m) => !seen.has(m.id)), ...list];
          if (!list.length) list = [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }, { id: 'gpt-6-astra', name: 'GPT-6 Astra' }, { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' }];
        }
        setModels(list);
        if (r.error) setNote(r.error);
        else if (r.needsConnection && source !== 'openai') setNote('Add an API key for this provider in Connections to load its models.');
      })
      .catch((e) => !cancel && setNote((e as Error).message))
      .finally(() => !cancel && setLoading(false));
    return () => {
      cancel = true;
    };
  }, [source, draft.model.connectionId, connections.length, chatgptModels.length, localModels.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = (id: string): { tone: 'success' | 'warning' | 'neutral'; text: string } => {
    switch (id) {
      case 'openai': {
        const chat = devices.some((d) => d.capabilities?.chatgpt?.signedIn);
        const key = !!keyFor('openai');
        if (chat && key) return { tone: 'success', text: 'ChatGPT plan + API key' };
        if (chat) return { tone: 'success', text: 'ChatGPT plan on your computer' };
        if (key) return { tone: 'success', text: 'API key connected' };
        return { tone: 'warning', text: 'Sign in with ChatGPT or add a key' };
      }
      case 'claude-code':
        return devices.some((d) => d.capabilities?.claudeCode?.installed) ? { tone: 'success', text: 'Found on your computer' } : { tone: 'neutral', text: anyDevice ? 'Not installed' : 'Needs the desktop app' };
      case 'grok-build':
        return devices.some((d) => d.capabilities?.grokBuild?.installed) ? { tone: 'success', text: 'Found on your computer' } : { tone: 'neutral', text: anyDevice ? 'Not installed' : 'Needs the desktop app' };
      case 'local':
        return localModels.length ? { tone: 'success', text: `${localModels.length} models` } : { tone: 'neutral', text: anyDevice ? 'No server found' : 'Needs the desktop app' };
      case 'anthropic':
      case 'xai':
      case 'gateway':
        return keyFor(id) ? { tone: 'success', text: 'Key connected' } : { tone: 'neutral', text: 'Add an API key' };
      default:
        return { tone: 'neutral', text: '' };
    }
  };

  return (
    <div className="space-y-3">
      {loadingConnections ? (
        <Spinner />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {available.map((s) => {
            const st = status(s.id);
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onChange({ ...draft, model: { source: s.id, model: '', connectionId: undefined }, runtime: s.desktopOnly ? 'desktop' : draft.runtime })}
                className={cx('relative rounded-2xl border p-3.5 text-left transition', source === s.id ? 'border-text bg-surface shadow-card' : 'border-border hover:border-border-strong')}
              >
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{s.label}</span>
                  {s.usesSubscription && <Badge tone="brand">Plan</Badge>}
                </span>
                <span className="mt-0.5 block text-[12.5px] text-muted">{s.short}</span>
                {st.text && <span className={cx('mt-1.5 block text-[11.5px] font-medium', st.tone === 'success' ? 'text-success' : st.tone === 'warning' ? 'text-warning' : 'text-faint')}>{st.text}</span>}
                {source === s.id && <Check className="absolute top-3 right-3 h-4 w-4" />}
              </button>
            );
          })}
        </div>
      )}
      {source && sourceInfo(source) && (
        <div className="flex gap-2 rounded-xl bg-bg-subtle px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {sourceInfo(source)!.detail}
            {source === 'openai' && (
              <>
                {' '}
                Current preference: <b className="text-text">{profile?.settings?.openaiAccess === 'api' ? 'API key' : 'ChatGPT plan'}</b> — <Link href="/app/settings#model-access" className="underline">change</Link>.
              </>
            )}
            {desk && source === 'openai' && !desk.chatgpt.signedIn && ' Sign in with ChatGPT in Settings on this computer.'}
          </span>
        </div>
      )}
      {source && (
        <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
          <div>
            <Label htmlFor="agent-model">Model</Label>
            {loading ? (
              <div className="flex h-10 items-center">
                <Spinner />
              </div>
            ) : models.length ? (
              <Select id="agent-model" value={draft.model.model} onChange={(e) => onChange({ ...draft, model: { ...draft.model, model: e.target.value } })}>
                <option value="">Choose a model…</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name === m.id ? m.id : `${m.name} (${m.id})`}
                  </option>
                ))}
              </Select>
            ) : (
              <Input id="agent-model" placeholder="Model id" value={draft.model.model} onChange={(e) => onChange({ ...draft, model: { ...draft.model, model: e.target.value } })} />
            )}
            {note && <p className="mt-1.5 text-[12.5px] text-warning">{note}</p>}
          </div>
          {!ENGINE_MODELS[source] && source !== 'local' && source !== 'test' && (
            <div>
              <Label htmlFor="agent-effort">Effort</Label>
              <Select id="agent-effort" value={draft.model.effort ?? ''} onChange={(e) => onChange({ ...draft, model: { ...draft.model, effort: (e.target.value || undefined) as AgentDraft['model']['effort'] } })}>
                <option value="">Default</option>
                <option value="low">Low (faster)</option>
                <option value="medium">Medium</option>
                <option value="high">High (smarter)</option>
              </Select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
