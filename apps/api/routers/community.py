"""
Community Router — Comments and votes on jobs

Threaded comments and simple upvoting.
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel
from typing import Optional

from database import get_supabase
from auth_dependency import get_current_user_id as _get_user_id

router = APIRouter()


# ── Comments ────────────────────────────────────────

class CreateCommentRequest(BaseModel):
    content: str
    parent_id: Optional[str] = None  # for threaded replies


@router.post("/{job_id}/comments")
async def create_comment(job_id: str, req: CreateCommentRequest, request: Request):
    """Post a comment on a job."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    # Verify job exists
    job = db.table("jobs").select("id").eq("id", job_id).execute()
    if not job.data:
        raise HTTPException(status_code=404, detail="Job not found")

    comment = {
        "job_id": job_id,
        "user_id": user_id,
        "content": req.content,
        "parent_id": req.parent_id,
    }

    result = db.table("comments").insert(comment).execute()
    return result.data[0]


@router.get("/{job_id}/comments")
async def get_comments(job_id: str):
    """Get threaded comments for a job."""
    db = get_supabase()

    result = (
        db.table("comments")
        .select("*")
        .eq("job_id", job_id)
        .order("created_at")
        .execute()
    )

    # Build threaded structure
    comments_by_id = {}
    top_level = []

    for comment in result.data:
        # Enrich with profile
        profile = (
            db.table("profiles")
            .select("username, display_name, avatar_url")
            .eq("id", comment["user_id"])
            .execute()
        )
        comment["profile"] = profile.data[0] if profile.data else None
        comment["replies"] = []
        comments_by_id[comment["id"]] = comment

    for comment in result.data:
        if comment.get("parent_id") and comment["parent_id"] in comments_by_id:
            comments_by_id[comment["parent_id"]]["replies"].append(comment)
        else:
            top_level.append(comment)

    return {"comments": top_level, "total": len(result.data)}


# ── Votes ───────────────────────────────────────────

@router.post("/{job_id}/vote")
async def toggle_vote(job_id: str, request: Request):
    """Toggle vote on a job — vote if not voted, unvote if already voted."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    existing = (
        db.table("votes")
        .select("*")
        .eq("job_id", job_id)
        .eq("user_id", user_id)
        .execute()
    )

    if existing.data:
        db.table("votes").delete().eq("job_id", job_id).eq("user_id", user_id).execute()
        action = "removed"
    else:
        db.table("votes").insert({"job_id": job_id, "user_id": user_id}).execute()
        action = "added"

    count = (
        db.table("votes")
        .select("user_id", count="exact")
        .eq("job_id", job_id)
        .execute()
    )

    return {"message": action, "vote_count": count.count, "voted": action == "added"}


@router.get("/{job_id}/vote")
async def get_vote_status(job_id: str, request: Request):
    """Check if the current user has voted on a job."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    existing = (
        db.table("votes")
        .select("user_id")
        .eq("job_id", job_id)
        .eq("user_id", user_id)
        .execute()
    )

    return {"voted": len(existing.data) > 0}


@router.delete("/{job_id}/vote")
async def remove_vote(job_id: str, request: Request):
    """Remove upvote from a job."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    db.table("votes").delete().eq("job_id", job_id).eq("user_id", user_id).execute()

    return {"message": "Vote removed"}
