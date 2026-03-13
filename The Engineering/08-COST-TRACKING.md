# 08 — Cost & Token Tracking

> **Problem**: v1 has no cost tracking. Agents can burn unlimited API tokens. There's a `token_cap` column in the database but it's never enforced. This is one of Overstory's top STEELMAN risks: *"Cost amplification without proportional value."*
>
> A 20-agent swarm completing 15 tasks consumed **8M tokens (~$60)**. A single agent doing the same work used **1.2M tokens (~$9)**. Budget enforcement is a safety-critical feature.

---

## Table of Contents

1. [Problem Analysis](#problem-analysis)
2. [Token Metering Design](#token-metering-design)
3. [Budget Enforcement](#budget-enforcement)
4. [Cost Dashboard](#cost-dashboard)
5. [Credit System Integration](#credit-system-integration)
6. [Implementation Details](#implementation-details)

---

## Problem Analysis

### The Cost Equation

```
Total Cost = Σ (Agents × Sessions × Avg Tokens per Session × Price per Token)

Example: 5-agent job
  5 agents × 3 sessions each × 200K tokens/session × $3/M tokens (Claude)
  = 3M tokens × $3/M
  = $9 per job

But with coordination overhead:
  + 5 agents × 50 mail-check calls × 5K tokens each
  + 3 failed tasks retried (wasted tokens)
  + AI merge resolution (100K tokens × 2 conflicts)
  = Additional ~2M tokens = +$6
  
  Total: ~$15 per job
```

### What Goes Wrong Without Tracking

| Scenario | Impact |
|----------|--------|
| Agent stuck in loop | Burns tokens infinitely polling/retrying |
| Long-running session | Claude sessions can hit 500K+ tokens |
| Too many agents | N agents = N× coordination overhead |
| Retry storms | Failed tasks retried without budget check |
| No visibility | Poster has no idea how much the job is costing |

---

## Token Metering Design

### Data Sources

Different runtimes expose token usage differently:

| Runtime | Token Data Source | Extraction Method |
|---------|-------------------|-------------------|
| Claude Code | `--print` output footer | Regex: `Total.*?(\d+)\s*tokens` |
| Gemini CLI | JSONL transcript files | Parse `usage` field |
| Codex CLI | Output summary | Regex: `tokens?[\s:]+(\d+)` |
| A2A Agent | A2A response metadata | `usage` in response body |

### Token Flow

```
Agent Session
    │
    ├── Claude runs, produces output with token count
    │
    ▼
CLI parses output
    │
    ├── Extracts: input_tokens, output_tokens, total_tokens
    │
    ├── Stores locally: cumulative_tokens += total_tokens
    │
    ▼
Heartbeat (every 30s)
    │
    ├── POST /api/worker/heartbeat/{token}
    │   Body: { tokens_used: 145000 }  (cumulative)
    │
    ▼
Server records
    │
    ├── contributors.tokens_used = 145000
    │
    ├── Computes: job_total = SUM(contributors.tokens_used) for this job
    │
    ├── Checks: job_total < job.budget_cap?
    │   │
    │   ├── YES: { should_stop: false }
    │   └── NO:  { should_stop: true, stop_reason: "budget_exhausted" }
    │
    ▼
Agent receives stop signal → graceful shutdown
```

### Per-Task Token Tracking

When a task is completed, the token usage for that specific task is recorded:

```javascript
// packages/cli/src/mcp.js — Token tracking per task

let taskStartTokens = 0;

if (request.params.name === "swarmbuild_claim_task") {
    // Record token count at task start
    taskStartTokens = getTotalTokensUsed();
    // ... normal claim logic
}

if (request.params.name === "swarmbuild_complete_task") {
    const taskTokens = getTotalTokensUsed() - taskStartTokens;
    
    // Include token usage in completion report
    const res = await api.completeTask(taskId, status, {
        tokens_used: taskTokens,
    });
    // ... normal complete logic
}
```

---

## Budget Enforcement

### Job-Level Budget

```sql
-- Per job budget cap (in tokens)
ALTER TABLE jobs ADD COLUMN budget_cap INT;           -- Max total tokens for the entire job
ALTER TABLE jobs ADD COLUMN budget_warning_pct INT DEFAULT 80;  -- Warn at this % used
ALTER TABLE jobs ADD COLUMN budget_used INT DEFAULT 0;          -- Running total
```

### Enforcement Points

Budget is checked at **three critical points**:

#### Point 1: Task Claim

```python
@router.post("/{token}/tasks/{task_id}/claim")
async def claim_task(token: str, task_id: str):
    contributor = _verify_token(token)
    job = get_job(contributor["job_id"])
    
    # Budget check
    if job.get("budget_cap"):
        if job.get("budget_used", 0) >= job["budget_cap"]:
            raise HTTPException(402, {
                "error": "budget_exhausted",
                "message": "Job budget exhausted. No more tasks can be claimed.",
                "budget_cap": job["budget_cap"],
                "budget_used": job["budget_used"],
            })
    
    # ... normal claim logic
```

#### Point 2: Heartbeat Response

```python
# In heartbeat handler
if job.get("budget_cap") and req.tokens_used:
    # Update running total
    db.table("jobs").update({
        "budget_used": compute_total_tokens(job_id)
    }).eq("id", job_id).execute()
    
    total_used = compute_total_tokens(job_id)
    cap = job["budget_cap"]
    
    if total_used >= cap:
        should_stop = True
        stop_reason = "budget_exhausted"
    elif total_used >= cap * (job.get("budget_warning_pct", 80) / 100):
        # Warn but don't stop
        pending_notifications.append({
            "type": "budget_warning",
            "message": f"Budget is {int(total_used/cap*100)}% used ({total_used:,}/{cap:,} tokens)"
        })
```

#### Point 3: Agent Session Start

```javascript
// packages/cli/src/orchestrator.js — Before spawning agent

const jobInfo = await api.getJobInfo();
if (jobInfo.budget_exhausted) {
    console.log("[swarmbuild] ⛔ Job budget exhausted. Stopping.");
    await gracefulShutdown(api, "budget_exhausted");
    return;
}
```

### Warning & Escalation

```
Budget Usage Timeline:
  0% ───────── 50% ───── 80% ─── 90% ─── 100%
  │             │         │       │        │
  │             │         │       │        └── ⛔ HARD STOP
  │             │         │       │             All agents told to stop
  │             │         │       │             No new task claims
  │             │         │       │
  │             │         │       └── ⚠️ URGENT WARNING
  │             │         │            Lobby notification
  │             │         │            Poster email alert
  │             │         │
  │             │         └── ⚠️ WARNING
  │             │             Lobby notification + heartbeat warning
  │             │
  │             └── 📊 Info
  │                 Dashboard update only
  │
  └── Normal operation
```

---

## Cost Dashboard

### Per-Agent Breakdown

```
┌─────────────────────────────────────────────────────────┐
│  Job: Build a REST API for Todo App                    │
│  Budget: 500,000 tokens (used: 324,000 = 65%)         │
│  ████████████████████████████░░░░░░░░░░░                │
│                                                         │
│  ┌──────────────┬──────────┬─────────┬───────────────┐ │
│  │ Agent        │ Tokens   │ Tasks   │ $/estimate    │ │
│  ├──────────────┼──────────┼─────────┼───────────────┤ │
│  │ Lead (you)   │ 145,000  │ 3 done  │ $0.44         │ │
│  │ Backend      │ 112,000  │ 2 done  │ $0.34         │ │
│  │ Frontend     │  67,000  │ 1 done  │ $0.20         │ │
│  └──────────────┴──────────┴─────────┴───────────────┘ │
│                                                         │
│  Per-Task Breakdown:                                   │
│  ├── Setup DB Schema:     23,000 tokens ($0.07) ✅     │
│  ├── Build Auth API:      89,000 tokens ($0.27) ✅     │
│  ├── Build User API:      45,000 tokens ($0.14) 🔄     │
│  └── Frontend Login:      67,000 tokens ($0.20) 🔄     │
└─────────────────────────────────────────────────────────┘
```

### API Endpoint

```python
@router.get("/api/jobs/{job_id}/costs")
async def get_cost_breakdown(job_id: str):
    """Get token usage and cost breakdown for a job."""
    db = get_supabase()
    
    # Per-contributor breakdown
    contribs = (
        db.table("contributors")
        .select("id, role, tokens_used, sessions_run, tasks_completed")
        .eq("job_id", job_id)
        .execute()
    )
    
    # Per-task breakdown
    attempts = (
        db.table("task_attempts")
        .select("task_id, tokens_used, outcome")
        .eq("job_id", job_id)
        .execute()
    )
    
    job = db.table("jobs").select("budget_cap, budget_used").eq("id", job_id).single().execute()
    
    total = sum(c.get("tokens_used", 0) for c in contribs.data)
    
    return {
        "job_id": job_id,
        "budget_cap": job.data.get("budget_cap"),
        "budget_used": total,
        "budget_pct": int(total / job.data["budget_cap"] * 100) if job.data.get("budget_cap") else None,
        "estimated_cost_usd": total * 0.000003,  # $3/M tokens (Claude Sonnet)
        "contributors": [
            {
                "role": c["role"],
                "tokens_used": c.get("tokens_used", 0),
                "sessions": c.get("sessions_run", 0),
                "tasks_done": c.get("tasks_completed", 0),
                "cost_usd": c.get("tokens_used", 0) * 0.000003,
            }
            for c in contribs.data
        ],
    }
```

---

## Credit System Integration

### Connecting Tokens to Credits

The existing `credit_events` table tracks credit awards. In v2, credits are calculated from verified token usage:

```
Tokens spent by agent on completed, verified tasks → Credit points for contributor

Formula:
  credits_earned = (tokens_used_on_verified_tasks / 1000) * credit_multiplier

credit_multiplier based on verification tier:
  Tier 0: 1.0x (self-reported)
  Tier 1: 1.5x (build-checked)
  Tier 2: 2.0x (peer-reviewed)
  Tier 3: 2.5x (human-approved)
```

Higher verification = more trust = more credits, incentivizing quality work.

---

## Implementation Details

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/api/routers/costs.py` | **NEW** | Cost breakdown endpoint |
| `apps/api/routers/worker.py` | **MODIFY** | Budget checks in heartbeat |
| `apps/api/routers/tasks.py` | **MODIFY** | Budget check on claim |
| `apps/api/init.sql` | **MODIFY** | Budget columns on jobs |
| `packages/cli/src/orchestrator.js` | **MODIFY** | Token parsing + reporting |
| `packages/cli/src/mcp.js` | **MODIFY** | Per-task token tracking |
| `apps/web/app/components/CostDashboard.tsx` | **NEW** | Cost visualization |

### Migration SQL

```sql
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS budget_cap INT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS budget_warning_pct INT DEFAULT 80;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS budget_used INT DEFAULT 0;
ALTER TABLE task_attempts ADD COLUMN IF NOT EXISTS tokens_used INT DEFAULT 0;
```
