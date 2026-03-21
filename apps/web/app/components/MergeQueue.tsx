"use client";

import { useEffect, useState } from "react";

interface MergeItem {
    id: string;
    branch_name: string;
    position: number;
    status: string;
    conflict_tier: number | null;
    conflict_files: string[] | null;
    resolution_by: string | null;
    conflict_diff: string | null;
    created_at: string;
    completed_at: string | null;
    files_changed: number;
    lines_added: number;
    lines_removed: number;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
    pending: { bg: "bg-yellow-500/10", text: "text-yellow-500", label: "Pending" },
    processing: { bg: "bg-blue-500/10", text: "text-blue-500", label: "Processing" },
    merged: { bg: "bg-green-500/10", text: "text-[var(--green)]", label: "Merged" },
    conflict: { bg: "bg-red-500/10", text: "text-[var(--red)]", label: "Conflict" },
    failed: { bg: "bg-red-500/10", text: "text-[var(--red)]", label: "Failed" },
    cancelled: { bg: "bg-gray-500/10", text: "text-[var(--text-muted)]", label: "Cancelled" },
    retry_pending: { bg: "bg-orange-500/10", text: "text-orange-500", label: "Retrying..." },
};

export function MergeQueue({ jobId, apiUrl }: { jobId: string; apiUrl: string }) {
    const [queue, setQueue] = useState<MergeItem[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchQueue = async () => {
            try {
                const res = await fetch(`${apiUrl}/api/${jobId}/merge/queue`);
                if (res.ok) {
                    const data = await res.json();
                    setQueue(data.queue || []);
                }
            } catch { /* ignore */ }
            setLoading(false);
        };
        fetchQueue();
        const interval = setInterval(fetchQueue, 10000);
        return () => clearInterval(interval);
    }, [jobId, apiUrl]);

    if (loading) return <div className="text-[var(--text-muted)] text-sm p-4">Loading merge queue...</div>;

    if (queue.length === 0) {
        return (
            <div className="text-center py-8 text-[var(--text-muted)] text-sm">
                Merge queue is empty.
            </div>
        );
    }

    return (
        <div className="animate-fade-in space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">
                Merge Queue ({queue.length})
            </h3>
            {queue.map((item) => {
                const style = STATUS_STYLES[item.status] || STATUS_STYLES.pending;
                return (
                    <div
                        key={item.id}
                        className="bg-[var(--surface)] rounded-lg border border-[var(--border)] p-3 flex items-center gap-3"
                    >
                        <div className="text-xs font-bold text-[var(--text-muted)] w-6 text-center">
                            #{item.position}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-[var(--text)] truncate">
                                {item.branch_name}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                                {item.files_changed > 0 && (
                                    <span className="text-[10px] text-[var(--text-muted)]">
                                        {item.files_changed} files
                                        {item.lines_added > 0 && <span className="text-[var(--green)]"> +{item.lines_added}</span>}
                                        {item.lines_removed > 0 && <span className="text-[var(--red)]"> -{item.lines_removed}</span>}
                                    </span>
                                )}
                                {item.conflict_tier !== null && (
                                    <span className="text-[10px] text-[var(--text-muted)]">
                                        Tier {item.conflict_tier}
                                    </span>
                                )}
                                {item.resolution_by && (
                                    <span className="text-[10px] text-[var(--text-muted)]">
                                        by {item.resolution_by}
                                    </span>
                                )}
                                {item.status === "retry_pending" && item.conflict_diff && (() => {
                                    try {
                                        const info = JSON.parse(item.conflict_diff);
                                        return (
                                            <span className="text-[10px] text-orange-500">
                                                attempt {info.retry_count}/3
                                            </span>
                                        );
                                    } catch {
                                        return null;
                                    }
                                })()}
                            </div>
                        </div>
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
                            {style.label}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
