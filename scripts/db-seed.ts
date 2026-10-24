/**
 * Idempotent demo seed for local / staging.
 *
 * Creates (or reuses) tenant slug `demo-institute` with a sample class,
 * students, and guardians. Owner auth id is synthetic (`seed-owner-demo`) —
 * it has an auth_users row but no password, so sign up normally for
 * interactive login.
 *
 * Usage: npm run db:seed
 */
import { config } from "dotenv";
import { Pool } from "pg";
import { and, eq, isNull } from "drizzle-orm";
import { pgPoolConfig } from "../lib/db/pool-config";
import {
  classEnrolments,
  classes,
  guardians,
  students,
} from "../lib/db/schema";
import { withTenant } from "../lib/db/tenant";
import { pool as appPool } from "../lib/db/index";

config({ path: ".env" });

const SLUG = process.env.SEED_TENANT_SLUG ?? "demo-institute";
const OWNER = process.env.SEED_OWNER_AUTH_ID ?? "seed-owner-demo";

async function main() {
  const url =
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.DIRECT_URL ??
    process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");

  const pool = new Pool(pgPoolConfig(url));

  try {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM tenants WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
      [SLUG],
    );

    let tenantId = existing.rows[0]?.id;
    if (!tenantId) {
      // memberships.auth_user_id references auth_users (0012_better_auth.sql)
      await pool.query(
        `INSERT INTO auth_users (id, name, email, email_verified)
         VALUES ($1, 'Demo Owner', $2, true)
         ON CONFLICT (id) DO NOTHING`,
        [OWNER, `${OWNER}@seed.akura.invalid`],
      );
      const created = await pool.query<{ id: string }>(
        `SELECT app_create_tenant_with_owner($1, $2, $3, 'Asia/Colombo') AS id`,
        [SLUG, "Demo Institute", OWNER],
      );
      tenantId = created.rows[0]!.id;
      console.log(`created tenant ${SLUG} (${tenantId})`);
    } else {
      console.log(`reusing tenant ${SLUG} (${tenantId})`);
    }

    await withTenant({ tenantId, userId: OWNER }, async (tx) => {
      const existingClasses = await tx
        .select()
        .from(classes)
        .where(
          and(eq(classes.tenantId, tenantId!), isNull(classes.deletedAt)),
        )
        .limit(1);

      let classId = existingClasses[0]?.id;
      if (!classId) {
        const [klass] = await tx
          .insert(classes)
          .values({
            tenantId: tenantId!,
            name: "Grade 10 Maths",
            teacherAuthUserId: OWNER,
          })
          .returning();
        classId = klass!.id;
        console.log("created class Grade 10 Maths");
      }

      const existingStudents = await tx
        .select()
        .from(students)
        .where(
          and(eq(students.tenantId, tenantId!), isNull(students.deletedAt)),
        )
        .limit(5);

      if (existingStudents.length >= 2) {
        console.log("students already present — skip sample people");
        return;
      }

      const [s1] = await tx
        .insert(students)
        .values({
          tenantId: tenantId!,
          fullName: "Asha Perera",
          email: "asha.demo@example.com",
          status: "active",
        })
        .returning();
      const [s2] = await tx
        .insert(students)
        .values({
          tenantId: tenantId!,
          fullName: "Binura Silva",
          email: "binura.demo@example.com",
          status: "active",
        })
        .returning();

      await tx.insert(guardians).values([
        {
          tenantId: tenantId!,
          studentId: s1!.id,
          name: "Parent Perera",
          email: "parent.perera@example.com",
          receivesEmail: true,
          isPrimary: true,
        },
        {
          tenantId: tenantId!,
          studentId: s2!.id,
          name: "Parent Silva",
          email: "parent.silva@example.com",
          receivesEmail: true,
          isPrimary: true,
        },
      ]);

      await tx.insert(classEnrolments).values([
        { tenantId: tenantId!, classId: classId!, studentId: s1!.id },
        { tenantId: tenantId!, classId: classId!, studentId: s2!.id },
      ]);
      console.log("seeded 2 students + guardians + enrolments");
    });

    console.log("seed complete");
  } finally {
    await pool.end();
    await appPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
