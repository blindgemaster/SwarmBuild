"""
JWT Scoped Worker Tokens — Role-based permission system for worker tokens.

v2 tokens are signed JWTs with claims for contributor_id, job_id, role,
and a permission set. This replaces the v1 plaintext token lookup.

Reference: The Engineering/09-SECURITY.md §Scoped Worker Tokens
"""

import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

try:
    import jwt
except ImportError:
    jwt = None  # PyJWT not installed — fallback to v1 token verification


_jwt_secret = os.environ.get("JWT_SECRET", "")
if not _jwt_secret:
    import warnings
    warnings.warn(
        "JWT_SECRET not set — using random ephemeral key. "
        "Set JWT_SECRET in .env for persistent token validation.",
        stacklevel=2,
    )
    import secrets as _secrets
    _jwt_secret = _secrets.token_urlsafe(64)
SECRET_KEY = _jwt_secret

ROLE_PERMISSIONS = {
    "lead": [
        "claim_task", "complete_task", "create_tasks",
        "read_chat", "send_message", "read_tasks",
        "review_task",
    ],
    "backend": [
        "claim_task", "complete_task",
        "read_chat", "send_message", "read_tasks",
    ],
    "frontend": [
        "claim_task", "complete_task",
        "read_chat", "send_message", "read_tasks",
    ],
    "devops": [
        "claim_task", "complete_task",
        "read_chat", "send_message", "read_tasks",
    ],
    "reviewer": [
        "read_tasks", "review_task",
        "read_chat", "send_message",
    ],
    "merge-agent": [
        "read_tasks", "read_chat",
    ],
}


def create_worker_token(contributor_id: str, job_id: str, role: str) -> str:
    """Create a scoped JWT worker token."""
    if jwt is None:
        # Fallback: return a simple token if PyJWT not installed
        import secrets
        return f"wt_{secrets.token_hex(24)}"

    permissions = ROLE_PERMISSIONS.get(role, ROLE_PERMISSIONS["backend"])

    payload = {
        "sub": contributor_id,
        "job_id": job_id,
        "role": role,
        "permissions": permissions,
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(hours=24),
        "iss": "swarmbuild",
    }

    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")


def verify_worker_token(token: str) -> Optional[dict]:
    """
    Verify and decode a worker token.
    Returns the decoded payload or None if invalid.
    For backward compat with v1 tokens (wt_...), returns None to
    signal the caller should fall back to DB lookup.
    """
    if jwt is None:
        return None  # PyJWT not installed — use v1 DB verification

    # v1 tokens start with "wt_" — skip JWT verification
    if token.startswith("wt_"):
        return None

    try:
        payload = jwt.decode(
            token, SECRET_KEY,
            algorithms=["HS256"],
            issuer="swarmbuild",
        )
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        return None  # Not a valid JWT — fall back to DB


def require_permission(token_payload: dict, permission: str):
    """Check if a token has a specific permission."""
    if permission not in token_payload.get("permissions", []):
        raise HTTPException(
            status_code=403,
            detail=f"Permission denied: {permission} not allowed for role {token_payload['role']}"
        )
