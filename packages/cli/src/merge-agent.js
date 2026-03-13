/**
 * Merge Agent — Dedicated CLI process that polls the merge queue and
 * processes branch merges into main using tiered conflict resolution.
 *
 * Runs as: swarmbuild merge-agent --job <job_id> --relay <url> --token <token>
 *
 * Reference: The Engineering/02-MERGE-RESOLUTION.md §The Merge Agent Pattern
 */

import { exec as execCb } from "child_process";
import fs from "fs/promises";
import path from "path";
import util from "util";
import { SwarmbuildAPI } from "./api.js";

const exec = util.promisify(execCb);

const POLL_INTERVAL = 10_000; // 10 seconds
const REPO_DIR = path.join(process.cwd(), ".merge-agent-repo");

/**
 * Run the merge agent loop for a specific job.
 */
export async function runMergeAgent(jobId, options) {
    const { relay, token } = options;
    console.log(`[merge-agent] Starting merge agent for job ${jobId}...`);

    const api = new SwarmbuildAPI(relay, token);

    // Register as a special merge-agent contributor
    try {
        await api.register(jobId, "merge-agent");
        console.log(`[merge-agent] Registered as merge-agent. Token: ...${api.workerToken?.slice(-6)}`);
    } catch (err) {
        console.error(`[merge-agent] Failed to register: ${err.response?.data?.detail || err.message}`);
        process.exit(1);
    }

    // Fetch job info for repo URL
    const jobInfo = await api.getJobInfo();
    if (!jobInfo.github_repo_url) {
        console.error(`[merge-agent] No GitHub repo configured for this job.`);
        process.exit(1);
    }

    // Setup local repo clone
    await setupMergeRepo(jobInfo);

    console.log(`[merge-agent] Polling merge queue every ${POLL_INTERVAL / 1000}s...`);
    console.log(`[merge-agent] Press Ctrl+C to stop.\n`);

    // Graceful shutdown
    process.on("SIGINT", () => {
        console.log(`\n[merge-agent] Shutting down...`);
        process.exit(0);
    });

    // Main loop
    while (true) {
        try {
            const queueRes = await api.client.get(`/api/${jobId}/merge/next`);
            const next = queueRes.data.next;

            if (!next) {
                await sleep(POLL_INTERVAL);
                continue;
            }

            console.log(`[merge-agent] Processing: ${next.branch_name} (position ${next.position})`);

            // Mark as processing
            await api.client.post(`/api/${jobId}/merge/${next.id}/status`, {
                decision: "processing",
            });

            // Attempt tiered merge
            const result = await attemptMerge(next.branch_name, jobInfo);

            if (result.success) {
                await api.client.post(`/api/${jobId}/merge/${next.id}/status`, {
                    decision: "merged",
                    resolution_by: `auto-tier${result.tier}`,
                });
                console.log(`[merge-agent] ✅ Merged ${next.branch_name} (tier ${result.tier})`);
            } else {
                await api.client.post(`/api/${jobId}/merge/${next.id}/status`, {
                    decision: "conflict",
                    resolution_by: null,
                    conflict_diff: result.conflictDiff || "",
                });
                console.log(`[merge-agent] ⚠️ Conflict on ${next.branch_name} — needs human review`);
            }

        } catch (err) {
            console.error(`[merge-agent] Error: ${err.message}`);
            await sleep(5_000);
        }
    }
}

/**
 * Clone or update the repo for merge operations.
 */
async function setupMergeRepo(jobInfo) {
    const repoExists = await fs.access(path.join(REPO_DIR, ".git")).then(() => true).catch(() => false);

    if (repoExists) {
        console.log(`[merge-agent] Updating existing repo clone...`);
        try {
            await execInRepo("git fetch origin");
            await execInRepo("git checkout main");
            await execInRepo("git pull --rebase origin main");
            console.log(`[merge-agent] ✅ Repo updated.`);
        } catch (err) {
            console.log(`[merge-agent] ⚠️ Repo update failed, re-cloning: ${err.message}`);
            await fs.rm(REPO_DIR, { recursive: true, force: true });
            await cloneRepo(jobInfo);
        }
    } else {
        await cloneRepo(jobInfo);
    }
}

async function cloneRepo(jobInfo) {
    console.log(`[merge-agent] Cloning repo...`);
    await fs.mkdir(REPO_DIR, { recursive: true });

    // Write deploy key
    if (jobInfo.github_deploy_key_private) {
        const keyPath = path.join(REPO_DIR, ".deploy_key");
        await fs.writeFile(keyPath, jobInfo.github_deploy_key_private, { mode: 0o600 });
        const sshKeyPath = process.platform === 'win32' ? keyPath.replace(/\\/g, '\\\\') : keyPath;

        await exec(`git clone ${jobInfo.github_repo_url} ${REPO_DIR}`);
        await execInRepo(`git config core.sshCommand "ssh -i \\"${sshKeyPath}\\" -o StrictHostKeyChecking=no"`);
    } else {
        await exec(`git clone ${jobInfo.github_repo_url} ${REPO_DIR}`);
    }

    console.log(`[merge-agent] ✅ Repo cloned.`);
}

/**
 * Attempt a tiered merge of a branch into main.
 *
 * Tier 0: Fast-forward (branch is direct descendant of main)
 * Tier 1: Auto-merge (git can merge without conflicts)
 * Tier 3: Flag for human review (conflicts exist)
 */
async function attemptMerge(branchName, jobInfo) {
    // Ensure we're on latest main
    await execInRepo("git checkout main");
    await execInRepo("git pull --rebase origin main");
    await execInRepo("git fetch origin");

    // Tier 0: Fast-forward
    try {
        await execInRepo(`git merge --ff-only origin/${branchName}`);
        await pushMain(jobInfo);
        return { success: true, tier: 0, ...await getStats() };
    } catch {
        // Not fast-forwardable, reset and try next tier
        await execInRepo("git reset --hard HEAD");
    }

    // Tier 1: Auto-merge (no conflicts)
    try {
        await execInRepo(`git merge --no-ff origin/${branchName} -m "Merge ${branchName}"`);
        await pushMain(jobInfo);
        return { success: true, tier: 1, ...await getStats() };
    } catch {
        // Has conflicts — abort and escalate
        try {
            await execInRepo("git merge --abort");
        } catch { /* already clean */ }
    }

    // Tier 2: AI-assisted resolution — skipped for v2.0, go to Tier 3

    // Tier 3: Flag for human review
    const conflictInfo = await getConflictInfo(branchName);
    return { success: false, tier: 3, ...conflictInfo };
}

/**
 * Push main to origin.
 */
async function pushMain(jobInfo) {
    const githubToken = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

    if (githubToken) {
        // HTTPS push
        const { stdout: remoteUrl } = await exec("git remote get-url origin", { cwd: REPO_DIR });
        const sshMatch = remoteUrl.trim().match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/);
        if (sshMatch) {
            const httpsUrl = `https://x-access-token:${githubToken}@github.com/${sshMatch[1]}.git`;
            await exec(`git push ${httpsUrl} main`, { cwd: REPO_DIR });
            return;
        }
    }

    // SSH push (deploy key)
    await execInRepo("git push origin main");
}

async function getStats() {
    try {
        const { stdout } = await execInRepo("git diff --stat HEAD~1 HEAD");
        const lines = stdout.trim().split("\n");
        const summary = lines[lines.length - 1] || "";
        const filesMatch = summary.match(/(\d+) files? changed/);
        const addMatch = summary.match(/(\d+) insertions?/);
        const delMatch = summary.match(/(\d+) deletions?/);
        return {
            filesChanged: filesMatch ? parseInt(filesMatch[1]) : 0,
            linesAdded: addMatch ? parseInt(addMatch[1]) : 0,
            linesRemoved: delMatch ? parseInt(delMatch[1]) : 0,
        };
    } catch {
        return { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
    }
}

async function getConflictInfo(branchName) {
    try {
        // Attempt merge to see what conflicts
        await execInRepo(`git merge --no-commit --no-ff origin/${branchName}`);
    } catch { /* expected to fail */ }

    let conflictDiff = "";
    let conflictFiles = [];
    try {
        const { stdout } = await execInRepo("git diff --name-only --diff-filter=U");
        conflictFiles = stdout.trim().split("\n").filter(Boolean);
        const { stdout: diff } = await execInRepo("git diff");
        conflictDiff = diff.slice(0, 10000); // Cap at 10KB
    } catch { /* ignore */ }

    try {
        await execInRepo("git merge --abort");
    } catch { /* already clean */ }

    return { conflictFiles, conflictDiff };
}

async function execInRepo(cmd) {
    return exec(cmd, { cwd: REPO_DIR });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
