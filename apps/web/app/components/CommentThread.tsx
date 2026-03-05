"use client";

import { Comment } from "@/lib/api";
import { useState } from "react";

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

export function CommentThread({
    comments,
    onPost,
    posting,
}: {
    comments: Comment[];
    onPost: (content: string) => void;
    posting: boolean;
}) {
    const [newComment, setNewComment] = useState("");

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!newComment.trim()) return;
        onPost(newComment.trim());
        setNewComment("");
    }

    return (
        <div className="animate-fade-in">
            <div className="section-title">Discussion ({comments.length})</div>

            {/* Comment Form */}
            <form onSubmit={handleSubmit} className="mb-5">
                <div className="flex gap-2">
                    <input
                        className="input flex-1"
                        value={newComment}
                        onChange={(e) => setNewComment(e.target.value)}
                        placeholder="Add a comment..."
                    />
                    <button
                        type="submit"
                        disabled={posting || !newComment.trim()}
                        className="btn btn-primary btn-sm"
                    >
                        {posting ? "..." : "Post"}
                    </button>
                </div>
            </form>

            {/* Comments List */}
            {comments.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">No comments yet.</p>
            ) : (
                <div className="flex flex-col gap-4">
                    {comments.map((c) => (
                        <div key={c.id} className="flex gap-3">
                            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500/30 to-purple-600/30 flex items-center justify-center text-xs shrink-0 font-medium">
                                {c.profile?.username?.[0]?.toUpperCase() || "?"}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                                    <span className="font-medium text-[var(--text)]">
                                        {c.profile?.display_name || c.profile?.username || "Anonymous"}
                                    </span>
                                    <span>{timeAgo(c.created_at)}</span>
                                </div>
                                <p className="text-sm mt-0.5 text-[var(--text-secondary)]">{c.content}</p>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
