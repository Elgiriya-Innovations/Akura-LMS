-- Better Auth identity tables (self-hosted in Neon Postgres).
-- Schema matches better-auth@1.7.6 getMigrations() output for the modelName /
-- field mapping in lib/auth/server.ts — keep the two in sync.
--
-- These are global (not tenant-owned) tables. Only the login role used by
-- Better Auth touches them; akura_app gets no grants, so tenant code running
-- under withTenant() cannot read credentials or sessions.

CREATE TABLE IF NOT EXISTS auth_users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL,
  image text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Sessions/accounts cascade with their auth user: they are credentials, not
-- application records.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_accounts (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_verifications (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS auth_accounts_user_id_idx ON auth_accounts (user_id);
CREATE INDEX IF NOT EXISTS auth_verifications_identifier_idx ON auth_verifications (identifier);

REVOKE ALL ON TABLE auth_users, auth_sessions, auth_accounts, auth_verifications FROM PUBLIC;
REVOKE ALL ON TABLE auth_users, auth_sessions, auth_accounts, auth_verifications FROM akura_app;

-- Link application records to identities. Deleting an auth user must never
-- cascade into application data (AGENTS.md §4.8).
ALTER TABLE memberships
  ADD CONSTRAINT memberships_auth_user_fk
  FOREIGN KEY (auth_user_id) REFERENCES auth_users (id) ON DELETE RESTRICT;

ALTER TABLE students
  ADD CONSTRAINT students_auth_user_fk
  FOREIGN KEY (auth_user_id) REFERENCES auth_users (id) ON DELETE SET NULL;

ALTER TABLE student_applications
  ADD CONSTRAINT student_applications_auth_user_fk
  FOREIGN KEY (auth_user_id) REFERENCES auth_users (id) ON DELETE SET NULL;
