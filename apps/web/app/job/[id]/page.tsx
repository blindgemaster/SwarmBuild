"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, Job, PlanResponse, Comment, Contributor, Task } from "@/lib/api";

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

export default function JobDetailPage() {
    const params = useParams();
    const router = useRouter();
    const jobId = params.id as string;

    const [job, setJob] = useState<Job | null>(null);
    const [plan, setPlan] = useState<PlanResponse | null>(null);
    const [comments, setComments] = useState<Comment[]>([]);
    const [contributors, setContributors] = useState<Contributor[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [logs, setLogs] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    // Action states
    const [generatingPlan, setGeneratingPlan] = useState(false);
    const [newComment, setNewComment] = useState("");
    const [postingComment, setPostingComment] = useState(false);
    const [actionMessage, setActionMessage] = useState("");

    // Dynamic Role Editing states
    const [editingRoles, setEditingRoles] = useState<string[]>([]);
    const [newRole, setNewRole] = useState("");
    const [savingRoles, setSavingRoles] = useState(false);

    // Plan Editing states (active only in plan_ready status)
    const [editingPrompt, setEditingPrompt] = useState("");
    const [editingTaskList, setEditingTaskList] = useState<string[]>([]);
    const [newTaskItem, setNewTaskItem] = useState("");
    const [savingPlan, setSavingPlan] = useState(false);
    const planInitializedRef = useRef(false);

    // Hydration fix
    const [isMounted, setIsMounted] = useState(false);

    const loadJob = useCallback(async () => {
        try {
            const [jobData, planData, commentsData, contributorsData, tasksData] = await Promise.all([
                api.getJob(jobId),
                api.getPlan(jobId).catch(() => null),
                api.getComments(jobId).catch(() => ({ comments: [] })),
                api.listContributors(jobId).catch(() => ({ contributors: [], total: 0 })),
                api.listJobTasks(jobId).catch(() => ({ tasks: [] })),
            ]);
            setJob(jobData);
            setPlan(planData);
            setComments(commentsData.comments || []);
            setContributors(contributorsData.contributors || []);
            setTasks(tasksData.tasks || []);
            // Seed plan/role editor state once (guard prevents WS-triggered reloads from clobbering edits)
            if (!planInitializedRef.current && (planData?.plan_ready || jobData.status === "plan_ready")) {
                if (planData?.plan_ready) {
                    setEditingPrompt(planData.agent_prompt || "");
                    setEditingTaskList(planData.task_list || []);
                }
                if (jobData.status === "plan_ready") {
                    const roles = jobData.required_roles?.length
                        ? [...jobData.required_roles]
                        : Array(jobData.required_agent_count || 1).fill("teammate");
                    if (!roles.includes("lead")) roles.unshift("lead");
                    setEditingRoles(roles);
                }
                planInitializedRef.current = true;
            }
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Failed to load job");
        } finally {
            setLoading(false);
        }
    }, [jobId]);

    useEffect(() => {
        setIsMounted(true);
        loadJob();

        // Fetch persisted log history so logs survive page refresh
        api.getJobLogs(jobId).then(data => {
            if (data.logs?.length) setLogs(data.logs);
        }).catch(() => {});

        // Connect to WebSocket for real-time Lobby updates
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
        const wsUrl = apiUrl.replace(/^http/, "ws");
        const ws = new WebSocket(`${wsUrl}/api/jobs/${jobId}/lobby/ws`);

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === "lobby_state_change" || data.type === "new_message" || data.type === "task_updated") {
                    // Instantly refresh the UI from the server instead of waiting 3 seconds!
                    loadJob();
                }
            } catch (e) {
                console.error("Failed to parse WebSocket message", e);
            }
        };

        ws.onopen = () => console.log("Lobby WebSocket Connected");
        ws.onclose = () => console.log("Lobby WebSocket Disconnected");

        // Connect to WebSocket for real-time Event Logs
        const logWs = new WebSocket(`${wsUrl}/api/logs/${jobId}`);
        logWs.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === "log" && data.content) {
                    setLogs(prev => {
                        const newLogs = [...prev, data.content];
                        return newLogs.slice(-100); // Keep last 100 lines to prevent memory leaks
                    });
                }
            } catch (e) {
                console.error("Failed to parse log message", e);
            }
        };

        return () => {
            ws.close();
            logWs.close();
        };
    }, [loadJob, jobId]);

    async function handleGeneratePlan() {
        setGeneratingPlan(true);
        setActionMessage("");
        try {
            await api.generatePlan(jobId);
            setActionMessage("Plan generation started! Refreshing...");
            // Poll for completion
            for (let i = 0; i < 30; i++) {
                await new Promise((r) => setTimeout(r, 2000));
                const planData = await api.getPlan(jobId);
                if (planData.plan_ready) {
                    setPlan(planData);
                    const updatedJob = await api.getJob(jobId);
                    setJob(updatedJob);
                    // Initialize local role editor state (lead is always required)
                    const roles = updatedJob.required_roles?.length
                        ? [...updatedJob.required_roles]
                        : Array(updatedJob.required_agent_count || 1).fill("teammate");
                    if (!roles.includes("lead")) roles.unshift("lead");
                    setEditingRoles(roles);
                    // Initialize plan editor state (reset ref so new plan always seeds fresh)
                    planInitializedRef.current = false;
                    setEditingPrompt(planData.agent_prompt || "");
                    setEditingTaskList(planData.task_list || []);
                    planInitializedRef.current = true;
                    setActionMessage("Plan generated!");
                    break;
                }
                if (planData.status === "failed") {
                    setActionMessage("Plan generation failed. Check server logs.");
                    break;
                }
            }
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        } finally {
            setGeneratingPlan(false);
        }
    }

    async function handleApprove() {
        try {
            await api.approveJob(jobId);
            setActionMessage("Job approved! Contributors can now join.");
            loadJob();
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        }
    }

    async function handleMarkComplete() {
        if (!confirm("Mark this job as complete? This confirms the work is done and cannot be undone.")) return;
        try {
            await api.completeJob(jobId);
            setActionMessage("Job marked complete!");
            loadJob();
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        }
    }

    async function handleDelete() {
        if (!confirm("Cancel this job?")) return;
        try {
            await api.deleteJob(jobId);
            router.push("/");
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        }
    }

    async function handleSaveRoles() {
        if (!job) return;
        setSavingRoles(true);
        try {
            await api.updateRoles(jobId, editingRoles);
            setActionMessage("Required roles updated successfully!");
            loadJob();
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed to update roles");
        } finally {
            setSavingRoles(false);
        }
    }

    function handleAddRole() {
        if (!newRole.trim()) return;
        setEditingRoles([...editingRoles, newRole.trim()]);
        setNewRole("");
    }

    function handleRemoveRole(index: number) {
        if (editingRoles[index] === "lead") return; // lead is always required
        setEditingRoles(editingRoles.filter((_, i) => i !== index));
    }

    async function handleSavePlan() {
        setSavingPlan(true);
        try {
            await api.updatePlan(jobId, { agent_prompt: editingPrompt, task_list: editingTaskList });
            setPlan(prev => prev ? { ...prev, agent_prompt: editingPrompt, task_list: editingTaskList } : prev);
            setActionMessage("Plan saved!");
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed to save plan");
        } finally {
            setSavingPlan(false);
        }
    }

    function handleAddTaskItem() {
        if (!newTaskItem.trim()) return;
        setEditingTaskList([...editingTaskList, newTaskItem.trim()]);
        setNewTaskItem("");
    }

    function handleRemoveTaskItem(index: number) {
        setEditingTaskList(editingTaskList.filter((_, i) => i !== index));
    }

    async function handleContribute(role: string) {
        try {
            const result: any = await api.contribute(jobId, role);
            if (result.worker_token) {
                setActionMessage(
                    `Joined! CLI command:\n${result.cli_command}`
                );
            }
            loadJob();
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        }
    }

    async function handleVote() {
        try {
            await api.toggleVote(jobId);
            loadJob();
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        }
    }

    async function handleToggleReady(isReady: boolean) {
        try {
            await api.toggleReady(jobId, isReady);
            loadJob();
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        }
    }

    async function handlePostComment(e: React.FormEvent) {
        e.preventDefault();
        if (!newComment.trim()) return;
        setPostingComment(true);
        try {
            await api.addComment(jobId, newComment.trim());
            setNewComment("");
            const commentsData = await api.getComments(jobId);
            setComments(commentsData.comments || []);
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        } finally {
            setPostingComment(false);
        }
    }

    if (!isMounted || loading) {
        return <div className="text-center text-[var(--text-muted)] py-12" suppressHydrationWarning>Loading...</div>;
    }

    if (error || !job) {
        return (
            <div className="text-center py-12">
                <p className="text-[var(--red)] mb-4">{error || "Job not found"}</p>
                <Link href="/" className="btn btn-outline">← Back</Link>
            </div>
        );
    }

    return (
        <div suppressHydrationWarning>
            {/* Breadcrumb */}
            <Link href="/" className="text-sm text-[var(--text-muted)] hover:text-white mb-4 inline-block">
                ← Back to jobs
            </Link>

            {/* Header */}
            <div className="flex items-start justify-between gap-4 mb-6">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <h1 className="text-2xl font-bold">{job.title}</h1>
                        <span className={`badge badge-${job.status}`}>
                            {job.status.replace("_", " ")}
                        </span>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-[var(--text-muted)]">
                        <span>{job.output_type}</span>
                        {job.tech_stack?.length > 0 && <span>{job.tech_stack.join(", ")}</span>}
                        <span>{timeAgo(job.created_at)}</span>
                        {job.vote_count !== undefined && <span>▲ {job.vote_count} votes</span>}
                        {job.active_contributors !== undefined && (
                            <span>👥 {job.active_contributors} contributors</span>
                        )}
                    </div>
                </div>
                <button onClick={handleVote} className="btn btn-outline btn-sm">
                    ▲ Vote
                </button>
            </div>

            {/* Action Message */}
            {actionMessage && (
                <div className="card mb-4 text-sm whitespace-pre-wrap border-[var(--accent)]">
                    {actionMessage}
                </div>
            )}

            {/* GitHub Repo Widget — visible as soon as the repo is provisioned on approval */}
            {(job.github_repo_id || job.github_repo) && (() => {
                const repoId = job.github_repo_id || job.github_repo!;
                return (
                <div className="card mb-6 border-[var(--primary)] flex flex-col md:flex-row items-start md:items-center justify-between p-4 gap-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-[var(--surface-1)] flex items-center justify-center border border-[var(--border)] shrink-0">
                            <svg className="w-6 h-6 text-[var(--text)]" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                            </svg>
                        </div>
                        <div className="min-w-0">
                            <div className="font-bold text-sm text-[var(--text)]">Repository Auto-Provisioned</div>
                            <a href={`https://github.com/${repoId}`} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--accent)] hover:underline break-all">
                                github.com/{repoId}
                            </a>
                        </div>
                    </div>
                    <div className="md:text-right shrink-0">
                        {(job.status === "running" || job.status === "complete") ? (
                            <>
                                <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide font-semibold mb-1">Live Commits</div>
                                <div className="flex items-center gap-2">
                                    {job.status === "running" && (
                                        <span className="relative flex h-2 w-2">
                                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--green)] flex-shrink-0 opacity-75"></span>
                                            <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--green)]"></span>
                                        </span>
                                    )}
                                    <a href={`https://github.com/${repoId}/commits/main`} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-[var(--text)] hover:text-[var(--accent)] transition-colors">
                                        View commits →
                                    </a>
                                </div>
                            </>
                        ) : (
                            <span className="badge badge-pending">Waiting to start...</span>
                        )}
                    </div>
                </div>
                );
            })()}

            {/* Description */}
            <div className="card mb-6">
                <h2 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
                    Description
                </h2>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{job.description}</p>
                {job.constraints && (
                    <>
                        <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mt-4 mb-1">
                            Constraints
                        </h3>
                        <p className="text-sm text-[var(--text-muted)]">{job.constraints}</p>
                    </>
                )}
                {job.examples && (
                    <>
                        <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mt-4 mb-1">
                            Examples
                        </h3>
                        <p className="text-sm text-[var(--text-muted)]">{job.examples}</p>
                    </>
                )}
            </div>

            {/* Role Editor (Plan Ready State) */}
            {job.status === "plan_ready" && (
                <div className="card mb-6 border-[var(--primary)] text-sm">
                    <h2 className="font-semibold text-white mb-2 flex items-center gap-2">
                        🕵️ Team Composition Blueprint
                    </h2>
                    <p className="text-[var(--text-muted)] mb-4">
                        The AI suggests the following roles based on your required agent count ({job.required_agent_count || 1}).
                        Edit these before approving the plan.
                    </p>
                    <div className="flex flex-wrap gap-2 mb-4">
                        {editingRoles.map((role, idx) => (
                            <div key={idx} className={`flex items-center gap-2 px-3 py-1 rounded border ${role === "lead" ? "bg-[var(--primary)] border-[var(--primary)] text-white" : "bg-[var(--surface-2)] border-[var(--border)]"}`}>
                                <span className="font-medium capitalize">{role.replace("_", " ")}</span>
                                {role === "lead" ? (
                                    <span className="text-[10px] opacity-70 ml-1">required</span>
                                ) : (
                                    <button onClick={() => handleRemoveRole(idx)} className="text-[var(--red)] hover:text-white font-bold text-xs ml-2">×</button>
                                )}
                            </div>
                        ))}
                    </div>
                    <div className="flex items-center gap-2 mb-4">
                        <input
                            className="input flex-1 py-1 px-3 text-sm h-auto"
                            placeholder="Add a required role (e.g. security-auditor)"
                            value={newRole}
                            onChange={(e) => setNewRole(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAddRole()}
                        />
                        <button onClick={handleAddRole} className="btn btn-outline btn-sm">Add Slot</button>
                    </div>
                    <button
                        onClick={handleSaveRoles}
                        disabled={savingRoles}
                        className="btn btn-primary btn-sm"
                    >
                        {savingRoles ? "Saving..." : "💾 Save Roles"}
                    </button>
                </div>
            )}

            {/* Actions Bar */}
            <div className="flex gap-3 mb-6 flex-wrap">
                {(job.status === "pending" || job.status === "plan_ready") && (
                    <button
                        onClick={handleGeneratePlan}
                        disabled={generatingPlan}
                        className="btn btn-primary"
                    >
                        {generatingPlan ? "⏳ Generating..." : "🧠 Generate Plan"}
                    </button>
                )}
                {job.status === "plan_ready" && (
                    <button onClick={handleApprove} className="btn btn-primary">
                        ✅ Approve Plan
                    </button>
                )}
                {(job.status === "running" || job.status === "approved") && (
                    <button onClick={handleMarkComplete} className="btn btn-primary">
                        🏁 Mark Complete
                    </button>
                )}
                {job.status !== "complete" && job.status !== "cancelled" && (
                    <button onClick={handleDelete} className="btn btn-danger btn-sm">
                        Cancel Job
                    </button>
                )}
            </div>

            {/* Contributors / Lobby Section */}
            {(job.status === "approved" || job.status === "running") && (
                <div className="card mb-6 border-[var(--primary)]">
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="text-base font-bold text-[var(--text)]">Lobby & Contributors</h2>
                        {job.status === "approved" && (
                            <span className="text-xs px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--accent)] font-semibold border border-[var(--border)]">
                                Gathering Agents...
                            </span>
                        )}
                        {job.status === "running" && (
                            <span className="text-xs px-2 py-1 rounded bg-green-900/40 text-green-400 font-semibold border border-green-800">
                                Execution in progress!
                            </span>
                        )}
                    </div>

                    {(() => {
                        const roles = job.required_roles?.length ? job.required_roles : ["teammate"];
                        const usedContributorIds = new Set<string>();

                        return (
                            <div className="flex flex-col gap-3">
                                {roles.map((requiredRole, idx) => {
                                    const c = contributors.find(contrib => contrib.role === requiredRole && !usedContributorIds.has(contrib.id));

                                    if (c) {
                                        usedContributorIds.add(c.id);
                                        return (
                                            <div key={c.id} className="flex items-center justify-between p-3 rounded bg-[var(--surface-2)] border border-[var(--border)] shadow-sm">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-10 h-10 rounded-full bg-[var(--bg)] flex items-center justify-center text-sm font-bold border border-[var(--accent)]">
                                                        {c.profile?.username?.[0]?.toUpperCase() || "?"}
                                                    </div>
                                                    <div>
                                                        <div className="font-bold text-sm text-[var(--text)]">{c.profile?.display_name || c.profile?.username || "Anonymous"}</div>
                                                        <div className="flex items-center gap-2 mt-1">
                                                            <div className="text-xs text-[var(--text-muted)] capitalize bg-[var(--bg)] px-2 py-0.5 rounded border border-[var(--border)] inline-block">
                                                                {c.role.replace("_", " ")}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-4">
                                                    <div className="text-right mr-2">
                                                        {c.is_ready ? (
                                                            <div className="text-sm font-bold text-green-400">✅ Ready</div>
                                                        ) : (
                                                            <div className="text-sm font-medium text-[var(--orange)]">⏳ Claimed (Not Ready)</div>
                                                        )}
                                                    </div>

                                                    {job.status === "approved" && (
                                                        <button
                                                            onClick={() => handleToggleReady(!c.is_ready)}
                                                            className={`btn btn-sm ${c.is_ready ? 'btn-outline border-[var(--red)] text-[var(--red)] hover:bg-[var(--red)] hover:text-white' : 'btn-primary'}`}
                                                        >
                                                            {c.is_ready ? "Cancel Ready" : "Mark Ready"}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    }

                                    return (
                                        <div key={`empty-${idx}`} className="flex items-center justify-between p-3 rounded bg-[var(--bg)] border border-dashed border-[var(--border)]">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-full bg-[var(--surface-1)] flex items-center justify-center text-[var(--text-muted)] border border-dashed border-[var(--border)]">
                                                    ?
                                                </div>
                                                <div>
                                                    <div className="font-bold text-sm text-[var(--text-muted)]">Open Slot</div>
                                                    <div className="text-xs text-[var(--text-muted)] capitalize bg-[var(--bg)] px-2 py-0.5 rounded border border-[var(--border)] inline-block mt-1">
                                                        {requiredRole.replace("_", " ")}
                                                    </div>
                                                </div>
                                            </div>
                                            {job.status === "approved" && (
                                                <button onClick={() => handleContribute(requiredRole)} className="btn btn-outline btn-sm hover:!bg-[var(--primary)] hover:!text-white hover:!border-transparent">
                                                    🚀 Claim Role
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })()}
                </div>
            )}

            {/* Live Task Kanban Section */}
            {(job.status === "running" || job.status === "complete") && tasks.length > 0 && (
                <div className="mb-6">
                    <h2 className="text-base font-bold text-[var(--text)] mb-4 flex items-center gap-2">
                        📊 Live Execution Board
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {/* To Do (Available) */}
                        <div className="bg-[var(--surface-1)] rounded p-3 border border-[var(--border)] min-h-[200px]">
                            <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-3 flex justify-between">
                                <span>To Do</span>
                                <span className="bg-[var(--surface-2)] px-2 rounded-full text-[10px]">{tasks.filter(t => t.status === 'available').length}</span>
                            </h3>
                            <div className="flex flex-col gap-2">
                                {tasks.filter(t => t.status === 'available').map(t => (
                                    <div key={t.id} className="bg-[var(--surface-2)] p-2 rounded border border-[var(--border)] shadow-sm text-sm">
                                        <div className="font-medium text-[var(--text)] mb-1">{t.title}</div>
                                        {t.assigned_role && (
                                            <span className="text-[10px] bg-[var(--bg)] px-1.5 py-0.5 rounded text-[var(--text-muted)] border border-[var(--border)] capitalize">
                                                {t.assigned_role.replace("_", " ")}
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* In Progress (Locked) */}
                        <div className="bg-[var(--surface-1)] rounded p-3 border border-[var(--orange)] border-opacity-30 min-h-[200px]">
                            <h3 className="text-xs font-semibold text-[var(--orange)] uppercase tracking-wide mb-3 flex justify-between">
                                <span>In Progress</span>
                                <span className="bg-[var(--orange)] bg-[opacity-20] px-2 rounded-full text-[10px] text-[var(--orange)] border border-[var(--orange)] border-opacity-30.">{tasks.filter(t => t.status === 'locked').length}</span>
                            </h3>
                            <div className="flex flex-col gap-2">
                                {tasks.filter(t => t.status === 'locked').map(t => (
                                    <div key={t.id} className="bg-[var(--surface-2)] p-2 rounded border border-[var(--orange)] border-[opacity-50] shadow-sm text-sm border-l-2 border-l-[var(--orange)]">
                                        <div className="font-medium text-[var(--text)] mb-1">{t.title}</div>
                                        {t.assigned_role && (
                                            <span className="text-[10px] bg-[var(--bg)] px-1.5 py-0.5 rounded text-[var(--text-muted)] border border-[var(--border)] capitalize">
                                                {t.assigned_role.replace("_", " ")}
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Done (Completed / Failed) */}
                        <div className="bg-[var(--surface-1)] rounded p-3 border border-[var(--green)] border-opacity-30 min-h-[200px]">
                            <h3 className="text-xs font-semibold text-[var(--green)] uppercase tracking-wide mb-3 flex justify-between">
                                <span>Done</span>
                                <span className="bg-[var(--green)] bg-opacity-20 px-2 rounded-full text-[10px] border border-[var(--green)] border-opacity-30 text-[var(--green)]">{tasks.filter(t => t.status === 'completed' || t.status === 'failed').length}</span>
                            </h3>
                            <div className="flex flex-col gap-2">
                                {tasks.filter(t => t.status === 'completed' || t.status === 'failed').map(t => (
                                    <div key={t.id} className={`bg-[var(--surface-2)] p-2 rounded border shadow-sm text-sm border-l-2 ${t.status === 'completed' ? 'border-[var(--green)] border-opacity-50 border-l-[var(--green)]' : 'border-[var(--red)] border-opacity-50 border-l-[var(--red)]'}`}>
                                        <div className="font-medium text-[var(--text)] mb-1 ">{t.title}</div>
                                        <div className="flex justify-between items-center">
                                            {t.assigned_role && (
                                                <span className="text-[10px] bg-[var(--bg)] px-1.5 py-0.5 rounded text-[var(--text-muted)] border border-[var(--border)] capitalize">
                                                    {t.assigned_role.replace("_", " ")}
                                                </span>
                                            )}
                                            <span className={`text-[10px] font-bold ${t.status === 'completed' ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                                                {t.status.toUpperCase()}
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Live Event Log / Terminal Section */}
            {(job.status === "running" || job.status === "complete") && (
                <div className="card mb-6 border-[var(--primary)] text-sm">
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="font-semibold text-white flex items-center gap-2">
                            🖥️ Agent Live Event Log
                        </h2>
                        <span className="text-xs text-[var(--green)] flex items-center gap-1.5 font-mono">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--green)] opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--green)]"></span>
                            </span>
                            STREAMING STDOUT
                        </span>
                    </div>

                    <div className="bg-[#0D1117] rounded-md border border-[var(--border)] font-mono text-xs p-4 h-64 overflow-y-auto flex flex-col gap-1 shadow-inner">
                        {logs.length === 0 ? (
                            <div className="text-[var(--text-muted)] italic">Waiting for agents to broadcast events...</div>
                        ) : (
                            logs.map((log, i) => (
                                <div key={i} className="text-[#E6EDF3] whitespace-pre-wrap break-all border-b border-[#21262D] pb-1">
                                    <span className="text-[var(--text-muted)] mr-2 select-none">{String(i + 1).padStart(3, '0')} |</span>
                                    <span className={log.includes("SYSTEM:") ? "text-[var(--accent)] font-bold" : log.includes("Error") ? "text-[var(--red)]" : ""}>
                                        {log.trim()}
                                    </span>
                                </div>
                            ))
                        )}
                        {/* Auto-scroll anchor could go here */}
                    </div>
                </div>
            )}

            {/* Plan Section */}
            {plan?.plan_ready && (
                <div className="card mb-6">
                    <h2 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-3">
                        Generated Plan
                        {job.status === "plan_ready" && (
                            <span className="ml-2 text-[var(--accent)] normal-case font-normal text-xs">(editable before approval)</span>
                        )}
                    </h2>

                    {job.status === "plan_ready" ? (
                        <>
                            {/* Editable Task List */}
                            <div className="mb-5">
                                <h3 className="text-xs font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wide">
                                    Tasks ({editingTaskList.length})
                                </h3>
                                <div className="flex flex-col gap-2 mb-2">
                                    {editingTaskList.map((task, i) => (
                                        <div key={i} className="flex items-center gap-2">
                                            <span className="text-xs text-[var(--text-muted)] w-5 shrink-0 text-right">{i + 1}.</span>
                                            <input
                                                className="input flex-1 py-1 px-2 text-sm h-auto"
                                                value={task}
                                                onChange={(e) => {
                                                    const updated = [...editingTaskList];
                                                    updated[i] = e.target.value;
                                                    setEditingTaskList(updated);
                                                }}
                                            />
                                            <button
                                                onClick={() => handleRemoveTaskItem(i)}
                                                className="text-[var(--red)] hover:text-white font-bold text-sm px-2 shrink-0"
                                            >×</button>
                                        </div>
                                    ))}
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        className="input flex-1 py-1 px-2 text-sm h-auto"
                                        placeholder="Add a task..."
                                        value={newTaskItem}
                                        onChange={(e) => setNewTaskItem(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && handleAddTaskItem()}
                                    />
                                    <button onClick={handleAddTaskItem} className="btn btn-outline btn-sm">Add</button>
                                </div>
                            </div>

                            {/* Editable Agent Prompt */}
                            <div className="mb-4">
                                <h3 className="text-xs font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wide">
                                    Agent Prompt
                                </h3>
                                <textarea
                                    className="input w-full font-mono text-xs p-3 resize-y"
                                    rows={14}
                                    value={editingPrompt}
                                    onChange={(e) => setEditingPrompt(e.target.value)}
                                />
                            </div>

                            <button
                                onClick={handleSavePlan}
                                disabled={savingPlan}
                                className="btn btn-primary btn-sm"
                            >
                                {savingPlan ? "Saving..." : "💾 Save Plan"}
                            </button>
                        </>
                    ) : (
                        <>
                            {/* Read-only Task List */}
                            {plan.task_list && plan.task_list.length > 0 && (
                                <div className="mb-4">
                                    <h3 className="text-xs font-semibold text-[var(--text-muted)] mb-2">
                                        Tasks ({plan.task_count || plan.task_list.length})
                                    </h3>
                                    <ol className="list-decimal list-inside text-sm space-y-1">
                                        {plan.task_list.map((task, i) => (
                                            <li key={i} className="text-[var(--text-muted)]">{task}</li>
                                        ))}
                                    </ol>
                                </div>
                            )}

                            {/* Agent Prompt (collapsible) */}
                            {plan.agent_prompt && (
                                <details className="mt-4">
                                    <summary className="cursor-pointer text-sm text-[var(--accent)] hover:underline">
                                        View Agent Prompt
                                    </summary>
                                    <pre className="mt-2 text-xs bg-[var(--bg)] p-4 rounded overflow-auto max-h-96 whitespace-pre-wrap">
                                        {plan.agent_prompt}
                                    </pre>
                                </details>
                            )}

                            {/* Test Harness (collapsible) */}
                            {plan.test_harness && Object.keys(plan.test_harness).length > 0 && (
                                <details className="mt-3">
                                    <summary className="cursor-pointer text-sm text-[var(--accent)] hover:underline">
                                        View Test Harness ({Object.keys(plan.test_harness).length} files)
                                    </summary>
                                    {Object.entries(plan.test_harness).map(([filename, content]) => (
                                        <div key={filename} className="mt-2">
                                            <p className="text-xs font-mono text-[var(--text-muted)] mb-1">{filename}</p>
                                            <pre className="text-xs bg-[var(--bg)] p-3 rounded overflow-auto max-h-48">
                                                {content}
                                            </pre>
                                        </div>
                                    ))}
                                </details>
                            )}
                        </>
                    )}
                </div>
            )}

            {/* Comments */}
            <div className="card">
                <h2 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-3">
                    Discussion ({comments.length})
                </h2>

                {/* Comment Form */}
                <form onSubmit={handlePostComment} className="mb-4">
                    <div className="flex gap-2">
                        <input
                            className="input flex-1"
                            value={newComment}
                            onChange={(e) => setNewComment(e.target.value)}
                            placeholder="Add a comment..."
                        />
                        <button
                            type="submit"
                            disabled={postingComment || !newComment.trim()}
                            className="btn btn-primary btn-sm"
                        >
                            {postingComment ? "..." : "Post"}
                        </button>
                    </div>
                </form>

                {/* Comments List */}
                {comments.length === 0 ? (
                    <p className="text-sm text-[var(--text-muted)]">No comments yet.</p>
                ) : (
                    <div className="flex flex-col gap-3">
                        {comments.map((c) => (
                            <div key={c.id} className="flex gap-3">
                                <div className="w-7 h-7 rounded-full bg-[var(--surface-2)] flex items-center justify-center text-xs shrink-0">
                                    {c.profile?.username?.[0]?.toUpperCase() || "?"}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                                        <span className="font-medium text-[var(--text)]">
                                            {c.profile?.display_name || c.profile?.username || "Anonymous"}
                                        </span>
                                        <span>{timeAgo(c.created_at)}</span>
                                    </div>
                                    <p className="text-sm mt-0.5">{c.content}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
