import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { randomToken, sha256 } from '@/lib/crypto';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { body, json, route } from '@/lib/http';

// Desktop pairing, step 1 (unauthenticated, like an OAuth device flow): the
// app gets a short user code to show and a secret it uses to poll.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('').replace(/^(.{4})/, '$1-');

export const POST = route(async (req) => {
  const b = await body(req, z.object({ name: z.string().trim().min(1).max(60), platform: z.enum(['darwin', 'win32', 'linux']), arch: z.string().max(20).optional(), appVersion: z.string().max(30).optional() }));
  const pollSecret = randomToken();
  const userCode = code();
  const [p] = await db()`
    insert into public.device_pairings (user_code, poll_secret_hash, device_name, platform, arch, app_version, expires_at)
    values (${userCode}, ${sha256(pollSecret)}, ${b.name}, ${b.platform}, ${b.arch ?? null}, ${b.appVersion ?? null}, now() + interval '15 minutes')
    returning id`;
  return json({ pairId: p.id, userCode, pollSecret, verifyUrl: `${env.appUrl}/app/link?code=${encodeURIComponent(userCode)}`, expiresIn: 900, interval: 2 });
});
