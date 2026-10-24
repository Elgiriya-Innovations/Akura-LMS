/**
 * Shared test fixture helpers — creates/destroys a tenant with all scoped tables.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface TenantFixture {
  pool: Pool;
  tenantId: string;
  ownerUserId: string;
  slug: string;
}

/** All tenant-scoped tables in dependency order (children before parents). */
export const TENANT_TABLES = [
  "attendance_edits",
  "attendance",
  "class_sessions",
  "marks",
  "exams",
  "resource_views",
  "resources",
  "modules",
  "courses",
  "student_applications",
  "registration_links",
  "class_enrolments",
  "guardians",
  "students",
  "classes",
  "subjects",
  "bank_transfers",
  "payments",
  "usage_events",
  "usage_counters",
  "subscriptions",
  "setting_history",
  "tenant_settings",
  "invitations",
  "audit_log",
  "events",
  "memberships",
] as const;

/**
 * Insert an identity row so memberships.auth_user_id satisfies its FK to
 * auth_users (0012_better_auth.sql). Returns the id for chaining.
 */
export async function createTestAuthUser(
  pool: Pool,
  id: string = `user-${randomUUID()}`,
): Promise<string> {
  await pool.query(
    `INSERT INTO auth_users (id, name, email, email_verified)
     VALUES ($1, 'Test User', $2, true)
     ON CONFLICT (id) DO NOTHING`,
    [id, `${id}@test.akura.invalid`],
  );
  return id;
}

/**
 * Create a fresh test tenant with an owner membership.
 * Call inside before() — top-level await fails under tsx CJS.
 * @param pool — a raw pg Pool (pass createTestPool())
 */
export async function createTestTenant(pool: Pool): Promise<{
  tenantId: string;
  ownerUserId: string;
  slug: string;
}> {
  const slug = `test-${randomUUID().slice(0, 8)}`;
  const ownerUserId = await createTestAuthUser(pool, `owner-${randomUUID()}`);
  const r = await pool.query<{ app_create_tenant_with_owner: string }>(
    `SELECT app_create_tenant_with_owner($1, $2, $3, 'Asia/Colombo') AS app_create_tenant_with_owner`,
    [slug, "Test Institute", ownerUserId],
  );
  return { tenantId: r.rows[0]!.app_create_tenant_with_owner, ownerUserId, slug };
}
