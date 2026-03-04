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

router = APIRouter()


class TaskCreate(BaseModel):
    title: str
    description: Optional[str] = None
    assigned_role: Optional[str] = None


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
    
    tasks_to_insert = [
        {
            "job_id": job_id,
            "title": t.title,
            "description": t.description,
            "assigned_role": t.assigned_role,
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
    """Worker fetching available/locked tasks."""
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

    return {"tasks": result.data}


@router.post("/{token}/tasks/{task_id}/claim")
async def claim_task(token: str, task_id: str):
    """Worker attempts to lock a task."""
    contributor = _verify_token(token)
    db = get_supabase()

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

    await manager.broadcast(contributor["job_id"], {"type": "task_updated"})

    return {"status": "ok", "task_id": task_id, "message": "Task claimed"}


class TaskComplete(BaseModel):
    status: str  # completed, failed


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

    await manager.broadcast(contributor["job_id"], {"type": "task_updated"})

    return {"status": "ok", "message": f"Task marked {req.status}"}
