# 05 — Agent Collaboration via Git

> **Problem**: In the first live run, the frontend agent completed 5 tasks sequentially but never checked what other agents had done. Each agent works in isolation on its task branch, unaware of code written by others. When Task 3 (bouncing animation) needs the HTML from Task 1 and the CSS from Task 2, the agent has to re-invent them because it can't see the merged main branch.

---

## Root Cause Analysis

The v2 branch-per-task flow creates isolation by design:

```
main ──────────────────────────────────────────────────►
  ├── task/ff0fae79 (agent creates HTML)     → push → merge queue → wait
  ├── task/dc7a67c8 (agent creates CSS)      → push → merge queue → wait
  ├── task/966ae769 (agent creates JS)       → push → merge queue → wait
  └── task/04a9566b (agent creates tests)    → push → merge queue → wait
```

Each branch starts from `main` at the time of `claim_task`. But if Task 1 hasn't been merged yet when Task 2 starts, Task 2 doesn't see Task 1's HTML. The agent on Task 2 might create a duplicate `index.html` or reference files that don't exist on its branch.

### What Overstory Does

Overstory uses **git worktrees** — each agent gets an isolated checkout of the same repo. But critically, the coordinator merges completed work back to a **canonical branch** before dispatching the next task. So each new worktree starts from the latest merged state.

### What Beads Does

Beads tracks task dependencies as a graph. A task won't become `ready` until its parents are closed AND merged. This ensures agents always work on a codebase that includes prerequisite work.

---

## Design: Pre-Task Sync from Latest Main

### The Core Fix: Pull Main Before Branching

When an agent claims a task, the MCP `claim_task` handler should:

1. **Fetch latest main** (which includes recently merged work from other agents)
2. **Create the task branch from that updated main**

This already happens in theory (`git fetch origin` + `git checkout main` + `git pull`), but the merge queue wasn't processing — so main never had the latest work. With auto-merge (doc 01) fixed, this flow works correctly.

### Enhanced Flow: Rebase on Main Before Complete

Before pushing a completed task, rebase on the latest main to pick up any work merged since the branch was created:

```javascript
// mcp.js — In complete_task handler, before push:

// Sync with latest main (includes other agents' merged work)
try {
    await runGitCommand("git fetch origin", workspacePath);
    await runGitCommand("git rebase origin/main", workspacePath);
} catch (rebaseErr) {
    // Rebase conflict — abort and push as-is, let merge queue handle it
    await runGitCommand("git rebase --abort", workspacePath);
}

// Then push to task branch
gitStatus = await pushToRemote(branchName, workspacePath);
```

### Git Context Injection

When an agent claims a task, include a summary of what's already been done:

```javascript
// mcp.js — In claim_task handler:

// Fetch recent git log from main for context
let recentWork = "";
try {
    const { stdout } = await exec(
        'git log --oneline -10 origin/main',
        { cwd: workspacePath }
    );
    recentWork = stdout.trim();
} catch { /* no commits yet */ }

return {
    content: [{
        type: "text",
        text: JSON.stringify({
            ...res,
            branch: branchName,
            git_sync: gitStatus,
            recent_commits: recentWork,
            message: recentWork
                ? `Other agents have already committed:\n${recentWork}\n\nYour work should build on top of theirs.`
                : "You're the first agent to work on this codebase.",
        }, null, 2)
    }]
};
```

### Dependency-Aware Task Availability

With auto-merge working (doc 01), the DAG dependency system ensures proper ordering:

```
Task A (HTML) → completed → auto-merged to main
                ↓ (depends_on satisfied)
Task B (CSS) → now claimable → agent pulls main → sees Task A's HTML
                ↓ (depends_on satisfied)  
Task C (JS) → now claimable → agent pulls main → sees A's HTML + B's CSS
```

The key is that **auto-merge must complete before dependent tasks become claimable**. The dependency check in `claim_task` already blocks on `status = completed`, but we should also verify the merge is done:

```python
# tasks.py — Enhanced dependency check:
# In addition to task status, check merge status
for dep_id in depends_on:
    dep_task = task_map.get(dep_id)
    if dep_task["status"] != "completed":
        blocking.append(dep_task)
    else:
        # Also check if the merge is complete
        merge = db.table("merge_queue").select("status").eq("task_id", dep_id).execute()
        if merge.data and merge.data[0]["status"] not in ("merged",):
            blocking.append({**dep_task, "reason": "completed but not yet merged"})
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/src/mcp.js` | **MODIFY** | Add rebase-on-main before push in complete_task; add recent_commits context in claim_task |
| `apps/api/routers/tasks.py` | **MODIFY** | Check merge status in dependency validation (not just task status) |
