/**
 * Cookie policy for Akura sessions (§4.4).
 * `__Host-` prefix forbids a Domain attribute — shared parent DNS
 * (.elgiriya.com) must never receive app cookies.
 * A `__Host-` cookie is only honored by browsers when it is Secure,
 * has Path=/, and has no Domain.
 */
export const sessionCookieName = "__Host-akura.session_token";

export const sessionCookieOptions = {
  // Never set — __Host- forbids Domain; parent .elgiriya.com must not see cookies
  domain: undefined as undefined,
  path: "/",
  sameSite: "lax" as const,
  secure: true,
  httpOnly: true,
};

/**
 * Better Auth cookie overrides. Every cookie it can set gets a full `__Host-`
 * name so Better Auth never falls back to `__Secure-` (which allows Domain).
 */
export const betterAuthCookies = {
  session_token: { name: sessionCookieName, attributes: sessionCookieOptions },
  session_data: {
    name: "__Host-akura.session_data",
    attributes: sessionCookieOptions,
  },
  account_data: {
    name: "__Host-akura.account_data",
    attributes: sessionCookieOptions,
  },
  dont_remember: {
    name: "__Host-akura.dont_remember",
    attributes: sessionCookieOptions,
  },
};
