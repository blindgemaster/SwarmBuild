#!/bin/bash
# agent_loop.sh — Runs inside each agent container
#
# This is the core Carlini loop. Each agent runs this independently,
# coordinates with other agents via git file locks.
#
# Args:
#   $1 = AGENT_ID (0, 1, 2, ...)
#   $2 = WORKER_TOKEN (for log relay auth)
#   $3 = RELAY_URL

set -euo pipefail

AGENT_ID=$1
WORKER_TOKEN=$2
RELAY_URL=$3

echo "[agent-$AGENT_ID] Starting loop"

while true; do
    # ── Pull latest from other agents ────────────────────────
    git pull --rebase origin main 2>/dev/null || true

    # ── Check if job is already done ─────────────────────────
    if [ -f "JOB_COMPLETE" ]; then
        echo "[agent-$AGENT_ID] Job complete, exiting"
        exit 0
    fi

    # ── Find and lock a task ──────────────────────────────────
    TASK_FILE=$(find current_tasks/ -name "*.available" 2>/dev/null | shuf | head -1)

    if [ -z "$TASK_FILE" ]; then
        echo "[agent-$AGENT_ID] No available tasks. Waiting..."
        sleep 10
        continue
    fi

    TASK_NAME=$(basename "$TASK_FILE" .available)
    LOCK_FILE="current_tasks/${TASK_NAME}.locked.agent${AGENT_ID}"

    # Try to lock (git-based, collision-safe)
    git mv "$TASK_FILE" "$LOCK_FILE" 2>/dev/null || { sleep 2; continue; }
    git add -A
    git commit -m "agent-$AGENT_ID: lock $TASK_NAME" 2>/dev/null || true

    if ! git push origin main 2>/dev/null; then
        echo "[agent-$AGENT_ID] Lock collision on $TASK_NAME, picking another"
        git reset --hard HEAD~1 2>/dev/null || true
        git checkout -- . 2>/dev/null || true
        sleep 2
        continue
    fi

    echo "[agent-$AGENT_ID] Locked: $TASK_NAME"

    # ── Run Claude on this task ───────────────────────────────
    COMMIT=$(git rev-parse --short HEAD)
    LOGFILE="agent_logs/agent_${AGENT_ID}_${TASK_NAME}_${COMMIT}.log"
    mkdir -p agent_logs

    claude --dangerously-skip-permissions \
           -p "$(cat AGENT_PROMPT.md)

## Your current task
Work on: $TASK_NAME

Check current_tasks/ for other locked tasks so you don't duplicate work.
When done with $TASK_NAME, run the tests, commit, push, and remove the lock file." \
           --model claude-sonnet-4-20250514 \
           2>&1 | tee "$LOGFILE" | \
           while IFS= read -r line; do
               curl -s -X POST \
                   "${RELAY_URL}/api/logs/${WORKER_TOKEN}" \
                   -H "Content-Type: text/plain" \
                   --data-binary "$line" \
                   --max-time 5 2>/dev/null &
           done

    echo "[agent-$AGENT_ID] Claude session ended for $TASK_NAME"

    # ── Run tests ─────────────────────────────────────────────
    echo "[agent-$AGENT_ID] Running tests..."
    ./test_harness/run_tests.sh
    TEST_EXIT=$?

    # ── Commit everything ─────────────────────────────────────
    git add -A
    git commit -m "agent-$AGENT_ID: work on $TASK_NAME (tests: $([ $TEST_EXIT -eq 0 ] && echo PASS || echo FAIL))" 2>/dev/null || true

    # Pull and push (handle concurrent commits)
    for attempt in 1 2 3; do
        git pull --rebase origin main 2>/dev/null || true
        git push origin main 2>/dev/null && break
        sleep $((attempt * 3))
    done

    # ── Unlock the task ───────────────────────────────────────
    if [ -f "$LOCK_FILE" ]; then
        git rm "$LOCK_FILE" 2>/dev/null || true
        git commit -m "agent-$AGENT_ID: unlock $TASK_NAME" 2>/dev/null || true
        git push origin main 2>/dev/null || true
    fi

    # ── Check for completion ──────────────────────────────────
    if [ $TEST_EXIT -eq 0 ]; then
        echo "[agent-$AGENT_ID] ✓ All tests PASS"

        if [ ! -f "JOB_COMPLETE" ]; then
            touch JOB_COMPLETE
            git add JOB_COMPLETE
            git commit -m "agent-$AGENT_ID: JOB_COMPLETE - all tests pass"
            git pull --rebase origin main
            git push origin main
        fi
        exit 0
    fi

    echo "[agent-$AGENT_ID] Tests failing, continuing..."
    sleep 3
done
