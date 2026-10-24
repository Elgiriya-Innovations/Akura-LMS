# Akura — Master Build Plan & Technical Requirements

> A clean-sheet plan for building Akura, a multi-tenant LMS for Sri Lankan tuition institutes and private schools.
> It is written from first principles: it does not reuse the earlier phase plans in `docs/superpowers/plans/`, and it uses no off-the-shelf LMS (Moodle, Canvas, Chamilo, etc.). Everything is custom-built. It is a **responsive web app** (no native mobile apps). It follows the stack in `AGENTS.md`, except that **Neon replaces Supabase for the database, auth runs on self-hosted Better Auth with its tables in Neon** (chosen over the Neon Auth SDK, which hardcodes `__Secure-` cookie names and requires Next 16), and **Supabase Storage is kept for files** (see §6.0).
>
> Date: 2026-10-24 · Owner: Elgiriya Innovations

---

## 1. Goals and success criteria

| # | Goal | Measurable success criterion |
|---|------|------------------------------|
| G1 | An institute can go from signup to a working workspace in one sitting | Signup → first class with students enrolled in **< 15 min** (measured in usability test with 3 real institutes) |
| G2 | Teachers mark attendance fast on a cheap Android phone | A class of 40 marked in **< 60 s**, works on a 3G connection, and survives the connection dropping mid-session |
| G3 | Wrong marks never reach guardians | Teachers cannot publish; publish is an explicit admin action with a preview; 100% of publishes audited |
| G4 | Tenants are isolated | Automated cross-tenant tests run on every PR; **zero** tenant data readable across tenants under any role |
| G5 | Billing runs itself | PayHere recurring charges, renewals, failures and grace periods processed without manual work; every money event is in `audit_log` |
| G6 | Cheap to run | Infra cost per tenant stays low enough for SMB pricing in LKR (Vercel + Neon + Resend free/low tiers through the first ~50 tenants) |

### Non-goals (from AGENTS.md §14 — refuse and continue)
Student fee collection, assignments, timetables, online quizzes, watermarking, live classes, certificates, admissions funnel, forums, custom roles, automation builders, custom report builders, AI features, Sinhala/Tamil UI, subdomains/custom domains, mobile apps, **any guardian portal or login**.

---

## 2. Users and permissions

### 2.1 Personas

| Persona | Device reality | Primary jobs |
|---------|----------------|--------------|
| **Institute Admin** (one is the **Owner**) | Laptop, sometimes phone | Set up classes, approve registrations, publish marks, manage staff, view reports, pay (Owner only) |
| **Teacher** | Low/mid Android phone, patchy data | Mark attendance, enter marks, build course content |
| **Student** | Phone, shared family devices | View course content, own attendance, own *published* results |
| **Guardian** (contact record, not a user) | Email only | Receives absence alerts, results, notices |
| **Platform operator** (Elgiriya staff) | Laptop | Support, tenant lifecycle, billing exceptions (separate operator console, not a tenant role) |

### 2.2 Permission matrix (must be enforced server-side **and** by RLS where data-shaped)

| Action | Owner | Admin | Teacher | Student |
|--------|:----:|:----:|:----:|:----:|
| Manage billing / plan / payment method | ✅ | ❌ | ❌ | ❌ |
| Transfer ownership | ✅ | ❌ | ❌ | ❌ |
| Invite / deactivate staff | ✅ | ✅ | ❌ | ❌ |
| Change institute settings | ✅ | ✅ | ❌ | ❌ |
| Create classes, enrol students | ✅ | ✅ | ❌ | ❌ |
| Approve self-registrations | ✅ | ✅ | ❌ | ❌ |
| Mark attendance | ✅ | ✅ | ✅ (own classes) | ❌ |
| Enter / edit draft marks | ✅ | ✅ | ✅ (own classes) | ❌ |
| **Publish** marks | ✅ | ✅ | ❌ | ❌ |
| Create / edit course content | ✅ | ✅ | ✅ (assigned courses) | ❌ |
| View own published results | — | — | — | ✅ |
| View own attendance | — | — | — | ✅ |
| View class rank | — | — | — | Only if tenant setting `results.show_rank` = on (default **off**) |
| View another student's data | — | — | — | ❌ never |

Deactivated users: login blocked, records retained, audit entry written.

---

## 3. Functional requirements

Requirement IDs (`FR-x.y`) are used in tests and PRs.

### 3.1 Tenancy & onboarding
- **FR-1.1** Public signup creates: Better Auth user (`auth_users`) → `users` row → `tenants` row (slug, timezone `Asia/Colombo`) → `memberships` row (role `admin`, `is_owner = true`) → trial `subscriptions` row. All in one DB transaction (auth user created first; compensating cleanup if DB step fails).
- **FR-1.2** Slug: lowercase, `[a-z0-9-]{3,40}`, unique, reserved-word blocklist (`api`, `admin`, `login`, `i`, `r`, `join`, …). Slug is immutable after creation in v1 (changing it breaks printed QR codes).
- **FR-1.3** Onboarding checklist: logo + accent colour, first class, first teacher invite, first registration link.
- **FR-1.4** Branding: tenant logo and accent colour override `--accent` inside `/i/{slug}` only.
- **FR-1.5** Ownership transfer: Owner picks another active Admin; both receive email; audited; exactly one owner per tenant enforced by a partial unique index.

### 3.2 Auth & membership
- **FR-2.1** Email + password and magic link via Better Auth; email verification required before workspace access.
- **FR-2.2** Staff invitations: tokenised link, single use, expires (expiry length → **open question Q1**).
- **FR-2.3** One person may belong to several tenants (e.g. a teacher at two institutes); a tenant switcher lists their memberships.
- **FR-2.4** `requireRole(ctx, roles[])` guard in every server action / route handler; tenant re-verified against `memberships` per request.

### 3.3 People: students, guardians, classes
- **FR-3.1** Student record: name, student number (tenant-unique, auto or manual), DOB, school, grade, contact, status (`active`, `deactivated`, `archived`).
- **FR-3.2** Guardians: 1..n per student, name, relationship, email, phone, `receives_email` flag. No login.
- **FR-3.3** Classes: name, subject, grade/year, teacher(s), schedule note (free text — **no timetable feature**).
- **FR-3.4** Enrolment: many-to-many students↔classes with `enrolled_at` / `left_at` (history preserved).
- **FR-3.5** Bulk import via CSV with a dry-run preview and per-row errors.

### 3.4 Self-registration
- **FR-4.1** Admin creates a registration link (`/join/{slug}` or `/r/{token}`) optionally scoped to a class, with optional seat cap and expiry.
- **FR-4.2** Link has a printable QR code and OpenGraph preview (institute name + logo) for WhatsApp sharing.
- **FR-4.3** Applicant submits student + guardian details → `applications` row (`pending`). Rate-limited and bot-protected.
- **FR-4.4** Approval queue: approve (creates student, enrols, sends welcome + login invite), reject (with reason), or bulk approve. Seat cap and student quota checked at approval time inside the transaction.

### 3.5 Attendance
- **FR-5.1** Session model: an attendance **session** = class + date + optional label; one row per student per session with status `present | absent | late | excused`.
- **FR-5.2** 3-tap marking: open today's class → everyone defaults to *present* → tap exceptions → save.
- **FR-5.3** Offline draft: the marking screen stores the draft locally (IndexedDB) and syncs when online; server is idempotent on `(session_id, student_id)` with a client-generated session UUID.
- **FR-5.4** Lock: sessions lock after a tenant-configurable window; admins may unlock (audited).
- **FR-5.5** Attendance marking is **never blocked** by quota / `read_only` state (AGENTS.md §4.5).
- **FR-5.6** Absence alert email to guardians (batched, respects quiet hours).
- **FR-5.7** Reports: per student, per class, date range, CSV export. **Percentage formula → open question Q3** (do `excused` and `late` count?).

### 3.6 Exams & marks
- **FR-6.1** Exam: name, class(es), date, subjects/papers, max mark per paper.
- **FR-6.2** Entry grid: spreadsheet-like, keyboard-navigable, autosave, validation against max mark, "absent" distinct from 0.
- **FR-6.3** Workflow `draft → published` (and admin-only `unpublish` with reason, audited). Unpublished marks invisible to students, even their own.
- **FR-6.4** Ranks computed and **stored** at publish time (not recomputed on read) so later setting changes are not retroactive. **Tie handling and rank basis → open question Q4.** **Grade bands → Q5.**
- **FR-6.5** Report card PDF per student and bulk (zip / combined PDF), rendered server-side with React-PDF.
- **FR-6.6** On publish: results email to guardians (batched).

### 3.7 Courses & resources
- **FR-7.1** Hierarchy: Course → **Module** (course content unit) → Resource.
- **FR-7.2** Resource types: file (PDF, image, audio, video ≤ size limit), external link (YouTube/Drive), rich-text note.
- **FR-7.3** Files in a private **Supabase Storage** bucket at `tenants/{tenant_id}/…`; served only via short-lived signed URLs **after** app-level authz.
- **FR-7.4** Drip release: per-module `available_from` (absolute date) or relative to enrolment (days). Evaluated in tenant timezone.
- **FR-7.5** Course access by class enrolment.
- **FR-7.6** Storage usage counted against the plan's storage quota at upload time.

### 3.8 Notifications / email
- **FR-8.1** Templates in React Email: welcome, staff invite, absence alert, results published, registration received/approved/rejected, billing receipts, payment failed, trial ending.
- **FR-8.2** All sends go through the event outbox → worker → Resend. Never sent inline in a request.
- **FR-8.3** Batching (one digest per guardian per window), quiet hours per tenant (default window → **Q6**), email quota per plan.
- **FR-8.4** Resend webhook updates delivery status (delivered, bounced, complained); hard bounces flag the guardian email.
- **FR-8.5** Sending identity: from `Akura <no-reply@…>` with institute name in display / reply-to.

### 3.9 Billing
- **FR-9.1** Plans differ by capacity only: max students, max staff, storage GB, emails/month. All features in every plan.
- **FR-9.2** Trial on signup (length → **Q7**).
- **FR-9.3** PayHere Recurring API for card payments; `notify_url` webhook verified with MD5 signature (merchant secret), idempotent on `payment_id`.
- **FR-9.4** Bank transfer as manual alternative: Owner uploads slip → operator confirms in operator console.
- **FR-9.5** Subscription state machine — candidate states `trialing, active, past_due, read_only, cancelled`; **exact transitions, grace periods and downgrade rules → Q8** (must be confirmed before Phase 9, per AGENTS.md §15).
- **FR-9.6** Exceeding a cap blocks new writes of that type only; it **never deletes data**.
- **FR-9.7** Money stored as integer minor units (cents of LKR) with currency code.

### 3.10 Reporting, export, operator console
- **FR-10.1** Admin dashboard: active students, today's attendance, pending applications, quota usage bars.
- **FR-10.2** Full tenant data export (CSV zip) on demand by Owner.
- **FR-10.3** Operator console (Elgiriya staff, separate auth gate, every action audited): tenant list, subscription override, bank-transfer confirmation, impersonation **not** included in v1.

---

## 4. Non-functional requirements

| ID | Area | Requirement |
|----|------|-------------|
| NFR-1 | Performance | p95 server response < 500 ms for page loads, < 300 ms for attendance save; LCP < 2.5 s on Moto-G-class device over 4G |
| NFR-2 | Payload | Teacher attendance route JS < 150 KB gzipped |
| NFR-3 | Availability | 99.5% monthly (bounded by Vercel + Neon SLAs) |
| NFR-4 | Scale target (v1) | 500 tenants, 100k students, 5M attendance rows, 200 concurrent markers at 8 am peak |
| NFR-5 | Security | OWASP ASVS L2 as checklist; RLS on every tenant table; no `BYPASSRLS` for app role |
| NFR-6 | Privacy | Minors' data: collect minimum, no public profile pages, data export + deletion request process (soft-delete + scheduled purge per retention policy → **Q9**). Align with Sri Lanka Personal Data Protection Act No. 9 of 2022 |
| NFR-7 | Accessibility | WCAG 2.2 AA for all flows; large tap targets (≥ 44 px) on teacher screens |
| NFR-8 | Browser support | Last 2 versions of Chrome/Android WebView, Safari iOS 16+, Firefox, Edge |
| NFR-9 | Time | Store UTC; display in tenant timezone (default `Asia/Colombo`) |
| NFR-10 | Observability | Structured logs with `tenant_id`, `request_id`; error tracking; alerting on webhook failures and outbox backlog |
| NFR-11 | Backups | Neon point-in-time restore (history window per plan) + nightly `pg_dump` to object storage; quarterly restore drill onto a Neon branch |
| NFR-12 | Auditability | `audit_log` for every destructive, permission, publish and financial action — append-only |

---

## 5. UI & UX — modern web app

Akura is a **responsive web app** that runs in the browser on phones, tablets and laptops. "Modern" here means fast, calm and obvious. It does not mean decoration.

### 5.1 Design principles
1. **Mobile-first for teachers and students; desktop-first for admins.** Every screen still works at 360 px.
2. **One primary action per screen.** Secondary actions go in menus or sheets.
3. **Instant feedback.** Optimistic UI (`useOptimistic`) for attendance taps and mark entry, skeleton loaders while Server Components stream, and toasts that offer undo instead of "are you sure?" dialogs where the action can be reversed.
4. **Never lose input.** Autosave drafts (marks grid, course editor, attendance) and show a visible "Saved · 2 s ago" state.
5. **Zero training.** Empty states explain the next step and link to the action, and onboarding is a checklist rather than a tour.

### 5.2 Design system (Tailwind v4 + headless primitives)
- **Tokens** as CSS variables in `@theme`: Ink `#101828`, Accent `#E4761B` (overridable per tenant via `--accent` inside `/i/{slug}`), Surface `#F7F8FB`, Success `#2E9E6B`, Danger `#D6453D`, plus neutral 50–950, radius scale (6 / 10 / 16 px), shadow scale (2 levels only) and an 8 px spacing grid.
- **Dark mode** from the start, using the same tokens remapped under `prefers-color-scheme` plus a user toggle. The tenant accent is contrast-checked automatically, and if it fails WCAG AA against the surface we derive a darker or lighter shade.
- **Typography:** Inter (variable, self-hosted via `next/font`), tabular numerals for marks and attendance counts, and a 4-step type scale.
- **Icons:** Lucide (tree-shaken SVG; confirm before adding).
- **Primitives:** Radix UI or Headless UI for Dialog, Popover, Dropdown, Tabs, Combobox and Toast. Pick one and confirm, because AGENTS.md allows headless primitives but no full UI kit.
- **Component library** in `/components/ui`: Button, Input, Select, Combobox, DataTable (sortable, filterable, virtualised for 1k+ rows), Sheet (mobile bottom sheet), Dialog, Tabs, Badge, Avatar, EmptyState, Skeleton, Toast, StatCard, ProgressBar (quota), Stepper. Each component has a states page (`/dev/ui`, dev-only) covering default, hover, focus, disabled, loading and error.
- **Motion:** CSS transitions of 150–200 ms only, respecting `prefers-reduced-motion`. No animation library.

### 5.3 App shell & navigation
| Role | Layout |
|------|--------|
| Admin | Collapsible left sidebar (Dashboard, Students, Classes, Courses, Exams, Reports, Applications, Staff, Settings, Billing), top bar with tenant switcher, global search (⌘K command palette: jump to student/class/exam) and profile |
| Teacher | Bottom tab bar on mobile (**Today**, Attendance, Marks, Courses), sidebar on desktop. "Today" lists the day's classes with one-tap "Mark attendance" |
| Student | Bottom tab bar (Courses, Attendance, Results, Profile), with large cards and minimal chrome |

### 5.4 Key screens (wireframed in Phase 0, built against these specs)
- **Attendance marking:** a full-screen student list with large avatar rows. Everyone starts as Present, and tapping a row cycles Present → Absent → Late → Excused. A sticky footer shows the counts and a Save button. An offline banner shows when there's no connection and a sync badge shows when it reconnects.
- **Marks entry grid:** spreadsheet feel with arrow, Enter and Tab navigation, paste from Excel or Google Sheets, an inline error when a mark exceeds the max, `A` for absent, autosave per cell, and a "Draft" badge until an admin publishes.
- **Publish flow:** a preview of the distribution (min, max, average, ungraded count), a list of students who will be emailed, a confirm step, and an undo window before emails leave the outbox.
- **Admin dashboard:** stat cards (active students, today's attendance %, pending applications), quota bars, an attendance trend sparkline and a recent-activity feed.
- **Course viewer:** module list with lock icons and "Opens on 3 Nov" for drip content, inline PDF/video viewer and progress per module.
- **Public join page:** branded with the institute's logo and accent, a single-column form with mobile-friendly inputs (`inputmode`, `autocomplete`) and a clear success state.

### 5.5 Front-end technical requirements
- Server Components by default; client components only for interactivity (grid, attendance, editor, command palette).
- Forms: Server Actions + `useActionState`, with Zod errors mapped to fields. No client form library.
- Charts: lightweight SVG components written in-house (sparkline, bar). Confirm before adding a chart library.
- **PWA-lite:** web app manifest + service worker caching the shell and the attendance route so teachers can open it offline, plus "Add to Home Screen". This is still a web app, not a native app.
- Performance budgets from NFR-1/NFR-2 are enforced in CI with Lighthouse CI on the teacher attendance and student course routes.
- Accessibility: keyboard paths for every action, visible focus rings, `aria-live` for save/sync status and axe checks in E2E.
- i18n-ready string extraction (English only in v1, because Sinhala/Tamil UI is out of scope), with dates and numbers formatted via `Intl` in the tenant timezone.

---

## 6. Architecture

### 6.0 Technology stack

| Layer | Choice | Notes |
|-------|--------|-------|
| App type | Responsive web app (+ PWA-lite shell) | No native apps |
| Framework | Next.js App Router, TypeScript, Server Components + Server Actions | |
| **Database** | **Neon serverless Postgres** | Branching for previews and CI, autoscaling compute, PITR |
| **Auth** | **Better Auth (self-hosted)** | Identities in `auth_users` / `auth_sessions` / `auth_accounts` / `auth_verifications` in the same Neon database. Session cookie `__Host-akura.session_token`. App links `auth_user_id` by FK, and auth deletions never cascade into app data |
| ORM | Drizzle | Migrations as SQL with RLS in the same file |
| DB driver | `pg` over Neon's **pooled** endpoint for requests; **direct** endpoint for migrations | Pooled endpoint is PgBouncer in transaction mode, so `SET LOCAL` inside `withTenant` transactions is mandatory. `@neondatabase/serverless` (`Pool`, WebSocket) is an alternative for edge runtimes; confirm before switching |
| Styling | Tailwind CSS v4 + headless primitives | See §5 |
| File storage | **Supabase Storage** (private bucket) | Storage-only Supabase project. Auth is Neon, so Supabase's own storage RLS is not used: the server checks access in the app, then uses the service-role key (server-only) to issue short-lived signed upload and download URLs. Files go directly between browser and Supabase, so large files never pass through a Vercel function |
| Email | Resend + React Email | |
| Payments | PayHere only (Recurring API + `notify_url`) | |
| PDF | React-PDF, server-side | |
| Validation | Zod everywhere | |
| Hosting | Vercel (+ Neon–Vercel integration for branch-per-preview) | |

**Neon-specific requirements**
- Roles: `akura_migrator` owns the schema; `akura_app` has `NOINHERIT`, no `BYPASSRLS` and DML grants only. The Neon default owner role is used only to bootstrap these.
- `auth_*` tables are touched only by Better Auth on the login role; `akura_app` has no grants on them. App tables reference `auth_users` with `ON DELETE RESTRICT` (memberships) / `SET NULL` (students, applications).
- Cold starts: production compute set to stay warm in school hours (scale-to-zero disabled or min CU ≥ 0.25 on `main`). Preview branches may scale to zero.
- Connection limits: always use the pooled host from Vercel functions and keep `pg` pool `max` small (≈ 3–5 per function instance).
- A test proves tenant context does not leak across pooled connections (two tenants interleaved on one PgBouncer backend).

### 6.1 System view

```
 Browser (Admin / Teacher / Student)
        │  HTTPS, __Host- session cookie
        ▼
 Vercel — Next.js App Router
   ├─ middleware.ts ............ resolve /i/{slug} → tenant, optimistic session-cookie gate
   ├─ Server Components ........ reads via withTenant()
   ├─ Server Actions ........... Zod → requireRole() → assertQuota/assertWritable → withTenant()
   ├─ /api/webhooks/payhere .... signature check → idempotent billing event
   ├─ /api/webhooks/resend ..... delivery status
   └─ /api/cron/* .............. outbox drain, drip, trial expiry (triggered externally — see 6.6)
        │ pg (SSL, transaction pooler)
        ▼
 Neon
   ├─ Postgres (RLS, FORCE RLS, role akura_app, events outbox)
   │    └─ branches: prod · staging · one per PR preview
   └─ Better Auth tables (identity only, `auth_*`)
        │
        ├─ Supabase Storage (private bucket, signed URLs)
        ├─ Resend (email)      └─ PayHere (recurring payments)
```

### 6.2 Code layout

```
/app            routes only; thin — parse input, call capability, render
/capabilities   students | attendance | exams | courses | notifications | billing
   /{key}/actions.ts   server actions (Zod schemas co-located)
   /{key}/queries.ts   read functions taking (ctx, tx)
   /{key}/schema.ts    Drizzle tables owned by this capability
   /{key}/events.ts    events emitted / handled
/lib            db, auth, tenant, settings, billing (quota), events, storage, email, pdf
/components     shared UI (Tailwind + headless primitives)
/emails         React Email templates
/drizzle        SQL migrations (RLS policies in the same file as the table)
/tests          node:test suites against a real Postgres
```

**Rule:** capabilities never import each other. ESLint `no-restricted-imports` enforces it; a cross-capability effect (e.g. "marks published → email guardians") is an event in the outbox.

### 6.3 Request lifecycle (every mutating call)

1. Middleware resolves slug → `tenant_id` (cached lookup; slug only, never trusted id).
2. Server action loads Better Auth session → `auth_user_id` → `users.id`.
3. Loads `memberships` row for (user, tenant); 404 if absent or deactivated.
4. `requireRole()` checks role/owner flag.
5. Zod parses input.
6. `withTenant(ctx, tx => { assertWritable; assertQuota; write; insert event; insert audit })` — one transaction.
7. `revalidatePath` / redirect.

### 6.4 Tenant isolation (defence in depth)

| Layer | Mechanism |
|-------|-----------|
| URL | Tenant only from path slug |
| App | Membership re-check per request; `requireRole()` |
| DB session | `withTenant()` → `SET LOCAL ROLE akura_app` + `set_config('app.current_tenant', …, true)` inside a transaction |
| DB policy | Every tenant table: `ENABLE` + `FORCE ROW LEVEL SECURITY`; policy `USING (tenant_id = current_setting('app.current_tenant')::uuid) WITH CHECK (same)` |
| Roles | `akura_app` (no `BYPASSRLS`, no DDL), `akura_migrator` (DDL only, used by CI/migrate script) |
| Storage | Object path prefixed with `tenant_id`; signed URLs issued only after app authz |
| CI | Cross-tenant test suite fails the build |
| Lint | Custom rule / grep check: no `db.select|insert|update|delete` on tenant tables outside `withTenant` |

Student-level isolation (a student sees only their own rows) is a **second RLS predicate** using `app.current_user` on student-facing tables (`attendance_records`, `marks`, `enrolments`), plus `published_at IS NOT NULL` on marks.

### 6.5 Event outbox

```
events(id, tenant_id, type, payload jsonb, created_at, processed_at, attempts, last_error)
```
- Written in the same transaction as the domain change.
- Worker claims batches with `FOR UPDATE SKIP LOCKED`, dispatches to handler registry in `/lib/events`, retries with exponential backoff, dead-letters after N attempts.
- Handlers are idempotent (keyed on `event.id`).

### 6.6 Scheduled work

Vercel Hobby has limited crons, so cron routes are plain authenticated endpoints (`Authorization: Bearer CRON_SECRET`) triggered by an external scheduler (GitHub Actions schedule or Upstash/QStash-style external cron — Neon has no built-in job scheduler). Jobs: outbox drain (every minute), attendance lock (hourly), trial/past-due transitions (hourly), drip notifications (daily), storage usage reconcile (daily). All idempotent.

### 6.7 Settings

`setting_definitions(key, type, default, scope, description)` + `tenant_settings(tenant_id, key, value, effective_from)`. `settings.get(tenantId, key)` reads with per-request memoisation. Changes are not retroactive: values that affect computed results (e.g. ranking) are snapshotted onto the record at compute time.

---

## 7. Data model (core tables)

All tenant tables: `id uuid pk default gen_random_uuid()`, `tenant_id uuid not null references tenants`, `created_at`, `updated_at`, soft-delete `archived_at` where relevant. Composite indexes lead with `tenant_id`.

| Table | Key columns | Notes |
|-------|-------------|-------|
| `tenants` | slug (unique), name, timezone, logo_path, accent_hex, status | Global table; RLS: member-readable |
| `users` | auth_user_id (unique; FK to `auth_users`, `RESTRICT`/`SET NULL`), email, full_name | App identity; never cascades from Auth |
| `memberships` | tenant_id, user_id, role (`admin|teacher|student`), is_owner, status | Partial unique `(tenant_id) WHERE is_owner` |
| `invitations` | tenant_id, email, role, token_hash, expires_at, accepted_at | Store hash, not token |
| `audit_log` | tenant_id, actor_user_id, action, entity, entity_id, before, after, ip, at | Append-only (no UPDATE/DELETE grant) |
| `events` | see 6.5 | |
| `setting_definitions` / `tenant_settings` | see 6.7 | |
| `plans` | code, name, price_minor, currency, interval, max_students, max_staff, storage_bytes, emails_per_month | Global |
| `subscriptions` | tenant_id, plan_id, state, trial_ends_at, current_period_end, payhere_subscription_id | |
| `payments` | tenant_id, provider, provider_payment_id (unique), amount_minor, status, raw jsonb | Idempotency on provider id |
| `usage_counters` | tenant_id, metric, period, value | Emails/storage; students/staff counted live |
| `students` | tenant_id, membership_id (nullable), student_no, names, dob, status | |
| `guardians` | tenant_id, student_id, name, relationship, email, phone, receives_email, bounced_at | |
| `classes` | tenant_id, name, subject, grade, archived_at | |
| `class_teachers` | tenant_id, class_id, membership_id | |
| `enrolments` | tenant_id, class_id, student_id, enrolled_at, left_at | |
| `registration_links` | tenant_id, token, class_id, seat_cap, expires_at, active | |
| `applications` | tenant_id, link_id, payload jsonb, status, decided_by, decided_at, reason | |
| `attendance_sessions` | tenant_id, class_id, date, label, client_uuid (unique), locked_at, marked_by | |
| `attendance_records` | tenant_id, session_id, student_id, status, note | Unique `(session_id, student_id)` |
| `exams` / `exam_papers` | tenant_id, name, date, max_mark | |
| `marks` | tenant_id, paper_id, student_id, value_numeric, is_absent, entered_by, published_at | |
| `exam_results` | tenant_id, exam_id, student_id, total, rank, rank_basis_snapshot jsonb | Stored at publish |
| `courses` / `modules` / `resources` | tenant_id, ordering, available_from / release_offset_days, storage_path, size_bytes | |
| `email_messages` | tenant_id, event_id, to, template, status, resend_id | |

Migrations are plain SQL generated by drizzle-kit and hand-edited to add RLS policies in the same file.

---

## 8. Security requirements

- **Cookies:** `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`. Better Auth configured with explicit `__Host-akura.*` names for every cookie (`tests/auth-session.test.ts` asserts the attributes and that `__Secure-` names are ignored).
- **CSRF:** Server Actions' origin check + SameSite=Lax; webhooks exempt but signature-verified.
- **Input:** Zod on every action and route; reject unknown keys.
- **Webhooks:** PayHere MD5 signature with merchant secret, amount/currency/merchant cross-checked against our own records, idempotent; Resend via Svix signature.
- **Uploads:** MIME sniffing + extension allow-list, size cap per type, filenames never trusted, path = `tenants/{tenant_id}/{uuid}`.
- **Rate limiting:** login, signup, public registration form, invitation accept (Postgres-backed token bucket — no new infra).
- **Secrets:** Vercel env vars only; `.env*` files git-ignored; separate keys per environment; the Neon owner / `akura_migrator` connection string used only by migration/ops scripts; the Supabase service-role key used only in server-side storage code (`/lib/storage`), never exposed to the client, never by request paths.
- **Headers:** CSP (nonce-based), HSTS, `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `frame-ancestors 'none'`.
- **Dependency hygiene:** `npm audit` in CI, Dependabot/Renovate weekly.

---

## 9. Quality, testing & CI/CD

### 9.1 Test layers

| Layer | Tooling (no new deps beyond stack) | Must cover |
|-------|-----------------------------------|------------|
| Unit | `node:test` via `tsx` | Pure domain logic: drip dates, rank calc, quota math, state machine, signature verify |
| DB / integration | `node:test` against real Postgres (an ephemeral **Neon branch per CI run**, deleted afterwards) | **RLS isolation** for every tenant table × every role; quota enforcement inside tx; permission matrix; subscription transitions; outbox idempotency |
| E2E (Phase 10) | Playwright (ask before adding) | Signup → class → registration → approve → attend → marks → publish → student sees result |
| Load | k6 | 200 concurrent attendance saves; outbox drain throughput |

Generated test: a script enumerates every table with a `tenant_id` column and asserts it has `relrowsecurity` + `relforcerowsecurity` + a policy with both `USING` and `WITH CHECK`. New tables can't slip through.

### 9.2 Pipeline

```
PR → lint + typecheck → migrate fresh DB (as akura_migrator) → unit + DB tests → build → Vercel preview
main → same + migrate staging → deploy staging → smoke → manual promote → migrate prod → deploy prod
```

Environments: `local` (personal Neon dev branch, or Docker Postgres for offline work), `preview` (Neon branch per PR, auto-created by the Neon–Vercel integration), `staging` (Neon `staging` branch, PayHere sandbox, Resend test domain), `production` (Neon `main` branch). Migrations are forward-only; destructive changes use expand → migrate → contract across releases.

### 9.3 Definition of done (per feature)
Requirement ID referenced · Zod schemas · `requireRole` · `withTenant` · RLS policy + test · audit entry where applicable · quota check where applicable · empty/error/loading states · mobile check at 360 px · no capability cross-imports.

---

## 10. Delivery plan

Each phase ends with a demo, passing CI and a written exit checklist. Per AGENTS.md, file lists are confirmed before each phase starts.

| Phase | Scope | Key deliverables | Exit criteria | Est. |
|-------|-------|------------------|---------------|------|
| **0 Discovery** | Interviews with 3–5 institutes; resolve open questions §12 | Answered Q1–Q10; design tokens + component inventory; clickable wireframes for attendance, marks grid, dashboard, join page | Owner sign-off on business rules | 1 wk |
| **1 Foundation** | UI shell + design system base (`/components/ui`, tokens, dark mode); repo, Neon project + branches, roles, `withTenant`, tenants/memberships/audit_log/events, middleware, cookies, RLS CI tests | Cross-tenant test suite green; lint rule for raw DB access | A deliberate leak attempt fails in CI | 1.5 wk |
| **2 Auth & roles** | Better Auth on Neon, signup→tenant+owner, invitations, `requireRole`, tenant switcher, ownership transfer | Permission matrix tests | Every cell of §2.2 has a test | 1.5 wk |
| **3 Settings & billing skeleton** | setting_definitions, `settings.get`, plans, subscriptions, trial, `assertQuota`, `assertWritable` | Quota tests incl. attendance-never-blocked | Over-cap write rejected inside same tx; no data deleted | 1 wk |
| **4 People & registration** | Students, guardians, classes, enrolments, CSV import, registration links, QR, OG, approval queue | Public join flow, approval queue | Applicant → approved student in < 2 min | 2 wk |
| **5 Attendance** | Sessions, 3-tap UI, offline draft + sync, lock, reports, absence events | Teacher PWA-style screen | G2 met on a real low-end phone | 2 wk |
| **6 Exams & marks** | Exams, entry grid, draft→publish, stored ranks, report card PDF | PDF output signed off by an institute | G3 met; student can't see draft marks (RLS test) | 2 wk |
| **7 Courses** | Course→Module→Resource, Storage, signed URLs, drip | Content editor, student course view | Cross-tenant file access test fails as expected | 1.5 wk |
| **8 Email** | Outbox worker, React Email templates, batching, quiet hours, Resend webhook | All templates previewable | Emails respect quiet hours & quota in tests | 1 wk |
| **9 Billing live** | PayHere recurring, notify webhook, bank transfer, state machine, receipts, operator console | Sandbox end-to-end charge + failure | All transitions in Q8 tested | 2 wk |
| **10 Harden** | Seed data, export, monitoring/alerts, backup restore drill, load test, security review, E2E | Runbooks in `docs/ops` | NFR-1/4 met under k6; restore drill done | 1.5 wk |
| **Pilot** | 2–3 friendly institutes for one term | Feedback log, bug triage | No P1 issues for 2 weeks → GA | 4 wk |

≈ 18 weeks build + 4 weeks pilot for one full-stack developer; ~11–12 weeks with two (Phases 4–7 parallelise well because capabilities are isolated).

### Critical path
`1 → 2 → 3` are strictly sequential (everything depends on tenancy, auth, quotas). After 3, **People (4)** unblocks Attendance, Exams and Courses, which can run in parallel. Email (8) can start its worker after Phase 1 events table exists. Billing live (9) is blocked only on Q8 answers and PayHere merchant approval — **apply for the PayHere merchant account in week 1**, because approval takes time.

---

## 11. Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| RLS mis-policy leaks data | Critical | Generated RLS coverage test, FORCE RLS, no BYPASSRLS, per-role tests |
| Pooler + `SET` leaks tenant context between requests | Critical | `SET LOCAL` only inside `withTenant` transactions; test that runs two tenants interleaved on one pooled connection |
| PayHere merchant approval / recurring API delays | High | Apply in week 1; bank transfer path ships first |
| Teachers on poor connectivity lose attendance | High | Offline draft + idempotent sync; field test in Phase 5 |
| Email deliverability (bounces, spam) | Medium | Verified sending domain, SPF/DKIM/DMARC, bounce handling, batching |
| Vercel Hobby limits (crons, function duration) | Medium | External scheduler; chunked outbox batches; move to Pro before GA |
| Scope creep into §14 features | Medium | Non-goals list in every phase review |
| Neon Auth SDK hardcodes `__Secure-` cookies and needs Next 16 | Resolved | Spike done 2026-10-24: switched to self-hosted Better Auth (same engine) with `__Host-` cookies |
| Two vendors (Neon + Supabase) to run | Low | Supabase used for storage only; storage usage reconciled daily against `resources.size_bytes`; orphaned objects swept by cron |
| Neon cold start delays first 8 am request | Medium | Keep production compute warm; monitor p95 latency at session start |
| Business rules invented by developers | Medium | Phase 0 sign-off; AGENTS.md §15 ambiguity rule |

---

## 12. Open questions (must be answered by the product owner — not decided by engineering)

| # | Question |
|---|----------|
| Q1 | Staff invitation expiry length? Can admins resend/revoke? |
| Q2 | Can a student belong to multiple classes of the same subject? Can a student self-register into multiple institutes with one login? |
| Q3 | Attendance % formula: are `late` counted as present? Are `excused` excluded from the denominator? |
| Q4 | Ranking: by total or average? Tie handling (1,1,3 vs 1,1,2)? Students absent for a paper — ranked or excluded? |
| Q5 | Grade bands (A/B/C/S/W style for O/L & A/L?) — fixed or per-tenant setting? |
| Q6 | Default quiet-hours window and batching interval for guardian email? |
| Q7 | Trial length, and which plan's caps apply during trial? |
| Q8 | Full subscription state machine: grace period length after failed payment, when `read_only` begins, what a downgrade below current usage does, cancellation behaviour, refunds |
| Q9 | Data retention after a tenant cancels — how long before purge, and what export is offered? |
| Q10 | Plan names, caps and LKR prices for launch |

---

## 13. Immediate next steps

1. Product owner answers Q1–Q10 (Phase 0).
2. Update `AGENTS.md` §2 stack table to Neon DB + Better Auth + Supabase Storage so the brief and this plan agree.
3. Apply for PayHere merchant + recurring access; verify the Resend sending domain.
4. Create the Neon project with `main` and `staging` branches, connect the Neon–Vercel integration; create a storage-only Supabase project with a private bucket (separate buckets/projects for staging and prod); create `akura_app` and `akura_migrator` roles.
5. Confirm Phase 1 file list, then start.
