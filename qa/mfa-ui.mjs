// Two-step sign-in in the real web UI (headless Chrome) against the LOCAL stack.
//
//   npx supabase start && node scripts/local-auth-recovery-codes.mjs && npm run dev
//   node qa/mfa-ui.mjs [screenshot-dir]
//
// Throwaway users (…@mfa-ui.test) are created on the local stack and deleted afterwards.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(`${root}apps/web/package.json`);
const { createClient } = require('@supabase/supabase-js');
const OTPAuth = require('otpauth');
const { chromium } = require(`${root}node_modules/playwright-core`);

const SUPABASE = 'http://127.0.0.1:54321';
const KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const WEB = 'http://localhost:5310';
const MAILPIT = 'http://127.0.0.1:54324';
const shots = process.argv[2];

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
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
const run = Date.now().toString(36);
const users = [];
const client = () => createClient(SUPABASE, KEY, { auth: { persistSession: false, autoRefreshToken: false, experimental: { recoveryCodes: true } } });

async function newUser(tag) {
  const u = { email: `${tag}-${run}@mfa-ui.test`, password: `Pw-${run}-${Math.random().toString(36).slice(2)}`, c: client() };
  const { error } = await u.c.auth.signUp({ email: u.email, password: u.password });
  if (error) throw error;
  users.push(u.email);
  return u;
}
async function emailCode(email, after) {
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    const m = (list.messages ?? []).find((x) => Date.parse(x.Created) >= after && /verification code/i.test(x.Subject));
    if (m) return />\s*(\d{6})\s*</.exec((await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()).HTML)[1];
    await sleep(250);
  }
  throw new Error(`no code email for ${email}`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const axe = readFileSync(`${root}node_modules/axe-core/axe.min.js`, 'utf8');
async function a11y(page) {
  await page.addScriptTag({ content: axe });
  const r = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id));
  return r;
}
async function login(page, u, next = '') {
  await page.goto(`${WEB}/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  await page.fill('#email', u.email);
  await page.fill('#password', u.password);
  await page.click('button[type=submit]');
}
const seen = (loc, timeout = 10000) => loc.waitFor({ timeout }).then(() => true, () => false);
const fresh = async () => (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
/** Skip Wren's one-code-a-minute gap for this account (Supabase Auth's own gap is a second locally). */
async function backdate(email) {
  psql(`update public.mfa_email_requests set sent_at = sent_at - interval '61 seconds' where user_id = (select id from auth.users where email = '${email}')`);
  await sleep(1100);
}

try {
  // --- authenticator app at sign-in, with a deep link
  const A = await newUser('totp');
  const en = await A.c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Phone' });
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(en.data.totp.secret) });
  await A.c.auth.mfa.challengeAndVerify({ factorId: en.data.id, code: await freshCode(totp) });
  const codes = (await A.c.auth.mfa.recoveryCodes.generate()).data.codes;
  let page = await fresh();
  await login(page, A, '/app/settings');
  await page.waitForURL(/\/auth\/mfa/);
  check('sign-in: an authenticator account lands on the two-step page', page.url().includes('next=%2Fapp%2Fsettings'));
  check('two-step page: no serious accessibility problems', (await a11y(page)).length === 0);
  if (shots) await page.screenshot({ path: `${shots}/mfa-totp.png` });
  await page.goto(`${WEB}/app`); // typing an app URL doesn't skip it
  await page.waitForURL(/\/auth\/mfa/);
  check('the app itself redirects back to the two-step page', true);
  await page.goto(`${WEB}/auth/mfa?next=${encodeURIComponent('/app/settings')}`);
  await page.getByLabel('Code from your authenticator app').fill('000000');
  await page.getByRole('button', { name: 'Continue' }).click();
  check('a wrong code shows an error', await seen(page.getByRole('alert').filter({ hasText: 'isn’t right' })));
  await page.getByLabel('Code from your authenticator app').fill(await freshCode(totp));
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/app\/settings/, { timeout: 15000 });
  check('the right code continues to the page that was asked for', page.url().endsWith('/app/settings'));
  await page.getByText('Recovery codes').first().waitFor();
  check('settings show the authenticator and 10 recovery codes left', await seen(page.getByText('10 of 10 left')));
  if (shots) await page.screenshot({ path: `${shots}/security-on.png`, fullPage: true });
  await page.context().close();

  // --- edge cases: signed out, and a hostile "next"
  page = await fresh();
  await page.goto(`${WEB}/auth/mfa?next=/app/settings`);
  await page.waitForURL(/\/login/, { timeout: 10000 });
  check('the two-step page sends signed-out visitors to sign in', page.url().includes('/login'));
  await page.context().close();
  for (const evil of ['https://evil.example/x', '//evil.example', '/\\evil.example']) {
    page = await fresh();
    await login(page, A);
    await page.waitForURL(/\/auth\/mfa/);
    await page.goto(`${WEB}/auth/mfa?next=${encodeURIComponent(evil)}`);
    await page.getByLabel('Code from your authenticator app').fill(await freshCode(totp));
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL((u) => new URL(u).pathname.startsWith('/app'), { timeout: 15000 }).catch(() => {});
    check(`a hostile next (${evil}) stays on Wren`, new URL(page.url()).origin === WEB && new URL(page.url()).pathname.startsWith('/app'), page.url());
    await page.context().close();
  }

  // --- recovery code at sign-in
  page = await fresh();
  await login(page, A);
  await page.waitForURL(/\/auth\/mfa/);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel('Recovery code').fill(codes[0].toUpperCase().match(/.{1,4}/g).join('-'));
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/app(\/)?$/, { timeout: 15000 });
  check('sign-in with a recovery code works', true);
  await page.goto(`${WEB}/app/settings`);
  check('…and spends that code (9 left)', await seen(page.getByText('9 of 10 left')));
  await page.context().close();

  // --- two authenticators: sign-in lets you pick the one you have (W-93)
  const en2 = await A.c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Tablet' });
  const totp2 = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(en2.data.totp.secret) });
  await A.c.auth.mfa.challengeAndVerify({ factorId: en2.data.id, code: await freshCode(totp2) });
  page = await fresh();
  await login(page, A);
  await page.waitForURL(/\/auth\/mfa/);
  const picker = page.getByLabel('Authenticator app', { exact: true });
  check('two authenticators: sign-in asks which one', await seen(picker) && (await picker.locator('option').allInnerTexts()).join(',') === 'Phone,Tablet');
  await picker.selectOption({ label: 'Tablet' });
  if (shots) await page.screenshot({ path: `${shots}/mfa-pick-app.png` });
  await page.getByLabel('Code from your authenticator app').fill(await freshCode(totp2));
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/app(\/)?$/, { timeout: 15000 }).catch(() => {});
  check('two authenticators: the second one’s code signs in', new URL(page.url()).pathname.replace(/\/$/, '') === '/app', page.url());
  await page.context().close();

  // --- set up an authenticator from Settings (no two-step sign-in yet): confirm by email, scan, codes
  const S = await newUser('setup');
  page = await fresh();
  await login(page, S);
  await page.waitForURL(/\/app/);
  await page.goto(`${WEB}/app/settings`);
  const t0 = Date.now() - 1000;
  await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
  await page.getByRole('dialog', { name: 'Confirm it’s you' }).waitFor();
  check('setting up asks to confirm with an email code first', true);
  await page.getByLabel('Code from the email').fill(await emailCode(S.email, t0));
  await page.getByRole('button', { name: 'Confirm' }).click();
  const enroll = page.getByRole('dialog', { name: 'Set up an authenticator app' });
  await enroll.getByRole('img', { name: /QR code/ }).waitFor({ timeout: 10000 });
  const key = (await enroll.locator('p.font-mono').innerText()).replace(/\s+/g, '');
  if (shots) await page.screenshot({ path: `${shots}/enroll.png` });
  await enroll.getByLabel('Code from the app').fill(new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(key) }).generate());
  await enroll.getByRole('button', { name: 'Turn on' }).click();
  const saved = page.getByRole('dialog', { name: 'Save your recovery codes' });
  await saved.waitFor({ timeout: 15000 });
  const shown = await saved.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem').count();
  check('turning it on shows 10 recovery codes once', shown === 10);
  if (shots) await page.screenshot({ path: `${shots}/recovery-codes.png` });
  await saved.getByRole('button', { name: 'I’ve saved them' }).click();
  check('Security now shows the authenticator as on', await seen(page.getByText('10 of 10 left')));
  check('Supabase has the authenticator and recovery codes', psql(`select string_agg(factor_type::text, ',' order by factor_type) from auth.mfa_factors f join auth.users u on u.id = f.user_id where u.email = '${S.email}' and status = 'verified'`) === 'totp,recovery_code' || psql(`select count(*) from auth.mfa_factors f join auth.users u on u.id = f.user_id where u.email = '${S.email}' and status = 'verified'`) === '2');

  // --- remove it again (just verified, so no new prompt), recovery codes go with it
  await page.getByRole('button', { name: 'Remove Authenticator app' }).click();
  await page.getByRole('dialog', { name: 'Remove this authenticator app?' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Set up an authenticator app' }).waitFor({ timeout: 15000 });
  check('removing the only authenticator also removes the recovery codes', psql(`select count(*) from auth.mfa_factors f join auth.users u on u.id = f.user_id where u.email = '${S.email}'`) === '0');
  await page.context().close();

  // --- email codes: turn on in Settings, then sign in with one
  const E = await newUser('email');
  page = await fresh();
  await login(page, E);
  await page.waitForURL(/\/app/);
  await page.goto(`${WEB}/app/settings`);
  const t1 = Date.now() - 1000;
  await page.getByRole('button', { name: 'Turn on email codes' }).click();
  await page.getByLabel('Code from the email').fill(await emailCode(E.email, t1));
  await page.getByRole('dialog', { name: 'Turn on email codes' }).getByRole('button', { name: 'Turn on' }).click();
  check('email codes turn on after entering the emailed code', await seen(page.getByText(/Signing in asks for a code sent to/)));
  await page.context().close();
  await backdate(E.email);
  page = await fresh();
  const t2 = Date.now() - 1000;
  await login(page, E);
  await page.waitForURL(/\/auth\/mfa/);
  await page.getByText(/We sent a code to/).waitFor({ timeout: 10000 });
  if (shots) await page.screenshot({ path: `${shots}/mfa-email.png` });
  await page.getByLabel('Code from the email').fill(await emailCode(E.email, t2));
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/app(\/)?$/, { timeout: 15000 });
  check('sign-in with an email code works', true);

  // --- choosing a new password goes through Wren (W-87); this session just passed an email code
  await page.goto(`${WEB}/auth/update-password`);
  await page.getByLabel('New password').fill(`${E.password}-new`);
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.waitForURL(/\/app(\/)?$/, { timeout: 15000 }).catch(() => {});
  const newPw = await client().auth.signInWithPassword({ email: E.email, password: `${E.password}-new` });
  check('new password: saved through Wren for an email-code account', !!newPw.data.session, page.url());
  E.password = `${E.password}-new`;

  // --- an authenticator added while email codes can't be turned off: email codes stay visible (W-95)
  await page.goto(`${WEB}/app/settings`);
  await page.route('**/api/mfa/email', (r) => (r.request().method() === 'DELETE' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down","code":"internal"}' }) : r.continue()));
  await page.getByRole('button', { name: 'Set up an authenticator app' }).click();
  const enrollE = page.getByRole('dialog', { name: 'Set up an authenticator app' });
  await enrollE.getByRole('img', { name: /QR code/ }).waitFor({ timeout: 10000 });
  const keyE = (await enrollE.locator('p.font-mono').innerText()).replace(/\s+/g, '');
  await enrollE.getByLabel('Code from the app').fill(new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(keyE) }).generate());
  await enrollE.getByRole('button', { name: 'Turn on' }).click();
  check('email-off failure: the user is told email codes are still on', await seen(page.getByText(/email codes are still on/i).first()));
  const savedE = page.getByRole('dialog', { name: 'Save your recovery codes' });
  if (await seen(savedE, 5000)) await savedE.getByRole('button', { name: 'I’ve saved them' }).click();
  check('email-off failure: Settings keeps showing email codes, with a way to turn them off', await seen(page.getByText(/Still on: signing in asks for a code sent to/)) && (await page.getByRole('button', { name: 'Turn off email codes' }).count()) === 1);
  if (shots) await page.screenshot({ path: `${shots}/security-email-still-on.png`, fullPage: true });
  await page.unroute('**/api/mfa/email');
  await page.getByRole('button', { name: 'Turn off email codes' }).click();
  await page.getByRole('dialog', { name: 'Turn off email codes?' }).getByRole('button', { name: 'Turn off' }).click();
  await page.getByRole('dialog', { name: 'Turn off email codes?' }).waitFor({ state: 'hidden' }).catch(() => {});
  check('email-off failure: turning them off afterwards works', await seen(page.getByText('Email codes turned off.')) && psql(`select count(*) from public.mfa_email e join auth.users u on u.id = e.user_id where u.email = '${E.email}'`) === '0');
  await page.context().close();

  // --- a session revoked on the server: the app sends the browser to sign in (W-89)
  const R = await newUser('revoked');
  page = await fresh();
  await login(page, R);
  await page.waitForURL(/\/app/);
  psql(`delete from auth.sessions where user_id = (select id from auth.users where email = '${R.email}')`);
  await page.goto(`${WEB}/app/settings`);
  await page.waitForURL(/\/login/, { timeout: 15000 }).catch(() => {});
  check('revoked session: opening the app leads to sign-in (no redirect loop)', new URL(page.url()).pathname === '/login', page.url());
  await page.context().close();

  // --- deleting an account asks to confirm with an email code
  const D = await newUser('delete');
  page = await fresh();
  await login(page, D);
  await page.waitForURL(/\/app/);
  await page.goto(`${WEB}/app/settings`);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByLabel(/Type DELETE/i).fill('DELETE');
  const t3 = Date.now() - 1000;
  await page.getByRole('button', { name: 'Delete account' }).click();
  await page.getByRole('dialog', { name: 'Confirm it’s you' }).waitFor({ timeout: 10000 });
  check('deleting the account opens “Confirm it’s you”', true);
  await page.getByLabel('Code from the email').fill(await emailCode(D.email, t3));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 20000 });
  check('after the code the account is deleted', psql(`select count(*) from auth.users where email = '${D.email}'`) === '0');
  users.splice(users.indexOf(D.email), 1);
  await page.context().close();
} catch (e) {
  check(`unexpected error: ${e.message.split('\n')[0]}`, false);
} finally {
  await browser.close();
  for (const email of users) psql(`delete from auth.users where email = '${email}'`);
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
