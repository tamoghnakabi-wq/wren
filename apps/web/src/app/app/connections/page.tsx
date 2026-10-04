'use client';

import Link from 'next/link';
import { CheckCircle2, Circle, Cpu, Download, ExternalLink, KeyRound, Laptop, Monitor, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { GithubMark as Github } from '@/components/brand';
import { useState } from 'react';
import { useApp } from '@/components/app/provider';
import { Badge, Button, Card, cx, Dialog, Input, Label, PageHeader, Spinner, timeAgo, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';
import { desktop } from '@/lib/client/desktop';
import { useLive } from '@/lib/client/live';
import { isLiveDevice, type Connection, type Device } from '@/lib/client/types';

type Provider = 'openai' | 'anthropic' | 'xai' | 'gateway' | 'github' | 'mcp';

const KEY_HELP: Record<Provider, { title: string; url?: string; placeholder: string; help: string }> = {
  openai: { title: 'OpenAI API key', url: 'https://platform.openai.com/api-keys', placeholder: 'sk-…', help: 'Billed by OpenAI per token. Used for cloud runs, and on your computer when you prefer API billing.' },
  anthropic: { title: 'Anthropic API key', url: 'https://platform.claude.com/settings/keys', placeholder: 'sk-ant-…', help: 'Billed by Anthropic per token. Works in the cloud and on your computer.' },
  xai: { title: 'xAI API key', url: 'https://console.x.ai', placeholder: 'xai-…', help: 'Billed by xAI per token. Works in the cloud and on your computer.' },
  gateway: { title: 'Vercel AI Gateway key', url: 'https://vercel.com/docs/ai-gateway', placeholder: 'vck_…', help: 'One key for models from many providers, billed by Vercel.' },
  github: { title: 'GitHub token', url: 'https://github.com/settings/personal-access-tokens/new', placeholder: 'github_pat_…', help: 'Use a fine-grained token limited to the repositories agents may touch. Pushes, merges and other writes always ask for approval.' },
  mcp: { title: 'MCP server', placeholder: 'Optional bearer token', help: 'Connect any remote MCP server (Streamable HTTP) to give agents its tools. Read-only tools run freely; others ask first.' },
};

export default function ConnectionsPage() {
  const { userId, devices } = useApp();
  const conns = useLive<Connection>({ table: 'connections', eq: { user_id: userId }, order: { column: 'created_at', ascending: true }, realtimeFilter: { column: 'user_id', value: userId } });
  const [adding, setAdding] = useState<Provider | null>(null);
  const keys = (p: string) => conns.rows.filter((c) => c.provider === p);
  const anyDevice = (pred: (d: Device) => boolean) => devices.find(pred);

  return (
    <div>
      <PageHeader title="Connections" subtitle="How your agents think, what they can use, and where they can work." />

      <section className="mb-10">
        <h2 className="mb-1 text-lg font-semibold">Model access</h2>
        <p className="mb-4 max-w-2xl text-sm text-muted">
          Wren uses your existing subscriptions wherever the provider officially allows it — today that means on your own computer. Cloud agents need an API key because no provider currently lets third-party clouds use consumer plans.
        </p>
        {conns.loading ? (
          <Spinner />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <ProviderCard
              name="OpenAI"
              plan={{
                title: 'ChatGPT plan',
                sub: 'Plus or Pro, via official Sign in with ChatGPT',
                where: 'On your computer',
                device: anyDevice((d) => !!d.capabilities?.chatgpt?.signedIn),
                detail: (d) => (d.capabilities?.chatgpt?.email ? `Signed in as ${d.capabilities.chatgpt.email}` : 'Signed in'),
                action: <ChatGPTAction />,
              }}
              keys={keys('openai')}
              onAdd={() => setAdding('openai')}
              reload={conns.reload}
            />
            <ProviderCard
              name="Anthropic"
              plan={{
                title: 'Claude plan',
                sub: 'Pro or Max, via Anthropic’s own Claude Code app',
                where: 'On your computer',
                device: anyDevice((d) => !!d.capabilities?.claudeCode?.installed),
                detail: (d) => `Claude Code ${d.capabilities?.claudeCode?.version ?? ''} on ${d.name}`,
                action: <EngineAction engine="claude-code" install="https://code.claude.com/docs/en/setup" />,
              }}
              keys={keys('anthropic')}
              onAdd={() => setAdding('anthropic')}
              reload={conns.reload}
            />
            <ProviderCard
              name="xAI"
              plan={{
                title: 'Grok plan',
                sub: 'SuperGrok or X Premium, via xAI’s Grok Build CLI',
                where: 'On your computer',
                device: anyDevice((d) => !!d.capabilities?.grokBuild?.installed),
                detail: (d) => `Grok Build ${d.capabilities?.grokBuild?.version ?? ''} on ${d.name}`,
                action: <EngineAction engine="grok-build" install="https://docs.x.ai/build/overview" />,
              }}
              keys={keys('xai')}
              onAdd={() => setAdding('xai')}
              reload={conns.reload}
            />
            <ProviderCard
              name="More models"
              plan={{
                title: 'Local models',
                sub: 'LM Studio, Ollama or any OpenAI-compatible server',
                where: 'On your computer',
                device: anyDevice((d) => !!d.capabilities?.local?.reachable),
                detail: (d) => `${d.capabilities?.local?.models?.length ?? 0} models at ${d.capabilities?.local?.baseUrl}`,
                action: null,
              }}
              keys={keys('gateway')}
              keyLabel="Vercel AI Gateway"
              onAdd={() => setAdding('gateway')}
              reload={conns.reload}
            />
          </div>
        )}
        <p className="mt-4 text-[12.5px] text-faint">
          Why not log in to ChatGPT, Claude or Grok directly in the cloud? Anthropic forbids third-party apps from using Claude subscription logins, OpenAI allows plan usage only from open-source apps running on your machine (hosted apps need partner approval), and xAI hasn’t published a third-party sign-in. Wren follows these rules rather than scraping sessions.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="mb-4 text-lg font-semibold">Tools & services</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <ServiceCard icon={<Github className="h-5 w-5" />} title="GitHub" body="Repos, issues and pull requests through the GitHub API, plus git with your token on the agent’s computer." items={keys('github')} onAdd={() => setAdding('github')} reload={conns.reload} />
          <ServiceCard icon={<Plug className="h-5 w-5" />} title="MCP servers" body="Plug in Notion, Linear, your own APIs — any remote MCP server — and enable it per agent." items={keys('mcp')} onAdd={() => setAdding('mcp')} reload={conns.reload} multi />
        </div>
      </section>

      <section id="devices">
        <h2 className="mb-1 text-lg font-semibold">Your computers</h2>
        <p className="mb-4 text-sm text-muted">Agents can work on linked computers with the permissions you set there. Approvals can come from your phone.</p>
        <Devices />
      </section>

      {adding && <AddConnectionDialog provider={adding} onClose={() => setAdding(null)} onDone={conns.reload} />}
    </div>
  );
}

function ProviderCard({ name, plan, keys, keyLabel, onAdd, reload }: { name: string; plan: { title: string; sub: string; where: string; device?: Device; detail: (d: Device) => string; action: React.ReactNode }; keys: Connection[]; keyLabel?: string; onAdd: () => void; reload: () => void }) {
  return (
    <Card className="p-5">
      <h3 className="mb-3 font-semibold">{name}</h3>
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-xl border border-border p-3">
          {plan.device ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-success" /> : <Circle className="mt-0.5 h-5 w-5 text-faint" />}
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {plan.title} <Badge tone="brand">{plan.where}</Badge>
            </p>
            <p className="text-[12.5px] text-muted">{plan.device ? plan.detail(plan.device) : plan.sub}</p>
            {plan.action && <div className="mt-2">{plan.action}</div>}
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-border p-3">
          {keys.length ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-success" /> : <KeyRound className="mt-0.5 h-5 w-5 text-faint" />}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{keyLabel ?? 'API key'} <span className="font-normal text-faint">· cloud & computer</span></p>
            {keys.map((k) => (
              <KeyRow key={k.id} c={k} reload={reload} />
            ))}
            {!keys.length && <p className="text-[12.5px] text-muted">Pay-as-you-go with the provider.</p>}
            <Button size="sm" variant="secondary" className="mt-2" onClick={onAdd}>
              <Plus className="h-3.5 w-3.5" /> {keys.length ? 'Add another' : 'Add key'}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function KeyRow({ c, reload }: { c: Connection; reload: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-1 flex items-center gap-2 text-[12.5px]">
      <span className={cx('h-1.5 w-1.5 rounded-full', c.status === 'active' ? 'bg-success' : 'bg-danger')} />
      <span className="truncate">{c.label}</span>
      <span className="font-mono text-faint">{c.secret_hint}</span>
      {c.status === 'error' && <span className="truncate text-danger">{c.last_error}</span>}
      <span className="flex-1" />
      <button
        className="rounded p-1 text-faint hover:text-text"
        title="Test"
        aria-label="Test connection"
        onClick={async () => {
          setBusy(true);
          const r = await api<{ ok: boolean; error?: string }>(`/api/connections/${c.id}`, { body: {} }).catch((e) => ({ ok: false, error: (e as Error).message }));
          setBusy(false);
          toast(r.ok ? 'Connection works.' : `Failed: ${r.error}`, r.ok ? 'success' : 'error');
          reload();
        }}
      >
        <RefreshCw className={cx('h-3.5 w-3.5', busy && 'animate-spin')} />
      </button>
      <button
        className="rounded p-1 text-faint hover:text-danger"
        aria-label="Remove"
        onClick={async () => {
          if (!confirm(`Remove ${c.label}? Agents using it will stop working until you add another.`)) return;
          await api(`/api/connections/${c.id}`, { method: 'DELETE' });
          reload();
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ServiceCard({ icon, title, body, items, onAdd, reload, multi }: { icon: React.ReactNode; title: string; body: string; items: Connection[]; onAdd: () => void; reload: () => void; multi?: boolean }) {
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-subtle">{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-[13px] text-muted">{body}</p>
          <div className="mt-2">
            {items.map((c) => (
              <KeyRow key={c.id} c={c} reload={reload} />
            ))}
          </div>
          {(multi || !items.length) && (
            <Button size="sm" variant="secondary" className="mt-3" onClick={onAdd}>
              <Plus className="h-3.5 w-3.5" /> Connect
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function ChatGPTAction() {
  const d = desktop();
  const { desktop: status } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!d) return <p className="text-[12.5px] text-muted">Open the Wren desktop app → Settings → Model access → <b>Continue with ChatGPT</b>.</p>;
  if (status?.chatgpt.signedIn)
    return (
      <Button size="sm" variant="ghost" onClick={() => d.chatgptSignOut()}>
        Sign out of ChatGPT
      </Button>
    );
  return (
    <Button
      size="sm"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        const r = await d.chatgptSignIn();
        setBusy(false);
        if (r.ok) toast(r.planUsage ? 'You’re using your ChatGPT plan in Wren.' : 'Signed in, but ChatGPT plan usage wasn’t granted.', r.planUsage ? 'success' : 'error');
        else toast(r.error ?? 'Sign-in failed', 'error');
      }}
    >
      Continue with ChatGPT
    </Button>
  );
}

function EngineAction({ engine, install }: { engine: 'claude-code' | 'grok-build'; install: string }) {
  const d = desktop();
  const { desktop: status } = useApp();
  if (!d)
    return (
      <a href={install} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-muted underline">
        Install it on your computer <ExternalLink className="h-3 w-3" />
      </a>
    );
  const s = engine === 'claude-code' ? status?.engines.claudeCode : status?.engines.grokBuild;
  if (!s?.installed)
    return (
      <Button size="sm" variant="secondary" onClick={() => d.openExternal(install)}>
        How to install
      </Button>
    );
  return (
    <Button size="sm" variant="secondary" onClick={() => d.openEngineLogin(engine)}>
      {s.loggedIn ? 'Switch account' : 'Sign in'} (opens Terminal)
    </Button>
  );
}

function Devices() {
  const { devices } = useApp();
  const d = desktop();
  const toast = useToast();
  return (
    <div className="space-y-3">
      {devices.map((dev) => {
        const online = isLiveDevice(dev);
        const caps = dev.capabilities ?? {};
        return (
          <Card key={dev.id} className="flex flex-wrap items-center gap-3 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-subtle">{dev.platform === 'darwin' ? <Laptop className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}</span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-medium">
                {dev.name} <span className={cx('h-2 w-2 rounded-full', online ? 'bg-success' : 'bg-border-strong')} />
                <span className="text-[12px] font-normal text-faint">{online ? 'Online' : `Last seen ${timeAgo(dev.last_seen_at)}`}</span>
              </p>
              <p className="text-[12.5px] text-muted">
                {dev.platform === 'darwin' ? 'macOS' : dev.platform === 'win32' ? 'Windows' : dev.platform} · Wren {dev.app_version ?? '?'}
                {dev.policy?.folders?.length ? ` · ${dev.policy.folders.length} allowed folder${dev.policy.folders.length > 1 ? 's' : ''}` : ''}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {caps.chatgpt?.signedIn && <Badge tone="success">ChatGPT plan</Badge>}
                {caps.claudeCode?.installed && <Badge tone="success">Claude Code</Badge>}
                {caps.grokBuild?.installed && <Badge tone="success">Grok Build</Badge>}
                {caps.local?.reachable && (
                  <Badge tone="success">
                    <Cpu className="h-3 w-3" /> Local models
                  </Badge>
                )}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              onClick={async () => {
                if (!confirm(`Unlink ${dev.name}? It stops receiving tasks immediately.`)) return;
                await api(`/api/devices/${dev.id}`, { method: 'DELETE' }).catch((e) => toast((e as Error).message, 'error'));
              }}
            >
              Unlink
            </Button>
          </Card>
        );
      })}
      <Card className="flex flex-wrap items-center gap-3 border-dashed p-4">
        <Download className="h-5 w-5 text-muted" />
        <p className="flex-1 text-sm text-muted">{d ? 'This computer is running Wren. Manage its permissions in Settings.' : 'Install Wren for macOS or Windows, sign in, and it links automatically.'}</p>
        {!d && (
          <Link href="/download">
            <Button size="sm" variant="secondary">
              Download
            </Button>
          </Link>
        )}
      </Card>
    </div>
  );
}

function AddConnectionDialog({ provider, onClose, onDone }: { provider: Provider; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const help = KEY_HELP[provider];
  const [secret, setSecret] = useState('');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/connections', { body: { provider, secret, label: label || undefined, config: provider === 'mcp' ? { url } : undefined } });
      toast('Connected', 'success');
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Connect ${help.title}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={provider === 'mcp' ? !url : !secret}>
            Verify & connect
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">{help.help}</p>
        {provider === 'mcp' && (
          <div>
            <Label htmlFor="mcp-url">Server URL</Label>
            <Input id="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
          </div>
        )}
        <div>
          <Label htmlFor="conn-secret">{provider === 'mcp' ? 'Bearer token (optional)' : 'Key'}</Label>
          <Input id="conn-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={help.placeholder} />
          {help.url && (
            <a href={help.url} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] text-muted underline">
              Get one here <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div>
          <Label htmlFor="conn-label">Label (optional)</Label>
          <Input id="conn-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </div>
        <p className="text-[12.5px] text-faint">
          {provider === 'github'
            ? 'The token is verified and encrypted (AES-256-GCM). Wren uses it for GitHub API calls and gives it to git/gh on the agent’s cloud computer while a task with GitHub enabled runs — so keep it fine-grained.'
            : 'Keys are verified, then encrypted (AES-256-GCM) and only used by Wren’s servers to call the provider for your agents. They never enter an agent’s computer.'}
        </p>
        {error && <p className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
