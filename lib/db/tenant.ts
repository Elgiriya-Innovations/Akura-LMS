import { sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import { db } from "./index";
import * as schema from "./schema";

export type Tx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * The only allowed path for tenant-owned data.
 * Assumes akura_app (NOBYPASSRLS) then sets transaction-local GUCs so RLS
 * applies under PgBouncer (Neon pooled endpoint) transaction pooling.
 */
export async function withTenant<T>(
  ctx: { tenantId: string; userId: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE akura_app`);
    await tx.execute(
      sql`SELECT set_config('app.current_tenant', ${ctx.tenantId}, true)`,
    );
    await tx.execute(
      sql`SELECT set_config('app.current_user', ${ctx.userId}, true)`,
    );
    return fn(tx);
  });
}
