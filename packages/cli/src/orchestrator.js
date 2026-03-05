import { spawn, exec as execCb } from "child_process";
import fs from "fs/promises";
import path from "path";
import util from "util";
import { fileURLToPath } from "url";
import { SwarmbuildAPI } from "./api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const exec = util.promisify(execCb);
export async function runLobby(jobId, options) {
    const { role, relay, token } = options;
    console.log(`[swarmbuild] Joining Job ${jobId} as ${role}...`);

    const api = new SwarmbuildAPI(relay, token);

    // 1. Register and get worker token
    const contrib = await api.register(jobId, role);
    console.log(`[DEBUG] api.register finished! Worker token is: ${api.workerToken}`);
    console.log(`[swarmbuild] ✅ Joined! Worker Token: wt_...${api.workerToken?.slice(-6) || 'null'} `);

    // 2. Fetch Job Info
    const jobInfo = await api.getJobInfo();

    const WORKSPACE = path.join(process.cwd(), `workspace-${jobId}`);

    // 3. Setup local workspace
    await setupWorkspace(jobInfo, WORKSPACE);

    // 4. Pre-Run Lobby Loop
    if (role === 'lead') {
        console.log(`\n[swarmbuild] You are the LEAD. Launching Claude to propose the Agent Team Plan...`);
        await startAgentInteractive(api, role, jobInfo, true, WORKSPACE);
        console.log(`\n[swarmbuild] ℹ️ Tip: Claude operates fully autonomously and exits when its instruction finishes.`);
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
        // Simple poll
        while (true) {
            await new Promise(r => setTimeout(r, 3000));
            // In a real app we'd websocket this, but polling for MVP is okay
            const check = await api.client.get(`/api/jobs/${jobId}`);
            if (check.data.lobby_state === 'executing') break;
        }
        console.log(`[swarmbuild] 🚀 Execution starting...`);
    }

    // 5. Execution Loop
    console.log(`[swarmbuild] Entering continuous execution loop...`);
    while (true) {
        // Fetch tasks to check status
        let tasks = [];
        try {
            tasks = await api.getTasks();
        } catch (e) {
            console.log(`[swarmbuild] Error fetching tasks: ${e.message}. Retrying in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        const pendingTasks = tasks.filter(t => t.status === 'available' || t.status === 'locked');
        if (pendingTasks.length === 0) {
            if (tasks.length === 0) {
                // Lead agent hasn't created tasks yet — wait rather than exit
                console.log(`[swarmbuild] ⏳ No tasks created yet. Waiting for lead agent to create tasks...`);
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }
            // Every task is in a terminal state (completed / failed)
            console.log(`\n[swarmbuild] 🎉 All tasks for the job are complete! Exiting gracefully...`);
            break;
        }

        // A solo lead (the only required role) takes all tasks regardless of assigned_role
        const isSoloLead = role === 'lead' && (
            !jobInfo.required_roles?.length ||
            jobInfo.required_roles.length === 1 ||
            jobInfo.required_roles.every(r => r === 'lead')
        );
        const myRoleTasks = isSoloLead
            ? pendingTasks
            : pendingTasks.filter(t => t.assigned_role === role);
        if (myRoleTasks.length === 0) {
            console.log(`[swarmbuild] ⏳ No pending tasks for role '${role}'. Sleeping for 10 seconds before checking again...`);
            await new Promise(r => setTimeout(r, 10000));
            continue;
        }

        const exitCode = await startAgentInteractive(api, role, jobInfo, false, WORKSPACE);

        if (exitCode !== 0) {
            console.log(`[swarmbuild] Agent exited with code ${exitCode}. Pausing for 5s before loop restarts...`);
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

    // Write .gitignore so sensitive runtime files are never accidentally committed.
    // Do this unconditionally (git and non-git workspaces both benefit).
    const gitignorePath = path.join(WORKSPACE, ".gitignore");
    const gitignoreContent = [
        "# Swarmbuild runtime files — do not commit",
        ".deploy_key",
        "claude_mcp.json",
        "AGENT_PROMPT.md",
        "TASK_LIST.md",
        "",
    ].join("\n");
    // Only write if it doesn't already exist so we don't clobber a project's own .gitignore
    try {
        await fs.access(gitignorePath);
    } catch {
        await fs.writeFile(gitignorePath, gitignoreContent, "utf8");
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

async function startAgentInteractive(api, role, jobInfo, isPlanning = false, WORKSPACE) {
    // We start the MCP Server in the same Node process, but attach it to stdio.
    // Wait, if Claude connects via MCP, Claude needs to *launch* an MCP server.
    // We handle that by writing a fast claude config json.

    const mcpConfigPath = path.join(WORKSPACE, "claude_mcp.json");
    const mcpConfig = {
        "mcpServers": {
            "swarmbuild": {
                "command": "node",
                "args": [path.join(__dirname, "mcp-runner.js"), api.relayUrl, api.workerToken, WORKSPACE]
            }
        }
    };

    if (process.env.GITHUB_TOKEN) {
        mcpConfig.mcpServers.github = {
            "command": "docker",
            "args": [
                "run",
                "-i",
                "--rm",
                "-e",
                "GITHUB_PERSONAL_ACCESS_TOKEN",
                "ghcr.io/github/github-mcp-server"
            ],
            "env": {
                "GITHUB_PERSONAL_ACCESS_TOKEN": process.env.GITHUB_TOKEN
            }
        };
    }

    await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    const isSoloLead = role === 'lead' && (
        !jobInfo.required_roles?.length ||
        jobInfo.required_roles.length === 1 ||
        jobInfo.required_roles.every(r => r === 'lead')
    );

    let prompt = "";
    if (isPlanning && role === 'lead') {
        const availableRoles = jobInfo.required_roles && jobInfo.required_roles.length > 0
            ? jobInfo.required_roles.join(", ")
            : "lead";

        if (isSoloLead) {
            prompt = `Read AGENT_PROMPT.md and TASK_LIST.md. TASK_LIST.md contains AI-suggested tasks — use them as your starting point. You are the SOLE agent on this job. Use swarmbuild_create_tasks to create all tasks. Assign ALL tasks to assigned_role = "lead" since you are the only contributor. DO NOT write code yourself during planning.`;
        } else {
            prompt = `Read AGENT_PROMPT.md and TASK_LIST.md. TASK_LIST.md contains AI-suggested tasks — use them as your starting point. Use swarmbuild_create_tasks to create tasks for the team. YOU MUST map every task to one of these specific assigned_roles: [${availableRoles}]. DO NOT invent roles like "developer", use ONLY the provided roles. DO NOT write code yourself.`;
        }
    } else if (isSoloLead) {
        prompt = `You are the Lead agent and sole contributor on this job. Read AGENT_PROMPT.md. Use swarmbuild_get_tasks to find ALL available tasks regardless of their assigned_role. Claim them one at a time and implement them fully. Use swarmbuild_send_message to report progress.`;
    } else {
        prompt = `You are a ${role}. Use swarmbuild_get_tasks to find tasks with assigned_role = "${role}". Claim them, run them, complete them. Use swarmbuild_send_message if stuck.`;
    }
    const isWindows = process.platform === 'win32';
    const escapedPrompt = isWindows ? `"${prompt.replace(/"/g, '\\"')}"` : prompt;

    console.log(`[swarmbuild] Spawning Claude Code...`);

    return new Promise((resolve, reject) => {
        const claudeArgs = [
            escapedPrompt,
            "--mcp-config", "claude_mcp.json",
            "--dangerously-skip-permissions"
        ];

        // If GITHUB_TOKEN is missing, restrict tools to swarmbuild only. Otherwise, allow github tools by omitting the restriction.
        if (!process.env.GITHUB_TOKEN) {
            claudeArgs.push("--allowed-tools", "swarmbuild_create_tasks,swarmbuild_get_tasks,swarmbuild_claim_task,swarmbuild_complete_task,swarmbuild_send_message,swarmbuild_read_chat");
        }

        // Actually spawn the global `claude` CLI
        const claude = spawn("claude", claudeArgs, {
            cwd: WORKSPACE,
            stdio: ["inherit", "pipe", "pipe"], // Allow stdin so TTY features and colors might work natively
            shell: true,
            env: { ...process.env, CLAUDE_CONFIG_FILE: mcpConfigPath, FORCE_COLOR: "1" }
        });

        // Pipe stdout to backend logs AND to terminal
        claude.stdout.on("data", (data) => {
            const str = data.toString();
            process.stdout.write(str);
            api.publishLog(str).catch(() => { });
        });

        // Pipe stderr to backend logs AND to terminal
        claude.stderr.on("data", (data) => {
            const str = data.toString();
            process.stderr.write(str);
            api.publishLog(str).catch(() => { });
        });

        claude.on("close", (code) => {
            console.log(`[swarmbuild] Claude exited with code ${code} `);
            api.publishLog(`SYSTEM: Agent exited with code ${code}`).catch(() => { });
            resolve(code);
        });

        claude.on("error", (err) => {
            console.log(`[swarmbuild] Error spawning Claude Code.Is it installed ? (npm i - g @anthropic-ai / claude - code)`);
            reject(err);
        });
    });
}
