import { beforeEach, describe, expect, it, vi } from 'vitest';

// Adding a connection (W-197): the connection and its secret are saved together or not at all. The database
// stand-in keeps committed rows apart from a transaction's, and drops the transaction's when it throws.
const h = vi.hoisted(() => ({
  committed: { connections: [] as unknown[], secrets: [] as unknown[] },
  failSecretInsert: false,
  failEncrypt: false,
}));

vi.mock('../src/lib/db', () => {
  const client = (rows: typeof h.committed) => {
    const tag = (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('insert into public.connections ')) {
        const row = { id: `c${rows.connections.length + 1}`, provider: 'github', status: 'active' };
        rows.connections.push(row);
        return Promise.resolve([row]);
      }
      if (text.includes('insert into public.connection_secrets')) {
        if (h.failSecretInsert) return Promise.reject(new Error('connection lost'));
        rows.secrets.push({});
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    };
    return Object.assign(tag, { json: (v: unknown) => v });
  };
  return {
    db: () =>
      Object.assign(client(h.committed), {
        begin: async <T>(fn: (tx: unknown) => Promise<T>) => {
          const pending = { connections: [] as unknown[], secrets: [] as unknown[] };
          const out = await fn(client(pending)); // a throw leaves nothing committed
          h.committed.connections.push(...pending.connections);
          h.committed.secrets.push(...pending.secrets);
          return out;
        },
      }),
  };
});
vi.mock('../src/lib/crypto', () => ({
  encryptSecret: () => {
    if (h.failEncrypt) throw new Error('no key');
    return 'ciphertext';
  },
  hint: () => 'ghp_…abcd',
}));
vi.mock('../src/lib/auth', () => ({
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  },
  requireUser: async () => ({ id: 'user-1' }),
}));
vi.mock('../src/lib/mcp', () => ({ probeMcp: async () => [] }));
vi.mock('@wren/core', () => ({ listModels: async () => [] }));
vi.mock('@/lib/auth', () => import('../src/lib/auth'));
vi.mock('@/lib/crypto', () => import('../src/lib/crypto'));
vi.mock('@/lib/db', () => import('../src/lib/db'));
vi.mock('@/lib/http', () => import('../src/lib/http'));
vi.mock('@/lib/mcp', () => import('../src/lib/mcp'));
vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ login: 'octo' }), { headers: { 'x-oauth-scopes': 'repo' } }));

const { POST } = (await import('../src/app/api/connections/route')) as unknown as { POST: (req: Request, ctx: unknown) => Promise<Response> };
const add = () => POST(new Request('http://localhost/api/connections', { method: 'POST', body: JSON.stringify({ provider: 'github', secret: 'ghp_example' }) }), {});

beforeEach(() => {
  h.committed.connections.length = 0;
  h.committed.secrets.length = 0;
  h.failSecretInsert = false;
  h.failEncrypt = false;
});

describe('adding a connection (W-197)', () => {
  it('saves the connection and its secret together', async () => {
    expect((await add()).status).toBe(201);
    expect(h.committed).toEqual({ connections: [expect.objectContaining({ status: 'active' })], secrets: [{}] });
  });

  it('leaves no connection behind when its secret can’t be saved', async () => {
    h.failSecretInsert = true;
    expect((await add()).status).toBe(500);
    expect(h.committed).toEqual({ connections: [], secrets: [] });
  });

  it('writes nothing when the secret can’t be encrypted', async () => {
    h.failEncrypt = true;
    expect((await add()).status).toBe(500);
    expect(h.committed).toEqual({ connections: [], secrets: [] });
  });
});
