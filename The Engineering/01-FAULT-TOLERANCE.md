# 01 — Fault Tolerance & Agent Lifecycle

> **The #1 question**: "What happens when someone leaves?"
>
> In v1, the answer is: the task stays locked forever, other agents wait indefinitely, and the job stalls. In v2, the system detects disconnection within 2 minutes, automatically recovers stuck tasks, and continues the job without human intervention.

---

## Table of Contents

1. [Problem Analysis](#problem-analysis)
2. [Heartbeat System](#heartbeat-system)
3. [Watchdog Service](#watchdog-service)
4. [Task Recovery & Reassignment](#task-recovery--reassignment)
5. [Graceful Shutdown Protocol](#graceful-shutdown-protocol)
6. [Contributor Lifecycle State Machine](#contributor-lifecycle-state-machine)
7. [Edge Cases & Failure Modes](#edge-cases--failure-modes)
8. [Implementation Details](#implementation-details)
9. [Testing Strategy](#testing-strategy)

---

## Problem Analysis

### What Goes Wrong in v1

| Failure Mode | v1 Behavior | User Impact |
|-------------|-------------|-------------|
| Agent process crashes (OOM, bug) | CLI exits, no cleanup | Task stuck as `locked` forever |
| User closes terminal window | No signal handler catches it | Same as crash |
| Network drops (WiFi, VPN) | HTTP calls fail silently | Agent appears dead but task is locked |
| API server restarts (Render cold start) | In-memory WS connections lost | Browser loses live updates |
| Agent runs out of API credits | Claude errors out | Task half-finished, marked as locked |
| User intentionally walks away | No detection mechanism | Job stalls, other agents wait |

### Why This Matters for Global Internet Agents

When agents are running on **different machines across the internet**, disconnection is not an edge case — it's the **normal operating condition**. Network partitions, laptop sleep, power outages, and intentional departures will happen on every multi-hour job. The system must handle these gracefully.

### What We Learned From Reference Projects

- **Overstory**: Uses a 3-tier watchdog system — Tier 0 mechanical daemon (checks tmux/pid liveness every 30s), Tier 1 AI-assisted triage (classifies failure type), Tier 2 monitor agent (continuous fleet patrol). This is overengineered for SwarmBuild's centralized architecture but the mechanical daemon concept is essential.
- **OpenAgents**: Uses heartbeat + receipts. Every action is receipted. If a worker goes silent, the receipt trail shows exactly where it stopped.

---

## Heartbeat System

### Design Overview

Every active agent CLI sends a lightweight heartbeat to the API server every 30 seconds. The server records the timestamp and uses it for liveness detection.

```
Agent CLI                                     API Server
  │                                              │
  │──── POST /api/worker/heartbeat/{token} ────►│
  │     Body: {                                  │
  │       agents_running: 1,                     │
  │       tokens_used: 45000,                    │
  │       current_task_id: "uuid-...",           │
  │       status: "working"                      │
  │     }                                        │
  │                                              │
  │◄──── 200 OK ─────────────────────────────────│
  │      {                                       │
  │        status: "ok",                         │
  │        server_time: "2026-03-13T...",         │
  │        should_stop: false                    │
  │      }                                       │
  │                                              │
  │  ... 30 seconds later ...                    │
  │                                              │
  │──── POST /api/worker/heartbeat/{token} ────►│
  │     ...                                      │
```

### Heartbeat Request Schema

```typescript
interface HeartbeatRequest {
    // Number of Claude instances this CLI is managing
    agents_running: number;
    
    // Cumulative token count from all sessions
    tokens_used: number;
    
    // The task currently being worked on (null if idle)
    current_task_id: string | null;
    
    // What the agent is doing right now
    status: "idle" | "working" | "merging" | "waiting";
    
    // Sessions completed since last heartbeat
    sessions_run: number;
    
    // Git commits pushed since last heartbeat
    commits_pushed: number;
}
```

### Heartbeat Response Schema

```typescript
interface HeartbeatResponse {
    status: "ok";
    
    // Server's current time (for clock sync detection)
    server_time: string;
    
    // Server can tell agent to stop (e.g., budget exhausted, job cancelled)
    should_stop: boolean;
    
    // Reason for stop directive
    stop_reason?: "budget_exhausted" | "job_cancelled" | "job_completed" | "token_expired";
    
    // Any pending messages from the server
    pending_notifications: ServerNotification[];
}
```

### CLI Implementation

```javascript
// packages/cli/src/orchestrator.js — inside runLobby()

// Start heartbeat loop immediately after registration
let heartbeatInterval = null;
let currentTaskId = null;

function startHeartbeat(api) {
    heartbeatInterval = setInterval(async () => {
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
        } catch (err) {
            // Network error — log but don't crash
            // The watchdog on the server side will handle the missed heartbeat
            console.log(`[swarmbuild] ⚠️ Heartbeat failed: ${err.message}`);
        }
    }, 30_000); // Every 30 seconds
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}
```

### Server Implementation

```python
# apps/api/routers/worker.py — Enhanced heartbeat endpoint

class HeartbeatRequestV2(BaseModel):
    agents_running: int = 1
    tokens_used: int = 0
    current_task_id: Optional[str] = None
    status: str = "idle"  # idle, working, merging, waiting
    sessions_run: int = 0
    commits_pushed: int = 0


@router.post("/heartbeat/{token}")
async def worker_heartbeat(token: str, req: HeartbeatRequestV2):
    """Worker reports it's still alive (every 30s)."""
    contributor = _verify_token(token)
    db = get_supabase()

    now = datetime.utcnow().isoformat()

    # Update contributor record
    db.table("contributors").update({
        "last_seen": now,
        "num_agents": req.agents_running,
        "tokens_used": req.tokens_used,
        "sessions_run": req.sessions_run,
        "commits_pushed": req.commits_pushed,
        "current_task_id": req.current_task_id,
        "contributor_status": "active",
    }).eq("id", contributor["id"]).execute()

    # Check if server wants the agent to stop
    job = contributor.get("jobs", {})
    should_stop = False
    stop_reason = None

    # Budget exhaustion check
    job_budget = job.get("budget_cap")
    if job_budget and req.tokens_used >= job_budget:
        should_stop = True
        stop_reason = "budget_exhausted"

    # Job cancellation check
    if job.get("status") in ("cancelled", "complete", "failed"):
        should_stop = True
        stop_reason = f"job_{job.get('status')}"

    # Token expiry check
    expires = datetime.fromisoformat(contributor["token_expires"].replace("Z", "+00:00"))
    if datetime.now(timezone.utc) > expires - timedelta(minutes=5):
        should_stop = True
        stop_reason = "token_expired"

    return {
        "status": "ok",
        "server_time": now,
        "should_stop": should_stop,
        "stop_reason": stop_reason,
        "pending_notifications": [],
    }
```

---

## Watchdog Service

### Design Overview

The watchdog is a server-side background task that runs every 60 seconds, scanning for contributors who have missed heartbeats. It operates on a **state machine** with escalating actions.

```
Heartbeat received           Heartbeat received
within 2 min                 within 2 min
    ┌──────┐                     ┌──────┐
    │      ▼                     │      ▼
┌───┴──────────┐  miss 2 min  ┌──┴───────────┐  miss 5 min  ┌──────────────┐
│    ACTIVE    │─────────────►│    STALE     │─────────────►│ DISCONNECTED │
│  (healthy)   │              │  (warning)    │              │  (cleanup)   │
└──────────────┘              └───────────────┘              └──────┬───────┘
                                                                    │
                                                               Auto-release
                                                               locked tasks
                                                                    │
                                                                    ▼
                                                             ┌──────────────┐
                                                             │   LEFT       │
                                                             │  (terminal)  │
                                                             └──────────────┘
```

### State Transitions

| Current State | Condition | Next State | Action |
|---------------|-----------|------------|--------|
| `active` | `last_seen` < 2 min ago | `active` | No action |
| `active` | `last_seen` 2–5 min ago | `stale` | Broadcast warning to lobby |
| `stale` | Heartbeat received | `active` | Clear warning |
| `stale` | `last_seen` > 5 min ago | `disconnected` | Release tasks, broadcast |
| `disconnected` | Heartbeat received | `active` | Re-register, re-sync |
| `disconnected` | `last_seen` > 15 min ago | `left` | Full cleanup |

### Server Implementation

```python
# apps/api/lib/watchdog.py

import asyncio
from datetime import datetime, timedelta, timezone
from database import get_supabase
from lib.websocket import manager


STALE_THRESHOLD = timedelta(minutes=2)
DISCONNECTED_THRESHOLD = timedelta(minutes=5)
LEFT_THRESHOLD = timedelta(minutes=15)


async def watchdog_tick():
    """Run one watchdog cycle. Called every 60 seconds."""
    db = get_supabase()
    now = datetime.now(timezone.utc)

    # Fetch all active/stale contributors across all running jobs
    active_contribs = (
        db.table("contributors")
        .select("id, job_id, worker_token, last_seen, contributor_status, role")
        .in_("contributor_status", ["active", "stale"])
        .is_("left_at", "null")
        .execute()
    )

    for contrib in active_contribs.data:
        last_seen_str = contrib.get("last_seen")
        if not last_seen_str:
            continue

        last_seen = datetime.fromisoformat(last_seen_str.replace("Z", "+00:00"))
        elapsed = now - last_seen
        current_status = contrib["contributor_status"]
        job_id = contrib["job_id"]
        contrib_id = contrib["id"]
        token = contrib["worker_token"]

        # ── Transition: active → stale ──
        if current_status == "active" and elapsed > STALE_THRESHOLD:
            db.table("contributors").update({
                "contributor_status": "stale"
            }).eq("id", contrib_id).execute()

            await manager.broadcast(job_id, {
                "type": "contributor_status_change",
                "contributor_id": contrib_id,
                "role": contrib["role"],
                "status": "stale",
                "message": f"Agent ({contrib['role']}) hasn't responded in {int(elapsed.total_seconds())}s"
            })
            print(f"[watchdog] Contributor {contrib_id} marked STALE (silent for {int(elapsed.total_seconds())}s)")

        # ── Transition: stale → disconnected ──
        elif current_status == "stale" and elapsed > DISCONNECTED_THRESHOLD:
            # Release all tasks locked by this contributor
            locked_tasks = (
                db.table("tasks")
                .select("id, title")
                .eq("locked_by_token", token)
                .eq("status", "locked")
                .execute()
            )

            for task in locked_tasks.data:
                # Record the failed attempt
                db.table("task_attempts").insert({
                    "task_id": task["id"],
                    "worker_token": token,
                    "outcome": "agent_disconnected",
                    "log_summary": f"Agent disconnected after {int(elapsed.total_seconds())}s of silence",
                }).execute()

                # Release the task back to available
                db.table("tasks").update({
                    "status": "available",
                    "locked_by_token": None,
                    "updated_at": datetime.utcnow().isoformat(),
                }).eq("id", task["id"]).execute()

                print(f"[watchdog] Released task '{task['title']}' (id={task['id']}) — agent disconnected")

            # Mark contributor as disconnected
            db.table("contributors").update({
                "contributor_status": "disconnected"
            }).eq("id", contrib_id).execute()

            await manager.broadcast(job_id, {
                "type": "contributor_disconnected",
                "contributor_id": contrib_id,
                "role": contrib["role"],
                "released_tasks": [t["id"] for t in locked_tasks.data],
                "message": f"Agent ({contrib['role']}) disconnected. {len(locked_tasks.data)} task(s) released."
            })

        # ── Transition: disconnected → left ──
        elif current_status == "disconnected" and elapsed > LEFT_THRESHOLD:
            db.table("contributors").update({
                "contributor_status": "left",
                "left_at": datetime.utcnow().isoformat(),
            }).eq("id", contrib_id).execute()

            await manager.broadcast(job_id, {
                "type": "contributor_left",
                "contributor_id": contrib_id,
                "role": contrib["role"],
            })


async def watchdog_loop():
    """Infinite loop that runs watchdog_tick every 60 seconds."""
    while True:
        try:
            await watchdog_tick()
        except Exception as e:
            print(f"[watchdog] Error in watchdog tick: {e}")
        await asyncio.sleep(60)
```

### Integration with FastAPI Lifespan

```python
# apps/api/main.py — Add to lifespan

import asyncio
from lib.watchdog import watchdog_loop

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[api] Swarmbuild API starting...")
    
    # Start watchdog background task
    watchdog_task = asyncio.create_task(watchdog_loop())
    print("[api] Watchdog started (checking every 60s)")
    
    yield
    
    # Cancel watchdog on shutdown
    watchdog_task.cancel()
    print("[api] Swarmbuild API shutting down...")
```

---

## Task Recovery & Reassignment

### Problem: Half-Finished Work

When an agent disconnects mid-task, the code might be half-written. The task gets released, but the next agent that claims it needs context about what was already attempted.

### Design: Task Attempts Table

Every claim creates an attempt record. When the attempt ends (by completion, failure, or disconnection), the outcome is recorded.

```sql
CREATE TABLE task_attempts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    worker_token    TEXT NOT NULL,
    
    -- Timing
    started_at      TIMESTAMPTZ DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    
    -- Outcome
    outcome         TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (outcome IN (
                        'in_progress',
                        'completed',
                        'failed',
                        'agent_disconnected',
                        'agent_crashed',
                        'budget_exhausted',
                        'manually_released'
                    )),
    
    -- What the agent did (git diff summary, log excerpt)
    log_summary     TEXT,
    
    -- Git state at end of attempt
    branch_name     TEXT,
    commit_sha      TEXT,
    files_changed   INT DEFAULT 0,
    
    -- Token usage for this specific attempt
    tokens_used     INT DEFAULT 0
);

CREATE INDEX idx_task_attempts_task ON task_attempts(task_id);
CREATE INDEX idx_task_attempts_token ON task_attempts(worker_token);
```

### How It Works

```
Agent A claims Task X
    │
    ├── task_attempts row created: outcome = "in_progress"
    │
    ├── Agent A writes code...
    │
    ├── Agent A disconnects! ⚡
    │
    ├── Watchdog detects silence (5 min)
    │   ├── task_attempts row updated: outcome = "agent_disconnected"
    │   └── tasks row updated: status = "available", locked_by_token = null
    │
    ├── Agent B claims Task X
    │   ├── New task_attempts row created
    │   ├── Server response includes:
    │   │   {
    │   │     "previous_attempts": [
    │   │       {
    │   │         "outcome": "agent_disconnected",
    │   │         "log_summary": "Agent wrote 3 files before disconnecting",
    │   │         "branch_name": "task-uuid-attempt-1",
    │   │         "commit_sha": "abc123",
    │   │         "files_changed": 3
    │   │       }
    │   │     ],
    │   │     "warning": "⚠️ This task was previously attempted. Check git history."
    │   │   }
    │   │
    │   └── Agent B can: git log, see what A did, continue from there
    │
    └── Agent B completes Task X ✅
```

### MCP Tool Enhancement

```javascript
// packages/cli/src/mcp.js — Enhanced claim_task response

if (request.params.name === "swarmbuild_claim_task") {
    const res = await api.claimTask(request.params.arguments.task_id);

    // Fetch previous attempts for context
    const attempts = await api.getTaskAttempts(request.params.arguments.task_id);

    // Git sync (pull latest)
    let gitStatus = "No git remote detected.";
    try {
        try { await runGitCommand("git stash --include-untracked", workspacePath); } catch {}
        await runGitCommand("git pull --rebase origin main", workspacePath);
        try { await runGitCommand("git stash pop", workspacePath); } catch {}
        gitStatus = "Successfully pulled latest code.";
    } catch (err) {
        gitStatus = `Git pull failed: ${err.message}`;
    }

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                ...res,
                git_sync: gitStatus,
                previous_attempts: attempts,
                warning: attempts.length > 0
                    ? `⚠️ This task was attempted ${attempts.length} time(s) before. Check git history for partial work.`
                    : null,
            }, null, 2)
        }]
    };
}
```

---

## Graceful Shutdown Protocol

### Design

When the CLI receives a termination signal, it performs cleanup before exiting.

```javascript
// packages/cli/src/orchestrator.js — Signal handling

async function gracefulShutdown(api, reason = "user_interrupted") {
    console.log(`\n[swarmbuild] 🛑 Initiating graceful shutdown (reason: ${reason})...`);

    // 1. Stop the heartbeat
    stopHeartbeat();

    // 2. Release all tasks locked by this worker
    try {
        const released = await api.releaseAllMyTasks();
        console.log(`[swarmbuild] Released ${released.count} locked task(s)`);
    } catch (err) {
        console.log(`[swarmbuild] ⚠️ Failed to release tasks: ${err.message}`);
    }

    // 3. Commit and push any uncommitted work
    try {
        await runGitCommand("git add .", WORKSPACE);
        try {
            await runGitCommand(
                `git commit -m "WIP: Agent shutdown (${reason}) — partial work"`,
                WORKSPACE
            );
            // Push to a WIP branch so work isn't lost
            await runGitCommand(
                `git push origin HEAD:wip/${api.workerToken.slice(-8)}`,
                WORKSPACE
            );
            console.log("[swarmbuild] ✅ Pushed partial work to WIP branch");
        } catch {
            // Nothing to commit
        }
    } catch (err) {
        console.log(`[swarmbuild] ⚠️ Failed to save partial work: ${err.message}`);
    }

    // 4. Notify server
    try {
        await api.workerComplete("stopped", `Graceful shutdown: ${reason}`);
    } catch {
        // Server might be unreachable
    }

    console.log("[swarmbuild] Goodbye! 👋");
}

// Register signal handlers at startup
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
```

### New API Endpoint

```python
# apps/api/routers/tasks.py — New endpoint

@router.post("/{token}/tasks/release-all")
async def release_all_tasks(token: str):
    """Release all tasks locked by this worker (graceful shutdown)."""
    contributor = _verify_token(token)
    db = get_supabase()

    result = (
        db.table("tasks")
        .update({
            "status": "available",
            "locked_by_token": None,
            "updated_at": datetime.utcnow().isoformat()
        })
        .eq("locked_by_token", token)
        .eq("status", "locked")
        .execute()
    )

    released_count = len(result.data) if result.data else 0

    # Record attempts for each released task
    for task in (result.data or []):
        db.table("task_attempts").insert({
            "task_id": task["id"],
            "worker_token": token,
            "outcome": "manually_released",
            "log_summary": "Agent performed graceful shutdown",
        }).execute()

    if released_count > 0:
        await manager.broadcast(contributor["job_id"], {"type": "task_updated"})

    return {"status": "ok", "count": released_count}
```

---

## Contributor Lifecycle State Machine

### Complete State Diagram

```
                              register()
                                 │
                                 ▼
                          ┌──────────────┐
                          │  REGISTERED  │
                          │  (in lobby)  │
                          └──────┬───────┘
                                 │ set_ready(true)
                                 ▼
                          ┌──────────────┐
                          │    READY     │
                          │  (waiting)   │
                          └──────┬───────┘
                                 │ all_ready → job=executing
                                 ▼
     Heartbeat ◄──────── ┌──────────────┐ ────────── Miss 2 heartbeats
     received            │   ACTIVE     │               │
        │                │  (working)   │               │
        └───────────────►└──────────────┘               ▼
                                │               ┌──────────────┐
                                │               │    STALE     │ ◄── Heartbeat
                                │               │  (warning)   │     received
                                │               └──────┬───────┘     │
                                │                      │             │
                                │               Miss 5 min ──────────┘
                                │                      │
                                │                      ▼
                                │               ┌──────────────┐
                                │               │ DISCONNECTED │
                                │               │  (tasks      │
                                │               │   released)  │
                                │               └──────┬───────┘
                                │                      │
                    graceful    │               Miss 15 min
                    shutdown    │                      │
                                │                      ▼
                                └──────────────►┌──────────────┐
                                                │    LEFT      │
                                                │  (terminal)  │
                                                └──────────────┘
```

---

## Edge Cases & Failure Modes

### Edge Case 1: Only One Agent on the Job

If the solo lead agent disconnects, the entire job stalls. The watchdog releases their tasks, but nobody is there to pick them up.

**Mitigation**: When the last active contributor disconnects:
1. Job status changes to `stalled`
2. UI shows "This job needs contributors — all agents have left"
3. Email notification to poster (if configured)
4. Job remains open for new contributors to join

### Edge Case 2: Agent Reconnects After Being Marked Disconnected

An agent's CLI might recover from a network partition after 10 minutes.

**Mitigation**: The heartbeat endpoint checks `contributor_status`. If `disconnected`, it transitions back to `active` and the response includes a list of tasks that were released. The agent can re-claim them.

### Edge Case 3: Two Agents Claim the Same Task Simultaneously

Race condition: both send `POST /tasks/{id}/claim` at the same time.

**Mitigation**: Already solved in v1 with `WHERE status = 'available'` — only one update succeeds. The loser gets a 409 Conflict. No change needed.

### Edge Case 4: Watchdog Runs While Agent is Legitimately Working

An agent might be in a long compilation or test run, not sending heartbeats because the code is blocking.

**Mitigation**: The heartbeat runs on a separate `setInterval` from the agent spawn. As long as the CLI process is alive, heartbeats continue regardless of what Claude is doing. The 30s interval and 2-minute stale threshold provide generous tolerance.

### Edge Case 5: API Server Restarts (Render)

Render free tier containers sleep after inactivity. When the container restarts, the watchdog loop restarts too. Contributors with stale `last_seen` from before the restart might get falsely marked as disconnected.

**Mitigation**: On startup, the watchdog should skip its first tick and use the start time as the baseline. Only contributors whose `last_seen` is older than the server's startup time + threshold should be flagged.

```python
# In watchdog_loop():
startup_time = datetime.now(timezone.utc)
await asyncio.sleep(120)  # Wait 2 minutes before first watchdog cycle
# This ensures agents have time to send heartbeats after server restart
```

---

## Implementation Details

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/api/lib/watchdog.py` | **NEW** | Watchdog service with state machine logic |
| `apps/api/main.py` | **MODIFY** | Add watchdog to lifespan |
| `apps/api/routers/worker.py` | **MODIFY** | Enhanced heartbeat with v2 request/response |
| `apps/api/routers/tasks.py` | **MODIFY** | Add `release-all` endpoint, add attempt tracking on claim |
| `apps/api/init.sql` | **MODIFY** | Add `task_attempts` table, `contributor_status` column |
| `packages/cli/src/orchestrator.js` | **MODIFY** | Heartbeat loop, signal handlers, graceful shutdown |
| `packages/cli/src/api.js` | **MODIFY** | New `heartbeat()`, `releaseAllMyTasks()`, `getTaskAttempts()` methods |
| `packages/cli/src/mcp.js` | **MODIFY** | Include previous attempts in claim response |

### Migration SQL

```sql
-- Add contributor_status to contributors table
ALTER TABLE contributors 
    ADD COLUMN IF NOT EXISTS contributor_status TEXT DEFAULT 'active'
    CHECK (contributor_status IN ('registered', 'ready', 'active', 'stale', 'disconnected', 'left'));

-- Add current_task_id to contributors table  
ALTER TABLE contributors 
    ADD COLUMN IF NOT EXISTS current_task_id UUID REFERENCES tasks(id);

-- Create task_attempts table
CREATE TABLE IF NOT EXISTS task_attempts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    worker_token    TEXT NOT NULL,
    started_at      TIMESTAMPTZ DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    outcome         TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (outcome IN (
                        'in_progress', 'completed', 'failed',
                        'agent_disconnected', 'agent_crashed',
                        'budget_exhausted', 'manually_released'
                    )),
    log_summary     TEXT,
    branch_name     TEXT,
    commit_sha      TEXT,
    files_changed   INT DEFAULT 0,
    tokens_used     INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_task_attempts_token ON task_attempts(worker_token);
```

---

## Testing Strategy

### Unit Tests
- Watchdog state transitions (active → stale → disconnected → left)
- Heartbeat processing with various contributor states
- Task release logic (only releases `locked` tasks, not `completed`)

### Integration Tests
- Simulate agent disconnect (stop sending heartbeats, verify task release after 5 min)
- Simulate graceful shutdown (send SIGINT, verify tasks released + WIP branch pushed)
- Simulate agent reconnection (resume heartbeats after being marked disconnected)

### Load Tests
- 50 concurrent agents sending heartbeats every 30s
- Watchdog processing 50 contributors per tick within the 60s window
