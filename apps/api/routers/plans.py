"""
Plans Router — Harness generation and plan management

Triggers AI-powered test harness generation via the harness-gen module.
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Request, BackgroundTasks
from pydantic import BaseModel
from typing import Optional

from database import get_supabase
from auth_dependency import get_current_user_id as _get_user_id

router = APIRouter()


# ── Background task: generate plan ──────────────────

async def _generate_plan_background(job_id: str):
    """
    Background task that calls harness-gen to create
    AGENT_PROMPT.md + test harness + task list.
    Uses Google Gemini API.
    """
    from config import get_settings

    settings = get_settings()
    db = get_supabase()

    # Fetch job details
    job_result = db.table("jobs").select("*").eq("id", job_id).execute()
    if not job_result.data:
        return

    job = job_result.data[0]

    try:
        # Import harness-gen (local package) using absolute path relative to this file
        import sys
        import os
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
        harness_gen_dir = os.path.join(repo_root, "packages", "harness-gen")
        if harness_gen_dir not in sys.path:
            sys.path.insert(0, harness_gen_dir)
            
        from generator import generate_harness, JobSpec

        # Fetch community discussion to inform the plan
        comments_result = (
            db.table("comments")
            .select("content, profiles(username, display_name)")
            .eq("job_id", job_id)
            .order("created_at")
            .limit(50)
            .execute()
        )
        discussion_lines = []
        for c in comments_result.data:
            profile = c.get("profiles") or {}
            name = profile.get("display_name") or profile.get("username") or "User"
            discussion_lines.append(f"- {name}: {c['content']}")
        discussion = "\n".join(discussion_lines) if discussion_lines else None

        spec = JobSpec(
            title=job["title"],
            description=job["description"],
            output_type=job["output_type"],
            tech_stack=job.get("tech_stack", []),
            constraints=job.get("constraints"),
            examples=job.get("examples"),
            agent_count=job.get("required_agent_count", 1),
            discussion=discussion,
        )

        plan = await generate_harness(spec, settings.hugging_face_token)

        # Enforce: "lead" must always be present as the first role
        roles = list(plan.required_roles or [])
        if "lead" not in roles:
            roles.insert(0, "lead")
        plan.required_roles = roles

        # Store generated plan in DB
        db.table("jobs").update({
            "agent_prompt": plan.agent_prompt,
            "required_roles": plan.required_roles,
            "test_harness": plan.test_files,
            "task_list": plan.task_list,
            "status": "plan_ready",
            "updated_at": datetime.utcnow().isoformat(),
        }).eq("id", job_id).execute()

        print(f"[api] Plan generated for job {job_id} (quality: {plan.quality_score}/10)")

    except Exception as e:
        print(f"[api] Plan generation failed for {job_id}: {e}")
        db.table("jobs").update({
            "status": "failed",
            "error_message": f"Plan generation failed: {str(e)}",
            "updated_at": datetime.utcnow().isoformat(),
        }).eq("id", job_id).execute()


# ── Endpoints ───────────────────────────────────────

@router.post("/{job_id}/generate-plan")
async def generate_plan(
    job_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
):
    """
    Trigger plan generation (poster only).
    Runs asynchronously — poll GET /api/jobs/{id}/plan for results.
    """
    user_id = await _get_user_id(request)
    db = get_supabase()

    job_result = db.table("jobs").select("poster_id, status").eq("id", job_id).execute()
    if not job_result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = job_result.data[0]
    if job["poster_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the poster can generate a plan")
    if job["status"] not in ("pending", "plan_ready", "failed"):
        raise HTTPException(status_code=400, detail=f"Cannot generate plan from status '{job['status']}'")

    # Update status to indicate generation in progress
    db.table("jobs").update({
        "status": "pending",
        "error_message": None,
        "updated_at": datetime.utcnow().isoformat(),
    }).eq("id", job_id).execute()

    # Run in background
    background_tasks.add_task(_generate_plan_background, job_id)

    return {"message": "Plan generation started", "job_id": job_id}


@router.get("/{job_id}/plan")
async def get_plan(job_id: str):
    """Get the generated plan for a job."""
    db = get_supabase()

    result = (
        db.table("jobs")
        .select("id, status, agent_prompt, test_harness, task_list")
        .eq("id", job_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = result.data[0]

    if not job["agent_prompt"]:
        return {
            "status": job["status"],
            "plan_ready": False,
            "message": "Plan not yet generated" if job["status"] == "pending" else "No plan available",
        }

    return {
        "status": job["status"],
        "plan_ready": True,
        "agent_prompt": job["agent_prompt"],
        "test_harness": job["test_harness"],
        "task_list": job["task_list"],
        "task_count": len(job["task_list"]) if job["task_list"] else 0,
    }


@router.patch("/{job_id}/plan")
async def edit_plan(job_id: str, request: Request):
    """
    Poster edits the generated plan before contributors join.
    Accepts partial updates to agent_prompt, test_harness, task_list.
    """
    user_id = await _get_user_id(request)
    db = get_supabase()

    job_result = db.table("jobs").select("poster_id, status").eq("id", job_id).execute()
    if not job_result.data:
        raise HTTPException(status_code=404, detail="Job not found")

    job = job_result.data[0]
    if job["poster_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the poster can edit the plan")
    if job["status"] != "plan_ready":
        raise HTTPException(status_code=400, detail="Can only edit plan in plan_ready status")

    body = await request.json()
    update_data = {}
    for field in ("agent_prompt", "test_harness", "task_list"):
        if field in body:
            update_data[field] = body[field]

    if update_data:
        update_data["updated_at"] = datetime.utcnow().isoformat()
        db.table("jobs").update(update_data).eq("id", job_id).execute()

    return {"message": "Plan updated"}
