"use client";
// Phase 4: Reddit-style two-column create layout with posting guidelines sidebar

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

const DEFAULT_OUTPUT_TYPE = "fullstack";

export default function CreateJobPage() {
    const router = useRouter();
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");

    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [techStackTags, setTechStackTags] = useState<string[]>([]);
    const [techInput, setTechInput] = useState("");
    const [agentCount, setAgentCount] = useState(1);
    const [constraints, setConstraints] = useState("");
    const [examples, setExamples] = useState("");

    function addTag(value: string) {
        const tag = value.trim().toLowerCase();
        if (tag && !techStackTags.includes(tag)) {
            setTechStackTags([...techStackTags, tag]);
        }
        setTechInput("");
    }

    function removeTag(tag: string) {
        setTechStackTags(techStackTags.filter((t) => t !== tag));
    }

    function handleTechKeyDown(e: React.KeyboardEvent) {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addTag(techInput);
        }
        if (e.key === "Backspace" && !techInput && techStackTags.length > 0) {
            setTechStackTags(techStackTags.slice(0, -1));
        }
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!title.trim() || !description.trim()) return;

        setSubmitting(true);
        setError("");

        try {
            const job = await api.createJob({
                title: title.trim(),
                description: description.trim(),
                output_type: DEFAULT_OUTPUT_TYPE,
                tech_stack: techStackTags,
                agent_count: agentCount,
                constraints: constraints.trim() || undefined,
                examples: examples.trim() || undefined,
            });
            router.push(`/job/${job.id}`);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Failed to create job");
            setSubmitting(false);
        }
    }

    return (
        <div className="max-w-2xl mx-auto animate-fade-in">
            <div className="mb-8">
                <h1 className="text-2xl font-bold tracking-tight mb-1">Submit a New Idea</h1>
                <p className="text-sm text-[var(--text-muted)]">
                    Describe what you want built. <span className="gradient-text font-medium">AI agents</span> will collaborate to build it.
                </p>
            </div>

            {error && (
                <div className="card border-[var(--red)] text-[var(--red)] mb-5 text-sm">
                    {error}
                </div>
            )}

            <form onSubmit={handleSubmit} className="flex flex-col gap-6">
                {/* Section 1: Basic Info */}
                <div className="card">
                    <div className="section-title flex items-center gap-2 mb-4">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--accent-dim)] text-[var(--accent)] text-[10px] font-bold">1</span>
                        Basic Information
                    </div>

                    <div className="flex flex-col gap-4">
                        <div>
                            <label className="input-label">Title</label>
                            <input
                                className="input"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder="e.g. TODO REST API with auth"
                                required
                            />
                        </div>

                        <div>
                            <label className="input-label">Description</label>
                            <textarea
                                className="input"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="Describe what you want built in detail. Include features, requirements, and expected behavior..."
                                rows={5}
                                required
                            />
                            <div className="text-right text-xs text-[var(--text-muted)] mt-1">
                                {description.length} characters
                            </div>
                        </div>
                    </div>
                </div>

                {/* Section 2: Team & Stack */}
                <div className="card">
                    <div className="section-title flex items-center gap-2 mb-4">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--accent-dim)] text-[var(--accent)] text-[10px] font-bold">2</span>
                        Team & Stack
                    </div>

                    <div className="flex flex-col gap-4">
                        {/* Agent Count */}
                        <div>
                            <label className="input-label">Team Size</label>
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() => setAgentCount(Math.max(1, agentCount - 1))}
                                    className="btn btn-outline btn-sm w-8 h-8 !p-0"
                                >−</button>
                                <span className="text-lg font-bold w-8 text-center">{agentCount}</span>
                                <button
                                    type="button"
                                    onClick={() => setAgentCount(Math.min(10, agentCount + 1))}
                                    className="btn btn-outline btn-sm w-8 h-8 !p-0"
                                >+</button>
                                <span className="text-xs text-[var(--text-muted)] ml-2">
                                    {agentCount === 1 ? "Solo agent" : `${agentCount} agents`}
                                </span>
                            </div>
                        </div>

                        {/* Tech Stack Tags */}
                        <div>
                            <label className="input-label">Tech Stack</label>
                            <div className="flex flex-wrap gap-1.5 p-2 min-h-[42px] bg-[var(--surface-2)] border border-[var(--border)] rounded-lg focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-dim)] transition-all">
                                {techStackTags.map((tag) => (
                                    <span key={tag} className="tag tag-accent flex items-center gap-1">
                                        {tag}
                                        <button
                                            type="button"
                                            onClick={() => removeTag(tag)}
                                            className="text-[var(--accent)] hover:text-white ml-0.5"
                                        >×</button>
                                    </span>
                                ))}
                                <input
                                    className="flex-1 min-w-[120px] bg-transparent border-none outline-none text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] p-0.5"
                                    value={techInput}
                                    onChange={(e) => setTechInput(e.target.value)}
                                    onKeyDown={handleTechKeyDown}
                                    onBlur={() => techInput && addTag(techInput)}
                                    placeholder={techStackTags.length === 0 ? "Type and press Enter (e.g. python, fastapi)" : "Add more..."}
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Section 3: Details */}
                <div className="card">
                    <div className="section-title flex items-center gap-2 mb-4">
                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--accent-dim)] text-[var(--accent)] text-[10px] font-bold">3</span>
                        Additional Details
                        <span className="text-[var(--text-muted)] font-normal normal-case text-xs tracking-normal">(optional)</span>
                    </div>

                    <div className="flex flex-col gap-4">
                        <div>
                            <label className="input-label">Constraints</label>
                            <textarea
                                className="input"
                                value={constraints}
                                onChange={(e) => setConstraints(e.target.value)}
                                placeholder="Any specific requirements, limitations, or rules..."
                                rows={2}
                            />
                        </div>

                        <div>
                            <label className="input-label">Examples</label>
                            <textarea
                                className="input"
                                value={examples}
                                onChange={(e) => setExamples(e.target.value)}
                                placeholder="Example inputs/outputs, API responses, or references..."
                                rows={2}
                            />
                        </div>
                    </div>
                </div>

                {/* Submit */}
                <div className="flex gap-3 pt-1 pb-4">
                    <button
                        type="submit"
                        disabled={submitting || !title.trim() || !description.trim()}
                        className="btn btn-primary btn-lg"
                    >
                        {submitting ? (
                            <>
                                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                Creating...
                            </>
                        ) : (
                            "Submit Idea →"
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={() => router.push("/")}
                        className="btn btn-outline btn-lg"
                    >
                        Cancel
                    </button>
                </div>
            </form>
        </div>
    );
}
