# SwarmBuild v2 — E2E Smoke Test Guide

> Quick verification that all v2 features work end-to-end.

---

## Prerequisites

1. **API server running**: `cd apps/api && uvicorn main:app --reload --port 8000`
2. **Database migrated**: Run `init.sql` then `init_v2.sql` in Supabase SQL editor
3. **CLI linked**: `cd packages/cli && npm link`
4. **Environment**: `GITHUB_TOKEN`, `SUPABASE_URL`, `SUPABASE_KEY` set in `apps/api/.env`

---

## Test 1: Health Check

```bash
curl http://localhost:8000/api/health
# Expected: {"status":"ok","service":"swarmbuild-api"}
```

## Test 2: Heartbeat v2 Response

```bash
# After registering a contributor and getting a worker token:
curl -X POST http://localhost:8000/api/worker/heartbeat/YOUR_TOKEN \
  -H "Content-Type: application/json" \
  -d '{"agents_running":1,"tokens_used":5000,"current_task_id":null,"status":"idle","sessions_run":1,"commits_pushed":0}'
# Expected: {"status":"ok","server_time":"...","should_stop":false,"stop_reason":null,"pending_notifications":[]}
```

## Test 3: Task DAG — Dependency Enforcement

```bash
# Create tasks with dependencies:
curl -X POST http://localhost:8000/api/YOUR_TOKEN/tasks \
  -H "Content-Type: application/json" \
  -d '{"tasks":[{"title":"Setup DB","assigned_role":"lead"},{"title":"Build API","assigned_role":"backend","depends_on":["TASK_A_ID"]}]}'

# Try to claim Task B before Task A is complete:
curl -X POST http://localhost:8000/api/YOUR_TOKEN/tasks/TASK_B_ID/claim
# Expected: 409 {"error":"dependencies_not_met",...}
```

## Test 4: Budget Enforcement

```bash
# Set budget_cap on a job (via Supabase or API), then try to claim when exhausted:
# Expected: 402 {"error":"budget_exhausted",...}
```

## Test 5: Rate Limiting

```bash
# Send 11 rapid claim_task requests within 60 seconds:
# Expected: 429 on the 11th request
```

## Test 6: Merge Queue

```bash
# Enqueue a merge:
curl -X POST http://localhost:8000/api/YOUR_TOKEN/merge/enqueue \
  -H "Content-Type: application/json" \
  -d '{"task_id":"...","branch_name":"task/abc12345"}'
# Expected: {"status":"ok","position":1,"queue_id":"..."}

# View queue:
curl http://localhost:8000/api/JOB_ID/merge/queue
# Expected: {"queue":[...]}
```

## Test 7: Cost Tracking

```bash
curl http://localhost:8000/api/jobs/JOB_ID/costs
# Expected: {"job_id":"...","budget_cap":...,"contributors":[...],"tasks":[...]}
```

## Test 8: A2A Agent Card

```bash
curl http://localhost:8000/api/a2a/.well-known/agent.json
# Expected: {"name":"SwarmBuild","skills":[...],...}
```

## Test 9: A2A Task Send

```bash
curl -X POST http://localhost:8000/api/a2a \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tasks/send","params":{"message":{"role":"user","parts":[{"type":"text","text":"list available jobs"}]}}}'
# Expected: {"jsonrpc":"2.0","result":{"status":{"state":"completed"},...}}
```

## Test 10: SSE Events

```bash
curl -N http://localhost:8000/api/jobs/JOB_ID/events
# Expected: SSE stream with data: {...} frames and : heartbeat comments
```

## Test 11: CLI — Multi-Runtime

```bash
swarmbuild runtimes
# Expected:
# Available runtimes:
#   claude       ✅ MCP   (command: claude)
#   gemini       ✅ MCP   (command: gemini)
#   codex        ⚠️ Bridge   (command: codex)
```

## Test 12: CLI — Graceful Shutdown

```bash
swarmbuild run JOB_ID --role lead --runtime claude
# Press Ctrl+C during execution
# Expected: "🛑 Initiating graceful shutdown..." → releases tasks → pushes WIP branch → "Goodbye! 👋"
```

## Test 13: Audit Log

```bash
# After performing some operations, check the audit_log table in Supabase:
# SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 20;
# Expected: Entries with action, resource_type, response_status, duration_ms
```

---

## Verification Checklist

| # | Feature | Status |
|---|---------|--------|
| 1 | Health check | ⬜ |
| 2 | Heartbeat v2 with should_stop | ⬜ |
| 3 | Task DAG dependency enforcement | ⬜ |
| 4 | Budget enforcement on claim | ⬜ |
| 5 | Rate limiting (429) | ⬜ |
| 6 | Merge queue enqueue/view | ⬜ |
| 7 | Cost tracking endpoint | ⬜ |
| 8 | A2A Agent Card | ⬜ |
| 9 | A2A task/send | ⬜ |
| 10 | SSE events stream | ⬜ |
| 11 | CLI runtimes command | ⬜ |
| 12 | CLI graceful shutdown | ⬜ |
| 13 | Audit log entries | ⬜ |
