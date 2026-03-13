# 02 — Merge Conflict Resolution

> **The problem**: In v1, all agents push directly to `main`. When two agents finish tasks at the same time, one of them gets a rebase conflict. With 5+ agents, merge conflicts are the **normal case**, not an edge case.
>
> Inspired by Overstory's FIFO merge queue with 4-tier conflict resolution.

---

## Table of Contents

1. [Problem Analysis](#problem-analysis)
2. [Branch-Per-Task Strategy](#branch-per-task-strategy)
3. [FIFO Merge Queue](#fifo-merge-queue)
4. [4-Tier Conflict Resolution](#4-tier-conflict-resolution)
5. [The Merge Agent Pattern](#the-merge-agent-pattern)
6. [Implementation Details](#implementation-details)
7. [Failure Modes & Mitigations](#failure-modes--mitigations)

---

## Problem Analysis

### v1 Git Flow (Broken at Scale)

```
Agent A ──commit──push main──► ✅ (first push wins)
Agent B ──commit──push main──► ❌ CONFLICT (remote has changed)
  └── rebase ──► Push again ──► ❌ STILL CONFLICTS (Agent C pushed meanwhile)
Agent C ──commit──push main──► ✅ (squeezed in between)
```

In v1, the MCP `complete_task` handler does:
1. `git add .`
2. `git commit -m "Completed task: {task_id}"`
3. `git pull --rebase origin main`
4. `git push origin main`

This fails when:
- **Textual conflicts**: Two agents edit the same file/line
- **Semantic conflicts**: Changes don't textually conflict but are logically incompatible (e.g., one agent adds a required field, another doesn't provide it)
- **Race conditions**: Multiple agents push within seconds of each other
- **Rebase loops**: Agent pulls, resolves, pushes, but another push landed during resolution

### What Overstory Teaches Us

Overstory uses **git worktrees** (each agent gets an isolated branch) and a **FIFO merge queue** backed by SQLite. Their 4-tier conflict resolution:

| Tier | Strategy | When Used |
|------|----------|-----------|
| 0 | Fast-forward | Branch is ahead of main, no divergence |
| 1 | Auto-merge | Git can merge automatically (no textual conflicts) |
| 2 | AI-assisted resolve | Textual conflicts, resolved by an AI agent analyzing both sides |
| 3 | Human review | Semantic conflicts or AI resolver fails — flagged for human |

SwarmBuild adapts this for a **server-managed remote queue** (not local SQLite), since our agents are distributed across the internet.

---

## Branch-Per-Task Strategy

### Design

Instead of all agents pushing to `main`, each agent pushes to a **task-specific branch**.

```
main ─────────────────────────────────────────────────► (clean history)
  │                                                     ▲
  ├── task/setup-db ────commit──push──► merge ──────────┘
  │                                                     ▲
  ├── task/auth-api ───────commit──push──► merge ──────┘
  │                                                     ▲
  └── task/frontend ──────────commit──push──► merge ───┘
```

### Branch Naming Convention

```
task/{task-id-short}
```

Example: `task/a1b2c3d4` (first 8 chars of the task UUID)

### MCP Changes Required

```javascript
// packages/cli/src/mcp.js — On claim_task:

if (request.params.name === "swarmbuild_claim_task") {
    const res = await api.claimTask(request.params.arguments.task_id);
    const taskId = request.params.arguments.task_id;
    const branchName = `task/${taskId.slice(0, 8)}`;

    // Sync with main first
    try {
        await runGitCommand("git fetch origin", workspacePath);
        await runGitCommand("git checkout main", workspacePath);
        await runGitCommand("git pull --rebase origin main", workspacePath);
    } catch (err) {
        // Empty repo — okay
    }

    // Create task branch from latest main
    try {
        await runGitCommand(`git checkout -b ${branchName}`, workspacePath);
    } catch {
        // Branch might already exist from a previous attempt
        await runGitCommand(`git checkout ${branchName}`, workspacePath);
        await runGitCommand("git rebase main", workspacePath);
    }

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                ...res,
                branch: branchName,
                message: `Working on branch '${branchName}'. Push here, server will merge to main.`
            }, null, 2)
        }]
    };
}
```

```javascript
// packages/cli/src/mcp.js — On complete_task:

if (request.params.name === "swarmbuild_complete_task") {
    const taskId = request.params.arguments.task_id;
    const branchName = `task/${taskId.slice(0, 8)}`;

    // Commit and push to task branch (NOT main)
    let gitStatus = "No git remote detected.";
    try {
        await runGitCommand("git add .", workspacePath);
        try {
            await runGitCommand(
                `git commit -m "Complete: ${taskId}"`,
                workspacePath
            );
        } catch (e) {
            if (!e.stdout?.includes("nothing to commit")) throw e;
        }

        // Push to task branch
        await pushToRemote(branchName, workspacePath);
        gitStatus = `Pushed to branch '${branchName}'. Server will merge to main.`;

        // Enqueue merge request on the server
        await api.enqueueMerge(taskId, branchName);

    } catch (err) {
        gitStatus = `Git push failed: ${err.message}`;
    }

    const res = await api.completeTask(taskId, request.params.arguments.status);
    return {
        content: [{
            type: "text",
            text: JSON.stringify({ ...res, git_sync: gitStatus }, null, 2)
        }]
    };
}
```

---

## FIFO Merge Queue

### Design

A server-side queue that processes merge requests one at a time, in the order they arrive.

```
┌─────────────────────────────────────────────────┐
│                MERGE QUEUE (FIFO)                │
│                                                  │
│  Position 1: task/a1b2c3d4 (Agent Lead)      ◄──│── Currently processing
│  Position 2: task/e5f6g7h8 (Agent Backend)      │
│  Position 3: task/i9j0k1l2 (Agent Frontend)     │
│                                                  │
│  Processing strategy:                           │
│  ├─ Tier 0: Fast-forward possible? → Merge now  │
│  ├─ Tier 1: Auto-merge (no conflicts)? → Merge  │
│  ├─ Tier 2: AI-assisted resolve → Attempt merge │
│  └─ Tier 3: Flag for human review               │
└─────────────────────────────────────────────────┘
```

### Database Schema

```sql
CREATE TABLE merge_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    task_id         UUID NOT NULL REFERENCES tasks(id),
    worker_token    TEXT NOT NULL,
    
    -- Git info
    branch_name     TEXT NOT NULL,
    commit_sha      TEXT,        -- HEAD of the task branch at enqueue time
    
    -- Queue management
    position        INT NOT NULL, -- Order in queue (auto-increment per job)
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                        'pending',      -- Waiting in queue
                        'processing',   -- Currently being merged
                        'merged',       -- Successfully merged to main
                        'conflict',     -- Has conflicts, needs resolution
                        'failed',       -- Merge failed permanently
                        'cancelled'     -- Task was cancelled
                    )),
    
    -- Conflict info
    conflict_tier   INT,          -- Which tier resolved (or failed at)
    conflict_files  JSONB,        -- List of conflicting file paths
    conflict_diff   TEXT,         -- The conflict diff for human review
    resolution_by   TEXT,         -- 'auto', 'ai', 'human', or a user_id
    
    -- Timing
    created_at      TIMESTAMPTZ DEFAULT now(),
    started_at      TIMESTAMPTZ, -- When merge processing started
    completed_at    TIMESTAMPTZ, -- When merge completed (or failed)
    
    -- Metadata
    files_changed   INT DEFAULT 0,
    lines_added     INT DEFAULT 0,
    lines_removed   INT DEFAULT 0
);

CREATE INDEX idx_merge_queue_job ON merge_queue(job_id, position);
CREATE INDEX idx_merge_queue_status ON merge_queue(status);
```

### API Endpoints

```python
# apps/api/routers/merge.py

router = APIRouter()

@router.post("/{token}/merge/enqueue")
async def enqueue_merge(token: str, req: MergeRequest):
    """Agent requests their task branch be merged into main."""
    contributor = _verify_token(token)
    db = get_supabase()
    job_id = contributor["job_id"]

    # Get next position in queue
    last = (
        db.table("merge_queue")
        .select("position")
        .eq("job_id", job_id)
        .order("position", desc=True)
        .limit(1)
        .execute()
    )
    next_position = (last.data[0]["position"] + 1) if last.data else 1

    result = db.table("merge_queue").insert({
        "job_id": job_id,
        "task_id": req.task_id,
        "worker_token": token,
        "branch_name": req.branch_name,
        "commit_sha": req.commit_sha,
        "position": next_position,
        "status": "pending",
    }).execute()

    await manager.broadcast(job_id, {
        "type": "merge_enqueued",
        "branch": req.branch_name,
        "position": next_position,
    })

    return {"status": "ok", "position": next_position, "queue_id": result.data[0]["id"]}


@router.get("/{job_id}/merge/queue")
async def get_merge_queue(job_id: str):
    """View the current merge queue for a job."""
    db = get_supabase()
    result = (
        db.table("merge_queue")
        .select("*")
        .eq("job_id", job_id)
        .order("position")
        .execute()
    )
    return {"queue": result.data}


@router.post("/{job_id}/merge/{queue_id}/resolve")
async def resolve_conflict(job_id: str, queue_id: str, req: ResolveRequest, request: Request):
    """Human resolves a merge conflict manually."""
    user_id = await _get_user_id(request)
    # ... apply human resolution, mark merged
```

---

## 4-Tier Conflict Resolution

### Tier 0: Fast-Forward

**Condition**: The task branch is a direct descendant of the current `main` HEAD. No other merges happened since this branch was created.

```
main: A ── B ── C
                └── task/xyz: D ── E

Fast-forward: main becomes A ── B ── C ── D ── E
```

**Implementation**: `git merge --ff-only task/xyz`

**Success rate**: ~60% when agents work sequentially (low parallelism jobs).

### Tier 1: Auto-Merge

**Condition**: The branches have diverged but git can merge them automatically (no textual conflicts).

```
main: A ── B ── C ── F (from another task merge)
                └── task/xyz: D ── E

                     file1.py changed by F
                     file2.py changed by D, E (different files)
```

**Implementation**: `git merge --no-ff task/xyz`

**Success rate**: ~80% when agents work on different files (which a good task decomposition ensures).

### Tier 2: AI-Assisted Resolution

**Condition**: Textual conflicts exist. An AI agent analyzes both sides and proposes a resolution.

**Implementation**:
1. Clone the repo to a temp directory
2. Attempt `git merge task/xyz`
3. Git reports conflicting files
4. For each conflicting file:
   - Extract the `<<<<<<< HEAD`, `=======`, `>>>>>>> task/xyz` markers
   - Send to an LLM with context: "These two agents modified the same file. Agent A (on main) did X. Agent B (on the task branch) did Y. Merge them correctly."
   - Apply the LLM's resolution
5. `git add . && git commit -m "AI-resolved merge: task/xyz"`
6. If all conflicts resolved, push to main

**Constraints**:
- Only attempts resolution for files < 500 lines of conflict
- Marks as Tier 3 if resolution fails validation (tests fail after merge)
- Rate-limited to prevent cost explosion (max 3 AI resolution attempts per merge)

### Tier 3: Human Review

**Condition**: AI resolution failed, or the conflicts are too complex for automated resolution.

**Implementation**:
1. The merge queue item status becomes `conflict`
2. WebSocket broadcasts to the lobby: "Merge conflict needs human review"
3. The web UI shows a diff view with conflict markers
4. The job poster (or any contributor) resolves the conflict in the UI
5. Resolution is applied and the merge completes

**UI Flow**:
```
┌─────────────────────────────────────────────────────┐
│  Merge Conflict — task/a1b2c3d4                     │
│                                                     │
│  Conflicting files:                                │
│  ├── src/auth.ts (3 conflicts)                     │
│  └── src/types.ts (1 conflict)                     │
│                                                     │
│  ┌─────────────────┐  ┌──────────────────┐         │
│  │   main (HEAD)    │  │  task/a1b2c3d4   │         │
│  │                  │  │                  │         │
│  │  export type     │  │  export type     │         │
│  │  User = {        │  │  User = {        │         │
│  │    id: string;   │  │    id: string;   │         │
│  │    name: string; │  │    name: string; │         │
│  │    role: string; │  │    email: string;│         │
│  │  }               │  │    role: Role;   │         │
│  │                  │  │  }               │         │
│  └─────────────────┘  └──────────────────┘         │
│                                                     │
│  [Accept Left] [Accept Right] [Edit Manually]      │
└─────────────────────────────────────────────────────┘
```

---

## The Merge Agent Pattern

### Why Not Run Git on the API Server?

The API server (on Render) shouldn't perform git operations because:
1. Render containers have limited disk space and no persistent storage
2. Cloning repos for every merge is slow and expensive
3. Git operations can hang (SSH timeouts, large repos)
4. It adds operational complexity to the API server

### The Solution: A Dedicated Merge Agent

A **merge agent** is a special always-on CLI process that only processes the merge queue. It runs on a machine with:
- Persistent disk (for repo clones)
- Git + SSH configured
- Access to the GITHUB_TOKEN

```
┌───────────────┐     polls queue      ┌──────────────────┐
│  API Server   │◄────(every 10s)──────│  Merge Agent CLI │
│               │                      │                  │
│  merge_queue  │─────next item────────►│  git checkout    │
│               │                      │  git merge       │
│               │◄────result───────────│  git push main   │
│               │     (merged/failed)  │                  │
└───────────────┘                      └──────────────────┘
```

### Merge Agent Implementation

```javascript
// packages/cli/src/merge-agent.js

async function runMergeAgent(apiUrl, token) {
    const api = new SwarmbuildAPI(apiUrl, token);
    
    console.log("[merge-agent] Starting merge agent...");
    
    while (true) {
        try {
            // 1. Get next pending merge from queue
            const next = await api.getNextPendingMerge();
            
            if (!next) {
                await sleep(10_000); // No work, wait 10s
                continue;
            }
            
            console.log(`[merge-agent] Processing merge: ${next.branch_name} (queue position ${next.position})`);
            
            // 2. Update status to processing
            await api.updateMergeStatus(next.id, "processing");
            
            // 3. Clone/update the repo
            await syncRepo(next.job_repo_url, next.deploy_key);
            
            // 4. Attempt tiered merge
            const result = await attemptMerge(next.branch_name);
            
            // 5. Report result
            if (result.success) {
                await api.updateMergeStatus(next.id, "merged", {
                    conflict_tier: result.tier,
                    files_changed: result.filesChanged,
                    lines_added: result.linesAdded,
                    lines_removed: result.linesRemoved,
                });
                console.log(`[merge-agent] ✅ Merged ${next.branch_name} (tier ${result.tier})`);
            } else {
                await api.updateMergeStatus(next.id, "conflict", {
                    conflict_tier: result.tier,
                    conflict_files: result.conflictFiles,
                    conflict_diff: result.conflictDiff,
                });
                console.log(`[merge-agent] ⚠️ Conflict on ${next.branch_name} — needs human review`);
            }
            
        } catch (err) {
            console.error(`[merge-agent] Error: ${err.message}`);
            await sleep(5_000);
        }
    }
}

async function attemptMerge(branchName) {
    // Tier 0: Fast-forward
    try {
        await exec(`git merge --ff-only origin/${branchName}`);
        await exec("git push origin main");
        return { success: true, tier: 0, ...getStats() };
    } catch {
        // Not fast-forwardable, try next tier
    }
    
    // Tier 1: Auto-merge
    try {
        await exec(`git merge --no-ff origin/${branchName} -m "Merge ${branchName}"`);
        await exec("git push origin main");
        return { success: true, tier: 1, ...getStats() };
    } catch (e) {
        // Has conflicts
        await exec("git merge --abort");
    }
    
    // Tier 2: AI-assisted (future — skip for v2.0, go straight to Tier 3)
    
    // Tier 3: Flag for human review
    const conflictInfo = await getConflictInfo(branchName);
    return { success: false, tier: 3, ...conflictInfo };
}
```

---

## Failure Modes & Mitigations

| Failure | Mitigation |
|---------|------------|
| Merge agent crashes | Merge queue items stay as `processing`, watchdog re-marks as `pending` after timeout |
| Two merge agents run simultaneously | Queue uses `SELECT ... FOR UPDATE` to prevent double-processing |
| Task branch deleted before merge | Queue item marked as `failed` with reason |
| Main branch has force-push protection | Use GitHub API for merge instead of git CLI (creates merge commit via API) |
| Merge produces broken code | Tier 1+ runs test suite post-merge; if tests fail, revert and escalate to next tier |
| Queue grows faster than processing | Rate-limit task completions per job, or spawn multiple merge agents |

---

## Implementation Details

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/api/routers/merge.py` | **NEW** | Merge queue endpoints |
| `apps/api/init.sql` | **MODIFY** | Add `merge_queue` table |
| `packages/cli/src/merge-agent.js` | **NEW** | Merge agent CLI |
| `packages/cli/src/mcp.js` | **MODIFY** | Branch-per-task on claim/complete |
| `packages/cli/src/api.js` | **MODIFY** | New `enqueueMerge()` method |
| `packages/cli/bin/swarmbuild.js` | **MODIFY** | Add `merge-agent` command |
