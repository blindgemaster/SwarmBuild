import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Singleton Supabase browser client via @supabase/ssr.
 *
 * Uses cookie-based storage instead of localStorage, which fixes the
 * PKCE "code verifier not found" error in Next.js — the code_verifier
 * persists across page navigations via cookies instead of being lost
 * when Turbopack reloads the page.
 */
export const supabase = createBrowserClient(supabaseUrl, supabaseAnon);
