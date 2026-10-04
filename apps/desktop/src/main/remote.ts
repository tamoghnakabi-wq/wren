import type { ApprovalRequest, ApprovalState, ModelClient, ModelRequest, ModelStreamEvent, ModelTurn, ModelUsage, RunStore, SessionEvent } from '@wren/core';
import { ModelError } from '@wren/core';
import { deviceFetch, deviceJson } from './api';

// RunStore over the device API: the desktop runs the loop, the server keeps
// the durable log, approvals and notifications.

export class RemoteStore implements RunStore {
  /** Who actually paid for model calls (e.g. "chatgpt" when using the ChatGPT plan). */
  usageSource: string | undefined;
  /** Called when an approval is created (desktop may show a native prompt). */
  onApproval?: (id: string, req: ApprovalRequest) => void;

  /** With remote approvals off, only a decision made on this computer counts. */
  localOnlyApprovals = false;

  constructor(
    private readonly runId: string,
    readonly lease: string,
  ) {}

  private call<T>(action: string, body?: unknown) {
    return deviceJson<T>(`/api/device/runs/${this.runId}/${action}`, body ?? {}, { lease: this.lease });
  }

  async events(): Promise<SessionEvent[]> {
    return (await this.call<{ events: SessionEvent[] }>('events')).events;
  }
  async append<T>(type: SessionEvent['type'], data: T, status?: string): Promise<SessionEvent<T>> {
    return this.call<SessionEvent<T>>('append', { type, data: stripInline(data), status });
  }
  async update(id: string, patch: { data?: unknown; status?: string }): Promise<void> {
    await this.call('update', { id, data: patch.data === undefined ? undefined : stripInline(patch.data), status: patch.status });
  }
  async control() {
    return this.call<{ cancel: boolean; pause: boolean }>('control');
  }
  async createApproval(req: ApprovalRequest): Promise<string> {
    const { id } = await this.call<{ id: string }>('approval', { ...req, localOnly: this.localOnlyApprovals });
    this.onApproval?.(id, req);
    return id;
  }
  async approvalState(id: string): Promise<ApprovalState> {
    return (await this.call<{ state: ApprovalState }>('approval-state', { id })).state;
  }
  async recordUsage(u: ModelUsage, model: string): Promise<void> {
    await this.call('usage', { ...u, model, source: this.usageSource });
  }
  async notify(title: string, body: string, kind: string): Promise<void> {
    await this.call('notify', { title, body, kind });
  }
  memory = {
    add: async (fact: string) => (await this.call<{ id: string }>('memory', { op: 'add', value: fact })).id,
    remove: async (id: string) => (await this.call<{ ok: boolean }>('memory', { op: 'remove', value: id })).ok,
  };
}

function stripInline(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  return JSON.parse(JSON.stringify(data, (k, v) => (k === 'data' && typeof v === 'string' && v.length > 2000 ? undefined : v)));
}

/** Model client that asks the server to call the provider with the user's stored key. */
export class ProxyModelClient implements ModelClient {
  constructor(
    private readonly runId: string,
    private readonly lease: string,
    private readonly source: string,
    private readonly connectionId?: string,
  ) {}
  get label() {
    return `proxy:${this.source}`;
  }

  async stream(req: ModelRequest, onEvent: (e: ModelStreamEvent) => void): Promise<ModelTurn> {
    const res = await deviceFetch(`/api/device/runs/${this.runId}/model`, {
      method: 'POST',
      lease: this.lease,
      signal: req.signal,
      body: JSON.stringify({ source: this.source, model: req.model, connectionId: this.connectionId, effort: req.effort, instructions: req.instructions, tools: req.tools, hosted: req.hosted }),
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      let msg = t;
      try {
        msg = JSON.parse(t).error ?? t;
      } catch {
        /* text */
      }
      throw new ModelError(msg || `Model proxy failed (${res.status})`, res.status, undefined, res.status >= 500);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as ModelStreamEvent | { type: 'final'; turn: ModelTurn } | { type: 'error'; message: string; status?: number; code?: string; retryable?: boolean };
        if (ev.type === 'final') return ev.turn;
        if (ev.type === 'error') throw new ModelError(ev.message, ev.status, ev.code, !!ev.retryable);
        onEvent(ev);
      }
    }
    throw new ModelError('The model stream ended unexpectedly.', undefined, 'stream_interrupted', true);
  }
}
