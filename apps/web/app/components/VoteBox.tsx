"use client";

import { useState } from "react";
import { api } from "@/lib/api";

export function VoteBox({
    jobId,
    initialCount,
    vertical = true,
}: {
    jobId: string;
    initialCount: number;
    vertical?: boolean;
}) {
    const [count, setCount] = useState(initialCount);
    const [voted, setVoted] = useState<"up" | null>(null);
    const [loading, setLoading] = useState(false);

    async function handleVote(e: React.MouseEvent) {
        e.stopPropagation();
        e.preventDefault();
        if (loading) return;
        setLoading(true);
        try {
            await api.toggleVote(jobId);
            if (voted === "up") {
                setVoted(null);
                setCount((c) => c - 1);
            } else {
                setVoted("up");
                setCount((c) => c + 1);
            }
        } catch { }
        setLoading(false);
    }

    if (vertical) {
        return (
            <div className="job-card-vote">
                <button
                    className={`vote-btn ${voted === "up" ? "voted-up" : ""}`}
                    onClick={handleVote}
                    title="Upvote"
                >
                    {/* Up arrow SVG */}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 4l9 9h-6v7H9v-7H3z" />
                    </svg>
                </button>
                <span className={`vote-count ${voted === "up" ? "voted-up" : ""}`}>
                    {count >= 1000 ? (count / 1000).toFixed(1) + "k" : count}
                </span>
                {/* Down arrow (visual only — SwarmBuild has toggle vote API) */}
                <button className="vote-btn" title="Downvote" onClick={(e) => e.preventDefault()}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 20l-9-9h6V4h6v7h6z" />
                    </svg>
                </button>
            </div>
        );
    }

    // Horizontal inline variant for detail sidebar
    return (
        <div className="flex items-center gap-2">
            <button
                className={`vote-btn ${voted === "up" ? "voted-up" : ""}`}
                onClick={handleVote}
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 4l9 9h-6v7H9v-7H3z" />
                </svg>
            </button>
            <span className={`text-lg font-bold ${voted === "up" ? "text-[var(--vote-up)]" : "text-[var(--text-muted)]"}`}>
                {count}
            </span>
            <span className="text-xs text-[var(--text-muted)]">votes</span>
        </div>
    );
}
