"use client";

import { PlanResponse } from "@/lib/api";

export function PlanEditor({
    plan,
    editable,
    editingPrompt,
    setEditingPrompt,
    editingTaskList,
    setEditingTaskList,
    editingRoles,
    setEditingRoles,
    newRole,
    setNewRole,
    newTaskItem,
    setNewTaskItem,
    onSavePlan,
    savingPlan,
    onSaveRoles,
    savingRoles,
    onAddRole,
    onRemoveRole,
    agentCount,
}: {
    plan: PlanResponse | null;
    editable: boolean;
    editingPrompt: string;
    setEditingPrompt: (v: string) => void;
    editingTaskList: string[];
    setEditingTaskList: (v: string[]) => void;
    editingRoles: string[];
    setEditingRoles: (v: string[]) => void;
    newRole: string;
    setNewRole: (v: string) => void;
    newTaskItem: string;
    setNewTaskItem: (v: string) => void;
    onSavePlan: () => void;
    savingPlan: boolean;
    onSaveRoles: () => void;
    savingRoles: boolean;
    onAddRole: () => void;
    onRemoveRole: (i: number) => void;
    agentCount: number;
}) {
    if (!plan?.plan_ready) {
        return (
            <div className="text-center py-12 text-[var(--text-muted)] animate-fade-in">
                <div className="text-3xl mb-3">📋</div>
                <p>No plan generated yet.</p>
            </div>
        );
    }

    if (editable) {
        return (
            <div className="flex flex-col gap-6 animate-fade-in">
                {/* Role Editor */}
                <div className="card border-[var(--accent)]/20">
                    <div className="section-title flex items-center gap-2">
                        <span>🕵️</span> Team Composition
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mb-3">
                        Agent count: {agentCount}. Edit roles before approving.
                    </p>
                    <div className="flex flex-wrap gap-2 mb-3">
                        {editingRoles.map((role, idx) => (
                            <span
                                key={idx}
                                className={`tag flex items-center gap-1 ${role === "lead" ? "tag-accent" : ""
                                    }`}
                            >
                                <span className="capitalize">{role.replace("_", " ")}</span>
                                {role === "lead" ? (
                                    <span className="text-[9px] opacity-50">req</span>
                                ) : (
                                    <button
                                        onClick={() => onRemoveRole(idx)}
                                        className="text-[var(--red)] hover:text-white ml-0.5 text-xs"
                                    >
                                        ×
                                    </button>
                                )}
                            </span>
                        ))}
                    </div>
                    <div className="flex items-center gap-2">
                        <input
                            className="input flex-1 text-sm"
                            placeholder="Add role (e.g. security-auditor)"
                            value={newRole}
                            onChange={(e) => setNewRole(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && onAddRole()}
                        />
                        <button onClick={onAddRole} className="btn btn-outline btn-sm">Add</button>
                        <button onClick={onSaveRoles} disabled={savingRoles} className="btn btn-primary btn-sm">
                            {savingRoles ? "Saving..." : "Save Roles"}
                        </button>
                    </div>
                </div>

                {/* Editable Task List */}
                <div className="card">
                    <div className="section-title">Tasks ({editingTaskList.length})</div>
                    <div className="flex flex-col gap-2 mb-3">
                        {editingTaskList.map((task, i) => (
                            <div key={i} className="flex items-center gap-2">
                                <span className="text-xs text-[var(--text-muted)] w-5 shrink-0 text-right">
                                    {i + 1}.
                                </span>
                                <input
                                    className="input flex-1 text-sm"
                                    value={task}
                                    onChange={(e) => {
                                        const updated = [...editingTaskList];
                                        updated[i] = e.target.value;
                                        setEditingTaskList(updated);
                                    }}
                                />
                                <button
                                    onClick={() =>
                                        setEditingTaskList(editingTaskList.filter((_, j) => j !== i))
                                    }
                                    className="text-[var(--red)] hover:text-white text-sm px-2 shrink-0"
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>
                    <div className="flex items-center gap-2">
                        <input
                            className="input flex-1 text-sm"
                            placeholder="Add a task..."
                            value={newTaskItem}
                            onChange={(e) => setNewTaskItem(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && newTaskItem.trim()) {
                                    setEditingTaskList([...editingTaskList, newTaskItem.trim()]);
                                    setNewTaskItem("");
                                }
                            }}
                        />
                        <button
                            onClick={() => {
                                if (newTaskItem.trim()) {
                                    setEditingTaskList([...editingTaskList, newTaskItem.trim()]);
                                    setNewTaskItem("");
                                }
                            }}
                            className="btn btn-outline btn-sm"
                        >
                            Add
                        </button>
                    </div>
                </div>

                {/* Editable Agent Prompt */}
                <div className="card">
                    <div className="section-title">Agent Prompt</div>
                    <textarea
                        className="input w-full font-mono text-xs p-3 resize-y"
                        rows={14}
                        value={editingPrompt}
                        onChange={(e) => setEditingPrompt(e.target.value)}
                    />
                </div>

                <button
                    onClick={onSavePlan}
                    disabled={savingPlan}
                    className="btn btn-primary"
                >
                    {savingPlan ? "Saving..." : "💾 Save Plan"}
                </button>
            </div>
        );
    }

    // Read-only plan view
    return (
        <div className="flex flex-col gap-5 animate-fade-in">
            {/* Read-only tasks */}
            {plan.task_list && plan.task_list.length > 0 && (
                <div className="card">
                    <div className="section-title">
                        Tasks ({plan.task_count || plan.task_list.length})
                    </div>
                    <ol className="list-decimal list-inside text-sm space-y-1.5">
                        {plan.task_list.map((task, i) => (
                            <li key={i} className="text-[var(--text-secondary)]">{task}</li>
                        ))}
                    </ol>
                </div>
            )}

            {/* Agent Prompt (collapsible) */}
            {plan.agent_prompt && (
                <details className="card group">
                    <summary className="cursor-pointer text-sm text-[var(--accent-hover)] hover:underline font-medium">
                        View Agent Prompt
                    </summary>
                    <pre className="mt-3 text-xs bg-[var(--bg)] p-4 rounded-lg overflow-auto max-h-96 whitespace-pre-wrap text-[var(--text-secondary)]">
                        {plan.agent_prompt}
                    </pre>
                </details>
            )}

            {/* Test Harness (collapsible) */}
            {plan.test_harness && Object.keys(plan.test_harness).length > 0 && (
                <details className="card group">
                    <summary className="cursor-pointer text-sm text-[var(--accent-hover)] hover:underline font-medium">
                        View Test Harness ({Object.keys(plan.test_harness).length} files)
                    </summary>
                    {Object.entries(plan.test_harness).map(([filename, content]) => (
                        <div key={filename} className="mt-3">
                            <p className="text-xs font-mono text-[var(--text-muted)] mb-1">{filename}</p>
                            <pre className="text-xs bg-[var(--bg)] p-3 rounded-lg overflow-auto max-h-48 text-[var(--text-secondary)]">
                                {content}
                            </pre>
                        </div>
                    ))}
                </details>
            )}
        </div>
    );
}
