"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/app/components/AuthProvider";

/**
 * Navbar user menu — shows avatar + dropdown with logout.
 * Shown in place of the "Login" button when user is authenticated.
 */
export function NavUser() {
    const { user, loading, signOut } = useAuth();
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    // Close dropdown on outside click
    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    if (loading) {
        // Skeleton pill
        return <div style={{ width: 72, height: 32, borderRadius: 4, background: "var(--surface-2)" }} />;
    }

    if (!user) {
        return (
            <Link href="/login" className="btn btn-primary btn-sm">
                Sign in
            </Link>
        );
    }

    const name = user.user_metadata?.full_name || user.email?.split("@")[0] || "You";
    const avatar = user.user_metadata?.avatar_url;
    const initials = name.slice(0, 2).toUpperCase();
    const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

    return (
        <div ref={ref} style={{ position: "relative" }}>
            <button
                onClick={() => setOpen(o => !o)}
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 20,
                    padding: "4px 10px 4px 4px",
                    cursor: "pointer",
                    fontSize: 13,
                    color: "var(--text)",
                    transition: "border-color 0.15s",
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--accent)")}
                onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--border)")}
            >
                {/* Avatar */}
                {avatar ? (
                    <img
                        src={avatar}
                        alt={name}
                        style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover" }}
                    />
                ) : (
                    <div
                        style={{
                            width: 24, height: 24, borderRadius: "50%",
                            background: `hsl(${hue},60%,45%)`,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 10, fontWeight: 700, color: "white",
                        }}
                    >
                        {initials}
                    </div>
                )}
                <span style={{ maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {name}
                </span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.5 }}>
                    <path d="M7 10l5 5 5-5z" />
                </svg>
            </button>

            {open && (
                <div
                    style={{
                        position: "absolute",
                        right: 0,
                        top: "calc(100% + 6px)",
                        width: 180,
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
                        zIndex: 100,
                        overflow: "hidden",
                    }}
                >
                    <div
                        style={{
                            padding: "10px 14px",
                            borderBottom: "1px solid var(--border)",
                            fontSize: 12,
                            color: "var(--text-muted)",
                        }}
                    >
                        Signed in as<br />
                        <strong style={{ color: "var(--text)", fontSize: 13 }}>{user.email}</strong>
                    </div>
                    <button
                        onClick={async () => { setOpen(false); await signOut(); router.push("/login"); }}
                        style={{
                            width: "100%",
                            padding: "10px 14px",
                            textAlign: "left",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            fontSize: 13,
                            color: "var(--text)",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "none")}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
                        </svg>
                        Sign out
                    </button>
                </div>
            )}
        </div>
    );
}
