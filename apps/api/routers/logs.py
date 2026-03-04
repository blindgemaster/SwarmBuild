"""
Log Relay Router — WebSocket pub/sub for streaming agent logs

Workers POST log lines → platform fans out to browser WebSockets.
Intentionally minimal (~40 lines). Per ARCHITECTURE.md: no Redis at this scale.
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Request, HTTPException, Query

from database import get_supabase

router = APIRouter()

# In-memory channel map: job_id → list of connected browser WebSockets
channels: dict[str, list[WebSocket]] = {}


@router.websocket("/{job_id}")
async def browser_subscribe(websocket: WebSocket, job_id: str):
    """
    Browser connects here to watch logs in real time.
    One WebSocket per browser tab viewing a job.
    """
    await websocket.accept()
    channels.setdefault(job_id, []).append(websocket)

    try:
        # Send initial connection message
        await websocket.send_json({
            "type": "connected",
            "job_id": job_id,
            "message": "Connected to log stream",
        })

        # Keep alive until browser disconnects
        while True:
            # Wait for any message (ping/pong or close)
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if job_id in channels and websocket in channels[job_id]:
            channels[job_id].remove(websocket)
            if not channels[job_id]:
                del channels[job_id]


@router.get("/{job_id}/history")
async def get_log_history(job_id: str, limit: int = Query(200, le=500)):
    """Return persisted log lines for a job (survives page refresh)."""
    db = get_supabase()
    result = (
        db.table("job_logs")
        .select("content")
        .eq("job_id", job_id)
        .order("id")
        .limit(limit)
        .execute()
    )
    return {"logs": [r["content"] for r in result.data]}


@router.post("/{worker_token}")
async def worker_publish(worker_token: str, request: Request):
    """
    Worker posts log lines here.
    Validates the worker token, resolves the job_id,
    then fans out to all connected browsers.
    """
    db = get_supabase()

    # Resolve worker token to job_id
    result = (
        db.table("contributors")
        .select("job_id")
        .eq("worker_token", worker_token)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=401, detail="Invalid worker token")

    job_id = result.data[0]["job_id"]
    log_line = (await request.body()).decode("utf-8", errors="replace")

    # Persist the log line (truncate at 4096 chars to avoid bloat)
    db.table("job_logs").insert({
        "job_id": job_id,
        "content": log_line[:4096],
    }).execute()

    # Fan out to all connected browsers
    disconnected = []
    for ws in channels.get(job_id, []):
        try:
            await ws.send_json({
                "type": "log",
                "content": log_line,
            })
        except Exception:
            disconnected.append(ws)

    # Clean up disconnected sockets
    for ws in disconnected:
        if job_id in channels and ws in channels[job_id]:
            channels[job_id].remove(ws)

    return {"status": "ok", "subscribers": len(channels.get(job_id, []))}
