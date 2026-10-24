import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import {
  resolveTenantIdBySlug,
  requireMembership,
} from "@/lib/tenant/resolve";
import {
  addResource,
  assertStorageQuota,
  CourseError,
} from "@/capabilities/courses/lib/service";
import { putResourceObject, isStorageConfigured } from "@/lib/storage/supabase";

export const runtime = "nodejs";

const metaSchema = z.object({
  slug: z.string().min(1),
  moduleId: z.string().uuid(),
  title: z.string().trim().min(2),
});

export async function POST(req: Request) {
  if (!isStorageConfigured()) {
    return NextResponse.json(
      {
        error:
          "Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (and create the storage bucket).",
      },
      { status: 503 },
    );
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }

  const parsed = metaSchema.safeParse({
    slug: form.get("slug"),
    moduleId: form.get("moduleId"),
    title: form.get("title") || file.name,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid upload metadata" }, { status: 400 });
  }

  const tenantId = await resolveTenantIdBySlug(parsed.data.slug);
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  const membership = await requireMembership({
    tenantId,
    authUserId: user.id,
  });
  if (!membership || (membership.role !== "admin" && membership.role !== "teacher")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (bytes.byteLength > 50 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (50MB max)" }, { status: 400 });
  }

  try {
    await assertStorageQuota({
      tenantId,
      userId: user.id,
      bytes: bytes.byteLength,
    });

    const { key } = await putResourceObject({
      tenantId,
      body: bytes,
      contentType: file.type || "application/octet-stream",
    });

    const resource = await addResource({
      tenantId,
      userId: user.id,
      moduleId: parsed.data.moduleId,
      title: parsed.data.title,
      type: "file",
      storageKey: key,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: bytes.byteLength,
      isAdmin: membership.role === "admin",
      recordStorageBytes: bytes.byteLength,
    });

    return NextResponse.json({ ok: true, resourceId: resource.id });
  } catch (err) {
    if (err instanceof CourseError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
