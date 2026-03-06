"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, Job } from "@/lib/api";

const OUTPUT_LABELS: Record<string, string> = {
    "rest-api": "API",
    "cli": "CLI",
    "library": "Lib",
    "script": "Script",
    "fullstack": "Full-stack",
};

function StatRow({ label, value, color }: { label: string; value: number | string; color?: string }) {
    return (
        <div className="flex items-center justify-between py-1.5 text-sm border-b border-[var(--border)] last:border-0">
            <span className="text-[var(--text-muted)]">{label}</span>
            <span className="font-bold" style={{ color: color || "var(--text)" }}>{value}</span>
        </div>
    );
}

export function Sidebar() {
    const router = useRouter();
    const [jobs, setJobs] = useState<Job[]>([]);
    const [stats, setStats] = useState({ total: 0, running: 0, complete: 0, plan_ready: 0 });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function load() {
            try {
                const data = await api.listJobs(1, undefined);
                const all = data.jobs;
                setJobs(
                    [...all]
                        .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
                        .slice(0, 5)
                );
                setStats({
                    total: all.length,
                    running: all.filter(j => j.status === "running").length,
                    complete: all.filter(j => j.status === "complete").length,
                    plan_ready: all.filter(j => j.status === "plan_ready").length,
                });
            } catch { }
            setLoading(false);
        }
        load();
    }, []);

    return (
        <aside className="flex flex-col gap-3 w-full">
            {/* Create CTA */}
            <div className="sidebar-widget">
                <div className="sidebar-widget-header">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                        <path d="M12 5v14M5 12h14" />
                    </svg>
                    Start Building
                </div>
                <div className="sidebar-widget-body">
                    <p className="text-sm text-[var(--text-secondary)] mb-3 leading-relaxed">
                        Have a software idea? Submit it and let AI agent teams build it for you.
                    </p>
                    <a href="/create" className="btn btn-primary w-full text-center" style={{ display: "flex" }}>
                        Submit Idea
                    </a>
                </div>
            </div>

            {/* Top Jobs */}
            <div className="sidebar-widget">
                <div className="sidebar-widget-header">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                    Trending
                </div>
                <div className="sidebar-widget-body" style={{ padding: "8px 12px" }}>
                    {loading ? (
                        <div className="text-[var(--text-muted)] text-sm py-4 text-center">Loading…</div>
                    ) : jobs.length === 0 ? (
                        <div className="text-[var(--text-muted)] text-sm py-2">No jobs yet</div>
                    ) : (
                        jobs.map((job, i) => (
                            <div
                                key={job.id}
                                className="top-job-item"
                                onClick={() => router.push(`/job/${job.id}`)}
                            >
                                <span className="top-job-rank">#{i + 1}</span>
                                <div>
                                    <div className="top-job-title">{job.title}</div>
                                    <div className="top-job-votes flex items-center gap-2">
                                        <span>▲ {job.vote_count ?? 0}</span>
                                        <span>·</span>
                                        <span className="text-[var(--text-muted)]">{OUTPUT_LABELS[job.output_type] ?? job.output_type}</span>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>

            {/* Stats */}
            <div className="sidebar-widget">
                <div className="sidebar-widget-header">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
                        <path d="M18 20V10M12 20V4M6 20v-6" />
                    </svg>
                    Platform Stats
                </div>
                <div className="sidebar-widget-body" style={{ padding: "8px 12px" }}>
                    <StatRow label="Total Jobs" value={stats.total} />
                    <StatRow label="Running Now" value={stats.running} color="var(--orange)" />
                    <StatRow label="Plan Ready" value={stats.plan_ready} color="var(--accent-hover)" />
                    <StatRow label="Completed" value={stats.complete} color="var(--green)" />
                </div>
            </div>

            {/* Footer */}
            <div className="text-[var(--text-muted)] text-xs px-1 leading-relaxed">
                SwarmBuild — AI agent teams build your ideas.
            </div>
        </aside>
    );
}
