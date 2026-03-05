import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Singleton Supabase browser client.
 * 
 * flowType: 'pkce' — forces the PKCE code-exchange flow so that after
 * Google OAuth, Supabase redirects to /auth/callback?code=xxx (clean URL)
 * instead of dumping tokens directly in the home page hash.
 */
export const supabase = createClient(supabaseUrl, supabaseAnon, {
    auth: {
        flowType: "pkce",
        detectSessionInUrl: true,
        persistSession: true,
    },
});
