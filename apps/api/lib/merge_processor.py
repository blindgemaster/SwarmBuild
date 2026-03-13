"""
Auto-Merge Processor — Background task that processes the merge queue
by merging task branches into main via the GitHub API.

No git clone needed — pure HTTP calls to GitHub's merge endpoint.
Runs every 15 seconds alongside the watchdog.

Reference: The Engineering Part 2/01-AUTO-MERGE-PIPELINE.md
"""

import asyncio
from datetime import datetime, timezone

import httpx

from config import get_settings
from database import get_supabase
from lib.websocket import manager


MERGE_POLL_INTERVAL = 15  # seconds
STARTUP_DELAY = 30  # Grace period before first merge cycle


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

    # Mark as processing
    db.table("merge_queue").update({
        "status": "processing",
        "started_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", queue_id).execute()

    print(f"[merge] Processing: {branch} → main on {repo_id} (queue #{item['position']})")

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
        print(f"[merge] ✅ Merged {branch} (tier {tier})")
    else:
        db.table("merge_queue").update({
            "status": "conflict",
            "conflict_tier": 3,
            "conflict_diff": result.get("message", "Unknown error"),
            "completed_at": now,
        }).eq("id", queue_id).execute()

        await manager.broadcast(job_id, {
            "type": "merge_conflict",
            "branch": branch,
            "queue_id": queue_id,
            "message": result.get("message"),
        })
        print(f"[merge] ⚠️ Conflict on {branch}: {result.get('message')}")


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
