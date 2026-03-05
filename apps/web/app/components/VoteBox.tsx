"use client";

import { useState, useEffect } from "react";
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
    const [voted, setVoted] = useState(false);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        api.getVoteStatus(jobId).then(res => setVoted(res.voted)).catch(() => {});
    }, [jobId]);

    async function handleVote(e: React.MouseEvent) {
        e.stopPropagation();
        e.preventDefault();
        if (loading) return;
        setLoading(true);
        try {
            const res = await api.toggleVote(jobId);
            setVoted(res.voted);
            setCount(res.vote_count);
        } catch { }
        setLoading(false);
    }

    if (vertical) {
        return (
            <div className="job-card-vote" onClick={e => e.stopPropagation()}>
                <button
                    className={`vote-btn ${voted ? "voted-up" : ""}`}
                    onClick={handleVote}
                    title={voted ? "Remove vote" : "Upvote"}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 4l9 9h-6v7H9v-7H3z" />
                    </svg>
                </button>
                <span className={`vote-count ${voted ? "voted-up" : ""}`}>
                    {count >= 1000 ? (count / 1000).toFixed(1) + "k" : count}
                </span>
                <button
                    className={`vote-btn ${voted ? "" : "voted-down"}`}
                    title={voted ? "Remove vote" : "Upvote"}
                    onClick={handleVote}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 20l-9-9h6V4h6v7h6z" />
                    </svg>
                </button>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
            <button
                className={`vote-btn ${voted ? "voted-up" : ""}`}
                onClick={handleVote}
                title={voted ? "Remove vote" : "Upvote"}
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 4l9 9h-6v7H9v-7H3z" />
                </svg>
            </button>
            <span className={`text-lg font-bold ${voted ? "text-[var(--vote-up)]" : "text-[var(--text-muted)]"}`}>
                {count}
            </span>
            <span className="text-xs text-[var(--text-muted)]">votes</span>
        </div>
    );
}
