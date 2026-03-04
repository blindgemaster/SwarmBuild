"""
Messages Router — Human/Agent Chat for Web UI and MCP

Handles message creation and fetching.
Uses the same logic as logs for WebSocket, or we can just fetch via REST for now.
"""

from datetime import datetime
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from typing import Optional

from database import get_supabase
from auth_dependency import get_current_user_id as _get_user_id
from routers.worker import _verify_token  # Re-use worker auth
from lib.websocket import manager

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

    result = db.table("messages").insert({
        "job_id": job_id,
        "author_name": author_name,
        "author_type": "agent",
        "content": req.content
    }).execute()

    if result.data:
        await manager.broadcast(job_id, {
            "type": "new_message",
            "message": result.data[0]
        })

    return {"status": "ok"}
