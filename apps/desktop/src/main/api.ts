import { APP_URL, loadDevice } from './config';

// Authenticated calls to the Wren API as this device.

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function deviceFetch(path: string, init: RequestInit & { lease?: string } = {}): Promise<Response> {
  const d = loadDevice();
  if (!d) throw new ApiError('This computer is not linked.', 401, 'not_linked');
  const headers = new Headers(init.headers);
  headers.set('authorization', `Device ${d.token}`);
  if (init.lease) headers.set('x-wren-lease', init.lease);
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${d.appUrl ?? APP_URL}${path}`, { ...init, headers });
}

export async function deviceJson<T>(path: string, body?: unknown, opts: { lease?: string; method?: string; signal?: AbortSignal } = {}): Promise<T> {
  const res = await deviceFetch(path, { method: opts.method ?? (body === undefined ? 'GET' : 'POST'), body: body === undefined ? undefined : JSON.stringify(body), lease: opts.lease, signal: opts.signal });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const d = data as { error?: string; code?: string } | null;
    throw new ApiError(d?.error ?? `Request failed (${res.status})`, res.status, d?.code);
  }
  return data as T;
}

export async function publicJson<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${APP_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}
