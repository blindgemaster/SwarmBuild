/**
 * Swarmbuild API Client
 *
 * All API calls go through here.
 * In dev mode, uses the dev token for auth.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const DEV_TOKEN = "dev-token-swarmbuild-test";

// ── Helpers ────────────────────────────────────────

function authHeaders(): HeadersInit {
    return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEV_TOKEN}`,
    };
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
            ...authHeaders(),
            ...options?.headers,
        },
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`API ${res.status}: ${body}`);
    }

    return res.json();
}

// ── Types ──────────────────────────────────────────

export interface Job {
    id: string;
    title: string;
    description: string;
    output_type: string;
    tech_stack: string[];
    status: string;
    poster_id: string;
    required_agent_count?: number;
    required_roles?: string[];
    constraints?: string;
    examples?: string;
    agent_prompt?: string;
    test_harness?: Record<string, string>;
    task_list?: string[];
    created_at: string;
    updated_at: string;
    active_contributors?: number;
    vote_count?: number;
    votes?: { count: number }[];
    github_repo?: string;
    github_repo_id?: string;    // full name e.g. "org/repo-name" — set on approval
    github_repo_url?: string;   // SSH clone URL
}

export interface JobListResponse {
    jobs: Job[];
    total: number;
    page: number;
    per_page: number;
}

export interface Task {
    id: string;
    job_id: string;
    title: string;
    description?: string;
    assigned_role?: string;
    status: "available" | "locked" | "completed" | "failed";
    locked_by_token?: string;
    created_at: string;
    updated_at: string;
}

export interface Contributor {
    id: string;
    user_id: string;
    role: string;
    is_ready: boolean;
    joined_at: string;
    last_seen: string | null;
    num_agents: number;
    tokens_used: number;
    sessions_run: number;
    commits_pushed: number;
    profile?: { username: string; display_name: string; avatar_url: string };
}

export interface Comment {
    id: string;
    job_id: string;
    user_id: string;
    content: string;
    created_at: string;
    profile?: { username: string; display_name: string; avatar_url: string };
}

export interface PlanResponse {
    status: string;
    plan_ready: boolean;
    agent_prompt?: string;
    test_harness?: Record<string, string>;
    task_list?: string[];
    task_count?: number;
    message?: string;
}

// ── API Functions ──────────────────────────────────

export const api = {
    // Health
    health: () => apiFetch<{ status: string }>("/api/health"),

    // Jobs
    listJobs: (page = 1, status?: string) => {
        const params = new URLSearchParams({ page: page.toString() });
        if (status) params.set("status", status);
        return apiFetch<JobListResponse>(`/api/jobs?${params}`);
    },

    getJob: (id: string) => apiFetch<Job>(`/api/jobs/${id}`),

    createJob: (data: {
        title: string;
        description: string;
        output_type: string;
        tech_stack: string[];
        agent_count: number;
        constraints?: string;
        examples?: string;
    }) =>
        apiFetch<Job>("/api/jobs", {
            method: "POST",
            body: JSON.stringify(data),
        }),

    deleteJob: (id: string) =>
        apiFetch(`/api/jobs/${id}`, { method: "DELETE" }),

    approveJob: (id: string) =>
        apiFetch(`/api/jobs/${id}/approve`, { method: "POST" }),

    completeJob: (id: string) =>
        apiFetch(`/api/jobs/${id}/complete`, { method: "POST" }),

    listJobTasks: (jobId: string) =>
        apiFetch<{ tasks: Task[] }>(`/api/jobs/${jobId}/tasks`),

    // Plans
    generatePlan: (jobId: string) =>
        apiFetch(`/api/jobs/${jobId}/generate-plan`, { method: "POST" }),

    getPlan: (jobId: string) =>
        apiFetch<PlanResponse>(`/api/jobs/${jobId}/plan`),

    updateRoles: (jobId: string, roles: string[]) =>
        apiFetch(`/api/jobs/${jobId}/roles`, {
            method: "PUT",
            body: JSON.stringify({ roles })
        }),

    // Contributors
    contribute: (jobId: string, role = "teammate") =>
        apiFetch(`/api/jobs/${jobId}/contribute`, {
            method: "POST",
            body: JSON.stringify({ role })
        }),

    stopContributing: (jobId: string) =>
        apiFetch(`/api/jobs/${jobId}/contribute`, { method: "DELETE" }),

    listContributors: (jobId: string) =>
        apiFetch<{ contributors: Contributor[], total: number }>(`/api/jobs/${jobId}/contributors`),

    toggleReady: (jobId: string, isReady: boolean) =>
        apiFetch(`/api/jobs/${jobId}/ready`, {
            method: "POST",
            body: JSON.stringify({ is_ready: isReady }),
        }),

    // Comments
    getComments: (jobId: string) =>
        apiFetch<{ comments: Comment[] }>(`/api/jobs/${jobId}/comments`),

    addComment: (jobId: string, content: string) =>
        apiFetch(`/api/jobs/${jobId}/comments`, {
            method: "POST",
            body: JSON.stringify({ content }),
        }),

    // Votes
    toggleVote: (jobId: string) =>
        apiFetch(`/api/jobs/${jobId}/vote`, { method: "POST" }),

    // Credits
    getCredits: () => apiFetch<{ balance: number }>("/api/credits"),

    updatePlan: (jobId: string, data: { agent_prompt?: string; task_list?: string[] }) =>
        apiFetch(`/api/jobs/${jobId}/plan`, {
            method: "PATCH",
            body: JSON.stringify(data),
        }),

    // Logs
    getJobLogs: (jobId: string) =>
        apiFetch<{ logs: string[] }>(`/api/logs/${jobId}/history`),

    // Dev
    seed: () => apiFetch("/api/dev/seed", { method: "POST" }),
    reset: () => apiFetch("/api/dev/reset", { method: "DELETE" }),
};
