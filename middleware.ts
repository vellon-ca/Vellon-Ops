import { type NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Refreshes the Supabase auth session on every request and bounces
// unauthenticated traffic to /login. The definitive allowlist check happens
// server-side in requirePlatformOwner(); this is the first, coarse gate.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getClaims() refreshes the session cookie (like getUser) but verifies the
  // JWT signature locally via cached JWKS when asymmetric signing keys are on —
  // no auth-server round-trip on every request. Falls back to getUser() on
  // legacy HS256, so it's never weaker. The definitive allowlist check still
  // happens server-side in requirePlatformOwner().
  const {
    data,
  } = await supabase.auth.getClaims();
  const authed = !!data?.claims?.sub;

  const { pathname } = request.nextUrl;
  const isPublic =
    pathname.startsWith("/login") || pathname.startsWith("/auth");

  if (!authed && !isPublic) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.).*)"],
};
