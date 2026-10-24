import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { getPool } from "@/lib/db";
import { betterAuthCookies } from "@/lib/auth/cookies";
import { isResendConfigured, sendEmail } from "@/lib/email/client";
import { VerifyEmail } from "@/emails/verify-email";

function siteUrl() {
  return (
    process.env.BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

/** Local dev only — production always requires a verified email (FR-2.1). */
const skipEmailVerification =
  process.env.NODE_ENV !== "production" &&
  process.env.AUTH_SKIP_EMAIL_VERIFICATION === "true";

/**
 * Self-hosted Better Auth; identity tables live in Neon (0012_better_auth.sql).
 * Keep modelName / fields in sync with that migration.
 */
export const betterAuthServer = betterAuth({
  appName: "Akura",
  baseURL: siteUrl(),
  secret: process.env.BETTER_AUTH_SECRET,
  database: getPool(),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    requireEmailVerification: !skipEmailVerification,
  },
  emailVerification: {
    sendOnSignUp: !skipEmailVerification,
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user, url }) {
      if (!isResendConfigured()) {
        console.warn(`[auth] Resend not configured — verify ${user.email}: ${url}`);
        return;
      }
      await sendEmail({
        to: user.email,
        subject: "Confirm your email for Akura",
        react: VerifyEmail({ name: user.name, verifyUrl: url }),
      });
    },
  },
  user: {
    modelName: "auth_users",
    fields: {
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  session: {
    modelName: "auth_sessions",
    fields: {
      userId: "user_id",
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  account: {
    modelName: "auth_accounts",
    fields: {
      userId: "user_id",
      accountId: "account_id",
      providerId: "provider_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  verification: {
    modelName: "auth_verifications",
    fields: {
      expiresAt: "expires_at",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  advanced: {
    // Names below already carry __Host-; stop Better Auth adding __Secure-.
    useSecureCookies: false,
    cookies: betterAuthCookies,
  },
  // nextCookies must stay last so Set-Cookie from server actions reaches the browser.
  plugins: [nextCookies()],
});

type AuthError = { message: string; code?: string };

type AuthResult = {
  error: AuthError | null;
  user?: { id: string; email: string } | null;
};

function toError(err: unknown): AuthError {
  if (err instanceof APIError) {
    return { message: err.message, code: err.body?.code };
  }
  if (err instanceof Error) return { message: err.message };
  return { message: "Authentication failed" };
}

/**
 * Small facade so server actions don't depend on Better Auth directly.
 * Cookies are written through next/headers by the nextCookies plugin.
 */
export const auth = {
  signIn: {
    email: async (opts: {
      email: string;
      password: string;
    }): Promise<AuthResult> => {
      try {
        const res = await betterAuthServer.api.signInEmail({
          body: { email: opts.email, password: opts.password },
          headers: await headers(),
        });
        return { error: null, user: { id: res.user.id, email: res.user.email } };
      } catch (err) {
        return { error: toError(err), user: null };
      }
    },
  },
  signUp: {
    email: async (opts: {
      email: string;
      password: string;
      name?: string;
    }): Promise<AuthResult> => {
      try {
        const res = await betterAuthServer.api.signUpEmail({
          body: {
            email: opts.email,
            password: opts.password,
            name: opts.name ?? opts.email.split("@")[0] ?? opts.email,
            callbackURL: "/login?verified=1",
          },
          headers: await headers(),
        });
        return { error: null, user: { id: res.user.id, email: res.user.email } };
      } catch (err) {
        return { error: toError(err), user: null };
      }
    },
  },
  signOut: async (): Promise<AuthResult> => {
    try {
      await betterAuthServer.api.signOut({ headers: await headers() });
      return { error: null };
    } catch (err) {
      return { error: toError(err) };
    }
  },
};
