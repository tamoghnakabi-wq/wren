import type { ApprovalRequest, ApprovalState, ModelUsage, RunStore, SessionEvent } from '@wren/core';
import { HttpError } from '../auth';
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
  /** When set, every write first checks this worker still holds the run's lease. */
  leaseId?: string;
}

export class LeaseLostError extends HttpError {
  constructor() {
    super(409, 'This worker no longer holds this run.', 'lease_lost');
  }
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

  /**
   * SQL condition: this worker still holds the run's lease. It is part of each write statement
   * itself and share-locks the run row, so a takeover (which updates that row) waits for the write
   * to finish, and a write that queued behind a takeover re-checks against the new owner.
   */
  private holds(sql: ReturnType<typeof db>) {
    return this.r.leaseId ? sql`exists (select 1 from public.runs where id = ${this.r.runId}::uuid and lease_id = ${this.r.leaseId}::uuid for share)` : sql`true`;
  }

  /** After a write matched nothing: was it because the lease is gone? */
  private async assertLease() {
    if (!this.r.leaseId) return;
    const [row] = await db()`select 1 from public.runs where id = ${this.r.runId} and lease_id = ${this.r.leaseId}`;
    if (!row) throw new LeaseLostError();
  }

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
      select ${this.r.userId}::uuid, ${this.r.sessionId}::uuid, ${this.r.runId}::uuid, ${type}, ${status ?? null}, ${sql.json(stripInline(data) as Json)}
      where ${this.holds(sql)}
      returning id, seq, run_id, type, status, data, created_at`;
    if (!row) throw new LeaseLostError();
    await sql`update public.sessions set last_event_at = now() where id = ${this.r.sessionId}`;
    return toEvent(row) as SessionEvent<T>;
  }

  /** Only this run's own events can be changed. */
  async update(id: string, patch: { data?: unknown; status?: string }): Promise<void> {
    const sql = db();
    if (patch.data === undefined && patch.status === undefined) return;
    const done =
      patch.data !== undefined
        ? await sql`update public.events set data = ${sql.json(stripInline(patch.data) as Json)}, status = coalesce(${patch.status ?? null}, status)
            where id = ${id} and run_id = ${this.r.runId} and ${this.holds(sql)} returning id`
        : await sql`update public.events set status = ${patch.status!} where id = ${id} and run_id = ${this.r.runId} and ${this.holds(sql)} returning id`;
    if (!done.length) await this.assertLease();
  }

  async control() {
    const [r] = await db()`select cancel_requested, pause_requested from public.runs where id = ${this.r.runId}`;
    return { cancel: !!r?.cancel_requested, pause: !!r?.pause_requested };
  }

  async createApproval(req: ApprovalRequest, opts: { localOnly?: boolean } = {}): Promise<string> {
    const sql = db();
    // Only for one of this run's own events, and only while holding the lease.
    const [row] = await sql`
      insert into public.approvals (user_id, agent_id, session_id, run_id, event_id, tool, title, detail, risk)
      select ${this.r.userId}::uuid, ${this.r.agentId}::uuid, ${this.r.sessionId}::uuid, ${this.r.runId}::uuid, ${req.eventId}::uuid, ${req.tool}, ${req.title.slice(0, 300)},
             ${sql.json({ args: req.args as Json, reason: req.reason ?? null, ...(opts.localOnly ? { localOnly: true } : {}) })}, ${req.risk}
      where exists (select 1 from public.events where id = ${req.eventId}::uuid and run_id = ${this.r.runId}::uuid) and ${this.holds(sql)}
      returning id`;
    if (!row) {
      await this.assertLease();
      throw new Error('Approval event does not belong to this run.');
    }
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

  /** State of one of this run's approvals (anything else reads as denied). */
  async approvalState(id: string): Promise<ApprovalState> {
    const sql = db();
    await sql`update public.approvals set status = 'expired' where id = ${id} and run_id = ${this.r.runId} and status = 'pending' and expires_at < now()`;
    const [r] = await sql`select status from public.approvals where id = ${id} and run_id = ${this.r.runId} and user_id = ${this.r.userId}`;
    return (r?.status ?? 'denied') as ApprovalState;
  }

  async recordUsage(u: ModelUsage, model: string): Promise<void> {
    const sql = db();
    // Usage is what the provider charged, so it is always recorded, even by a worker that just
    // lost its lease. The record and the per-run total commit together, so they never disagree.
    await sql.begin(async (tx) => {
      await tx`
        insert into public.usage_records (user_id, agent_id, run_id, source, model, input_tokens, output_tokens, cached_tokens)
        values (${this.r.userId}, ${this.r.agentId}, ${this.r.runId}, ${this.r.source}, ${model}, ${u.inputTokens}, ${u.outputTokens}, ${u.cachedTokens})`;
      await tx`
        update public.runs set usage = jsonb_build_object(
          'input_tokens', coalesce((usage->>'input_tokens')::bigint, 0) + ${u.inputTokens},
          'output_tokens', coalesce((usage->>'output_tokens')::bigint, 0) + ${u.outputTokens},
          'cached_tokens', coalesce((usage->>'cached_tokens')::bigint, 0) + ${u.cachedTokens},
          'requests', coalesce((usage->>'requests')::bigint, 0) + 1)
        where id = ${this.r.runId}`;
    });
  }

  async notify(title: string, body: string, kind: string): Promise<void> {
    await notifyUser({ userId: this.r.userId, kind, title: `${this.r.agentName}: ${title}`, body, url: `/app/s/${this.r.sessionId}`, sessionId: this.r.sessionId });
  }

  memory = {
    add: async (fact: string) => {
      const sql = db();
      const [row] = await sql`insert into public.agent_memories (user_id, agent_id, content)
        select ${this.r.userId}::uuid, ${this.r.agentId}::uuid, ${fact} where ${this.holds(sql)} returning id`;
      if (!row) throw new LeaseLostError();
      return String(row.id).slice(0, 8);
    },
    remove: async (id: string) => {
      if (!/^[a-f0-9-]{6,36}$/i.test(id)) return false;
      const sql = db();
      const rows = await sql`delete from public.agent_memories where agent_id = ${this.r.agentId} and id::text like ${id.replace(/[^a-f0-9-]/gi, '') + '%'} and ${this.holds(sql)} returning id`;
      if (!rows.length) await this.assertLease();
      return rows.length > 0;
    },
  };

  /** Live-view frame for this run (only from the worker holding the lease). */
  async live(frame: { image: string; url?: string | null; title?: string | null }) {
    const sql = db();
    const rows = await sql`
      insert into public.run_live (run_id, user_id, session_id, image, url, title, updated_at)
      select ${this.r.runId}::uuid, ${this.r.userId}::uuid, ${this.r.sessionId}::uuid, ${frame.image}, ${frame.url ?? null}, ${frame.title ?? null}, now()
      where ${this.holds(sql)}
      on conflict (run_id) do update set image = excluded.image, url = excluded.url, title = excluded.title, updated_at = now()
      returning run_id`;
    if (!rows.length) await this.assertLease();
  }
}
