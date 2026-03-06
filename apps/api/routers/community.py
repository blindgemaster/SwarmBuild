"""
Community Router — Comments and votes on jobs

Threaded comments and simple upvoting.
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel
from typing import Optional
import httpx
import logging

from database import get_supabase
from auth_dependency import get_current_user_id as _get_user_id
from config import get_settings

router = APIRouter()

logger = logging.getLogger(__name__)


async def _ensure_profile(user_id: str, request: Request):
    """Ensure a profiles row exists for user_id with real metadata.
    If missing, fetch real metadata from Supabase Auth and create the row.
    If exists but has placeholder name, update it with real metadata."""
    db = get_supabase()
    existing = db.table("profiles").select("id, display_name").eq("id", user_id).execute()
    if existing.data and existing.data[0].get("display_name") not in (None, "New User"):
        return

    # Try to pull real user info from Supabase Auth
    display_name = "New User"
    username = f"user-{user_id[:8]}"
    avatar_url = None
    github_username = None

    try:
        token = request.headers.get("Authorization", "").split(" ", 1)[1]
        settings = get_settings()
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{settings.supabase_url}/auth/v1/user",
                headers={
                    "apikey": settings.supabase_anon_key,
                    "Authorization": f"Bearer {token}",
                },
            )
        if resp.status_code == 200:
            user_data = resp.json()
            meta = user_data.get("user_metadata") or {}
            display_name = meta.get("full_name") or meta.get("name") or display_name
            avatar_url = meta.get("avatar_url") or avatar_url
            github_username = meta.get("user_name") or meta.get("preferred_username") or github_username
            email = user_data.get("email", "")
            if email and username.startswith("user-"):
                username = email.split("@")[0]
    except Exception as e:
        logger.warning(f"Could not fetch user metadata for profile creation: {e}")

    profile_data = {
        "display_name": display_name,
        "avatar_url": avatar_url,
        "github_username": github_username,
    }

    if existing.data:
        # Update the placeholder profile with real data
        db.table("profiles").update(profile_data).eq("id", user_id).execute()
    else:
        # Create new profile
        profile_data["id"] = user_id
        profile_data["username"] = username
        db.table("profiles").insert(profile_data).execute()


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

    # Ensure the user has a profile row (FK constraint requires it)
    await _ensure_profile(user_id, request)

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

    # Ensure the user has a profile row (FK constraint may require it)
    await _ensure_profile(user_id, request)

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
    """Check if the current user has voted on a job, and return current count.
    Tolerates missing/invalid auth — returns voted=false for anonymous users."""
    db = get_supabase()

    # Get total vote count (always works)
    count = (
        db.table("votes")
        .select("user_id", count="exact")
        .eq("job_id", job_id)
        .execute()
    )

    # Try to get user vote status — gracefully handle missing auth
    voted = False
    try:
        user_id = await _get_user_id(request)
        existing = (
            db.table("votes")
            .select("user_id")
            .eq("job_id", job_id)
            .eq("user_id", user_id)
            .execute()
        )
        voted = len(existing.data) > 0
    except Exception:
        pass

    return {"voted": voted, "vote_count": count.count or 0}


@router.delete("/{job_id}/vote")
async def remove_vote(job_id: str, request: Request):
    """Remove upvote from a job."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    db.table("votes").delete().eq("job_id", job_id).eq("user_id", user_id).execute()

    return {"message": "Vote removed"}
