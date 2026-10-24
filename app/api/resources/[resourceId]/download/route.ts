import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext } from "@/lib/tenant/context";
import { TenantError } from "@/lib/tenant/resolve";
import {
  authorizeResourceDownload,
  findStudentByAuthUser,
  CourseError,
} from "@/capabilities/courses/lib/service";
import { isStorageConfigured, signedDownloadUrl } from "@/lib/storage/supabase";

export const runtime = "nodejs";

const querySchema = z.object({
  slug: z.string().min(1),
  resourceId: z.string().uuid(),
});

export async function GET(
  req: Request,
  ctx: { params: Promise<{ resourceId: string }> },
) {
  if (!isStorageConfigured()) {
    return NextResponse.json(
      {
        error:
          "Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (and create the storage bucket).",
      },
      { status: 503 },
    );
  }

  const { resourceId } = await ctx.params;
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    slug: url.searchParams.get("slug"),
    resourceId,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }

  try {
    const tenantCtx = await getTenantContext(parsed.data.slug);
    const isAdmin = tenantCtx.membership.role === "admin";
    const isTeacher = tenantCtx.membership.role === "teacher";

    let studentId: string | null = null;
    if (tenantCtx.membership.role === "student") {
      const student = await findStudentByAuthUser({
        tenantId: tenantCtx.tenantId,
        userId: tenantCtx.user.id,
        authUserId: tenantCtx.user.id,
      });
      studentId = student?.id ?? null;
    }

    const row = await authorizeResourceDownload({
      tenantId: tenantCtx.tenantId,
      userId: tenantCtx.user.id,
      resourceId: parsed.data.resourceId,
      isAdmin,
      isTeacher,
      studentId,
    });

    const signed = await signedDownloadUrl({
      storageKey: row.resource.storageKey!,
      filename: row.resource.title,
    });

    return NextResponse.redirect(signed);
  } catch (err) {
    if (err instanceof TenantError && err.code === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    if (err instanceof CourseError || err instanceof TenantError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : "Failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
