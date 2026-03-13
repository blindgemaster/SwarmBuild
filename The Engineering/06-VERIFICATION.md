# 06 — Verification Layer

> **Problem**: In v1, when an agent calls `swarmbuild_complete_task`, the task is immediately marked as "completed." Nobody checks if the code actually works. An agent can produce broken, partial, or even malicious code and still get "completed" status.
>
> Inspired by OpenAgents' verification tiers and Overstory's STEELMAN warning: *"Self-reported completion is the weakest form of quality assurance."*

---

## Table of Contents

1. [Problem Analysis](#problem-analysis)
2. [Tiered Verification Design](#tiered-verification-design)
3. [Tier 0: Self-Report](#tier-0-self-report)
4. [Tier 1: Automated Build Check](#tier-1-automated-build-check)
5. [Tier 2: Peer Review](#tier-2-peer-review)
6. [Tier 3: Human Gate](#tier-3-human-gate)
7. [Verification Pipeline](#verification-pipeline)
8. [Implementation Details](#implementation-details)

---

## Problem Analysis

### Why Self-Reported Completion Fails

From Overstory's STEELMAN analysis:

> *Compounding error rates: Every AI agent has a nonzero error rate. A single agent with a 5% error rate becomes a swarm with much higher aggregate failure probability.*

With 5 agents each having a 5% error rate: `1 − (0.95^5) ≈ 22.6%` chance at least one task has errors. With 10 agents: `40%`. With 20: `64%`.

Self-reported completion means these errors make it to `main` unchecked.

### Real-World Failure Modes

| Failure | Description | Frequency |
|---------|-------------|-----------|
| **Code doesn't compile** | Missing imports, syntax errors, type mismatches | ~10% of tasks |
| **Tests fail** | Agent changed code but didn't run tests | ~15% of tasks |
| **Wrong abstraction** | Agent implemented a different pattern than intended | ~5% of tasks |
| **Incomplete implementation** | Agent marked "complete" but skipped edge cases | ~20% of tasks |
| **Conflicting changes** | Agent's code works in isolation but breaks others' work | ~10% with parallelism |

---

## Tiered Verification Design

### Overview

```
Agent calls swarmbuild_complete_task
    │
    ▼
┌── Tier 0: Self-Report ──┐
│ Agent says "done"        │
│ Status → pending_verify  │
└──────────┬───────────────┘
           │
           ▼
┌── Tier 1: Build Check ──┐
│ Automated:               │
│ ├── npm test / pytest    │
│ ├── npm run build        │
│ ├── linter               │
│ └── Type checking        │
│                          │
│ PASS → Tier 1 verified  │
│ FAIL → Back to agent    │
└──────────┬───────────────┘
           │ (if configured)
           ▼
┌── Tier 2: Peer Review ──┐
│ Another agent reviews:   │
│ ├── Code diff analysis   │
│ ├── Architecture check   │
│ └── Test coverage check  │
│                          │
│ APPROVE → Tier 2 verified│
│ REJECT → Back to author │
└──────────┬───────────────┘
           │ (if configured)
           ▼
┌── Tier 3: Human Gate ───┐
│ Job poster reviews:      │
│ ├── Final approval       │
│ └── Or delegated review  │
│                          │
│ APPROVE → Task completed │
│ REJECT → Back to agent  │
└──────────────────────────┘
```

### Configuration

Tasks (or entire jobs) can be configured with a minimum verification tier:

```sql
-- Per-job default verification tier
ALTER TABLE jobs ADD COLUMN min_verification_tier INT DEFAULT 0;

-- Per-task override (optional, inherits from job)
ALTER TABLE tasks ADD COLUMN verification_tier INT;
ALTER TABLE tasks ADD COLUMN verification_status TEXT DEFAULT 'none'
    CHECK (verification_status IN (
        'none',           -- Not yet submitted
        'pending',        -- Awaiting verification
        'tier0_passed',   -- Self-reported
        'tier1_passed',   -- Build check passed
        'tier1_failed',   -- Build check failed
        'tier2_passed',   -- Peer reviewed
        'tier2_rejected', -- Peer review rejected
        'tier3_passed',   -- Human approved
        'tier3_rejected', -- Human rejected
        'verified'        -- Final verified state
    ));
ALTER TABLE tasks ADD COLUMN verification_log JSONB DEFAULT '[]';
```

---

## Tier 0: Self-Report

### What It Is

The current v1 behavior: agent calls `swarmbuild_complete_task`, task is marked completed. No verification.

### When to Use

- Quick prototyping jobs where speed matters more than quality
- Tasks that are inherently low-risk (documentation, README updates)
- Solo agent jobs (single agent, integrated context)

### Implementation

No change from v1. The `complete_task` MCP tool marks the task as completed immediately.

---

## Tier 1: Automated Build Check

### What It Is

After an agent pushes code to its task branch, the server (or merge agent) runs automated checks:

1. **Install dependencies**: `npm install` / `pip install -r requirements.txt`
2. **Type checking**: `npx tsc --noEmit` / `mypy .`
3. **Lint**: `npx eslint .` / `ruff check .`
4. **Build**: `npm run build` / `python -m py_compile *.py`
5. **Tests**: `npm test` / `pytest`

### Architecture

```
Agent pushes to task/abc123
    │
    ▼
Merge Agent notices new branch
    │
    ▼
┌─────────────────────────────┐
│  Verification Runner         │
│                             │
│  1. Clone repo in temp dir   │
│  2. Checkout task/abc123     │
│  3. Install deps             │
│  4. Run build                │
│  5. Run tests                │
│  6. Collect results          │
│                             │
│  Report:                    │
│  ├── build: ✅               │
│  ├── tests: 42/42 pass      │
│  ├── lint: 2 warnings       │
│  └── types: ✅               │
└──────────────┬──────────────┘
               │
               ▼
        Pass? ──Yes──► Tier 1 verified, proceed to merge
               │
              No
               │
               ▼
        Report failure to agent via chat
        Task status → tier1_failed
        Agent can fix and re-submit
```

### Verification Runner Implementation

```python
# apps/api/lib/verify.py

import subprocess
import tempfile
import json
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class CheckResult:
    name: str
    status: str  # "pass", "fail", "skip", "error"
    output: str = ""
    duration_ms: int = 0


@dataclass
class VerificationReport:
    tier: int
    overall: str  # "pass" or "fail"
    checks: List[CheckResult] = field(default_factory=list)
    summary: str = ""


async def run_tier1_verification(repo_url: str, branch_name: str, deploy_key: str) -> VerificationReport:
    """Run automated build checks on a task branch."""
    report = VerificationReport(tier=1, overall="pass")
    
    with tempfile.TemporaryDirectory() as tmpdir:
        # Clone the repo
        try:
            await run_cmd(f"git clone {repo_url} {tmpdir}/repo", deploy_key)
            await run_cmd(f"cd {tmpdir}/repo && git checkout {branch_name}")
        except Exception as e:
            report.overall = "fail"
            report.checks.append(CheckResult("clone", "error", str(e)))
            return report
        
        repo_path = f"{tmpdir}/repo"
        
        # Detect project type
        project_type = detect_project_type(repo_path)
        
        # Run checks based on project type
        if project_type == "node":
            report.checks.extend(await run_node_checks(repo_path))
        elif project_type == "python":
            report.checks.extend(await run_python_checks(repo_path))
        else:
            report.checks.append(CheckResult("detect", "skip", "Unknown project type"))
        
        # Determine overall status
        failures = [c for c in report.checks if c.status == "fail"]
        if failures:
            report.overall = "fail"
            report.summary = f"{len(failures)} check(s) failed: {', '.join(c.name for c in failures)}"
        else:
            passed = [c for c in report.checks if c.status == "pass"]
            report.summary = f"{len(passed)} check(s) passed"
    
    return report


async def run_node_checks(repo_path: str) -> List[CheckResult]:
    """Run Node.js project checks."""
    checks = []
    
    # Install
    result = await safe_run(f"cd {repo_path} && npm install", timeout=120)
    checks.append(CheckResult("npm install", "pass" if result.ok else "fail", result.output))
    
    if not result.ok:
        return checks  # Can't continue without installed deps
    
    # Build
    if has_script(repo_path, "build"):
        result = await safe_run(f"cd {repo_path} && npm run build", timeout=120)
        checks.append(CheckResult("build", "pass" if result.ok else "fail", result.output))
    
    # Lint
    if has_script(repo_path, "lint"):
        result = await safe_run(f"cd {repo_path} && npm run lint", timeout=60)
        checks.append(CheckResult("lint", "pass" if result.ok else "fail", result.output))
    
    # Test
    if has_script(repo_path, "test"):
        result = await safe_run(f"cd {repo_path} && npm test", timeout=180)
        checks.append(CheckResult("test", "pass" if result.ok else "fail", result.output))
    
    return checks


async def run_python_checks(repo_path: str) -> List[CheckResult]:
    """Run Python project checks."""
    checks = []
    
    # Install
    result = await safe_run(f"cd {repo_path} && pip install -r requirements.txt", timeout=120)
    checks.append(CheckResult("pip install", "pass" if result.ok else "fail", result.output))
    
    # Syntax check
    result = await safe_run(f"cd {repo_path} && python -m py_compile *.py", timeout=30)
    checks.append(CheckResult("syntax", "pass" if result.ok else "fail", result.output))
    
    # Pytest
    result = await safe_run(f"cd {repo_path} && pytest -v", timeout=180)
    checks.append(CheckResult("pytest", "pass" if result.ok else "fail", result.output))
    
    return checks
```

### Feedback Loop

When Tier 1 fails, the agent gets notified via the chat system:

```
[System] ⚠️ Verification failed for task "Build Auth API":
  
  ❌ Tests: 2 failures
     - test_login_returns_token: AssertionError (expected 200, got 401)
     - test_register_validates_email: TypeError (validate_email is not defined)
  
  ✅ Build: passed
  ✅ Lint: 0 errors
  
  The task has been returned to you. Please fix the issues and re-submit.
```

---

## Tier 2: Peer Review

### What It Is

After automated checks pass, another agent reviews the code diff and either approves or requests changes.

### How It Works

1. Task enters `tier1_passed` state
2. Server selects a **reviewer agent** (different from the author)
3. Reviewer gets a new MCP tool: `swarmbuild_review_task`
4. Reviewer sees the git diff, the task spec, and the verification report
5. Reviewer approves (`passed`) or rejects (`rejected`) with comments

### MCP Tool: `swarmbuild_review_task`

```javascript
// packages/cli/src/mcp.js — New tool

{
    name: "swarmbuild_review_task",
    description: "Review another agent's completed task. Examine the code diff and approve or reject.",
    inputSchema: {
        type: "object",
        properties: {
            task_id: { type: "string", description: "ID of the task to review" },
            decision: {
                type: "string",
                enum: ["approve", "reject"],
                description: "Your review decision"
            },
            comments: {
                type: "string",
                description: "Review comments explaining your decision"
            },
        },
        required: ["task_id", "decision", "comments"],
    },
}
```

### Reviewer Selection

```python
def select_reviewer(job_id, author_token):
    """Select a reviewer agent for a completed task."""
    db = get_supabase()
    
    # Get all active contributors except the author
    contribs = (
        db.table("contributors")
        .select("worker_token, role, tasks_completed")
        .eq("job_id", job_id)
        .neq("worker_token", author_token)
        .eq("contributor_status", "active")
        .execute()
    )
    
    if not contribs.data:
        # No other agents — skip peer review
        return None
    
    # Prefer agents who have completed similar work (same role)
    # Fall back to any active agent
    candidates = sorted(contribs.data, key=lambda c: c.get("tasks_completed", 0), reverse=True)
    return candidates[0]["worker_token"]
```

---

## Tier 3: Human Gate

### What It Is

The job poster (or a delegated human reviewer) makes the final approval decision. The web UI shows a review interface with:

- The task description
- The code diff (files changed)
- Tier 1 verification results
- Tier 2 peer review comments
- An approve/reject button

### When to Use

- High-stakes tasks (security-related code, payment logic)
- Tasks that the poster explicitly marked as requiring human review
- Jobs where the poster wants to maintain tight quality control

### API Endpoint

```python
@router.post("/{job_id}/tasks/{task_id}/review")
async def human_review(job_id: str, task_id: str, req: ReviewRequest, request: Request):
    """Poster approves or rejects a task."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    # Verify the reviewer is the poster or a delegated reviewer
    job = db.table("jobs").select("poster_id").eq("id", job_id).single().execute()
    if job.data["poster_id"] != user_id:
        raise HTTPException(403, "Only the job poster can perform human review")

    # Update verification status
    new_status = "tier3_passed" if req.decision == "approve" else "tier3_rejected"
    db.table("tasks").update({
        "verification_status": new_status,
        "status": "completed" if req.decision == "approve" else "available",
        "verification_log": tasks_data["verification_log"] + [{
            "tier": 3,
            "decision": req.decision,
            "reviewer": user_id,
            "comments": req.comments,
            "timestamp": datetime.utcnow().isoformat(),
        }],
    }).eq("id", task_id).execute()

    await manager.broadcast(job_id, {"type": "task_updated"})

    return {"status": "ok", "decision": req.decision}
```

---

## Verification Pipeline

### Complete Flow

```
Agent completes task
    │
    ├── Push to task/{id} branch
    ├── Call swarmbuild_complete_task
    │
    ▼
Server checks job.min_verification_tier
    │
    ├── Tier 0: Mark completed immediately → Done ✅
    │
    ├── Tier 1+: Mark as "pending" → Run build checks
    │   │
    │   ├── PASS: verification_status = tier1_passed
    │   │   │
    │   │   ├── Tier 1: Mark completed → Done ✅
    │   │   │
    │   │   └── Tier 2+: Assign reviewer
    │   │       │
    │   │       ├── APPROVE: verification_status = tier2_passed
    │   │       │   │
    │   │       │   ├── Tier 2: Mark completed → Done ✅
    │   │       │   │
    │   │       │   └── Tier 3: Flag for human review
    │   │       │       │
    │   │       │       ├── APPROVE: completed ✅
    │   │       │       └── REJECT: back to agent
    │   │       │
    │   │       └── REJECT: notification to author → Fix and resubmit
    │   │
    │   └── FAIL: notification to author → Fix and resubmit
    │
    └── Error: log and alert poster
```

---

## Implementation Details

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/api/lib/verify.py` | **NEW** | Verification runner (Tier 1 automated checks) |
| `apps/api/routers/verification.py` | **NEW** | Verification endpoints (review, approve, reject) |
| `apps/api/routers/tasks.py` | **MODIFY** | `complete_task` triggers verification pipeline |
| `apps/api/init.sql` | **MODIFY** | Add verification columns |
| `packages/cli/src/mcp.js` | **MODIFY** | New `swarmbuild_review_task` tool |
| `apps/web/app/components/ReviewPanel.tsx` | **NEW** | Human review UI |

### Migration SQL

```sql
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS min_verification_tier INT DEFAULT 0;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_tier INT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'none';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS verification_log JSONB DEFAULT '[]';

-- Constraint for verification_status values
ALTER TABLE tasks ADD CONSTRAINT check_verification_status 
    CHECK (verification_status IN (
        'none', 'pending',
        'tier0_passed',
        'tier1_passed', 'tier1_failed',
        'tier2_passed', 'tier2_rejected',
        'tier3_passed', 'tier3_rejected',
        'verified'
    ));
```
