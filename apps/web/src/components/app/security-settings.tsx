'use client';

import { Copy, Download, KeyRound, Mail, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { formatRecoveryCode, mfaError, mfaInfo, sendEmailCode, verifyEmailCode, type MfaInfo } from '@/lib/client/mfa';
import { supabase } from '@/lib/client/supabase';
import { Badge, Button, Dialog, Input, Label, useConfirm, useToast } from '../ui';
import { useStepUp } from './step-up';

// Settings → Security: two-step sign-in. Authenticator apps and recovery codes are Supabase Auth
// MFA factors managed from the browser (Supabase itself requires an aal2 session to remove or
// replace them); email codes are Wren's (turned on and off through the API). Changes ask the user
// to confirm with their second step first.

interface Factor {
  id: string;
  friendly_name?: string;
  created_at: string;
}

async function loadSecurity() {
  const sb = supabase();
  const [info, f] = await Promise.all([mfaInfo(), sb.auth.mfa.listFactors()]);
  const factors = ((f.data?.totp ?? []) as (Factor & { status: string })[]).filter((x) => x.status === 'verified');
  let codesLeft: { remaining: number; total: number } | null = null;
  if (info?.recoveryCodes) {
    const st = await sb.auth.mfa.recoveryCodes.getStatus();
    if (st.data) codesLeft = { remaining: st.data.remaining, total: st.data.total };
  }
  return { info, factors, codesLeft };
}

export function SecuritySettings({ section: Section, row: Row }: { section: React.ComponentType<{ title: string; subtitle?: string; children: React.ReactNode }>; row: React.ComponentType<{ title: string; body?: React.ReactNode; children?: React.ReactNode }> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const stepUp = useStepUp();
  const [info, setInfo] = useState<MfaInfo | null>(null);
  const [factors, setFactors] = useState<Factor[]>([]);
  const [codesLeft, setCodesLeft] = useState<{ remaining: number; total: number } | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [emailOn, setEmailOn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    loadSecurity().then((r) => {
      if (cancelled) return;
      setInfo(r.info);
      setFactors(r.factors);
      setCodesLeft(r.codesLeft);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  if (!info) return null;
  const hasApp = factors.length > 0;

  async function removeFactor(f: Factor) {
    if (!(await stepUp())) return;
    const last = factors.length === 1;
    const ok = await confirm({
      title: 'Remove this authenticator app?',
      body: last ? 'Signing in will only need your password again, and your recovery codes stop working.' : 'You can still sign in with your other authenticator app.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setBusy(f.id);
    try {
      const sb = supabase();
      // Recovery codes can't be the only factor (Supabase would still ask for one at sign-in).
      if (last && info?.recoveryCodes) {
        const r = await sb.auth.mfa.recoveryCodes.unenroll();
        if (r.error && r.error.code !== 'mfa_factor_not_found') throw new Error(mfaError(r.error));
      }
      const { error } = await sb.auth.mfa.unenroll({ factorId: f.id });
      if (error) throw new Error(mfaError(error));
      await sb.auth.refreshSession();
      toast('Authenticator app removed.', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
      reload();
    }
  }

  async function newCodes() {
    if (!(await stepUp())) return;
    setBusy('codes');
    try {
      const sb = supabase();
      const r = info?.recoveryCodes ? await sb.auth.mfa.recoveryCodes.regenerate() : await sb.auth.mfa.recoveryCodes.generate();
      if (r.error) throw new Error(mfaError(r.error));
      setCodes(r.data.codes);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
      reload();
    }
  }

  async function turnOffEmail() {
    const ok = await confirm({ title: 'Turn off email codes?', body: 'Signing in will only need your password.', confirmLabel: 'Turn off', danger: true });
    if (!ok) return;
    setBusy('email');
    try {
      await api('/api/mfa/email', { method: 'DELETE' }); // asks to confirm with a code first if needed
      toast('Email codes turned off.', 'success');
    } catch (e) {
      if ((e as ApiError).code !== 'step_up_required') toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
      reload();
    }
  }

  return (
    <Section title="Security" subtitle="Two-step sign-in asks for a code after your password. Deleting your account and linking a computer ask for it again.">
      <Row
        title="Authenticator app"
        body={
          hasApp ? (
            <span className="flex flex-col gap-1">
              {factors.map((f) => (
                <span key={f.id} className="flex items-center gap-2">
                  <Smartphone className="h-3.5 w-3.5" aria-hidden /> {f.friendly_name || 'Authenticator app'}
                  <button type="button" className="underline underline-offset-2 hover:text-text disabled:opacity-50" disabled={busy === f.id} onClick={() => removeFactor(f)} aria-label={`Remove ${f.friendly_name || 'Authenticator app'}`}>
                    Remove
                  </button>
                </span>
              ))}
            </span>
          ) : (
            'Get a code from an app like 1Password, Google Authenticator or Authy each time you sign in.'
          )
        }
      >
        {hasApp ? <Badge tone="success">On</Badge> : null}
        <Button size="sm" variant={hasApp ? 'secondary' : 'primary'} onClick={async () => (await stepUp()) && setEnrolling(true)} aria-label={hasApp ? 'Add another authenticator app' : 'Set up an authenticator app'}>
          {hasApp ? 'Add another' : 'Set up'}
        </Button>
      </Row>
      {hasApp && (
        <Row title="Recovery codes" body={codesLeft ? `${codesLeft.remaining} of ${codesLeft.total} left. Use one to sign in if you lose your phone.` : 'One-time codes for signing in if you lose your phone.'}>
          {codesLeft?.remaining === 0 && <Badge tone="warning">None left</Badge>}
          <Button size="sm" variant="secondary" loading={busy === 'codes'} onClick={newCodes} aria-label={codesLeft ? 'Get new recovery codes' : 'Create recovery codes'}>
            <KeyRound className="h-4 w-4" /> {codesLeft ? 'Get new codes' : 'Create codes'}
          </Button>
        </Row>
      )}
      {!hasApp && (
        <Row title="Email codes" body={info.email ? `On. Signing in asks for a code sent to ${info.emailHint}.` : 'Get a code by email each time you sign in. An authenticator app is safer: it doesn’t depend on your email account.'}>
          {info.email ? <Badge tone="success">On</Badge> : null}
          <Button size="sm" variant="secondary" loading={busy === 'email'} onClick={() => (info.email ? turnOffEmail() : setEmailOn(true))} aria-label={info.email ? 'Turn off email codes' : 'Turn on email codes'}>
            <Mail className="h-4 w-4" /> {info.email ? 'Turn off' : 'Turn on'}
          </Button>
        </Row>
      )}
      {enrolling && (
        <EnrollDialog
          info={info}
          existing={factors}
          onClose={() => setEnrolling(false)}
          onDone={(c) => {
            setEnrolling(false);
            if (c) setCodes(c);
            reload();
          }}
        />
      )}
      {emailOn && (
        <EmailOnDialog
          hint={info.emailHint}
          onClose={() => {
            setEmailOn(false);
            reload();
          }}
        />
      )}
      <Dialog open={!!codes} onClose={() => setCodes(null)} title="Save your recovery codes" footer={<Button onClick={() => setCodes(null)}>I’ve saved them</Button>}>
        {codes && <RecoveryCodes codes={codes} />}
      </Dialog>
    </Section>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const toast = useToast();
  const text = codes.map(formatRecoveryCode).join('\n');
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Each code signs you in once if you lose your authenticator app. Keep them somewhere safe, like a password manager. They won’t be shown again.</p>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl border border-border bg-bg-subtle px-4 py-3 font-mono text-[13px]" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{formatRecoveryCode(c)}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(text).then(() => toast('Copied.', 'success'))}>
          <Copy className="h-4 w-4" /> Copy
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([`Wren recovery codes\n\n${text}\n`], { type: 'text/plain' }));
            a.download = 'wren-recovery-codes.txt';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          <Download className="h-4 w-4" /> Download
        </Button>
      </div>
    </div>
  );
}

/** Add an authenticator app: scan, enter a code, then (first app only) save recovery codes. */
function EnrollDialog({ info, existing, onClose, onDone }: { info: MfaInfo; existing: Factor[]; onClose: () => void; onDone: (codes: string[] | null) => void }) {
  const toast = useToast();
  const [factor, setFactor] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One enrollment per dialog, even if the effect runs twice (React's development mode does that).
  const started = useRef<Promise<{ id: string; qr: string; secret: string } | { error: string }> | null>(null);
  useEffect(() => {
    let cancelled = false;
    started.current ??= (async () => {
      const sb = supabase();
      // Leftovers from a setup that was never finished.
      const all = (await sb.auth.mfa.listFactors()).data?.all ?? [];
      for (const f of all) if (f.factor_type === 'totp' && f.status === 'unverified') await sb.auth.mfa.unenroll({ factorId: f.id });
      const names = new Set(all.filter((f) => f.status === 'verified').map((f) => f.friendly_name));
      let name = 'Authenticator app';
      for (let i = 2; names.has(name); i++) name = `Authenticator app ${i}`;
      const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: name, issuer: 'Wren' });
      return error ? { error: mfaError(error) } : { id: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
    })();
    started.current.then((r) => {
      if (cancelled) return;
      if ('error' in r) setError(r.error);
      else setFactor(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!factor) return;
    setBusy(true);
    setError(null);
    try {
      const sb = supabase();
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.replace(/\s+/g, '') });
      if (error) throw new Error(mfaError(error));
      // The session is aal2 now. Email codes give way to the app (the step-up from a moment ago
      // covers turning them off); the first app also gets recovery codes.
      if (info.email) await api('/api/mfa/email', { method: 'DELETE' }).catch(() => {});
      let codes: string[] | null = null;
      if (!info.recoveryCodes && existing.length === 0) {
        const r = await sb.auth.mfa.recoveryCodes.generate();
        if (r.error) toast(`Authenticator app added, but recovery codes couldn’t be created: ${mfaError(r.error)}`, 'error');
        else codes = r.data.codes;
      }
      toast('Two-step sign-in is on.', 'success');
      onDone(codes);
    } catch (err) {
      setError((err as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    if (factor) void supabase().auth.mfa.unenroll({ factorId: factor.id }); // not finished: don't leave it behind
    onClose();
  };

  return (
    <Dialog open onClose={close} title="Set up an authenticator app">
      <form onSubmit={verify} className="space-y-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Open your authenticator app and add an account.</li>
          <li>Scan this code, or enter the key by hand.</li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        {factor ? (
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            {/* eslint-disable-next-line @next/next/no-img-element -- a data: SVG from Supabase Auth */}
            <img src={factor.qr} alt="QR code to add Wren to your authenticator app" width={176} height={176} className="rounded-xl border border-border bg-white p-2" />
            <div className="min-w-0 text-[12.5px] text-muted">
              <p>Key</p>
              <p className="mt-0.5 font-mono text-[13px] break-words text-text select-all">{factor.secret.match(/.{1,4}/g)?.join(' ')}</p>
            </div>
          </div>
        ) : (
          !error && <p className="text-sm text-muted">Preparing…</p>
        )}
        <div>
          <Label htmlFor="enroll-code">Code from the app</Label>
          <Input id="enroll-code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={10} required className="font-mono tracking-widest" />
        </div>
        {error && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!factor}>
            Turn on
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Turn on email codes: prove the inbox works with one first. */
function EmailOnDialog({ hint, onClose }: { hint: string; onClose: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [note, setNote] = useState(`Sending a code to ${hint}…`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sendEmailCode('enable').then(
      () => setNote(`We sent a code to ${hint}. Enter it to turn on email codes.`),
      (e: ApiError) => (e.code === 'code_cooldown' ? setNote(`A code was sent to ${hint} a moment ago.`) : setError(e.message)),
    );
  }, [hint]);

  return (
    <Dialog open onClose={onClose} title="Turn on email codes">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await verifyEmailCode(code);
            toast('Email codes are on.', 'success');
            onClose();
          } catch (err) {
            setError((err as Error).message);
            setCode('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-muted">{note}</p>
        <div>
          <Label htmlFor="email-on-code">Code from the email</Label>
          <Input id="email-on-code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={10} required autoFocus className="font-mono tracking-widest" />
        </div>
        {error && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Turn on
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
