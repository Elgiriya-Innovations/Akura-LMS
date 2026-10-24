import { toNextJsHandler } from "better-auth/next-js";
import { betterAuthServer } from "@/lib/auth/server";

/** Better Auth HTTP endpoints (email verification links, session, sign-out). */
export const { GET, POST } = toNextJsHandler(betterAuthServer);
