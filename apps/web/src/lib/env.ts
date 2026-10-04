// Centralised environment access (server only).

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  get supabaseUrl() {
    return req('NEXT_PUBLIC_SUPABASE_URL');
  },
  get supabaseKey() {
    return req('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  },
  get databaseUrl() {
    return req('DATABASE_URL');
  },
  get secretsKey() {
    return req('WREN_SECRETS_KEY');
  },
  get internalSecret() {
    return req('WREN_INTERNAL_SECRET');
  },
  get cronSecret() {
    return req('CRON_SECRET');
  },
  get appUrl() {
    return (process.env.WREN_APP_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:5310')).replace(/\/$/, '');
  },
  vapidPublic: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '',
  vapidPrivate: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:wren@example.com',
  /** Comma-separated emails allowed to use the operator's AI Gateway credits. */
  platformModelUsers: (process.env.PLATFORM_MODEL_USERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** Enables the scripted test model (automated end-to-end tests only). */
  testModel: process.env.WREN_TEST_MODEL === '1',
  sandboxRegion: process.env.WREN_SANDBOX_REGION ?? 'syd1',
  releasesRepo: process.env.WREN_RELEASES_REPO ?? 'tamoghnakabi-wq/wren',
};

/** Where the current function is running: used to self-invoke the next tick. */
export function selfUrl(): string {
  if (process.env.WREN_SELF_URL) return process.env.WREN_SELF_URL.replace(/\/$/, '');
  if (process.env.VERCEL_ENV === 'production' && process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:5310';
}
