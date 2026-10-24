"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { auth } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { auditLog, invitations, memberships, tenants } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { createTenantWithOwner, transferOwnership } from "@/lib/tenant/ownership";
import { redirectToRoleHome, requireRole } from "@/lib/tenant/context";
import { getSessionUser } from "@/lib/auth/session";
import { rowsOf } from "@/lib/db/result";
import { isResendConfigured, sendEmail } from "@/lib/email/client";
import { InviteEmail } from "@/emails/invite";
import { ADMIN_ROLES, roleHomePath } from "@/lib/rbac";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const signupSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  instituteName: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens."),
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "teacher", "student"]),
});

export type FormState = { error?: string; ok?: string; inviteUrl?: string } | null;

export async function loginAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "Enter a valid email and password." };
  }

  const result = await auth.signIn.email({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (result.error?.code === "EMAIL_NOT_VERIFIED") {
    return { error: "Confirm your email first — we sent you a link when you signed up." };
  }
  if (result.error) {
    return { error: "Sign in failed. Check your email and password." };
  }

  const session = await getSessionUser();
  if (!session) {
    return { error: "Signed in, but session was not available. Try again." };
  }

  await redirectToRoleHome(session.id);
  return null;
}

export async function signupAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = signupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    instituteName: formData.get("instituteName"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid signup details." };
  }

  const signUp = await auth.signUp.email({
    email: parsed.data.email,
    password: parsed.data.password,
    name: parsed.data.name,
  });
  if (signUp.error) {
    return { error: "Could not create account. The email may already be in use." };
  }

  // Prefer session; fall back to signUp user when email confirmation is enabled.
  let user = await getSessionUser();
  if (!user) {
    const signIn = await auth.signIn.email({
      email: parsed.data.email,
      password: parsed.data.password,
    });
    if (!signIn.error) {
      user = await getSessionUser();
    }
  }
  if (!user && signUp.user) {
    user = {
      id: signUp.user.id,
      email: signUp.user.email,
      name: parsed.data.name,
    };
  }
  if (!user) {
    return {
      error:
        "Account created. Confirm your email (if required), then sign in to finish setup.",
    };
  }

  try {
    await createTenantWithOwner({
      slug: parsed.data.slug,
      name: parsed.data.instituteName,
      authUserId: user.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("slug_taken")) {
      return { error: "That institute URL is already taken. Choose another slug." };
    }
    if (message.includes("invalid_slug")) {
      return { error: "Invalid institute slug." };
    }
    return { error: "Could not create your institute. Try a different slug." };
  }

  const session = await getSessionUser();
  if (!session) {
    return {
      error:
        "Institute created. Confirm your email if prompted, then sign in at /login.",
    };
  }

  redirect(`/i/${parsed.data.slug}/admin/onboarding`);
}

export async function createInviteAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { error: "Enter a valid email and role." };
  }

  let ctx;
  try {
    ctx = await requireRole(slug, ADMIN_ROLES);
  } catch {
    return { error: "Only institute admins can invite people." };
  }

  const token = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);
  const base =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
    "http://localhost:3000";
  const acceptUrl = `${base}/accept-invite?token=${token}`;

  await withTenant(
    { tenantId: ctx.tenantId, userId: ctx.user.id },
    async (tx) => {
      await tx.insert(invitations).values({
        tenantId: ctx.tenantId,
        email: parsed.data.email.toLowerCase(),
        role: parsed.data.role,
        token,
        expiresAt,
        invitedByAuthUserId: ctx.user.id,
      });
      await tx.insert(auditLog).values({
        tenantId: ctx.tenantId,
        actorUserId: ctx.user.id,
        action: "invitation.created",
        entityType: "invitation",
        entityId: token,
        payload: { email: parsed.data.email, role: parsed.data.role },
      });
    },
  );

  let emailed = false;
  if (isResendConfigured()) {
    try {
      await sendEmail({
        to: parsed.data.email,
        subject: `You're invited to ${ctx.tenant.name}`,
        react: InviteEmail({
          instituteName: ctx.tenant.name,
          role: parsed.data.role,
          acceptUrl,
          expiresLabel: expiresAt.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          }),
        }),
        idempotencyKey: `invite:${ctx.tenantId}:${token}`,
      });
      emailed = true;
    } catch {
      // Keep invite usable via link even if email fails
    }
  }

  return {
    ok: emailed
      ? "Invite created and emailed."
      : "Invite created. Share the link (configure Resend to email automatically).",
    inviteUrl: `/accept-invite?token=${token}`,
  };
}

export async function acceptInviteAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const schema = z.object({
    token: z.string().min(10),
    name: z.string().trim().min(2).max(120),
    email: z.string().email(),
    password: z.string().min(8).max(128),
  });
  const parsed = schema.safeParse({
    token: formData.get("token"),
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "Check your details and try again." };
  }

  const preview = await db.execute(sql`SELECT * FROM app_resolve_invitation_by_token(${parsed.data.token})`);

  const invite = rowsOf<{
    email: string;
    tenant_slug: string;
    role: "admin" | "teacher" | "student";
    accepted_at: Date | null;
    expires_at: Date;
    deleted_at: Date | null;
  }>(preview)[0];
  if (!invite || invite.deleted_at) {
    return { error: "Invite not found." };
  }
  if (invite.accepted_at) {
    return { error: "This invite was already accepted." };
  }
  if (new Date(invite.expires_at) < new Date()) {
    return { error: "This invite has expired." };
  }
  if (invite.email.toLowerCase() !== parsed.data.email.toLowerCase()) {
    return { error: "Use the email address this invite was sent to." };
  }

  let user = await getSessionUser();
  if (!user) {
    const signUp = await auth.signUp.email({
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.name,
    });
    if (signUp.error) {
      const signIn = await auth.signIn.email({
        email: parsed.data.email,
        password: parsed.data.password,
      });
      if (signIn.error) {
        return { error: "Could not sign up or sign in with that email." };
      }
    } else {
      await auth.signIn.email({
        email: parsed.data.email,
        password: parsed.data.password,
      });
    }
    user = await getSessionUser();
  }

  if (!user) {
    return { error: "Authentication failed." };
  }

  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return { error: "Use the email address this invite was sent to." };
  }

  try {
    await db.execute(
      sql`SELECT app_accept_invitation(
        ${parsed.data.token},
        ${user.id},
        ${parsed.data.email}
      )`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("invite_email_mismatch")) {
      return { error: "Use the email address this invite was sent to." };
    }
    if (message.includes("invite_expired")) {
      return { error: "This invite has expired." };
    }
    if (message.includes("invite_already_accepted")) {
      return { error: "This invite was already accepted." };
    }
    return { error: "Could not accept invite." };
  }

  redirect(roleHomePath(invite.tenant_slug, invite.role));
}

export async function completeOnboardingAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const schema = z.object({
    timezone: z.string().min(1).max(64),
    accentColor: z.string(),
  });
  const parsed = schema.safeParse({
    timezone: formData.get("timezone"),
    accentColor: formData.get("accentColor") || "",
  });
  if (!parsed.success) {
    return { error: "Check timezone and accent colour." };
  }
  if (
    parsed.data.accentColor &&
    !/^#[0-9A-Fa-f]{6}$/.test(parsed.data.accentColor)
  ) {
    return { error: "Accent colour must look like #E4761B." };
  }

  const ctx = await requireRole(slug, ADMIN_ROLES);

  await withTenant(
    { tenantId: ctx.tenantId, userId: ctx.user.id },
    async (tx) => {
      await tx
        .update(tenants)
        .set({
          timezone: parsed.data.timezone,
          accentColor: parsed.data.accentColor || null,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, ctx.tenantId));
      await tx.insert(auditLog).values({
        tenantId: ctx.tenantId,
        actorUserId: ctx.user.id,
        action: "onboarding.completed",
        entityType: "tenant",
        entityId: ctx.tenantId,
        payload: {
          timezone: parsed.data.timezone,
          accentColor: parsed.data.accentColor || null,
        },
      });
    },
  );

  redirect(`/i/${slug}/admin`);
}

export async function transferOwnershipAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const schema = z.object({
    membershipId: z.string().uuid(),
  });
  const parsed = schema.safeParse({
    membershipId: formData.get("membershipId"),
  });
  if (!parsed.success) {
    return { error: "Select a valid admin." };
  }

  const ctx = await requireRole(slug, ADMIN_ROLES);
  if (!ctx.membership.isOwner) {
    return { error: "Only the owner can transfer ownership." };
  }

  try {
    await transferOwnership({
      tenantId: ctx.tenantId,
      currentOwnerUserId: ctx.user.id,
      newOwnerMembershipId: parsed.data.membershipId,
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Transfer failed.",
    };
  }

  return { ok: "Ownership transferred." };
}

export async function listStaff(slug: string) {
  const ctx = await requireRole(slug, ADMIN_ROLES);
  return withTenant(
    { tenantId: ctx.tenantId, userId: ctx.user.id },
    async (tx) => {
      const members = await tx
        .select()
        .from(memberships)
        .where(
          and(eq(memberships.tenantId, ctx.tenantId), isNull(memberships.deletedAt)),
        )
        .orderBy(desc(memberships.createdAt));
      const invites = await tx
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.tenantId, ctx.tenantId),
            isNull(invitations.deletedAt),
            isNull(invitations.acceptedAt),
          ),
        )
        .orderBy(desc(invitations.createdAt));
      return { members, invites, ctx };
    },
  );
}
