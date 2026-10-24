import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { sessionCookieName } from "@/lib/auth/cookies";

function isPublic(pathname: string) {
  return (
    pathname === "/" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/accept-invite") ||
    pathname.startsWith("/pending-approval") ||
    pathname.startsWith("/join/") ||
    pathname.startsWith("/r/") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/qr") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/ready") ||
    pathname.startsWith("/api/webhooks/") ||
    pathname.startsWith("/api/cron/") ||
    pathname.startsWith("/api/ops/")
  );
}

export default async function middleware(req: NextRequest) {
  if (req.headers.has("next-action") || req.headers.has("Next-Action")) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;
  // Optimistic gate only: the cookie's signature and expiry are verified by
  // getSessionUser() (Better Auth) inside requireRole() on every request.
  const hasSession = req.cookies.has(sessionCookieName);

  if (!isPublic(pathname) && !hasSession) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  const requestHeaders = new Headers(req.headers);
  const match = pathname.match(/^\/i\/([^/]+)/);
  if (match?.[1]) {
    requestHeaders.set("x-akura-tenant-slug", decodeURIComponent(match[1]));
  }

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
