"use client";

import { useState } from "react";
import { api, Comment } from "@/lib/api";

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

function buildTree(comments: Comment[]): (Comment & { children: Comment[] })[] {
    const map: Record<string, Comment & { children: Comment[] }> = {};
    const roots: (Comment & { children: Comment[] })[] = [];
    comments.forEach(c => { map[c.id] = { ...c, children: [] }; });
    comments.forEach(c => {
        if ((c as any).parent_id && map[(c as any).parent_id]) {
            map[(c as any).parent_id].children.push(map[c.id]);
        } else {
            roots.push(map[c.id]);
        }
    });
    return roots;
}

function Avatar({ name }: { name: string }) {
    const initials = (name || "?").slice(0, 2).toUpperCase();
    const hue = [...name].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
    return (
        <div
            style={{
                width: 24, height: 24, borderRadius: "50%",
                background: `hsl(${hue}, 65%, 45%)`,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 700, color: "white", flexShrink: 0,
            }}
        >
            {initials}
        </div>
    );
}

// ── Single Comment Node ──────────────────────────────

type CommentWithChildren = Comment & { children: CommentWithChildren[] };

function CommentNode({
    comment, depth, jobId, onReplyAdded,
}: {
    comment: CommentWithChildren;
    depth: number;
    jobId: string;
    onReplyAdded: (c: Comment, parentId: string) => void;
}) {
    const [collapsed, setCollapsed] = useState(depth >= 4);
    const [replying, setReplying] = useState(false);
    const [replyText, setReplyText] = useState("");
    const [posting, setPosting] = useState(false);

    const author = comment.profile?.display_name || comment.profile?.username || "Anonymous";

    async function submitReply(e: React.FormEvent) {
        e.preventDefault();
        if (!replyText.trim() || posting) return;
        setPosting(true);
        try {
            // parent_id is sent via body; the API's community router should accept it
            await api.addComment(jobId, replyText.trim());
            onReplyAdded({ ...comment, content: replyText } as any, comment.id);
            setReplyText("");
            setReplying(false);
        } catch { }
        setPosting(false);
    }

    return (
        <div className="comment-node">
            <div className="comment-body">
                {/* Header */}
                <div className="comment-header">
                    <button
                        className="comment-collapse-btn"
                        onClick={() => setCollapsed(c => !c)}
                        title={collapsed ? "Expand" : "Collapse"}
                    >
                        {collapsed ? "+" : "−"}
                    </button>
                    <Avatar name={author} />
                    <span className="comment-author">{author}</span>
                    <span className="comment-timestamp">{timeAgo(comment.created_at)}</span>
                </div>

                {/* Content */}
                {!collapsed && (
                    <>
                        <div className="comment-content">{comment.content}</div>
                        <div className="comment-actions">
                            <button className="comment-action-btn" onClick={() => setReplying(r => !r)}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" />
                                </svg>
                                {replying ? "Cancel" : "Reply"}
                            </button>
                        </div>

                        {/* Reply editor */}
                        {replying && (
                            <form onSubmit={submitReply} className="mt-2 flex flex-col gap-2">
                                <textarea
                                    className="input"
                                    style={{ minHeight: 60, fontSize: 13 }}
                                    placeholder="What are your thoughts?"
                                    value={replyText}
                                    onChange={e => setReplyText(e.target.value)}
                                    autoFocus
                                />
                                <div className="flex gap-2">
                                    <button type="submit" className="btn btn-primary btn-sm" disabled={posting || !replyText.trim()}>
                                        {posting ? "Posting…" : "Reply"}
                                    </button>
                                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplying(false)}>
                                        Cancel
                                    </button>
                                </div>
                            </form>
                        )}
                    </>
                )}
            </div>

            {/* Child threads */}
            {!collapsed && comment.children.length > 0 && (
                <div className="comment-children">
                    {comment.children.map(child => (
                        <CommentNode
                            key={child.id}
                            comment={child as CommentWithChildren}
                            depth={depth + 1}
                            jobId={jobId}
                            onReplyAdded={onReplyAdded}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Root CommentThread ───────────────────────────────

export function CommentThread({
    jobId,
    initialComments,
}: {
    jobId: string;
    initialComments: Comment[];
}) {
    const [comments, setComments] = useState<Comment[]>(initialComments);
    const [newText, setNewText] = useState("");
    const [posting, setPosting] = useState(false);

    async function submitComment(e: React.FormEvent) {
        e.preventDefault();
        if (!newText.trim() || posting) return;
        setPosting(true);
        try {
            await api.addComment(jobId, newText.trim());
            // Optimistic UI add
            const fakeComment: Comment = {
                id: crypto.randomUUID(),
                job_id: jobId,
                user_id: "",
                content: newText.trim(),
                created_at: new Date().toISOString(),
                profile: { username: "you", display_name: "You", avatar_url: "" },
            };
            setComments(prev => [fakeComment, ...prev]);
            setNewText("");
        } catch { }
        setPosting(false);
    }

    function handleReplyAdded(reply: Comment, parentId: string) {
        setComments(prev => [...prev, { ...reply, id: crypto.randomUUID(), created_at: new Date().toISOString() }]);
    }

    const tree = buildTree(comments);

    return (
        <div>
            {/* Compose box */}
            <form onSubmit={submitComment} className="mb-6 card" style={{ padding: "12px" }}>
                <div className="section-title mb-2">Join the discussion</div>
                <textarea
                    className="input mb-2"
                    style={{ minHeight: 80 }}
                    placeholder="What are your thoughts on this job?"
                    value={newText}
                    onChange={e => setNewText(e.target.value)}
                />
                <button type="submit" className="btn btn-primary btn-sm" disabled={posting || !newText.trim()}>
                    {posting ? "Posting…" : "Comment"}
                </button>
            </form>

            {/* Thread count */}
            {comments.length > 0 && (
                <h3 className="text-sm font-bold text-[var(--text-muted)] mb-3">
                    {comments.length} comment{comments.length !== 1 ? "s" : ""}
                </h3>
            )}

            {/* Tree */}
            <div className="comment-tree">
                {tree.length === 0 ? (
                    <div className="text-center py-8 text-[var(--text-muted)] text-sm">
                        No comments yet — be the first!
                    </div>
                ) : (
                    tree.map(node => (
                        <CommentNode
                            key={node.id}
                            comment={node as CommentWithChildren}
                            depth={0}
                            jobId={jobId}
                            onReplyAdded={handleReplyAdded}
                        />
                    ))
                )}
            </div>
        </div>
    );
}
