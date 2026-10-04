import postgres from 'postgres';
import { env } from './env';

// One small pool per function instance. The production URL points at the
// Supavisor transaction pooler, so prepared statements are disabled.

declare global {
  var __wrenSql: postgres.Sql | undefined;
}

export function db(): postgres.Sql {
  if (!globalThis.__wrenSql) {
    globalThis.__wrenSql = postgres(env.databaseUrl, {
      prepare: false,
      max: Number(process.env.WREN_DB_POOL ?? 4),
      idle_timeout: 20,
      connect_timeout: 15,
      onnotice: () => {},
      ssl: env.databaseUrl.includes('127.0.0.1') || env.databaseUrl.includes('localhost') ? false : 'require',
    });
  }
  return globalThis.__wrenSql;
}

export type Sql = postgres.Sql;
export type Json = postgres.JSONValue;
