"""
Auto-Merge Processor — Background task that processes the merge queue
by merging task branches into main via the GitHub API.

No git clone needed — pure HTTP calls to GitHub's merge endpoint.
Runs every 15 seconds alongside the watchdog.

Reference: The Engineering Part 2/01-AUTO-MERGE-PIPELINE.md
"""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx

from config import get_settings
from database import get_supabase
from lib.websocket import manager


MERGE_POLL_INTERVAL = 15  # seconds
STARTUP_DELAY = 30  # Grace period before first merge cycle
MAX_CONFLICT_RETRIES = 3  # Max times to re-enqueue a conflicted merge
RETRY_DELAY_SECONDS = 60  # Wait before retrying a conflicted merge


async def github_api_merge(repo_full_name: str, branch_name: str) -> dict:
    """Merge a branch into main using the GitHub API."""
    token = get_settings().github_token
    if not token:
        return {"success": False, "message": "No GITHUB_TOKEN configured on server"}

    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
    }

    url = f"https://api.github.com/repos/{repo_full_name}/merges"
    payload = {
        "base": "main",
        "head": branch_name,
        "commit_message": f"Auto-merge: {branch_name}",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=payload, headers=headers)

    if resp.status_code == 201:
        # Successful merge commit created
        return {"success": True, "fast_forward": False, "sha": resp.json().get("sha")}
    elif resp.status_code == 204:
        # Fast-forward (no merge commit needed)
        return {"success": True, "fast_forward": True}
    elif resp.status_code == 409:
        return {"success": False, "message": "Merge conflict — needs manual resolution"}
    elif resp.status_code == 404:
        return {"success": False, "message": f"Branch '{branch_name}' not found on GitHub"}
    else:
        body = resp.text[:500]
        return {"success": False, "message": f"GitHub API error {resp.status_code}: {body}"}


async def process_next_merge():
    """Process the next pending item in the merge queue."""
    db = get_supabase()

    # Recover stale items stuck in "processing" for >5 minutes (crash recovery)
    stale_cutoff = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    db.table("merge_queue").update({
        "status": "pending",
        "started_at": None,
    }).eq("status", "processing").lt("started_at", stale_cutoff).execute()

    # Retry conflicted merges: re-enqueue items marked "retry_pending" after enough time
    retry_cutoff = (datetime.now(timezone.utc) - timedelta(seconds=RETRY_DELAY_SECONDS)).isoformat()
    retry_items = (
        db.table("merge_queue")
        .select("id, position")
        .eq("status", "retry_pending")
        .lt("completed_at", retry_cutoff)
        .execute()
    )
    if retry_items.data:
        # Get max position to re-enqueue at the end
        max_pos = db.table("merge_queue").select("position").order("position", desc=True).limit(1).execute()
        next_pos = (max_pos.data[0]["position"] + 1) if max_pos.data else 1
        for ri in retry_items.data:
            db.table("merge_queue").update({
                "status": "pending",
                "started_at": None,
                "completed_at": None,
                "position": next_pos,
            }).eq("id", ri["id"]).execute()
            next_pos += 1
        print(f"[merge] Re-enqueued {len(retry_items.data)} retry_pending items")

    # Get next pending merge (FIFO order)
    pending = (
        db.table("merge_queue")
        .select("id, job_id, task_id, branch_name, position")
        .eq("status", "pending")
        .order("position")
        .limit(1)
        .execute()
    )

    if not pending.data:
        return  # Queue empty

    item = pending.data[0]
    job_id = item["job_id"]
    queue_id = item["id"]
    branch = item["branch_name"]

    # Look up the repo name from the job
    job = (
        db.table("jobs")
        .select("github_repo_id")
        .eq("id", job_id)
        .execute()
    )

    if not job.data or not job.data[0].get("github_repo_id"):
        print(f"[merge] Skipping queue item {queue_id} — no github_repo_id on job {job_id}")
        db.table("merge_queue").update({
            "status": "failed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", queue_id).execute()
        return

    repo_id = job.data[0]["github_repo_id"]

    # Atomic claim: only transition pending → processing (prevents double-processing)
    claim_result = (
        db.table("merge_queue").update({
            "status": "processing",
            "started_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("id", queue_id)
        .eq("status", "pending")
        .execute()
    )
    if not claim_result.data:
        return  # Another process already claimed this item

    print(f"[merge] Processing: {branch} -> main on {repo_id} (queue #{item['position']})")

    # Attempt merge via GitHub API
    result = await github_api_merge(repo_id, branch)

    now = datetime.now(timezone.utc).isoformat()

    if result["success"]:
        tier = 0 if result.get("fast_forward") else 1
        db.table("merge_queue").update({
            "status": "merged",
            "conflict_tier": tier,
            "resolution_by": f"auto-tier{tier}",
            "completed_at": now,
        }).eq("id", queue_id).execute()

        await manager.broadcast(job_id, {
            "type": "merge_completed",
            "branch": branch,
            "queue_id": queue_id,
            "tier": tier,
        })
        print(f"[merge] Merged {branch} (tier {tier})")
    else:
        # Parse retry count from conflict_diff field (JSON: {"retry_count": N, "message": "..."})
        existing = (
            db.table("merge_queue")
            .select("conflict_diff")
            .eq("id", queue_id)
            .execute()
        )
        prev_diff = (existing.data[0].get("conflict_diff") or "") if existing.data else ""
        retry_count = 0
        if prev_diff:
            try:
                parsed = json.loads(prev_diff)
                retry_count = parsed.get("retry_count", 0)
            except (json.JSONDecodeError, AttributeError):
                # Backwards compat: try old "retry:N|message" format
                if prev_diff.startswith("retry:"):
                    try:
                        retry_count = int(prev_diff.split("|")[0].split(":")[1])
                    except (ValueError, IndexError):
                        retry_count = 0

        error_msg = result.get("message", "Unknown error")
        retry_count += 1

        if retry_count < MAX_CONFLICT_RETRIES:
            # Re-enqueue for retry — set to retry_pending so the recovery step picks it up
            db.table("merge_queue").update({
                "status": "retry_pending",
                "conflict_tier": 2,
                "conflict_diff": json.dumps({"retry_count": retry_count, "message": error_msg}),
                "completed_at": now,
            }).eq("id", queue_id).execute()

            await manager.broadcast(job_id, {
                "type": "merge_retry",
                "branch": branch,
                "queue_id": queue_id,
                "retry_count": retry_count,
                "max_retries": MAX_CONFLICT_RETRIES,
                "message": error_msg,
            })
            print(f"[merge] Conflict on {branch} (attempt {retry_count}/{MAX_CONFLICT_RETRIES}), will retry: {error_msg}")
        else:
            # Exhausted retries — mark as terminal conflict (Tier 3)
            db.table("merge_queue").update({
                "status": "conflict",
                "conflict_tier": 3,
                "conflict_diff": json.dumps({"retry_count": retry_count, "message": error_msg}),
                "completed_at": now,
            }).eq("id", queue_id).execute()

            await manager.broadcast(job_id, {
                "type": "merge_conflict",
                "branch": branch,
                "queue_id": queue_id,
                "message": f"Terminal conflict after {retry_count} attempts: {error_msg}",
            })
            print(f"[merge] Terminal conflict on {branch} after {retry_count} retries: {error_msg}")


async def merge_processor_loop():
    """Infinite loop that processes the merge queue every 15 seconds."""
    print(f"[merge] Waiting {STARTUP_DELAY}s before first merge cycle")
    await asyncio.sleep(STARTUP_DELAY)

    while True:
        try:
            await process_next_merge()
        except Exception as e:
            print(f"[merge] Error in merge processor: {e}")
        await asyncio.sleep(MERGE_POLL_INTERVAL)
