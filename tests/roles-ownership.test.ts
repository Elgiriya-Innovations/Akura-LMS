import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import { memberships } from "../lib/db/schema";
import { assertRole, ForbiddenError, ADMIN_ROLES } from "../lib/rbac";
import {
  countOwnersWithTenant,
  disableMembership,
  transferOwnership,
} from "../lib/tenant/ownership";
import { withTenant } from "../lib/db/tenant";
import { createTestPool } from "./helpers/db-pool";
import { createTestAuthUser, createTestTenant } from "./helpers/test-tenant";

const pool = createTestPool();
let tenantId = "";
let ownerUser = "";
const adminUser = `admin-${randomUUID()}`;
const teacherUser = `teacher-${randomUUID()}`;

describe("Phase 2 roles & ownership", () => {
  let ownerMembershipId = "";
  let adminMembershipId = "";

  before(async () => {
    const t = await createTestTenant(pool);
    tenantId = t.tenantId;
    ownerUser = t.ownerUserId;
    await createTestAuthUser(pool, adminUser);
    await createTestAuthUser(pool, teacherUser);

    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      const [admin] = await tx
        .insert(memberships)
        .values({
          tenantId,
          authUserId: adminUser,
          role: "admin",
          isOwner: false,
          status: "active",
        })
        .returning();
      adminMembershipId = admin!.id;

      await tx.insert(memberships).values({
        tenantId,
        authUserId: teacherUser,
        role: "teacher",
        isOwner: false,
        status: "active",
      });

      const [owner] = await tx
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.authUserId, ownerUser),
            eq(memberships.isOwner, true),
            isNull(memberships.deletedAt),
          ),
        )
        .limit(1);
      ownerMembershipId = owner!.id;
    });
  });

  after(async () => {
    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(sql`DELETE FROM invitations`);
      await tx.execute(sql`DELETE FROM audit_log`);
      await tx.execute(sql`DELETE FROM events`);
      await tx.execute(sql`DELETE FROM memberships`);
    });
    await pool.query(`UPDATE tenants SET deleted_at = now() WHERE id = $1`, [
      tenantId,
    ]);
    await pool.end();
  });

  it("teacher role is forbidden on admin routes (assertRole)", () => {
    assert.throws(
      () => assertRole("teacher", ADMIN_ROLES),
      (err: unknown) => err instanceof ForbiddenError,
    );
  });

  it("tenant always has exactly one owner after create", async () => {
    const n = await countOwnersWithTenant({
      tenantId,
      userId: ownerUser,
    });
    assert.equal(n, 1);
  });

  it("cannot disable the last owner", async () => {
    await assert.rejects(
      () =>
        disableMembership({
          tenantId,
          actorUserId: ownerUser,
          targetMembershipId: ownerMembershipId,
        }),
      (err: unknown) =>
        err instanceof Error && /owner/i.test(err.message),
    );
  });

  it("ownership transfer keeps exactly one owner", async () => {
    await transferOwnership({
      tenantId,
      currentOwnerUserId: ownerUser,
      newOwnerMembershipId: adminMembershipId,
    });
    const n = await countOwnersWithTenant({
      tenantId,
      userId: adminUser,
    });
    assert.equal(n, 1);
  });
});
