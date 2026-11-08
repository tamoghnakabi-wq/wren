import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayLabel, lastDays } from '../src/lib/usage-days';

// The Usage page labelled every day one too early west of UTC (new Date('2026-11-08') is Nov 7 in New
// York) and cut days at UTC midnight rather than the account's. Days are now the account's calendar
// days, sent as dates and shown as written.

const realTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = realTz;
});

describe('a usage day is shown as the date it is', () => {
  for (const tz of ['America/New_York', 'America/Los_Angeles', 'UTC', 'Australia/Melbourne', 'Pacific/Kiritimati']) {
    it(`in ${tz}`, () => {
      process.env.TZ = tz;
      expect(dayLabel('2026-11-08')).toMatch(/\b8\b/);
      expect(dayLabel('2026-11-08')).not.toMatch(/\b(7|9)\b/);
      expect(dayLabel('2027-01-01')).toMatch(/\b1\b/);
    });
  }
});

describe('the last days end with today in the given zone', () => {
  const instant = Date.UTC(2026, 10, 7, 22, 0); // 7 Nov 22:00 UTC = 8 Nov 09:00 in Melbourne
  it('ahead of UTC', () => {
    expect(lastDays(3, 'Australia/Melbourne', instant)).toEqual(['2026-11-06', '2026-11-07', '2026-11-08']);
  });
  it('behind UTC', () => {
    expect(lastDays(3, 'America/New_York', instant)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07']);
  });
  it('across a daylight-saving change (US clocks went back on 1 Nov 2026)', () => {
    expect(lastDays(4, 'America/New_York', Date.UTC(2026, 10, 2, 17))).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });
  it('30 days by default length, oldest first, no gaps', () => {
    const d = lastDays(30, 'UTC', instant);
    expect(d).toHaveLength(30);
    expect(d[29]).toBe('2026-11-07');
    expect(d[0]).toBe('2026-10-09');
  });
});

// The route, over a database stand-in: which zone each query used, and what it answered.
const db = vi.hoisted(() => ({ zone: 'UTC' as string | null, unknown: new Set<string>(), fail: null as Error | null, zones: [] as unknown[] }));
vi.mock('@/lib/auth', () => ({ requireUser: async () => ({ id: 'user-1' }), HttpError: class extends Error {} }));
vi.mock('@/lib/http', () => import('../src/lib/http'));
vi.mock('@/lib/usage-days', () => import('../src/lib/usage-days'));
vi.mock('@/lib/db', () => {
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('from public.profiles')) return db.zone ? [{ timezone: db.zone }] : [];
    if (db.fail) throw db.fail;
    const zone = text.includes('at time zone') ? values.find((v) => typeof v === 'string' && v !== 'user-1') : undefined;
    db.zones.push(zone);
    if (typeof zone === 'string' && db.unknown.has(zone)) throw Object.assign(new Error(`time zone "${zone}" not recognized`), { code: '22023' });
    if (text.includes('generate_series')) return [{ day: '2026-11-07' }, { day: '2026-11-08' }];
    return [{ day: '2026-11-08', agent_id: null, source: 'openai', model: 'm', input_tokens: '5', output_tokens: '7', cached_tokens: '0', calls: 1 }];
  };
  return { db: () => Object.assign(sql, { begin: (fn: (tx: typeof sql) => unknown) => fn(sql) }) };
});

async function usage() {
  const { GET } = await import('../src/app/api/usage/route');
  const res = await GET(new Request('http://x/api/usage'), undefined as never);
  return { status: res.status, body: await res.json() };
}

describe('/api/usage', () => {
  afterEach(() => {
    db.zone = 'UTC';
    db.unknown.clear();
    db.fail = null;
    db.zones = [];
  });

  it('groups days in the account’s time zone', async () => {
    db.zone = 'America/New_York';
    const r = await usage();
    expect(r.status).toBe(200);
    expect(r.body.timezone).toBe('America/New_York');
    expect(db.zones).toEqual(['America/New_York', 'America/New_York']);
    expect(r.body.days).toEqual(['2026-11-07', '2026-11-08']);
    expect(r.body.rows[0]).toMatchObject({ day: '2026-11-08', input_tokens: 5, output_tokens: 7 });
  });

  it('falls back to UTC for a zone the database doesn’t know', async () => {
    db.zone = 'America/Ciudad_Juarez';
    db.unknown.add('America/Ciudad_Juarez');
    const r = await usage();
    expect(r.status).toBe(200);
    expect(r.body.timezone).toBe('UTC');
  });

  it('uses UTC when the account has no profile row', async () => {
    db.zone = null;
    expect((await usage()).body.timezone).toBe('UTC');
  });

  it('other database errors are not hidden', async () => {
    db.zone = 'Europe/London';
    db.fail = Object.assign(new Error('connection refused'), { code: '08006' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await usage()).status).toBe(500);
  });
});
