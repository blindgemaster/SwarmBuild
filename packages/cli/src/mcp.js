import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SwarmbuildAPI } from "./api.js";
import { exec as execCb } from "child_process";
import fs from "fs/promises";
import path from "path";
import util from "util";

const exec = util.promisify(execCb);

// Helper to run git commands with the deployed ssh key if it exists
async function runGitCommand(cmd, cwdPath) {
    const cwd = cwdPath || process.cwd();
    // Use the explicit workspace path so we don't accidentally find keys in parent directories
    const keyPath = path.join(cwd, ".deploy_key");
    let hasKey = false;
    try {
        await fs.access(keyPath);
        hasKey = true;
    } catch {
        // No key file present
    }

    if (hasKey) {
        const sshKeyPath = process.platform === 'win32' ? keyPath.replace(/\\/g, '\\\\') : keyPath;
        // Set it on the local repository config to avoid messing with process.env which drops ComSpec
        await exec(`git config core.sshCommand "ssh -i \\"${sshKeyPath}\\" -o StrictHostKeyChecking=no"`, { cwd });
    }

    return await exec(cmd, { cwd });
}

// Parse GitHub owner/repo from an SSH or HTTPS remote URL
function parseGithubRepo(remoteUrl) {
    // SSH:   git@github.com:owner/repo.git
    // HTTPS: https://github.com/owner/repo.git
    const sshMatch = remoteUrl.trim().match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/);
    return sshMatch ? sshMatch[1] : null;
}

// Push via HTTPS token URL — works on all platforms, no SSH key required
async function pushViaToken(githubToken, cwdPath) {
    const cwd = cwdPath || process.cwd();
    const { stdout: remoteUrl } = await exec("git remote get-url origin", { cwd });
    const repoPath = parseGithubRepo(remoteUrl);
    if (!repoPath) throw new Error(`Could not parse GitHub repo from remote URL: ${remoteUrl.trim()}`);
    const httpsUrl = `https://x-access-token:${githubToken}@github.com/${repoPath}.git`;
    await exec(`git push ${httpsUrl} HEAD:main`, { cwd });
}

// v2.2: Per-task token tracking (Map instead of global to handle concurrent claims)
const taskTokenStart = new Map();  // taskId → token count at claim time
let totalTokensUsed = 0;

function getTotalTokensUsed() { return totalTokensUsed; }

// Helper: push to a specific branch with retry (SSH key or token)
async function pushToRemote(branchName, cwdPath, force = false) {
    const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

    // Check if remote exists
    let hasRemote = false;
    try {
        await exec("git remote get-url origin", { cwd: cwdPath });
        hasRemote = true;
    } catch { /* no remote */ }
    if (!hasRemote) return "No git remote configured — skipping push.";

    // Try SSH deploy key first
    const keyPath = path.join(cwdPath, ".deploy_key");
    let hasKey = false;
    try { await fs.access(keyPath); hasKey = true; } catch { /* no key */ }

    const forceFlag = force ? " --force-with-lease" : "";

    if (hasKey) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await runGitCommand(`git push origin HEAD:${branchName}${forceFlag}`, cwdPath);
                return `Successfully pushed to branch '${branchName}'.`;
            } catch (e) {
                if (attempt === 3) throw e;
                await new Promise(r => setTimeout(r, attempt * 2000));
            }
        }
    }

    if (githubToken) {
        const { stdout: remoteUrl } = await exec("git remote get-url origin", { cwd: cwdPath });
        const repoPath = parseGithubRepo(remoteUrl);
        if (!repoPath) throw new Error(`Could not parse GitHub repo from: ${remoteUrl.trim()}`);
        const httpsUrl = `https://x-access-token:${githubToken}@github.com/${repoPath}.git`;
        await exec(`git push${forceFlag} ${httpsUrl} HEAD:${branchName}`, { cwd: cwdPath });
        return `Successfully pushed to branch '${branchName}'.`;
    }

    return "Skipped git push: no GITHUB_TOKEN or deploy key available.";
}

export async function runMCPServer(relayUrl, workerToken, workspacePath) {
    const api = new SwarmbuildAPI(relayUrl);
    api.workerToken = workerToken; // Pretend we are already logged in to the worker

    const server = new Server(
        { name: "swarmbuild-agent-api", version: "0.1.0" },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "swarmbuild_get_tasks",
                    description: "Get all tasks for this job",
                    inputSchema: { type: "object", properties: {} }
                },
                {
                    name: "swarmbuild_claim_task",
                    description: "Attempt to lock a task so you can work on it uniquely",
                    inputSchema: {
                        type: "object",
                        properties: { task_id: { type: "string" } },
                        required: ["task_id"]
                    }
                },
                {
                    name: "swarmbuild_complete_task",
                    description: "Mark a task as completed or failed",
                    inputSchema: {
                        type: "object",
                        properties: {
                            task_id: { type: "string" },
                            status: { type: "string", enum: ["completed", "failed"] }
                        },
                        required: ["task_id", "status"]
                    }
                },
                {
                    name: "swarmbuild_create_tasks",
                    description: "(Lead Only) Create tasks for the teammates. Supports depends_on for task ordering.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            tasks: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        title: { type: "string", description: "Short task title" },
                                        description: { type: "string", description: "Detailed task specification" },
                                        assigned_role: { type: "string", description: "Role that should do this task (lead, backend, frontend, etc.)" },
                                        depends_on: { type: "array", items: { type: "string" }, description: "Array of task IDs that must be completed before this task can be claimed" },
                                        parallel_group: { type: "string", description: "Group label for tasks that can run in parallel" },
                                        estimated_duration: { type: "number", description: "Estimated minutes to complete" }
                                    },
                                    required: ["title"]
                                }
                            }
                        },
                        required: ["tasks"]
                    }
                },
                {
                    name: "swarmbuild_read_chat",
                    description: "Read the last 50 messages from the Web UI Lobby chat",
                    inputSchema: { type: "object", properties: {} }
                },
                {
                    name: "swarmbuild_send_message",
                    description: "Broadcast a message to the humans and agents in the Web UI Lobby",
                    inputSchema: {
                        type: "object",
                        properties: { content: { type: "string" } },
                        required: ["content"]
                    }
                },
                {
                    name: "swarmbuild_cancel_task",
                    description: "Cancel a pending/available task. Use when human requests a plan change and existing tasks are no longer needed.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            task_id: { type: "string", description: "The task ID to cancel" },
                            reason: { type: "string", description: "Why this task is being cancelled" }
                        },
                        required: ["task_id"]
                    }
                }
            ]
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            if (request.params.name === "swarmbuild_get_tasks") {
                const tasks = await api.getTasks();

                // v2.3: Group by status for better display (includes review, cancelled)
                const claimable = tasks.filter(t => t.is_claimable && t.status === "available");
                const blocked = tasks.filter(t => !t.is_claimable && t.status === "available");
                const inProgress = tasks.filter(t => t.status === "locked");
                const inReview = tasks.filter(t => t.status === "review");
                const completed = tasks.filter(t => t.status === "completed");
                const failed = tasks.filter(t => t.status === "failed");
                const cancelled = tasks.filter(t => t.status === "cancelled");

                const formatted = `## Available Tasks (can claim now)
${claimable.map(t => `- [${t.id.slice(0, 8)}] ${t.title} (${t.assigned_role || 'any'}) — priority: ${t.priority_score || 0}`).join("\n") || "None — waiting for dependencies"}

## Blocked Tasks (dependencies incomplete)
${blocked.map(t => `- [${t.id.slice(0, 8)}] ${t.title} — waiting on: ${(t.blocking_tasks || []).join(", ") || "unknown"}`).join("\n") || "None"}

## In Progress
${inProgress.map(t => `- [${t.id.slice(0, 8)}] ${t.title} (locked)`).join("\n") || "None"}
${inReview.length ? `\n## Pending Review\n${inReview.map(t => `- [${t.id.slice(0, 8)}] ${t.title} (awaiting approval)`).join("\n")}` : ""}

## Completed
${completed.map(t => `- [${t.id.slice(0, 8)}] ${t.title} ✅`).join("\n") || "None"}
${failed.length ? `\n## Failed\n${failed.map(t => `- [${t.id.slice(0, 8)}] ${t.title} ❌`).join("\n")}` : ""}
${cancelled.length ? `\n## Cancelled\n${cancelled.map(t => `- [${t.id.slice(0, 8)}] ${t.title} 🚫`).join("\n")}` : ""}

Full task data (JSON):
${JSON.stringify(tasks, null, 2)}`;

                return { content: [{ type: "text", text: formatted }] };
            }

            if (request.params.name === "swarmbuild_claim_task") {
                const taskId = request.params.arguments.task_id;
                const res = await api.claimTask(taskId);

                // v2.2: Record token count at task start (keyed by taskId, not global)
                taskTokenStart.set(taskId, getTotalTokensUsed());

                // v2: Branch-per-task git flow
                const branchName = `task/${taskId.slice(0, 8)}`;
                let gitStatus = "No git remote detected.";
                try {
                    // Sync with main first
                    try { await runGitCommand("git stash --include-untracked", workspacePath); } catch { /* nothing to stash */ }
                    try {
                        await runGitCommand("git fetch origin", workspacePath);
                        await runGitCommand("git checkout main", workspacePath);
                        await runGitCommand("git pull --rebase origin main", workspacePath);
                    } catch { /* empty repo or no remote */ }
                    try { await runGitCommand("git stash pop", workspacePath); } catch { /* nothing stashed */ }

                    // Create task branch from latest main
                    try {
                        await runGitCommand(`git checkout -b ${branchName}`, workspacePath);
                    } catch {
                        // Branch might already exist from a previous attempt
                        await runGitCommand(`git checkout ${branchName}`, workspacePath);
                        try { await runGitCommand("git rebase main", workspacePath); } catch { /* rebase conflict — continue on branch as-is */ }
                    }
                    gitStatus = `Working on branch '${branchName}'. Push here, server will merge to main.`;
                } catch (err) {
                    gitStatus = `Git branch setup failed: ${err.message}`;
                    console.error("[MCP] Git Branch Error:", err.message);
                }

                // Include previous attempts for context
                let previousAttempts = [];
                let warning = null;
                try {
                    previousAttempts = res.previous_attempts || [];
                    warning = res.warning || null;
                } catch { /* ignore */ }

                // v2.1: Include recent commits from main so agent knows what others have done
                let recentCommits = "";
                try {
                    const { stdout } = await runGitCommand(
                        'git log --oneline -10 origin/main',
                        workspacePath
                    );
                    recentCommits = stdout.trim();
                } catch { /* no commits yet or no remote */ }

                const contextMessage = recentCommits
                    ? `Other agents have already committed:\n${recentCommits}\n\nYour work should build on top of theirs.`
                    : "You're the first agent to work on this codebase.";

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            ...res,
                            branch: branchName,
                            git_sync: gitStatus,
                            previous_attempts: previousAttempts,
                            warning,
                            recent_commits: recentCommits,
                            context: contextMessage,
                        }, null, 2)
                    }]
                };
            }

            if (request.params.name === "swarmbuild_complete_task") {
                const taskId = request.params.arguments.task_id;
                const branchName = `task/${taskId.slice(0, 8)}`;

                // v2.2: Compute per-task token usage from Map (handles concurrent tasks)
                const startTokens = taskTokenStart.get(taskId) || 0;
                const taskTokens = getTotalTokensUsed() - startTokens;
                taskTokenStart.delete(taskId);  // Clean up

                // v2: Commit and push to task branch (NOT main)
                let gitStatus = "No git remote detected.";
                let mergeSuccess = false;
                try {
                    await runGitCommand("git add .", workspacePath);
                    try {
                        await runGitCommand(
                            `git commit -m "Complete: ${taskId}"`,
                            workspacePath
                        );
                    } catch (e) {
                        const nothingToCommit =
                            e.stdout?.includes("nothing to commit") ||
                            e.stderr?.includes("nothing to commit") ||
                            e.message?.includes("nothing to commit");
                        if (!nothingToCommit) throw e;
                    }

                    // v2.1: Rebase on latest main before pushing (picks up other agents' merged work)
                    let synced = false;
                    try {
                        await runGitCommand("git fetch origin", workspacePath);
                        await runGitCommand("git rebase origin/main", workspacePath);
                        synced = true;
                    } catch {
                        // Rebase conflict — abort and try merge instead (more forgiving)
                        try { await runGitCommand("git rebase --abort", workspacePath); } catch { /* already clean */ }
                        try {
                            await runGitCommand("git merge origin/main --no-edit", workspacePath);
                            synced = true;
                        } catch {
                            // Merge also failed — abort and force push as last resort
                            try { await runGitCommand("git merge --abort", workspacePath); } catch { /* already clean */ }
                            console.error(`[MCP] WARNING: Both rebase and merge with origin/main failed for ${branchName}. Force pushing branch as-is.`);
                        }
                    }

                    // Push to task branch (not main) — force push to handle rebase rewrites
                    gitStatus = await pushToRemote(branchName, workspacePath, true);

                    // Enqueue merge request on the server
                    let mergeQueueId = null;
                    try {
                        const mergeResult = await api.enqueueMerge(taskId, branchName);
                        mergeQueueId = mergeResult.queue_id;
                        gitStatus += " Merge enqueued.";
                        mergeSuccess = true;
                    } catch (mergeErr) {
                        gitStatus += ` (merge enqueue failed: ${mergeErr.message})`;
                    }

                    // v2.5.1: Wait for merge to complete before returning
                    // This prevents sequential tasks from creating overlapping branches
                    if (mergeSuccess && mergeQueueId) {
                        const MERGE_WAIT_TIMEOUT = 90_000; // 90 seconds max
                        const MERGE_POLL_INTERVAL = 5_000;  // Check every 5 seconds
                        const waitStart = Date.now();
                        let mergeCompleted = false;

                        console.log(`[MCP] Waiting for merge of ${branchName} to complete...`);
                        while (Date.now() - waitStart < MERGE_WAIT_TIMEOUT) {
                            await new Promise(r => setTimeout(r, MERGE_POLL_INTERVAL));
                            try {
                                // Check if our branch has been merged by fetching and checking if main moved
                                await runGitCommand("git fetch origin", workspacePath);
                                // Try to find our commit on origin/main
                                try {
                                    await runGitCommand(`git merge-base --is-ancestor ${branchName} origin/main`, workspacePath);
                                    // If this succeeds, our branch is merged into main
                                    mergeCompleted = true;
                                    break;
                                } catch {
                                    // Not merged yet — keep waiting
                                }
                            } catch {
                                // Fetch failed — keep waiting
                            }
                        }

                        if (mergeCompleted) {
                            gitStatus += " Merge confirmed.";
                            console.log(`[MCP] Merge of ${branchName} confirmed on main.`);
                            // Sync local main with the merged state
                            try {
                                await runGitCommand("git checkout main", workspacePath);
                                await runGitCommand("git pull --rebase origin main", workspacePath);
                            } catch { /* best effort */ }
                        } else {
                            gitStatus += " Merge wait timed out (90s) — proceeding anyway.";
                            console.log(`[MCP] Merge wait timed out for ${branchName}. Proceeding.`);
                        }
                    }

                } catch (err) {
                    gitStatus = `Git push failed: ${err.message}`;
                    console.error("[MCP] Git Push Error:", err.message);
                }

                // v2.3: Only mark complete if merge was enqueued (or no remote configured)
                if (mergeSuccess || gitStatus.includes("No git remote")) {
                    const res = await api.completeTask(taskId, request.params.arguments.status, taskTokens);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({ ...res, git_sync: gitStatus, tokens_used: taskTokens, branch: branchName }, null, 2)
                        }]
                    };
                } else {
                    return {
                        isError: true,
                        content: [{
                            type: "text",
                            text: `Task NOT marked complete because merge failed. ${gitStatus}. Fix the issue and try completing again.`
                        }]
                    };
                }
            }

            if (request.params.name === "swarmbuild_create_tasks") {
                const res = await api.createTasks(request.params.arguments.tasks);
                return { content: [{ type: "text", text: JSON.stringify(res) }] };
            }

            if (request.params.name === "swarmbuild_read_chat") {
                const msgs = await api.getMessages();
                return { content: [{ type: "text", text: JSON.stringify(msgs, null, 2) }] };
            }

            if (request.params.name === "swarmbuild_send_message") {
                const res = await api.broadcastMessage(request.params.arguments.content);
                return { content: [{ type: "text", text: JSON.stringify(res) }] };
            }

            if (request.params.name === "swarmbuild_cancel_task") {
                const taskId = request.params.arguments.task_id;
                const reason = request.params.arguments.reason || "Cancelled by coordinator";
                const res = await api.cancelTask(taskId, reason);
                return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
            }

            throw new Error("Unknown tool");
        } catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: error.response?.data?.detail || error.message }]
            };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Swarmbuild MCP Server running on stdio");
}
