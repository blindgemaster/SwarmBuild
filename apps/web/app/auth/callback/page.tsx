"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

/**
 * Supabase OAuth callback handler.
 *
 * Handles both flows:
 *  - PKCE (preferred): ?code=xxx → exchangeCodeForSession → redirect to /
 *  - Implicit (legacy): #access_token=xxx → already in session → redirect to /
 */
export default function AuthCallbackPage() {
    const router = useRouter();

    useEffect(() => {
        async function handleCallback() {
            // Check for PKCE code in query params
            const params = new URLSearchParams(window.location.search);
            const code = params.get("code");

            if (code) {
                const { error } = await supabase.auth.exchangeCodeForSession(code);
                if (error) {
                    console.error("Code exchange failed:", error.message);
                    router.replace("/login?error=auth_failed");
                    return;
                }
                router.replace("/");
                return;
            }

            // Fallback: check if session already exists (implicit flow already set it)
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
                router.replace("/");
                return;
            }

            // Nothing worked
            router.replace("/login?error=no_session");
        }

        handleCallback();
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
