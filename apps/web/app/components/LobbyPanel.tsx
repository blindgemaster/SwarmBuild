"use client";

import { useRouter } from "next/navigation";
import { Contributor, Job } from "@/lib/api";
import { useAuth } from "@/app/components/AuthProvider";

export function LobbyPanel({
    job,
    contributors,
    onContribute,
    onToggleReady,
}: {
    job: Job;
    contributors: Contributor[];
    onContribute: (role: string) => void;
    onToggleReady: (isReady: boolean) => void;
}) {
    const { user } = useAuth();
    const router = useRouter();
    const roles = job.required_roles?.length ? job.required_roles : ["teammate"];
    const usedContributorIds = new Set<string>();

    return (
        <div className="animate-fade-in">
            <div className="flex justify-between items-center mb-4">
                <h3 className="font-semibold text-sm">Team Lobby</h3>
                {job.status === "approved" && (
                    <span className="tag tag-accent text-[10px]">Gathering agents...</span>
                )}
                {job.status === "running" && (
                    <span className="text-xs text-[var(--green)] flex items-center gap-1.5 font-medium">
                        <span className="live-dot" />
                        Executing
                    </span>
                )}
            </div>

            <div className="flex flex-col gap-2">
                {roles.map((requiredRole, idx) => {
                    const c = contributors.find(
                        (contrib) =>
                            contrib.role === requiredRole && !usedContributorIds.has(contrib.id)
                    );

                    if (c) {
                        usedContributorIds.add(c.id);
                        return (
                            <div
                                key={c.id}
                                className="flex items-center justify-between p-3 rounded-xl bg-[var(--surface-2)] border border-[var(--border)]"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-sm font-bold text-white shadow-lg shadow-indigo-500/20">
                                        {c.profile?.username?.[0]?.toUpperCase() || "?"}
                                    </div>
                                    <div>
                                        <div className="font-medium text-sm">
                                            {c.profile?.display_name || c.profile?.username || "Anonymous"}
                                        </div>
                                        <div className="tag text-[10px] capitalize mt-0.5 inline-block">
                                            {c.role.replace("_", " ")}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    {c.contributor_status === "disconnected" ? (
                                        <span className="text-xs font-semibold text-[var(--red)] flex items-center gap-1">
                                            ⚠ Disconnected
                                        </span>
                                    ) : c.contributor_status === "stale" ? (
                                        <span className="text-xs font-semibold text-[var(--orange)] flex items-center gap-1">
                                            ⏳ Stale
                                        </span>
                                    ) : c.contributor_status === "left" ? (
                                        <span className="text-xs font-semibold text-[var(--text-muted)] flex items-center gap-1">
                                            Left
                                        </span>
                                    ) : c.is_ready ? (
                                        <span className="text-xs font-semibold text-[var(--green)] flex items-center gap-1">
                                            ✓ Active
                                        </span>
                                    ) : (
                                        <span className="text-xs text-[var(--yellow)]">Waiting...</span>
                                    )}
                                    {job.status === "approved" && (
                                        <button
                                            onClick={() => onToggleReady(!c.is_ready)}
                                            className={`btn btn-sm ${c.is_ready ? "btn-danger" : "btn-primary"
                                                }`}
                                        >
                                            {c.is_ready ? "Cancel" : "Ready"}
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    }

                    return (
                        <div
                            key={`empty-${idx}`}
                            className="flex items-center justify-between p-3 rounded-xl bg-[var(--bg)] border border-dashed border-[var(--border)]"
                        >
                            <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-full bg-[var(--surface-2)] flex items-center justify-center text-[var(--text-muted)] border border-dashed border-[var(--border)] text-sm">
                                    ?
                                </div>
                                <div>
                                    <div className="font-medium text-sm text-[var(--text-muted)]">Open Slot</div>
                                    <div className="tag text-[10px] capitalize mt-0.5 inline-block">
                                        {requiredRole.replace("_", " ")}
                                    </div>
                                </div>
                            </div>
                            {job.status === "approved" && (
                                user ? (
                                    <button
                                        onClick={() => onContribute(requiredRole)}
                                        className="btn btn-outline btn-sm hover:!bg-[var(--accent)] hover:!text-white hover:!border-transparent"
                                    >
                                        🚀 Claim
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => router.push("/login")}
                                        className="btn btn-outline btn-sm"
                                    >
                                        Sign in to claim
                                    </button>
                                )
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
