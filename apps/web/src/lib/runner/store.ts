import type { ApprovalRequest, ApprovalState, ModelUsage, RunStore, SessionEvent } from '@wren/core';
import { db, type Json } from '../db';
import { notifyUser } from '../notify';

// RunStore backed by Postgres. Every write bumps the session's last_event_at
// so lists sort by activity; Realtime pushes the rows to open browsers.

export interface RunRefs {
  runId: string;
  sessionId: string;
  agentId: string;
  userId: string;
  agentName: string;
  source: string;
}

type Row = { id: string; seq: string | number; run_id: string | null; type: string; status: string | null; data: unknown; created_at: Date };

export const toEvent = (r: Row): SessionEvent => ({
  id: r.id,
  seq: Number(r.seq),
  runId: r.run_id,
  type: r.type as SessionEvent['type'],
  status: r.status,
  data: r.data,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
});

/** Strip inline image bytes before persisting; images live in Blob storage. */
export function stripInline(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as Record<string, unknown>;
  const result = d.result as { images?: { data?: string }[] } | undefined;
  if (result?.images?.some((i) => i.data)) {
    return { ...d, result: { ...result, images: result.images.map(({ data: _drop, ...rest }) => rest) } };
  }
  if (Array.isArray(d.images) && (d.images as { data?: string }[]).some((i) => i.data)) {
    return { ...d, images: (d.images as { data?: string }[]).map(({ data: _drop, ...rest }) => rest) };
  }
  return data;
}

export class DbRunStore implements RunStore {
  constructor(private readonly r: RunRefs) {}

  async events(): Promise<SessionEvent[]> {
    const rows = await db()<Row[]>`
      select id, seq, run_id, type, status, data, created_at from public.events
      where session_id = ${this.r.sessionId} order by seq`;
    return rows.map(toEvent);
  }

  async append<T>(type: SessionEvent['type'], data: T, status?: string): Promise<SessionEvent<T>> {
    const sql = db();
    const [row] = await sql<Row[]>`
      insert into public.events (user_id, session_id, run_id, type, status, data)
      values (${this.r.userId}, ${this.r.sessionId}, ${this.r.runId}, ${type}, ${status ?? null}, ${sql.json(stripInline(data) as Json)})
      returning id, seq, run_id, type, status, data, created_at`;
    await sql`update public.sessions set last_event_at = now() where id = ${this.r.sessionId}`;
    return toEvent(row) as SessionEvent<T>;
  }

  async update(id: string, patch: { data?: unknown; status?: string }): Promise<void> {
    const sql = db();
    if (patch.data !== undefined && patch.status !== undefined) {
      await sql`update public.events set data = ${sql.json(stripInline(patch.data) as Json)}, status = ${patch.status} where id = ${id} and session_id = ${this.r.sessionId}`;
    } else if (patch.data !== undefined) {
      await sql`update public.events set data = ${sql.json(stripInline(patch.data) as Json)} where id = ${id} and session_id = ${this.r.sessionId}`;
    } else if (patch.status !== undefined) {
      await sql`update public.events set status = ${patch.status} where id = ${id} and session_id = ${this.r.sessionId}`;
    }
  }

  async control() {
    const [r] = await db()`select cancel_requested, pause_requested from public.runs where id = ${this.r.runId}`;
    return { cancel: !!r?.cancel_requested, pause: !!r?.pause_requested };
  }

  async createApproval(req: ApprovalRequest): Promise<string> {
    const sql = db();
    const [row] = await sql`
      insert into public.approvals (user_id, agent_id, session_id, run_id, event_id, tool, title, detail, risk)
      values (${this.r.userId}, ${this.r.agentId}, ${this.r.sessionId}, ${this.r.runId}, ${req.eventId}, ${req.tool}, ${req.title.slice(0, 300)},
              ${sql.json({ args: req.args as Json, reason: req.reason ?? null })}, ${req.risk})
      returning id`;
    await notifyUser({
      userId: this.r.userId,
      kind: 'approval',
      title: `${this.r.agentName} needs your approval`,
      body: `${req.title}${req.reason ? ` — ${req.reason}` : ''}`,
      url: `/app/s/${this.r.sessionId}?approval=${row.id}`,
      sessionId: this.r.sessionId,
      tag: `approval-${row.id}`,
    });
    return row.id;
  }

  async approvalState(id: string): Promise<ApprovalState> {
    const sql = db();
    await sql`update public.approvals set status = 'expired' where id = ${id} and status = 'pending' and expires_at < now()`;
    const [r] = await sql`select status from public.approvals where id = ${id}`;
    return (r?.status ?? 'denied') as ApprovalState;
  }

  async recordUsage(u: ModelUsage, model: string): Promise<void> {
    const sql = db();
    await sql`
      insert into public.usage_records (user_id, agent_id, run_id, source, model, input_tokens, output_tokens, cached_tokens)
      values (${this.r.userId}, ${this.r.agentId}, ${this.r.runId}, ${this.r.source}, ${model}, ${u.inputTokens}, ${u.outputTokens}, ${u.cachedTokens})`;
    await sql`
      update public.runs set usage = jsonb_build_object(
        'input_tokens', coalesce((usage->>'input_tokens')::bigint, 0) + ${u.inputTokens},
        'output_tokens', coalesce((usage->>'output_tokens')::bigint, 0) + ${u.outputTokens},
        'cached_tokens', coalesce((usage->>'cached_tokens')::bigint, 0) + ${u.cachedTokens},
        'requests', coalesce((usage->>'requests')::bigint, 0) + 1)
      where id = ${this.r.runId}`;
  }

  async notify(title: string, body: string, kind: string): Promise<void> {
    await notifyUser({ userId: this.r.userId, kind, title: `${this.r.agentName}: ${title}`, body, url: `/app/s/${this.r.sessionId}`, sessionId: this.r.sessionId });
  }

  memory = {
    add: async (fact: string) => {
      const [row] = await db()`insert into public.agent_memories (user_id, agent_id, content) values (${this.r.userId}, ${this.r.agentId}, ${fact}) returning id`;
      return String(row.id).slice(0, 8);
    },
    remove: async (id: string) => {
      if (!/^[a-f0-9-]{6,36}$/i.test(id)) return false;
      const rows = await db()`delete from public.agent_memories where agent_id = ${this.r.agentId} and id::text like ${id.replace(/[^a-f0-9-]/gi, '') + '%'} returning id`;
      return rows.length > 0;
    },
  };
}
