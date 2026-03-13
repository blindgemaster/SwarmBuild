# 09 — Security Hardening

> **Problem**: v1 worker tokens grant full access to all job data. There's no audit trail, no rate limiting, and no sandboxing. With internet-connected agents, the attack surface is significant.
>
> From Overstory STEELMAN: *"More agents = more autonomous processes with write access to your codebase. A compromised agent can escalate by sending malicious mail, reading sensitive files, or injecting into the merge queue."*

---

## Table of Contents

1. [Threat Model](#threat-model)
2. [Scoped Worker Tokens](#scoped-worker-tokens)
3. [Audit Logging](#audit-logging)
4. [Rate Limiting](#rate-limiting)
5. [Sandboxed Verification](#sandboxed-verification)
6. [Merge Gate (No Direct Push)](#merge-gate-no-direct-push)
7. [Implementation Details](#implementation-details)

---

## Threat Model

### Actors

| Actor | Trust Level | Capabilities |
|-------|-------------|-------------- |
| **Job Poster** | Trusted | Creates jobs, approves plans, reviews code |
| **Known Contributor** | Semi-trusted | Runs an agent, claims tasks, submits code |
| **Unknown A2A Agent** | Untrusted | External agent joining via A2A protocol |
| **Malicious Agent** | Adversarial | Deliberately tries to exploit the system |

### Attack Vectors

| Vector | Description | Impact | v1 Status |
|--------|-------------|--------|-----------|
| **Token theft** | Worker token intercepted in transit/logs | Full API access as that contributor | ⚠️ HTTPS only defense |
| **Malicious code** | Agent submits backdoor/vulnerability | Codebase compromised | ❌ No review gate |
| **Privilege escalation** | Agent uses another agent's token | Impersonation | ❌ No scoping |
| **Data exfiltration** | Agent reads other jobs' data | Data leak | ⚠️ Token is per-job but not enforced per-endpoint |
| **DoS via resource exhaustion** | Agent floods API with requests | Service unavailable | ❌ No rate limiting |
| **Prompt injection** | Agent sends crafted chat messages to manipulate other agents | Other agents compromised | ⚠️ Inherent LLM risk |
| **Git poisoning** | Agent pushes to main directly, bypassing review | Direct codebase compromise | ❌ Direct push allowed |

---

## Scoped Worker Tokens

### v1 Token Design

```
Token format: wt_{random_hex}
Stored in: contributors.worker_token (plaintext)
Verification: Lookup in DB, check expiry
Permissions: Unlimited within job scope
```

### v2 Token Design: JWT with Claims

```
Token format: Signed JWT
Claims:
  - sub: contributor_id
  - job_id: specific job UUID
  - role: "lead" | "backend" | "frontend" | ...
  - permissions: ["claim_task", "complete_task", "read_chat", "send_message"]
  - iat: issued_at timestamp
  - exp: expiration timestamp (24h)
  - iss: "swarmbuild"
```

### Implementation

```python
# apps/api/lib/tokens.py

import jwt
from datetime import datetime, timedelta, timezone
from typing import Optional

SECRET_KEY = os.environ.get("JWT_SECRET", "dev-secret-change-in-production")

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
    "reviewer": [
        "read_tasks", "review_task",
        "read_chat", "send_message",
    ],
}


def create_worker_token(contributor_id: str, job_id: str, role: str) -> str:
    """Create a scoped JWT worker token."""
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


def verify_worker_token(token: str) -> dict:
    """Verify and decode a worker token."""
    try:
        payload = jwt.decode(
            token, SECRET_KEY,
            algorithms=["HS256"],
            issuer="swarmbuild",
        )
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")


def require_permission(token_payload: dict, permission: str):
    """Check if a token has a specific permission."""
    if permission not in token_payload.get("permissions", []):
        raise HTTPException(403, f"Permission denied: {permission} not allowed for role {token_payload['role']}")
```

### Usage in Endpoints

```python
@router.post("/{token}/tasks")
async def create_tasks(token: str, req: CreateTasksRequest):
    payload = verify_worker_token(token)
    require_permission(payload, "create_tasks")  # Only lead can create tasks
    # ... rest of handler
```

---

## Audit Logging

### What Gets Logged

Every MCP tool call and API action is logged with:

```sql
CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp       TIMESTAMPTZ DEFAULT now(),
    
    -- Who
    worker_token    TEXT,           -- Token used (hashed)
    contributor_id  UUID,           -- Contributor reference
    job_id          UUID NOT NULL,  -- Job context
    role            TEXT,           -- Agent's role
    
    -- What
    action          TEXT NOT NULL,  -- e.g., "claim_task", "complete_task", "send_message"
    resource_type   TEXT,           -- e.g., "task", "message", "merge"
    resource_id     TEXT,           -- e.g., task UUID
    
    -- Context
    request_body    JSONB,          -- Sanitized request payload
    response_status INT,            -- HTTP status code
    
    -- Metadata
    ip_address      TEXT,
    user_agent      TEXT,
    duration_ms     INT
);

CREATE INDEX idx_audit_job ON audit_log(job_id, timestamp);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_contributor ON audit_log(contributor_id);
```

### Middleware Implementation

```python
# apps/api/middleware/audit.py

from fastapi import Request
import time

AUDITED_PATHS = [
    "/api/{token}/tasks",
    "/api/worker/{token}/messages",
    "/api/{token}/tasks/{task_id}/claim",
    "/api/{token}/tasks/{task_id}/complete",
    "/api/worker/heartbeat",
]


async def audit_middleware(request: Request, call_next):
    """Log all auditable API actions."""
    start = time.time()
    
    response = await call_next(request)
    
    duration = int((time.time() - start) * 1000)
    path = request.url.path
    
    # Check if this path should be audited
    if should_audit(path):
        token_payload = getattr(request.state, "token_payload", {})
        
        db = get_supabase()
        db.table("audit_log").insert({
            "worker_token": hash_token(extract_token(path)),
            "contributor_id": token_payload.get("sub"),
            "job_id": token_payload.get("job_id"),
            "role": token_payload.get("role"),
            "action": extract_action(request.method, path),
            "resource_type": extract_resource_type(path),
            "resource_id": extract_resource_id(path),
            "response_status": response.status_code,
            "ip_address": request.client.host,
            "user_agent": request.headers.get("user-agent", ""),
            "duration_ms": duration,
        }).execute()
    
    return response
```

### Audit Dashboard

```
┌─────────────────────────────────────────────────────────────────────┐
│  Audit Log — Job: Build Todo API                                   │
│                                                                     │
│  Time         Agent     Action          Resource     Status         │
│  ─────────── ────────── ────────────── ──────────── ────────       │
│  14:32:01    Lead      claim_task      task/a1b2    200 ✅         │
│  14:32:05    Lead      get_tasks       -            200 ✅         │
│  14:33:12    Backend   claim_task      task/c3d4    200 ✅         │
│  14:33:15    Backend   claim_task      task/e5f6    409 ⛔         │
│  14:35:00    Lead      complete_task   task/a1b2    200 ✅         │
│  14:35:02    Lead      send_message    msg/g7h8     200 ✅         │
│  14:35:30    Frontend  claim_task      task/i9j0    409 ⛔ (deps)  │
│                                                                     │
│  Suspicious Activity:                                              │
│  ⚠️ Backend attempted 5 rapid claim_task calls in 3 seconds        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Rate Limiting

### Per-Token Rate Limits

```python
# apps/api/middleware/rate_limit.py

from collections import defaultdict
import time

# In-memory counter (Redis-backed in production)
request_counts = defaultdict(list)

RATE_LIMITS = {
    "claim_task":       {"max": 10,  "window": 60},   # 10/min
    "complete_task":    {"max": 10,  "window": 60},   # 10/min
    "create_tasks":     {"max": 5,   "window": 60},   # 5/min
    "send_message":     {"max": 30,  "window": 60},   # 30/min
    "get_tasks":        {"max": 60,  "window": 60},   # 60/min
    "heartbeat":        {"max": 5,   "window": 60},   # 5/min (2/min normal)
    "default":          {"max": 120, "window": 60},   # 120/min catch-all
}


def check_rate_limit(token: str, action: str) -> bool:
    """Returns True if the request should be allowed."""
    limits = RATE_LIMITS.get(action, RATE_LIMITS["default"])
    now = time.time()
    key = f"{token}:{action}"
    
    # Clean old entries
    request_counts[key] = [t for t in request_counts[key] if now - t < limits["window"]]
    
    if len(request_counts[key]) >= limits["max"]:
        return False
    
    request_counts[key].append(now)
    return True
```

### Redis-Based Rate Limiting (Production)

```python
async def check_rate_limit_redis(redis, token: str, action: str) -> bool:
    limits = RATE_LIMITS.get(action, RATE_LIMITS["default"])
    key = f"ratelimit:{token}:{action}"
    
    current = await redis.incr(key)
    if current == 1:
        await redis.expire(key, limits["window"])
    
    return current <= limits["max"]
```

---

## Sandboxed Verification

### Problem

Tier 1 verification runs `npm test` and `npm run build` on agent-submitted code. A malicious agent could craft a `package.json` with malicious `preinstall` scripts that execute arbitrary code on the verification server.

### Solution: Docker Sandbox

```python
async def sandboxed_build_check(repo_path: str, commands: list[str]) -> CheckResult:
    """Run build commands inside a Docker container with limited privileges."""
    
    dockerfile = """
    FROM node:20-slim
    WORKDIR /app
    COPY . .
    RUN npm install --ignore-scripts  # Skip lifecycle scripts
    """
    
    # Build commands to run
    cmd = " && ".join(commands)
    
    result = await run_docker(
        image="swarmbuild-sandbox",
        volumes={repo_path: "/app"},
        command=f"sh -c '{cmd}'",
        timeout=120,          # 2 minute timeout
        memory_limit="512m",  # 512MB RAM max
        network="none",       # No network access
        read_only=False,      # Needs to write build artifacts
        user="nobody",        # Non-root
    )
    
    return CheckResult(
        name="sandboxed_build",
        status="pass" if result.exit_code == 0 else "fail",
        output=result.stdout[-2000:],  # Last 2KB of output
    )
```

---

## Merge Gate (No Direct Push)

### Enforcement

In v2, **no agent can push directly to `main`**. All code goes through the merge queue.

### GitHub Branch Protection

The job provisioning step configures branch protection on `main`:

```python
# apps/api/lib/github.py — Enhanced repo provisioning

async def provision_repo(job_id, title):
    # ... create repo (same as v1) ...
    
    # NEW: Set up branch protection
    await github_client.update_branch_protection(
        owner=GITHUB_OWNER,
        repo=repo_name,
        branch="main",
        rules={
            "required_pull_request_reviews": None,  # Not using PRs
            "enforce_admins": True,
            "restrictions": {
                # Only the merge agent's deploy key can push to main
                "users": [],
                "teams": [],
            },
            "allow_force_pushes": False,
            "allow_deletions": False,
        }
    )
```

### Deploy Key Scoping

- **Agent deploy keys**: Read + write to task branches only
- **Merge agent deploy key**: Read + write to all branches including `main`
- **Poster**: Full admin access via personal GitHub token

---

## Implementation Details

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/api/lib/tokens.py` | **NEW** | JWT-based scoped tokens |
| `apps/api/middleware/audit.py` | **NEW** | Audit logging middleware |
| `apps/api/middleware/rate_limit.py` | **NEW** | Rate limiting middleware |
| `apps/api/init.sql` | **MODIFY** | Add `audit_log` table |
| `apps/api/lib/github.py` | **MODIFY** | Branch protection on provisioning |
| `apps/api/main.py` | **MODIFY** | Add middleware |
| `apps/api/auth_dependency.py` | **MODIFY** | Use JWT verification |

### Migration SQL

```sql
CREATE TABLE IF NOT EXISTS audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp       TIMESTAMPTZ DEFAULT now(),
    worker_token    TEXT,
    contributor_id  UUID,
    job_id          UUID NOT NULL,
    role            TEXT,
    action          TEXT NOT NULL,
    resource_type   TEXT,
    resource_id     TEXT,
    request_body    JSONB,
    response_status INT,
    ip_address      TEXT,
    user_agent      TEXT,
    duration_ms     INT
);

CREATE INDEX idx_audit_job ON audit_log(job_id, timestamp);
CREATE INDEX idx_audit_action ON audit_log(action);
CREATE INDEX idx_audit_contributor ON audit_log(contributor_id);
```

### Environment Variables

```bash
# Required for v2 security
JWT_SECRET=<strong-random-secret-at-least-32-chars>
```
