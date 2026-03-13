"""
A2A Protocol Translator — Maps between A2A JSON-RPC messages and SwarmBuild's internal API.

A2A uses "tasks" and "messages" with "parts" (text/file).
SwarmBuild uses REST endpoints for tasks, messages, and code submission.

Reference: The Engineering/04-A2A-GATEWAY.md
"""

import re
from typing import Optional


def parse_a2a_intent(message_parts: list) -> dict:
    """
    Parse the agent's A2A message to determine what SwarmBuild action to take.

    A2A messages are free-form text/file, but we need to map them to specific
    SwarmBuild operations. We use pattern matching for common operations.
    """
    text_content = " ".join(
        p.get("text", "") for p in message_parts if p.get("type") == "text"
    )
    file_parts = [p for p in message_parts if p.get("type") == "file"]
    text_lower = text_content.lower()

    # Pattern matching for common operations
    if "list" in text_lower and "job" in text_lower:
        return {"action": "list_jobs"}

    if "join" in text_lower and "job" in text_lower:
        job_id = _extract_uuid(text_content)
        role = _extract_role(text_content)
        return {"action": "join_job", "job_id": job_id, "role": role or "backend"}

    if "claim" in text_lower and "task" in text_lower:
        task_id = _extract_uuid(text_content)
        return {"action": "claim_task", "task_id": task_id}

    if ("complete" in text_lower or "submit" in text_lower) and "task" in text_lower:
        task_id = _extract_uuid(text_content)
        return {
            "action": "complete_task",
            "task_id": task_id,
            "files": file_parts,
            "message": text_content,
        }

    if "get" in text_lower and "task" in text_lower:
        return {"action": "get_tasks"}

    if file_parts:
        # Agent is submitting code
        return {
            "action": "submit_code",
            "files": file_parts,
            "message": text_content,
        }

    # Default: treat as a chat message
    return {"action": "chat", "message": text_content}


def to_a2a_response(internal_result: dict, task_id: str = None, req_id: str = None) -> dict:
    """Convert an internal API response to A2A JSON-RPC format."""
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "result": {
            "id": task_id or "unknown",
            "status": {
                "state": map_status(internal_result.get("status", "unknown")),
            },
            "artifacts": [
                {
                    "name": "result",
                    "parts": [
                        {"type": "text", "text": str(internal_result)}
                    ]
                }
            ]
        }
    }


def to_a2a_error(code: int, message: str, req_id: str = None) -> dict:
    """Create an A2A JSON-RPC error response."""
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {
            "code": code,
            "message": message,
        }
    }


def map_status(swarmbuild_status: str) -> str:
    """Map SwarmBuild task status to A2A task state."""
    mapping = {
        "available": "submitted",
        "locked": "working",
        "completed": "completed",
        "failed": "failed",
        "pending": "working",
        "ok": "completed",
    }
    return mapping.get(swarmbuild_status, "unknown")


def _extract_uuid(text: str) -> Optional[str]:
    """Extract a UUID from text."""
    match = re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', text, re.I)
    if match:
        return match.group(0)
    # Try short form (first 8 chars)
    match = re.search(r'\b([0-9a-f]{8})\b', text, re.I)
    return match.group(1) if match else None


def _extract_role(text: str) -> Optional[str]:
    """Extract a role name from text."""
    roles = ["lead", "backend", "frontend", "devops", "designer", "qa", "reviewer"]
    text_lower = text.lower()
    for role in roles:
        if role in text_lower:
            return role
    # Check "as <role>" pattern
    match = re.search(r'\bas\s+(\w+)', text_lower)
    return match.group(1) if match else None
