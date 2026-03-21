"""
Contributors Router — Managing who's running agents on a job

Handles contributor registration, worker token issuance, and
generating the docker run command.
"""

import secrets
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from database import get_supabase
from auth_dependency import get_current_user_id as _get_user_id
from lib.websocket import manager

router = APIRouter()


def _generate_worker_token() -> str:
    """Generate a short-lived worker token."""
    return f"wt_{secrets.token_urlsafe(32)}"


class ContributeRequest(BaseModel):
    role: str = "teammate"  # lead, teammate, observer

@router.post("/{job_id}/contribute")
async def register_contributor(job_id: str, req: ContributeRequest, request: Request):
    """
    Register as a contributor to a job.
    Returns worker_token + CLI command to run.
    """
    user_id = await _get_user_id(request)
    db = get_supabase()

    # Verify job exists and is open for contributions
    job_result = db.table("jobs").select("id, title, status").eq("id", job_id).execute()
    if not job_result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = job_result.data[0]
    # v2.1: Allow hot-joining running jobs (not just approved)
    if job["status"] in ("complete", "failed", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=f"Job is finished — cannot join (status: {job['status']})"
        )

    # Build cli command string (used for both new and existing)
    from config import get_settings
    settings = get_settings()
    relay_url = settings.api_url
    
    # In dev mode, include the dummy auth token so the CLI can bypass auth.
    # In production, users must authenticate separately.
    if settings.dev_mode:
        cli_command = f"npx swarmbuild-cli run {job_id} --role {req.role} --relay {relay_url} --token dev-token-swarmbuild-test"
    else:
        cli_command = f"npx swarmbuild-cli run {job_id} --role {req.role} --relay {relay_url}"

    # Check if already contributing WITH THIS SPECIFIC ROLE
    existing = (
        db.table("contributors")
        .select("id, worker_token, role")
        .eq("job_id", job_id)
        .eq("user_id", user_id)
        .eq("role", req.role) # Allow same user to join multiple roles for testing
        .is_("left_at", "null")
        .execute()
    )
    if existing.data:
        # Idempotent return: they are already registered, return existing token & command
        return {
            "contributor_id": existing.data[0]["id"],
            "worker_token": existing.data[0]["worker_token"],
            "cli_command": cli_command,
            "role": existing.data[0]["role"],
            "job_title": job["title"],
            "expires_in": "24 hours",
        }

    # Create contributor record
    worker_token = _generate_worker_token()

    # v2.1: Hot-joiners on running jobs are auto-ready + active
    is_hot_join = job["status"] == "running"

    contributor = {
        "job_id": job_id,
        "user_id": user_id,
        "worker_token": worker_token,
        "role": req.role,
        "is_ready": True if is_hot_join else False,
        "contributor_status": "active" if is_hot_join else "registered",
        "token_expires": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
    }
    try:
        result = db.table("contributors").insert(contributor).execute()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DB Insert failed: {str(e)}")

    # Update job to lobby state if it was just approved
    if job["status"] == "approved":
        db.table("jobs").update({
            "status": "approved",  # stays approved until everyone is ready
            "lobby_state": "gathering",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", job_id).execute()


    # Broadcast that someone joined the lobby
    await manager.broadcast(job_id, {"type": "lobby_state_change"})

    return {
        "contributor_id": result.data[0]["id"],
        "worker_token": worker_token,
        "cli_command": cli_command,
        "role": req.role,
        "job_title": job["title"],
        "expires_in": "24 hours",
    }


@router.delete("/{job_id}/contribute")
async def unregister_contributor(job_id: str, request: Request):
    """Stop contributing to a job."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    result = (
        db.table("contributors")
        .update({"left_at": datetime.now(timezone.utc).isoformat()})
        .eq("job_id", job_id)
        .eq("user_id", user_id)
        .is_("left_at", "null")
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Not currently contributing to this job")

    # If the last person left, potentially revert lobby status, but keep it simple for now.
    await manager.broadcast(job_id, {"type": "lobby_state_change"})

    return {"message": "Stopped contributing"}

class ReadyRequest(BaseModel):
    is_ready: bool
    worker_token: Optional[str] = None  # preferred: uniquely identifies the contributor

@router.post("/{job_id}/ready")
async def toggle_ready(job_id: str, req: ReadyRequest, request: Request):
    """Toggle the ready state of a contributor in the lobby."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    job_result = db.table("jobs").select("required_roles").eq("id", job_id).execute()
    if not job_result.data:
        raise HTTPException(status_code=404, detail="Job not found")
    required_roles = job_result.data[0].get("required_roles") or ["teammate"]

    # Prefer lookup by worker_token — it is unique per contributor so multiple
    # agents sharing the same user_id (e.g. dev token) are correctly distinguished.
    if req.worker_token:
        current_contrib = (
            db.table("contributors")
            .select("id, role")
            .eq("worker_token", req.worker_token)
            .is_("left_at", "null")
            .execute()
        )
    else:
        current_contrib = (
            db.table("contributors")
            .select("id, role")
            .eq("job_id", job_id)
            .eq("user_id", user_id)
            .is_("left_at", "null")
            .execute()
        )
    if not current_contrib.data:
        raise HTTPException(status_code=404, detail="Not contributing to this job")

    my_role = current_contrib.data[0]["role"]

    if req.is_ready:
        all_ready_contribs = (
            db.table("contributors")
            .select("id, role, user_id")
            .eq("job_id", job_id)
            .eq("is_ready", True)
            .is_("left_at", "null")
            .execute()
        )
        
        allowed_count = required_roles.count(my_role)
        taken_count = sum(1 for c in all_ready_contribs.data if c["role"] == my_role and c["user_id"] != user_id)
        
        if taken_count >= allowed_count:
            raise HTTPException(status_code=409, detail=f"The '{my_role}' role is already fully claimed.")

    db.table("contributors").update({"is_ready": req.is_ready}).eq("id", current_contrib.data[0]["id"]).execute()

    final_ready_contribs = (
        db.table("contributors")
        .select("role")
        .eq("job_id", job_id)
        .eq("is_ready", True)
        .is_("left_at", "null")
        .execute()
    )
    
    ready_roles = [c["role"] for c in final_ready_contribs.data]
    
    all_ready = True
    for role in required_roles:
        if ready_roles.count(role) < required_roles.count(role):
            all_ready = False
            break

    if all_ready and len(required_roles) > 0:
        db.table("jobs").update({
            "status": "running",
            "lobby_state": "executing",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", job_id).execute()

    await manager.broadcast(job_id, {"type": "lobby_state_change"})

    return {
        "message": "Ready state updated",
        "is_ready": req.is_ready,
        "all_ready": all_ready
    }


@router.get("/{job_id}/contributors")
async def list_contributors(job_id: str):
    """List active contributors for a job."""
    db = get_supabase()

    # Fetch contributors (no FK join available in schema cache, so we enrich manually)
    result = (
        db.table("contributors")
        .select("id, user_id, joined_at, last_seen, num_agents, tokens_used, sessions_run, commits_pushed, role, is_ready, contributor_status")
        .eq("job_id", job_id)
        .is_("left_at", "null")
        .order("joined_at")
        .execute()
    )

    # Batch-fetch profiles for all contributor user_ids
    user_ids = list({c["user_id"] for c in result.data})
    profiles_by_id: dict = {}
    if user_ids:
        profiles_result = (
            db.table("profiles")
            .select("id, username, display_name, avatar_url")
            .in_("id", user_ids)
            .execute()
        )
        profiles_by_id = {p["id"]: p for p in profiles_result.data}

    contributors = []
    for c in result.data:
        profile = profiles_by_id.get(c["user_id"])
        contributors.append({**c, "profile": profile})

    return {
        "contributors": contributors,
        "total": len(contributors),
    }
