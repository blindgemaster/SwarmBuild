"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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
    const [busy, setBusy] = useState(false);
    const mountedRef = useRef(true);
    const initializedRef = useRef(false);

    // Sync count when parent re-renders with fresh data, but only if we haven't
    // fetched our own authoritative count yet
    useEffect(() => {
        if (!initializedRef.current) {
            setCount(initialCount);
        }
    }, [initialCount]);

    // Fetch authoritative vote status + count once on mount
    useEffect(() => {
        mountedRef.current = true;
        let cancelled = false;
        api.getVoteStatus(jobId)
            .then(res => {
                if (!cancelled && mountedRef.current) {
                    setVoted(res.voted);
                    if (typeof res.vote_count === "number") {
                        setCount(res.vote_count);
                    }
                    initializedRef.current = true;
                }
            })
            .catch(() => {});
        return () => { cancelled = true; mountedRef.current = false; };
    }, [jobId]);

    const handleUpvote = useCallback(async (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        // Optimistic update
        const wasVoted = voted;
        const prevCount = count;
        setVoted(!wasVoted);
        setCount(wasVoted ? Math.max(0, prevCount - 1) : prevCount + 1);
        try {
            const res = await api.toggleVote(jobId);
            if (mountedRef.current) {
                setVoted(res.voted);
                setCount(res.vote_count);
            }
        } catch {
            // Revert on error
            if (mountedRef.current) {
                setVoted(wasVoted);
                setCount(prevCount);
            }
        }
        if (mountedRef.current) setBusy(false);
    }, [busy, voted, count, jobId]);

    const formattedCount = count >= 1000 ? (count / 1000).toFixed(1) + "k" : String(count);

    if (vertical) {
        return (
            <div className="job-card-vote" onClick={e => e.stopPropagation()}>
                <button
                    className={`vote-btn ${voted ? "voted-up" : ""}`}
                    onClick={handleUpvote}
                    title={voted ? "Remove vote" : "Upvote"}
                    disabled={busy}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 4l9 9h-6v7H9v-7H3z" />
                    </svg>
                </button>
                <span className={`vote-count ${voted ? "voted-up" : ""}`}>
                    {formattedCount}
                </span>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
            <button
                className={`vote-btn ${voted ? "voted-up" : ""}`}
                onClick={handleUpvote}
                title={voted ? "Remove vote" : "Upvote"}
                disabled={busy}
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 4l9 9h-6v7H9v-7H3z" />
                </svg>
            </button>
            <span className={`text-lg font-bold ${voted ? "text-[var(--vote-up)]" : "text-[var(--text-muted)]"}`}>
                {formattedCount}
            </span>
            <span className="text-xs text-[var(--text-muted)]">votes</span>
        </div>
    );
}
