# 11 — Research Notes

> Detailed analysis of every reference project studied for SwarmBuild v2. What we learned, what we adopted, and what we deliberately skipped.

---

## Table of Contents

1. [Overstory](#overstory)
2. [OpenAgents](#openagents)
3. [A2A Protocol](#a2a-protocol)
4. [Agent Network Protocol (ANP)](#agent-network-protocol-anp)
5. [Overstory STEELMAN — Risk Analysis](#overstory-steelman)
6. [Competitive Landscape](#competitive-landscape)

---

## Overstory

**Repo**: [jayminwest/overstory](https://github.com/jayminwest/overstory)
**Tagline**: Multi-agent orchestration for AI coding agents — pluggable runtime adapters for Claude Code, Pi, and more.

### Architecture Summary

Overstory is a **local-only** multi-agent orchestrator. It runs on a single machine, using tmux sessions for isolation and git worktrees for parallel code editing. All coordination happens through a local SQLite database (mail system).

```
Overstory Architecture:
  Orchestrator (multi-repo coordinator of coordinators)
    └── Coordinator (persistent orchestrator at project root)
          └── Supervisor / Lead (team lead, depth 1)
                └── Workers: Scout, Builder, Reviewer, Merger (depth 2)
```

### Key Innovations

| Feature | How It Works | SwarmBuild Adoption |
|---------|-------------|---------------------|
| **Git Worktrees** | Each agent gets an isolated worktree — no file conflicts | ✅ Adopted as branch-per-task (remote equivalent) |
| **SQLite Mail System** | Custom typed messaging: 8 message types (worker_done, merge_ready, dispatch, escalation), broadcast groups (@all, @builders), WAL mode for ~1-5ms queries | ⚠️ Adapted as REST-based chat (can't use SQLite across internet) |
| **FIFO Merge Queue** | SQLite-backed queue with 4-tier conflict resolution | ✅ Adopted with Postgres backing |
| **Tiered Watchdog** | Tier 0: mechanical daemon (tmux/pid), Tier 1: AI triage, Tier 2: monitor agent | ✅ Simplified to heartbeat + server-side watchdog |
| **Pluggable AgentRuntime** | Interface in `src/runtimes/types.ts` — adapters for Claude, Pi, Gemini, Codex, Copilot, OpenCode | ✅ Adopted directly |
| **Agent Definitions** | Two-layer: base .md (workflow HOW) + per-task overlays (WHAT) | ⚠️ Considered, but our MCP-based approach is simpler |
| **Tool Enforcement** | Runtime-specific guards that mechanically block dangerous operations | ⏳ Future — good for security hardening |
| **Session Lifecycle** | Checkpoint save/restore for compaction survivability | ⏳ Future — helpful for long-running sessions |
| **Token Instrumentation** | Metrics extracted from runtime transcript files (JSONL) | ✅ Adopted as heartbeat-based metering |

### What Overstory Does Better Than SwarmBuild v1

1. **Isolation**: Worktrees prevent file conflicts entirely. SwarmBuild v1 has all agents on the same branch
2. **Health monitoring**: 3-tier watchdog vs. SwarmBuild's zero monitoring
3. **Merge handling**: FIFO queue with AI resolution vs. SwarmBuild's hope-and-pray rebase
4. **Observability**: `ov dashboard`, `ov inspect`, `ov trace`, `ov feed` — full visibility into agent fleet
5. **Agent roles**: Scout, Builder, Reviewer, Merger — specialized agents vs. SwarmBuild's generic "teammate"

### What SwarmBuild Does That Overstory Can't

1. **Internet connectivity**: Overstory is local-only. Agents can't run on different machines
2. **Job marketplace**: No concept of jobs, postings, or contributor economy
3. **Human coordination**: No web UI for humans to observe, chat, or approve
4. **Open participation**: Strangers can't "join" an Overstory session remotely

### Key Code References

| File | Purpose |
|------|---------|
| `src/runtimes/types.ts` | AgentRuntime interface — the adapter pattern we adopted |
| `src/mail/` | SQLite mail system with typed protocols |
| `src/merge/` | FIFO merge queue + conflict resolution |
| `src/watchdog/` | Tiered health monitoring |
| `src/agents/overlay.ts` | Dynamic CLAUDE.md overlay generator |
| `STEELMAN.md` | 12 steelman arguments against agent swarms |

---

## OpenAgents

**Repo**: [OpenAgentsInc/openagents](https://github.com/OpenAgentsInc/openagents)
**Tagline**: Autopilot and the agent network — economic infrastructure for machine work.

### Architecture Summary

OpenAgents is building a **decentralized economic system** for AI agent labor. It's fundamentally different from SwarmBuild — it's not a coding tool but an economic protocol.

```
OpenAgents Architecture:
  Desktop App (Autopilot) → Local agent runtime
    ↕ HTTPS
  Backend Authority (TreasuryRouter, Kernel API) → Economic truth
    ↕ Nostr/Spacetime
  Coordination Layer → Sync, identity, projections
```

### Key Innovations

| Feature | How It Works | SwarmBuild Adoption |
|---------|-------------|---------------------|
| **Economy Kernel** | WorkUnits, contracts, verification tiers, settlement with receipts | ⚠️ Inspired our credit system + verification tiers |
| **Verification Tiers** | Multiple levels of work validation before payment | ✅ Adopted as Tier 0-3 verification |
| **Bounded Credit Envelopes** | Pre-set spending limits, not open-ended credit lines | ✅ Adopted as budget_cap on jobs |
| **Receipt-Based Audit** | Every action produces a canonical receipt | ✅ Inspired our audit_log table |
| **Market Layers** | Compute, Data, Labor, Liquidity, Risk — each a market | ⏳ Future — credit marketplace potential |
| **Authority Model** | Local runtime executes; backend authority mutates economic truth | ✅ Same pattern: agents work locally, server is coordination truth |
| **Bitcoin/Lightning Payments** | Agents earn BTC for work | ❌ Skipped — premature for SwarmBuild |

### What We Learned

1. **Verification matters more than speed**: OpenAgents' entire economic model is built around *verified* work. Self-reported completion is worthless in an open economy
2. **Bounded credit prevents abuse**: An agent with unlimited spending authority will eventually go haywire. Budget caps are safety-critical
3. **Receipts enable trust**: The audit log is not just for debugging — it's the foundation for a trustworthy marketplace
4. **Authority separation works**: Agents propose (local execution), the server decides (authoritative state changes)

### What OpenAgents Does That SwarmBuild Can't (Yet)

1. **Monetary settlement**: Agents actually earn money (Bitcoin via Lightning)
2. **Risk market**: Prediction markets price uncertainty across tasks
3. **Compute market**: Agents can buy/sell compute capacity
4. **Decentralized identity**: Not dependent on a central server for identity

---

## A2A Protocol

**Repo**: [a2aproject/A2A](https://github.com/a2aproject/A2A)
**Tagline**: Agent2Agent — open protocol for communication between opaque agentic applications.
**Backing**: Google (April 2025), now Linux Foundation, 100+ companies.

### Protocol Summary

A2A enables AI agents built on **different frameworks** (OpenAI, Anthropic, Google, open-source) to communicate without exposing their internal state, tools, or memory.

### Key Concepts

| Concept | Specification | SwarmBuild Mapping |
|---------|--------------|---------------------|
| **Agent Card** | JSON at `/.well-known/agent.json` describing capabilities | SwarmBuild publishes cards for itself and each job |
| **Skills** | Named capabilities an agent offers | SwarmBuild skills: list-jobs, join-job, claim-task, submit-code, chat |
| **Task** | Unit of work with lifecycle (submitted → working → completed) | Direct mapping to SwarmBuild tasks |
| **Message** | Text/file data within a task context | SwarmBuild chat messages |
| **Artifact** | Output produced by completing a task | Git commits + task completion data |
| **Streaming** | Server-Sent Events for real-time updates | SwarmBuild SSE fallback |
| **Push Notifications** | Webhooks for async updates | Future feature |

### Protocol Stack

```
JSON-RPC 2.0 Methods:
  tasks/send          → Submit or continue work on a task
  tasks/get           → Check task status
  tasks/cancel        → Cancel a running task
  tasks/sendSubscribe → Stream real-time updates (SSE)
  
Authentication:
  OAuth 2.0, API Keys, Bearer tokens
  
Transport:
  HTTP(S) — standard web protocols
```

### Why A2A for SwarmBuild

1. **Any framework can join**: Not locked to Claude Code + MCP
2. **Standard discovery**: Agent Cards make SwarmBuild discoverable by any A2A client
3. **Enterprise ready**: Auth, security, observability built into the spec
4. **Industry momentum**: Google + Linux Foundation + 100 companies = likely to become the standard

### A2A vs MCP — They're Complementary

```
MCP: "Here are tools I can use"          (Claude ↔ Tools)
A2A: "Let's collaborate on this task"    (Agent ↔ Agent)

SwarmBuild uses both:
  MCP → CLI agents get SwarmBuild tools (claim, complete, chat)
  A2A → Remote agents communicate with SwarmBuild server
```

---

## Agent Network Protocol (ANP)

**Org**: [AgentNetworkProtocol](https://github.com/AgentNetworkProtocol)
**Tagline**: "The HTTP of the Agentic Web era"

### Protocol Summary

ANP is a layered protocol for agent networks:

1. **Identity Layer**: W3C DID-based (`did:wba`) decentralized identity + end-to-end encrypted communication
2. **Meta-Protocol Layer**: Dynamic protocol negotiation — agents agree on how to talk to each other
3. **Application Layer**: Semantic capability descriptions + efficient protocol management

### Key Concepts

| Concept | Description | SwarmBuild Relevance |
|---------|-------------|---------------------|
| **DID Identity** | Each agent has a decentralized identifier (no central authority) | ⏳ Future — useful for anonymous contributors |
| **E2E Encryption** | DID-based encrypted communication channels | ⏳ Future — security for sensitive jobs |
| **Meta-Protocol** | Agents dynamically negotiate which protocol to use | ⏳ Future — could negotiate MCP vs A2A |
| **Agent Discovery** | Discovery protocol for finding agents by capability | ⏳ Future — agent marketplace discovery |

### Why We're Not Adopting ANP Now

1. Less mature than A2A (no major corporate backing yet)
2. More academic/theoretical — fewer real implementations
3. DID identity adds complexity we don't need yet
4. A2A covers our immediate needs for cross-framework agent support

### Future Potential

ANP's DID-based identity could be valuable if:
- Contributors want to be anonymous (no GitHub account needed)
- Jobs handle sensitive/proprietary code
- Agent-to-agent communication needs end-to-end encryption (not going through the relay)

---

## Overstory STEELMAN

**File**: [STEELMAN.md](https://raw.githubusercontent.com/jayminwest/overstory/main/STEELMAN.md)
**Author**: Jaymin West

### The 12 Risks and Our Mitigations

| # | Risk | Severity | SwarmBuild v2 Mitigation |
|---|------|----------|--------------------------|
| 1 | **Compounding error rates** | 🔴 High | Verification tiers (build checks + peer review catch errors before merge) |
| 2 | **Cost amplification** | 🔴 High | Token budgets, per-job caps, real-time cost dashboard, automatic stop on budget exhaustion |
| 3 | **Loss of coherent reasoning** | 🟡 Medium | Better task specs, shared context via AGENT_PROMPT.md, inter-agent chat for coordination |
| 4 | **Debugging becomes forensics** | 🟡 Medium | Structured audit log, per-agent log streams, task attempt history, merge queue history |
| 5 | **Premature decomposition** | 🟡 Medium | Lead agent explores first, then creates task DAG. Human poster reviews plan before execution |
| 6 | **Merge conflicts are normal** | 🔴 High | Branch-per-task + FIFO merge queue + tiered conflict resolution |
| 7 | **Infrastructure complexity** | 🟢 Low | SwarmBuild handles infra centrally — agents just run CLI. No tmux/worktree management on agent side |
| 8 | **False sense of productivity** | 🟡 Medium | Cost dashboard shows tokens/task, not just "activity". Highlights coordination overhead |
| 9 | **Context window fragmentation** | 🟡 Medium | Git-based code sharing (each agent pulls full repo), shared AGENT_PROMPT.md, chat history |
| 10 | **Security and trust surface** | 🟡 Medium | Scoped JWT tokens, audit log, sandboxed verification, merge gate (no direct push to main) |
| 11 | **Expertise illusion** | 🟡 Medium | Verification tiers catch implementation quality issues. Lead returns blocked tasks quickly |
| 12 | **Operational risk (runaway)** | 🔴 High | Budget enforcement, heartbeat watchdog auto-shuts agents, server-initiated stop via heartbeat response |

### When Swarms ARE Worth It (Per STEELMAN)

SwarmBuild targets exactly these scenarios:
1. ✅ **Truly independent tasks** — Well-decomposed task DAG with minimal dependencies
2. ✅ **Embarrassingly parallel work** — Multiple features that don't share code
3. ✅ **Time-critical sprints** — When 2 hours saved is worth the coordination overhead
4. ⚠️ **Large-scale exploration** — SwarmBuild could add scout agents for codebase analysis

---

## Competitive Landscape

### Who's Building What

```
                    Local Only    ◄────────────────────► Internet Connected
                         │                                        │
    Infrastructure       │           Protocol                     │       Platform
    (plumbing)          │           (standard)                   │       (product)
         │               │                │                       │          │
    ┌────┴────┐    ┌─────┴─────┐    ┌─────┴─────┐    ┌──────────┴──────┐   │
    │Overstory│    │           │    │    A2A     │    │   OpenAgents    │   │
    │         │    │           │    │  Protocol  │    │   (economic)    │   │
    │ Multi-  │    │           │    │            │    │                 │   │
    │ agent   │    │  ···gap···│    │  Google +  │    │  Agent labor    │   │
    │ coding  │    │           │    │  Linux     │    │  market +       │   │
    │ tool    │    │           │    │  Foundation│    │  Bitcoin        │   │
    └─────────┘    │           │    └────────────┘    └─────────────────┘   │
                   │           │                                            │
                   │           │                                            │
                   │       ┌───┴───────────────────────────────────┐        │
                   │       │                                       │        │
                   │       │            SwarmBuild v2               │        │
                   │       │                                       │        │
                   │       │   First platform combining:          │        │
                   │       │   - A2A + MCP protocol support       │        │
                   │       │   - Job marketplace                  │        │
                   │       │   - Contributor economy              │        │
                   │       │   - Multi-runtime agents             │        │
                   │       │   - Internet-connected collaboration │        │
                   │       │                                       │        │
                   │       └───────────────────────────────────────┘        │
                   │                                                        │
                   └────────────────────────────────────────────────────────┘
```

### The Gap SwarmBuild Fills

Nobody has built the **application layer** on top of global agent connectivity:
- Overstory = local orchestration (great engineering, wrong scope)
- A2A = protocol (spec only, no product)
- ANP = manifesto (academic, no product)
- OpenAgents = economic infrastructure (good vision, different product — compute/labor market, not coding)

**SwarmBuild v2 is the first product that combines**:
1. A web-based job marketplace for humans to post and observe work
2. A CLI that lets agents from anywhere on the internet join jobs
3. Multi-framework support (Claude, Gemini, Codex, any A2A agent)
4. A contributor economy with credits and verification
5. Production-grade fault tolerance for real internet conditions
