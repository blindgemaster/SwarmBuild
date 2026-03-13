# 01 — Auto-Merge Pipeline

> **Problem**: In the first live run, the frontend agent completed all 5 tasks and pushed to task branches. 4 PRs appeared on GitHub. The lead agent sat idle. The user had to manually click "Merge pull request" 4 times. This defeats the purpose of autonomous agents.

---

## Root Cause Analysis

The v2 merge flow has three disconnected pieces that were never wired together:

1. **`mcp.js` complete_task**: Pushes to `task/{id}` branch + calls `api.enqueueMerge()` → ✅ Works
2. **`routers/merge.py`**: Server stores merge queue entries with `status=pending` → ✅ Works  
3. **`merge-agent.js`**: CLI process that polls queue and merges → ❌ **Never started by anyone**

The merge agent was designed as a separate process (`swarmbuild merge-agent <job_id>`), but nobody runs it. The lead agent doesn't know about it. The server doesn't auto-start it. Result: merge queue fills up, nothing processes it.

### Why Overstory Gets This Right

Overstory's merge is **built into the coordinator**, not a separate process. When a worker sends a `merge_ready` mail message, the coordinator:
1. Picks it up on its next `ov mail check` cycle
2. Runs `ov merge --branch worker-branch` 
3. If conflicts → escalation message back to the worker
4. If clean → auto-merge, notify all agents

**Key insight**: Merge should be a **server-side background task**, not a separate CLI process that someone has to remember to start.

---

## Design: Server-Side Auto-Merge

### Option A: Background Task in API Server (Recommended)

Add a `merge_processor_loop()` alongside the existing `watchdog_loop()` in the FastAPI lifespan. It runs every 15 seconds, picks the next pending merge, and processes it via the GitHub API (no git clone needed).

```
FastAPI Lifespan
  ├── watchdog_loop()        (every 60s — agent health)
  └── merge_processor_loop() (every 15s — auto-merge queue)
```

### Why GitHub API Instead of Git Clone

The API server runs on Render (no persistent disk). Instead of cloning repos and running `git merge`, we use the **GitHub Merge API**:

```
POST /repos/{owner}/{repo}/merges
{
  "base": "main",
  "head": "task/abc12345",
  "commit_message": "Merge task/abc12345 (auto-merge)"
}
```

This is:
- **No disk needed** — pure HTTP call
- **Atomic** — GitHub handles conflict detection
- **Fast** — no clone/fetch/push cycle
- **Reliable** — GitHub's merge engine is battle-tested

### Merge Processor Implementation

```python
# apps/api/lib/merge_processor.py

async def merge_processor_loop():
    """Background task that auto-merges pending queue items via GitHub API."""
    await asyncio.sleep(30)  # Grace period on startup
    
    while True:
        try:
            await process_next_merge()
        except Exception as e:
            print(f"[merge] Error: {e}")
        await asyncio.sleep(15)


async def process_next_merge():
    db = get_supabase()
    
    # Get next pending merge (FIFO)
    pending = (
        db.table("merge_queue")
        .select("*, jobs(github_repo_id)")
        .eq("status", "pending")
        .order("position")
        .limit(1)
        .execute()
    )
    
    if not pending.data:
        return
    
    item = pending.data[0]
    repo_id = item["jobs"]["github_repo_id"]
    
    # Mark as processing
    db.table("merge_queue").update({
        "status": "processing",
        "started_at": datetime.utcnow().isoformat(),
    }).eq("id", item["id"]).execute()
    
    # Attempt merge via GitHub API
    result = await github_api_merge(repo_id, item["branch_name"])
    
    if result["success"]:
        db.table("merge_queue").update({
            "status": "merged",
            "conflict_tier": 0 if result["fast_forward"] else 1,
            "completed_at": datetime.utcnow().isoformat(),
        }).eq("id", item["id"]).execute()
        
        await manager.broadcast(item["job_id"], {
            "type": "merge_completed",
            "branch": item["branch_name"],
        })
    else:
        db.table("merge_queue").update({
            "status": "conflict",
            "conflict_tier": 3,
            "conflict_diff": result.get("message", ""),
            "completed_at": datetime.utcnow().isoformat(),
        }).eq("id", item["id"]).execute()
        
        await manager.broadcast(item["job_id"], {
            "type": "merge_conflict",
            "branch": item["branch_name"],
            "message": result.get("message"),
        })
```

### GitHub API Merge Helper

```python
async def github_api_merge(repo_full_name, branch_name):
    """Merge a branch into main using the GitHub API."""
    token = get_settings().github_token
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
    }
    
    url = f"https://api.github.com/repos/{repo_full_name}/merges"
    payload = {
        "base": "main",
        "head": branch_name,
        "commit_message": f"Auto-merge: {branch_name}",
    }
    
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=payload, headers=headers)
    
    if resp.status_code == 201:
        return {"success": True, "fast_forward": False, "sha": resp.json().get("sha")}
    elif resp.status_code == 204:
        return {"success": True, "fast_forward": True}
    elif resp.status_code == 409:
        return {"success": False, "message": "Merge conflict — needs manual resolution"}
    else:
        return {"success": False, "message": f"GitHub API error {resp.status_code}: {resp.text}"}
```

---

## Integration Points

1. **`main.py` lifespan**: Start `merge_processor_loop()` alongside `watchdog_loop()`
2. **`mcp.js` complete_task**: Already enqueues merge — no changes needed
3. **WebSocket broadcast**: Already wired — UI will show merge status in real-time
4. **Fallback**: `merge-agent.js` CLI still works as a manual fallback for repos where the API server doesn't have a GitHub token

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/api/lib/merge_processor.py` | **NEW** | Server-side auto-merge via GitHub API |
| `apps/api/main.py` | **MODIFY** | Add merge_processor_loop to lifespan |
