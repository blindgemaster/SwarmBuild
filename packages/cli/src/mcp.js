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
                    description: "(Lead Only) Create tasks for the teammates",
                    inputSchema: {
                        type: "object",
                        properties: {
                            tasks: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        title: { type: "string" },
                                        description: { type: "string" },
                                        assigned_role: { type: "string" }
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
                }
            ]
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            if (request.params.name === "swarmbuild_get_tasks") {
                const tasks = await api.getTasks();
                return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
            }

            if (request.params.name === "swarmbuild_claim_task") {
                const res = await api.claimTask(request.params.arguments.task_id);

                // PHASE 10: AUTOMATIC GIT SYNC -> ROBUST CLAIM
                let gitStatus = "No git remote detected.";
                try {
                    // Stash any uncommitted work Claude might have started before pulling.
                    // Use --include-untracked so it catches new files too. Ignore exit code
                    // cross-platform by catching the error rather than relying on "|| true"
                    // (which is bash-only and breaks on Windows cmd.exe).
                    try { await runGitCommand("git stash --include-untracked", workspacePath); } catch { /* nothing to stash */ }
                    await runGitCommand("git pull --rebase origin main", workspacePath);
                    try { await runGitCommand("git stash pop", workspacePath); } catch { /* nothing stashed */ }
                    gitStatus = "Successfully pulled latest code from other agents via GitHub.";
                } catch (err) {
                    gitStatus = `Git pull failed: ${err.message}`;
                    console.error("[MCP] Git Pull Error:", err.message);
                }

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ ...res, git_sync: gitStatus }, null, 2)
                    }]
                };
            }

            if (request.params.name === "swarmbuild_complete_task") {
                // PHASE 10: AUTOMATIC GIT SYNC -> ROBUST COMPLETE
                let gitStatus = "No git remote detected.";
                try {
                    await runGitCommand("git add .", workspacePath);
                    // Ignore "nothing to commit" — Node.js exec errors put git's stdout
                    // in e.stdout (not e.message), so check both properties.
                    try {
                        await runGitCommand(`git commit -m "Completed task: ${request.params.arguments.task_id}"`, workspacePath);
                    } catch (e) {
                        const nothingToCommit =
                            e.stdout?.includes("nothing to commit") ||
                            e.stderr?.includes("nothing to commit") ||
                            e.message?.includes("nothing to commit");
                        if (!nothingToCommit) throw e;
                        // If nothing to commit, fall through to push — git push will
                        // return "Everything up-to-date" (exit 0), which is fine.
                    }

                    // Prefer HTTPS token push (GitHub MCP approach — reliable on all platforms,
                    // no SSH key required). Fall back to SSH deploy key if present. Skip if neither.
                    const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

                    // Check whether git remote exists at all
                    let hasRemote = false;
                    try {
                        await exec("git remote get-url origin", { cwd: workspacePath });
                        hasRemote = true;
                    } catch {
                        // No remote configured — nothing to push
                    }

                    if (!hasRemote) {
                        gitStatus = "No git remote configured — skipping push.";
                    } else if (!githubToken) {
                        // Check if deploy key was written by setupWorkspace
                        const keyPath = path.join(workspacePath, ".deploy_key");
                        let hasKey = false;
                        try { await fs.access(keyPath); hasKey = true; } catch { /* no key */ }

                        if (!hasKey) {
                            // Neither token nor SSH key — skip silently rather than failing
                            gitStatus = "Skipped git push: no GITHUB_TOKEN set. Set GITHUB_TOKEN in your environment to enable automatic pushes.";
                        } else {
                            // SSH deploy key present — try 3x
                            let pushed = false, lastError = "";
                            for (let attempt = 1; attempt <= 3; attempt++) {
                                try {
                                    try { await runGitCommand("git pull --rebase origin main", workspacePath); } catch { /* empty repo */ }
                                    await runGitCommand("git push origin main", workspacePath);
                                    pushed = true;
                                    break;
                                } catch (e) {
                                    lastError = e.message || String(e);
                                    await new Promise(r => setTimeout(r, attempt * 2000));
                                }
                            }
                            gitStatus = pushed
                                ? "Successfully pushed your code to GitHub for other agents."
                                : `Git push failed (SSH): ${lastError}`;
                        }
                    } else {
                        // Token available — use HTTPS push (most reliable)
                        let pushed = false, lastError = "";
                        for (let attempt = 1; attempt <= 3; attempt++) {
                            try {
                                try { await runGitCommand("git pull --rebase origin main", workspacePath); } catch { /* empty repo */ }
                                await pushViaToken(githubToken, workspacePath);
                                pushed = true;
                                break;
                            } catch (e) {
                                lastError = e.message || String(e);
                                await new Promise(r => setTimeout(r, attempt * 2000));
                            }
                        }

                        // If token push failed, try SSH deploy key as fallback
                        // (token may lack write access to the job org but deploy key always has it)
                        if (!pushed) {
                            const keyPath = path.join(workspacePath, ".deploy_key");
                            let hasKey = false;
                            try { await fs.access(keyPath); hasKey = true; } catch { /* no key */ }

                            if (hasKey) {
                                let sshPushed = false, sshError = "";
                                for (let attempt = 1; attempt <= 3; attempt++) {
                                    try {
                                        try { await runGitCommand("git pull --rebase origin main", workspacePath); } catch { /* empty repo */ }
                                        await runGitCommand("git push origin main", workspacePath);
                                        sshPushed = true;
                                        break;
                                    } catch (e) {
                                        sshError = e.message || String(e);
                                        await new Promise(r => setTimeout(r, attempt * 2000));
                                    }
                                }
                                gitStatus = sshPushed
                                    ? "Successfully pushed via deploy key (token had no org access)."
                                    : `Git push failed — token: ${lastError} | SSH: ${sshError}`;
                            } else {
                                gitStatus = `Git push failed (token): ${lastError}`;
                            }
                        } else {
                            gitStatus = "Successfully pushed your code to GitHub for other agents.";
                        }
                    }


                } catch (err) {
                    gitStatus = `Git push failed: ${err.message}`;
                    console.error("[MCP] Git Push Error:", err.message);
                }

                const res = await api.completeTask(request.params.arguments.task_id, request.params.arguments.status);

                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ ...res, git_sync: gitStatus }, null, 2)
                    }]
                };
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
