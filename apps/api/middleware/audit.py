"""
Audit Logging Middleware — Logs all auditable API actions to the audit_log table.

Tracks who did what, when, and with what result for security and observability.

Reference: The Engineering/09-SECURITY.md §Audit Logging
"""

import hashlib
import re
import time
from typing import Optional

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from database import get_supabase


# Path patterns that should be audited (token-based worker endpoints)
AUDITED_PATTERNS = [
    r"/api/[^/]+/tasks",                    # create tasks, get tasks
    r"/api/[^/]+/tasks/[^/]+/claim",        # claim task
    r"/api/[^/]+/tasks/[^/]+/complete",     # complete task
    r"/api/[^/]+/tasks/release-all",        # release all tasks
    r"/api/worker/[^/]+/messages",          # send message
    r"/api/worker/heartbeat/[^/]+",         # heartbeat
    r"/api/worker/complete/[^/]+",          # worker complete
    r"/api/[^/]+/merge/enqueue",            # merge enqueue
]

# Compile patterns
_AUDIT_REGEXES = [re.compile(p) for p in AUDITED_PATTERNS]


def _should_audit(path: str) -> bool:
    """Check if this request path should be audited."""
    for regex in _AUDIT_REGEXES:
        if regex.search(path):
            return True
    return False


def _hash_token(token: Optional[str]) -> Optional[str]:
    """Hash a worker token for storage (don't store plaintext in audit log)."""
    if not token:
        return None
    return hashlib.sha256(token.encode()).hexdigest()[:16]


def _extract_token(path: str) -> Optional[str]:
    """Extract worker token from URL path."""
    # Patterns: /api/{token}/tasks, /api/worker/heartbeat/{token}, etc.
    parts = path.strip("/").split("/")
    if len(parts) >= 3:
        # /api/worker/heartbeat/{token}
        if "worker" in parts and "heartbeat" in parts:
            return parts[-1]
        # /api/worker/complete/{token}
        if "worker" in parts and "complete" in parts:
            return parts[-1]
        # /api/{token}/tasks/...
        if parts[0] == "api" and len(parts) >= 3:
            candidate = parts[1]
            # Token looks like wt_... or a long hex string
            if candidate.startswith("wt_") or len(candidate) > 20:
                return candidate
    return None


def _extract_action(method: str, path: str) -> str:
    """Derive an action name from HTTP method + path."""
    parts = path.strip("/").split("/")

    if "heartbeat" in parts:
        return "heartbeat"
    if "release-all" in parts:
        return "release_all_tasks"
    if "claim" in parts:
        return "claim_task"
    if "complete" in parts and "worker" in parts:
        return "worker_complete"
    if "complete" in parts:
        return "complete_task"
    if "enqueue" in parts:
        return "merge_enqueue"
    if "messages" in parts:
        return "send_message" if method == "POST" else "read_messages"
    if "tasks" in parts:
        return "create_tasks" if method == "POST" else "get_tasks"

    return f"{method.lower()}_{parts[-1]}" if parts else "unknown"


def _extract_resource_type(path: str) -> Optional[str]:
    """Derive the resource type from the path."""
    if "tasks" in path:
        return "task"
    if "messages" in path:
        return "message"
    if "merge" in path:
        return "merge"
    if "heartbeat" in path:
        return "heartbeat"
    return None


def _extract_resource_id(path: str) -> Optional[str]:
    """Extract a resource ID (e.g. task UUID) from the path."""
    parts = path.strip("/").split("/")
    # Look for UUID-like segments after 'tasks'
    for i, part in enumerate(parts):
        if part == "tasks" and i + 1 < len(parts):
            candidate = parts[i + 1]
            if candidate not in ("release-all",) and len(candidate) > 8:
                return candidate
    return None


class AuditMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware that logs auditable API actions to the audit_log table."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path
        method = request.method

        # Only audit matching paths and mutating methods (+ GET for tasks)
        if not _should_audit(path):
            return await call_next(request)

        start = time.time()
        response = await call_next(request)
        duration_ms = int((time.time() - start) * 1000)

        # Fire-and-forget audit log insert (don't block the response)
        try:
            token = _extract_token(path)
            db = get_supabase()

            # We need a job_id — try to get it from the contributor lookup
            # For now, we store what we can; job_id is required so we skip if unknown
            job_id = getattr(request.state, "job_id", None)

            # If we can't determine job_id, still log with a placeholder approach
            audit_entry = {
                "worker_token": _hash_token(token),
                "action": _extract_action(method, path),
                "resource_type": _extract_resource_type(path),
                "resource_id": _extract_resource_id(path),
                "response_status": response.status_code,
                "ip_address": request.client.host if request.client else None,
                "user_agent": request.headers.get("user-agent", "")[:500],
                "duration_ms": duration_ms,
            }

            if job_id:
                audit_entry["job_id"] = job_id
                db.table("audit_log").insert(audit_entry).execute()
            else:
                # Try to resolve job_id from token
                if token:
                    contrib = (
                        db.table("contributors")
                        .select("id, job_id, role")
                        .eq("worker_token", token)
                        .limit(1)
                        .execute()
                    )
                    if contrib.data:
                        audit_entry["contributor_id"] = contrib.data[0]["id"]
                        audit_entry["job_id"] = contrib.data[0]["job_id"]
                        audit_entry["role"] = contrib.data[0].get("role")
                        db.table("audit_log").insert(audit_entry).execute()
        except Exception as e:
            # Audit logging should never break the request
            print(f"[audit] Failed to log: {e}")

        return response
