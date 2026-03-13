"use client";

import { useEffect, useState } from "react";

interface CostData {
    job_id: string;
    title: string;
    budget_cap: number | null;
    budget_used: number;
    budget_pct: number | null;
    estimated_cost_usd: number;
    contributors: {
        role: string;
        tokens_used: number;
        sessions: number;
        tasks_done: number;
        commits: number;
        cost_usd: number;
    }[];
    tasks: {
        task_id: string;
        title: string;
        status: string;
        tokens_used: number;
        attempts: number;
    }[];
}

export function CostDashboard({ jobId, apiUrl }: { jobId: string; apiUrl: string }) {
    const [data, setData] = useState<CostData | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchCosts = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/jobs/${jobId}/costs`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                setData(await res.json());
            } catch (e: unknown) {
                setError(e instanceof Error ? e.message : String(e));
            }
        };
        fetchCosts();
        const interval = setInterval(fetchCosts, 30000);
        return () => clearInterval(interval);
    }, [jobId, apiUrl]);

    if (error) return <div className="text-[var(--red)] text-sm p-4">Failed to load costs: {error}</div>;
    if (!data) return <div className="text-[var(--text-muted)] text-sm p-4">Loading cost data...</div>;

    const pct = data.budget_pct ?? 0;
    const barColor = pct >= 90 ? "var(--red)" : pct >= 80 ? "var(--orange)" : "var(--green)";

    return (
        <div className="animate-fade-in space-y-4">
            {/* Budget bar */}
            {data.budget_cap && (
                <div className="bg-[var(--surface)] rounded-xl border border-[var(--border)] p-4">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                            Budget
                        </span>
                        <span className="text-xs font-medium text-[var(--text-muted)]">
                            {data.budget_used.toLocaleString()} / {data.budget_cap.toLocaleString()} tokens ({pct}%)
                        </span>
                    </div>
                    <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${Math.min(pct, 100)}%`, background: barColor }} />
                    </div>
                    <div className="text-right mt-1 text-xs text-[var(--text-muted)]">
                        ~${data.estimated_cost_usd.toFixed(2)} USD
                    </div>
                </div>
            )}

            {/* Per-agent breakdown */}
            <div className="bg-[var(--surface)] rounded-xl border border-[var(--border)] p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">
                    Per-Agent Breakdown
                </h3>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-[var(--text-muted)] text-xs uppercase">
                                <th className="text-left pb-2">Agent</th>
                                <th className="text-right pb-2">Tokens</th>
                                <th className="text-right pb-2">Tasks</th>
                                <th className="text-right pb-2">Sessions</th>
                                <th className="text-right pb-2">Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.contributors.map((c, i) => (
                                <tr key={i} className="border-t border-[var(--border)]">
                                    <td className="py-2 capitalize font-medium text-[var(--text)]">{c.role}</td>
                                    <td className="py-2 text-right text-[var(--text-muted)]">{c.tokens_used.toLocaleString()}</td>
                                    <td className="py-2 text-right text-[var(--text-muted)]">{c.tasks_done}</td>
                                    <td className="py-2 text-right text-[var(--text-muted)]">{c.sessions}</td>
                                    <td className="py-2 text-right text-[var(--text)]">${c.cost_usd.toFixed(4)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Per-task breakdown */}
            {data.tasks.length > 0 && (
                <div className="bg-[var(--surface)] rounded-xl border border-[var(--border)] p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">
                        Per-Task Token Usage
                    </h3>
                    <div className="space-y-2">
                        {data.tasks.map((t) => (
                            <div key={t.task_id} className="flex items-center justify-between text-sm">
                                <div className="flex items-center gap-2">
                                    <span className={`w-2 h-2 rounded-full ${t.status === "completed" ? "bg-[var(--green)]" : t.status === "locked" ? "bg-[var(--orange)]" : "bg-[var(--text-muted)]"}`} />
                                    <span className="text-[var(--text)] truncate max-w-[200px]">{t.title}</span>
                                </div>
                                <span className="text-[var(--text-muted)] text-xs">{t.tokens_used.toLocaleString()} tokens</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
