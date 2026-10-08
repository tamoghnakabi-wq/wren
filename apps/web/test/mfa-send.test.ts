import { describe, expect, it, vi } from 'vitest';

// The send path of email codes, against a stand-in database that records each statement. Supabase's
// answer is made to arrive late (over 50 s after the send started), as when the function was paused.
const h = vi.hoisted(() => ({ statements: [] as string[], clock: 1_000_000, delay: 0 }));
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
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      signInWithOtp: async () => {
        h.clock += h.delay;
        return { error: null };
      },
    },
  }),
}));
vi.mock('../src/lib/db', () => {
  const sql = (strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    h.statements.push(text);
    if (text.includes('wren_mfa_state')) return Promise.resolve([{ factors: 0, totp: 0, email: false, user_email: 'owner@wren.test', session_alive: true }]);
    if (text.includes('order by sent_at desc limit 1')) return Promise.resolve([]); // no recent request
    if (text.includes('count(*)')) return Promise.resolve([{ n: 1 }]);
    if (text.startsWith('insert into public.mfa_email_requests')) return Promise.resolve([{ id: 'req-new' }]);
    return Promise.resolve([]);
  };
  (sql as unknown as { begin: unknown }).begin = async (fn: (tx: typeof sql) => unknown) => fn(sql);
  return { db: () => sql };
});
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test';
vi.spyOn(Date, 'now').mockImplementation(() => h.clock);

const { sendEmailCode } = await import('../src/lib/mfa');
const user = { id: 'u1', email: 'owner@wren.test', sessionId: 's1', aal: 'aal1', amr: [] } as never;

describe('an email code send that took too long (W-114, W-125)', () => {
  it('ends every open request of the account, older ones too, and asks the user to try again', async () => {
    h.statements = [];
    h.delay = 55_000;
    await expect(sendEmailCode(user, 'step_up')).rejects.toMatchObject({ status: 502, code: 'email_failed' });
    const supersede = h.statements.filter((s) => s.startsWith('update public.mfa_email_requests set superseded_at = now() where user_id'));
    expect(supersede).toEqual(['update public.mfa_email_requests set superseded_at = now() where user_id = ? and used_at is null and superseded_at is null']);
  });

  it('on time: marks it delivered and ends only the older requests', async () => {
    h.statements = [];
    h.delay = 2_000;
    await expect(sendEmailCode(user, 'step_up')).resolves.toMatchObject({ challengeId: 'req-new', sent: true });
    expect(h.statements.some((s) => s.includes('and sent_at < (select sent_at'))).toBe(true);
  });
});
