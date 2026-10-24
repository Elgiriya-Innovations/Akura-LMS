import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createTestPool } from "./helpers/db-pool";
import { createTestAuthUser, createTestTenant } from "./helpers/test-tenant";
import { sql } from "drizzle-orm";
import { withTenant } from "../lib/db/tenant";
import { classes, modules } from "../lib/db/schema";
import { createStudentInTx } from "../capabilities/students/lib/service";
import {
  assertStorageQuota,
  CourseError,
  createCourse,
  getCourseEditor,
  getStudentCourseView,
  isModuleUnlocked,
  listPublishedCoursesForStudent,
  publishCourse,
  addModule,
  addResource,
} from "../capabilities/courses/lib/service";
import { QuotaError } from "../lib/billing/quota";
import { setSetting } from "../lib/settings";

const pool = createTestPool();
let tenantId = "";
let ownerUser = "";
const teacherA = `teacher-a-${randomUUID()}`;
const teacherB = `teacher-b-${randomUUID()}`;

describe("Phase 7 courses & drip", () => {
  let classId = "";
  let studentId = "";

  before(async () => {
    const t = await createTestTenant(pool);
    tenantId = t.tenantId;
    ownerUser = t.ownerUserId;
    await createTestAuthUser(pool, teacherA);
    await createTestAuthUser(pool, teacherB);

    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO memberships (tenant_id, auth_user_id, role, status, is_owner)
        VALUES
          (${tenantId}::uuid, ${teacherA}, 'teacher', 'active', false),
          (${tenantId}::uuid, ${teacherB}, 'teacher', 'active', false)
      `);
      const [klass] = await tx
        .insert(classes)
        .values({
          tenantId,
          name: "Physics",
          teacherAuthUserId: teacherA,
        })
        .returning();
      classId = klass!.id;

      const student = await createStudentInTx(tx, {
        tenantId,
        actorUserId: ownerUser,
        fullName: "Learner",
        classId,
      });
      studentId = student.id;
    });

    await setSetting({
      tenantId,
      userId: ownerUser,
      key: "courses.drip_enabled_default",
      value: false,
    });
  });

  after(async () => {
    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
        await tx.execute(sql`DELETE FROM resource_views`);
        await tx.execute(sql`DELETE FROM resources`);
        await tx.execute(sql`DELETE FROM modules`);
        await tx.execute(sql`DELETE FROM courses`);
        await tx.execute(sql`DELETE FROM class_enrolments`);
        await tx.execute(sql`DELETE FROM guardians`);
        await tx.execute(sql`DELETE FROM students`);
        await tx.execute(sql`DELETE FROM classes`);
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

  it("isModuleUnlocked respects drip and available_at", () => {
    assert.equal(isModuleUnlocked({ dripEnabled: false, availableAt: null }), true);
    assert.equal(
      isModuleUnlocked({
        dripEnabled: true,
        availableAt: new Date(Date.now() + 60_000),
      }),
      false,
    );
    assert.equal(
      isModuleUnlocked({
        dripEnabled: true,
        availableAt: new Date(Date.now() - 60_000),
      }),
      true,
    );
  });

  it("draft courses hidden from students; drip hides resources; teacher B cannot edit", async () => {
    const course = await createCourse({
      tenantId,
      userId: teacherA,
      classId,
      title: "Mechanics",
      isAdmin: false,
    });

    const draftList = await listPublishedCoursesForStudent({
      tenantId,
      userId: ownerUser,
      studentId,
    });
    assert.equal(draftList.filter((c) => c.course.id === course.id).length, 0);

    const mod = await addModule({
      tenantId,
      userId: teacherA,
      courseId: course.id,
      title: "Module 1",
      isAdmin: false,
      availableAt: new Date(Date.now() + 86400_000),
    });

    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx
        .update(modules)
        .set({
          dripEnabled: true,
          availableAt: new Date(Date.now() + 86400_000),
        })
        .where(sql`${modules.id} = ${mod.id}::uuid`);
    });

    await addResource({
      tenantId,
      userId: teacherA,
      moduleId: mod.id,
      title: "Notes",
      type: "text",
      body: "secret until unlock",
      isAdmin: false,
    });

    await publishCourse({
      tenantId,
      userId: teacherA,
      courseId: course.id,
      isAdmin: false,
      status: "published",
    });

    const lockedView = await getStudentCourseView({
      tenantId,
      userId: ownerUser,
      courseId: course.id,
      studentId,
    });
    const lockedMod = lockedView.modules.find((m) => m.module.id === mod.id);
    assert.equal(lockedMod?.unlocked, false);
    assert.equal(lockedMod?.resources.length, 0);

    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx
        .update(modules)
        .set({ availableAt: new Date(Date.now() - 60_000) })
        .where(sql`${modules.id} = ${mod.id}::uuid`);
    });

    const openView = await getStudentCourseView({
      tenantId,
      userId: ownerUser,
      courseId: course.id,
      studentId,
    });
    const openMod = openView.modules.find((m) => m.module.id === mod.id);
    assert.equal(openMod?.unlocked, true);
    assert.equal(openMod?.resources.length, 1);

    await assert.rejects(
      () =>
        getCourseEditor({
          tenantId,
          userId: teacherB,
          courseId: course.id,
          isAdmin: false,
        }),
      (err: unknown) =>
        err instanceof CourseError && /not the teacher/i.test(err.message),
    );

    // Quota: push storage near limit then assertStorageQuota fails
    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(
        sql`UPDATE subscriptions SET plan_key = 'free' WHERE tenant_id = ${tenantId}::uuid`,
      );
      await tx.execute(sql`
        UPDATE usage_counters SET quantity = 1073741824
        WHERE tenant_id = ${tenantId}::uuid AND metric = 'storage_bytes'
      `);
    });

    await assert.rejects(
      () =>
        assertStorageQuota({
          tenantId,
          userId: ownerUser,
          bytes: 1,
        }),
      (err: unknown) => err instanceof QuotaError,
    );
  });
});
