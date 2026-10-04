import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env';

// AES-256-GCM for stored provider credentials. The owning user id is bound as
// additional authenticated data, so a ciphertext copied to another user's row
// will not decrypt.

function key(): Buffer {
  const k = Buffer.from(env.secretsKey, 'hex');
  if (k.length !== 32) throw new Error('WREN_SECRETS_KEY must be 32 bytes of hex');
  return k;
}

export function encryptSecret(plain: string, userId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function decryptSecret(blob: string, userId: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(userId));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hint(secret: string): string {
  const s = secret.trim();
  return s.length <= 8 ? '••••' : `${s.slice(0, Math.min(6, s.indexOf('-') > 0 ? s.indexOf('-') + 1 : 3))}…${s.slice(-4)}`;
}
