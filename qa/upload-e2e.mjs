// Large uploads, end to end against the local stack (`npx supabase start`, `npm run dev`) and the real
// file store the local server is set up with: start → send to the store → finish → read back, and the
// refusals. Makes two throwaway accounts through the local admin API and removes them (and every file)
// at the end. Run from the repository root: `node qa/upload-e2e.mjs`.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { put } from '@vercel/blob/client';

const APP = process.env.WREN_URL ?? 'http://localhost:5310';
const env = Object.fromEntries(
  execFileSync('npx', ['supabase', 'status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .map((l) => l.match(/^(\w+)="?([^"]*)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const admin = { apikey: env.SERVICE_ROLE_KEY, authorization: `Bearer ${env.SERVICE_ROLE_KEY}`, 'content-type': 'application/json' };
const MB = 1024 * 1024;
let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

async function account(tag) {
  const email = `upload-e2e-${tag}-${Date.now()}@wren.test`;
  const password = randomBytes(18).toString('base64url');
  const made = await (await fetch(`${env.API_URL}/auth/v1/admin/users`, { method: 'POST', headers: admin, body: JSON.stringify({ email, password, email_confirm: true }) })).json();
  const s = await (await fetch(`${env.API_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: env.ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
  return { id: made.id, token: s.access_token };
}
const call = async (who, method, path, body) => {
  const res = await fetch(`${APP}${path}`, { method, headers: { authorization: `Bearer ${who.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, text };
};

const a = await account('a');
const b = await account('b');
const files = []; // [account, artifactId] to delete at the end
try {
  // 1. The whole path, with a name that needs cleaning.
  const data = randomBytes(6 * MB);
  const start = await call(a, 'POST', '/api/files/upload', { name: 'big report (final).bin', size: data.length });
  check('start answers 201 with a place in the account’s folder', start.status === 201 && start.data.pathname === `u/${a.id}/${start.data.id}/big report (final).bin`, start.text.slice(0, 200));
  await put(start.data.pathname, data, { access: 'private', token: start.data.token, contentType: 'application/octet-stream' });
  const done = await call(a, 'PUT', '/api/files/upload', { id: start.data.id, name: 'big report (final).bin' });
  check('finish records it with the stored size', done.status === 201 && done.data.artifactId === start.data.id && done.data.size === data.length, done.text.slice(0, 200));
  if (done.status === 201) files.push([a, done.data.artifactId]);
  const back = await fetch(`${APP}/api/files/${start.data.id}?download`, { headers: { authorization: `Bearer ${a.token}` } });
  const got = Buffer.from(await back.arrayBuffer());
  check('the file reads back byte for byte', back.status === 200 && createHash('sha256').update(got).digest('hex') === createHash('sha256').update(data).digest('hex'), `status ${back.status}, ${got.length} bytes`);
  check('another account can’t read it', (await fetch(`${APP}/api/files/${start.data.id}`, { headers: { authorization: `Bearer ${b.token}` } })).status === 404);

  // 2. Finishing again, or a place that was never handed out.
  const again = await call(a, 'PUT', '/api/files/upload', { id: start.data.id, name: 'big report (final).bin' });
  check('finishing twice is refused (410)', again.status === 410 && again.data.code === 'upload_expired', again.text.slice(0, 200));

  // 3. The token is for its one place, once.
  const second = await call(a, 'POST', '/api/files/upload', { name: 'second.bin', size: 5 * MB });
  const elsewhere = await put(`u/${b.id}/${second.data.id}/second.bin`, Buffer.alloc(1024), { access: 'private', token: second.data.token }).then(() => 'stored', (e) => `refused: ${e.message.slice(0, 80)}`);
  check('the token can’t store anything at another place', elsewhere.startsWith('refused'), elsewhere);
  await put(second.data.pathname, Buffer.alloc(5 * MB, 1), { access: 'private', token: second.data.token });
  const over = await put(second.data.pathname, Buffer.alloc(1024), { access: 'private', token: second.data.token }).then(() => 'stored', (e) => `refused: ${e.message.slice(0, 80)}`);
  check('nor replace what is already there', over.startsWith('refused'), over);

  // 4. Another account can't finish it; its owner still can.
  const stolen = await call(b, 'PUT', '/api/files/upload', { id: second.data.id, name: 'second.bin' });
  check('another account can’t finish it (400, nothing there for them)', stolen.status === 400 && stolen.data.code === 'upload_missing', stolen.text.slice(0, 200));
  const mine = await call(a, 'PUT', '/api/files/upload', { id: second.data.id, name: 'second.bin' });
  check('its owner can', mine.status === 201 && mine.data.size === 5 * MB, mine.text.slice(0, 200));
  if (mine.status === 201) files.push([a, mine.data.artifactId]);

  // 5. Refusals before any token.
  check('over 25 MB is refused (413)', (await call(a, 'POST', '/api/files/upload', { name: 'x.bin', size: 25 * MB + 1 })).status === 413);
  check('no size is refused (400)', (await call(a, 'POST', '/api/files/upload', { name: 'x.bin', size: 0 })).status === 400);
  check('signed out is refused (401)', (await fetch(`${APP}/api/files/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x.bin', size: 5 * MB }) })).status === 401);
  const never = await call(a, 'POST', '/api/files/upload', { name: 'never-sent.bin', size: 5 * MB });
  const missing = await call(a, 'PUT', '/api/files/upload', { id: never.data.id, name: 'never-sent.bin' });
  check('a file that never arrived isn’t recorded (400)', missing.status === 400 && missing.data.code === 'upload_missing', missing.text.slice(0, 200));

  // 6. The store enforces the size on the token.
  const big = await call(a, 'POST', '/api/files/upload', { name: 'too-big.bin', size: 25 * MB });
  const tooBig = await put(big.data.pathname, Buffer.alloc(26 * MB, 2), { access: 'private', token: big.data.token }).then(() => 'stored', (e) => `refused: ${e.message.slice(0, 80)}`);
  check('the store refuses more than the token allows (26 MB)', tooBig.startsWith('refused'), tooBig);
  if (tooBig === 'stored') {
    const f = await call(a, 'PUT', '/api/files/upload', { id: big.data.id, name: 'too-big.bin' });
    check('…and Wren then deletes it instead of recording it (413)', f.status === 413, f.text.slice(0, 200));
  }

  // 7. Only so many under way per account (b has none yet).
  let granted = 0;
  let last = 0;
  for (let i = 0; i < 22; i++) {
    last = (await call(b, 'POST', '/api/files/upload', { name: `p${i}.bin`, size: 5 * MB })).status;
    if (last === 201) granted++;
  }
  check('an account gets 20 uploads under way, then 429', granted === 20 && last === 429, `granted ${granted}, last ${last}`);

  // 8. Small files still go through the API in one request.
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'note.txt');
  const small = await fetch(`${APP}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${a.token}` }, body: form });
  const smallData = await small.json();
  check('a small file still uploads in one request', small.status === 201 && smallData.size === 5, JSON.stringify(smallData));
  if (small.status === 201) files.push([a, smallData.artifactId]);
} finally {
  for (const [who, id] of files) {
    const r = await call(who, 'DELETE', `/api/files/${id}`);
    check(`clean-up: file ${id.slice(0, 8)} deleted`, r.status === 200, r.text.slice(0, 120));
  }
  for (const u of [a, b]) await fetch(`${env.API_URL}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: admin });
  // Places that were handed out and never finished (no file behind them here, or one the store refused).
  execFileSync('docker', ['exec', '-i', 'supabase_db_wren', 'psql', '-U', 'postgres', '-qAt', '-c', `delete from public.external_cleanups where ref like 'u/${a.id}/%' or ref like 'u/${b.id}/%'`]);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
