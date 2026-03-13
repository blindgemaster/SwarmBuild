# 03 — Hot-Join & Dynamic Teams

> **Problem**: Once a job transitions to `executing` state, no new contributors can join. If someone sees a running job and wants to help, they're locked out. The system should allow hot-joining — contributors can arrive at any time during execution and pick up available tasks.

---

## Root Cause Analysis

The v1 lobby flow is sequential and gate-based:

```
gathering → planning → ready_wait → executing
                                      ↑
                                      Once here, registration is closed
```

The `contribute` endpoint in `contributors.py` checks `lobby_state` and rejects late-comers. The `ready` endpoint requires all contributors to mark ready before transitioning to `executing`. This was designed for a "everyone starts together" model that doesn't work when:

- A job takes 30+ minutes and someone discovers it mid-run
- The poster wants to add more agents to speed things up
- An agent disconnects and a replacement needs to join

### What Overstory Does

Overstory has no lobby concept at all. The coordinator spawns agents on demand via `ov sling <task-id>`. Agents arrive, do work, leave. There's no "gathering" phase.

### What Beads Does

Beads uses `bd ready` to surface tasks whose dependencies are met. Any agent can claim any ready task at any time. There's no registration gate.

---

## Design: Hot-Join Flow

### 1. Allow Registration During Execution

```python
# apps/api/routers/contributors.py — Remove lobby_state gate

# BEFORE (v1):
if job["lobby_state"] not in ("gathering",):
    raise HTTPException(400, "Job is not accepting contributors")

# AFTER (v2.1):
if job["status"] in ("complete", "failed", "cancelled"):
    raise HTTPException(400, "Job is finished — cannot join")
# Allow joining during: pending, plan_ready, approved, running
```

### 2. Skip Ready-Wait for Hot-Joiners

When a contributor joins a job that's already `executing`, they should skip the ready-wait:

```python
# If job is already executing, auto-mark the new contributor as ready and active
if job["lobby_state"] == "executing":
    contributor_data["is_ready"] = True
    contributor_data["contributor_status"] = "active"
```

### 3. New API Endpoint: Job Status for Joiners

```python
@router.get("/api/jobs/{job_id}/join-info")
async def get_join_info(job_id: str):
    """Info for someone considering joining this job."""
    db = get_supabase()
    job = db.table("jobs").select("*").eq("id", job_id).execute()
    contributors = db.table("contributors").select("role, contributor_status").eq("job_id", job_id).execute()
    tasks = db.table("tasks").select("status, assigned_role").eq("job_id", job_id).execute()
    
    available_tasks = [t for t in tasks.data if t["status"] == "available"]
    active_agents = [c for c in contributors.data if c["contributor_status"] == "active"]
    filled_roles = [c["role"] for c in active_agents]
    
    # Suggest roles that have unclaimed tasks
    needed_roles = set()
    for t in available_tasks:
        if t.get("assigned_role") and t["assigned_role"] not in filled_roles:
            needed_roles.add(t["assigned_role"])
    
    return {
        "job_id": job_id,
        "status": job.data[0]["status"],
        "can_join": job.data[0]["status"] not in ("complete", "failed", "cancelled"),
        "active_agents": len(active_agents),
        "available_tasks": len(available_tasks),
        "total_tasks": len(tasks.data),
        "needed_roles": list(needed_roles),
        "filled_roles": filled_roles,
    }
```

### 4. CLI Handles Hot-Join

```javascript
// orchestrator.js — Modified runLobby
// If job is already executing, skip the lobby wait entirely
const jobStatus = await api.client.get(`/api/jobs/${jobId}`);
if (jobStatus.data.lobby_state === 'executing') {
    console.log("[swarmbuild] 🔥 Hot-joining a running job — skipping lobby...");
    // Jump straight to execution loop
} else {
    // Normal lobby flow (planning → ready → wait)
}
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/api/routers/contributors.py` | **MODIFY** | Remove lobby_state gate, allow joining during execution |
| `apps/api/routers/jobs.py` | **MODIFY** | Add `GET /api/jobs/{job_id}/join-info` endpoint |
| `packages/cli/src/orchestrator.js` | **MODIFY** | Detect running job and skip lobby wait |
