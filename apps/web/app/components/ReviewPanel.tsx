"use client";

import { useEffect, useState } from "react";

interface PendingTask {
    id: string;
    title: string;
    status: string;
    verification_status: string;
    verification_tier: number | null;
    verification_log: Array<{
        tier: number;
        decision: string;
        comments: string;
        timestamp: string;
    }>;
    assigned_role: string;
    locked_by_token: string | null;
}

export function ReviewPanel({ jobId, apiUrl }: { jobId: string; apiUrl: string }) {
    const [tasks, setTasks] = useState<PendingTask[]>([]);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState<string | null>(null);
    const [comments, setComments] = useState<Record<string, string>>({});

    useEffect(() => {
        const fetchPending = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/jobs/${jobId}/tasks/pending-review`);
                if (res.ok) {
                    const data = await res.json();
                    setTasks(data.tasks || []);
                }
            } catch { /* ignore */ }
            setLoading(false);
        };
        fetchPending();
        const interval = setInterval(fetchPending, 15000);
        return () => clearInterval(interval);
    }, [jobId, apiUrl]);

    async function submitReview(taskId: string, decision: "approve" | "reject") {
        setSubmitting(taskId);
        try {
            const res = await fetch(`${apiUrl}/api/jobs/${jobId}/tasks/${taskId}/review`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    decision,
                    comments: comments[taskId] || `${decision === "approve" ? "Approved" : "Rejected"} via web UI`,
                }),
            });
            if (res.ok) {
                setTasks((prev) => prev.filter((t) => t.id !== taskId));
                setComments((prev) => {
                    const next = { ...prev };
                    delete next[taskId];
                    return next;
                });
            }
        } catch { /* ignore */ }
        setSubmitting(null);
    }

    if (loading) {
        return <div className="text-[var(--text-muted)] text-sm p-4">Loading reviews...</div>;
    }

    if (tasks.length === 0) {
        return (
            <div className="text-center py-8 text-[var(--text-muted)] text-sm">
                No tasks pending review.
            </div>
        );
    }

    return (
        <div className="animate-fade-in space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">
                Pending Review ({tasks.length})
            </h3>
            {tasks.map((task) => (
                <div
                    key={task.id}
                    className="bg-[var(--surface)] rounded-xl border border-[var(--border)] p-4 space-y-3"
                >
                    <div className="flex items-start justify-between">
                        <div>
                            <div className="font-medium text-[var(--text)] text-sm">{task.title}</div>
                            <div className="flex items-center gap-2 mt-1">
                                <span className="tag text-[10px] capitalize">{task.assigned_role}</span>
                                <span className="text-[10px] text-[var(--text-muted)]">
                                    {task.verification_status}
                                </span>
                            </div>
                        </div>
                        <span className="text-[10px] font-mono text-[var(--text-muted)]">
                            {task.id.slice(0, 8)}
                        </span>
                    </div>

                    {/* Verification log */}
                    {task.verification_log && task.verification_log.length > 0 && (
                        <div className="text-xs text-[var(--text-muted)] space-y-1 border-t border-[var(--border)] pt-2">
                            {task.verification_log.map((entry, i) => (
                                <div key={i} className="flex items-center gap-1">
                                    <span className={entry.decision === "approve" ? "text-[var(--green)]" : "text-[var(--red)]"}>
                                        {entry.decision === "approve" ? "✓" : "✗"}
                                    </span>
                                    <span>Tier {entry.tier}: {entry.comments}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Review form */}
                    <div className="space-y-2">
                        <textarea
                            className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-2 text-sm text-[var(--text)] placeholder-[var(--text-muted)] resize-none"
                            rows={2}
                            placeholder="Review comments (optional)..."
                            value={comments[task.id] || ""}
                            onChange={(e) => setComments((prev) => ({ ...prev, [task.id]: e.target.value }))}
                        />
                        <div className="flex gap-2">
                            <button
                                className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--green)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
                                onClick={() => submitReview(task.id, "approve")}
                                disabled={submitting === task.id}
                            >
                                {submitting === task.id ? "..." : "Approve"}
                            </button>
                            <button
                                className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--red)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
                                onClick={() => submitReview(task.id, "reject")}
                                disabled={submitting === task.id}
                            >
                                {submitting === task.id ? "..." : "Reject"}
                            </button>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
