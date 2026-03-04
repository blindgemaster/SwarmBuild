"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, Job, JobListResponse } from "@/lib/api";

const STATUS_ORDER = ["running", "approved", "plan_ready", "pending", "complete", "failed", "cancelled"];

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

  if (!isMounted) {
    return (
      <div className="text-center text-[var(--text-muted)] py-12" suppressHydrationWarning>
        Loading view...
      </div>
    );
  }

  return (
    <div suppressHydrationWarning>
      {/* Header */}
      <div className="flex items-center justify-between mb-6" suppressHydrationWarning>
        <div>
          <h1 className="text-2xl font-bold">Job Board</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            {data ? `${data.total} jobs` : "Loading..."}
          </p>
        </div>
        <Link href="/create" className="btn btn-primary">
          + Submit Idea
        </Link>
      </div>

      {/* Filter Pills */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {["", "pending", "plan_ready", "approved", "running", "complete"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`btn btn-sm ${filter === s
              ? "btn-primary"
              : "btn-outline"
              }`}
          >
            {s || "All"}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="card border-[var(--red)] text-[var(--red)] mb-4">
          {error}
          <button onClick={loadJobs} className="btn btn-sm btn-outline ml-4">
            Retry
          </button>
        </div>
      )}

      {/* Jobs List */}
      {loading ? (
        <div className="text-center text-[var(--text-muted)] py-12">Loading jobs...</div>
      ) : data?.jobs.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-[var(--text-muted)] mb-4">No jobs yet.</p>
          <Link href="/create" className="btn btn-primary">
            Submit the first idea
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {data?.jobs
            .sort((a, b) => {
              const ai = STATUS_ORDER.indexOf(a.status);
              const bi = STATUS_ORDER.indexOf(b.status);
              if (ai !== bi) return ai - bi;
              return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            })
            .map((job) => (
              <Link key={job.id} href={`/job/${job.id}`}>
                <div className="card cursor-pointer transition-all hover:border-[var(--accent)]">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold truncate">{job.title}</h3>
                        <span className={`badge badge-${job.status}`}>
                          {job.status.replace("_", " ")}
                        </span>
                      </div>
                      <p className="text-sm text-[var(--text-muted)] line-clamp-2">
                        {job.description}
                      </p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-[var(--text-muted)]">
                        <span>{job.output_type}</span>
                        {job.tech_stack?.length > 0 && (
                          <span>{job.tech_stack.join(", ")}</span>
                        )}
                        <span>{timeAgo(job.created_at)}</span>
                        {job.votes && job.votes.length > 0 && (
                          <span>▲ {job.votes[0].count}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}
