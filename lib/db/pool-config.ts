import type { PoolConfig } from "pg";

/**
 * Neon Postgres. Requests use the pooled (`-pooler`) endpoint, which is
 * PgBouncer in transaction mode — hence SET LOCAL inside withTenant().
 * Neon serves publicly trusted certificates, so TLS is verified.
 * DATABASE_SSL=false is for local Postgres / CI only.
 */
export function pgPoolConfig(connectionString: string): PoolConfig {
  const url = connectionString
    .replace(/[?&](sslmode|channel_binding)=[^&]*/g, "")
    .replace(/\?$/, "")
    .replace(/\?&/, "?");
  return {
    connectionString: url,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true },
    // Small per-instance pool: many serverless instances share Neon's pooler.
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
  };
}
