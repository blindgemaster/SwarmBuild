"use client";

import { Task } from "@/lib/api";

// v2: Extended task type with DAG fields
interface TaskV2 extends Task {
    depends_on?: string[];
    is_claimable?: boolean;
    blocking_tasks?: string[];
    priority_score?: number;
    verification_status?: string;
    locked_by_role?: string;
    locked_by_status?: string;
}

export function TaskBoard({ tasks }: { tasks: Task[] }) {
    const v2Tasks = tasks as TaskV2[];
    // Split available tasks into claimable and blocked
    const claimable = v2Tasks.filter((t) => t.status === "available" && t.is_claimable !== false);
    const blocked = v2Tasks.filter((t) => t.status === "available" && t.is_claimable === false);
    const locked = v2Tasks.filter((t) => t.status === "locked");
    const done = v2Tasks.filter((t) => t.status === "completed" || t.status === "failed");
    const total = v2Tasks.length;
    const completed = done.length;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

    return (
        <div className="animate-fade-in">
            {/* Progress bar */}
            <div className="flex items-center gap-3 mb-5">
                <div className="progress-bar flex-1">
                    <div className="progress-fill" style={{ width: `${progress}%` }} />
                </div>
                <span className="text-xs font-medium text-[var(--text-muted)] whitespace-nowrap">
                    {completed}/{total} done
                </span>
            </div>

            {/* Kanban columns */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                {/* Ready (claimable) */}
                <KanbanColumn
                    title="Ready"
                    count={claimable.length}
                    color="text-[var(--accent)]"
                    borderColor="border-[var(--accent)]/20"
                >
                    {claimable.map((t) => (
                        <TaskCard key={t.id} task={t} accentColor="var(--accent)" />
                    ))}
                </KanbanColumn>

                {/* Blocked (waiting on deps) */}
                <KanbanColumn
                    title="Blocked"
                    count={blocked.length}
                    color="text-[var(--text-muted)]"
                    borderColor="border-[var(--border)]"
                >
                    {blocked.map((t) => (
                        <TaskCard key={t.id} task={t} blocked />
                    ))}
                </KanbanColumn>

                {/* In Progress */}
                <KanbanColumn
                    title="In Progress"
                    count={locked.length}
                    color="text-[var(--orange)]"
                    borderColor="border-orange-500/20"
                >
                    {locked.map((t) => (
                        <TaskCard key={t.id} task={t} accentColor="var(--orange)" />
                    ))}
                </KanbanColumn>

                {/* Done */}
                <KanbanColumn
                    title="Done"
                    count={done.length}
                    color="text-[var(--green)]"
                    borderColor="border-green-500/20"
                >
                    {done.map((t) => (
                        <TaskCard
                            key={t.id}
                            task={t}
                            accentColor={t.status === "completed" ? "var(--green)" : "var(--red)"}
                        />
                    ))}
                </KanbanColumn>
            </div>
        </div>
    );
}

function KanbanColumn({
    title,
    count,
    color,
    borderColor,
    children,
}: {
    title: string;
    count: number;
    color: string;
    borderColor: string;
    children: React.ReactNode;
}) {
    return (
        <div className={`rounded-xl bg-[var(--surface)] border ${borderColor} p-3 min-h-[180px]`}>
            <div className="flex items-center justify-between mb-3">
                <h3 className={`text-xs font-semibold uppercase tracking-wide ${color}`}>
                    {title}
                </h3>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--surface-2)] ${color}`}>
                    {count}
                </span>
            </div>
            <div className="flex flex-col gap-2">{children}</div>
        </div>
    );
}

function TaskCard({ task, accentColor, blocked }: { task: Task; accentColor?: string; blocked?: boolean }) {
    const v2 = task as TaskV2;
    return (
        <div
            className={`bg-[var(--surface-2)] p-2.5 rounded-lg border border-[var(--border)] text-sm transition-colors hover:border-[var(--border-hover)] ${blocked ? "opacity-60" : ""}`}
            style={accentColor ? { borderLeftWidth: 3, borderLeftColor: accentColor } : undefined}
        >
            <div className="font-medium text-[var(--text)] mb-1.5 text-[13px]">
                {blocked && <span className="mr-1" title="Waiting on dependencies">🔒</span>}
                {task.title}
            </div>
            <div className="flex items-center justify-between flex-wrap gap-1">
                {task.assigned_role && (
                    <span className="tag text-[10px] capitalize">
                        {task.assigned_role.replace("_", " ")}
                    </span>
                )}
                {blocked && v2.blocking_tasks && v2.blocking_tasks.length > 0 && (
                    <span className="text-[10px] text-[var(--text-muted)] truncate max-w-[120px]" title={v2.blocking_tasks.join(", ")}>
                        waiting: {v2.blocking_tasks[0]}{v2.blocking_tasks.length > 1 ? ` +${v2.blocking_tasks.length - 1}` : ""}
                    </span>
                )}
                {task.status === "locked" && v2.locked_by_role && (
                    <span className="text-[10px] text-[var(--orange)] font-medium capitalize">
                        {v2.locked_by_status === "disconnected" ? "⚠ " : ""}
                        {v2.locked_by_role} agent
                    </span>
                )}
                {v2.verification_status && v2.verification_status !== "none" && (
                    <span className="text-[10px] text-[var(--orange)]">{v2.verification_status}</span>
                )}
                {(task.status === "completed" || task.status === "failed") && (
                    <span
                        className="text-[10px] font-bold uppercase"
                        style={{ color: task.status === "completed" ? "var(--green)" : "var(--red)" }}
                    >
                        {task.status}
                    </span>
                )}
            </div>
        </div>
    );
}
