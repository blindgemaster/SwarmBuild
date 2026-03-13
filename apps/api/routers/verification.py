"""
Verification Router — Endpoints for the tiered verification pipeline.

Tier 0: Self-report (no verification)
Tier 1: Automated build checks
Tier 2: Peer review by another agent
Tier 3: Human gate (job poster approves)

Reference: The Engineering/06-VERIFICATION.md
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from database import get_supabase
from lib.websocket import manager
from lib.verify import select_reviewer

router = APIRouter()


class ReviewRequest(BaseModel):
    decision: str  # "approve" or "reject"
    comments: str


@router.get("/jobs/{job_id}/tasks/{task_id}/verification")
async def get_verification_status(job_id: str, task_id: str):
    """Get the current verification status and log for a task."""
    db = get_supabase()

    result = (
        db.table("tasks")
        .select("id, title, status, verification_tier, verification_status, verification_log")
        .eq("id", task_id)
        .eq("job_id", job_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Task not found")

    return {"task": result.data[0]}


@router.post("/jobs/{job_id}/tasks/{task_id}/review")
async def human_review(job_id: str, task_id: str, req: ReviewRequest):
    """
    Job poster approves or rejects a task (Tier 3 human gate).
    Also used for Tier 2 peer review when called by another agent.
    """
    db = get_supabase()

    # Fetch task
    task_result = (
        db.table("tasks")
        .select("id, title, status, verification_status, verification_log")
        .eq("id", task_id)
        .eq("job_id", job_id)
        .execute()
    )

    if not task_result.data:
        raise HTTPException(status_code=404, detail="Task not found")

    task = task_result.data[0]

    # Determine which tier this review is for
    current_vs = task.get("verification_status", "none")

    if current_vs == "tier1_passed":
        # This is a Tier 2 peer review
        new_status = "tier2_passed" if req.decision == "approve" else "tier2_rejected"
        tier = 2
    elif current_vs == "tier2_passed":
        # This is a Tier 3 human review
        new_status = "tier3_passed" if req.decision == "approve" else "tier3_rejected"
        tier = 3
    elif current_vs == "pending":
        # Direct human review (skip tiers)
        new_status = "tier3_passed" if req.decision == "approve" else "tier3_rejected"
        tier = 3
    else:
        raise HTTPException(
            status_code=409,
            detail=f"Task verification status '{current_vs}' does not accept reviews"
        )

    # Build updated verification log
    existing_log = task.get("verification_log") or []
    new_log_entry = {
        "tier": tier,
        "decision": req.decision,
        "comments": req.comments,
        "timestamp": datetime.utcnow().isoformat(),
    }
    updated_log = existing_log + [new_log_entry]

    # If approved at the required tier, mark the task as completed
    # If rejected, send it back to available for rework
    if req.decision == "approve":
        task_status = "completed"
        final_vs = new_status
    else:
        task_status = "available"
        final_vs = new_status

    db.table("tasks").update({
        "verification_status": final_vs,
        "status": task_status,
        "locked_by_token": None if task_status == "available" else task.get("locked_by_token"),
        "updated_at": datetime.utcnow().isoformat(),
        "verification_log": updated_log,
    }).eq("id", task_id).execute()

    await manager.broadcast(job_id, {
        "type": "task_verification_update",
        "task_id": task_id,
        "verification_status": final_vs,
        "task_status": task_status,
        "decision": req.decision,
    })

    return {
        "status": "ok",
        "decision": req.decision,
        "verification_status": final_vs,
        "task_status": task_status,
    }


@router.get("/jobs/{job_id}/tasks/pending-review")
async def get_tasks_pending_review(job_id: str):
    """Get all tasks that need review (Tier 2 or Tier 3)."""
    db = get_supabase()

    result = (
        db.table("tasks")
        .select("id, title, status, verification_status, verification_tier, verification_log, assigned_role, locked_by_token")
        .eq("job_id", job_id)
        .in_("verification_status", ["pending", "tier1_passed", "tier2_passed"])
        .execute()
    )

    return {"tasks": result.data}
