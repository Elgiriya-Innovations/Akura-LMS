import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createTestPool } from "./helpers/db-pool";
import { createTestAuthUser, createTestTenant } from "./helpers/test-tenant";
import { sql } from "drizzle-orm";
import { withTenant } from "../lib/db/tenant";
import { classes } from "../lib/db/schema";
import { createStudentInTx } from "../capabilities/students/lib/service";
import {
  createExam,
  ExamError,
  listPublishedResultsForStudent,
  publishExam,
  saveExamMarks,
} from "../capabilities/exams/lib/service";
import { competitionRanks, letterFromPercent, percentage } from "../capabilities/exams/lib/grades";
import { WritableError, assertWritable } from "../lib/billing/quota";
import { setSetting } from "../lib/settings";

const pool = createTestPool();
let tenantId = "";
let ownerUser = "";
const teacherUser = `teacher-${randomUUID()}`;

describe("Phase 6 exams & marks", () => {
  let classId = "";
  let studentA = "";
  let studentB = "";

  before(async () => {
    const t = await createTestTenant(pool);
    tenantId = t.tenantId;
    ownerUser = t.ownerUserId;
    await createTestAuthUser(pool, teacherUser);

    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO memberships (tenant_id, auth_user_id, role, status, is_owner)
        VALUES (${tenantId}::uuid, ${teacherUser}, 'teacher', 'active', false)
      `);
      const [klass] = await tx
        .insert(classes)
        .values({
          tenantId,
          name: "Grade 10 Maths",
          teacherAuthUserId: teacherUser,
        })
        .returning();
      classId = klass!.id;

      const a = await createStudentInTx(tx, {
        tenantId,
        actorUserId: ownerUser,
        fullName: "Alice",
        classId,
      });
      const b = await createStudentInTx(tx, {
        tenantId,
        actorUserId: ownerUser,
        fullName: "Bob",
        classId,
      });
      studentA = a.id;
      studentB = b.id;
    });
  });

  after(async () => {
    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
        await tx.execute(sql`DELETE FROM marks`);
        await tx.execute(sql`DELETE FROM exams`);
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

  it("grades helpers: percent, letter, competition ranks", () => {
    assert.equal(percentage(80, 100), 80);
    assert.equal(letterFromPercent(75), "A");
    assert.equal(letterFromPercent(40), "S");
    assert.equal(letterFromPercent(39.9), "F");
    assert.deepEqual(competitionRanks([90, 80, 80, 70]), [1, 2, 2, 4]);
  });

  it("teacher cannot publish; assertWritable blocks create in read_only", async () => {
    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(
        sql`UPDATE subscriptions SET status = 'read_only' WHERE tenant_id = ${tenantId}::uuid`,
      );
    });
    await assert.rejects(
      () => assertWritable(tenantId, ownerUser),
      (err: unknown) => err instanceof WritableError,
    );
    await assert.rejects(
      () =>
        createExam({
          tenantId,
          userId: ownerUser,
          classId,
          title: "Blocked",
          examDate: new Date(),
          maxMarks: 100,
        }),
      (err: unknown) => err instanceof WritableError,
    );

    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      await tx.execute(
        sql`UPDATE subscriptions SET status = 'trialing' WHERE tenant_id = ${tenantId}::uuid`,
      );
    });

    const exam = await createExam({
      tenantId,
      userId: ownerUser,
      classId,
      title: "Mid Term",
      examDate: new Date("2026-08-01"),
      maxMarks: 100,
    });

    await saveExamMarks({
      tenantId,
      userId: teacherUser,
      examId: exam.id,
      scores: [
        { studentId: studentA, score: 90 },
        { studentId: studentB, score: 80 },
      ],
    });

    await assert.rejects(
      () =>
        publishExam({
          tenantId,
          userId: teacherUser,
          examId: exam.id,
          isAdmin: false,
        }),
      (err: unknown) =>
        err instanceof ExamError && /admin/i.test(err.message),
    );

    // Draft invisible to student results API
    const draftResults = await listPublishedResultsForStudent({
      tenantId,
      userId: ownerUser,
      studentId: studentA,
    });
    assert.equal(
      draftResults.filter((r) => r.examId === exam.id).length,
      0,
    );

    await publishExam({
      tenantId,
      userId: ownerUser,
      examId: exam.id,
      isAdmin: true,
    });

    await withTenant({ tenantId, userId: ownerUser }, async (tx) => {
      const events = await tx.execute<{ type: string }>(
        sql`SELECT type FROM events WHERE tenant_id = ${tenantId}::uuid AND type = 'exams.published' ORDER BY created_at DESC LIMIT 1`,
      );
      assert.equal(events.rows[0]?.type, "exams.published");

      const ranks = await tx.execute<{ student_id: string; rank: number; letter: string }>(
        sql`SELECT student_id, rank, letter FROM marks WHERE exam_id = ${exam.id}::uuid ORDER BY rank ASC`,
      );
      assert.equal(ranks.rows[0]?.rank, 1);
      assert.equal(ranks.rows[0]?.letter, "A");
      assert.equal(ranks.rows[1]?.rank, 2);
    });

    await setSetting({
      tenantId,
      userId: ownerUser,
      key: "exams.class_rank_visible",
      value: false,
    });
    const hidden = await listPublishedResultsForStudent({
      tenantId,
      userId: ownerUser,
      studentId: studentA,
    });
    const row = hidden.find((r) => r.examId === exam.id);
    assert.ok(row);
    assert.equal(row!.rank, null);
    assert.equal(row!.showRank, false);

    await setSetting({
      tenantId,
      userId: ownerUser,
      key: "exams.class_rank_visible",
      value: true,
    });
    const shown = await listPublishedResultsForStudent({
      tenantId,
      userId: ownerUser,
      studentId: studentA,
    });
    const shownRow = shown.find((r) => r.examId === exam.id);
    assert.equal(shownRow!.rank, 1);
    assert.equal(shownRow!.showRank, true);
  });
});
