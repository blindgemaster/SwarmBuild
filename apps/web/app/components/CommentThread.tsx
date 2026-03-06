"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { api, Comment } from "@/lib/api";
import { useAuth } from "@/app/components/AuthProvider";

// ── Helpers ─────────────────────────────────────────

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

/** Hue-based color per username, like Reddit's distinct thread line colors per depth */
const DEPTH_COLORS = [
    "#ff4500", // orange-red (depth 0)
    "#0dd3bb", // teal
    "#5f99cf", // blue
    "#ff585b", // red
    "#ffd635", // yellow
    "#46d160", // green
    "#fc8451", // orange
    "#cc69b8", // pink
];

function depthColor(depth: number) {
    return DEPTH_COLORS[depth % DEPTH_COLORS.length];
}

function Avatar({ name }: { name: string }) {
    const initials = (name || "?").slice(0, 2).toUpperCase();
    const hue = [...(name || "?")].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
    return (
        <div
            style={{
                width: 20, height: 20, borderRadius: "50%",
                background: `hsl(${hue}, 60%, 45%)`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, fontWeight: 700, color: "white", flexShrink: 0,
            }}
        >
            {initials}
        </div>
    );
}

// ── Recursive Comment Node ───────────────────────────

function CommentNode({
    comment,
    depth,
    jobId,
    onReplyPosted,
}: {
    comment: Comment;
    depth: number;
    jobId: string;
    /** Called with the newly created comment so parent can insert it optimistically */
    onReplyPosted: (newComment: Comment, parentId: string) => void;
}) {
    const [collapsed, setCollapsed] = useState(depth >= 5);
    const [replying, setReplying] = useState(false);
    const [replyText, setReplyText] = useState("");
    const [posting, setPosting] = useState(false);
    // Optimistic replies added locally before next re-fetch
    const [localReplies, setLocalReplies] = useState<Comment[]>([]);

    const author = comment.profile?.display_name || comment.profile?.username || "Anonymous";
    const replies = [...(comment.replies ?? []), ...localReplies];
    const hasReplies = replies.length > 0;

    async function submitReply(e: React.FormEvent) {
        e.preventDefault();
        if (!replyText.trim() || posting) return;
        setPosting(true);
        try {
            const result = await api.addComment(jobId, replyText.trim(), comment.id) as Record<string, unknown>;
            // Optimistically show the new reply without re-fetching
            const optimistic: Comment = {
                id: (result?.id as string) ?? crypto.randomUUID(),
                job_id: jobId,
                user_id: "",
                parent_id: comment.id,
                content: replyText.trim(),
                created_at: new Date().toISOString(),
                profile: { username: "you", display_name: "You", avatar_url: "" },
                replies: [],
            };
            setLocalReplies(prev => [...prev, optimistic]);
            setReplyText("");
            setReplying(false);
            // Bubble up so tree root can track counts etc.
            onReplyPosted(optimistic, comment.id);
        } catch (err) {
            console.error("Failed to post reply", err);
        }
        setPosting(false);
    }

    // A nested reply was posted deeper in the tree — bubble it up
    function handleNestedReply(newComment: Comment, parentId: string) {
        onReplyPosted(newComment, parentId);
    }

    return (
        <div style={{ marginTop: depth === 0 ? 0 : 0 }}>
            {/* ── Comment body ── */}
            <div style={{ display: "flex", gap: 0 }}>
                {/* Left depth gutter with colorful thread line */}
                {depth > 0 && (
                    <div
                        style={{
                            width: 2,
                            background: depthColor(depth - 1),
                            borderRadius: 1,
                            marginRight: 10,
                            flexShrink: 0,
                            opacity: 0.55,
                            cursor: "pointer",
                            transition: "opacity 0.15s",
                        }}
                        title="Collapse thread"
                        onClick={() => setCollapsed(c => !c)}
                        onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
                        onMouseLeave={e => (e.currentTarget.style.opacity = "0.55")}
                    />
                )}

                <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Header row */}
                    <div className="comment-header" style={{ marginBottom: 4 }}>
                        {/* Collapse button */}
                        <button
                            className="comment-collapse-btn"
                            onClick={() => setCollapsed(c => !c)}
                            title={collapsed ? "Expand thread" : "Collapse thread"}
                        >
                            {collapsed ? "+" : "−"}
                        </button>
                        <Avatar name={author} />
                        <span className="comment-author">{author}</span>
                        <span className="comment-timestamp">{timeAgo(comment.created_at)}</span>
                        {collapsed && hasReplies && (
                            <span className="comment-timestamp" style={{ fontStyle: "italic" }}>
                                {replies.length} {replies.length === 1 ? "reply" : "replies"}
                            </span>
                        )}
                    </div>

                    {/* Body + actions (hidden when collapsed) */}
                    {!collapsed && (
                        <>
                            <div className="comment-content">{comment.content}</div>

                            {/* Actions row */}
                            <div className="comment-actions">
                                <button
                                    className="comment-action-btn"
                                    onClick={() => setReplying(r => !r)}
                                >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" />
                                    </svg>
                                    {replying ? "Cancel" : "Reply"}
                                </button>
                                {/* Comment count badge if thread has children */}
                                {hasReplies && (
                                    <span className="comment-action-btn" style={{ cursor: "default" }}>
                                        💬 {replies.length} {replies.length === 1 ? "reply" : "replies"}
                                    </span>
                                )}
                            </div>

                            {/* Inline reply compose */}
                            {replying && (
                                <form
                                    onSubmit={submitReply}
                                    style={{
                                        marginTop: 8,
                                        marginBottom: 8,
                                        background: "var(--surface-2)",
                                        border: "1px solid var(--border)",
                                        borderRadius: 4,
                                        padding: "10px",
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 8,
                                    }}
                                >
                                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                                        Replying to <strong style={{ color: "var(--text)" }}>{author}</strong>
                                    </div>
                                    <textarea
                                        className="input"
                                        style={{ minHeight: 70, fontSize: 13 }}
                                        placeholder={`Reply to ${author}…`}
                                        value={replyText}
                                        onChange={e => setReplyText(e.target.value)}
                                        autoFocus
                                    />
                                    <div className="flex gap-2">
                                        <button
                                            type="submit"
                                            className="btn btn-primary btn-sm"
                                            disabled={posting || !replyText.trim()}
                                        >
                                            {posting ? "Posting…" : "Reply"}
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-sm"
                                            onClick={() => { setReplying(false); setReplyText(""); }}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </form>
                            )}

                            {/* Recursive children */}
                            {replies.length > 0 && (
                                <div style={{ marginTop: 4 }}>
                                    {replies.map(child => (
                                        <CommentNode
                                            key={child.id}
                                            comment={child}
                                            depth={depth + 1}
                                            jobId={jobId}
                                            onReplyPosted={handleNestedReply}
                                        />
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Root CommentThread ───────────────────────────────

function countAll(comments: Comment[]): number {
    return comments.reduce((acc, c) => acc + 1 + countAll(c.replies ?? []), 0);
}

export function CommentThread({
    jobId,
    initialComments,
}: {
    jobId: string;
    initialComments: Comment[];
}) {
    const { user } = useAuth();
    const router = useRouter();

    // Server returns top-level comments with nested `replies` already built
    const [topLevel, setTopLevel] = useState<Comment[]>(initialComments);
    const [totalCount, setTotalCount] = useState(countAll(initialComments));
    const [newText, setNewText] = useState("");
    const [posting, setPosting] = useState(false);
    const justPostedRef = useRef(false);

    // Sync with parent-provided comments (from polling) for real-time updates
    useEffect(() => {
        // Skip the sync right after user posts to avoid overwriting optimistic update
        if (justPostedRef.current) {
            justPostedRef.current = false;
            return;
        }
        setTopLevel(initialComments);
        setTotalCount(countAll(initialComments));
    }, [initialComments]);

    async function submitTopLevel(e: React.FormEvent) {
        e.preventDefault();
        if (!newText.trim() || posting) return;
        setPosting(true);
        try {
            const result = await api.addComment(jobId, newText.trim()) as Record<string, unknown>;
            const optimistic: Comment = {
                id: (result?.id as string) ?? crypto.randomUUID(),
                job_id: jobId,
                user_id: "",
                content: newText.trim(),
                created_at: new Date().toISOString(),
                profile: { username: "you", display_name: "You", avatar_url: "" },
                replies: [],
            };
            justPostedRef.current = true;
            setTopLevel(prev => [optimistic, ...prev]);
            setTotalCount(c => c + 1);
            setNewText("");
        } catch { }
        setPosting(false);
    }

    function handleReplyPosted() {
        setTotalCount(c => c + 1);
    }

    return (
        <div id="comments">
            {/* ── Compose box or login prompt ── */}
            {user ? (
                <form
                    onSubmit={submitTopLevel}
                    style={{
                        marginBottom: 20,
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                        padding: 14,
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                    }}
                >
                    <div className="section-title">Join the discussion</div>
                    <textarea
                        className="input"
                        style={{ minHeight: 90 }}
                        placeholder="What are your thoughts on this job?"
                        value={newText}
                        onChange={e => setNewText(e.target.value)}
                    />
                    <div>
                        <button
                            type="submit"
                            className="btn btn-primary btn-sm"
                            disabled={posting || !newText.trim()}
                        >
                            {posting ? "Posting…" : "Comment"}
                        </button>
                    </div>
                </form>
            ) : (
                <div
                    style={{
                        marginBottom: 20,
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                        padding: 14,
                        textAlign: "center",
                    }}
                >
                    <p className="text-sm text-[var(--text-muted)] mb-3">Sign in to join the discussion</p>
                    <button className="btn btn-primary btn-sm" onClick={() => router.push("/login")}>
                        Sign in
                    </button>
                </div>
            )}

            {/* ── Comment count header ── */}
            {totalCount > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text-muted)", margin: 0 }}>
                        {totalCount} comment{totalCount !== 1 ? "s" : ""}
                    </h3>
                    <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                </div>
            )}

            {/* ── Thread list ── */}
            {topLevel.length === 0 ? (
                <div style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)", fontSize: 14 }}>
                    No comments yet — be the first!
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {topLevel.map(comment => (
                        <div
                            key={comment.id}
                            style={{
                                background: "var(--surface)",
                                border: "1px solid var(--border)",
                                borderRadius: 4,
                                padding: "10px 12px",
                            }}
                        >
                            <CommentNode
                                comment={comment}
                                depth={0}
                                jobId={jobId}
                                onReplyPosted={handleReplyPosted}
                            />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
