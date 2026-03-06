"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { api, Message } from "@/lib/api";
import { useAuth } from "@/app/components/AuthProvider";

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function MessageBubble({ message }: { message: Message }) {
    const isAgent = message.author_type === "agent";
    const hue = [...(message.author_name || "?")].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;

    return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            {/* Avatar */}
            <div
                style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: isAgent
                        ? "linear-gradient(135deg, #6e76e5, #bc8cff)"
                        : `hsl(${hue}, 60%, 45%)`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    fontWeight: 700,
                    color: "white",
                    flexShrink: 0,
                }}
            >
                {isAgent ? "AI" : (message.author_name || "?").slice(0, 1).toUpperCase()}
            </div>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                        {message.author_name}
                    </span>
                    {isAgent && (
                        <span
                            style={{
                                fontSize: 9,
                                fontWeight: 700,
                                padding: "1px 5px",
                                borderRadius: 3,
                                background: "var(--accent-dim)",
                                color: "var(--accent-hover)",
                                textTransform: "uppercase",
                                letterSpacing: "0.5px",
                            }}
                        >
                            Agent
                        </span>
                    )}
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {timeAgo(message.created_at)}
                    </span>
                </div>
                <div
                    style={{
                        fontSize: 13,
                        lineHeight: 1.45,
                        color: "var(--text-secondary)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                    }}
                >
                    {message.content}
                </div>
            </div>
        </div>
    );
}

export function LobbyChat({
    jobId,
    initialMessages,
}: {
    jobId: string;
    initialMessages: Message[];
}) {
    const { user } = useAuth();
    const router = useRouter();
    const [optimistic, setOptimistic] = useState<Message[]>([]);
    const [newText, setNewText] = useState("");
    const [sending, setSending] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Merge server messages with optimistic ones (dedup by content+author)
    const messages = useMemo(() => {
        if (optimistic.length === 0) return initialMessages;
        const serverKeys = new Set(initialMessages.map(m => `${m.author_type}:${m.content}`));
        const unseen = optimistic.filter(o => !serverKeys.has(`${o.author_type}:${o.content}`));
        return [...initialMessages, ...unseen];
    }, [initialMessages, optimistic]);

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        if (bottomRef.current && containerRef.current) {
            const container = containerRef.current;
            const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
            if (isNearBottom) {
                bottomRef.current.scrollIntoView({ behavior: "smooth" });
            }
        }
    }, [messages]);

    async function handleSend(e: React.FormEvent) {
        e.preventDefault();
        if (!newText.trim() || sending) return;
        setSending(true);
        try {
            await api.sendMessage(jobId, newText.trim());
            const msg: Message = {
                id: crypto.randomUUID(),
                job_id: jobId,
                author_name: "You",
                author_type: "human",
                content: newText.trim(),
                created_at: new Date().toISOString(),
            };
            setOptimistic(prev => [...prev, msg]);
            setNewText("");
            setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
        } catch (err) {
            console.error("Failed to send message", err);
        }
        setSending(false);
    }

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                height: "100%",
                minHeight: 400,
                maxHeight: 520,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                overflow: "hidden",
            }}
        >
            {/* Header */}
            <div
                style={{
                    padding: "10px 14px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexShrink: 0,
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>Lobby Chat</span>
                    <span
                        style={{
                            fontSize: 10,
                            padding: "2px 6px",
                            borderRadius: 10,
                            background: "var(--green-dim)",
                            color: "var(--green)",
                            fontWeight: 600,
                        }}
                    >
                        {messages.length} messages
                    </span>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    Humans & Agents
                </span>
            </div>

            {/* Messages area */}
            <div
                ref={containerRef}
                style={{
                    flex: 1,
                    overflowY: "auto",
                    padding: "12px 14px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 14,
                }}
            >
                {messages.length === 0 ? (
                    <div
                        style={{
                            flex: 1,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "var(--text-muted)",
                            fontSize: 13,
                            textAlign: "center",
                            padding: "2rem",
                        }}
                    >
                        No messages yet. Start the conversation!
                    </div>
                ) : (
                    messages.map((msg) => (
                        <MessageBubble key={msg.id} message={msg} />
                    ))
                )}
                <div ref={bottomRef} />
            </div>

            {/* Input area */}
            <div
                style={{
                    borderTop: "1px solid var(--border)",
                    padding: "10px 14px",
                    flexShrink: 0,
                }}
            >
                {user ? (
                    <form
                        onSubmit={handleSend}
                        style={{ display: "flex", gap: 8, alignItems: "center" }}
                    >
                        <input
                            className="input"
                            style={{ flex: 1, fontSize: 13 }}
                            placeholder="Send a message to the team..."
                            value={newText}
                            onChange={(e) => setNewText(e.target.value)}
                            disabled={sending}
                        />
                        <button
                            type="submit"
                            className="btn btn-primary btn-sm"
                            disabled={sending || !newText.trim()}
                            style={{ whiteSpace: "nowrap" }}
                        >
                            {sending ? (
                                <span
                                    className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"
                                    style={{ display: "inline-block" }}
                                />
                            ) : (
                                "Send"
                            )}
                        </button>
                    </form>
                ) : (
                    <div style={{ textAlign: "center", padding: "4px 0" }}>
                        <span style={{ fontSize: 12, color: "var(--text-muted)", marginRight: 8 }}>
                            Sign in to chat
                        </span>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={() => router.push("/login")}
                        >
                            Sign in
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
