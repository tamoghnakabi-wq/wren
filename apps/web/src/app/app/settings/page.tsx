'use client';

import { useRouter } from 'next/navigation';
import { BellRing, Check, ExternalLink, FolderPlus, Laptop, Moon, RefreshCw, Sun, SunMoon, X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { enablePush, pushState, type PushState } from '@/components/app/push';
import { useApp } from '@/components/app/provider';
import { SecuritySettings } from '@/components/app/security-settings';
import { Badge, Button, Card, cx, Input, Label, PageHeader, Select, Switch, useConfirm, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useDesktop, type DesktopPolicy, type DesktopStatus, type WrenDesktop } from '@/lib/client/desktop';
import { supabase } from '@/lib/client/supabase';

export default function SettingsPage() {
  const d = useDesktop();
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Settings" />
      <div className="space-y-8">
        <Profile />
        <ModelAccess />
        <Notifications />
        {d && <ThisComputer d={d} />}
        <Appearance />
        <SecuritySettings section={Section} row={Row} />
        <Account />
      </div>
    </div>
  );
}

function Section({ id, title, subtitle, children }: { id?: string; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle && <p className="mt-0.5 mb-3 text-sm text-muted">{subtitle}</p>}
      <Card className="mt-3 divide-y divide-border">{children}</Card>
    </section>
  );
}

function Row({ title, body, children }: { title: string; body?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:flex-nowrap">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {body && <div className="mt-0.5 text-[12.5px] text-muted">{body}</div>}
      </div>
      {children}
    </div>
  );
}

function Profile() {
  const { profile, email } = useApp();
  const toast = useToast();
  const [name, setName] = useState(profile?.display_name ?? '');
  const [tz, setTz] = useState(profile?.timezone ?? 'UTC');
  // When the saved profile changes (it loads, or another tab saves), show it.
  const saved = `${profile?.display_name ?? ''}|${profile?.timezone ?? 'UTC'}`;
  const [shownFor, setShownFor] = useState(saved);
  if (shownFor !== saved) {
    setShownFor(saved);
    setName(profile?.display_name ?? '');
    setTz(profile?.timezone ?? 'UTC');
  }
  const zones = [...new Set([tz, 'UTC', ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [])])];
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const save = async (body: object) => {
    try {
      await api('/api/account/settings', { body });
      toast('Saved', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Section title="Profile">
      <div className="space-y-4 px-4 py-4">
        <div>
          <Label htmlFor="s-name">Name</Label>
          <div className="flex gap-2">
            <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            <Button variant="secondary" disabled={!name.trim() || name === profile?.display_name} onClick={() => save({ displayName: name })}>
              Save
            </Button>
          </div>
          <p className="mt-1 text-[12.5px] text-faint">{email}</p>
        </div>
        <div>
          <Label htmlFor="s-tz" hint="Schedules and the agents' sense of “now” use this.">
            Time zone
          </Label>
          <div className="flex gap-2">
            <Select id="s-tz" value={tz} onChange={(e) => (setTz(e.target.value), save({ timezone: e.target.value }))}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
            {local !== tz && (
              <Button variant="secondary" onClick={() => (setTz(local), save({ timezone: local }))}>
                Use {local}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

function ModelAccess() {
  const { profile, devices, desktop: status } = useApp();
  const toast = useToast();
  const access = profile?.settings?.openaiAccess ?? 'chatgpt';
  const fallback = profile?.settings?.openaiAllowFallback !== false;
  const signedInSomewhere = devices.some((d) => d.capabilities?.chatgpt?.signedIn);
  const d = useDesktop();
  const [busy, setBusy] = useState(false);
  const save = async (settings: object) => {
    try {
      await api('/api/account/settings', { body: { settings } });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Section id="model-access" title="Model access" subtitle="Choose how OpenAI models are paid for. You can switch any time.">
      <div className="space-y-2 px-4 py-4">
        {(
          [
            { id: 'chatgpt', title: 'Use my ChatGPT plan', badge: 'Recommended for Plus & Pro', body: 'Eligible requests use the usage included in your ChatGPT plan via official Sign in with ChatGPT. Works for agents running on your computer.' },
            { id: 'api', title: 'Use my OpenAI API key', badge: null, body: 'Pay-as-you-go API billing on your OpenAI Platform account. Works everywhere, including cloud agents.' },
          ] as const
        ).map((o) => (
          <button key={o.id} onClick={() => save({ openaiAccess: o.id })} className={cx('relative w-full rounded-2xl border p-4 text-left transition', access === o.id ? 'border-text bg-surface shadow-card' : 'border-border hover:border-border-strong')}>
            <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {o.title} {o.badge && <Badge tone="brand">{o.badge}</Badge>}
            </span>
            <span className="mt-1 block pr-6 text-[13px] text-muted">{o.body}</span>
            {access === o.id && <Check className="absolute top-4 right-4 h-4 w-4" />}
          </button>
        ))}
      </div>
      <Row title="Use the other option when the preferred one isn’t available" body={access === 'chatgpt' ? 'For example, when this computer isn’t signed in to ChatGPT, use your API key instead (if you added one).' : 'If no API key is connected, use your ChatGPT plan on computers where you signed in.'}>
        <Switch label="Fallback" checked={fallback} onChange={(v) => save({ openaiAllowFallback: v })} />
      </Row>
      <Row
        title="ChatGPT on this computer"
        body={
          d ? (
            status?.chatgpt.signedIn ? (
              <>
                Signed in{status.chatgpt.email ? ` as ${status.chatgpt.email}` : ''}. {status.chatgpt.planUsage ? 'Using your ChatGPT plan.' : 'Plan usage was not granted.'}
              </>
            ) : (
              'Not signed in.'
            )
          ) : signedInSomewhere ? (
            `Signed in on ${devices.filter((x) => x.capabilities?.chatgpt?.signedIn).map((x) => x.name).join(', ')}.`
          ) : (
            'Sign in from the Wren desktop app on each computer you want to use it on.'
          )
        }
      >
        {d &&
          (status?.chatgpt.signedIn ? (
            <Button size="sm" variant="secondary" onClick={() => d.chatgptSignOut()}>
              Sign out
            </Button>
          ) : (
            <Button
              size="sm"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const r = await d.chatgptSignIn();
                setBusy(false);
                if (!r.ok) toast(r.error ?? 'Sign-in failed', 'error');
              }}
            >
              Continue with ChatGPT
            </Button>
          ))}
      </Row>
      <Row title="ChatGPT plan usage" body="Review usage and set limits for Wren in your ChatGPT settings.">
        <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">
          <Button size="sm" variant="secondary">
            Manage usage <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </a>
      </Row>
    </Section>
  );
}

function Notifications() {
  const toast = useToast();
  const d = useDesktop();
  // The browser's permission (read after hydration), unless this page just changed it.
  const current = useSyncExternalStore(noSubscribe, pushState, () => 'unsupported' as PushState);
  const [changed, setState] = useState<PushState | null>(null);
  const state = changed ?? current;
  return (
    <Section title="Notifications" subtitle="Get told when agents finish, ask a question, or need approval.">
      <Row
        title="Push notifications on this device"
        body={
          state === 'granted'
            ? 'On for this browser.'
            : state === 'denied'
              ? 'Blocked in your browser settings.'
              : state === 'needs-install'
                ? 'On iPhone and iPad: tap Share → Add to Home Screen, open Wren from the Home Screen, then turn this on.'
                : state === 'unsupported'
                  ? d
                    ? 'The desktop app shows native notifications.'
                    : 'This browser does not support push notifications.'
                  : 'Off'
        }
      >
        {state === 'default' && (
          <Button size="sm" onClick={async () => setState(await enablePush())}>
            <BellRing className="h-4 w-4" /> Turn on
          </Button>
        )}
        {state === 'granted' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              const r = await api<{ sent: number }>('/api/push/test', { body: {} });
              toast(r.sent ? 'Test notification sent.' : 'No subscribed devices yet.');
            }}
          >
            Send test
          </Button>
        )}
      </Row>
    </Section>
  );
}

function ThisComputer({ d }: { d: WrenDesktop }) {
  const { desktop: status } = useApp();
  const [policy, setPolicy] = useState<DesktopPolicy | null>(null);
  useEffect(() => {
    d.getPolicy().then(setPolicy);
  }, [d]);
  const update = async (p: Partial<DesktopPolicy>) => setPolicy(await d.setPolicy(p));
  if (!policy) return null;
  return (
    <Section title="This computer" subtitle="These permissions are stored on this computer and can only be changed here — not from the web or your phone.">
      <Row title={status?.deviceName ?? 'This computer'} body={status?.linked ? `Linked to ${status.account?.email ?? 'your account'} · Wren ${status.version}` : 'Not linked'}>
        <Laptop className="h-5 w-5 text-faint" />
      </Row>
      <div className="px-4 py-3.5">
        <p className="text-sm font-medium">Folders agents may use</p>
        <p className="text-[12.5px] text-muted">
          {status?.platform === 'win32'
            ? 'Agents’ file tools work only inside these folders. Windows has no sandbox for terminal commands: anything that can change files asks you first, but read-only commands can still see other files.'
            : 'Agents’ file tools work only inside these folders. Terminal commands run in a macOS sandbox: they can’t change anything outside these folders or read the rest of your home folder (developer tool settings and caches excepted).'}
        </p>
        <ul className="mt-2 space-y-1">
          {policy.folders.map((f) => (
            <li key={f} className="flex items-center gap-2 rounded-lg bg-bg-subtle px-3 py-1.5 font-mono text-[12.5px]">
              <span className="min-w-0 flex-1 truncate">{f}</span>
              <button onClick={() => update({ folders: policy.folders.filter((x) => x !== f) })} className="text-faint hover:text-danger" aria-label={`Remove ${f}`}>
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <Button size="sm" variant="secondary" className="mt-2" onClick={async () => setPolicy(await d.addFolder())}>
          <FolderPlus className="h-4 w-4" /> Add folder
        </Button>
      </div>
      <Row title="Terminal commands" body="Run commands in allowed folders. Risky commands still ask first.">
        <Switch label="Terminal" checked={policy.shell} onChange={(v) => update({ shell: v })} />
      </Row>
      <Row title="Browser" body="Let agents drive a separate Chrome window (your normal profile is never used).">
        <Switch label="Browser" checked={policy.browser} onChange={(v) => update({ browser: v })} />
      </Row>
      <Row title="Screen capture" body="Allow agents to request screenshots of your screen (always asks).">
        <Switch label="Screen" checked={policy.screen} onChange={(v) => update({ screen: v })} />
      </Row>
      <Row title="Approve from other devices" body="Let approvals from your phone or the web unlock actions on this computer. Off means only this computer can approve.">
        <Switch label="Remote approvals" checked={policy.remoteApprovals} onChange={(v) => update({ remoteApprovals: v })} />
      </Row>
      <div className="px-4 py-3.5">
        <Label htmlFor="s-local" hint="An OpenAI-compatible server such as LM Studio (http://127.0.0.1:1234/v1) or Ollama (http://127.0.0.1:11434/v1).">
          Local model server
        </Label>
        <div className="flex gap-2">
          <Input id="s-local" defaultValue={policy.localModelUrl} onBlur={(e) => e.target.value !== policy.localModelUrl && update({ localModelUrl: e.target.value })} />
          <Badge tone={status?.local.reachable ? 'success' : 'neutral'}>{status?.local.reachable ? `${status.local.models.length} models` : 'Not reachable'}</Badge>
        </div>
      </div>
      <UpdateRow d={d} status={status} />
    </Section>
  );
}

const sentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);

/** The desktop app's self-updater. Older desktop builds report less (no progress, no retry time), and this copes with both. */
function UpdateRow({ d, status }: { d: WrenDesktop; status: DesktopStatus | null | undefined }) {
  const toast = useToast();
  const u = status?.update;
  const manual = (
    <button type="button" className="underline underline-offset-2 hover:text-text" onClick={() => d.openExternal(`${location.origin}/download`)}>
      download it yourself
    </button>
  );
  const pct = u?.downloading && u.total ? Math.min(100, Math.floor(((u.received ?? 0) / u.total) * 100)) : null;
  let body: React.ReactNode;
  if (u?.ready) body = `Version ${u.version} is ready to install.${u.error ? ` ${sentence(u.error)}` : ''}`;
  else if (u?.downloading)
    body =
      pct === null ? (
        // Builds before 0.1.9 don't report progress, so there's no telling whether they're stuck.
        <>Downloading {u.version}… If this doesn’t finish, {manual}.</>
      ) : (
        <>
          Downloading {u.version}… {pct}% of {Math.round(u.total! / 1e6)} MB
          <span role="progressbar" aria-label={`Downloading Wren ${u.version}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="mt-1.5 block h-1 max-w-64 overflow-hidden rounded-full bg-border">
            <span className="block h-full rounded-full bg-brand-solid transition-[width] duration-700" style={{ width: `${pct}%` }} />
          </span>
        </>
      );
  else if (u?.available && u.error)
    body = (
      <>
        Couldn’t download {u.version}: {sentence(u.error)}
        {u.retryAt ? ` Wren will try again at ${new Date(u.retryAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.` : ''} You can also {manual}.
      </>
    );
  else if (u?.error) body = sentence(u.error);
  else body = `You’re on ${status?.version}.`;
  return (
    <Row title="Updates" body={body}>
      {u?.ready ? (
        <Button size="sm" onClick={() => d.installUpdate()}>
          Restart & update
        </Button>
      ) : u?.downloading ? null : (
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            const r = await d.checkUpdate();
            if (r?.ready) toast(`Version ${r.version} is ready to install.`, 'success');
            else if (r?.downloading) toast(`Downloading ${r.version}…`);
            else if (r?.error) toast(r.available ? `Couldn’t download ${r.version}: ${sentence(r.error)}` : sentence(r.error), 'error');
            else toast('Wren is up to date.');
          }}
        >
          <RefreshCw className="h-4 w-4" /> {u?.error ? 'Try again' : 'Check'}
        </Button>
      )}
    </Row>
  );
}

const THEME_EVENT = 'wren-theme';
const readTheme = () => {
  try {
    return localStorage.getItem('wren-theme') ?? 'system';
  } catch {
    return 'system';
  }
};
const subscribeTheme = (cb: () => void) => {
  window.addEventListener('storage', cb);
  window.addEventListener(THEME_EVENT, cb);
  return () => {
    window.removeEventListener('storage', cb);
    window.removeEventListener(THEME_EVENT, cb);
  };
};
function noSubscribe() {
  return () => {};
}

function Appearance() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => 'system');
  const apply = (t: string) => {
    try {
      localStorage.setItem('wren-theme', t);
    } catch {}
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    window.dispatchEvent(new Event(THEME_EVENT));
  };
  return (
    <Section title="Appearance">
      <div className="grid grid-cols-3 gap-2 px-4 py-4" role="radiogroup" aria-label="Theme">
        {[
          { id: 'system', label: 'System', Icon: SunMoon },
          { id: 'light', label: 'Light', Icon: Sun },
          { id: 'dark', label: 'Dark', Icon: Moon },
        ].map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={theme === o.id}
            onClick={() => apply(o.id)}
            className={cx(
              'relative flex flex-col items-center gap-1.5 rounded-xl border py-3 text-sm transition-[border-color,box-shadow,color,background-color] duration-150',
              theme === o.id ? 'border-brand bg-brand-soft/40 font-medium text-text ring-4 ring-[var(--ring)]' : 'border-border text-muted hover:border-border-strong hover:text-text',
            )}
          >
            <o.Icon className="h-5 w-5" aria-hidden /> {o.label}
            {theme === o.id && <Check className="absolute top-2 right-2 h-3.5 w-3.5 text-brand" aria-hidden />}
          </button>
        ))}
      </div>
    </Section>
  );
}

function Account() {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [deleting, setDeleting] = useState(false);
  return (
    <Section title="Account">
      <Row title="Sign out" body="Signs out of this browser.">
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await supabase().auth.signOut();
            router.replace('/login');
            router.refresh();
          }}
        >
          Sign out
        </Button>
      </Row>
      <Row title="Delete account" body="Permanently deletes your agents, tasks, files, connections and linked devices.">
        <Button
          size="sm"
          variant="danger"
          loading={deleting}
          onClick={async () => {
            const ok = await confirm({
              title: 'Delete your account?',
              body: 'This permanently deletes your agents, tasks, files, connections and linked computers. It can’t be undone.',
              confirmLabel: 'Delete account',
              danger: true,
              typeToConfirm: 'DELETE',
            });
            if (!ok) return;
            setDeleting(true);
            try {
              await api('/api/account/settings', { method: 'DELETE', body: { confirm: 'DELETE' } });
              await supabase().auth.signOut();
              router.replace('/');
            } catch (e) {
              toast((e as Error).message, 'error');
              setDeleting(false);
            }
          }}
        >
          Delete
        </Button>
      </Row>
    </Section>
  );
}
