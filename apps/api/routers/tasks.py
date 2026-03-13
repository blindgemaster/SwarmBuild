"""
Tasks Router — Managing DB-backed Agent Tasks

Allows the Lead agent to create tasks, and teammate agents to query, 
claim, and complete tasks via the MCP Server.
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional, List

from database import get_supabase
from routers.worker import _verify_token  # Re-use worker auth
from lib.websocket import manager
from lib.dag import validate_task_dependencies, check_dependencies_met, enrich_tasks_with_dag_info

router = APIRouter()


class TaskCreate(BaseModel):
    title: str
    description: Optional[str] = None
    assigned_role: Optional[str] = None
    depends_on: Optional[List[str]] = None
    parallel_group: Optional[str] = None
    estimated_duration: Optional[int] = None


class TaskCreateRequest(BaseModel):
    tasks: List[TaskCreate]


@router.post("/{token}/tasks")
async def create_tasks(token: str, req: TaskCreateRequest):
    """Lead agent creates tasks for the team."""
    contributor = _verify_token(token)
    db = get_supabase()

    # Only lead can create tasks
    if contributor.get("role") != "lead":
        raise HTTPException(status_code=403, detail="Only the lead agent can create tasks")

    job_id = contributor["job_id"]
    
    # Fetch existing tasks for dependency validation
    existing = db.table("tasks").select("id, title, depends_on").eq("job_id", job_id).execute()

    # Build new tasks with temp structure for validation
    new_task_dicts = [
        {
            "title": t.title,
            "depends_on": t.depends_on or [],
        }
        for t in req.tasks
    ]

    # Validate DAG — check for circular dependencies
    validation = validate_task_dependencies(new_task_dicts, existing.data)
    if not validation["valid"]:
        raise HTTPException(status_code=400, detail={
            "error": "circular_dependencies",
            "message": validation["error"],
            "cycles": validation["cycles"],
        })

    tasks_to_insert = [
        {
            "job_id": job_id,
            "title": t.title,
            "description": t.description,
            "assigned_role": t.assigned_role,
            "depends_on": t.depends_on or [],
            "parallel_group": t.parallel_group,
            "estimated_duration": t.estimated_duration,
            "status": "available"
        }
        for t in req.tasks
    ]

    if tasks_to_insert:
        db.table("tasks").insert(tasks_to_insert).execute()
        await manager.broadcast(job_id, {"type": "task_updated"})

    return {"status": "ok", "message": f"Created {len(tasks_to_insert)} tasks"}


@router.get("/{token}/tasks")
async def get_tasks(token: str):
    """Worker fetching available/locked tasks with DAG dependency info."""
    contributor = _verify_token(token)
    db = get_supabase()
    
    job_id = contributor["job_id"]

    result = (
        db.table("tasks")
        .select("*")
        .eq("job_id", job_id)
        .order("created_at")
        .execute()
    )

    # Auto-release tasks locked by disconnected/left agents
    for task in result.data:
        if task["status"] == "locked" and task.get("locked_by_token"):
            locker = (
                db.table("contributors")
                .select("contributor_status")
                .eq("worker_token", task["locked_by_token"])
                .execute()
            )
            if locker.data and locker.data[0].get("contributor_status") in ("disconnected", "left"):
                db.table("tasks").update({
                    "status": "available",
                    "locked_by_token": None,
                    "updated_at": datetime.utcnow().isoformat(),
                }).eq("id", task["id"]).execute()
                task["status"] = "available"
                task["locked_by_token"] = None
                db.table("task_attempts").insert({
                    "task_id": task["id"],
                    "worker_token": task.get("locked_by_token", "unknown"),
                    "outcome": "agent_disconnected",
                    "log_summary": "Auto-released: agent disconnected",
                }).execute()

    # Enrich with contributor info for UI (who has which task)
    contrib_tokens = list({t["locked_by_token"] for t in result.data if t.get("locked_by_token")})
    contrib_map = {}
    if contrib_tokens:
        contribs = (
            db.table("contributors")
            .select("worker_token, role, contributor_status")
            .in_("worker_token", contrib_tokens)
            .execute()
        )
        contrib_map = {c["worker_token"]: c for c in contribs.data}

    for task in result.data:
        tok = task.get("locked_by_token")
        if tok and tok in contrib_map:
            task["locked_by_role"] = contrib_map[tok].get("role")
            task["locked_by_status"] = contrib_map[tok].get("contributor_status")
        else:
            task["locked_by_role"] = None
            task["locked_by_status"] = None

    # Enrich tasks with DAG info (is_claimable, blocking_tasks, priority_score)
    enriched = enrich_tasks_with_dag_info(result.data)

    return {"tasks": enriched}


@router.post("/{token}/tasks/{task_id}/claim")
async def claim_task(token: str, task_id: str):
    """Worker attempts to lock a task."""
    contributor = _verify_token(token)
    db = get_supabase()

    # Budget check — reject if job budget is exhausted
    job = contributor.get("jobs", {})
    if job and job.get("budget_cap"):
        budget_used = job.get("budget_used", 0) or 0
        if budget_used >= job["budget_cap"]:
            raise HTTPException(status_code=402, detail={
                "error": "budget_exhausted",
                "message": "Job budget exhausted. No more tasks can be claimed.",
                "budget_cap": job["budget_cap"],
                "budget_used": budget_used,
            })

    # Fetch the task and check dependencies before claiming
    task_result = db.table("tasks").select("*").eq("id", task_id).execute()
    if not task_result.data:
        raise HTTPException(status_code=404, detail="Task not found")

    task = task_result.data[0]
    if task["status"] != "available":
        raise HTTPException(status_code=409, detail=f"Task is already {task['status']}")

    # Check dependencies are met (task completed AND merge finished)
    depends_on = task.get("depends_on") or []
    if depends_on:
        deps_result = (
            db.table("tasks")
            .select("id, title, status")
            .in_("id", depends_on)
            .execute()
        )
        incomplete = [d for d in deps_result.data if d["status"] != "completed"]

        # v2.1: Also check that completed deps have been merged
        if not incomplete:
            for dep in deps_result.data:
                merge_check = (
                    db.table("merge_queue")
                    .select("status")
                    .eq("task_id", dep["id"])
                    .execute()
                )
                # If there's a merge queue entry that isn't merged yet, block
                if merge_check.data and merge_check.data[0]["status"] not in ("merged",):
                    incomplete.append({
                        "id": dep["id"],
                        "title": dep["title"],
                        "status": f"completed but merge {merge_check.data[0]['status']}",
                    })

        if incomplete:
            raise HTTPException(status_code=409, detail={
                "error": "dependencies_not_met",
                "message": f"Cannot claim: {len(incomplete)} dependency task(s) not ready",
                "blocking_tasks": [
                    {"id": d["id"], "title": d["title"], "status": d["status"]}
                    for d in incomplete
                ]
            })

    # Try to lock — checking status=available avoids race conditions
    result = (
        db.table("tasks")
        .update({
            "status": "locked",
            "locked_by_token": token,
            "updated_at": datetime.utcnow().isoformat()
        })
        .eq("id", task_id)
        .eq("status", "available")
        .execute()
    )

    if not result.data:
        # Check if it was locked by someone else or already complete
        task_check = db.table("tasks").select("status").eq("id", task_id).execute()
        if not task_check.data:
            raise HTTPException(status_code=404, detail="Task not found")
        raise HTTPException(status_code=409, detail=f"Task is already {task_check.data[0]['status']}")

    # Record task attempt
    db.table("task_attempts").insert({
        "task_id": task_id,
        "worker_token": token,
        "outcome": "in_progress",
    }).execute()

    # Fetch previous attempts for context
    prev_attempts = (
        db.table("task_attempts")
        .select("outcome, log_summary, branch_name, commit_sha, files_changed, started_at, ended_at")
        .eq("task_id", task_id)
        .neq("outcome", "in_progress")
        .order("started_at", desc=True)
        .execute()
    )

    await manager.broadcast(contributor["job_id"], {"type": "task_updated"})

    warning = None
    if prev_attempts.data:
        warning = f"This task was attempted {len(prev_attempts.data)} time(s) before. Check git history for partial work."

    return {
        "status": "ok",
        "task_id": task_id,
        "message": "Task claimed",
        "previous_attempts": prev_attempts.data,
        "warning": warning,
    }


class TaskComplete(BaseModel):
    status: str  # completed, failed
    tokens_used: int = 0


@router.post("/{token}/tasks/{task_id}/complete")
async def complete_task(token: str, task_id: str, req: TaskComplete):
    """Worker completes or fails a task."""
    contributor = _verify_token(token)
    db = get_supabase()

    result = (
        db.table("tasks")
        .update({
            "status": req.status,
            "updated_at": datetime.utcnow().isoformat()
        })
        .eq("id", task_id)
        .eq("locked_by_token", token)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=403, detail="Cannot complete task (not locked by you)")

    # Update the in-progress task attempt with outcome
    outcome = "completed" if req.status == "completed" else "failed"
    db.table("task_attempts").update({
        "outcome": outcome,
        "ended_at": datetime.utcnow().isoformat(),
        "tokens_used": req.tokens_used,
    }).eq("task_id", task_id).eq("worker_token", token).eq("outcome", "in_progress").execute()

    # Increment tasks_completed on the contributor if completed
    if req.status == "completed":
        db.rpc("increment_tasks_completed", {"contrib_id": contributor["id"]}).execute() if False else None
        # Fallback: read-then-write since Supabase may not have the RPC
        current = contributor.get("tasks_completed", 0) or 0
        db.table("contributors").update({
            "tasks_completed": current + 1,
            "current_task_id": None,
        }).eq("id", contributor["id"]).execute()

    await manager.broadcast(contributor["job_id"], {"type": "task_updated"})

    return {"status": "ok", "message": f"Task marked {req.status}"}


@router.get("/{token}/tasks/{task_id}/attempts")
async def get_task_attempts(token: str, task_id: str):
    """Get attempt history for a task."""
    _verify_token(token)
    db = get_supabase()

    result = (
        db.table("task_attempts")
        .select("*")
        .eq("task_id", task_id)
        .order("started_at", desc=True)
        .execute()
    )

    return {"attempts": result.data}


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
