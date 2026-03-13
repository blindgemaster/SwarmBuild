"""
Worker Protocol Router — Endpoints called by contributor Docker containers

These endpoints are authenticated via worker_token (not user session).
"""

from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List

from database import get_supabase

router = APIRouter()


def _verify_token(token: str) -> dict:
    """Verify a worker token and return the contributor record."""
    db = get_supabase()
    result = (
        db.table("contributors")
        .select("*, jobs(id, status, agent_prompt, test_harness, task_list, github_repo_url, github_repo_id, github_deploy_key_private, required_roles)")
        .eq("worker_token", token)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=401, detail="Invalid worker token")

    contributor = result.data[0]

    # Check expiry
    expires = datetime.fromisoformat(contributor["token_expires"].replace("Z", "+00:00"))
    if datetime.now(timezone.utc) > expires:
        raise HTTPException(status_code=401, detail="Worker token expired")

    return contributor


@router.get("/job/{token}")
async def get_job_for_worker(token: str):
    """
    Worker calls this on startup to get everything it needs:
    repo URL, agent prompt, test files, task list.
    """
    contributor = _verify_token(token)
    job = contributor.get("jobs")

    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    return {
        "job_id": job["id"],
        "github_repo_url": job.get("github_repo_url"),
        "github_repo_id": job.get("github_repo_id"),
        "github_deploy_key_private": job.get("github_deploy_key_private"),
        "agent_prompt": job.get("agent_prompt"),
        "required_roles": job.get("required_roles", []),
        "test_files": job.get("test_harness", {}),
        "task_list": job.get("task_list", []),
        "token_cap": contributor["token_cap"],
        "worker_token": token,
    }


class HeartbeatRequest(BaseModel):
    agents_running: int = 1
    tokens_used: int = 0
    current_task_id: Optional[str] = None
    status: str = "idle"  # idle, working, merging, waiting
    sessions_run: int = 0
    commits_pushed: int = 0


@router.post("/heartbeat/{token}")
async def worker_heartbeat(token: str, req: HeartbeatRequest):
    """Worker reports it's still alive (every 30s)."""
    contributor = _verify_token(token)
    db = get_supabase()

    now = datetime.utcnow().isoformat()

    # Update contributor record with v2 fields
    db.table("contributors").update({
        "last_seen": now,
        "num_agents": req.agents_running,
        "tokens_used": req.tokens_used,
        "sessions_run": req.sessions_run,
        "commits_pushed": req.commits_pushed,
        "current_task_id": req.current_task_id,
        "contributor_status": "active",
    }).eq("id", contributor["id"]).execute()

    # Determine if server wants the agent to stop
    job = contributor.get("jobs", {})
    should_stop = False
    stop_reason = None
    pending_notifications: List[dict] = []

    # Budget exhaustion check
    job_budget = job.get("budget_cap") if job else None
    if job_budget and req.tokens_used >= job_budget:
        should_stop = True
        stop_reason = "budget_exhausted"
    elif job_budget:
        # Budget warning at configured percentage
        warning_pct = job.get("budget_warning_pct", 80) / 100
        if req.tokens_used >= job_budget * warning_pct:
            pending_notifications.append({
                "type": "budget_warning",
                "message": f"Budget is {int(req.tokens_used / job_budget * 100)}% used ({req.tokens_used:,}/{job_budget:,} tokens)"
            })

    # Job cancellation/completion check
    if job and job.get("status") in ("cancelled", "complete", "failed"):
        should_stop = True
        stop_reason = f"job_{job.get('status')}"

    # Token expiry check (warn 5 min before)
    try:
        expires = datetime.fromisoformat(contributor["token_expires"].replace("Z", "+00:00"))
        if datetime.now(timezone.utc) > expires - timedelta(minutes=5):
            should_stop = True
            stop_reason = "token_expired"
    except (KeyError, ValueError):
        pass

    return {
        "status": "ok",
        "server_time": now,
        "should_stop": should_stop,
        "stop_reason": stop_reason,
        "pending_notifications": pending_notifications,
    }


class ProgressRequest(BaseModel):
    tokens_used: int = 0
    sessions_run: int = 0
    commits_pushed: int = 0


@router.post("/progress/{token}")
async def worker_progress(token: str, req: ProgressRequest):
    """Worker reports progress metrics."""
    contributor = _verify_token(token)
    db = get_supabase()

    db.table("contributors").update({
        "tokens_used": req.tokens_used,
        "sessions_run": req.sessions_run,
        "commits_pushed": req.commits_pushed,
        "last_seen": datetime.utcnow().isoformat(),
    }).eq("id", contributor["id"]).execute()

    return {"status": "ok"}


class CompleteRequest(BaseModel):
    status: str  # complete | stopped | cap_reached | failed
    message: Optional[str] = ""


@router.post("/complete/{token}")
async def worker_complete(token: str, req: CompleteRequest):
    """Worker reports job done or stopped."""
    contributor = _verify_token(token)
    db = get_supabase()

    # Mark contributor as left
    db.table("contributors").update({
        "left_at": datetime.utcnow().isoformat(),
    }).eq("id", contributor["id"]).execute()

    # Agents finishing their work: award credits but do NOT mark the job complete.
    # Only a human (the poster) can mark a job complete via POST /api/jobs/{id}/complete.
    if req.status == "complete":
        job_id = contributor["job_id"]

        # Award credits to all contributors on this job
        all_contribs = (
            db.table("contributors")
            .select("user_id, sessions_run")
            .eq("job_id", job_id)
            .gt("sessions_run", 0)
            .execute()
        )

        for c in all_contribs.data:
            credits = max(1, c["sessions_run"])
            db.table("credit_events").insert({
                "user_id": c["user_id"],
                "event_type": "contributed",
                "amount": credits,
                "job_id": job_id,
                "note": f"Contributed {c['sessions_run']} agent sessions",
            }).execute()

            db.table("contributors").update({
                "credits_earned": credits,
            }).eq("job_id", job_id).eq("user_id", c["user_id"]).execute()

    elif req.status == "failed":
        db.table("jobs").update({
            "status": "failed",
            "error_message": req.message,
            "updated_at": datetime.utcnow().isoformat(),
        }).eq("id", contributor["job_id"]).execute()

    return {"status": "ok", "message": f"Worker {req.status}"}
