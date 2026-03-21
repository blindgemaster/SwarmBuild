"""
Watchdog Service — Background task that detects disconnected agents and recovers tasks.

State Machine:
  active → stale (2 min no heartbeat) → disconnected (5 min, tasks released) → left (15 min)

Reference: The Engineering/01-FAULT-TOLERANCE.md
"""

import asyncio
from datetime import datetime, timedelta, timezone

from database import get_supabase
from lib.websocket import manager


STALE_THRESHOLD = timedelta(minutes=2)
DISCONNECTED_THRESHOLD = timedelta(minutes=5)
LEFT_THRESHOLD = timedelta(minutes=15)

STARTUP_DELAY = 120  # Wait 2 minutes before first watchdog cycle (server restart grace)


async def watchdog_tick():
    """Run one watchdog cycle. Called every 60 seconds."""
    db = get_supabase()
    now = datetime.now(timezone.utc)

    # Fetch all active/stale contributors across all running jobs
    active_contribs = (
        db.table("contributors")
        .select("id, job_id, worker_token, last_seen, contributor_status, role")
        .in_("contributor_status", ["active", "stale"])
        .is_("left_at", "null")
        .execute()
    )

    for contrib in active_contribs.data:
        last_seen_str = contrib.get("last_seen")
        if not last_seen_str:
            continue

        try:
            last_seen = datetime.fromisoformat(last_seen_str.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue

        elapsed = now - last_seen
        current_status = contrib["contributor_status"]
        job_id = contrib["job_id"]
        contrib_id = contrib["id"]
        token = contrib["worker_token"]

        # ── Transition: active → stale ──
        if current_status == "active" and elapsed > STALE_THRESHOLD:
            db.table("contributors").update({
                "contributor_status": "stale"
            }).eq("id", contrib_id).execute()

            await manager.broadcast(job_id, {
                "type": "contributor_status_change",
                "contributor_id": contrib_id,
                "role": contrib.get("role"),
                "status": "stale",
                "message": f"Agent ({contrib.get('role', 'unknown')}) hasn't responded in {int(elapsed.total_seconds())}s"
            })
            print(f"[watchdog] Contributor {contrib_id} marked STALE (silent for {int(elapsed.total_seconds())}s)")

        # ── Transition: stale → disconnected ──
        elif current_status == "stale" and elapsed > DISCONNECTED_THRESHOLD:
            # Release all tasks locked by this contributor
            locked_tasks = (
                db.table("tasks")
                .select("id, title")
                .eq("locked_by_token", token)
                .eq("status", "locked")
                .execute()
            )

            for task in locked_tasks.data:
                # Record the failed attempt
                db.table("task_attempts").insert({
                    "task_id": task["id"],
                    "worker_token": token,
                    "outcome": "agent_disconnected",
                    "log_summary": f"Agent disconnected after {int(elapsed.total_seconds())}s of silence",
                }).execute()

                # Release the task back to available (verify it's still locked by this agent)
                db.table("tasks").update({
                    "status": "available",
                    "locked_by_token": None,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", task["id"]).eq("locked_by_token", token).eq("status", "locked").execute()

                print(f"[watchdog] Released task '{task['title']}' (id={task['id']}) — agent disconnected")

            # Mark contributor as disconnected
            db.table("contributors").update({
                "contributor_status": "disconnected",
                "current_task_id": None,
            }).eq("id", contrib_id).execute()

            await manager.broadcast(job_id, {
                "type": "contributor_disconnected",
                "contributor_id": contrib_id,
                "role": contrib.get("role"),
                "released_tasks": [t["id"] for t in locked_tasks.data],
                "message": f"Agent ({contrib.get('role', 'unknown')}) disconnected. {len(locked_tasks.data)} task(s) released."
            })

            # Check if this was the last active contributor — stall the job
            remaining = (
                db.table("contributors")
                .select("id")
                .eq("job_id", job_id)
                .in_("contributor_status", ["active", "stale"])
                .is_("left_at", "null")
                .execute()
            )
            if not remaining.data:
                db.table("jobs").update({
                    "lobby_state": "gathering",
                }).eq("id", job_id).eq("status", "running").execute()

                await manager.broadcast(job_id, {
                    "type": "job_status_change",
                    "status": "stalled",
                    "message": "All agents have disconnected. Job needs contributors."
                })
                print(f"[watchdog] Job {job_id} stalled — no active contributors remaining")

        # ── Transition: disconnected → left ──
        elif current_status == "disconnected" and elapsed > LEFT_THRESHOLD:
            db.table("contributors").update({
                "contributor_status": "left",
                "left_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", contrib_id).execute()

            await manager.broadcast(job_id, {
                "type": "contributor_left",
                "contributor_id": contrib_id,
                "role": contrib.get("role"),
            })
            print(f"[watchdog] Contributor {contrib_id} marked LEFT (silent for {int(elapsed.total_seconds())}s)")


async def watchdog_loop():
    """Infinite loop that runs watchdog_tick every 60 seconds."""
    # Wait before first cycle to allow agents to reconnect after server restart
    print(f"[watchdog] Waiting {STARTUP_DELAY}s before first cycle (server restart grace period)")
    await asyncio.sleep(STARTUP_DELAY)

    while True:
        try:
            await watchdog_tick()
        except Exception as e:
            print(f"[watchdog] Error in watchdog tick: {e}")
        await asyncio.sleep(60)
