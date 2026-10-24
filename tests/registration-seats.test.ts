import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { withTenant } from "../lib/db/tenant";
import {
  approveApplication,
  countPendingApplications,
  createStudentInTx,
} from "../capabilities/students/lib/service";
import { getUsageSnapshot, QuotaError } from "../lib/billing/quota";
import { studentApplications } from "../lib/db/schema";
import { createTestPool } from "./helpers/db-pool";
import { createTestAuthUser, createTestTenant } from "./helpers/test-tenant";

const pool = createTestPool();
let tenantId = "";
let ownerUser = "";

describe("Phase 4 registration & seats", () => {
  let applicationId = "";

  before(async () => {
    const t = await createTestTenant(pool);
    tenantId = t.tenantId;
    ownerUser = t.ownerUserId;

    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(
        sql`UPDATE subscriptions SET plan_key = 'free' WHERE tenant_id = ${tenantId}::uuid`,
      );
    });
  });

  after(async () => {
    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(sql`DELETE FROM class_enrolments`);
      await tx.execute(sql`DELETE FROM guardians`);
      await tx.execute(sql`DELETE FROM students`);
      await tx.execute(sql`DELETE FROM student_applications`);
      await tx.execute(sql`DELETE FROM registration_links`);
      await tx.execute(sql`DELETE FROM classes`);
      await tx.execute(sql`DELETE FROM subjects`);
      await tx.execute(sql`DELETE FROM setting_history`);
      await tx.execute(sql`DELETE FROM tenant_settings`);
      await tx.execute(sql`DELETE FROM usage_events`);
      await tx.execute(sql`DELETE FROM usage_counters`);
      await tx.execute(sql`DELETE FROM subscriptions`);
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

  it("pending application does not consume a student seat", async () => {
    const token = randomUUID().replace(/-/g, "");
    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO registration_links (tenant_id, token, label, requires_approval, is_active)
        VALUES (${tenantId}::uuid, ${token}, 'Test', true, true)
      `);
    });

    const link = await pool.query<{ id: string }>(
      `SELECT id FROM registration_links WHERE token = $1`,
      [token],
    );
    const linkId = link.rows[0]!.id;
    const authUser = await createTestAuthUser(pool, `applicant-${randomUUID()}`);

    const app = await pool.query<{ app_submit_student_application: string }>(
      `SELECT app_submit_student_application(
        $1::uuid, $2, 'Applicant One', 'a1@example.com', NULL, NULL, NULL,
        'Parent', 'p@example.com', NULL, 'parent', 'poster', '127.0.0.1'
      ) AS app_submit_student_application`,
      [linkId, authUser],
    );
    applicationId = app.rows[0]!.app_submit_student_application;

    const pending = await countPendingApplications(tenantId, ownerUser);
    assert.equal(pending, 1);

    const usage = await getUsageSnapshot(tenantId, ownerUser);
    assert.equal(usage.students ?? 0, 0);
  });

  it("approval consumes a seat and respects quota", async () => {
    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(
        sql`UPDATE usage_counters SET quantity = 30 WHERE metric = 'students'`,
      );
    });

    await assert.rejects(
      () =>
        approveApplication({
          tenantId,
          actorUserId: ownerUser,
          applicationId,
        }),
      QuotaError,
    );

    assert.equal(await countPendingApplications(tenantId, ownerUser), 1);

    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(
        sql`UPDATE usage_counters SET quantity = 0 WHERE metric = 'students'`,
      );
    });

    await approveApplication({
      tenantId,
      actorUserId: ownerUser,
      applicationId,
    });

    assert.equal(await countPendingApplications(tenantId, ownerUser), 0);
    const usage = await getUsageSnapshot(tenantId, ownerUser);
    assert.equal(usage.students ?? 0, 1);
  });

  it("manual createStudent also asserts quota before write", async () => {
    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(
        sql`UPDATE usage_counters SET quantity = 30 WHERE metric = 'students'`,
      );
      await assert.rejects(
        () =>
          createStudentInTx(tx, {
            tenantId,
            actorUserId: ownerUser,
            fullName: "Overflow",
            email: "overflow@example.com",
          }),
        QuotaError,
      );
    });
  });
});

void studentApplications;
