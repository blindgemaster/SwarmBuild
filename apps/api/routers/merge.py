"""
Merge Queue Router — FIFO merge queue for processing branch merges into main.

Agents push to task-specific branches. When a task is complete, the agent
enqueues a merge request. The merge agent (or server) processes them in order.

Reference: The Engineering/02-MERGE-RESOLUTION.md
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from database import get_supabase
from routers.worker import _verify_token
from lib.websocket import manager

router = APIRouter()


class MergeRequest(BaseModel):
    task_id: str
    branch_name: str
    commit_sha: Optional[str] = None


class ResolveRequest(BaseModel):
    decision: str  # "merged" or "failed"
    resolution_by: Optional[str] = None
    conflict_diff: Optional[str] = None


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

    return {
        "status": "ok",
        "position": next_position,
        "queue_id": result.data[0]["id"] if result.data else None,
    }


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


@router.get("/{job_id}/merge/next")
async def get_next_pending_merge(job_id: str):
    """Get the next pending merge item for the merge agent to process."""
    db = get_supabase()
    result = (
        db.table("merge_queue")
        .select("*")
        .eq("job_id", job_id)
        .eq("status", "pending")
        .order("position")
        .limit(1)
        .execute()
    )

    if not result.data:
        return {"next": None}

    return {"next": result.data[0]}


@router.post("/{job_id}/merge/{queue_id}/status")
async def update_merge_status(job_id: str, queue_id: str, req: ResolveRequest):
    """
    Update the status of a merge queue item.
    Called by the merge agent after processing, or by a human resolving a conflict.
    """
    db = get_supabase()

    update_data = {
        "status": req.decision,
        "resolution_by": req.resolution_by,
        "completed_at": datetime.utcnow().isoformat(),
    }

    if req.conflict_diff:
        update_data["conflict_diff"] = req.conflict_diff

    result = (
        db.table("merge_queue")
        .update(update_data)
        .eq("id", queue_id)
        .eq("job_id", job_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Merge queue item not found")

    # Broadcast status update
    event_type = "merge_completed" if req.decision == "merged" else "merge_conflict"
    await manager.broadcast(job_id, {
        "type": event_type,
        "queue_id": queue_id,
        "status": req.decision,
        "branch": result.data[0].get("branch_name"),
    })

    return {"status": "ok", "merge_status": req.decision}


@router.post("/{job_id}/merge/{queue_id}/resolve")
async def resolve_conflict(job_id: str, queue_id: str, req: ResolveRequest, request: Request):
    """Human resolves a merge conflict manually."""
    db = get_supabase()

    # Verify the queue item exists and is in conflict state
    item = (
        db.table("merge_queue")
        .select("*")
        .eq("id", queue_id)
        .eq("job_id", job_id)
        .eq("status", "conflict")
        .execute()
    )

    if not item.data:
        raise HTTPException(status_code=404, detail="No conflicting merge item found")

    # Mark as resolved
    db.table("merge_queue").update({
        "status": "merged",
        "resolution_by": req.resolution_by or "human",
        "completed_at": datetime.utcnow().isoformat(),
    }).eq("id", queue_id).execute()

    await manager.broadcast(job_id, {
        "type": "merge_completed",
        "queue_id": queue_id,
        "status": "merged",
        "resolution": "human",
        "branch": item.data[0].get("branch_name"),
    })

    return {"status": "ok", "message": "Conflict resolved and merged"}
