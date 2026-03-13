"""
SSE Events Router — Server-Sent Events fallback for real-time job updates.

Some environments (corporate proxies, load balancers) block WebSocket upgrades.
SSE works over standard HTTP and provides a reliable fallback for one-way
event streaming.

Reference: The Engineering/07-REALTIME-INFRA.md §SSE Fallback Channel
"""

import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from database import get_supabase
from lib.websocket import manager

router = APIRouter()

SSE_HEARTBEAT_INTERVAL = 15  # seconds


@router.get("/jobs/{job_id}/events")
async def sse_events(job_id: str, request: Request):
    """
    SSE endpoint for real-time job events (fallback for WebSocket).

    Clients connect via EventSource:
        const es = new EventSource('/api/jobs/{job_id}/events');
        es.onmessage = (e) => console.log(JSON.parse(e.data));
    """

    async def event_generator():
        # Internal queue for this SSE connection
        queue: asyncio.Queue = asyncio.Queue()

        # Lightweight event forwarder — the manager broadcasts to WebSocket clients,
        # but SSE clients need a different delivery. We poll recent state instead.
        last_check = datetime.now(timezone.utc)

        try:
            # Send initial connection event
            yield _format_sse({
                "type": "connected",
                "job_id": job_id,
                "server_time": datetime.now(timezone.utc).isoformat(),
            })

            heartbeat_counter = 0
            while True:
                # Check if client disconnected
                if await request.is_disconnected():
                    break

                # Poll for recent changes (lightweight approach without Redis)
                try:
                    events = await _poll_job_events(job_id, last_check)
                    last_check = datetime.now(timezone.utc)

                    for event in events:
                        yield _format_sse(event)
                except Exception as e:
                    yield _format_sse({"type": "error", "message": str(e)})

                # Heartbeat to keep connection alive
                heartbeat_counter += 1
                if heartbeat_counter >= SSE_HEARTBEAT_INTERVAL:
                    yield ": heartbeat\n\n"
                    heartbeat_counter = 0

                await asyncio.sleep(1)

        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


def _format_sse(data: dict) -> str:
    """Format a dict as an SSE data frame."""
    return f"data: {json.dumps(data)}\n\n"


async def _poll_job_events(job_id: str, since: datetime) -> list:
    """
    Poll for recent changes to a job since the given timestamp.
    Returns a list of event dicts.

    This is a lightweight polling approach. When Redis pub/sub is added,
    this will be replaced with a proper subscription.
    """
    db = get_supabase()
    events = []
    since_iso = since.isoformat()

    # Check for new/updated tasks
    tasks = (
        db.table("tasks")
        .select("id, title, status, updated_at, verification_status")
        .eq("job_id", job_id)
        .gt("updated_at", since_iso)
        .execute()
    )
    for t in tasks.data:
        events.append({
            "type": "task_updated",
            "task_id": t["id"],
            "title": t["title"],
            "status": t["status"],
            "verification_status": t.get("verification_status"),
            "timestamp": t["updated_at"],
        })

    # Check for new messages
    messages = (
        db.table("messages")
        .select("id, author_name, author_type, content, created_at")
        .eq("job_id", job_id)
        .gt("created_at", since_iso)
        .order("created_at")
        .execute()
    )
    for m in messages.data:
        events.append({
            "type": "new_message",
            "message_id": m["id"],
            "author_name": m["author_name"],
            "author_type": m["author_type"],
            "content": m["content"],
            "timestamp": m["created_at"],
        })

    # Check for contributor status changes
    contribs = (
        db.table("contributors")
        .select("id, role, contributor_status, last_seen")
        .eq("job_id", job_id)
        .gt("last_seen", since_iso)
        .execute()
    )
    for c in contribs.data:
        events.append({
            "type": "contributor_status_change",
            "contributor_id": c["id"],
            "role": c.get("role"),
            "status": c.get("contributor_status"),
            "timestamp": c.get("last_seen"),
        })

    return events
