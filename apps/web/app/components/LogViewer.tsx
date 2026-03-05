"use client";

import { useEffect, useRef, useState } from "react";

export function LogViewer({ logs }: { logs: string[] }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [autoScroll, setAutoScroll] = useState(true);

    useEffect(() => {
        if (autoScroll && containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [logs, autoScroll]);

    function handleScroll() {
        if (!containerRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
        setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
    }

    return (
        <div className="animate-fade-in relative">
            <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                    <span className="text-base">🖥️</span>
                    Agent Live Log
                </h3>
                <span className="text-xs text-[var(--green)] flex items-center gap-1.5 font-mono">
                    <span className="live-dot" />
                    STREAMING
                </span>
            </div>

            <div
                ref={containerRef}
                onScroll={handleScroll}
                className="bg-[#0a0c10] rounded-xl border border-[var(--border)] font-mono text-xs p-4 h-72 overflow-y-auto flex flex-col gap-0.5"
            >
                {logs.length === 0 ? (
                    <div className="text-[var(--text-muted)] italic flex-1 flex items-center justify-center">
                        Waiting for agents to broadcast events...
                    </div>
                ) : (
                    logs.map((log, i) => (
                        <div
                            key={i}
                            className="text-[#c9d1d9] whitespace-pre-wrap break-all py-0.5 hover:bg-white/[0.03] rounded px-1 -mx-1"
                        >
                            <span className="text-[var(--text-muted)] mr-2 select-none text-[10px]">
                                {String(i + 1).padStart(3, "0")}
                            </span>
                            <span
                                className={
                                    log.includes("SYSTEM:")
                                        ? "text-[var(--accent)] font-semibold"
                                        : log.includes("Error") || log.includes("error")
                                            ? "text-[var(--red)]"
                                            : log.includes("✓") || log.includes("success")
                                                ? "text-[var(--green)]"
                                                : ""
                                }
                            >
                                {log.trim()}
                            </span>
                        </div>
                    ))
                )}
            </div>

            {/* Scroll to bottom button */}
            {!autoScroll && logs.length > 0 && (
                <button
                    onClick={() => {
                        setAutoScroll(true);
                        containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: "smooth" });
                    }}
                    className="absolute bottom-4 right-4 btn btn-sm bg-[var(--surface-2)] border border-[var(--border)] text-xs"
                >
                    ↓ Latest
                </button>
            )}
        </div>
    );
}
