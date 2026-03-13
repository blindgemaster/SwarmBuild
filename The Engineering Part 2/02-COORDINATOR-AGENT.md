# 02 — Coordinator Agent

> **Problem**: In the first live run, the lead agent created 5 tasks assigned to `frontend`, then entered a polling loop printing "No pending tasks for role 'lead'" every 10 seconds for 14 cycles. It did nothing useful while the frontend agent did all the work. The lead should be an active coordinator — dispatching, monitoring progress, reviewing, and merging.

---

## Root Cause Analysis

The v2 orchestrator has a fundamental flaw in the execution loop:

```javascript
// Current behavior:
const myRoleTasks = isSoloLead ? pendingTasks : pendingTasks.filter(t => t.assigned_role === role);
if (myRoleTasks.length === 0) {
    console.log("No pending tasks for role 'lead'. Sleeping...");
    await new Promise(r => setTimeout(r, 10000));
    continue;
}
```

When the lead creates tasks assigned to other roles, it has **nothing to do**. It should be:
1. **Monitoring** other agents' progress
2. **Reviewing** completed tasks (Tier 2 peer review)
3. **Helping** agents that are stuck (via chat)
4. **Claiming** any unassigned or cross-role tasks when idle
5. **Reading** human chat messages and responding

### What Overstory Does

Overstory's **coordinator** is a persistent session that:
- Receives `worker_done` messages and triggers merge
- Receives `escalation` messages when workers are stuck
- Dispatches new work via `ov sling`
- Runs `ov mail check --inject` on every prompt to see agent messages
- Can be talked to by humans directly

**Key insight**: The lead agent should have a **different execution loop** than worker agents. It shouldn't try to claim tasks — it should coordinate.

---

## Design: Lead Agent Coordinator Mode

### Two Execution Modes

```
Worker Agent (backend, frontend, etc.):
  Loop: get_tasks → claim → implement → complete → repeat

Lead/Coordinator Agent:
  Loop: check_progress → review_completed → read_chat → respond → help_stuck → repeat
```

### Coordinator System Prompt

The lead agent in coordinator mode gets a fundamentally different prompt:

```markdown
# Swarmbuild — Coordinator Mode

## Your Role
You are the **COORDINATOR** for this job. You do NOT implement tasks yourself.
Your job is to monitor, review, and help.

## Every Cycle, Do This:
1. Use swarmbuild_get_tasks to check progress
2. If tasks are completed → review them (check the code looks correct)
3. Use swarmbuild_read_chat to check for human messages → respond if needed
4. If agents seem stuck (task locked for too long) → send encouragement/help via chat
5. If all tasks are done → send a summary message to chat

## When to Claim Tasks Yourself:
- ONLY if you are the sole agent (solo lead)
- OR if a task has been available for >5 minutes and no agent claims it

## Available Tools
- swarmbuild_get_tasks — Monitor all task progress
- swarmbuild_read_chat — Read messages from humans and agents
- swarmbuild_send_message — Send guidance, reviews, or status updates
- swarmbuild_claim_task — Only use if you're solo or tasks are orphaned
- swarmbuild_complete_task — Only if you personally implemented something
```

### Coordinator Execution Loop in orchestrator.js

```javascript
// New coordinator loop — replaces the idle polling for lead agents
async function runCoordinatorLoop(api, role, jobInfo, WORKSPACE, runtimeName) {
    console.log("[swarmbuild] Lead entering COORDINATOR mode...");
    
    while (true) {
        const tasks = await api.getTasks();
        const pending = tasks.filter(t => t.status === "available" || t.status === "locked");
        
        if (pending.length === 0 && tasks.length > 0) {
            console.log("[swarmbuild] 🎉 All tasks complete!");
            break;
        }
        
        // Check if there's actual coordination work to do
        const completed = tasks.filter(t => t.status === "completed");
        const hasNewCompletions = /* track since last check */;
        const hasUnreadChat = /* check messages */;
        
        if (hasNewCompletions || hasUnreadChat || /* periodic check */) {
            // Spawn a short coordinator session
            sessionCount++;
            await startAgentInteractive(api, role, jobInfo, false, WORKSPACE, runtimeName);
        }
        
        // Don't spam — check every 30 seconds
        await new Promise(r => setTimeout(r, 30_000));
    }
}
```

### Solo Lead Detection

When the lead is the **only** agent (solo mode), it should still claim and implement tasks directly. The coordinator mode only activates when there are other agents:

```javascript
const hasOtherAgents = contributors.filter(c => 
    c.role !== "lead" && c.contributor_status === "active"
).length > 0;

if (role === "lead" && hasOtherAgents) {
    await runCoordinatorLoop(api, role, jobInfo, WORKSPACE, runtimeName);
} else {
    // Normal execution loop (existing behavior)
    await runWorkerLoop(api, role, jobInfo, WORKSPACE, runtimeName);
}
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/src/orchestrator.js` | **MODIFY** | Add coordinator loop for lead agents with other contributors |
| `packages/cli/src/runtimes/prompts.js` | **MODIFY** | Add coordinator-mode prompt |
