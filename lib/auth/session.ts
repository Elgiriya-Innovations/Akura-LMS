import { cache } from "react";
import { cookies, headers } from "next/headers";
import { betterAuthServer } from "@/lib/auth/server";

/**
 * Build request headers from the live cookie store rather than the incoming
 * request, so a sign-in earlier in the same server action is visible here.
 */
async function sessionHeaders() {
  const h = new Headers(await headers());
  const cookieStore = await cookies();
  h.set(
    "cookie",
    cookieStore
      .getAll()
      .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
      .join("; "),
  );
  return h;
}

async function loadSessionUser() {
  const session = await betterAuthServer.api.getSession({
    headers: await sessionHeaders(),
  });
  const user = session?.user;
  if (!user?.id || !user.email) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name || user.email.split("@")[0] || null,
  };
}

/** Per-request memo — but never cached across a sign-in/out in the same action. */
const cachedSessionUser = cache(loadSessionUser);

export async function getSessionUser() {
  return (await headers()).has("next-action")
    ? loadSessionUser()
    : cachedSessionUser();
}
