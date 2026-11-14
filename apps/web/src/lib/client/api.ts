'use client';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

/** Shows the "confirm it's you" dialog (StepUpProvider); resolves true once verified. */
let stepUpHandler: (() => Promise<boolean>) | null = null;
export function setStepUpHandler(h: (() => Promise<boolean>) | null) {
  stepUpHandler = h;
}

/** What to say when the answer to a failed request didn't come from Wren's own API. */
export function outsideError(status: number): string {
  if (status === 413) return 'That’s too large to send.';
  if (status >= 500) return `Wren isn’t answering right now (${status}). Try again in a moment.`;
  return `Request failed (${status})`;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {}, retried = false): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
    headers: opts.form ? undefined : { 'content-type': 'application/json' },
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
    signal: opts.signal,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not Wren's own answer: the hosting platform's or a proxy's error page. Its text isn't for the user
    // ("Request Entity Too Large FUNCTION_PAYLOAD_TOO_LARGE syd1::…" was shown as it came).
    data = res.ok ? { error: text } : null;
  }
  if (!res.ok) {
    const d = data as { error?: string; code?: string } | null;
    // A sensitive action wants a fresh second step: ask for it, then try once more.
    if (res.status === 403 && d?.code === 'step_up_required' && stepUpHandler && !retried && (await stepUpHandler())) return api<T>(path, opts, true);
    // Two-step sign-in isn't finished in this session (e.g. it was turned on in another tab).
    if (res.status === 403 && d?.code === 'mfa_required' && typeof window !== 'undefined') {
      // A full page load on purpose: leave the app (and its data subscriptions) behind.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/auth/mfa?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
    // This sign-in was ended elsewhere (signed out, revoked): drop it and go to the sign-in page.
    if (res.status === 401 && d?.code === 'session_ended' && typeof window !== 'undefined') {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/auth/signout');
    }
    throw new ApiError(d?.error ?? outsideError(res.status), res.status, d?.code);
  }
  return data as T;
}
