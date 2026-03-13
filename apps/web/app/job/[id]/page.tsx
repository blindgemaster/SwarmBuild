"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, Job, PlanResponse, Comment, Contributor, Task, Message } from "@/lib/api";
import { useAuth } from "@/app/components/AuthProvider";
import { StatusBadge } from "@/app/components/StatusBadge";
import { TabGroup } from "@/app/components/TabGroup";
import { TaskBoard } from "@/app/components/TaskBoard";
import { LogViewer } from "@/app/components/LogViewer";
import { LobbyPanel } from "@/app/components/LobbyPanel";
import { PlanEditor } from "@/app/components/PlanEditor";
import { CommentThread } from "@/app/components/CommentThread";
import { VoteBox } from "@/app/components/VoteBox";
import { LobbyChat } from "@/app/components/LobbyChat";
import { CostDashboard } from "@/app/components/CostDashboard";
import { ReviewPanel } from "@/app/components/ReviewPanel";
import { MergeQueue } from "@/app/components/MergeQueue";
import { AuditLog } from "@/app/components/AuditLog";

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
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const jobId = params.id as string;

    const [job, setJob] = useState<Job | null>(null);
    const [plan, setPlan] = useState<PlanResponse | null>(null);
    const [comments, setComments] = useState<Comment[]>([]);
    const [contributors, setContributors] = useState<Contributor[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [messages, setMessages] = useState<Message[]>([]);
    const [logs, setLogs] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [activeTab, setActiveTab] = useState(searchParams.get("tab") || "overview");

    // Action states
    const [generatingPlan, setGeneratingPlan] = useState(false);
    const [actionMessage, setActionMessage] = useState("");
    const [approvingJob, setApprovingJob] = useState(false);
    const [completingJob, setCompletingJob] = useState(false);
    const [cancellingJob, setCancellingJob] = useState(false);

    // Plan/Role editing states
    const [editingRoles, setEditingRoles] = useState<string[]>([]);
    const [newRole, setNewRole] = useState("");
    const [savingRoles, setSavingRoles] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState("");
    const [editingTaskList, setEditingTaskList] = useState<string[]>([]);
    const [newTaskItem, setNewTaskItem] = useState("");
    const [savingPlan, setSavingPlan] = useState(false);
    const planInitializedRef = useRef(false);
    const [isMounted, setIsMounted] = useState(false);

    const loadJob = useCallback(async () => {
        try {
            const [jobData, planData, commentsData, contributorsData, tasksData, messagesData] = await Promise.all([
                api.getJob(jobId),
                api.getPlan(jobId).catch(() => null),
                api.getComments(jobId).catch(() => ({ comments: [] })),
                api.listContributors(jobId).catch(() => ({ contributors: [], total: 0 })),
                api.listJobTasks(jobId).catch(() => ({ tasks: [] })),
                api.getMessages(jobId).catch(() => ({ messages: [] as Message[] })),
            ]);
            setJob(jobData);
            setPlan(planData);
            setComments(commentsData.comments || []);
            setContributors(contributorsData.contributors || []);
            setTasks(tasksData.tasks || []);
            setMessages(messagesData.messages || []);
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
                    setActiveTab("plan");
                }
                // Auto-switch to execution tab on first load only
                if (jobData.status === "running" || jobData.status === "complete") {
                    setActiveTab("execution");
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

        api.getJobLogs(jobId).then(data => {
            if (data.logs?.length) setLogs(data.logs);
        }).catch(() => { });

        // Polling fallback — refresh data every 8 seconds for reliable realtime
        const pollInterval = setInterval(() => { loadJob(); }, 8000);

        // WebSocket for instant updates (best-effort, with reconnection)
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || "https://swarmbuild.onrender.com";
        const wsUrl = apiUrl.replace(/^http/, "ws");
        let ws: WebSocket | null = null;
        let logWs: WebSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

        function connectLobbyWs() {
            try {
                ws = new WebSocket(`${wsUrl}/api/jobs/${jobId}/lobby/ws`);
                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === "lobby_state_change" || data.type === "new_message" || data.type === "task_updated") {
                            loadJob();
                        }
                    } catch { }
                };
                ws.onclose = () => {
                    reconnectTimer = setTimeout(connectLobbyWs, 5000);
                };
                ws.onerror = () => { ws?.close(); };
            } catch { }
        }

        function connectLogWs() {
            try {
                logWs = new WebSocket(`${wsUrl}/api/logs/${jobId}`);
                logWs.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === "log" && data.content) {
                            setLogs(prev => [...prev, data.content].slice(-200));
                        }
                    } catch { }
                };
                logWs.onclose = () => {
                    setTimeout(connectLogWs, 5000);
                };
                logWs.onerror = () => { logWs?.close(); };
            } catch { }
        }

        connectLobbyWs();
        connectLogWs();

        return () => {
            clearInterval(pollInterval);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            ws?.close();
            logWs?.close();
        };
    }, [loadJob, jobId]);

    // ── Handlers ────────────────────

    async function handleGeneratePlan() {
        setGeneratingPlan(true);
        setActionMessage("");
        try {
            await api.generatePlan(jobId);
            setActionMessage("Plan generation started...");
            for (let i = 0; i < 30; i++) {
                await new Promise((r) => setTimeout(r, 2000));
                const planData = await api.getPlan(jobId);
                if (planData.plan_ready) {
                    setPlan(planData);
                    const updatedJob = await api.getJob(jobId);
                    setJob(updatedJob);
                    const roles = updatedJob.required_roles?.length
                        ? [...updatedJob.required_roles]
                        : Array(updatedJob.required_agent_count || 1).fill("teammate");
                    if (!roles.includes("lead")) roles.unshift("lead");
                    setEditingRoles(roles);
                    planInitializedRef.current = false;
                    setEditingPrompt(planData.agent_prompt || "");
                    setEditingTaskList(planData.task_list || []);
                    planInitializedRef.current = true;
                    setActionMessage("Plan generated!");
                    setActiveTab("plan");
                    break;
                }
                if (planData.status === "failed") {
                    setActionMessage("Plan generation failed.");
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
        setApprovingJob(true);
        try {
            await api.approveJob(jobId);
            setActionMessage("Job approved! Contributors can now join.");
            setActiveTab("team");
            loadJob();
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        } finally { setApprovingJob(false); }
    }

    async function handleMarkComplete() {
        if (!confirm("Mark this job as complete?")) return;
        setCompletingJob(true);
        try {
            await api.completeJob(jobId);
            setActionMessage("Job marked complete!");
            loadJob();
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        } finally { setCompletingJob(false); }
    }

    async function handleDelete() {
        if (!confirm("Cancel this job?")) return;
        setCancellingJob(true);
        try {
            await api.deleteJob(jobId);
            router.push("/");
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
            setCancellingJob(false);
        }
    }

    async function handleSaveRoles() {
        setSavingRoles(true);
        try {
            await api.updateRoles(jobId, editingRoles);
            setActionMessage("Roles updated!");
            loadJob();
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        } finally { setSavingRoles(false); }
    }

    async function handleSavePlan() {
        setSavingPlan(true);
        try {
            await api.updatePlan(jobId, { agent_prompt: editingPrompt, task_list: editingTaskList });
            setPlan(prev => prev ? { ...prev, agent_prompt: editingPrompt, task_list: editingTaskList } : prev);
            setActionMessage("Plan saved!");
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        } finally { setSavingPlan(false); }
    }

    async function handleContribute(role: string) {
        try {
            const result = await api.contribute(jobId, role) as Record<string, string>;
            if (result.worker_token) {
                setActionMessage(`Joined! CLI command:\n${result.cli_command}`);
            }
            loadJob();
        } catch (e: unknown) {
            setActionMessage(e instanceof Error ? e.message : "Failed");
        }
    }

    async function handleToggleReady(isReady: boolean) {
        try { await api.toggleReady(jobId, isReady); loadJob(); }
        catch (e: unknown) { setActionMessage(e instanceof Error ? e.message : "Failed"); }
    }

    // ── Render ──────────────────────

    if (!isMounted || loading) {
        return (
            <div className="flex items-center justify-center py-20" suppressHydrationWarning>
                <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    if (error || !job) {
        return (
            <div className="text-center py-16">
                <p className="text-[var(--red)] mb-4">{error || "Job not found"}</p>
                <Link href="/" className="btn btn-outline">← Back</Link>
            </div>
        );
    }

    // Build tabs dynamically
    const tabs: { key: string; label: string; count?: number }[] = [
        { key: "overview", label: "Overview" },
    ];
    if (plan?.plan_ready || job.status === "plan_ready") {
        tabs.push({ key: "plan", label: job.status === "plan_ready" ? "Plan & Roles ✏️" : "Plan" });
    }
    if (job.status === "approved" || job.status === "running") {
        tabs.push({ key: "team", label: "Team", count: contributors.length });
    }
    if (job.status === "running" || job.status === "complete") {
        tabs.push({ key: "execution", label: "Execution", count: tasks.length });
    }
    if (job.status === "running" || job.status === "complete") {
        tabs.push({ key: "costs", label: "Costs" });
    }
    tabs.push({ key: "discussion", label: "Discussion", count: comments.length });

    return (
        <div className="animate-fade-in" suppressHydrationWarning>
            {/* Breadcrumb */}
            <Link href="/" className="text-sm text-[var(--text-muted)] hover:text-[var(--accent)] mb-5 inline-flex items-center gap-1 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                Back to jobs
            </Link>

            {/* Two-column layout */}
            <div className="flex gap-6 items-start">
                {/* ── Left: Main content ── */}
                <div className="flex-1 min-w-0">

                    {/* Header */}
                    <div className="flex items-start justify-between gap-4 mb-3">
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                                <h1 className="text-2xl font-bold tracking-tight">{job.title}</h1>
                                <StatusBadge status={job.status} />
                            </div>
                            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] flex-wrap">
                                <Link href={`/profile/${job.poster_id}`} className="font-medium text-[var(--text)] hover:text-[var(--accent)] transition-colors">{job.poster_profile?.display_name || job.poster_profile?.username || "Anonymous"}</Link>
                                <span>·</span>
                                <span className="tag">{job.output_type}</span>
                                {job.tech_stack?.length > 0 && (
                                    <div className="flex gap-1 flex-wrap">
                                        {job.tech_stack.map(t => <span key={t} className="tag">{t}</span>)}
                                    </div>
                                )}
                                <span>·</span>
                                <span>posted {timeAgo(job.created_at)}</span>
                            </div>
                        </div>
                        <VoteBox jobId={jobId} initialCount={job.vote_count ?? 0} vertical={false} />
                    </div>

                    {/* GitHub Repo Widget */}
                    {(job.github_repo_id || job.github_repo) && (() => {
                        const repoId = job.github_repo_id || job.github_repo!;
                        return (
                            <div className="card flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-5 mt-4 border-indigo-500/20">
                                <div className="flex items-center gap-3">
                                    <div className="w-9 h-9 rounded-lg bg-[var(--surface-2)] flex items-center justify-center border border-[var(--border)] shrink-0">
                                        <svg className="w-5 h-5 text-[var(--text)]" fill="currentColor" viewBox="0 0 24 24">
                                            <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                                        </svg>
                                    </div>
                                    <div className="min-w-0">
                                        <div className="text-xs text-[var(--text-muted)] mb-0.5">Repository</div>
                                        <a href={`https://github.com/${repoId}`} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--accent-hover)] hover:underline font-medium break-all">
                                            {repoId}
                                        </a>
                                    </div>
                                </div>
                                {(job.status === "running" || job.status === "complete") && (
                                    <a href={`https://github.com/${repoId}/commits/main`} target="_blank" rel="noopener noreferrer" className="btn btn-outline btn-sm">
                                        {job.status === "running" && <span className="live-dot mr-1" />}
                                        View commits →
                                    </a>
                                )}
                            </div>
                        );
                    })()}

                    {/* Action Message */}
                    {actionMessage && (
                        <div className="card mb-4 text-sm whitespace-pre-wrap border-[var(--accent)]/30 bg-[var(--accent-dim)]">
                            <div className="flex items-start justify-between gap-2">
                                <span className="flex-1">{actionMessage}</span>
                                <div className="flex items-center gap-1 shrink-0">
                                    {actionMessage.includes("npx swarmbuild") && (
                                        <button
                                            onClick={() => {
                                                const cmd = actionMessage.split("\n").find((l: string) => l.includes("npx swarmbuild"));
                                                if (cmd) navigator.clipboard.writeText(cmd.trim());
                                            }}
                                            className="text-[var(--accent)] hover:text-white text-xs px-2 py-1 rounded border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors"
                                            title="Copy CLI command"
                                        >
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                                        </button>
                                    )}
                                    <button onClick={() => setActionMessage("")} className="text-[var(--text-muted)] hover:text-white text-xs px-1">✕</button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Actions Bar — poster-only controls */}
                    {(() => {
                        const isPoster = user?.id === job.poster_id;
                        return isPoster ? (
                            <div className="flex flex-col gap-2 mb-5">
                                <div className="flex gap-2 flex-wrap">
                                    {(job.status === "pending" || job.status === "plan_ready") && (
                                        <button onClick={handleGeneratePlan} disabled={generatingPlan} className="btn btn-primary">
                                            {generatingPlan ? (
                                                <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Generating...</>
                                            ) : "🧠 Generate Plan"}
                                        </button>
                                    )}
                                    {job.status === "plan_ready" && (
                                        <button onClick={handleApprove} disabled={approvingJob} className="btn btn-primary">
                                            {approvingJob ? (
                                                <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Approving...</>
                                            ) : "✅ Approve Plan"}
                                        </button>
                                    )}
                                    {(job.status === "running" || job.status === "approved") && (
                                        <button onClick={handleMarkComplete} disabled={completingJob} className="btn btn-outline">
                                            {completingJob ? (
                                                <><span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />Completing...</>
                                            ) : "🏁 Mark Complete"}
                                        </button>
                                    )}
                                    {job.status !== "complete" && job.status !== "cancelled" && (
                                        <button onClick={handleDelete} disabled={cancellingJob} className="btn btn-danger btn-sm">
                                            {cancellingJob ? (
                                                <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Cancelling...</>
                                            ) : "Cancel"}
                                        </button>
                                    )}
                                </div>
                                {(job.status === "pending" || job.status === "plan_ready") && comments.length > 0 && (
                                    <p className="text-xs text-[var(--text-muted)]">
                                        Plan generation will include {comments.length} discussion comment{comments.length !== 1 ? "s" : ""} as context.
                                    </p>
                                )}
                            </div>
                        ) : null;
                    })()}

                    {/* Tabs */}
                    <TabGroup tabs={tabs} active={activeTab} onChange={setActiveTab} />

                    {/* Tab Content */}
                    <div className="min-h-[300px]">
                        {activeTab === "overview" && (
                            <div className="flex flex-col gap-5 animate-fade-in">
                                <div className="card">
                                    <div className="section-title">Description</div>
                                    <p className="text-sm leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]">
                                        {job.description}
                                    </p>
                                    {job.constraints && (
                                        <>
                                            <div className="section-title mt-5">Constraints</div>
                                            <p className="text-sm text-[var(--text-muted)]">{job.constraints}</p>
                                        </>
                                    )}
                                    {job.examples && (
                                        <>
                                            <div className="section-title mt-5">Examples</div>
                                            <p className="text-sm text-[var(--text-muted)]">{job.examples}</p>
                                        </>
                                    )}
                                </div>

                                {/* Read-only plan preview for non-plan_ready */}
                                {plan?.plan_ready && job.status !== "plan_ready" && (
                                    <PlanEditor
                                        plan={plan}
                                        editable={false}
                                        editingPrompt={editingPrompt}
                                        setEditingPrompt={setEditingPrompt}
                                        editingTaskList={editingTaskList}
                                        setEditingTaskList={setEditingTaskList}
                                        editingRoles={editingRoles}
                                        setEditingRoles={setEditingRoles}
                                        newRole={newRole}
                                        setNewRole={setNewRole}
                                        newTaskItem={newTaskItem}
                                        setNewTaskItem={setNewTaskItem}
                                        onSavePlan={handleSavePlan}
                                        savingPlan={savingPlan}
                                        onSaveRoles={handleSaveRoles}
                                        savingRoles={savingRoles}
                                        onAddRole={() => {
                                            if (newRole.trim()) { setEditingRoles([...editingRoles, newRole.trim()]); setNewRole(""); }
                                        }}
                                        onRemoveRole={(i) => { if (editingRoles[i] !== "lead") setEditingRoles(editingRoles.filter((_, j) => j !== i)); }}
                                        agentCount={job.required_agent_count || 1}
                                    />
                                )}
                            </div>
                        )}

                        {activeTab === "plan" && (
                            <PlanEditor
                                plan={plan}
                                editable={job.status === "plan_ready"}
                                editingPrompt={editingPrompt}
                                setEditingPrompt={setEditingPrompt}
                                editingTaskList={editingTaskList}
                                setEditingTaskList={setEditingTaskList}
                                editingRoles={editingRoles}
                                setEditingRoles={setEditingRoles}
                                newRole={newRole}
                                setNewRole={setNewRole}
                                newTaskItem={newTaskItem}
                                setNewTaskItem={setNewTaskItem}
                                onSavePlan={handleSavePlan}
                                savingPlan={savingPlan}
                                onSaveRoles={handleSaveRoles}
                                savingRoles={savingRoles}
                                onAddRole={() => {
                                    if (newRole.trim()) { setEditingRoles([...editingRoles, newRole.trim()]); setNewRole(""); }
                                }}
                                onRemoveRole={(i) => { if (editingRoles[i] !== "lead") setEditingRoles(editingRoles.filter((_, j) => j !== i)); }}
                                agentCount={job.required_agent_count || 1}
                            />
                        )}

                        {activeTab === "team" && (
                            <div className="flex flex-col gap-6">
                                <LobbyPanel
                                    job={job}
                                    contributors={contributors}
                                    onContribute={handleContribute}
                                    onToggleReady={handleToggleReady}
                                />
                                <LobbyChat jobId={jobId} initialMessages={messages} />
                            </div>
                        )}

                        {activeTab === "execution" && (
                            <div className="flex flex-col gap-6">
                                {tasks.length > 0 && <TaskBoard tasks={tasks} />}
                                <ReviewPanel jobId={jobId} apiUrl={process.env.NEXT_PUBLIC_API_URL || "https://swarmbuild.onrender.com"} />
                                <MergeQueue jobId={jobId} apiUrl={process.env.NEXT_PUBLIC_API_URL || "https://swarmbuild.onrender.com"} />
                                <LobbyChat jobId={jobId} initialMessages={messages} />
                                <LogViewer logs={logs} />
                            </div>
                        )}

                        {activeTab === "costs" && (
                            <div className="flex flex-col gap-6">
                                <CostDashboard jobId={jobId} apiUrl={process.env.NEXT_PUBLIC_API_URL || "https://swarmbuild.onrender.com"} />
                                <AuditLog jobId={jobId} apiUrl={process.env.NEXT_PUBLIC_API_URL || "https://swarmbuild.onrender.com"} />
                            </div>
                        )}

                        {activeTab === "discussion" && (
                            <div className="flex flex-col gap-4">
                                <div style={{
                                    padding: "10px 14px",
                                    background: "var(--accent-dim)",
                                    border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
                                    borderRadius: 6,
                                    fontSize: 13,
                                    color: "var(--text-secondary)",
                                    lineHeight: 1.5,
                                }}>
                                    <span style={{ fontWeight: 600, color: "var(--accent-hover)", marginRight: 6 }}>Tip:</span>
                                    Comments here are used to refine the AI-generated plan. Share requirements, edge cases, or preferences to help shape the build.
                                </div>
                                <CommentThread
                                    jobId={jobId}
                                    initialComments={comments}
                                />
                            </div>
                        )}
                    </div>

                </div>{/* end left col */}

                {/* ── Right: Job Info Sidebar ── */}
                <div className="hidden lg:flex flex-col gap-3 w-64 flex-shrink-0 sticky top-20">
                    {/* Status */}
                    <div className="sidebar-widget">
                        <div className="sidebar-widget-header">📋 Job Info</div>
                        <div className="sidebar-widget-body" style={{ padding: "10px 12px" }}>
                            <div className="flex items-center justify-between py-1.5 text-sm border-b border-[var(--border)]">
                                <span className="text-[var(--text-muted)]">Status</span>
                                <StatusBadge status={job.status} />
                            </div>
                            <div className="flex items-center justify-between py-1.5 text-sm border-b border-[var(--border)]">
                                <span className="text-[var(--text-muted)]">Type</span>
                                <span className="text-xs font-medium">{job.output_type}</span>
                            </div>
                            <div className="flex items-center justify-between py-1.5 text-sm border-b border-[var(--border)]">
                                <span className="text-[var(--text-muted)]">Votes</span>
                                <span className="text-xs font-bold text-[var(--vote-up)]">▲ {job.vote_count ?? 0}</span>
                            </div>
                            <div className="flex items-center justify-between py-1.5 text-sm border-b border-[var(--border)]">
                                <span className="text-[var(--text-muted)]">Team Size</span>
                                <span className="text-xs font-medium">{job.required_roles?.length || job.required_agent_count || 1}</span>
                            </div>
                            <div className="flex items-center justify-between py-1.5 text-sm border-b border-[var(--border)]">
                                <span className="text-[var(--text-muted)]">Contributors</span>
                                <span className="text-xs font-medium">{contributors.length} / {job.required_roles?.length || job.required_agent_count || 1}</span>
                            </div>
                            <div className="flex items-center justify-between py-1.5 text-sm border-b border-[var(--border)]">
                                <span className="text-[var(--text-muted)]">Tasks</span>
                                <span className="text-xs font-medium">{tasks.length}</span>
                            </div>
                            <div className="flex items-center justify-between py-1.5 text-sm">
                                <span className="text-[var(--text-muted)]">Comments</span>
                                <span className="text-xs font-medium">{comments.length}</span>
                            </div>
                        </div>
                    </div>

                    {/* Tech stack */}
                    {job.tech_stack && job.tech_stack.length > 0 && (
                        <div className="sidebar-widget">
                            <div className="sidebar-widget-header">🛠️ Tech Stack</div>
                            <div className="sidebar-widget-body flex flex-wrap gap-1">
                                {job.tech_stack.map(t => <span key={t} className="tag tag-accent">{t}</span>)}
                            </div>
                        </div>
                    )}

                    {/* Required roles */}
                    {job.required_roles && job.required_roles.length > 0 && (
                        <div className="sidebar-widget">
                            <div className="sidebar-widget-header">👥 Required Roles</div>
                            <div className="sidebar-widget-body flex flex-col gap-1">
                                {job.required_roles.map(r => (
                                    <div key={r} className="flex items-center gap-2">
                                        <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
                                        <span className="text-sm">{r}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* GitHub link */}
                    {job.github_repo_id && (
                        <a
                            href={`https://github.com/${job.github_repo_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-outline w-full"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
                            </svg>
                            View on GitHub
                        </a>
                    )}
                </div>

            </div>{/* end two-col */}
        </div>
    );
}
