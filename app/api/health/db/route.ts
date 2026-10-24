import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** TEMPORARY diagnostic — raw pool.query to surface the full DB error. */
export async function GET() {
  const out: Record<string, unknown> = {};
  try {
    const f = await pool.query(`SELECT proname FROM pg_proc WHERE proname = 'app_create_tenant_with_owner'`);
    out.functionExists = (f.rowCount ?? 0) > 0;
  } catch (e) {
    const err = e as { message?: string; code?: string; detail?: string; hint?: string; routine?: string; name?: string };
    out.ok = false;
    out.name = err.name;
    out.message = err.message;
    out.code = err.code;
    out.detail = err.detail;
    out.hint = err.hint;
    out.routine = err.routine;
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  }
  out.ok = true;
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}
