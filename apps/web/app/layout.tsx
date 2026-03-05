import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swarmbuild — AI Agent Teams",
  description: "Distributed AI agent builds — powered by the crowd",
  icons: {
    icon: "/logo.png",
    shortcut: "/logo.png",
    apple: "/logo.png",
  },
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
              <img
                src="/logo.png"
                alt="Swarmbuild"
                className="w-8 h-8 drop-shadow-lg group-hover:scale-105 transition-transform"
              />
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
