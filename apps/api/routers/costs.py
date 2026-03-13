"""
Cost Tracking & Audit Router — Token usage, cost breakdown, and audit log per job.

Provides per-agent and per-task cost breakdowns with estimated USD costs,
plus audit log query endpoint.

Reference: The Engineering/08-COST-TRACKING.md §Cost Dashboard
Reference: The Engineering/09-SECURITY.md §Audit Logging
"""

from fastapi import APIRouter, HTTPException

from database import get_supabase

router = APIRouter()

# Approximate pricing per million tokens (Claude Sonnet)
DEFAULT_PRICE_PER_M_TOKENS = 3.0


@router.get("/jobs/{job_id}/costs")
async def get_cost_breakdown(job_id: str):
    """Get token usage and cost breakdown for a job."""
    db = get_supabase()

    # Verify job exists
    job = (
        db.table("jobs")
        .select("id, title, budget_cap, budget_used, budget_warning_pct")
        .eq("id", job_id)
        .execute()
    )
    if not job.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job_data = job.data[0]

    # Per-contributor breakdown
    contribs = (
        db.table("contributors")
        .select("id, role, tokens_used, sessions_run, tasks_completed, commits_pushed")
        .eq("job_id", job_id)
        .execute()
    )

    # Per-task breakdown from task_attempts
    attempts = (
        db.table("task_attempts")
        .select("task_id, tokens_used, outcome, worker_token")
        .execute()
    )

    # Filter attempts to only those related to tasks in this job
    job_tasks = (
        db.table("tasks")
        .select("id, title, status")
        .eq("job_id", job_id)
        .execute()
    )
    task_ids = {t["id"] for t in job_tasks.data}
    task_map = {t["id"]: t for t in job_tasks.data}

    job_attempts = [a for a in attempts.data if a.get("task_id") in task_ids]

    # Aggregate per-task token usage
    task_tokens = {}
    for attempt in job_attempts:
        tid = attempt["task_id"]
        if tid not in task_tokens:
            task_tokens[tid] = {
                "task_id": tid,
                "title": task_map.get(tid, {}).get("title", "Unknown"),
                "status": task_map.get(tid, {}).get("status", "unknown"),
                "tokens_used": 0,
                "attempts": 0,
            }
        task_tokens[tid]["tokens_used"] += attempt.get("tokens_used", 0) or 0
        task_tokens[tid]["attempts"] += 1

    # Compute totals
    total_tokens = sum(c.get("tokens_used", 0) or 0 for c in contribs.data)
    budget_cap = job_data.get("budget_cap")
    budget_pct = int(total_tokens / budget_cap * 100) if budget_cap else None
    price_per_token = DEFAULT_PRICE_PER_M_TOKENS / 1_000_000

    return {
        "job_id": job_id,
        "title": job_data.get("title"),
        "budget_cap": budget_cap,
        "budget_used": total_tokens,
        "budget_pct": budget_pct,
        "estimated_cost_usd": round(total_tokens * price_per_token, 4),
        "contributors": [
            {
                "role": c.get("role"),
                "tokens_used": c.get("tokens_used", 0) or 0,
                "sessions": c.get("sessions_run", 0) or 0,
                "tasks_done": c.get("tasks_completed", 0) or 0,
                "commits": c.get("commits_pushed", 0) or 0,
                "cost_usd": round((c.get("tokens_used", 0) or 0) * price_per_token, 4),
            }
            for c in contribs.data
        ],
        "tasks": list(task_tokens.values()),
    }


@router.get("/jobs/{job_id}/audit")
async def get_audit_log(job_id: str, limit: int = 100):
    """Get the audit log for a job, most recent first."""
    db = get_supabase()

    # Verify job exists
    job = db.table("jobs").select("id").eq("id", job_id).execute()
    if not job.data:
        raise HTTPException(status_code=404, detail="Job not found")

    result = (
        db.table("audit_log")
        .select("id, timestamp, role, action, resource_type, resource_id, response_status, duration_ms")
        .eq("job_id", job_id)
        .order("timestamp", desc=True)
        .limit(limit)
        .execute()
    )

    return {"entries": result.data}
