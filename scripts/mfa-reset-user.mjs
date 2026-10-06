// Operator tool: turn off two-step sign-in for one account, for someone who has lost their
// authenticator app AND their recovery codes. Verify who they are first (out of band); this removes
// every MFA factor through the Supabase Auth Admin API and turns email codes off.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SECRET_KEY=sb_secret_… DATABASE_URL=postgres://… \
//     node scripts/mfa-reset-user.mjs person@example.com
//
// The secret key bypasses all access rules: keep it out of the web app and this repo.
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../apps/web/package.json', import.meta.url)));
const { createClient } = require('@supabase/supabase-js');
const postgres = require('postgres');

const email = process.argv[2]?.toLowerCase();
const { SUPABASE_URL, SUPABASE_SECRET_KEY, DATABASE_URL } = process.env;
if (!email || !SUPABASE_URL || !SUPABASE_SECRET_KEY || !DATABASE_URL) {
  console.error('usage: SUPABASE_URL=… SUPABASE_SECRET_KEY=… DATABASE_URL=… node scripts/mfa-reset-user.mjs <email>');
  process.exit(2);
}
const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const sql = postgres(DATABASE_URL, { max: 1 });
const [user] = await sql`select id from auth.users where lower(email) = ${email}`;
if (!user) throw new Error(`No account for ${email}`);
const { data, error } = await admin.auth.admin.mfa.listFactors({ userId: user.id });
if (error) throw error;
const [mail] = await sql`select 1 from public.mfa_email where user_id = ${user.id}`;
console.log(`${email}: ${data.factors.length} factor(s) [${data.factors.map((f) => `${f.factor_type}:${f.status}`).join(', ')}], email codes ${mail ? 'on' : 'off'}`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
if ((await rl.question('Remove all of them? Type the email to confirm: ')).trim().toLowerCase() !== email) {
  console.log('Cancelled.');
  process.exit(1);
}
rl.close();
for (const f of data.factors) {
  const r = await admin.auth.admin.mfa.deleteFactor({ userId: user.id, id: f.id });
  if (r.error) throw r.error;
}
await sql`delete from public.mfa_email where user_id = ${user.id}`;
await sql.end();
console.log('Done. They can sign in with their password and set up two-step sign-in again.');
