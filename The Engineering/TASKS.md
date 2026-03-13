# SwarmBuild v2 — Implementation Tasks

> Auto-generated task tracker from engineering docs 00-10. Updated after each task is completed.

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Completed |
| ⏸️ | Blocked |

---

## Phase 1: Reliability Foundation (Critical)

### Task 1: Database Migration v2 — `init_v2.sql`
**Status**: ✅ Completed
**Priority**: 🔴 Critical (all other tasks depend on this)
**Reference**: [10-DATABASE-SCHEMA.md](./10-DATABASE-SCHEMA.md)
**Files**:
- `apps/api/init_v2.sql` — **NEW** — v2 migration script

**Subtasks**:
- 1.1: Add budget columns to `jobs` table (`budget_cap`, `budget_warning_pct`, `budget_used`, `min_verification_tier`)
- 1.2: Add lifecycle columns to `contributors` table (`contributor_status`, `current_task_id`, `sessions_run`, `commits_pushed`, `tasks_completed`)
- 1.3: Add DAG columns to `tasks` table (`depends_on`, `parallel_group`, `estimated_duration`)
- 1.4: Add verification columns to `tasks` table (`verification_tier`, `verification_status`, `verification_log`)
- 1.5: Create `task_attempts` table
- 1.6: Create `merge_queue` table
- 1.7: Create `audit_log` table
- 1.8: Create all indexes

**Completed**: —
**Notes**: —

---

### Task 2: Enhanced Heartbeat v2 — `worker.py`
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Reference**: [01-FAULT-TOLERANCE.md](./01-FAULT-TOLERANCE.md) §Heartbeat System
**Files**:
- `apps/api/routers/worker.py` — **MODIFY** — Upgrade `HeartbeatRequest` to v2 with `current_task_id`, `status`, `sessions_run`, `commits_pushed`; return `should_stop`, `stop_reason`, `server_time`, `pending_notifications`

**Subtasks**:
- 2.1: Create `HeartbeatRequestV2` model with all new fields
- 2.2: Create `HeartbeatResponseV2` with `should_stop`, `stop_reason`, `server_time`
- 2.3: Update heartbeat handler to save `contributor_status`, `current_task_id`
- 2.4: Add budget exhaustion check in heartbeat response
- 2.5: Add job cancellation/completion check
- 2.6: Add token expiry warning (5 min before)

**Completed**: —
**Notes**: —

---

### Task 3: Watchdog Service — `lib/watchdog.py`
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Reference**: [01-FAULT-TOLERANCE.md](./01-FAULT-TOLERANCE.md) §Watchdog Service
**Files**:
- `apps/api/lib/watchdog.py` — **NEW** — Background task with state machine

**Subtasks**:
- 3.1: Define thresholds (`STALE_THRESHOLD=2min`, `DISCONNECTED_THRESHOLD=5min`, `LEFT_THRESHOLD=15min`)
- 3.2: Implement `watchdog_tick()` — scan active/stale contributors
- 3.3: Implement active→stale transition (broadcast warning)
- 3.4: Implement stale→disconnected transition (release locked tasks, record task_attempts)
- 3.5: Implement disconnected→left transition (full cleanup)
- 3.6: Implement `watchdog_loop()` with 60s interval and startup delay (120s)

**Completed**: —
**Notes**: —

---

### Task 4: Integrate Watchdog into FastAPI Lifespan — `main.py`
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Reference**: [01-FAULT-TOLERANCE.md](./01-FAULT-TOLERANCE.md) §Integration with FastAPI Lifespan
**Files**:
- `apps/api/main.py` — **MODIFY** — Start/cancel watchdog background task in lifespan

**Subtasks**:
- 4.1: Import `watchdog_loop` from `lib.watchdog`
- 4.2: Create `asyncio.create_task(watchdog_loop())` in lifespan startup
- 4.3: Cancel watchdog task on shutdown

**Completed**: —
**Notes**: Depends on Task 3.

---

### Task 5: Task Attempts Tracking — `tasks.py`
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Reference**: [01-FAULT-TOLERANCE.md](./01-FAULT-TOLERANCE.md) §Task Recovery & Reassignment
**Files**:
- `apps/api/routers/tasks.py` — **MODIFY** — Record attempts on claim/complete

**Subtasks**:
- 5.1: On `claim_task`: insert a `task_attempts` row with `outcome='in_progress'`
- 5.2: On `complete_task`: update the task_attempt row with `outcome='completed'` and `ended_at`
- 5.3: On `complete_task` with `status='failed'`: update attempt with `outcome='failed'`
- 5.4: Add `GET /{token}/tasks/{task_id}/attempts` endpoint to retrieve attempt history
- 5.5: Include `previous_attempts` data in claim response

**Completed**: —
**Notes**: Depends on Task 1 (task_attempts table).

---

### Task 6: Release-All Endpoint — Graceful Shutdown Support
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Reference**: [01-FAULT-TOLERANCE.md](./01-FAULT-TOLERANCE.md) §Graceful Shutdown Protocol
**Files**:
- `apps/api/routers/tasks.py` — **MODIFY** — Add `POST /{token}/tasks/release-all`

**Subtasks**:
- 6.1: Implement `release_all_tasks` endpoint — release all tasks locked by token
- 6.2: Record `task_attempts` with `outcome='manually_released'` for each released task
- 6.3: Broadcast `task_updated` event after release

**Completed**: —
**Notes**: Depends on Task 1.

---

### Task 7: DAG Engine — `lib/dag.py` + Task Dependency Checks
**Status**: ✅ Completed
**Priority**: 🟡 High
**Reference**: [05-TASK-DAG.md](./05-TASK-DAG.md)
**Files**:
- `apps/api/lib/dag.py` — **NEW** — Circular dependency detection + validation
- `apps/api/routers/tasks.py` — **MODIFY** — Dependency check on claim, dependency validation on create

**Subtasks**:
- 7.1: Implement `detect_circular_dependencies(tasks)` using DFS cycle detection
- 7.2: Implement `validate_task_dependencies(new_tasks, existing_tasks)`
- 7.3: Modify `create_tasks` to accept `depends_on` field and validate DAG
- 7.4: Modify `claim_task` to check all dependencies are `completed`
- 7.5: Modify `get_tasks` to return `is_claimable` and `blocking_tasks` per task
- 7.6: Implement `compute_task_priority` scoring function

**Completed**: —
**Notes**: Depends on Task 1 (`depends_on` column).

---

### Task 8: Budget Enforcement
**Status**: ✅ Completed
**Priority**: 🟡 High
**Reference**: [08-COST-TRACKING.md](./08-COST-TRACKING.md) §Budget Enforcement
**Files**:
- `apps/api/routers/tasks.py` — **MODIFY** — Budget check on claim
- `apps/api/routers/worker.py` — **MODIFY** — Budget check in heartbeat response

**Subtasks**:
- 8.1: Add budget check in `claim_task` — reject if `budget_used >= budget_cap`
- 8.2: Add budget update in heartbeat — compute total tokens, update `jobs.budget_used`
- 8.3: Add budget warning notifications at 80% and 90% thresholds
- 8.4: Set `should_stop=True` when budget exhausted

**Completed**: —
**Notes**: Depends on Task 1 (budget columns) and Task 2 (enhanced heartbeat).

---

### Task 9: Audit Logging — `middleware/audit.py`
**Status**: ✅ Completed
**Priority**: 🟡 High
**Reference**: [09-SECURITY.md](./09-SECURITY.md) §Audit Logging
**Files**:
- `apps/api/middleware/__init__.py` — **NEW**
- `apps/api/middleware/audit.py` — **NEW** — Audit middleware
- `apps/api/main.py` — **MODIFY** — Add audit middleware

**Subtasks**:
- 9.1: Create `middleware/` directory with `__init__.py`
- 9.2: Implement `audit_middleware` — log action, resource, status, timing
- 9.3: Implement helper functions (`should_audit`, `extract_action`, `hash_token`)
- 9.4: Add middleware to FastAPI app in `main.py`

**Completed**: —
**Notes**: Depends on Task 1 (audit_log table).

---

### Task 10: Rate Limiting — `middleware/rate_limit.py`
**Status**: ✅ Completed
**Priority**: 🟡 High
**Reference**: [09-SECURITY.md](./09-SECURITY.md) §Rate Limiting
**Files**:
- `apps/api/middleware/rate_limit.py` — **NEW**
- `apps/api/main.py` — **MODIFY** — Add rate limiting middleware

**Subtasks**:
- 10.1: Define `RATE_LIMITS` dict per action type
- 10.2: Implement `check_rate_limit(token, action)` — in-memory with sliding window
- 10.3: Implement rate limit middleware for FastAPI
- 10.4: Add middleware to `main.py`

**Completed**: —
**Notes**: In-memory for now; Redis-backed in Phase 2.

---

## Phase 2: Merge & Verification

### Task 11: Merge Queue Router — `routers/merge.py`
**Status**: ✅ Completed
**Priority**: 🟡 High
**Reference**: [02-MERGE-RESOLUTION.md](./02-MERGE-RESOLUTION.md)
**Files**:
- `apps/api/routers/merge.py` — **NEW**
- `apps/api/main.py` — **MODIFY** — Mount merge router

**Subtasks**:
- 11.1: Implement `POST /{token}/merge/enqueue` — add to merge queue
- 11.2: Implement `GET /{job_id}/merge/queue` — view merge queue
- 11.3: Implement `POST /{job_id}/merge/{queue_id}/resolve` — human resolves conflict
- 11.4: Mount router in `main.py`

**Completed**: —
**Notes**: Depends on Task 1 (merge_queue table).

---

### Task 12: Cost Tracking Endpoint — `routers/costs.py`
**Status**: ✅ Completed
**Priority**: 🟡 High
**Reference**: [08-COST-TRACKING.md](./08-COST-TRACKING.md) §Cost Dashboard
**Files**:
- `apps/api/routers/costs.py` — **NEW**
- `apps/api/main.py` — **MODIFY** — Mount costs router

**Subtasks**:
- 12.1: Implement `GET /api/jobs/{job_id}/costs` — per-agent + per-task breakdown
- 12.2: Compute estimated USD cost based on token pricing
- 12.3: Mount router in `main.py`

**Completed**: —
**Notes**: Depends on Task 1 (budget columns, task_attempts.tokens_used).

---

### Task 13: Verification Engine — `lib/verify.py` + `routers/verification.py`
**Status**: ✅ Completed
**Priority**: 🟢 Medium
**Reference**: [06-VERIFICATION.md](./06-VERIFICATION.md)
**Files**:
- `apps/api/lib/verify.py` — **NEW** — Tier 1 automated build checks
- `apps/api/routers/verification.py` — **NEW** — Review/approve/reject endpoints
- `apps/api/routers/tasks.py` — **MODIFY** — `complete_task` triggers verification pipeline
- `apps/api/main.py` — **MODIFY** — Mount verification router

**Subtasks**:
- 13.1: Implement `CheckResult` and `VerificationReport` dataclasses
- 13.2: Implement `run_tier1_verification` with Node.js and Python checks
- 13.3: Implement `detect_project_type` helper
- 13.4: Create verification router with `POST /{job_id}/tasks/{task_id}/review` for human gate
- 13.5: Implement reviewer selection logic
- 13.6: Modify `complete_task` to set `verification_status='pending'` when tier > 0
- 13.7: Mount router in `main.py`

**Completed**: —
**Notes**: Depends on Task 1 (verification columns).

---

### Task 14: SSE Fallback Events — `routers/events.py`
**Status**: ✅ Completed
**Priority**: 🟢 Medium
**Reference**: [07-REALTIME-INFRA.md](./07-REALTIME-INFRA.md) §SSE Fallback Channel
**Files**:
- `apps/api/routers/events.py` — **NEW** — SSE endpoint
- `apps/api/main.py` — **MODIFY** — Mount events router

**Subtasks**:
- 14.1: Implement `GET /api/jobs/{job_id}/events` — SSE streaming endpoint
- 14.2: Add heartbeat keepalive every 15s
- 14.3: Mount router in `main.py`

**Completed**: —
**Notes**: Full Redis pub/sub is a later upgrade; this provides the SSE endpoint shape.

---

## Phase 3: CLI v2 Upgrades (Critical)

### Task 15: New API Methods in `api.js`
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Reference**: [01-FAULT-TOLERANCE.md](./01-FAULT-TOLERANCE.md), [02-MERGE-RESOLUTION.md](./02-MERGE-RESOLUTION.md)
**Files**:
- `packages/cli/src/api.js` — **MODIFY** — Add `heartbeat()`, `releaseAllMyTasks()`, `enqueueMerge()`, `getTaskAttempts()`, enhanced `completeTask()` with `tokens_used`

---

### Task 16: Heartbeat Loop + Graceful Shutdown in `orchestrator.js`
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Reference**: [01-FAULT-TOLERANCE.md](./01-FAULT-TOLERANCE.md) §Heartbeat, §Graceful Shutdown
**Files**:
- `packages/cli/src/orchestrator.js` — **MODIFY** — 30s heartbeat interval, SIGINT/SIGTERM handlers, `gracefulShutdown()`, `should_stop` response handling

---

### Task 17: Branch-Per-Task Git Flow in `mcp.js`
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Reference**: [02-MERGE-RESOLUTION.md](./02-MERGE-RESOLUTION.md) §Branch-Per-Task
**Files**:
- `packages/cli/src/mcp.js` — **MODIFY** — On claim: create `task/{id}` branch from main. On complete: push to task branch + enqueue merge (not push to main)

---

### Task 18: Enhanced `create_tasks` + `get_tasks` in `mcp.js`
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Reference**: [05-TASK-DAG.md](./05-TASK-DAG.md)
**Files**:
- `packages/cli/src/mcp.js` — **MODIFY** — `create_tasks` schema adds `depends_on`, `parallel_group`, `estimated_duration`. `get_tasks` displays claimable/blocked/in-progress/completed groups.

---

### Task 19: Per-Task Token Tracking in `mcp.js`
**Status**: ✅ Completed
**Priority**: 🟡 High
**Reference**: [08-COST-TRACKING.md](./08-COST-TRACKING.md)
**Files**:
- `packages/cli/src/mcp.js` — **MODIFY** — Track `taskStartTokens` on claim, compute delta on complete, send `tokens_used` in completeTask

---

### Task 20: `--runtime` CLI Flag + `runtimes` Command
**Status**: ✅ Completed
**Priority**: 🟡 High
**Reference**: [03-MULTI-RUNTIME.md](./03-MULTI-RUNTIME.md) §CLI Changes
**Files**:
- `packages/cli/bin/swarmbuild.js` — **MODIFY** — Add `--runtime` option, `runtimes` command

---

### Task 21: Runtime Adapter System (`runtimes/`)
**Status**: ✅ Completed
**Priority**: 🟡 High
**Reference**: [03-MULTI-RUNTIME.md](./03-MULTI-RUNTIME.md)
**Files**:
- `packages/cli/src/runtimes/types.js` — **NEW** — AgentRuntime base class
- `packages/cli/src/runtimes/claude.js` — **NEW** — Claude Code adapter
- `packages/cli/src/runtimes/gemini.js` — **NEW** — Gemini CLI adapter
- `packages/cli/src/runtimes/codex.js` — **NEW** — Codex CLI adapter
- `packages/cli/src/runtimes/index.js` — **NEW** — Registry + `getRuntime()`
- `packages/cli/src/runtimes/prompts.js` — **NEW** — Prompt translation layer
- `packages/cli/src/orchestrator.js` — **MODIFY** — Use `runtime.spawn()` instead of hardcoded `spawn("claude", ...)`

---

## Phase 4: Merge Agent, A2A, Infrastructure, Web UI

### Task 22: Merge Agent CLI — `merge-agent.js`
**Status**: ✅ Completed
**Files**: `packages/cli/src/merge-agent.js` — **NEW** — Dedicated merge agent that polls queue, attempts tiered merge (Tier 0 FF, Tier 1 auto-merge, Tier 3 human review)

---

### Task 23: Merge-Agent CLI Command
**Status**: ✅ Completed
**Files**: `packages/cli/bin/swarmbuild.js` — **MODIFY** — `swarmbuild merge-agent <job_id>` command

---

### Task 24: Prompt Translation Layer — `runtimes/prompts.js`
**Status**: ✅ Completed
**Files**: `packages/cli/src/runtimes/prompts.js` — **NEW** — `buildPrompt(runtime, context)` with v2 tool descriptions (branch-per-task, depends_on, etc.)

---

### Task 25: A2A Gateway Router — `routers/a2a.py`
**Status**: ✅ Completed
**Files**: `apps/api/routers/a2a.py` — **NEW** — JSON-RPC 2.0 endpoint at `/api/a2a`, handles `tasks/send`, `tasks/get`, `tasks/cancel`. Mounted in main.py

---

### Task 26: A2A Translator — `lib/a2a_translator.py`
**Status**: ✅ Completed
**Files**: `apps/api/lib/a2a_translator.py` — **NEW** — Intent parsing from A2A message parts, response formatting, status mapping

---

### Task 27: Agent Card Endpoint
**Status**: ✅ Completed
**Files**: Included in `routers/a2a.py` — `GET /api/a2a/.well-known/agent.json` with skills, capabilities, auth info

---

### Task 28: JWT Scoped Tokens — `lib/tokens.py`
**Status**: ✅ Completed
**Files**: `apps/api/lib/tokens.py` — **NEW** — `create_worker_token()`, `verify_worker_token()`, `require_permission()`, role-based permission sets

---

### Task 29: GitHub Branch Protection on Provisioning
**Status**: ✅ Completed
**Files**: `apps/api/lib/github.py` — **MODIFY** — `edit_protection()` on main branch after repo creation (non-fatal on free plans)

---

### Task 30: CostDashboard Web Component
**Status**: ✅ Completed
**Files**: `apps/web/app/components/CostDashboard.tsx` — **NEW** — Budget bar, per-agent table, per-task token breakdown, auto-refresh

---

### Task 31: ReviewPanel Web Component
**Status**: ✅ Completed
**Files**: `apps/web/app/components/ReviewPanel.tsx` — **NEW** — Pending review list, approve/reject buttons, comments, verification log

---

### Task 32: MergeQueue Web Component
**Status**: ✅ Completed
**Files**: `apps/web/app/components/MergeQueue.tsx` — **NEW** — Queue position list, status badges, conflict tier info, file stats

---

### Task 33: AuditLog Web Component
**Status**: ✅ Completed
**Files**: `apps/web/app/components/AuditLog.tsx` — **NEW** — Table with time, agent, action, resource, status code, duration

---

### Task 34: ReconnectingWebSocket Client
**Status**: ✅ Completed
**Files**: `apps/web/lib/ws-client.ts` — **NEW** — Auto-reconnect with exponential backoff, sequence tracking for replay

---

### Task 35: Updated System Prompts (buildPrompt integration)
**Status**: ✅ Completed
**Files**: `packages/cli/src/orchestrator.js` — **MODIFY** — Replaced 80+ lines of hardcoded prompts with `buildPrompt(runtime, context)` call

---

### Task 36: Update requirements.txt with PyJWT
**Status**: ✅ Completed
**Files**: `apps/api/requirements.txt` — **MODIFY** — Added `PyJWT==2.9.0`

---

### Task 37: .gitignore Entries for Runtime MCP Configs
**Status**: ✅ Completed
**Files**: `packages/cli/src/orchestrator.js` — **MODIFY** — Added `gemini_mcp.json`, `codex_mcp.json`, `*_mcp.json` to workspace .gitignore template

---

### Task 38: E2E Smoke Test Documentation
**Status**: ✅ Completed
**Files**: `The Engineering/SMOKE-TEST.md` — **NEW** — 13 smoke tests covering health, heartbeat, DAG, budget, rate limit, merge, costs, A2A, SSE, CLI, audit

---

## Implementation Log

| Date | Task | What was done |
|------|------|---------------|
| 2026-03-13 | Task 1 | Created `apps/api/init_v2.sql` — full v2 migration: jobs budget cols, contributors lifecycle cols, tasks DAG + verification cols, task_attempts table, merge_queue table, audit_log table, all indexes |
| 2026-03-13 | Task 2 | Enhanced `apps/api/routers/worker.py` — HeartbeatRequest v2 with `current_task_id`, `status`, `sessions_run`, `commits_pushed`; response now returns `should_stop`, `stop_reason`, `server_time`, `pending_notifications`; budget/job-status/token-expiry checks |
| 2026-03-13 | Task 3 | Created `apps/api/lib/watchdog.py` — background watchdog with state machine (active→stale→disconnected→left), auto-releases locked tasks, broadcasts status, detects stalled jobs |
| 2026-03-13 | Task 4 | Modified `apps/api/main.py` — watchdog_loop started as asyncio.create_task in lifespan, cancelled on shutdown |
| 2026-03-13 | Task 5 | Modified `apps/api/routers/tasks.py` — task_attempts row on claim (in_progress), updated on complete (completed/failed with tokens_used), previous_attempts returned in claim response, new GET attempts endpoint |
| 2026-03-13 | Task 6 | Added `POST /{token}/tasks/release-all` to `tasks.py` — releases all locked tasks, records manually_released attempts, broadcasts update |
| 2026-03-13 | Task 7 | Created `apps/api/lib/dag.py` — DFS cycle detection, dependency validation, priority scoring, task enrichment. Modified tasks.py: TaskCreate accepts depends_on/parallel_group/estimated_duration, DAG validation on create, dependency check on claim, enriched get_tasks with is_claimable/blocking_tasks/priority_score |
| 2026-03-13 | Task 8 | Added budget check to claim_task (402 if budget_used >= budget_cap). Heartbeat already had budget checks from Task 2 |
| 2026-03-13 | Task 9 | Created `apps/api/middleware/audit.py` — AuditMiddleware logs all worker API actions to audit_log table with hashed tokens, action classification, timing. Added to main.py |
| 2026-03-13 | Task 10 | Created `apps/api/middleware/rate_limit.py` — RateLimitMiddleware with per-token sliding window limits per action type. Added to main.py |
| 2026-03-13 | Task 11 | Created `apps/api/routers/merge.py` — enqueue, get queue, get next pending, update status, resolve conflict endpoints. Mounted in main.py |
| 2026-03-13 | Task 12 | Created `apps/api/routers/costs.py` — GET /api/jobs/{job_id}/costs with per-contributor and per-task token/cost breakdown, estimated USD. Mounted in main.py |
| 2026-03-13 | Task 13 | Created `apps/api/lib/verify.py` — Tier 1 automated checks (node + python), project detection, reviewer selection. Created `apps/api/routers/verification.py` — get status, human/peer review, pending-review list. Mounted in main.py |
| 2026-03-13 | Task 14 | Created `apps/api/routers/events.py` — SSE endpoint at GET /api/jobs/{job_id}/events with polling for tasks/messages/contributors, 15s heartbeat keepalive. Mounted in main.py |
| 2026-03-13 | Task 15 | Enhanced `packages/cli/src/api.js` — Added `heartbeat()`, `releaseAllMyTasks()`, `workerComplete()`, `enqueueMerge()`, `getTaskAttempts()`. Enhanced `completeTask()` to accept `tokensUsed` param |
| 2026-03-13 | Task 16 | Enhanced `packages/cli/src/orchestrator.js` — Added 30s heartbeat loop (`startHeartbeat`/`stopHeartbeat`), graceful shutdown with SIGINT/SIGTERM/uncaughtException handlers, `gracefulShutdown()` releases tasks + pushes WIP branch + notifies server, `should_stop` response handling, session/token tracking |
| 2026-03-13 | Task 17 | Rewrote `mcp.js` `claim_task` handler — creates `task/{id}` branch from latest main. Rewrote `complete_task` handler — pushes to task branch via `pushToRemote()` helper + enqueues merge via `api.enqueueMerge()`. No more direct push to main |
| 2026-03-13 | Task 18 | Enhanced `mcp.js` `create_tasks` schema — added `depends_on`, `parallel_group`, `estimated_duration` fields. Enhanced `get_tasks` display — groups tasks by claimable/blocked/in-progress/completed with priority scores |
| 2026-03-13 | Task 19 | Added per-task token tracking in `mcp.js` — `taskStartTokens` recorded on claim, delta computed on complete, `tokens_used` sent to `completeTask()` |
| 2026-03-13 | Task 20 | Added `--runtime <name>` option to `swarmbuild run` command and `swarmbuild runtimes` command in `bin/swarmbuild.js` |
| 2026-03-13 | Task 21 | Created full runtime adapter system: `runtimes/types.js` (AgentRuntime base class), `runtimes/claude.js`, `runtimes/gemini.js`, `runtimes/codex.js`, `runtimes/index.js` (registry). Refactored `orchestrator.js` `startAgentInteractive()` to use `runtime.buildMCPConfig()`, `runtime.spawn()`, `runtime.parseOutput()` instead of hardcoded Claude |
| 2026-03-13 | Task 22 | Created `packages/cli/src/merge-agent.js` — dedicated merge agent polling queue every 10s, tiered merge (Tier 0 FF, Tier 1 auto-merge, Tier 3 human review), repo clone/update, push via token or SSH |
| 2026-03-13 | Task 23 | Added `swarmbuild merge-agent <job_id>` command to `bin/swarmbuild.js` |
| 2026-03-13 | Task 24 | Created `packages/cli/src/runtimes/prompts.js` — `buildPrompt()` with v2 tool descriptions (branch-per-task, depends_on, claimable/blocked groups) |
| 2026-03-13 | Task 25 | Created `apps/api/routers/a2a.py` — A2A JSON-RPC gateway with `tasks/send`, `tasks/get`, `tasks/cancel` handlers, intent-based routing (list-jobs, join, claim, complete, chat). Mounted at `/api/a2a` |
| 2026-03-13 | Task 26 | Created `apps/api/lib/a2a_translator.py` — intent parsing from message parts, UUID/role extraction, A2A response formatting, status mapping |
| 2026-03-13 | Task 27 | Agent Card endpoint included in `a2a.py` at `GET /api/a2a/.well-known/agent.json` with 6 skills, auth info, capabilities |
| 2026-03-13 | Task 28 | Created `apps/api/lib/tokens.py` — JWT worker tokens with role-based permissions, backward-compat with v1 `wt_` tokens, `require_permission()` guard |
| 2026-03-13 | Task 29 | Modified `apps/api/lib/github.py` — added `branch.edit_protection()` on main after repo creation (non-fatal on free plans) |
| 2026-03-13 | Task 30 | Created `apps/web/app/components/CostDashboard.tsx` — budget bar with color thresholds, per-agent table, per-task token breakdown, 30s auto-refresh |
| 2026-03-13 | Task 31 | Created `apps/web/app/components/ReviewPanel.tsx` — pending review list with approve/reject, comments textarea, verification log display |
| 2026-03-13 | Task 32 | Created `apps/web/app/components/MergeQueue.tsx` — queue position list, status badges (pending/processing/merged/conflict), file change stats |
| 2026-03-13 | Task 33 | Created `apps/web/app/components/AuditLog.tsx` — audit table with time, agent role, action, resource ID, HTTP status, duration |
| 2026-03-13 | Task 34 | Created `apps/web/lib/ws-client.ts` — ReconnectingWebSocket with exponential backoff, sequence tracking for event replay |
| 2026-03-13 | Task 35 | Replaced 80+ lines of hardcoded prompts in `orchestrator.js` with single `buildPrompt(runtime, context)` call from `runtimes/prompts.js` |
| 2026-03-13 | Task 36 | Added `PyJWT==2.9.0` to `apps/api/requirements.txt` |
| 2026-03-13 | Task 37 | Added `gemini_mcp.json`, `codex_mcp.json`, `*_mcp.json` to workspace .gitignore template in `orchestrator.js` |
| 2026-03-13 | Task 38 | Created `The Engineering/SMOKE-TEST.md` — 13 E2E smoke tests with curl commands and verification checklist |
| 2026-03-13 | Task 39 | Added `GET /api/jobs/{job_id}/audit` endpoint to `routers/costs.py` — returns audit_log entries for AuditLog web component |
| 2026-03-13 | Task 40 | Updated `apps/web/app/components/TaskBoard.tsx` — 4-column Kanban (Ready/Blocked/In Progress/Done), TaskCard shows lock icon + blocking task names for blocked deps, verification status badge |
| 2026-03-13 | Task 41 | Wired v2 components into `apps/web/app/job/[id]/page.tsx` — execution tab now includes ReviewPanel + MergeQueue, new "Costs" tab with CostDashboard + AuditLog |

