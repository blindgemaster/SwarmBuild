"""
Jobs Router — CRUD for job/idea management

Handles the core lifecycle: create → discuss → approve → run → complete
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel
from typing import Optional

from database import get_supabase
from auth_dependency import get_current_user_id as _get_user_id
from lib.github import provision_job_repository
import logging

router = APIRouter()


# ── Request/Response Models ─────────────────────────

class CreateJobRequest(BaseModel):
    title: str
    description: str
    output_type: str  # rest-api | cli | library | script | fullstack
    tech_stack: list[str] = []
    constraints: Optional[str] = None
    examples: Optional[str] = None
    agent_count: int = 1


class UpdateJobRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    output_type: Optional[str] = None
    tech_stack: Optional[list[str]] = None
    constraints: Optional[str] = None
    examples: Optional[str] = None


class UpdateRolesRequest(BaseModel):
    roles: list[str]


# ── Endpoints ───────────────────────────────────────

@router.post("")
async def create_job(req: CreateJobRequest, request: Request):
    """Create a new job (submit an idea)."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    data = {
        "title": req.title,
        "description": req.description,
        "output_type": req.output_type,
        "tech_stack": req.tech_stack,
        "constraints": req.constraints,
        "examples": req.examples,
        "poster_id": user_id,
        "status": "pending",
        "required_agent_count": req.agent_count,
    }

    result = db.table("jobs").insert(data).execute()
    return result.data[0]


@router.get("")
async def list_jobs(
    status: Optional[str] = None,
    sort: str = Query("newest", regex="^(newest|votes|running)$"),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
):
    """List jobs — paginated, filterable by status, sortable."""
    db = get_supabase()

    query = db.table("jobs").select("*, votes(count)", count="exact")

    if status:
        query = query.eq("status", status)

    # Sort
    if sort == "newest":
        query = query.order("created_at", desc=True)
    elif sort == "running":
        query = query.eq("status", "running").order("created_at", desc=True)

    # Paginate
    offset = (page - 1) * per_page
    query = query.range(offset, offset + per_page - 1)

    result = query.execute()

    return {
        "jobs": result.data,
        "total": result.count,
        "page": page,
        "per_page": per_page,
    }


@router.get("/{job_id}/messages")
async def list_messages(job_id: str, limit: int = Query(50, le=100)):
    """Fetch messages for a specific job lobby/chat."""
    db = get_supabase()

    result = (
        db.table("messages")
        .select("*, profiles(username, display_name, avatar_url)")
        .eq("job_id", job_id)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )

    messages = result.data[::-1]
    return {"messages": messages}


@router.get("/{job_id}/tasks")
async def list_job_tasks(job_id: str):
    """Fetch all tasks associated with a job for the Kanban board."""
    db = get_supabase()

    result = (
        db.table("tasks")
        .select("*")
        .eq("job_id", job_id)
        .order("created_at")
        .execute()
    )

    return {"tasks": result.data}


@router.get("/{job_id}")
async def get_job(job_id: str):
    """Get job detail with live contributor count."""
    db = get_supabase()

    # Fetch job
    result = db.table("jobs").select("*").eq("id", job_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = result.data[0]

    # Count active contributors (seen in last 2 minutes)
    contrib_result = (
        db.table("contributors")
        .select("id", count="exact")
        .eq("job_id", job_id)
        .is_("left_at", "null")
        .execute()
    )

    # Count votes
    votes_result = (
        db.table("votes")
        .select("user_id", count="exact")
        .eq("job_id", job_id)
        .execute()
    )

    job["active_contributors"] = contrib_result.count or 0
    job["vote_count"] = votes_result.count or 0

    return job


@router.patch("/{job_id}")
async def update_job(job_id: str, req: UpdateJobRequest, request: Request):
    """Update a job spec (poster only, before approval)."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    # Verify ownership and status
    job_result = db.table("jobs").select("poster_id, status").eq("id", job_id).execute()
    if not job_result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = job_result.data[0]
    if job["poster_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the poster can edit this job")
    if job["status"] not in ("pending", "plan_ready"):
        raise HTTPException(status_code=400, detail="Cannot edit after approval")

    # Build update dict (only non-None fields)
    update_data = {k: v for k, v in req.model_dump().items() if v is not None}
    update_data["updated_at"] = datetime.utcnow().isoformat()

    result = db.table("jobs").update(update_data).eq("id", job_id).execute()
    return result.data[0]


@router.put("/{job_id}/roles")
async def update_job_roles(job_id: str, req: UpdateRolesRequest, request: Request):
    """Update the AI-generated required roles before approval."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    job_result = db.table("jobs").select("poster_id, status").eq("id", job_id).execute()
    if not job_result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = job_result.data[0]
    if job["poster_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the poster can edit this job")
    if job["status"] not in ("pending", "plan_ready"):
        raise HTTPException(status_code=400, detail="Cannot edit roles after approval")

    result = db.table("jobs").update({
        "required_roles": req.roles,
        "updated_at": datetime.utcnow().isoformat()
    }).eq("id", job_id).execute()
    
    return result.data[0]


@router.post("/{job_id}/approve")
async def approve_job(job_id: str, request: Request):
    """Poster approves the plan — job opens for contributors."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    job_result = db.table("jobs").select("poster_id, status, title").eq("id", job_id).execute()
    if not job_result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = job_result.data[0]
    if job["poster_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the poster can approve")
    if job["status"] != "plan_ready":
        raise HTTPException(status_code=400, detail=f"Cannot approve from status '{job['status']}'")

    try:
        logging.info("Provisioning GitHub Repository for Job...")
        repo_data = provision_job_repository(job_result.data[0]["title"])
        update_data = {
            "status": "approved",
            "updated_at": datetime.utcnow().isoformat(),
            "github_repo_url": repo_data["ssh_url"],
            "github_repo_id": repo_data["repo_name"],
            "github_deploy_key_private": repo_data["deploy_key_private"]
        }
    except Exception as e:
        logging.error(f"GitHub Provisioning Failed: {e}")
        # Fallback to approving without a repo if no token is configured
        update_data = {
            "status": "approved",
            "updated_at": datetime.utcnow().isoformat()
        }

    result = (
        db.table("jobs")
        .update(update_data)
        .eq("id", job_id)
        .execute()
    )
    return result.data[0]


@router.post("/{job_id}/complete")
async def complete_job(job_id: str, request: Request):
    """Poster manually marks a job as complete. AIs cannot do this."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    job_result = db.table("jobs").select("poster_id, status").eq("id", job_id).execute()
    if not job_result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = job_result.data[0]
    if job["poster_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the poster can mark a job complete")
    if job["status"] not in ("running", "approved"):
        raise HTTPException(status_code=400, detail=f"Cannot complete a job with status '{job['status']}'")

    result = (
        db.table("jobs")
        .update({
            "status": "complete",
            "completed_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
        })
        .eq("id", job_id)
        .execute()
    )
    return result.data[0]


@router.delete("/{job_id}")
async def cancel_job(job_id: str, request: Request):
    """Poster cancels a job."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    job_result = db.table("jobs").select("poster_id, status").eq("id", job_id).execute()
    if not job_result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = job_result.data[0]
    if job["poster_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the poster can cancel")
    if job["status"] in ("complete",):
        raise HTTPException(status_code=400, detail="Cannot cancel a completed job")

    result = (
        db.table("jobs")
        .update({"status": "cancelled", "updated_at": datetime.utcnow().isoformat()})
        .eq("id", job_id)
        .execute()
    )
    return result.data[0]
