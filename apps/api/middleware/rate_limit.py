"""
Rate Limiting Middleware — Per-token sliding window rate limiting.

In-memory implementation for now; upgrade to Redis-backed in production
for horizontal scaling.

Reference: The Engineering/09-SECURITY.md §Rate Limiting
"""

import re
import time
from collections import defaultdict
from typing import Optional

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse


# Rate limits per action type: max requests within a sliding window (seconds)
RATE_LIMITS = {
    "claim_task":       {"max": 10,  "window": 60},
    "complete_task":    {"max": 10,  "window": 60},
    "create_tasks":     {"max": 5,   "window": 60},
    "send_message":     {"max": 30,  "window": 60},
    "get_tasks":        {"max": 60,  "window": 60},
    "heartbeat":        {"max": 5,   "window": 60},
    "release_all":      {"max": 5,   "window": 60},
    "default":          {"max": 120, "window": 60},
}

# In-memory request timestamps per token:action
_request_counts: dict[str, list[float]] = defaultdict(list)


def _extract_token_from_path(path: str) -> Optional[str]:
    """Extract worker token from URL path."""
    parts = path.strip("/").split("/")
    if len(parts) >= 3:
        if "heartbeat" in parts or "complete" in parts:
            return parts[-1]
        if parts[0] == "api" and len(parts) >= 3:
            candidate = parts[1]
            if candidate.startswith("wt_") or len(candidate) > 20:
                return candidate
    return None


def _classify_action(method: str, path: str) -> str:
    """Classify the request into an action for rate limiting."""
    if "heartbeat" in path:
        return "heartbeat"
    if "release-all" in path:
        return "release_all"
    if "claim" in path:
        return "claim_task"
    if "complete" in path:
        return "complete_task"
    if "messages" in path and method == "POST":
        return "send_message"
    if "tasks" in path and method == "POST":
        return "create_tasks"
    if "tasks" in path and method == "GET":
        return "get_tasks"
    return "default"


def check_rate_limit(token: str, action: str) -> bool:
    """Returns True if the request should be allowed."""
    limits = RATE_LIMITS.get(action, RATE_LIMITS["default"])
    now = time.time()
    key = f"{token}:{action}"

    # Clean old entries outside window
    _request_counts[key] = [
        t for t in _request_counts[key]
        if now - t < limits["window"]
    ]

    if len(_request_counts[key]) >= limits["max"]:
        return False

    _request_counts[key].append(now)
    return True


class RateLimitMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware that enforces per-token rate limits."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path
        method = request.method

        # Only rate-limit API paths with tokens
        if not path.startswith("/api/"):
            return await call_next(request)

        token = _extract_token_from_path(path)
        if not token:
            return await call_next(request)

        action = _classify_action(method, path)
        if not check_rate_limit(token, action):
            limits = RATE_LIMITS.get(action, RATE_LIMITS["default"])
            return JSONResponse(
                status_code=429,
                content={
                    "error": "rate_limit_exceeded",
                    "message": f"Rate limit exceeded for {action}: max {limits['max']} requests per {limits['window']}s",
                    "retry_after": limits["window"],
                },
                headers={"Retry-After": str(limits["window"])},
            )

        return await call_next(request)
