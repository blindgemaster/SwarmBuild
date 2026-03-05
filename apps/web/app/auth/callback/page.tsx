"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

/**
 * Supabase redirects back to /auth/callback after Google OAuth.
 * This page exchanges the code for a session and then redirects home.
 */
export default function AuthCallbackPage() {
    const router = useRouter();

    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }: { data: { session: import("@supabase/supabase-js").Session | null } }) => {
            // Session is automatically set by Supabase from the URL hash/code
            if (session) {
                router.replace("/");
            } else {
                // Fallback: try exchanging code from URL params
                const params = new URLSearchParams(window.location.search);
                const code = params.get("code");
                if (code) {
                    supabase.auth.exchangeCodeForSession(code).then(() => {
                        router.replace("/");
                    });
                } else {
                    router.replace("/login");
                }
            }
        });
    }, [router]);

    return (
        <div
            style={{
                minHeight: "60vh",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 16,
            }}
        >
            <div
                style={{
                    width: 36, height: 36,
                    border: "3px solid var(--accent)",
                    borderTopColor: "transparent",
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite",
                }}
            />
            <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Signing you in…</p>
        </div>
    );
}
