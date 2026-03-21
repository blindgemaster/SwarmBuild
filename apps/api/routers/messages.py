"""
Messages Router — Human/Agent Chat for Web UI and MCP

Handles message creation and fetching.
Uses the same logic as logs for WebSocket, or we can just fetch via REST for now.
"""

from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from typing import Optional
import difflib
import logging

from database import get_supabase
from auth_dependency import get_current_user_id as _get_user_id
from routers.worker import _verify_token  # Re-use worker auth
from lib.websocket import manager
from lib.sse import event_bus
from lib.security import scan_for_secrets, redact_secrets, scan_for_injection

router = APIRouter()

# ── Lobby WebSockets ────────────────────────────────────────

@router.websocket("/jobs/{job_id}/lobby/ws")
async def lobby_websocket(websocket: WebSocket, job_id: str):
    await manager.connect(websocket, job_id)
    try:
        while True:
            # Just keep the connection open. Clients shouldn't send data here, 
            # they should use the REST endpoints to trigger broadcasts safely.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, job_id)
# ── Human Endpoints (Web UI) ────────────────────────────────

class HumanMessageCreate(BaseModel):
    content: str


@router.get("/jobs/{job_id}/messages")
async def get_human_messages(job_id: str):
    """Get recent messages for a job."""
    db = get_supabase()
    
    result = (
        db.table("messages")
        .select("*")
        .eq("job_id", job_id)
        .order("created_at", desc=False)
        .execute()
    )
    return {"messages": result.data}


@router.post("/jobs/{job_id}/messages")
async def create_human_message(job_id: str, req: HumanMessageCreate, request: Request):
    """Human posts a message from the Web UI."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    # Get profile for name
    profile_res = db.table("profiles").select("display_name, username").eq("id", user_id).execute()
    if not profile_res.data:
        raise HTTPException(status_code=404, detail="User profile not found")
        
    author_name = profile_res.data[0].get("display_name") or profile_res.data[0].get("username") or "Human"

    result = db.table("messages").insert({
        "job_id": job_id,
        "author_name": author_name,
        "author_type": "human",
        "content": req.content
    }).execute()

    if result.data:
        # Broadcast immediately to everyone in the lobby!
        await manager.broadcast(job_id, {
            "type": "new_message",
            "message": result.data[0]
        })
        await event_bus.publish("message.new", {
            "job_id": job_id,
            "author_name": author_name,
            "author_type": "human",
            "message_id": result.data[0].get("id"),
        })

    return {"status": "ok"}


# ── Agent Endpoints (MCP via Worker Token) ──────────────────

class AgentMessageCreate(BaseModel):
    content: str


@router.get("/worker/{token}/messages")
async def get_agent_messages(token: str):
    """Agent fetches recent chat history."""
    contributor = _verify_token(token)
    job_id = contributor["job_id"]
    db = get_supabase()

    # Fetch last 50 messages to give context to agent
    result = (
        db.table("messages")
        .select("*")
        .eq("job_id", job_id)
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    )
    
    # Reverse so they are chronological
    return {"messages": list(reversed(result.data))}


@router.post("/worker/{token}/messages")
async def create_agent_message(token: str, req: AgentMessageCreate):
    """Agent broadcasts a message to the Web UI chat."""
    contributor = _verify_token(token)
    job_id = contributor["job_id"]
    db = get_supabase()

    author_name = f"Agent ({contributor.get('role', 'Teammate')})"

    # v2.4: Chat spam prevention — deduplicate near-identical agent messages
    try:
        recent_from_me = (
            db.table("messages")
            .select("content, created_at")
            .eq("job_id", job_id)
            .eq("author_name", author_name)
            .order("created_at", desc=True)
            .limit(3)
            .execute()
        )
        if recent_from_me.data:
            last_msg = recent_from_me.data[0]
            last_time_str = last_msg["created_at"]
            # Parse ISO timestamp
            if last_time_str.endswith("Z"):
                last_time_str = last_time_str[:-1] + "+00:00"
            elif "+" not in last_time_str and "-" not in last_time_str[10:]:
                last_time_str = last_time_str + "+00:00"
            last_time = datetime.fromisoformat(last_time_str)
            now = datetime.now(timezone.utc)
            seconds_since_last = (now - last_time).total_seconds()

            if seconds_since_last < 120:  # Within 2 minutes
                similarity = difflib.SequenceMatcher(
                    None,
                    last_msg["content"].lower().strip()[:500],
                    req.content.lower().strip()[:500],
                ).ratio()

                if similarity > 0.6:
                    # Silently suppress duplicate — return OK so agent doesn't retry
                    return {"status": "ok", "deduplicated": True}
    except Exception:
        pass  # Non-fatal — if dedup check fails, just let the message through

    # Security: scan for prompt injection attempts
    injection_findings = scan_for_injection(req.content)
    if injection_findings:
        critical = [f for f in injection_findings if f["severity"] == "critical"]
        if critical:
            logging.warning(
                f"[security] Blocked agent message with critical injection attempt "
                f"(job={job_id}, types={[f['type'] for f in critical]})"
            )
            raise HTTPException(
                status_code=422,
                detail={
                    "error": "injection_detected",
                    "message": "Message blocked: potential prompt injection detected",
                    "findings": critical,
                }
            )
        # Non-critical injections: log but allow
        logging.info(
            f"[security] Agent message flagged for injection patterns "
            f"(job={job_id}, types={[f['type'] for f in injection_findings]})"
        )

    # Security: scan and redact secrets before storing
    secret_findings = scan_for_secrets(req.content)
    content = req.content
    if secret_findings:
        logging.warning(
            f"[security] Redacted {len(secret_findings)} secret(s) from agent message "
            f"(job={job_id}, types={[f['type'] for f in secret_findings]})"
        )
        content = redact_secrets(content)

    result = db.table("messages").insert({
        "job_id": job_id,
        "author_name": author_name,
        "author_type": "agent",
        "content": content
    }).execute()

    if result.data:
        await manager.broadcast(job_id, {
            "type": "new_message",
            "message": result.data[0]
        })
        await event_bus.publish("message.new", {
            "job_id": job_id,
            "author_name": author_name,
            "author_type": "agent",
            "message_id": result.data[0].get("id"),
        })

    response = {"status": "ok"}
    if secret_findings:
        response["warning"] = f"{len(secret_findings)} secret(s) were redacted from your message"
        response["redacted_types"] = [f["type"] for f in secret_findings]
    return response
