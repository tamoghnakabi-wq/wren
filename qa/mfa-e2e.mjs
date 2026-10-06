// Two-step sign-in (MFA): end-to-end checks against the LOCAL stack, written to find bypasses.
//
//   npx supabase start && node scripts/local-auth-recovery-codes.mjs   # local Auth with recovery codes
//   npm run dev                                                        # web on :5310
//   node qa/mfa-e2e.mjs
//
// Creates throwaway users (…@mfa-e2e.test) on the local stack only and deletes them afterwards.
// Reads emailed codes from the local Mailpit. Exit code 1 if any check fails.
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(`${root}apps/web/package.json`);
const { createClient } = require('@supabase/supabase-js');
const OTPAuth = require('otpauth');

const SUPABASE = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const KEY = process.env.SUPABASE_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const WEB = process.env.WEB_URL ?? 'http://localhost:5310';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';
for (const u of [SUPABASE, WEB, MAILPIT]) if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u)) throw new Error(`Refusing to run against ${u}: local stack only.`);

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A code from a time window that hasn't been used yet: Supabase refuses a code used once already. */
const usedWindows = new Map();
async function freshCode(totp) {
  const key = totp.secret.base32;
  while (Math.floor(Date.now() / 30000) <= (usedWindows.get(key) ?? -1)) await sleep(500);
  usedWindows.set(key, Math.floor(Date.now() / 30000));
  return totp.generate();
}
const psql = (q) => execSync(`docker exec -i supabase_db_wren psql -U postgres -tAc ${JSON.stringify(q)}`).toString().trim();
const client = () => createClient(SUPABASE, KEY, { auth: { persistSession: false, autoRefreshToken: false, experimental: { recoveryCodes: true } } });
const claims = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
const token = async (c) => (await c.auth.getSession()).data.session.access_token;
const run = Date.now().toString(36);
const users = [];

async function newUser(tag) {
  const email = `${tag}-${run}@mfa-e2e.test`;
  const password = `Pw-${run}-${Math.random().toString(36).slice(2)}`;
  const c = client();
  const { error } = await c.auth.signUp({ email, password });
  if (error) throw error;
  users.push(email);
  return { email, password, c };
}
async function signIn(u) {
  const c = client();
  const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw error;
  return c;
}
async function api(c, path, body, method) {
  const r = await fetch(`${WEB}${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${typeof c === 'string' ? c : await token(c)}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const tables = ['profiles', 'devices', 'connections', 'agents', 'agent_memories', 'sessions', 'schedules', 'runs', 'events', 'approvals', 'artifacts', 'usage_records', 'notifications', 'run_live'];
async function visibleRows(c) {
  let n = 0;
  for (const t of tables) n += ((await c.from(t).select('*').limit(50)).data ?? []).length;
  return n;
}
async function emailCode(email, after) {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    const m = (list.messages ?? []).find((x) => Date.parse(x.Created) >= after && /verification code/i.test(x.Subject));
    if (m) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
      const code = />\s*(\d{6})\s*</.exec(full.HTML ?? '')?.[1] ?? /\b(\d{6})\b/.exec(full.Text ?? '')?.[1];
      if (code) return code;
    }
    await sleep(250);
  }
  throw new Error(`no code email for ${email}`);
}
async function emailStep(c, email, purpose) {
  const t0 = Date.now() - 1000;
  const s = await api(c, '/api/mfa/email/send', { purpose });
  if (s.status !== 200) return { send: s };
  const code = await emailCode(email, t0);
  return { send: s, code, verify: await api(c, '/api/mfa/email/verify', { code, challengeId: s.body.challengeId, purpose }) };
}
/** Skip Wren's one-minute resend gap (Supabase Auth's own gap is a second locally). */
async function backdate(userId) {
  psql(`update public.mfa_email_requests set sent_at = sent_at - interval '61 seconds' where user_id = '${userId}'`);
  await sleep(1100);
}
const idOf = async (c) => claims(await token(c)).sub;
const sessionOf = async (c) => claims(await token(c)).session_id;
const asUser = (t) => createClient(SUPABASE, KEY, { global: { headers: { authorization: `Bearer ${t}` } }, auth: { persistSession: false, autoRefreshToken: false } });
async function rowsFor(t) {
  let n = 0;
  for (const tb of tables) n += ((await asUser(t).from(tb).select('*').limit(50)).data ?? []).length;
  return n;
}
function totpFor(secret) {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
}

try {
  // ------------------------------------------------------------------ authenticator app (TOTP)
  const A = await newUser('totp');
  const en = await A.c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Phone' });
  const totp = totpFor(en.data.totp.secret);
  await A.c.auth.mfa.challengeAndVerify({ factorId: en.data.id, code: await freshCode(totp) });
  const rc = await A.c.auth.mfa.recoveryCodes.generate();
  check('setup: authenticator app verified and recovery codes created', claims(await token(A.c)).aal === 'aal2' && rc.data?.codes?.length === 10);
  const created = await api(A.c, '/api/agents', { name: 'MFA probe', model: { source: 'test', model: 'script' } });
  check('setup: an aal2 session can use the API (agent created)', created.status === 201, `status ${created.status}`);
  const visibleAal2 = await visibleRows(A.c);

  const A1 = await signIn(A); // password only
  const a1 = await token(A1);
  check('password-only session is aal1', claims(a1).aal === 'aal1');
  const me = await api(a1, '/api/me');
  check('API: /api/me answers before two-step sign-in, saying what is needed', me.status === 200 && me.body.mfa?.method === 'totp' && me.body.mfa?.satisfied === false);
  const blocked = await Promise.all(['/api/usage', '/api/models', '/api/devices/approve?code=ZZZZ-ZZZZ'].map((p) => api(a1, p)));
  check('API: every other route refuses an aal1 session (403 mfa_required)', blocked.every((r) => r.status === 403 && r.body.code === 'mfa_required'), blocked.map((r) => r.status).join(','));
  const writeBlocked = await api(a1, '/api/agents', { name: 'should not exist', model: { source: 'test', model: 'script' } });
  check('API: writes are refused too', writeBlocked.status === 403);
  check('database: an aal1 session sees no rows in any of the 14 tables (direct REST reads)', (await visibleRows(A1)) === 0 && visibleAal2 >= 2, `aal2 saw ${visibleAal2}`);
  const gql = await fetch(`${SUPABASE}/graphql/v1`, { method: 'POST', headers: { apikey: KEY, authorization: `Bearer ${a1}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ agentsCollection { edges { node { name } } } }' }) }).then((r) => r.json()).catch(() => null);
  check('database: GraphQL sees nothing either', !JSON.stringify(gql ?? {}).includes('MFA probe'));

  // Forged and foreign tokens.
  const [h, p] = a1.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims(a1), aal: 'aal2', amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] })).toString('base64url')}.${a1.split('.')[2]}`;
  const forgedApi = await api(forged, '/api/usage');
  const forgedDb = await createClient(SUPABASE, KEY, { global: { headers: { authorization: `Bearer ${forged}` } }, auth: { persistSession: false } }).from('agents').select('*');
  check('a token edited to claim aal2 is rejected by the API and the database', forgedApi.status === 401 && (forgedDb.error || (forgedDb.data ?? []).length === 0), `api ${forgedApi.status}`);
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
  check('an unsigned (alg none) token is rejected', (await api(none, '/api/usage')).status === 401);

  // What Supabase itself refuses an aal1 session.
  check('Supabase: removing the authenticator needs aal2', !!(await A1.auth.mfa.unenroll({ factorId: en.data.id })).error);
  check('Supabase: new recovery codes need aal2', !!(await A1.auth.mfa.recoveryCodes.regenerate()).error);
  check('Supabase: adding a second authenticator needs aal2', !!(await A1.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Attacker' })).error);
  const pwChange = await A1.auth.updateUser({ password: `${A.password}-x` });
  check('Supabase: changing the password needs aal2', pwChange.error?.code === 'insufficient_aal');
  check('email codes can’t stand in for the authenticator', (await api(a1, '/api/mfa/email/send', { purpose: 'sign_in' })).status === 409 && (await api(a1, '/api/mfa/email/send', { purpose: 'step_up' })).status === 409);

  // Realtime: an aal1 subscriber gets no changes.
  const events = { aal1: 0, aal2: 0 };
  const sub = async (c, key) => {
    await c.realtime.setAuth(await token(c));
    const ch = c.channel(`t-${key}-${run}`).on('postgres_changes', { event: '*', schema: 'public', table: 'agents' }, () => events[key]++);
    await new Promise((res) => ch.subscribe((s) => s === 'SUBSCRIBED' && res()));
    return ch;
  };
  const ch1 = await sub(A1, 'aal1');
  const ch2 = await sub(A.c, 'aal2');
  // Wait until the aal2 subscriber sees changes (streaming can take a moment to start), so that
  // "the aal1 one saw nothing" means something.
  for (let i = 0; i < 4 && events.aal2 === 0; i++) {
    await api(A.c, `/api/agents/${created.body.id}`, { name: `MFA probe ${i}` }, 'PATCH');
    for (let j = 0; j < 20 && events.aal2 === 0; j++) await sleep(250);
  }
  await sleep(1500);
  check('realtime: changes reach the aal2 session but not the aal1 one', events.aal2 > 0 && events.aal1 === 0, JSON.stringify(events));
  await A1.removeChannel(ch1);
  await A.c.removeChannel(ch2);

  // Finishing with the authenticator code; a code that was already used doesn't work twice.
  const once = await freshCode(totp);
  await A1.auth.mfa.challengeAndVerify({ factorId: en.data.id, code: once });
  // Known limitation, recorded rather than asserted: Supabase Auth (v2.197) accepts a TOTP code again
  // within its time window (and the previous window's code), in any session.
  const Areplay = await signIn(A);
  const replay = await Areplay.auth.mfa.challengeAndVerify({ factorId: en.data.id, code: once });
  console.log(`NOTE  Supabase ${replay.error ? 'refused' : 'accepted'} a TOTP code that was already used (no replay protection in Supabase Auth; see CLAUDE.md)`);
  const a1b = await token(A1);
  check('after the authenticator code the session works (API and database)', claims(a1b).aal === 'aal2' && (await api(a1b, '/api/usage')).status === 200 && (await visibleRows(A1)) > 0);
  const stepUpOk = await api(a1b, '/api/devices/approve', { code: 'ZZZZ-ZZZZ' });
  check('step-up: a second step verified just now lets a sensitive action through', stepUpOk.status === 404, `status ${stepUpOk.status}`);

  // Recovery codes.
  const A2 = await signIn(A);
  const rv = await A2.auth.mfa.recoveryCodes.verify({ code: rc.data.codes[0].toUpperCase().match(/.{1,4}/g).join('-') });
  const a2 = await token(A2);
  check('recovery code: signs in at aal2 (amr mfa/recovery_code)', !rv.error && claims(a2).aal === 'aal2' && claims(a2).amr.some((x) => x.method === 'mfa/recovery_code'));
  check('recovery code: the API accepts that session, and it counts as a fresh step-up', (await api(a2, '/api/usage')).status === 200 && (await api(a2, '/api/devices/approve', { code: 'ZZZZ-ZZZZ' })).status === 404);
  const A3 = await signIn(A);
  check('recovery code: each code works once', (await A3.auth.mfa.recoveryCodes.verify({ code: rc.data.codes[0] })).error?.code === 'mfa_verification_failed');
  let locked = false;
  for (let i = 0; i < 15 && !locked; i++) locked = (await A3.auth.mfa.recoveryCodes.verify({ code: `zzzz${i}zzzzzzzzzzz`.slice(0, 16) })).error?.code === 'mfa_recovery_codes_locked';
  check('recovery code: guessing gets locked out', locked);
  const regen = await A.c.auth.mfa.recoveryCodes.regenerate();
  const A4 = await signIn(A);
  check('recovery code: new codes make the old ones stop working', !regen.error && (await A4.auth.mfa.recoveryCodes.verify({ code: rc.data.codes[1] })).error);

  // ------------------------------------------------------------------ signed-out and revoked sessions (W-89)
  const A5 = await signIn(A);
  await A5.auth.mfa.challengeAndVerify({ factorId: en.data.id, code: await freshCode(totp) });
  const a5 = await token(A5);
  const live5 = (await api(a5, '/api/usage')).status === 200 && (await rowsFor(a5)) > 0;
  await A5.auth.signOut({ scope: 'local' });
  const out5 = await api(a5, '/api/usage');
  check('authenticator: a saved aal2 token stops working when its session signs out (API 401, no rows)', live5 && out5.status === 401 && out5.body.code === 'session_ended' && (await rowsFor(a5)) === 0, `${out5.status} ${out5.body.code}`);
  check('authenticator: …step-up actions included', (await api(a5, '/api/devices/approve', { code: 'ZZZZ-ZZZZ' })).status === 401);
  const A6 = await signIn(A);
  await A6.auth.mfa.recoveryCodes.verify({ code: regen.data.codes[0] });
  const a6 = await token(A6);
  const live6 = (await api(a6, '/api/usage')).status === 200;
  psql(`delete from auth.sessions where id = '${claims(a6).session_id}'`);
  check('authenticator: a session revoked on the server stops working at once', live6 && (await api(a6, '/api/usage')).status === 401 && (await rowsFor(a6)) === 0);

  // ------------------------------------------------------------------ email codes
  const [B, B2, B3] = await Promise.all([newUser('email'), newUser('email2'), newUser('email3')]);
  const enables = await Promise.all([B, B2, B3].map((u) => emailStep(u.c, u.email, 'enable')));
  check('email codes: turned on by verifying an emailed code', enables.every((e) => e.verify?.status === 200) && psql(`select count(*) from public.mfa_email e join auth.users u on u.id = e.user_id where u.email like '%${run}@mfa-e2e.test'`) === '3');
  await api(B.c, '/api/agents', { name: 'email probe', model: { source: 'test', model: 'script' } });
  const B1 = await signIn(B);
  const b1 = await token(B1);
  check('email codes: a password-only session is refused by the API and sees no rows', (await api(b1, '/api/usage')).body.code === 'mfa_required' && (await visibleRows(B1)) === 0);
  check('email codes: that session can’t ask for a step-up or enable code instead', (await api(b1, '/api/mfa/email/send', { purpose: 'step_up' })).status === 409 && (await api(b1, '/api/mfa/email/send', { purpose: 'enable' })).status === 409);

  // The bypass this design closes: enrol an authenticator straight through the Auth API with just the password.
  const ev2 = await B1.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Attacker' });
  await B1.auth.mfa.challengeAndVerify({ factorId: ev2.data.id, code: await freshCode(totpFor(ev2.data.totp.secret)) });
  const b1aal2 = await token(B1);
  check('email codes: an authenticator added behind the account’s back (aal2) still doesn’t get in', claims(b1aal2).aal === 'aal2' && (await api(b1aal2, '/api/usage')).body.code === 'mfa_required' && (await visibleRows(B1)) === 0);

  // Codes are tied to the request (session, purpose) that asked, capped, and single-use.
  await backdate(await idOf(B.c));
  const t0 = Date.now() - 1000;
  const sent = await api(b1aal2, '/api/mfa/email/send', { purpose: 'sign_in' });
  const chal1 = sent.body.challengeId;
  const code1 = await emailCode(B.email, t0);
  const again = await api(b1aal2, '/api/mfa/email/send', { purpose: 'sign_in' });
  check('email codes: asking again within a minute (a reload) sends nothing and gives the same request', again.status === 200 && again.body.sent === false && again.body.challengeId === chal1);
  const Bx = await signIn(B);
  check('email codes: another session within that minute is refused (cooldown)', (await api(Bx, '/api/mfa/email/send', { purpose: 'sign_in' })).body.code === 'code_cooldown');
  check('email codes: a code only counts in the session that asked for it', sent.status === 200 && (await api(Bx, '/api/mfa/email/verify', { code: code1, challengeId: chal1, purpose: 'sign_in' })).body.code === 'code_expired');
  check('email codes: a request is checked only for the purpose it was sent for', (await api(b1aal2, '/api/mfa/email/verify', { code: code1, challengeId: chal1, purpose: 'step_up' })).body.code === 'code_expired');
  const okB1 = await api(b1aal2, '/api/mfa/email/verify', { code: code1, challengeId: chal1, purpose: 'sign_in' });
  check('email codes: the right code in the right session finishes sign-in', okB1.status === 200 && (await api(b1aal2, '/api/usage')).status === 200 && (await visibleRows(B1)) > 0);
  check('email codes: the same code can’t be used again', (await api(b1aal2, '/api/mfa/email/verify', { code: code1, challengeId: chal1, purpose: 'sign_in' })).body.code === 'code_expired');

  // Wrong guesses are capped per code (B2).
  const B2s = await signIn(B2);
  const t2 = Date.now() - 1000;
  await backdate(await idOf(B2.c));
  const chal2 = (await api(B2s, '/api/mfa/email/send', { purpose: 'sign_in' })).body.challengeId;
  const code2 = await emailCode(B2.email, t2);
  const wrong = String((Number(code2) + 1) % 1000000).padStart(6, '0');
  const guesses = [];
  for (let i = 0; i < 5; i++) guesses.push((await api(B2s, '/api/mfa/email/verify', { code: wrong, challengeId: chal2, purpose: 'sign_in' })).body.code);
  const afterCap = await api(B2s, '/api/mfa/email/verify', { code: code2, challengeId: chal2, purpose: 'sign_in' });
  check('email codes: after 5 wrong guesses even the right code is refused', guesses.every((g) => g === 'code_invalid') && afterCap.body.code === 'code_attempts', `${guesses.join(',')} then ${afterCap.body.code}`);

  // Signing out ends what the email code granted, even for a token that hasn't expired yet (B3).
  const B3s = await signIn(B3);
  const t3 = Date.now() - 1000;
  await backdate(await idOf(B3.c));
  const chal3 = (await api(B3s, '/api/mfa/email/send', { purpose: 'sign_in' })).body.challengeId;
  const code3 = await emailCode(B3.email, t3);
  const sessionsBefore = psql(`select count(*) from auth.sessions s join auth.users u on u.id = s.user_id where u.email = '${B3.email}'`);
  const v3 = await api(B3s, '/api/mfa/email/verify', { code: code3, challengeId: chal3, purpose: 'sign_in' });
  const sessionsAfter = psql(`select count(*) from auth.sessions s join auth.users u on u.id = s.user_id where u.email = '${B3.email}'`);
  const b3 = await token(B3s);
  const before = (await api(b3, '/api/usage')).status;
  await B3s.auth.signOut({ scope: 'local' });
  const afterOut = await api(b3, '/api/usage');
  check('email codes: after signing out, the old token no longer passes', v3.status === 200 && before === 200 && afterOut.status === 401 && afterOut.body.code === 'session_ended', `${before} → ${afterOut.status}`);
  check('email codes: checking a code leaves no extra session behind', sessionsBefore === sessionsAfter, `${sessionsBefore} → ${sessionsAfter}`);

  // Turning email codes off needs a recently verified session (B2's first session passed "enable" a minute or two ago).
  const off = await api(B2.c, '/api/mfa/email', undefined, 'DELETE');
  check('email codes: turning them off works from a recently verified session', off.status === 200, `status ${off.status} ${off.body.code ?? ''}`);
  check('email codes: but not from a session that never verified (403 mfa_required)', (await api(Bx, '/api/mfa/email', undefined, 'DELETE')).status === 403);
  const bUser = await idOf(B.c);
  const pwSession = await sessionOf(Bx);
  check('database: the extra-session cleanup never ends a password session', psql(`select public.wren_end_otp_session('${bUser}', '${pwSession}')`) === 'f');

  // ------------------------------------------------------------------ competing code requests (W-90)
  const D = await newUser('compete');
  const dId = await idOf(D.c);
  const D2 = await signIn(D);
  const sA = await api(D.c, '/api/mfa/email/send', { purpose: 'step_up' });
  await backdate(dId);
  const tD = Date.now() - 1000;
  const sB = await api(D2, '/api/mfa/email/send', { purpose: 'step_up' });
  const codeB = await emailCode(D.email, tD);
  check('competing requests: the newest code doesn’t finish an older request of another session', (await api(D.c, '/api/mfa/email/verify', { code: codeB, challengeId: sA.body.challengeId, purpose: 'step_up' })).body.code === 'code_superseded');
  check('competing requests: …nor that other session’s request', (await api(D.c, '/api/mfa/email/verify', { code: codeB, challengeId: sB.body.challengeId, purpose: 'step_up' })).body.code === 'code_expired');
  // Two tabs of one session: "turn on email codes", then a step-up. The enable dialog can't finish with the step-up's code.
  await backdate(dId);
  const enableReq = await api(D2, '/api/mfa/email/send', { purpose: 'enable' });
  await backdate(dId);
  const tD2 = Date.now() - 1000;
  const stepReq = await api(D2, '/api/mfa/email/send', { purpose: 'step_up' });
  const codeS = await emailCode(D.email, tD2);
  const enableTry = await api(D2, '/api/mfa/email/verify', { code: codeS, challengeId: enableReq.body.challengeId, purpose: 'enable' });
  check('competing requests: an “enable” request superseded by a step-up can’t be finished; email codes stay off', enableReq.status === 200 && enableTry.body.code === 'code_superseded' && psql(`select count(*) from public.mfa_email where user_id = '${dId}'`) === '0', enableTry.body.code);
  check('competing requests: the step-up finishes with its own code', (await api(D2, '/api/mfa/email/verify', { code: codeS, challengeId: stepReq.body.challengeId, purpose: 'step_up' })).status === 200);

  // ------------------------------------------------------------------ email address changes (W-86)
  const E = await newUser('rename');
  const eId = await idOf(E.c);
  const tE = Date.now() - 1000;
  const eReq = await api(E.c, '/api/mfa/email/send', { purpose: 'step_up' });
  const eCode = await emailCode(E.email, tE);
  const newEmail = `renamed-${run}@mfa-e2e.test`;
  psql(`update auth.users set email = '${newEmail}' where id = '${eId}'`);
  users.push(newEmail);
  const staleTry = await api(E.c, '/api/mfa/email/verify', { code: eCode, challengeId: eReq.body.challengeId, purpose: 'step_up' });
  check('email change: a code sent to the old address no longer counts', staleTry.body.code === 'code_expired' && /changed/.test(staleTry.body.error ?? ''), staleTry.body.code);
  await backdate(eId);
  const tE2 = Date.now() - 1000;
  const eReq2 = await api(E.c, '/api/mfa/email/send', { purpose: 'step_up' });
  const newCode = await emailCode(newEmail, tE2);
  check('email change: new codes go to the current address, not the one in the (older) token', claims(await token(E.c)).email === E.email && eReq2.status === 200 && !!newCode);
  check('email change: /api/me shows the current address', (await api(E.c, '/api/me')).body.email === newEmail);
  check('email change: the code from the current address works', (await api(E.c, '/api/mfa/email/verify', { code: newCode, challengeId: eReq2.body.challengeId, purpose: 'step_up' })).status === 200);

  // ------------------------------------------------------------------ password changes with email codes on (W-87)
  const F = await newUser('pw');
  const fOn = await emailStep(F.c, F.email, 'enable');
  const fId = await idOf(F.c);
  const F1 = await signIn(F); // password only: not finished
  const direct1 = await F1.auth.updateUser({ password: `${F.password}-x1` });
  const tookX1 = !!(await client().auth.signInWithPassword({ email: F.email, password: `${F.password}-x1` })).data.session;
  check('password: a session that hasn’t passed the email code can’t change it through Supabase Auth directly', fOn.verify?.status === 200 && !!direct1.error && !tookX1, direct1.error?.message);
  check('password: …nor through Wren', (await api(F1, '/api/account/password', { password: `${F.password}-x2` })).body.code === 'mfa_required');
  await backdate(fId);
  const fStep = await emailStep(F1, F.email, 'sign_in');
  const direct2 = await F1.auth.updateUser({ password: `${F.password}-x3` });
  check('password: even a finished session can’t go around Wren’s checks', fStep.verify?.status === 200 && !!direct2.error);
  // A permit issued for one session doesn't let another session's change through.
  const F2 = await signIn(F);
  psql(`insert into public.mfa_password_permits (user_id, session_id) values ('${fId}', '${await sessionOf(F1)}')`);
  const direct3 = await F2.auth.updateUser({ password: `${F.password}-x4` });
  check('password: another session can’t ride on a permit issued for this one', !!direct3.error && (await api(F1, '/api/usage')).status === 200);
  psql(`delete from public.mfa_password_permits where user_id = '${fId}'`);
  const viaWren = await api(F1, '/api/account/password', { password: `${F.password}-new` });
  const newPw = await client().auth.signInWithPassword({ email: F.email, password: `${F.password}-new` });
  check('password: through Wren, right after the email code, it changes', viaWren.status === 200 && !!newPw.data.session, `${viaWren.status} ${viaWren.body.code ?? ''}`);
  check('password: the account’s other sessions end with it', (await api(F.c, '/api/me')).status === 401 && (await api(F1, '/api/usage')).status === 200);
  check('password: no permit is left over', psql(`select count(*) from public.mfa_password_permits where user_id = '${fId}'`) === '0');

  // ------------------------------------------------------------------ removing authenticators at once (W-94)
  const G = await newUser('two-apps');
  const g1 = await G.c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Phone' });
  const gt1 = totpFor(g1.data.totp.secret);
  await G.c.auth.mfa.challengeAndVerify({ factorId: g1.data.id, code: await freshCode(gt1) });
  await G.c.auth.mfa.recoveryCodes.generate();
  const g2 = await G.c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Tablet' });
  const gt2 = totpFor(g2.data.totp.secret);
  await G.c.auth.mfa.challengeAndVerify({ factorId: g2.data.id, code: await freshCode(gt2) });
  const G2 = await signIn(G);
  const viaSecond = await G2.auth.mfa.challengeAndVerify({ factorId: g2.data.id, code: await freshCode(gt2) });
  check('two apps: the second app’s code signs in with that app', !viaSecond.error && claims(await token(G2)).aal === 'aal2');
  const gId = await idOf(G.c);
  const factorsBefore = psql(`select count(*) from auth.mfa_factors where user_id = '${gId}'`);
  const [r1, r2] = await Promise.all([G.c.auth.mfa.unenroll({ factorId: g1.data.id }), G2.auth.mfa.unenroll({ factorId: g2.data.id })]);
  const left = psql(`select coalesce(string_agg(factor_type::text, ','), '') from auth.mfa_factors where user_id = '${gId}'`);
  check('two apps removed at once from two sessions: the recovery codes go too (never the only factor left)', factorsBefore === '3' && !r1.error && !r2.error && left === '', `${factorsBefore} → [${left}] ${r1.error?.message ?? ''} ${r2.error?.message ?? ''}`);
  check('…and the account signs in with just its password again', (await api(await token(await signIn(G)), '/api/usage')).status === 200);

  // ------------------------------------------------------------------ where sign-in sends you next (W-98)
  // Where a redirect goes, as an absolute URL (Next may answer with a relative Location).
  const loc = async (path, cookie) => {
    const l = (await fetch(`${WEB}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} })).headers.get('location');
    return l && new URL(l, WEB).href;
  };
  const link = '/app/link?code=ABCD-EFGH';
  check('redirects: the auth callback keeps the next page’s query (pairing links)', (await loc(`/auth/callback?next=${encodeURIComponent(link)}`)) === `${WEB}${link}`);
  const evil = await Promise.all(['//evil.example/app', 'https://evil.example/app', '/app/../login', '/\\evil.example/app', '/apple'].map((n) => loc(`/auth/callback?next=${encodeURIComponent(n)}`)));
  check('redirects: anything outside the app goes to /app instead', evil.every((l) => l === `${WEB}/app`), evil.join(' '));
  const sess = (await A.c.auth.getSession()).data.session;
  const cookie = `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(sess)).toString('base64url')}`;
  const signedInLoc = await loc(`/login?next=${encodeURIComponent(link)}`, cookie);
  check('redirects: a signed-in visit to /login?next=… keeps the query too', signedInLoc === `${WEB}${link}`, signedInLoc ?? 'no redirect');

  // ------------------------------------------------------------------ no two-step sign-in: step-up by email
  const C = await newUser('plain');
  check('no MFA: the API and database work as before', (await api(C.c, '/api/usage')).status === 200 && (await visibleRows(C.c)) > 0);
  const needs = await api(C.c, '/api/devices/approve', { code: 'ZZZZ-ZZZZ' });
  check('no MFA: linking a computer asks to confirm first (step_up_required)', needs.status === 403 && needs.body.code === 'step_up_required');
  check('no MFA: deleting the account asks to confirm first', (await api(C.c, '/api/account/settings', { confirm: 'DELETE' }, 'DELETE')).body.code === 'step_up_required');
  const cpw = await api(C.c, '/api/account/password', { password: `${C.password}-new` });
  check('no MFA: changing the password needs nothing more', cpw.status === 200, `${cpw.status} ${cpw.body.code ?? ''}`);
  const su = await emailStep(C.c, C.email, 'step_up');
  check('no MFA: after an email code the action goes through', su.verify?.status === 200 && (await api(C.c, '/api/devices/approve', { code: 'ZZZZ-ZZZZ' })).status === 404);
  const del = await api(C.c, '/api/account/settings', { confirm: 'DELETE' }, 'DELETE');
  check('no MFA: account deletion works after confirming', del.status === 200 && psql(`select count(*) from auth.users where email = '${C.email}'`) === '0');
  users.splice(users.indexOf(C.email), 1);

  // ------------------------------------------------------------------ what browsers can reach directly
  const rpc = await A.c.rpc('wren_mfa_state', { p_user: '00000000-0000-0000-0000-000000000000', p_session: null });
  check('database: the MFA state function isn’t callable by browsers', !!rpc.error);
  check('database: neither is the session cleanup', !!(await A.c.rpc('wren_end_otp_session', { p_user: '00000000-0000-0000-0000-000000000000', p_session: '00000000-0000-0000-0000-000000000000' })).error);
  const own = await A1.rpc('wren_session_ok');
  check('database: wren_session_ok only answers for the caller', own.error === null && typeof own.data === 'boolean');
  const hidden = await Promise.all(['mfa_email', 'mfa_session_checks', 'mfa_email_requests', 'mfa_password_permits'].map((t) => A.c.from(t).select('*')));
  check('database: Wren’s MFA tables aren’t readable by browsers', hidden.every((r) => !!r.error || (r.data ?? []).length === 0));
} catch (e) {
  check(`unexpected error: ${e.message}`, false);
} finally {
  for (const email of users) psql(`delete from auth.users where email = '${email}'`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
