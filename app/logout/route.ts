import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";

export async function POST(request: Request) {
  await auth.signOut();
  // 303 so the browser follows with GET — a 307 would re-POST to "/" (405).
  // Relative to the request so it never points at a build-time host.
  return NextResponse.redirect(new URL("/", request.url), 303);
}
