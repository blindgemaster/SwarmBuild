"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

const OUTPUT_TYPES = [
    { value: "rest-api", label: "REST API" },
    { value: "cli", label: "CLI Tool" },
    { value: "library", label: "Library" },
    { value: "script", label: "Script" },
    { value: "fullstack", label: "Full-Stack App" },
];

export default function CreateJobPage() {
    const router = useRouter();
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");

    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [outputType, setOutputType] = useState("rest-api");
    const [techStack, setTechStack] = useState("");
    const [agentCount, setAgentCount] = useState(1);
    const [constraints, setConstraints] = useState("");
    const [examples, setExamples] = useState("");

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!title.trim() || !description.trim()) return;

        setSubmitting(true);
        setError("");

        try {
            const job = await api.createJob({
                title: title.trim(),
                description: description.trim(),
                output_type: outputType,
                tech_stack: techStack
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
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
        <div className="max-w-2xl mx-auto">
            <h1 className="text-2xl font-bold mb-1">Submit a New Idea</h1>
            <p className="text-sm text-[var(--text-muted)] mb-6">
                Describe what you want built. AI agents will collaborate to build it.
            </p>

            {error && (
                <div className="card border-[var(--red)] text-[var(--red)] mb-4 text-sm">
                    {error}
                </div>
            )}

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                {/* Title */}
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

                {/* Description */}
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
                </div>

                {/* Output Type */}
                <div>
                    <label className="input-label">Output Type</label>
                    <div className="flex gap-2 flex-wrap">
                        {OUTPUT_TYPES.map((t) => (
                            <button
                                key={t.value}
                                type="button"
                                onClick={() => setOutputType(t.value)}
                                className={`btn btn-sm ${outputType === t.value ? "btn-primary" : "btn-outline"
                                    }`}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Agent Count */}
                <div>
                    <label className="input-label">Required Agent Count</label>
                    <input
                        type="number"
                        min="1"
                        max="10"
                        className="input"
                        value={agentCount}
                        onChange={(e) => setAgentCount(parseInt(e.target.value) || 1)}
                    />
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                        The AI will generate exactly this many distinct roles for the project team.
                    </p>
                </div>

                {/* Tech Stack */}
                <div>
                    <label className="input-label">Tech Stack (comma-separated)</label>
                    <input
                        className="input"
                        value={techStack}
                        onChange={(e) => setTechStack(e.target.value)}
                        placeholder="e.g. python, fastapi, postgresql"
                    />
                </div>

                {/* Constraints */}
                <div>
                    <label className="input-label">Constraints (optional)</label>
                    <textarea
                        className="input"
                        value={constraints}
                        onChange={(e) => setConstraints(e.target.value)}
                        placeholder="Any specific requirements, limitations, or rules..."
                        rows={2}
                    />
                </div>

                {/* Examples */}
                <div>
                    <label className="input-label">Examples (optional)</label>
                    <textarea
                        className="input"
                        value={examples}
                        onChange={(e) => setExamples(e.target.value)}
                        placeholder="Example inputs/outputs, API responses, or reference projects..."
                        rows={2}
                    />
                </div>

                {/* Submit */}
                <div className="flex gap-3 pt-2">
                    <button
                        type="submit"
                        disabled={submitting || !title.trim() || !description.trim()}
                        className="btn btn-primary"
                    >
                        {submitting ? "Creating..." : "Submit Idea →"}
                    </button>
                    <button
                        type="button"
                        onClick={() => router.push("/")}
                        className="btn btn-outline"
                    >
                        Cancel
                    </button>
                </div>
            </form>
        </div>
    );
}
