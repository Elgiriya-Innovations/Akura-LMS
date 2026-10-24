import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createTestPool } from "./helpers/db-pool";
import { createTestAuthUser, createTestTenant } from "./helpers/test-tenant";

// Must be set before lib/auth/server and lib/db load (dynamic imports below).
process.env.AUTH_SKIP_EMAIL_VERIFICATION = "true";
process.env.BETTER_AUTH_SECRET ??= "test-secret-".padEnd(48, "x");
process.env.BETTER_AUTH_URL = "http://localhost:3000";
// One backend connection, so consecutive withTenant() calls share it exactly
// like requests multiplexed onto one PgBouncer server connection.
process.env.DATABASE_POOL_MAX = "1";

const pool = createTestPool();
const BASE = "http://localhost:3000/api/auth";

type AuthModule = typeof import("../lib/auth/server");
type TenantModule = typeof import("../lib/db/tenant");
let betterAuthServer: AuthModule["betterAuthServer"];
let withTenant: TenantModule["withTenant"];

function post(path: string, body: unknown, cookie?: string) {
  return betterAuthServer.handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function getSession(cookie: string) {
  return betterAuthServer.handler(
    new Request(`${BASE}/get-session`, { headers: { cookie } }),
  );
}

function sessionSetCookie(res: Response) {
  const all = res.headers.getSetCookie();
  return all.find((c) => c.startsWith("__Host-akura.session_token="));
}

describe("Better Auth sessions on Neon", () => {
  const email = `auth-${randomUUID()}@test.akura.invalid`;
  const password = "correct-horse-battery";
  let sessionCookie = "";
  let userId = "";

  before(async () => {
    ({ betterAuthServer } = await import("../lib/auth/server"));
    ({ withTenant } = await import("../lib/db/tenant"));
  });

  it("issues only __Host- session cookies with Secure, HttpOnly, Path=/, no Domain (§4.4)", async () => {
    const res = await post("/sign-up/email", { email, password, name: "Auth Test" });
    assert.equal(res.status, 200, await res.clone().text());
    userId = ((await res.json()) as { user: { id: string } }).user.id;

    for (const c of res.headers.getSetCookie()) {
      assert.match(c, /^__Host-akura\./, `unexpected cookie name: ${c}`);
      assert.match(c, /;\s*Secure/i);
      assert.match(c, /;\s*HttpOnly/i);
      assert.match(c, /;\s*Path=\/(;|$)/i);
      assert.match(c, /;\s*SameSite=Lax/i);
      assert.doesNotMatch(c, /;\s*Domain=/i);
    }

    const setCookie = sessionSetCookie(res);
    assert.ok(setCookie, "session cookie must be set on sign-up");
    sessionCookie = setCookie.split(";")[0]!;
  });

  it("resolves the session from the __Host- cookie", async () => {
    const res = await getSession(sessionCookie);
    const body = (await res.json()) as { user?: { id: string; email: string } } | null;
    assert.equal(body?.user?.id, userId);
    assert.equal(body?.user?.email, email);
  });

  it("ignores the same token under a __Secure- name (no cookie tossing from sibling subdomains)", async () => {
    const value = sessionCookie.slice(sessionCookie.indexOf("=") + 1);
    for (const name of ["__Secure-better-auth.session_token", "better-auth.session_token", "__Secure-akura.session_token"]) {
      const res = await getSession(`${name}=${value}`);
      assert.equal(await res.json(), null, `${name} must not authenticate`);
    }
  });

  it("rejects a wrong password", async () => {
    const res = await post("/sign-in/email", { email, password: "wrong-password" });
    assert.equal(res.status, 401);
    assert.equal(sessionSetCookie(res), undefined);
  });

  it("sign-out invalidates the session server-side", async () => {
    const signIn = await post("/sign-in/email", { email, password });
    const cookie = sessionSetCookie(signIn)!.split(";")[0]!;
    assert.ok(((await (await getSession(cookie)).json()) as { user?: unknown })?.user);

    const out = await post("/sign-out", {}, cookie);
    assert.equal(out.status, 200);
    assert.equal(await (await getSession(cookie)).json(), null);
  });
});

describe("identity tables vs application data", () => {
  let tenantId = "";
  let ownerUserId = "";

  before(async () => {
    ({ withTenant } = await import("../lib/db/tenant"));
    const t = await createTestTenant(pool);
    tenantId = t.tenantId;
    ownerUserId = t.ownerUserId;
  });

  it("akura_app cannot read auth tables", async () => {
    for (const table of ["auth_users", "auth_sessions", "auth_accounts", "auth_verifications"]) {
      await assert.rejects(
        withTenant({ tenantId, userId: ownerUserId }, (tx) =>
          tx.execute(`SELECT 1 FROM ${table} LIMIT 1`),
        ),
        (err: Error & { cause?: Error }) => {
          assert.match(err.cause?.message ?? err.message, /permission denied/);
          return true;
        },
        `${table} must not be readable by akura_app`,
      );
    }
  });

  it("deleting an auth user with a membership is restricted (§4.8)", async () => {
    await assert.rejects(
      pool.query(`DELETE FROM auth_users WHERE id = $1`, [ownerUserId]),
      /memberships_auth_user_fk/,
    );
  });

  it("deleting a student's auth user keeps the student record", async () => {
    const studentUser = await createTestAuthUser(pool);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO students (tenant_id, auth_user_id, full_name)
       VALUES ($1, $2, 'Linked Student') RETURNING id`,
      [tenantId, studentUser],
    );
    await pool.query(`DELETE FROM auth_users WHERE id = $1`, [studentUser]);
    const after = await pool.query(
      `SELECT auth_user_id FROM students WHERE id = $1`,
      [rows[0]!.id],
    );
    assert.equal(after.rowCount, 1);
    assert.equal(after.rows[0].auth_user_id, null);
  });
});

describe("pooled connection does not leak tenant context", () => {
  let a = { tenantId: "", userId: "" };
  let b = { tenantId: "", userId: "" };

  before(async () => {
    ({ withTenant } = await import("../lib/db/tenant"));
    const ta = await createTestTenant(pool);
    const tb = await createTestTenant(pool);
    a = { tenantId: ta.tenantId, userId: ta.ownerUserId };
    b = { tenantId: tb.tenantId, userId: tb.ownerUserId };
  });

  it("each transaction sees only its own tenant, and nothing survives commit", async () => {
    const read = (ctx: typeof a) =>
      withTenant(ctx, async (tx) => {
        const r = await tx.execute<{ tenant: string; usr: string; pid: number }>(
          `SELECT current_setting('app.current_tenant', true) AS tenant,
                  current_user AS usr, pg_backend_pid() AS pid`,
        );
        return r.rows[0]!;
      });

    const first = await read(a);
    const second = await read(b);
    assert.equal(first.pid, second.pid, "test needs both calls on one backend");
    assert.equal(first.tenant, a.tenantId);
    assert.equal(second.tenant, b.tenantId);
    assert.equal(first.usr, "akura_app");

    const { db } = await import("../lib/db");
    const leftover = await db.execute<{ tenant: string | null; usr: string }>(
      `SELECT NULLIF(current_setting('app.current_tenant', true), '') AS tenant,
              current_user AS usr`,
    );
    assert.equal(leftover.rows[0]!.tenant, null, "tenant GUC must not outlive the transaction");
    assert.notEqual(leftover.rows[0]!.usr, "akura_app", "SET LOCAL ROLE must not outlive the transaction");
  });
});

after(async () => {
  await pool.end();
  const { pool: appPool } = await import("../lib/db");
  await appPool.end();
});
