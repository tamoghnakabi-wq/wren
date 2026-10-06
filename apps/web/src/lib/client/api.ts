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

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}, retried = false): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
    headers: opts.form ? undefined : { 'content-type': 'application/json' },
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
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
    throw new ApiError(d?.error ?? `Request failed (${res.status})`, res.status, d?.code);
  }
  return data as T;
}
