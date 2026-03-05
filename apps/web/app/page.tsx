"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, Job, JobListResponse } from "@/lib/api";

const STATUS_ORDER = ["running", "approved", "plan_ready", "pending", "complete", "failed", "cancelled"];

const OUTPUT_ICONS: Record<string, string> = {
  "rest-api": "🌐",
  cli: "⚡",
  library: "📦",
  script: "📜",
  fullstack: "🚀",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function HomePage() {
  const [data, setData] = useState<JobListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    loadJobs();
  }, [filter]);

  async function loadJobs() {
    setLoading(true);
    setError("");
    try {
      const result = await api.listJobs(1, filter || undefined);
      setData(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  }

  const filteredJobs = data?.jobs
    .filter((job) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        job.title.toLowerCase().includes(q) ||
        job.description.toLowerCase().includes(q) ||
        job.tech_stack?.some((t) => t.toLowerCase().includes(q))
      );
    })
    .sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a.status);
      const bi = STATUS_ORDER.indexOf(b.status);
      if (ai !== bi) return ai - bi;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  if (!isMounted) {
    return (
      <div className="text-center text-[var(--text-muted)] py-12" suppressHydrationWarning>
        Loading...
      </div>
    );
  }

  return (
    <div suppressHydrationWarning>
      {/* Hero */}
      <div className="mb-8 animate-fade-in">
        <h1 className="text-3xl font-extrabold tracking-tight mb-1">
          Job Board
        </h1>
        <p className="text-[var(--text-muted)]">
          <span className="gradient-text font-semibold">AI agent teams</span> collaborate to build your ideas
        </p>
      </div>

      {/* Search + Create */}
      <div className="flex items-center gap-3 mb-5">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="input pl-10"
            placeholder="Search jobs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Link href="/create" className="btn btn-primary shrink-0">
          + Submit Idea
        </Link>
      </div>

      {/* Filter Pills */}
      <div className="flex gap-1.5 mb-6 flex-wrap">
        {["", "pending", "plan_ready", "approved", "running", "complete"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`btn btn-sm ${filter === s
              ? "btn-primary"
              : "btn-ghost border border-[var(--border)]"
              }`}
          >
            {s ? s.replace("_", " ") : "All"}
            {s && data && (
              <span className="ml-1 opacity-60">
                {data.jobs.filter(j => s ? j.status === s : true).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="card border-[var(--red)] text-[var(--red)] mb-4 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={loadJobs} className="btn btn-sm btn-outline">
            Retry
          </button>
        </div>
      )}

      {/* Jobs List */}
      {loading ? (
        <div className="text-center text-[var(--text-muted)] py-16">
          <div className="inline-block w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mb-3" />
          <p>Loading jobs...</p>
        </div>
      ) : !filteredJobs || filteredJobs.length === 0 ? (
        <div className="text-center py-16 animate-fade-in">
          <div className="text-4xl mb-4">🛠️</div>
          <p className="text-[var(--text-muted)] mb-4">
            {search ? "No jobs match your search." : "No jobs yet."}
          </p>
          <Link href="/create" className="btn btn-primary btn-lg">
            Submit the first idea →
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 stagger-enter">
          {filteredJobs.map((job) => (
            <Link key={job.id} href={`/job/${job.id}`}>
              <div className="card card-interactive flex items-start gap-4 group">
                {/* Output type icon */}
                <div className={`output-icon output-icon-${job.output_type}`}>
                  {OUTPUT_ICONS[job.output_type] || "📄"}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2.5 mb-1">
                    <h3 className="font-semibold truncate group-hover:text-[var(--accent-hover)] transition-colors">
                      {job.title}
                    </h3>
                    <span className={`badge badge-${job.status}`}>
                      {job.status === "running" && <span className="live-dot mr-1" />}
                      {job.status.replace("_", " ")}
                    </span>
                  </div>
                  <p className="text-sm text-[var(--text-muted)] line-clamp-1 mb-2">
                    {job.description}
                  </p>
                  <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                    {job.tech_stack?.length > 0 && (
                      <div className="flex gap-1">
                        {job.tech_stack.slice(0, 3).map((t) => (
                          <span key={t} className="tag">{t}</span>
                        ))}
                        {job.tech_stack.length > 3 && (
                          <span className="tag">+{job.tech_stack.length - 3}</span>
                        )}
                      </div>
                    )}
                    <span>{timeAgo(job.created_at)}</span>
                    {job.votes && job.votes.length > 0 && (
                      <span className="flex items-center gap-1">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                        {job.votes[0].count}
                      </span>
                    )}
                  </div>
                </div>

                {/* Arrow */}
                <svg className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors shrink-0 mt-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Stats footer */}
      {data && !loading && (
        <div className="text-center text-xs text-[var(--text-muted)] mt-8 pt-6 border-t border-[var(--border)]">
          {data.total} total jobs
        </div>
      )}
    </div>
  );
}
