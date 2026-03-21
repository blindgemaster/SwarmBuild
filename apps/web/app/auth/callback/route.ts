import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * GET /auth/callback — Server-side PKCE code exchange.
 *
 * Supabase redirects here with ?code=xxx after OAuth.
 * We exchange the code for a session server-side, set cookies,
 * then redirect to the home page.
 */
export async function GET(request: NextRequest) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get("code");

    if (!code) {
        // No code — redirect to login with error
        return NextResponse.redirect(`${origin}/login?error=no_code`);
    }

    const response = NextResponse.redirect(`${origin}/`);

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll();
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        response.cookies.set(name, value, options);
                    });
                },
            },
        },
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
        console.error("Auth callback error:", error.message);
        return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    }

    return response;
}
