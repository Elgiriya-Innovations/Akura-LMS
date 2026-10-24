import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import { auditLog, events, memberships } from "../lib/db/schema";
import { createTestPool } from "./helpers/db-pool";
import { createTestAuthUser, createTestTenant } from "./helpers/test-tenant";

const pool = createTestPool();
const db = drizzle(pool, { schema });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function withTenantLocal<T>(
  ctx: { tenantId: string; userId: string },
  fn: (tx: Tx) => Promise<T>,
) {
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

let tenantA = "";
let tenantB = "";
const userA = `user-a-${randomUUID()}`;
const userB = `user-b-${randomUUID()}`;

describe("RLS tenant isolation", () => {
  before(async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    tenantA = a.tenantId;
    tenantB = b.tenantId;
    await createTestAuthUser(pool, userA);
    await createTestAuthUser(pool, userB);

    await withTenantLocal({ tenantId: tenantA, userId: userA }, async (tx) => {
      await tx.insert(memberships).values({
        tenantId: tenantA,
        authUserId: userA,
        role: "admin",
        isOwner: true,
        status: "active",
      });
      await tx.insert(auditLog).values({
        tenantId: tenantA,
        actorUserId: userA,
        action: "test.seed",
        entityType: "tenant",
        entityId: tenantA,
        payload: {},
      });
      await tx.insert(events).values({
        tenantId: tenantA,
        type: "test.seed",
        payload: {},
      });
    });

    await withTenantLocal({ tenantId: tenantB, userId: userB }, async (tx) => {
      await tx.insert(memberships).values({
        tenantId: tenantB,
        authUserId: userB,
        role: "admin",
        isOwner: true,
        status: "active",
      });
      await tx.insert(auditLog).values({
        tenantId: tenantB,
        actorUserId: userB,
        action: "test.seed",
        entityType: "tenant",
        entityId: tenantB,
        payload: {},
      });
      await tx.insert(events).values({
        tenantId: tenantB,
        type: "test.seed",
        payload: {},
      });
    });
  });

  after(async () => {
    for (const id of [tenantA, tenantB]) {
      if (!id) continue;
      await withTenantLocal({ tenantId: id, userId: "cleanup" }, async (tx) => {
        await tx.execute(sql`DELETE FROM audit_log`);
        await tx.execute(sql`DELETE FROM events`);
        await tx.execute(sql`DELETE FROM memberships`);
      });
      await pool.query(`UPDATE tenants SET deleted_at = now() WHERE id = $1`, [id]);
    }
    await pool.end();
  });

  it("Tenant A withTenant sees only A memberships, audit_log, events", async () => {
    await withTenantLocal({ tenantId: tenantA, userId: userA }, async (tx) => {
      const mem = await tx.select().from(memberships);
      const audit = await tx.select().from(auditLog);
      const ev = await tx.select().from(events);
      assert.ok(mem.every((r) => r.tenantId === tenantA));
      assert.ok(audit.every((r) => r.tenantId === tenantA));
      assert.ok(ev.every((r) => r.tenantId === tenantA));
      assert.equal(mem.filter((r) => r.tenantId === tenantB).length, 0);
    });
  });

  it("unscoped SELECT inside Tenant A GUC still returns zero Tenant B rows", async () => {
    await withTenantLocal({ tenantId: tenantA, userId: userA }, async (tx) => {
      const audit = await tx.execute<{ tenant_id: string }>(
        sql`SELECT tenant_id FROM audit_log`,
      );
      const ev = await tx.execute<{ tenant_id: string }>(
        sql`SELECT tenant_id FROM events`,
      );
      const mem = await tx.execute<{ tenant_id: string }>(
        sql`SELECT tenant_id FROM memberships`,
      );

      const auditRows = (audit as unknown as { rows: { tenant_id: string }[] }).rows ?? [];
      const eventRows = (ev as unknown as { rows: { tenant_id: string }[] }).rows ?? [];
      const memRows = (mem as unknown as { rows: { tenant_id: string }[] }).rows ?? [];

      assert.ok(auditRows.every((r) => r.tenant_id === tenantA));
      assert.ok(eventRows.every((r) => r.tenant_id === tenantA));
      assert.ok(memRows.every((r) => r.tenant_id === tenantA));
      assert.equal(auditRows.filter((r) => r.tenant_id === tenantB).length, 0);
      assert.equal(eventRows.filter((r) => r.tenant_id === tenantB).length, 0);
      assert.equal(memRows.filter((r) => r.tenant_id === tenantB).length, 0);
    });
  });

  it("query without GUC fails closed (zero rows via missing_ok setting)", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE akura_app`);
      const audit = await tx.execute<{ tenant_id: string }>(
        sql`SELECT tenant_id FROM audit_log`,
      );
      const rows = (audit as unknown as { rows: unknown[] }).rows ?? [];
      assert.equal(rows.length, 0);
    });
  });
});
