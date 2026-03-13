# SwarmBuild v2.1 — The Engineering Part 2

> **Post-launch fixes**: Real-world testing exposed critical gaps between what v2 built and what production needs. This document set addresses every issue found in the first live run.

---

## What Went Wrong in the First Live Run

| Problem | Root Cause | Impact |
|---------|-----------|--------|
| **Lead agent sat idle** while merge PRs piled up | Lead enters a polling loop for `role=lead` tasks but all tasks were `role=frontend` | Lead burned 14 polling cycles doing nothing useful |
| **Merge PRs required manual GitHub merges** | Merge agent exists as code but was never started; no auto-merge flow | User had to click "Merge pull request" 4 times by hand |
| **Users can't join an ongoing job** | Registration requires lobby state `gathering`; once `executing`, no new contributors allowed | A second human who wants to help can't get in |
| **No human-to-agent chat in lobby** | Chat messages go to the DB but agents never read them during execution loop | Users can't talk to the lead agent or give feedback |
| **A2A not testable** | A2A router exists but no CLI/UI test path; no documentation for external agents | Feature is invisible |
| **Agents don't collaborate via GitHub** | Each agent works independently, pushes to a task branch, but never checks what others did | No code awareness between agents |

---

## Lessons from Reference Projects

### Beads (steveyegge/beads)
- **Dependency-aware graph**: Tasks form a DAG with `relates_to`, `duplicates`, `supersedes` links — not just `depends_on`
- **Hash-based IDs**: `bd-a1b2` prevents merge collisions in multi-branch workflows
- **Compaction**: Semantic "memory decay" summarizes old closed tasks to save context window
- **Agent-optimized**: JSON output, auto-ready task detection, designed for AI agents to consume

### Overstory (jayminwest/overstory)
- **Coordinator agent**: A persistent orchestrator that manages dispatch, monitors progress, handles escalation
- **Worktrees**: Each agent gets an isolated git worktree — zero file conflicts
- **Mail system**: Custom SQLite mail with typed protocol (worker_done, merge_ready, dispatch, escalation) — agents talk to each other
- **FIFO merge queue**: SQLite-backed with 4-tier conflict resolution — **fully automated, no human clicks**
- **Watchdog tiers**: Tier 0 mechanical daemon, Tier 1 AI-assisted triage, Tier 2 monitor agent
- **Hierarchical delegation**: Orchestrator → Team Lead → Specialist Workers (depth-limited)

---

## What We're Building in Part 2

| # | Document | Problem Solved |
|---|----------|----------------|
| 01 | [Auto-Merge Pipeline](./01-AUTO-MERGE-PIPELINE.md) | Merge PRs sit unmerged — need fully automated merge flow |
| 02 | [Coordinator Agent](./02-COORDINATOR-AGENT.md) | Lead agent sits idle — need an always-on coordinator that dispatches, monitors, merges |
| 03 | [Hot-Join & Dynamic Teams](./03-HOT-JOIN.md) | Can't join running jobs — need hot-join with role discovery |
| 04 | [Human-Agent Chat Bridge](./04-HUMAN-AGENT-CHAT.md) | Users can't talk to agents — need bidirectional chat in lobby |
| 05 | [Agent Collaboration via Git](./05-AGENT-GIT-COLLAB.md) | Agents don't know what others did — need git-aware context sharing |
| 06 | [A2A Testing & Demo](./06-A2A-TESTING.md) | A2A is untestable — need a demo flow + test harness |

---

## Priority Order

```
CRITICAL (blocks basic usage):
  01 — Auto-Merge Pipeline (merge PRs without human clicks)
  02 — Coordinator Agent (lead agent does useful work)
  03 — Hot-Join (users can join running jobs)

HIGH (quality of collaboration):
  04 — Human-Agent Chat Bridge
  05 — Agent Git Collaboration

MEDIUM (showcase feature):
  06 — A2A Testing & Demo
```
