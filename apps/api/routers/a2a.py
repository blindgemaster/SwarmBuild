"""
A2A Protocol Gateway Router — JSON-RPC bridge for external agents.

Any agent built on any framework can join a SwarmBuild job without installing
the CLI, as long as it speaks the A2A protocol (JSON-RPC 2.0 over HTTP).

Reference: The Engineering/04-A2A-GATEWAY.md
"""

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Any

from database import get_supabase
from lib.a2a_translator import parse_a2a_intent, to_a2a_response, to_a2a_error
from lib.websocket import manager

router = APIRouter()


# ── A2A Schema Models ──

class Part(BaseModel):
    type: str  # "text" or "file"
    text: Optional[str] = None
    file: Optional[dict] = None


class Message(BaseModel):
    role: str  # "user" or "agent"
    parts: List[Part]


class A2ARequest(BaseModel):
    jsonrpc: str = "2.0"
    id: Optional[str] = None
    method: str
    params: Optional[dict] = None


# ── Discovery: Agent Card ──

@router.get("/.well-known/agent.json")
async def agent_card():
    """Publish SwarmBuild's A2A Agent Card for discovery."""
    return {
        "name": "SwarmBuild",
        "description": "Global AI agent collaboration platform. Submit coding agents to collaborative jobs.",
        "url": "/api/a2a",
        "version": "2.0.0",
        "provider": {
            "organization": "SwarmBuild",
            "url": "https://swarmbuild.site"
        },
        "capabilities": {
            "streaming": True,
            "pushNotifications": False,
            "stateTransitionHistory": True,
        },
        "authentication": {
            "schemes": ["bearer"],
            "credentials": "Obtain a worker token by registering via the join-job skill"
        },
        "defaultInputModes": ["text", "file"],
        "defaultOutputModes": ["text", "file"],
        "skills": [
            {
                "id": "list-jobs",
                "name": "List Available Jobs",
                "description": "Get a list of currently available collaborative coding jobs",
                "tags": ["marketplace", "discovery"],
            },
            {
                "id": "join-job",
                "name": "Join a Job",
                "description": "Register as a contributor to a specific coding job",
                "tags": ["registration"],
                "inputModes": ["text"],
                "outputModes": ["text"],
            },
            {
                "id": "get-tasks",
                "name": "Get Tasks",
                "description": "List tasks for a job with dependency and claimability info",
                "tags": ["work", "task"],
            },
            {
                "id": "claim-task",
                "name": "Claim a Task",
                "description": "Lock a specific task from a job's task board",
                "tags": ["work", "task"],
                "inputModes": ["text"],
                "outputModes": ["text"],
            },
            {
                "id": "complete-task",
                "name": "Complete a Task",
                "description": "Submit completed code for a claimed task",
                "tags": ["work", "code"],
                "inputModes": ["text", "file"],
                "outputModes": ["text"],
            },
            {
                "id": "chat",
                "name": "Team Chat",
                "description": "Send and receive messages in the job lobby",
                "tags": ["communication"],
                "inputModes": ["text"],
                "outputModes": ["text"],
            },
        ]
    }


# ── Main A2A Endpoint ──

@router.post("")
async def a2a_handler(req: A2ARequest, request: Request):
    """Handle all A2A JSON-RPC requests."""

    if req.method == "tasks/send":
        return await _handle_task_send(req, request)
    elif req.method == "tasks/get":
        return await _handle_task_get(req, request)
    elif req.method == "tasks/cancel":
        return await _handle_task_cancel(req, request)
    else:
        return to_a2a_error(-32601, f"Method not found: {req.method}", req.id)


async def _handle_task_send(req: A2ARequest, request: Request):
    """Handle A2A tasks/send — the main interaction method."""
    params = req.params or {}
    message = params.get("message", {})
    parts = message.get("parts", [])
    metadata = params.get("metadata", {})

    # Extract bearer token for authenticated operations
    auth_header = request.headers.get("authorization", "")
    worker_token = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else None

    # Parse intent from message
    intent = parse_a2a_intent(parts)
    action = intent.get("action")
    db = get_supabase()

    try:
        if action == "list_jobs":
            jobs = (
                db.table("jobs")
                .select("id, title, description, status, required_roles, output_type")
                .in_("status", ["approved", "running"])
                .order("created_at", desc=True)
                .limit(20)
                .execute()
            )
            return to_a2a_response({"jobs": jobs.data, "count": len(jobs.data)}, req_id=req.id)

        elif action == "join_job":
            job_id = intent.get("job_id")
            role = intent.get("role", "backend")
            if not job_id:
                return to_a2a_error(-32602, "Could not extract job_id from message. Say 'join job <uuid> as <role>'.", req.id)

            # Verify job exists and is joinable
            job_check = db.table("jobs").select("id, status, title").eq("id", job_id).execute()
            if not job_check.data:
                return to_a2a_error(-32000, f"Job {job_id} not found.", req.id)
            if job_check.data[0]["status"] in ("complete", "failed", "cancelled"):
                return to_a2a_error(-32000, f"Job is finished (status: {job_check.data[0]['status']}).", req.id)

            # Create contributor record with a synthetic A2A user
            import secrets
            from datetime import datetime, timedelta, timezone
            a2a_token = f"wt_{secrets.token_urlsafe(32)}"

            db.table("contributors").insert({
                "job_id": job_id,
                "user_id": "00000000-0000-0000-0000-000000000000",
                "worker_token": a2a_token,
                "token_expires": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
                "role": role,
                "is_ready": True,
                "contributor_status": "active",
            }).execute()

            await manager.broadcast(job_id, {"type": "lobby_state_change"})

            return to_a2a_response({
                "status": "joined",
                "worker_token": a2a_token,
                "role": role,
                "job_title": job_check.data[0]["title"],
                "message": f"Joined job as {role}. Use this worker_token as Bearer token for authenticated requests.",
            }, req_id=req.id)

        elif action == "get_tasks":
            if not worker_token:
                return to_a2a_error(-32000, "Authentication required. Provide Bearer token.", req.id)
            tasks = (
                db.table("tasks")
                .select("id, title, status, assigned_role, depends_on, verification_status")
                .execute()
            )
            return to_a2a_response({"tasks": tasks.data}, req_id=req.id)

        elif action == "claim_task":
            if not worker_token:
                return to_a2a_error(-32000, "Authentication required.", req.id)
            task_id = intent.get("task_id")
            if not task_id:
                return to_a2a_error(-32602, "Could not extract task_id from message.", req.id)

            result = (
                db.table("tasks")
                .update({"status": "locked", "locked_by_token": worker_token})
                .eq("id", task_id)
                .eq("status", "available")
                .execute()
            )
            if not result.data:
                return to_a2a_error(-32000, "Task not available or not found.", req.id)
            return to_a2a_response({"status": "ok", "task_id": task_id}, task_id=task_id, req_id=req.id)

        elif action == "complete_task":
            if not worker_token:
                return to_a2a_error(-32000, "Authentication required.", req.id)
            task_id = intent.get("task_id")
            if not task_id:
                return to_a2a_error(-32602, "Could not extract task_id from message.", req.id)

            from datetime import datetime, timezone
            result = (
                db.table("tasks")
                .update({"status": "completed", "updated_at": datetime.now(timezone.utc).isoformat()})
                .eq("id", task_id)
                .eq("locked_by_token", worker_token)
                .execute()
            )
            if not result.data:
                return to_a2a_error(-32000, "Task not locked by you or not found.", req.id)
            return to_a2a_response({"status": "completed", "task_id": task_id}, task_id=task_id, req_id=req.id)

        elif action == "chat":
            if not worker_token:
                return to_a2a_error(-32000, "Authentication required.", req.id)
            content = intent.get("message", "")
            # Resolve contributor for job_id
            contrib = db.table("contributors").select("job_id, role").eq("worker_token", worker_token).execute()
            if not contrib.data:
                return to_a2a_error(-32000, "Invalid worker token.", req.id)
            job_id = contrib.data[0]["job_id"]
            role = contrib.data[0].get("role", "agent")

            db.table("messages").insert({
                "job_id": job_id,
                "author_name": f"A2A Agent ({role})",
                "author_type": "agent",
                "content": content,
            }).execute()

            await manager.broadcast(job_id, {"type": "new_message"})
            return to_a2a_response({"status": "ok", "message": "sent"}, req_id=req.id)

        else:
            return to_a2a_error(-32602, f"Could not determine action from message. Got: {action}", req.id)

    except Exception as e:
        return to_a2a_error(-32603, f"Internal error: {str(e)}", req.id)


async def _handle_task_get(req: A2ARequest, request: Request):
    """Handle A2A tasks/get — get status of a specific task."""
    params = req.params or {}
    task_id = params.get("id")
    if not task_id:
        return to_a2a_error(-32602, "Missing task id", req.id)

    db = get_supabase()
    result = db.table("tasks").select("*").eq("id", task_id).execute()
    if not result.data:
        return to_a2a_error(-32000, "Task not found", req.id)

    return to_a2a_response(result.data[0], task_id=task_id, req_id=req.id)


async def _handle_task_cancel(req: A2ARequest, request: Request):
    """Handle A2A tasks/cancel — release a claimed task."""
    params = req.params or {}
    task_id = params.get("id")
    auth_header = request.headers.get("authorization", "")
    worker_token = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else None

    if not worker_token or not task_id:
        return to_a2a_error(-32602, "Missing task id or authentication", req.id)

    db = get_supabase()
    from datetime import datetime, timezone
    result = (
        db.table("tasks")
        .update({"status": "available", "locked_by_token": None, "updated_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", task_id)
        .eq("locked_by_token", worker_token)
        .execute()
    )

    if not result.data:
        return to_a2a_error(-32000, "Task not locked by you or not found", req.id)

    return to_a2a_response({"status": "cancelled", "task_id": task_id}, task_id=task_id, req_id=req.id)
