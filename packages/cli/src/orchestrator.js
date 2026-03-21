import { spawn, exec as execCb } from "child_process";
import fs from "fs/promises";
import path from "path";
import util from "util";
import { fileURLToPath } from "url";
import { SwarmbuildAPI } from "./api.js";
import { getRuntime } from "./runtimes/index.js";
import { buildPrompt } from "./runtimes/prompts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const exec = util.promisify(execCb);

// ── v2: Global tracking state ──
let heartbeatInterval = null;
let heartbeatInFlight = null;  // v2.2: Track in-flight heartbeat to avoid shutdown race
let totalTokensUsed = 0;
let sessionCount = 0;
let commitCount = 0;
let currentTaskId = null;
let WORKSPACE = null;

function startHeartbeat(api) {
    heartbeatInterval = setInterval(async () => {
        // v2.2: Track in-flight promise so shutdown can wait for it
        const heartbeatPromise = (async () => {
        try {
            const response = await api.heartbeat({
                agents_running: 1,
                tokens_used: totalTokensUsed,
                current_task_id: currentTaskId,
                status: currentTaskId ? "working" : "idle",
                sessions_run: sessionCount,
                commits_pushed: commitCount,
            });

            // Server-initiated stop
            if (response.should_stop) {
                console.log(`[swarmbuild] ⛔ Server requested stop: ${response.stop_reason}`);
                await gracefulShutdown(api, response.stop_reason);
            }

            // Process notifications
            if (response.pending_notifications) {
                const humanMessages = [];
                for (const notif of response.pending_notifications) {
                    if (notif.type === "human_message") {
                        humanMessages.push(notif);
                        console.log(`[swarmbuild] 📨 Message from ${notif.from}: ${notif.content}`);
                    } else {
                        console.log(`[swarmbuild] ⚠️ ${notif.message}`);
                    }
                }
                // v2.1: Write human messages to MESSAGES.md so agents can read them
                if (humanMessages.length > 0 && WORKSPACE) {
                    try {
                        const content = humanMessages
                            .map(m => `**${m.from}** (${m.timestamp}):\n${m.content}`)
                            .join("\n\n---\n\n");
                        const msgPath = path.join(WORKSPACE, "MESSAGES.md");
                        await fs.appendFile(msgPath, `\n\n---\n\n${content}\n`);
                    } catch { /* non-fatal */ }
                }
            }
        } catch (err) {
            // Network error — log but don't crash
            console.log(`[swarmbuild] ⚠️ Heartbeat failed: ${err.message}`);
        }
        })();
        heartbeatInFlight = heartbeatPromise;
        await heartbeatPromise;
        heartbeatInFlight = null;
    }, 30_000); // Every 30 seconds
}

async function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    // v2.2: Wait for any in-flight heartbeat to finish before proceeding
    if (heartbeatInFlight) {
        try { await heartbeatInFlight; } catch { /* ignore */ }
        heartbeatInFlight = null;
    }
}

async function gracefulShutdown(api, reason = "user_interrupted") {
    console.log(`\n[swarmbuild] 🛑 Initiating graceful shutdown (reason: ${reason})...`);

    // 1. Stop the heartbeat (awaits any in-flight heartbeat)
    await stopHeartbeat();

    // 2. Release all tasks locked by this worker
    try {
        const released = await api.releaseAllMyTasks();
        console.log(`[swarmbuild] Released ${released.count} locked task(s)`);
    } catch (err) {
        console.log(`[swarmbuild] ⚠️ Failed to release tasks: ${err.message}`);
    }

    // 3. Commit and push any uncommitted work
    if (WORKSPACE) {
        try {
            await exec("git add .", { cwd: WORKSPACE });
            try {
                await exec(
                    `git commit -m "WIP: Agent shutdown (${reason}) — partial work"`,
                    { cwd: WORKSPACE }
                );
                // Push to a WIP branch so work isn't lost
                const wipBranch = `wip/${api.workerToken?.slice(-8) || 'unknown'}`;
                await exec(
                    `git push origin HEAD:${wipBranch}`,
                    { cwd: WORKSPACE }
                );
                console.log(`[swarmbuild] ✅ Pushed partial work to branch ${wipBranch}`);
            } catch {
                // Nothing to commit — that's fine
            }
        } catch (err) {
            console.log(`[swarmbuild] ⚠️ Failed to save partial work: ${err.message}`);
        }
    }

    // 4. Notify server
    try {
        await api.workerComplete("stopped", `Graceful shutdown: ${reason}`);
    } catch {
        // Server might be unreachable
    }

    console.log("[swarmbuild] Goodbye! 👋");
}

function registerShutdownHandlers(api) {
    let shuttingDown = false;

    const handler = async (signal) => {
        if (shuttingDown) {
            console.log("[swarmbuild] Force exit.");
            process.exit(1);
        }
        shuttingDown = true;

        await gracefulShutdown(api, signal);
        process.exit(0);
    };

    process.on("SIGINT", () => handler("SIGINT"));
    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("uncaughtException", async (err) => {
        console.error(`[swarmbuild] 💥 Uncaught exception: ${err.message}`);
        await gracefulShutdown(api, "uncaught_exception");
        process.exit(1);
    });
    process.on("unhandledRejection", async (err) => {
        console.error(`[swarmbuild] 💥 Unhandled rejection: ${err}`);
        await gracefulShutdown(api, "unhandled_rejection");
        process.exit(1);
    });
}

export async function runLobby(jobId, options) {
    const { role, relay, token, runtime: runtimeName = "claude" } = options;
    console.log(`[swarmbuild] Joining Job ${jobId} as ${role} (runtime: ${runtimeName})...`);

    const api = new SwarmbuildAPI(relay, token);

    // 1. Register and get worker token
    const contrib = await api.register(jobId, role);
    console.log(`[swarmbuild] ✅ Joined! Worker Token: wt_...${api.workerToken?.slice(-6) || 'null'}`);

    // 2. Fetch Job Info
    const jobInfo = await api.getJobInfo();

    WORKSPACE = path.join(process.cwd(), `workspace-${jobId}`);

    // 3. Setup local workspace
    await setupWorkspace(jobInfo, WORKSPACE);

    // v2: Start heartbeat loop + register shutdown handlers
    startHeartbeat(api);
    registerShutdownHandlers(api);
    console.log(`[swarmbuild] Heartbeat started (every 30s)`);

    // v2.1: Check if job is already executing (hot-join)
    let isHotJoin = false;
    try {
        const jobCheck = await api.client.get(`/api/jobs/${jobId}`);
        if (jobCheck.data.lobby_state === 'executing' || jobCheck.data.status === 'running') {
            isHotJoin = true;
        }
    } catch { /* ignore */ }

    if (isHotJoin) {
        console.log(`[swarmbuild] 🔥 Hot-joining a running job — skipping lobby, jumping to execution!`);
    } else {
        // 4. Normal Pre-Run Lobby Loop
        if (role === 'lead') {
            console.log(`\n[swarmbuild] You are the LEAD. Launching ${runtimeName} to propose the Agent Team Plan...`);
            await startAgentInteractive(api, role, jobInfo, true, WORKSPACE, runtimeName);
            console.log(`\n[swarmbuild] ℹ️ Tip: The agent operates fully autonomously and exits when its instruction finishes.`);
            console.log(`[swarmbuild] Plan proposed! Now chat with humans on the website.`);
        } else {
            console.log(`\n[swarmbuild] You are a TEAMMATE(${role}).Waiting in the Lobby...`);
            console.log(`[swarmbuild] Go to the Swarmbuild Web UI to see the plan and chat.`);
        }

        console.log(`\n[swarmbuild] Press ENTER to Mark Ready(Make sure everyone agrees on the plan!)`);

        // Wait for ENTER
        process.stdin.resume();
        await new Promise(resolve => process.stdin.once('data', resolve));
        process.stdin.pause();

        console.log(`[swarmbuild] Marking Ready...`);
        let readyState;
        try {
            readyState = await api.setReady(jobId, true);
        } catch (e) {
            console.log(`[swarmbuild] ❌ Error marking ready: ${e?.response?.data?.detail || e.message}`);
            console.log(`[swarmbuild] Make sure you aren't trying to claim a role that is already full! Please try again.`);
            return;
        }

        if (readyState.all_ready) {
            console.log(`[swarmbuild] 🚀 All contributors ready! Execution starting...`);
        } else {
            console.log(`[swarmbuild] ⏳ Waiting for OTHER required contributors to mark ready...`);
            console.log(`[swarmbuild] Ensure all roles defined in the plan have joined and clicked Ready in the Web UI!`);
            while (true) {
                await new Promise(r => setTimeout(r, 3000));
                const check = await api.client.get(`/api/jobs/${jobId}`);
                if (check.data.lobby_state === 'executing') break;
            }
            console.log(`[swarmbuild] 🚀 Execution starting...`);
        }
    }

    // 5. Determine execution mode: coordinator (lead with team) vs worker
    const isSoloLead = role === 'lead' && (
        !jobInfo.required_roles?.length ||
        jobInfo.required_roles.length === 1 ||
        jobInfo.required_roles.every(r => r === 'lead')
    );

    // Check if other agents are active (lead becomes coordinator if so)
    let isCoordinator = false;
    if (role === 'lead' && !isSoloLead) {
        try {
            const contribs = await api.client.get(`/api/jobs/${jobId}/contributors`);
            const others = (contribs.data.contributors || []).filter(c =>
                c.role !== 'lead' && !c.left_at
            );
            isCoordinator = others.length > 0;
        } catch { /* fallback to worker mode */ }
    }

    if (isCoordinator) {
        console.log(`[swarmbuild] 🎯 Lead entering COORDINATOR mode (other agents are working)...`);
        await runCoordinatorLoop(api, role, jobInfo, WORKSPACE, runtimeName, jobId);
    } else {
        console.log(`[swarmbuild] Entering worker execution loop...`);
        await runWorkerLoop(api, role, jobInfo, WORKSPACE, runtimeName, isSoloLead);
    }

    // Clean shutdown after all tasks done
    await stopHeartbeat();
    try {
        await api.workerComplete("complete", "All tasks completed");
    } catch { /* ignore */ }
}

// ── v2.4: Coordinator loop — fixed orphan detection + longer cooldown ──
async function runCoordinatorLoop(api, role, jobInfo, WORKSPACE, runtimeName, jobId) {
    let lastCompletedCount = 0;
    let lastSessionTime = 0;
    let lastWorkerSessionTime = 0;
    const SESSION_COOLDOWN_MS = 120_000; // v2.4: 2 minutes minimum between coordinator sessions
    const WORKER_COOLDOWN_MS = 30_000;   // v2.5.1: 30s cooldown for hybrid worker task claiming
    const NO_TASKS_TIMEOUT_MS = 5 * 60 * 1000;
    let noTasksSince = null;

    while (true) {
        let tasks = [];
        try {
            tasks = await api.getTasks();
        } catch (e) {
            console.log(`[swarmbuild] Error fetching tasks: ${e.message}. Retrying...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        const pending = tasks.filter(t => t.status === 'available' || t.status === 'locked' || t.status === 'review');
        const completed = tasks.filter(t => t.status === 'completed');

        // All tasks done
        if (pending.length === 0 && tasks.length > 0) {
            console.log(`\n[swarmbuild] 🎉 All tasks complete! Coordinator signing off.`);
            sessionCount++;
            lastSessionTime = Date.now();
            await startAgentInteractive(api, role, jobInfo, false, WORKSPACE, runtimeName);
            break;
        }

        // No tasks yet — wait with timeout
        if (tasks.length === 0) {
            if (!noTasksSince) noTasksSince = Date.now();
            if (Date.now() - noTasksSince > NO_TASKS_TIMEOUT_MS) {
                console.log(`[swarmbuild] ⚠️ No tasks created after 5 minutes. Exiting.`);
                break;
            }
            console.log(`[swarmbuild] ⏳ No tasks created yet. Waiting...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        noTasksSince = null;

        // Check if something changed since last cycle
        const hasNewCompletions = completed.length > lastCompletedCount;
        lastCompletedCount = completed.length;

        // Check for unread human messages
        let hasHumanMessages = false;
        try {
            const msgs = await api.getMessages();
            const recent = msgs.filter(m =>
                m.author_type === 'human' &&
                Date.now() - new Date(m.created_at).getTime() < 120_000
            );
            hasHumanMessages = recent.length > 0;
        } catch { /* ignore */ }

        // v2.4: Only consider tasks truly orphaned if no active agent exists for their role
        let orphanedCount = 0;
        try {
            const contribs = await api.client.get(`/api/jobs/${jobId}/contributors`);
            const activeRoles = new Set(
                (contribs.data.contributors || [])
                    .filter(c => c.contributor_status === 'active' && !c.left_at)
                    .map(c => c.role)
            );
            orphanedCount = tasks.filter(t => {
                if (t.status !== 'available' || t.is_claimable === false) return false;
                const assignedRole = t.assigned_role;
                // Only orphaned if no active agent exists for this task's role
                return assignedRole && !activeRoles.has(assignedRole);
            }).length;
        } catch { /* ignore — don't treat as orphaned if check fails */ }

        // Spawn coordinator session if there's a reason AND cooldown has elapsed
        if (hasNewCompletions || hasHumanMessages || orphanedCount > 0) {
            if (Date.now() - lastSessionTime < SESSION_COOLDOWN_MS) {
                // Only log cooldown if there are human messages (important to respond)
                if (hasHumanMessages) {
                    console.log(`[swarmbuild] 📋 Coordinator: session cooldown active, will respond soon...`);
                }
            } else {
                console.log(`[swarmbuild] 📋 Coordinator cycle: ${completed.length} done, ${pending.length} pending` +
                    (hasHumanMessages ? ', new human messages' : '') +
                    (orphanedCount > 0 ? `, ${orphanedCount} orphaned tasks` : ''));
                sessionCount++;
                lastSessionTime = Date.now();
                await startAgentInteractive(api, role, jobInfo, false, WORKSPACE, runtimeName);
            }
        } else {
            // Quiet monitoring — log less frequently
            if (Date.now() - lastSessionTime > 120_000) {
                console.log(`[swarmbuild] 📋 Coordinator: ${completed.length}/${tasks.length} done. Monitoring...`);
            }
        }

        // v2.5: Check if lead has its own tasks to pick up (hybrid coordinator+worker)
        const leadClaimable = tasks.filter(t =>
            t.status === 'available' &&
            t.is_claimable !== false &&
            t.assigned_role === 'lead'
        );

        if (leadClaimable.length > 0 && Date.now() - lastWorkerSessionTime >= WORKER_COOLDOWN_MS) {
            console.log(`[swarmbuild] 🔧 Coordinator picking up ${leadClaimable.length} lead task(s)...`);
            sessionCount++;
            lastWorkerSessionTime = Date.now();
            // Spawn as worker (forceWorkerMode=true) to actually claim and execute the work
            await startAgentInteractive(api, role, jobInfo, false, WORKSPACE, runtimeName, true);
        }

        // Coordinator checks every 30 seconds
        await new Promise(r => setTimeout(r, 30_000));
    }
}

// ── v2.4: Worker loop — fixed idle timeout + smart spawning ──
async function runWorkerLoop(api, role, jobInfo, WORKSPACE, runtimeName, isSoloLead) {
    const WORKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    let idleSince = null;
    let consecutiveEmptySessions = 0;
    const MAX_EMPTY_SESSIONS = 3; // Back off after 3 sessions with no progress

    while (true) {
        let tasks = [];
        try {
            tasks = await api.getTasks();
        } catch (e) {
            console.log(`[swarmbuild] Error fetching tasks: ${e.message}. Retrying in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        // No tasks created yet — wait for lead
        if (tasks.length === 0) {
            if (!idleSince) idleSince = Date.now();
            if (Date.now() - idleSince > WORKER_IDLE_TIMEOUT_MS) {
                console.log(`[swarmbuild] ⏰ Idle timeout. No tasks created. Exiting.`);
                break;
            }
            console.log(`[swarmbuild] ⏳ No tasks created yet. Waiting for lead agent...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        // Check if all tasks are terminal (completed/cancelled/failed)
        const activeStatuses = ['available', 'locked', 'review'];
        const activeTasks = tasks.filter(t => activeStatuses.includes(t.status));
        if (activeTasks.length === 0) {
            if (!idleSince) {
                idleSince = Date.now();
                console.log(`[swarmbuild] ⏳ All tasks complete. Waiting up to 5 min for new tasks...`);
            }
            if (Date.now() - idleSince > WORKER_IDLE_TIMEOUT_MS) {
                console.log(`[swarmbuild] ⏰ Idle timeout (5 min). No new tasks. Exiting.`);
                break;
            }
            await new Promise(r => setTimeout(r, 10_000));
            continue;
        }

        // Filter to tasks relevant to this agent's role
        // v2.5.1: First try own role, then fall back to ANY available task
        const myRoleTasks = isSoloLead
            ? activeTasks
            : activeTasks.filter(t => t.assigned_role === role);

        const claimableForMyRole = myRoleTasks.filter(t =>
            t.status === 'available' && t.is_claimable !== false
        );

        // If no tasks for my role, check for ANY claimable task (cross-role helping)
        const allClaimable = activeTasks.filter(t =>
            t.status === 'available' && t.is_claimable !== false
        );
        const claimableForMe = claimableForMyRole.length > 0 ? claimableForMyRole : allClaimable;
        const isCrossRoleHelping = claimableForMyRole.length === 0 && allClaimable.length > 0;

        if (claimableForMe.length === 0) {
            // Nothing this agent can claim right now
            if (!idleSince) {
                idleSince = Date.now();
                const reason = myRoleTasks.length === 0
                    ? `No tasks assigned to role '${role}'.`
                    : `All ${myRoleTasks.length} task(s) for '${role}' are locked/blocked.`;
                console.log(`[swarmbuild] ⏳ ${reason} Waiting up to 5 min...`);
            }
            if (Date.now() - idleSince > WORKER_IDLE_TIMEOUT_MS) {
                console.log(`[swarmbuild] ⏰ Idle timeout (5 min). Exiting.`);
                break;
            }
            await new Promise(r => setTimeout(r, 10_000));
            continue;
        }

        // Claimable tasks found — reset idle timer
        idleSince = null;

        if (isCrossRoleHelping) {
            console.log(`[swarmbuild] 🤝 No '${role}' tasks available. Helping with ${claimableForMe.length} task(s) from other roles...`);
        }

        sessionCount++;
        const claimableCount = claimableForMe.length;
        const exitCode = await startAgentInteractive(api, role, jobInfo, false, WORKSPACE, runtimeName);

        // v2.4: Check if session actually accomplished anything
        try {
            const postTasks = await api.getTasks();
            const stillMyRole = postTasks.filter(t =>
                t.status === 'available' &&
                t.is_claimable !== false &&
                (isSoloLead || t.assigned_role === role)
            );
            // v2.5.1: Count all claimable (including cross-role)
            const stillClaimable = stillMyRole.length > 0 ? stillMyRole : postTasks.filter(t =>
                t.status === 'available' && t.is_claimable !== false
            );
            if (stillClaimable.length >= claimableCount) {
                // Session didn't claim anything — increment empty counter
                consecutiveEmptySessions++;
                if (consecutiveEmptySessions >= MAX_EMPTY_SESSIONS) {
                    console.log(`[swarmbuild] ⚠️ ${MAX_EMPTY_SESSIONS} sessions with no progress. Backing off 60s...`);
                    await new Promise(r => setTimeout(r, 60_000));
                    consecutiveEmptySessions = 0;
                }
            } else {
                consecutiveEmptySessions = 0;
            }
        } catch { /* ignore check failure */ }

        if (exitCode !== 0) {
            console.log(`[swarmbuild] Agent exited with code ${exitCode}. Pausing 5s...`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

async function setupWorkspace(jobInfo, WORKSPACE) {
    console.log(`[swarmbuild] Setting up ${WORKSPACE} workspace...`);
    await fs.mkdir(WORKSPACE, { recursive: true });

    // Setup git if clone url
    if (jobInfo.github_repo_url && jobInfo.github_deploy_key_private) {
        console.log(`[swarmbuild] Provisioning GitHub deployment keys...`);
        const keyPath = path.join(WORKSPACE, ".deploy_key");
        await fs.writeFile(keyPath, jobInfo.github_deploy_key_private, { mode: 0o600 });

        const sshKeyPath = process.platform === 'win32' ? keyPath.replace(/\\/g, '\\\\') : keyPath;
        const gitOpts = { cwd: WORKSPACE };

        console.log(`[swarmbuild] Syncing Swarmbuild repository: ${jobInfo.github_repo_url}`);
        let isGitInit = false;
        try {
            await fs.access(path.join(WORKSPACE, ".git"));
            isGitInit = true;
        } catch {
            isGitInit = false;
        }

        if (isGitInit) {
            console.log(`[swarmbuild] Git already initialized. Pulling latest...`);
            try {
                // Ensure config is set for this session
                await exec(`git config core.sshCommand "ssh -i \\"${sshKeyPath}\\" -o StrictHostKeyChecking=no"`, gitOpts);
                // If it's a completely empty repo with just an initial commit on origin, rebase might fail if main doesn't exist locally
                await exec(`git fetch origin`, gitOpts);
                try {
                    await exec(`git checkout main`, gitOpts);
                } catch {
                    // ignore
                }
                await exec(`git pull origin main --rebase`, gitOpts);
                console.log(`[swarmbuild] ✅ Repository synced.`);
            } catch (err) {
                console.log(`[swarmbuild] ⚠️ Git pull failed. Stashing local changes and retrying: ${err.message}`);
                try {
                    await exec(`git stash || true`, gitOpts);
                    await exec(`git pull origin main --rebase`, gitOpts);
                    await exec(`git stash pop || true`, gitOpts);
                    console.log(`[swarmbuild] ✅ Repository synced after stash.`);
                } catch (e) {
                    console.log(`[swarmbuild] ⚠️ Fatal Git Pull Error: ${e.message}`);
                }
            }
        } else {
            console.log(`[swarmbuild] Initializing new Git repository locally...`);
            try {
                await exec(`git init`, gitOpts);
                await exec(`git config core.sshCommand "ssh -i \\"${sshKeyPath}\\" -o StrictHostKeyChecking=no"`, gitOpts);
                await exec(`git remote add origin ${jobInfo.github_repo_url}`, gitOpts);
                await exec(`git fetch origin`, gitOpts);

                // If the remote repo was auto-initialized (e.g. by GitHub API), we can track its main branch
                try {
                    await exec(`git checkout -b main --track origin/main`, gitOpts);
                } catch {
                    // If the remote is truly empty, just checkout main
                    await exec(`git checkout -b main`, gitOpts);
                }
                console.log(`[swarmbuild] ✅ Repository cloned successfully.`);
            } catch (e) {
                console.log(`[swarmbuild] ⚠️ Git setup failed: ${e.message}`);
            }
        }
    } else {
        console.log(`[swarmbuild] No GitHub repository configured, using local folder.`);
    }

    // Write .gitignore ALWAYS — append swarmbuild entries if file already exists.
    // This MUST happen before any git operations so runtime files are never staged.
    const gitignorePath = path.join(WORKSPACE, ".gitignore");
    const swarmbuildIgnore = [
        "",
        "# Swarmbuild runtime files — do not commit",
        ".deploy_key",
        "claude_mcp.json",
        "gemini_mcp.json",
        "codex_mcp.json",
        "*_mcp.json",
        "AGENT_PROMPT.md",
        "TASK_LIST.md",
        "SYSTEM_PROMPT.md",
        "MESSAGES.md",
        "",
    ].join("\n");
    try {
        const existing = await fs.readFile(gitignorePath, "utf8").catch(() => "");
        if (!existing.includes("Swarmbuild runtime files")) {
            await fs.writeFile(gitignorePath, existing + swarmbuildIgnore, "utf8");
        }
    } catch {
        await fs.writeFile(gitignorePath, swarmbuildIgnore.trim() + "\n", "utf8");
    }

    // Write prompt AT THE END so it doesn't dirty the working tree before git checkout/pull
    if (jobInfo.agent_prompt) {
        await fs.writeFile(path.join(WORKSPACE, "AGENT_PROMPT.md"), jobInfo.agent_prompt);
    }

    // Write test harness files so agents can validate their work
    if (jobInfo.test_files && typeof jobInfo.test_files === 'object') {
        for (const [filename, content] of Object.entries(jobInfo.test_files)) {
            const filepath = path.join(WORKSPACE, filename);
            await fs.mkdir(path.dirname(filepath), { recursive: true });
            await fs.writeFile(filepath, content);
            console.log(`[swarmbuild] Wrote test file: ${filename}`);
        }
    }

    // Write AI-generated task list as a suggestion for the Lead agent
    if (jobInfo.task_list && Array.isArray(jobInfo.task_list) && jobInfo.task_list.length > 0) {
        const taskContent = "# Suggested Task List\n\n" +
            "These tasks were generated by the AI planner. Use them as a starting point when creating tasks with `swarmbuild_create_tasks`.\n\n" +
            jobInfo.task_list.map((t, i) => `${i + 1}. ${t}`).join("\n") + "\n";
        await fs.writeFile(path.join(WORKSPACE, "TASK_LIST.md"), taskContent);
        console.log(`[swarmbuild] Wrote TASK_LIST.md with ${jobInfo.task_list.length} suggested tasks`);
    }
}

async function startAgentInteractive(api, role, jobInfo, isPlanning = false, WORKSPACE, runtimeName = "claude", forceWorkerMode = false) {
    const runtime = getRuntime(runtimeName);
    console.log(`[swarmbuild] Using runtime: ${runtime.name}`);

    // Build MCP server config (canonical, runtime-agnostic)
    const mcpServerConfig = {
        swarmbuild: {
            command: "node",
            args: [path.join(__dirname, "mcp-runner.js"), api.relayUrl, api.workerToken, WORKSPACE],
        },
    };

    if (process.env.GITHUB_TOKEN) {
        mcpServerConfig.github = {
            command: "docker",
            args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN },
        };
    }

    // Let the runtime adapter format the MCP config
    const mcpConfig = runtime.buildMCPConfig(mcpServerConfig);
    const mcpConfigPath = path.join(WORKSPACE, `${runtime.name}_mcp.json`);
    if (mcpConfig) {
        await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    }

    // When forceWorkerMode is true, treat as solo lead so we get the execution prompt
    // instead of the coordinator prompt — this lets the coordinator pick up its own tasks
    const isSoloLead = forceWorkerMode || (role === 'lead' && (
        !jobInfo.required_roles?.length ||
        jobInfo.required_roles.length === 1 ||
        jobInfo.required_roles.every(r => r === 'lead')
    ));

    // v2: Use prompt translation layer for runtime-specific prompts
    const systemPrompt = buildPrompt(runtime, {
        role,
        isPlanning,
        isSoloLead,
        jobInfo,
        availableRoles: jobInfo.required_roles,
    });

    // Write prompt to file as backup — but primary delivery is via stdin
    const systemPromptPath = path.join(WORKSPACE, "SYSTEM_PROMPT.md");
    await fs.writeFile(systemPromptPath, systemPrompt, "utf8");

    console.log(`[swarmbuild] Spawning ${runtime.name} (${isPlanning ? 'planning' : 'execution'}, role: ${role})...`);

    // Use the runtime adapter to spawn the agent
    const spawnConfig = {
        workspacePath: WORKSPACE,
        mcpConfigPath,
        systemPrompt,
        isPlanning,
        role,
        env: process.env,
    };

    return new Promise((resolve, reject) => {
        const proc = runtime.spawn(spawnConfig);

        let stdoutBuffer = "";
        proc.stdout?.on("data", (data) => {
            const str = data.toString();
            stdoutBuffer += str;
            process.stdout.write(str);
            api.publishLog(str).catch(() => { });
        });

        proc.stderr?.on("data", (data) => {
            const str = data.toString();
            process.stderr.write(str);
            api.publishLog(str).catch(() => { });
        });

        proc.on("close", (code) => {
            console.log(`[swarmbuild] ${runtime.name} exited with code ${code}`);
            api.publishLog(`SYSTEM: Agent exited with code ${code}`).catch(() => { });

            // Parse token usage from output
            try {
                const parsed = runtime.parseOutput(stdoutBuffer);
                if (parsed.tokensUsed > 0) {
                    totalTokensUsed += parsed.tokensUsed;
                }
            } catch { /* ignore parse errors */ }

            resolve(code);
        });

        proc.on("error", (err) => {
            console.log(`[swarmbuild] Error spawning ${runtime.name}. Is it installed?`);
            reject(err);
        });
    });
}
