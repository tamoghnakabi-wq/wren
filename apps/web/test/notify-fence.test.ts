import { beforeEach, describe, expect, it, vi } from 'vitest';

// W-200: a cloud worker that lost its run's lease adds no notification and sends no push, also when
// the takeover lands between an approval and its notification. W-199: pushes go only to browsers
// whose own sign-in is still live, and a subscription records the sign-in that registered it.
//
// The database stand-in reads each statement with its nested fragments, so it applies the store's real
// lease condition (`lease_id = <this worker's lease>`) against the run's current lease.

const RUN = '11111111-1111-4111-8111-111111111111';
const MINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const state = {
  lease: MINE as string,
  takeoverAfterApproval: false,
  queries: [] as { text: string; values: unknown[] }[],
  /** Notifications saved, and whether the saving worker still held the lease at that moment. */
  saved: [] as { title: unknown; held: boolean }[],
  approvals: 0,
  pushes: [] as { endpoint: string; payload: { title: string; url: string; tag: string } }[],
};

const FRAG = Symbol('fragment');
type Frag = { [FRAG]: true; strings: readonly string[]; values: unknown[] };
function flat(q: Frag): { text: string; values: unknown[] } {
  let text = q.strings[0];
  const values: unknown[] = [];
  q.values.forEach((v, i) => {
    if (v && typeof v === 'object' && FRAG in v) {
      const f = flat(v as Frag);
      text += f.text;
      values.push(...f.values);
    } else {
      text += '?';
      values.push(v);
    }
    text += q.strings[i + 1];
  });
  return { text: text.replace(/\s+/g, ' ').trim(), values };
}
/** The statement's lease condition, if it has one, holds for the run's current lease. */
const leaseHolds = (text: string, values: unknown[]) => !text.includes('lease_id = ?') || values.includes(state.lease);

function execute(q: Frag): unknown[] {
  const { text, values } = flat(q);
  state.queries.push({ text, values });
  const held = leaseHolds(text, values);
  if (text.startsWith('with a as ( insert into public.approvals')) {
    if (!held) return [];
    state.approvals++;
    state.saved.push({ title: values.find((v) => typeof v === 'string' && v.endsWith('needs your approval')), held: true });
    if (state.takeoverAfterApproval) state.lease = OTHER;
    return [{ id: 'appr-1' }];
  }
  if (text.startsWith('insert into public.approvals')) {
    if (!held) return [];
    state.approvals++;
    if (state.takeoverAfterApproval) state.lease = OTHER;
    return [{ id: 'appr-1' }];
  }
  if (text.startsWith('insert into public.notifications')) {
    if (!held) return [];
    state.saved.push({ title: values[2], held: !text.includes('lease_id = ?') ? state.lease === MINE : true });
    return [{ id: 'n-1' }];
  }
  if (text.startsWith('select 1 from public.runs where id = ? and lease_id = ?')) return values[1] === state.lease ? [{ '?column?': 1 }] : [];
  if (text.includes('wren_push_targets') || text.includes('from public.push_subscriptions where user_id')) {
    return [{ id: 'sub-1', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'k', auth: 'a' }];
  }
  if (text.startsWith('insert into public.push_subscriptions')) return [{ id: 'sub-1' }];
  return [];
}

function sql(strings: TemplateStringsArray, ...values: unknown[]) {
  const q: Frag & PromiseLike<unknown[]> = {
    [FRAG]: true,
    strings,
    values,
    then: (res, rej) => Promise.resolve().then(() => execute(q)).then(res, rej),
  };
  return q;
}
sql.json = (v: unknown) => v;

vi.mock('../src/lib/db', () => ({ db: () => sql }));
vi.mock('@/lib/db', () => ({ db: () => sql }));
vi.mock('../src/lib/env', () => ({ env: { vapidPublic: 'public-key', vapidPrivate: 'private-key', vapidSubject: 'mailto:test@example.test' } }));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }, payload: string) => {
      state.pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return {};
    },
  },
}));
const user = { id: 'user-1', sessionId: 'session-live', email: 'u@example.test' };
const requireUser = vi.fn(async (_req?: Request, _opts?: unknown) => user);
vi.mock('../src/lib/auth', () => ({
  HttpError: class HttpError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  },
  requireUser: (req?: Request, opts?: unknown) => requireUser(req, opts),
}));
vi.mock('@/lib/auth', () => import('../src/lib/auth'));
vi.mock('@/lib/http', () => import('../src/lib/http'));
vi.mock('@/lib/notify', () => import('../src/lib/notify'));

const { DbRunStore, LeaseLostError } = await import('../src/lib/runner/store');
const { sendPush } = await import('../src/lib/notify');
const subscribe = await import('../src/app/api/push/subscribe/route');

const store = () =>
  new DbRunStore({ runId: RUN, sessionId: 'session-1', agentId: 'agent-1', userId: 'user-1', agentName: 'Scout', source: 'cloud', leaseId: MINE });
const approval = { eventId: '33333333-3333-4333-8333-333333333333', tool: 'computer.shell', title: 'Run the deploy script', args: { command: './deploy' }, risk: 'high', reason: 'it publishes' };

beforeEach(() => {
  state.lease = MINE;
  state.takeoverAfterApproval = false;
  state.queries = [];
  state.saved = [];
  state.approvals = 0;
  state.pushes = [];
  requireUser.mockClear();
});

describe('task notifications follow the lease (W-200)', () => {
  it('the lease holder saves and pushes its notification', async () => {
    await store().notify('Report ready', 'Sales are up 4%.', 'task');
    expect(state.saved).toEqual([{ title: 'Scout: Report ready', held: true }]);
    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0].payload).toMatchObject({ title: 'Scout: Report ready', url: '/app/s/session-1' });
  });

  it('a worker that lost the lease saves nothing, pushes nothing and is told so', async () => {
    state.lease = OTHER;
    await expect(store().notify('Report ready', 'Sales are up 4%.', 'task')).rejects.toBeInstanceOf(LeaseLostError);
    expect(state.saved).toEqual([]);
    expect(state.pushes).toEqual([]);
    // The check is part of the statement that saves the notification, not a separate read before it.
    const insert = state.queries.find((q) => q.text.startsWith('insert into public.notifications'));
    expect(insert?.text).toContain('lease_id = ?');
  });

  it('an approval and its notification go in together, so a takeover right after the approval adds no stale notification', async () => {
    state.takeoverAfterApproval = true;
    const id = await store().createApproval(approval as never);
    expect(id).toBe('appr-1');
    expect(state.approvals).toBe(1);
    expect(state.saved).toEqual([{ title: 'Scout needs your approval', held: true }]);
    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0].payload).toMatchObject({ title: 'Scout needs your approval', url: '/app/s/session-1?approval=appr-1', tag: 'approval-appr-1' });
  });

  it('a worker that lost the lease adds no approval, no notification and no push', async () => {
    state.lease = OTHER;
    await expect(store().createApproval(approval as never)).rejects.toBeInstanceOf(LeaseLostError);
    expect(state.approvals).toBe(0);
    expect(state.saved).toEqual([]);
    expect(state.pushes).toEqual([]);
  });
});

describe('pushes go to live sign-ins only (W-199)', () => {
  it('sendPush asks the database for subscriptions of live sign-ins, not every subscription of the account', async () => {
    expect(await sendPush({ userId: 'user-1', kind: 'task', title: 'Hi' })).toBe(1);
    const lookup = state.queries.find((q) => q.text.includes('push_subscriptions') || q.text.includes('wren_push_targets'));
    expect(lookup?.text).toContain('from public.wren_push_targets(?::uuid)');
    expect(lookup?.values).toEqual(['user-1']);
  });

  it('registering a subscription records the sign-in, and registering again moves it to the current one', async () => {
    const res = await subscribe.POST(
      new Request('http://localhost/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Test browser' },
        body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'k', auth: 'a' } }),
      }),
      {} as never,
    );
    expect(res.status).toBe(200);
    const insert = state.queries.find((q) => q.text.startsWith('insert into public.push_subscriptions'));
    expect(insert?.text).toContain('session_id');
    expect(insert?.values).toContain('session-live');
    expect(insert?.text).toContain('session_id = excluded.session_id');
  });

  it('removing a subscription works before two-step sign-in is finished (sign-out calls it)', async () => {
    const res = await subscribe.DELETE(
      new Request('http://localhost/api/push/subscribe', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }) }),
      {} as never,
    );
    expect(res.status).toBe(200);
    expect(requireUser.mock.calls[0][1]).toEqual({ mfa: 'skip' });
    const del = state.queries.find((q) => q.text.startsWith('delete from public.push_subscriptions'));
    expect(del?.values).toEqual(['user-1', 'https://fcm.googleapis.com/fcm/send/abc']);
  });
});
