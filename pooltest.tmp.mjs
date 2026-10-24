import "dotenv/config";
import { Pool } from "pg";

const u = new URL(process.env.DATABASE_URL);
const pw = decodeURIComponent(u.password);

async function tryConn(label, connStr) {
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 10000 });
  const c = await pool.connect();
  try {
    await c.query("SET LOCAL ROLE akura_app");
    await c.query("SELECT set_config('app.current_tenant', '00000000-0000-0000-0000-000000000000', true)");
    const f = await c.query("SELECT proname FROM pg_proc WHERE proname='app_create_tenant_with_owner'");
    const ver = await c.query("SELECT version()");
    console.log(label, "OK | function:", f.rowCount>0 ? "yes":"no |", ver.rows[0].version.slice(0,40));
  } catch (e) {
    console.log(label, "FAIL:", e.message);
  } finally {
    c.release();
    await pool.end();
  }
}

const ref = "sggtqvdiivuhurdgdigf";
const encPw = encodeURIComponent(pw);
const dbName = u.pathname.slice(1) || "postgres";

await tryConn("SESSION-pooler(5432)", `postgresql://postgres.${ref}:${encPw}@aws-0-ap-south-1.pooler.supabase.com:5432/${dbName}`);
await tryConn("TRANSACTION-pooler(6543)", `postgresql://postgres.${ref}:${encPw}@aws-0-ap-south-1.pooler.supabase.com:6543/${dbName}`);
