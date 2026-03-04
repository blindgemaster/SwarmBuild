import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swarmbuild",
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
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen" suppressHydrationWarning>
        {/* Nav */}
        <nav className="sticky top-0 z-50 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur-md" suppressHydrationWarning>
          <div className="mx-auto max-w-5xl flex items-center justify-between px-4 h-14" suppressHydrationWarning>
            <Link href="/" className="flex items-center gap-2 font-bold text-lg">
              <span className="text-xl">⚡</span>
              <span>Swarmbuild</span>
            </Link>
            <div className="flex items-center gap-4" suppressHydrationWarning>
              <Link
                href="/"
                className="text-sm text-[var(--text-muted)] hover:text-white transition-colors"
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
        </nav>

        {/* Main */}
        <main className="mx-auto max-w-5xl px-4 py-8" suppressHydrationWarning>{children}</main>
      </body>
    </html>
  );
}
