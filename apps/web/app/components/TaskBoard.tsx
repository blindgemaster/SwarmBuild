"use client";

import { Task } from "@/lib/api";

export function TaskBoard({ tasks }: { tasks: Task[] }) {
    const available = tasks.filter((t) => t.status === "available");
    const locked = tasks.filter((t) => t.status === "locked");
    const done = tasks.filter((t) => t.status === "completed" || t.status === "failed");
    const total = tasks.length;
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* To Do */}
                <KanbanColumn
                    title="To Do"
                    count={available.length}
                    color="text-[var(--text-muted)]"
                    borderColor="border-[var(--border)]"
                >
                    {available.map((t) => (
                        <TaskCard key={t.id} task={t} />
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

function TaskCard({ task, accentColor }: { task: Task; accentColor?: string }) {
    return (
        <div
            className="bg-[var(--surface-2)] p-2.5 rounded-lg border border-[var(--border)] text-sm transition-colors hover:border-[var(--border-hover)]"
            style={accentColor ? { borderLeftWidth: 3, borderLeftColor: accentColor } : undefined}
        >
            <div className="font-medium text-[var(--text)] mb-1.5 text-[13px]">{task.title}</div>
            <div className="flex items-center justify-between">
                {task.assigned_role && (
                    <span className="tag text-[10px] capitalize">
                        {task.assigned_role.replace("_", " ")}
                    </span>
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
