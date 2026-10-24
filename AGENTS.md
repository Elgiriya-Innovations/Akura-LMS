# AKURA — Master Build Brief

You are building **Akura**, a multi-tenant Learning Management System, for Elgiriya Innovations. Read this entire brief before writing anything.

## 1. Product

A white-label LMS for education institutes — tuition institutes and private schools, initially in Sri Lanka.

Each institute is a **tenant** with an isolated workspace. Institutes register students, mark attendance, run exams, publish marks, build their own course content, and keep guardians informed by email. Institutes pay a **subscription based on capacity** (students, staff, storage, emails) — never per feature. Every institute gets every feature; plans differ only in size.

Deployed at `akura.elgiriya.com`; tenant workspaces at `akura.elgiriya.com/i/{slug}`.

### Terminology — get this exactly right

| Term | Meaning |
| --- | --- |
| **Tenant** | One institute |
| **Module** | A unit of **course content** created by the institute ("Module 3: Quadratic Equations"). **Never** a software feature. |
| **Capability** | A slice of our software (attendance, exams). Internal code term only — never appears in the UI. |
| **Guardian** | A parent/guardian **contact record** on a student. Not a user. No login, no portal. Receives email only. |
| **Owner** | The one Institute Admin per tenant holding billing rights. A boolean flag on `memberships`, not a separate role. |

## 2. Stack — use exactly this, add nothing else without asking

| Layer | Choice |
| --- | --- |
| Framework | Next.js (App Router), TypeScript, Server Components + Server Actions |
| Database | **Neon Postgres** (RLS + `withTenant()` / `akura_app`; pooled endpoint for the app, direct for migrations) |
| Auth | **Better Auth** (self-hosted) — identities in Neon `auth_*` tables; app links via `auth_user_id` (FK, never cascades) |
| ORM | Drizzle |
| DB driver | `pg` (node-postgres) with verified SSL — transactions for `SET LOCAL` under Neon's PgBouncer pooler |
| Styling | Tailwind CSS |
| File storage | **Supabase Storage only** (private bucket; service-role key server-side; signed URLs after app authz) |
| Email | Resend + React Email |
| Payments | **PayHere only** — Recurring API + `notify_url` webhook. No Stripe. |
| PDF | React-PDF or Puppeteer, server-side |
| Validation | Zod on every server action and route handler |
| Hosting | Vercel |

No state-management library, no tRPC, no alternative ORM, no UI kit beyond Tailwind plus headless primitives.

**Brand:** Ink `#101828` · Accent `#E4761B` · Surface `#F7F8FB` · Success `#2E9E6B` · Danger `#D6453D`. Use CSS variables so a tenant's own logo colour can override the accent inside their workspace.

## 3. Roles and access

Three roles have logins: **Institute Admin**, **Teacher**, **Student**. Guardians never log in. One Admin carries the **Owner** flag, adding billing rights.

Student hard rules: never sees another student's data; unpublished marks are invisible even to their owner; class rank visibility is a per-institute setting defaulted **off**; deactivation revokes access but retains records.

Teachers cannot publish marks — that gate is what stops a mistyped mark reaching guardians.

## 4. Non-negotiable invariants

### 4.1 Tenant isolation

Every tenant-owned table has `tenant_id uuid not null`, and RLS enabled with a policy created **in the same migration as the table**. Both `USING` and `WITH CHECK` are required.

The application DB role must **not** have `BYPASSRLS`. Migrations run as a separate role. Use `FORCE ROW LEVEL SECURITY` so owners cannot accidentally bypass.

### 4.2 `withTenant` — the only way to touch tenant data

Neon's pooled endpoint (PgBouncer) runs in transaction mode. A bare `SET` leaks session state. `SET LOCAL` / `set_config(..., true)` must sit inside an explicit transaction with the query.

```ts
export async function withTenant<T>(
  ctx: { tenantId: string; userId: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE akura_app`)
    await tx.execute(sql`SELECT set_config('app.current_tenant', ${ctx.tenantId}, true)`)
    await tx.execute(sql`SELECT set_config('app.current_user', ${ctx.userId}, true)`)
    return fn(tx)
  })
}
```

A raw `db.select()` against a tenant table is a bug.

### 4.3 Tenant resolution

Tenant comes from the URL path (`/i/{slug}`), resolved in middleware, then **re-verified against the user's `memberships` row on every request**. Never trust a tenant id from a cookie, header, form field, or any client-supplied value. Store the **slug**, never a hostname; the base domain is a single config value.

### 4.4 Cookies

`elgiriya.com` is a shared parent domain. Session cookies use the `__Host-` prefix (forbids `Domain`), plus `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`. Never set a cookie on the parent domain.

### 4.5 Quotas

Checks run **before** the write, **inside the same transaction**. `assertWritable` **never blocks attendance marking**, even in `read_only`. Exceeding a cap never deletes data.

### 4.6 Capability isolation

Capabilities live in `/capabilities/{key}/` and **never import from each other**. Cross-capability communication is through the Postgres event outbox only. Shared code in `/lib`, shared UI in `/components`.

### 4.7 Settings

No hardcoded institute-specific behaviour. Configurable behaviour reads through `settings.get(tenantId, key)`. New settings are rows in `setting_definitions`, not new columns. Setting changes are **not retroactive**.

### 4.8 Data safety

Never hard-delete tenant data; soft-delete or archive. Deleting an auth user must never cascade into application records — use `RESTRICT` or `SET NULL`. Every destructive or financial action writes to `audit_log`.

## 5. Repository structure (target)

```
/app
  /(public)      landing, pricing, signup, /join/[slug], /r/[token]
  /(auth)        login, register, verify, pending-approval
  /i/[slug]
    /(admin)     dashboard, students, staff, classes, courses, exams,
                 reports, applications, settings, billing
    /(teacher)   today, attendance, my-classes, marks, course-editor
    /(student)   courses, attendance, results, profile
  /api           webhooks (payhere, resend), cron
/capabilities
  /students /attendance /exams /courses /notifications /billing
/lib
  /db /auth /tenant /settings /billing /events /storage /email /pdf
/components  /emails  /tests
```

## 6–12. Domain behaviour

See product brief sections for data model, student self-registration, attendance, exams, email, PayHere, and conventions. Money as integer minor units. Dates UTC, display in tenant timezone (default `Asia/Colombo`). Tests required for RLS isolation, quota enforcement, permission matrix, subscription state transitions.

## 13. Phases

| Phase | Scope |
| --- | --- |
| **0. Audit** | Done — `docs/AUDIT.md` |
| **1. Foundation** | Neon Postgres + Drizzle + `pg`, `tenants`, `memberships`, `audit_log`, `events`, RLS, `withTenant()`, tenant middleware, `__Host-` cookies, cross-tenant CI tests |
| **2. Auth & roles** | Better Auth on Neon, signup creating tenant + owner, invitations, 3 roles + Owner flag, `requireRole()`, onboarding, ownership transfer |
| **3. Settings & billing skeleton** | setting_definitions, settings.get(), plans, subscriptions, trial, assertQuota/assertWritable |
| **4. People & registration** | Students, guardians, classes, registration links + QR + OG, approval queue |
| **5. Attendance** | Session model, 3-tap marking, offline draft, lock, reports |
| **6. Exams & marks** | Entry grid, draft→publish, stored ranks, report card PDF |
| **7. Courses & resources** | Course→Module→Resource, Supabase Storage, drip release |
| **8. Email** | Resend + React Email, batching, quiet hours |
| **9. Billing live** | PayHere Recurring API, bank transfer, state machine |
| **10. Harden** | Seed, export, monitoring, backup restore, load test |

Before each phase, list files to create/change and wait for confirmation. One phase at a time.

## 14. Out of scope — refuse and continue

Student fee collection · assignments · timetable · online quizzes · watermarking · live classes · certificates · admissions funnel · discussion forums · custom roles · automation rule builder · custom report builder · AI features · Sinhala/Tamil UI · subdomains or custom domains · mobile apps · **any guardian portal or login**

## 15. Ambiguity rule

If a requirement is unclear, **ask before implementing**. Never invent business rules around grading, ranking, attendance percentage calculation, quota edges, or billing state transitions.
