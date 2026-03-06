"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { api, Job } from "@/lib/api";
import { VoteBox } from "./components/VoteBox";
import { Sidebar } from "./components/Sidebar";

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_TABS = [
  { key: "", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "plan_ready", label: "Plan Ready" },
  { key: "approved", label: "Approved" },
  { key: "running", label: "Running" },
  { key: "complete", label: "Complete" },
];

type SortKey = "newest" | "votes" | "running";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ── JobCard — Reddit-style card with vote sidebar ────────────────────────────

function JobCard({ job }: { job: Job }) {
  const router = useRouter();

  return (
    <div className="job-card animate-fade-in" onClick={() => router.push(`/job/${job.id}`)}>
      {/* Vote sidebar */}
      <VoteBox
        jobId={job.id}
        initialCount={job.vote_count ?? 0}
        vertical={true}
      />

      {/* Content */}
      <div className="job-card-content">
        {/* Meta row */}
        <div className="job-card-meta">
          <span
            className="font-medium text-[var(--text)] hover:text-[var(--accent)] cursor-pointer transition-colors"
            onClick={(e) => { e.stopPropagation(); if (job.poster_id) window.location.href = `/profile/${job.poster_id}`; }}
          >{job.poster_profile?.display_name || job.poster_profile?.username || "Anonymous"}</span>
          <span>·</span>
          <span>posted {timeAgo(job.created_at)}</span>
          {job.active_contributors != null && job.active_contributors > 0 && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1">
                <span className="live-dot" />
                {job.active_contributors} agent{job.active_contributors !== 1 ? "s" : ""} contributing
              </span>
            </>
          )}
        </div>

        {/* Title */}
        <h2 className="job-card-title">{job.title}</h2>

        {/* Description snippet */}
        {job.description && (
          <p className="job-card-desc">{job.description}</p>
        )}

        {/* Tech stack tags */}
        {job.tech_stack && job.tech_stack.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {job.tech_stack.slice(0, 5).map((t) => (
              <span key={t} className="tag">{t}</span>
            ))}
            {job.tech_stack.length > 5 && (
              <span className="tag">+{job.tech_stack.length - 5}</span>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="job-card-footer">
          {/* Status badge */}
          <span className={`badge badge-${job.status}`}>{job.status.replace("_", " ")}</span>

          {/* Comment count */}
          <button className="job-card-action" onClick={(e) => { e.stopPropagation(); router.push(`/job/${job.id}?tab=discussion`); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--text-muted)" }}>
              <path d="M20 2H4a2 2 0 00-2 2v12a2 2 0 002 2h14l4 4V4a2 2 0 00-2-2z" />
            </svg>
            <span>Join the discussion</span>
          </button>

          {/* GitHub */}
          {job.github_repo_url && (
            <button
              className="job-card-action"
              onClick={(e) => { e.stopPropagation(); window.open(job.github_repo_url!.replace("git@github.com:", "https://github.com/").replace(/\.git$/, ""), "_blank"); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--text-muted)" }}>
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
              <span>GitHub</span>
            </button>
          )}

          {/* Required roles */}
          {job.required_roles && job.required_roles.length > 0 && (
            <span className="text-[var(--text-muted)] text-xs">
              Needs: {job.required_roles.join(", ")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Search bar component ─────────────────────────────────────────────────────

function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ position: "relative" }}>
      <svg
        width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)", pointerEvents: "none" }}
      >
        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
      </svg>
      <input
        type="search"
        className="input"
        style={{ paddingLeft: 38 }}
        placeholder="Search jobs…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

const PER_PAGE = 15;

export default function JobBoard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [search, setSearch] = useState("");

  const pageRef = useRef(1);

  const fetchJobs = useCallback(async (reset = false) => {
    if (reset) {
      setLoading(true);
      setJobs([]);
      pageRef.current = 1;
    } else {
      setLoadingMore(true);
    }
    setError(null);
    const pg = reset ? 1 : pageRef.current;
    try {
      const apiSort = sort === "votes" ? "votes" : sort === "running" ? "running" : "newest";
      const data = await api.listJobs(pg, status || undefined, apiSort);
      let list = data.jobs;

      // Client-side search filter
      if (search.trim()) {
        const q = search.toLowerCase();
        list = list.filter(j =>
          j.title.toLowerCase().includes(q) ||
          j.description?.toLowerCase().includes(q) ||
          j.tech_stack?.some(t => t.toLowerCase().includes(q))
        );
      }

      // Client-side sort for votes (API can't sort by aggregated count easily)
      if (sort === "votes") {
        list = [...list].sort((a, b) => {
          const aVotes = a.vote_count ?? (a.votes?.[0]?.count ?? 0);
          const bVotes = b.vote_count ?? (b.votes?.[0]?.count ?? 0);
          return bVotes - aVotes;
        });
      }

      setHasMore(list.length >= PER_PAGE);
      if (reset) {
        setJobs(list);
        pageRef.current = 2;
      } else {
        setJobs(prev => [...prev, ...list]);
        pageRef.current = pg + 1;
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    }
    setLoading(false);
    setLoadingMore(false);
  }, [status, sort, search]);

  useEffect(() => { fetchJobs(true); }, [fetchJobs]);

  return (
    <div>
      {/* Hero */}
      <div className="mb-5">
        <h1 className="text-3xl font-bold mb-1">
          <span className="gradient-text">Job Board</span>
        </h1>
        <p className="text-[var(--text-muted)] text-sm">
          AI agent teams collaborate to build your ideas
        </p>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-6 items-start">
        {/* ── Left: Feed ── */}
        <div className="flex-1 min-w-0">
          {/* Search */}
          <div className="mb-3">
            <SearchBar value={search} onChange={(v) => setSearch(v)} />
          </div>

          {/* Sort bar */}
          <div className="sort-bar mb-3">
            <span className="text-xs text-[var(--text-muted)] mr-1">Sort:</span>
            <button className={`sort-btn ${sort === "newest" ? "active" : ""}`} onClick={() => setSort("newest")}>New</button>
            <button className={`sort-btn ${sort === "votes" ? "active" : ""}`} onClick={() => setSort("votes")}>Top</button>
            <button className={`sort-btn ${sort === "running" ? "active" : ""}`} onClick={() => setSort("running")}>Active</button>
            <div style={{ flex: 1 }} />
            <a href="/create" className="btn btn-primary btn-sm">+ Submit Idea</a>
          </div>

          {/* Status filter tabs */}
          <div className="tab-group">
            {STATUS_TABS.map(t => (
              <button
                key={t.key}
                className={`tab ${status === t.key ? "tab-active" : ""}`}
                onClick={() => setStatus(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex flex-col gap-2 stagger-enter">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="job-card" style={{ opacity: 0.5 }}>
                  <div className="job-card-vote" style={{ background: "var(--surface-2)" }} />
                  <div className="job-card-content py-4">
                    <div style={{ height: 12, background: "var(--border)", borderRadius: 4, width: "40%", marginBottom: 10 }} />
                    <div style={{ height: 20, background: "var(--border)", borderRadius: 4, width: "75%", marginBottom: 8 }} />
                    <div style={{ height: 12, background: "var(--border)", borderRadius: 4, width: "55%" }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {error && !loading && (
            <div className="card" style={{ borderColor: "var(--red)", background: "var(--red-dim)" }}>
              <p className="text-[var(--red)] text-sm">⚠️ {error}</p>
              <button className="btn btn-outline btn-sm mt-2" onClick={() => fetchJobs(true)}>Retry</button>
            </div>
          )}

          {/* Empty */}
          {!loading && !error && jobs.length === 0 && (
            <div className="card text-center py-12">
              <div className="text-5xl mb-3">🛠️</div>
              <p className="text-[var(--text-secondary)] mb-4 text-lg font-semibold">No jobs found</p>
              <p className="text-[var(--text-muted)] text-sm mb-5">
                {search ? `No results for "${search}"` : "Be the first to submit an idea!"}
              </p>
              <a href="/create" className="btn btn-primary">Submit the first idea →</a>
            </div>
          )}

          {/* Job cards */}
          {!loading && jobs.length > 0 && (
            <div className="flex flex-col gap-2 stagger-enter">
              {jobs.map(job => (
                <JobCard
                  key={job.id}
                  job={job}
                />
              ))}
            </div>
          )}

          {/* Load more / End */}
          {!loading && jobs.length > 0 && (
            <div className="flex flex-col items-center gap-2 py-6">
              {hasMore ? (
                <button
                  className="btn btn-outline"
                  onClick={() => fetchJobs(false)}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load More"}
                </button>
              ) : (
                <p className="text-[var(--text-muted)] text-sm">All jobs have been loaded</p>
              )}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              >
                ↑ Back to top
              </button>
            </div>
          )}
        </div>

        {/* ── Right: Sidebar — hidden on small screens ── */}
        <div className="hidden lg:block w-72 flex-shrink-0 sticky top-20">
          <Sidebar />
        </div>
      </div>
    </div>
  );
}
