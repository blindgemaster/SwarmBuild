# SwarmBuild v2.1 — Part 2 Implementation Tasks

> Fixes for real-world issues found in the first live run. All tasks derived from Engineering Part 2 docs 01-06.

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Completed |

---

## Critical: Auto-Merge Pipeline (Doc 01)

### Task 1: Server-side merge processor — `lib/merge_processor.py`
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Files**: `apps/api/lib/merge_processor.py` — **NEW** — GitHub API merge, background loop every 15s

### Task 2: Integrate merge processor into FastAPI lifespan
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Files**: `apps/api/main.py` — **MODIFY** — Add `merge_processor_loop()` alongside watchdog

---

## Critical: Coordinator Agent (Doc 02)

### Task 3: Coordinator execution loop in orchestrator.js
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Files**: `packages/cli/src/orchestrator.js` — **MODIFY** — Lead with other agents enters coordinator mode (monitor, review, chat) instead of idle polling

### Task 4: Coordinator system prompt in prompts.js
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Files**: `packages/cli/src/runtimes/prompts.js` — **MODIFY** — Add `buildCoordinatorPrompt()` for lead-with-team

---

## Critical: Hot-Join (Doc 03)

### Task 5: Remove lobby_state gate on contributor registration
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Files**: `apps/api/routers/contributors.py` — **MODIFY** — Allow joining during `running` state, auto-ready hot-joiners

### Task 6: Join-info endpoint for role discovery
**Status**: ⬜ Deferred (low priority, hot-join works without it)
**Priority**: 🟡 High
**Files**: `apps/api/routers/jobs.py` — **MODIFY** — Add `GET /api/jobs/{job_id}/join-info` with needed roles + available tasks

### Task 7: CLI hot-join detection — skip lobby wait
**Status**: ✅ Completed
**Priority**: 🔴 Critical
**Files**: `packages/cli/src/orchestrator.js` — **MODIFY** — Detect `executing` state and skip to execution loop

---

## High: Human-Agent Chat Bridge (Doc 04)

### Task 8: Include unread human messages in heartbeat response
**Status**: ✅ Completed
**Priority**: 🟡 High
**Files**: `apps/api/routers/worker.py` — **MODIFY** — Query unread human messages, include in `pending_notifications`

### Task 9: CLI writes human messages to MESSAGES.md
**Status**: ✅ Completed
**Priority**: 🟡 High
**Files**: `packages/cli/src/orchestrator.js` — **MODIFY** — On heartbeat, write human messages to workspace file

### Task 10: Add message-awareness to execution prompts
**Status**: ✅ Completed
**Priority**: 🟡 High
**Files**: `packages/cli/src/runtimes/prompts.js` — **MODIFY** — Tell agents to check MESSAGES.md and read_chat

---

## High: Agent Git Collaboration (Doc 05)

### Task 11: Rebase on main before push in complete_task
**Status**: ✅ Completed
**Priority**: 🟡 High
**Files**: `packages/cli/src/mcp.js` — **MODIFY** — `git fetch origin && git rebase origin/main` before pushing task branch

### Task 12: Include recent commits context in claim_task
**Status**: ✅ Completed
**Priority**: 🟡 High
**Files**: `packages/cli/src/mcp.js` — **MODIFY** — `git log --oneline -10 origin/main` included in claim response

### Task 13: Check merge status in dependency validation
**Status**: ✅ Completed
**Priority**: 🟡 High
**Files**: `apps/api/routers/tasks.py` — **MODIFY** — Block claiming if dependency task is completed but not yet merged

---

## Medium: A2A Testing (Doc 06)

### Task 14: A2A test CLI command
**Status**: ✅ Completed
**Priority**: 🟢 Medium
**Files**: `packages/cli/src/a2a-test.js` — **NEW**, `packages/cli/bin/swarmbuild.js` — **MODIFY**

### Task 15: Fix A2A join_job to create contributor record
**Status**: ✅ Completed
**Priority**: 🟢 Medium
**Files**: `apps/api/routers/a2a.py` — **MODIFY** — Create contributor on join, return worker_token

---

## Implementation Log

| Date | Task | What was done |
|------|------|---------------|
| 2026-03-13 | Task 1 | Created `apps/api/lib/merge_processor.py` — server-side auto-merge via GitHub API (`POST /repos/{owner}/{repo}/merges`), 15s poll loop, no git clone needed |
| 2026-03-13 | Task 2 | Modified `apps/api/main.py` — added `merge_processor_loop()` to lifespan alongside watchdog, with cancel on shutdown |
| 2026-03-13 | Task 3 | Refactored `orchestrator.js` — split execution into `runCoordinatorLoop()` (lead monitors/reviews/responds every 30s) and `runWorkerLoop()` (claim/implement/complete). Lead auto-detects other agents and enters coordinator mode |
| 2026-03-13 | Task 4 | Added `buildCoordinatorPrompt()` to `prompts.js` + new `selectPrompt()` router that picks coordinator mode for lead-with-team. All prompts now include MESSAGES.md awareness |
| 2026-03-13 | Task 5 | Modified `contributors.py` — replaced `status not in (approved, running)` gate with `status in (complete, failed, cancelled)` gate. Hot-joiners on running jobs get auto `is_ready=True` + `contributor_status=active` |
| 2026-03-13 | Task 7 | Modified `orchestrator.js` — checks `lobby_state`/`status` on startup; if job is already running, skips entire lobby flow (planning, ENTER wait, ready-wait) |
| 2026-03-13 | Task 8 | Modified `worker.py` heartbeat — queries `messages` table for `author_type=human` since `last_seen`, appends as `human_message` notifications in heartbeat response |
| 2026-03-13 | Task 9 | Modified `orchestrator.js` heartbeat handler — filters `human_message` notifications, logs to console, appends to `MESSAGES.md` in workspace |
| 2026-03-13 | Task 10 | All execution prompts (solo lead, teammate, coordinator) now include "Check MESSAGES.md" and "Use swarmbuild_read_chat" instructions |
| 2026-03-13 | Task 11 | Modified `mcp.js` complete_task — added `git fetch origin && git rebase origin/main` before push, with abort-on-conflict fallback |
| 2026-03-13 | Task 12 | Modified `mcp.js` claim_task — added `git log --oneline -10 origin/main` and includes `recent_commits` + `context` message in response |
| 2026-03-13 | Task 13 | Modified `tasks.py` claim_task — after checking task status=completed for deps, also queries `merge_queue` to verify merge status is "merged". Blocks if dep is completed but merge pending/conflict |
| 2026-03-13 | Task 14 | Created `packages/cli/src/a2a-test.js` — 5-test suite (Agent Card, list jobs, auth check, unknown method, chat auth). Added `swarmbuild a2a-test` command to `swarmbuild.js` |
| 2026-03-13 | Task 15 | Modified `routers/a2a.py` — added `join_job` handler that creates a real contributor record with synthetic A2A user, returns `worker_token` for authenticated subsequent requests |
