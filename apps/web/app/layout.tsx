import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swarmbuild — AI Agent Teams",
  description: "Distributed AI agent builds — powered by the crowd",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen" suppressHydrationWarning>
        {/* Nav */}
        <nav className="sticky top-0 z-50 border-b border-[var(--border)] bg-[var(--bg)]/90 backdrop-blur-xl" suppressHydrationWarning>
          <div className="mx-auto max-w-6xl flex items-center justify-between px-6 h-14" suppressHydrationWarning>
            <Link href="/" className="flex items-center gap-2.5 group">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20 group-hover:shadow-indigo-500/40 transition-shadow">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              </div>
              <span className="font-bold text-base tracking-tight">Swarmbuild</span>
            </Link>
            <div className="flex items-center gap-1" suppressHydrationWarning>
              <Link
                href="/"
                className="btn btn-ghost text-sm"
              >
                Jobs
              </Link>
              <Link
                href="/create"
                className="btn btn-primary btn-sm"
              >
                + New Job
              </Link>
            </div>
          </div>
          {/* Gradient line */}
          <div className="h-px bg-gradient-to-r from-transparent via-indigo-500/40 to-transparent" />
        </nav>

        {/* Main */}
        <main className="mx-auto max-w-6xl px-6 py-8" suppressHydrationWarning>{children}</main>
      </body>
    </html>
  );
}
