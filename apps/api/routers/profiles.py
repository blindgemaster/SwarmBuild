"""
Profiles Router — Public user profile viewing

Provides endpoints for viewing user profiles, their posted jobs, and comments.
"""

from fastapi import APIRouter, HTTPException
from database import get_supabase

router = APIRouter()


@router.get("/{user_id}")
async def get_profile(user_id: str):
    """Get a user's public profile with stats."""
    db = get_supabase()

    profile_result = (
        db.table("profiles")
        .select("id, username, display_name, avatar_url, github_username, created_at")
        .eq("id", user_id)
        .execute()
    )
    if not profile_result.data:
        raise HTTPException(status_code=404, detail="Profile not found")

    profile = profile_result.data[0]

    # Count jobs posted
    jobs_result = (
        db.table("jobs")
        .select("id", count="exact")
        .eq("poster_id", user_id)
        .execute()
    )

    # Count comments
    comments_result = (
        db.table("comments")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .execute()
    )

    # Count votes given
    votes_result = (
        db.table("votes")
        .select("job_id", count="exact")
        .eq("user_id", user_id)
        .execute()
    )

    # Credit balance
    credits_result = (
        db.table("credit_events")
        .select("amount")
        .eq("user_id", user_id)
        .execute()
    )
    credit_balance = sum(row["amount"] for row in credits_result.data) if credits_result.data else 0

    return {
        "profile": profile,
        "stats": {
            "jobs_posted": jobs_result.count or 0,
            "comments": comments_result.count or 0,
            "votes_given": votes_result.count or 0,
            "credits": credit_balance,
        },
    }


@router.get("/{user_id}/jobs")
async def get_user_jobs(user_id: str):
    """Get jobs posted by a user."""
    db = get_supabase()

    result = (
        db.table("jobs")
        .select("id, title, description, output_type, tech_stack, status, created_at, vote_count:votes(count)")
        .eq("poster_id", user_id)
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    )

    return {"jobs": result.data}


@router.get("/{user_id}/comments")
async def get_user_comments(user_id: str):
    """Get comments made by a user."""
    db = get_supabase()

    result = (
        db.table("comments")
        .select("id, job_id, content, created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    )

    # Enrich with job titles
    job_ids = list({c["job_id"] for c in result.data if c.get("job_id")})
    jobs_by_id: dict = {}
    if job_ids:
        jobs_result = (
            db.table("jobs")
            .select("id, title")
            .in_("id", job_ids)
            .execute()
        )
        jobs_by_id = {j["id"]: j["title"] for j in jobs_result.data}

    for c in result.data:
        c["job_title"] = jobs_by_id.get(c.get("job_id"), "Unknown Job")

    return {"comments": result.data}
