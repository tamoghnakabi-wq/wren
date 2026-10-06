'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;

export function supabase(): SupabaseClient {
  // Recovery codes are a Supabase Auth MFA factor still flagged experimental in supabase-js.
  client ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { experimental: { recoveryCodes: true } } });
  return client;
}
