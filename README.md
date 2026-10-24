# Akura

Multi-tenant Learning Management System for education institutes. Built by Elgiriya Innovations.

Tenant workspaces live at `/i/{slug}`. Every institute gets every feature; plans differ only by capacity.

## Stack

- Next.js App Router + TypeScript
- Neon Postgres + Drizzle ORM (`pg` driver)
- Better Auth (self-hosted; identities in Neon `auth_*` tables, `__Host-akura.*` cookies)
- Tailwind CSS
- Supabase Storage for course files (storage only)
- Resend + React Email
- PayHere recurring billing

## Prerequisites

- Node.js 20+
- Neon project: pooled connection string (`DATABASE_URL`) and direct one (`DATABASE_URL_UNPOOLED`)
- Supabase project used **only** for Storage (private bucket `akura-uploads`)

## Setup

```bash
cp .env.example .env
# Fill DATABASE_URL*, BETTER_AUTH_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, etc.

npm install
npm run db:migrate
npm run db:seed   # optional demo tenant: demo-institute
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Sign-up requires email verification. Without Resend configured, the verification link is printed to the server console. For local work you can set `AUTH_SKIP_EMAIL_VERIFICATION="true"` (ignored in production).

## Ops

- Health: `GET /api/health` · Ready: `GET /api/ready`
- Backup/restore: [`docs/ops/backup-restore.md`](docs/ops/backup-restore.md)
- Monitoring: [`docs/ops/monitoring.md`](docs/ops/monitoring.md)
- Load smoke: `BASE_URL=http://localhost:3000 npm run load:smoke` (requires [k6](https://k6.io))

## Tests

```bash
npm test
```

Requires `DATABASE_URL` pointing at a migrated database.

## Docs

- [`AGENTS.md`](AGENTS.md) — product brief and invariants
- [`docs/AUDIT.md`](docs/AUDIT.md) — Phase 0 audit
- [`docs/ops/`](docs/ops/) — backup & monitoring
