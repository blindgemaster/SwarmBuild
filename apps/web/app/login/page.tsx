"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/app/components/AuthProvider";
import Link from "next/link";

export default function LoginPage() {
    const { user, loading, signInWithGoogle } = useAuth();
    const router = useRouter();

    // Already logged in → go home
    useEffect(() => {
        if (!loading && user) router.replace("/");
    }, [user, loading, router]);

    return (
        <div
            style={{
                minHeight: "80vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "2rem",
            }}
        >
            <div
                style={{
                    width: "100%",
                    maxWidth: 400,
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "2.5rem 2rem",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "1.5rem",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
                }}
            >
                {/* Logo */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <img src="/logo.png" alt="Swarmbuild" style={{ width: 52, height: 52 }} />
                    <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Swarmbuild</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                        Sign in to submit ideas and join builds
                    </p>
                </div>

                <hr style={{ width: "100%", borderColor: "var(--border)", borderTop: "none" }} />

                {/* Google sign-in button */}
                <button
                    onClick={signInWithGoogle}
                    disabled={loading}
                    style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 12,
                        padding: "12px 20px",
                        background: "white",
                        color: "#1f1f1f",
                        border: "1px solid #dadce0",
                        borderRadius: 4,
                        fontSize: 15,
                        fontWeight: 500,
                        cursor: "pointer",
                        transition: "box-shadow 0.2s",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.2)")}
                    onMouseLeave={e => (e.currentTarget.style.boxShadow = "none")}
                >
                    {/* Google logo */}
                    <svg width="18" height="18" viewBox="0 0 48 48">
                        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                    </svg>
                    Continue with Google
                </button>

                <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", margin: 0 }}>
                    By signing in you agree to our terms of service.
                    <br />
                    <Link href="/" style={{ color: "var(--accent)", textDecoration: "none" }}>
                        ← Back to job board
                    </Link>
                </p>
            </div>
        </div>
    );
}
