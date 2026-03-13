# 03 — Multi-Runtime Agent Support

> **Goal**: Any AI coding agent — Claude Code, Gemini CLI, Codex, or a custom agent — should be able to join a SwarmBuild job. The CLI should be runtime-agnostic.
>
> Inspired by Overstory's pluggable `AgentRuntime` interface which supports Claude, Pi, Gemini, Codex, Copilot, and OpenCode through a single adapter pattern.

---

## Table of Contents

1. [Problem Analysis](#problem-analysis)
2. [Runtime Adapter Interface](#runtime-adapter-interface)
3. [Adapter Implementations](#adapter-implementations)
4. [Prompt Translation Layer](#prompt-translation-layer)
5. [MCP Compatibility Matrix](#mcp-compatibility-matrix)
6. [CLI Changes](#cli-changes)
7. [Implementation Details](#implementation-details)

---

## Problem Analysis

### v1 Coupling to Claude Code

The v1 orchestrator is hardcoded to Claude Code in three places:

1. **`orchestrator.js` line 361**: `spawn("claude", claudeArgs, ...)`
2. **`orchestrator.js` line 350-358**: Claude-specific args (`--print`, `--mcp-config`, `--dangerously-skip-permissions`, `--allowed-tools`)
3. **`orchestrator.js` line 369**: Prompt delivery via stdin (`claude.stdin.write(systemPrompt)`)

These all assume Claude Code's specific CLI interface. Other runtimes have completely different interfaces:

| Feature | Claude Code | Gemini CLI | Codex CLI | OpenAI Agents |
|---------|-------------|------------|-----------|---------------|
| Invocation | `claude` | `gemini` | `codex` | Python SDK |
| Non-interactive mode | `--print` | `-n` / `--non-interactive` | `--quiet` | API call |
| MCP config | `--mcp-config file.json` | `--mcp-config file.json` | TBD | Not native |
| Tool access | `--allowed-tools` | Built-in | `--approval-mode` | Python code |
| Prompt delivery | stdin pipe | `-p "prompt"` | stdin | API body |
| Permissions | `--dangerously-skip-permissions` | Sandboxed by default | `--full-auto` | N/A |
| Output format | Streaming text | Streaming text | Streaming text | JSON API |

### What Overstory Teaches Us

Overstory defines an `AgentRuntime` interface in `src/runtimes/types.ts` with these methods:
- `spawn()` — Launch the agent with proper config
- `buildConfig()` — Deploy runtime-specific configuration files
- `enforceGuards()` — Set up tool-call restrictions
- `detectReadiness()` — Know when the agent is ready for work
- `parseTranscript()` — Extract token usage from output

Each runtime (Claude, Pi, Gemini, Codex, Copilot, OpenCode) implements this interface. The orchestrator only talks to the interface, never to the runtime directly.

---

## Runtime Adapter Interface

### Interface Definition

```javascript
// packages/cli/src/runtimes/types.js

/**
 * @typedef {Object} SpawnConfig
 * @property {string} workspacePath - Path to the workspace directory
 * @property {string} mcpConfigPath - Path to the MCP config JSON file
 * @property {string} systemPrompt - The full system prompt for the agent
 * @property {boolean} isPlanning - Whether this is a planning (not execution) session
 * @property {string} role - The agent's role (lead, backend, frontend, etc.)
 * @property {Object} env - Environment variables to pass
 */

/**
 * @typedef {Object} AgentOutput
 * @property {number} tokensUsed - Approximate token count from this session
 * @property {number} exitCode - Process exit code
 * @property {string} lastOutput - Last N chars of stdout for log relay
 */

/**
 * AgentRuntime — Interface that every runtime adapter must implement.
 *
 * The orchestrator calls these methods without knowing which AI model is
 * behind them. Each adapter translates SwarmBuild's needs into the
 * runtime's specific CLI flags, config format, and output parsing.
 */
export class AgentRuntime {
    /** Human-readable name shown in logs and UI */
    get name() { throw new Error("Not implemented"); }

    /** 
     * Does this runtime support MCP natively?
     * If true, the MCP server is configured via the runtime's built-in config.
     * If false, SwarmBuild runs the MCP server as a sidecar process and
     * provides tool results via a bridge.
     */
    get supportsMCP() { throw new Error("Not implemented"); }

    /**
     * Build the MCP configuration object in the format this runtime expects.
     * @param {Object} mcpServerConfig - SwarmBuild's canonical MCP config
     * @returns {Object} Runtime-specific MCP config
     */
    buildMCPConfig(mcpServerConfig) { throw new Error("Not implemented"); }

    /**
     * Build the command-line arguments for this runtime.
     * @param {SpawnConfig} config
     * @returns {string[]} Array of CLI arguments
     */
    buildArgs(config) { throw new Error("Not implemented"); }

    /**
     * Build the spawn options (env, stdio, shell, cwd).
     * @param {SpawnConfig} config
     * @returns {Object} Options for child_process.spawn()
     */
    buildSpawnOptions(config) { throw new Error("Not implemented"); }

    /**
     * The executable command to run.
     * @returns {string} e.g., "claude", "gemini", "codex"
     */
    get command() { throw new Error("Not implemented"); }

    /**
     * How to deliver the system prompt to this runtime.
     * @returns {"stdin" | "arg" | "file"} Delivery method
     */
    get promptDelivery() { throw new Error("Not implemented"); }

    /**
     * Parse the runtime's stdout output to extract token usage.
     * @param {string} output - Raw stdout text
     * @returns {AgentOutput}
     */
    parseOutput(output) { throw new Error("Not implemented"); }

    /**
     * Spawn the agent process.
     * Default implementation uses child_process.spawn with the above config.
     * Override for runtimes that need custom spawn logic (e.g., API-based agents).
     * @param {SpawnConfig} config
     * @returns {Promise<ChildProcess>}
     */
    async spawn(config) {
        const { spawn } = await import("child_process");
        const args = this.buildArgs(config);
        const options = this.buildSpawnOptions(config);
        const proc = spawn(this.command, args, options);

        // Deliver prompt based on runtime's preferred method
        if (this.promptDelivery === "stdin") {
            proc.stdin.write(config.systemPrompt);
            proc.stdin.end();
        }

        return proc;
    }
}
```

---

## Adapter Implementations

### Claude Code Adapter

```javascript
// packages/cli/src/runtimes/claude.js

import { AgentRuntime } from "./types.js";

export class ClaudeRuntime extends AgentRuntime {
    get name() { return "claude"; }
    get command() { return "claude"; }
    get supportsMCP() { return true; }
    get promptDelivery() { return "stdin"; }

    buildMCPConfig(mcpServerConfig) {
        // Claude Code uses the standard MCP config format
        return { mcpServers: mcpServerConfig };
    }

    buildArgs(config) {
        const args = [
            "--print",                          // Non-interactive mode
            "--mcp-config", "claude_mcp.json",  // MCP config file
            "--dangerously-skip-permissions",    // Skip permission prompts
        ];

        // If no GITHUB_TOKEN, restrict to SwarmBuild tools only
        if (!process.env.GITHUB_TOKEN) {
            args.push("--allowed-tools",
                "swarmbuild_create_tasks,swarmbuild_get_tasks," +
                "swarmbuild_claim_task,swarmbuild_complete_task," +
                "swarmbuild_send_message,swarmbuild_read_chat"
            );
        }

        return args;
    }

    buildSpawnOptions(config) {
        return {
            cwd: config.workspacePath,
            stdio: ["pipe", "pipe", "pipe"],
            shell: true,
            env: {
                ...process.env,
                CLAUDE_CONFIG_FILE: config.mcpConfigPath,
                FORCE_COLOR: "1",
            },
        };
    }

    parseOutput(output) {
        // Claude Code prints token usage in format: "Total tokens: X"
        const tokenMatch = output.match(/Total.*?(\d[\d,]+)\s*tokens/i);
        const tokens = tokenMatch ? parseInt(tokenMatch[1].replace(/,/g, '')) : 0;
        return { tokensUsed: tokens };
    }
}
```

### Gemini CLI Adapter

```javascript
// packages/cli/src/runtimes/gemini.js

import { AgentRuntime } from "./types.js";

export class GeminiRuntime extends AgentRuntime {
    get name() { return "gemini"; }
    get command() { return "gemini"; }
    get supportsMCP() { return true; }
    get promptDelivery() { return "arg"; }

    buildMCPConfig(mcpServerConfig) {
        // Gemini CLI uses the same MCP format as Claude
        return { mcpServers: mcpServerConfig };
    }

    buildArgs(config) {
        const args = [
            "-n",                             // Non-interactive mode
            "--mcp-config", "gemini_mcp.json", // MCP config file
            "--sandbox",                       // Run in sandbox mode
        ];

        // Gemini takes prompt as -p argument
        args.push("-p", config.systemPrompt);

        return args;
    }

    buildSpawnOptions(config) {
        return {
            cwd: config.workspacePath,
            stdio: ["pipe", "pipe", "pipe"],
            shell: true,
            env: {
                ...process.env,
                GEMINI_API_KEY: process.env.GEMINI_API_KEY,
            },
        };
    }

    parseOutput(output) {
        // Gemini CLI output format TBD — best-effort extraction
        const tokenMatch = output.match(/tokens?[\s:]+(\d+)/i);
        const tokens = tokenMatch ? parseInt(tokenMatch[1]) : 0;
        return { tokensUsed: tokens };
    }
}
```

### Codex CLI Adapter

```javascript
// packages/cli/src/runtimes/codex.js

import { AgentRuntime } from "./types.js";

export class CodexRuntime extends AgentRuntime {
    get name() { return "codex"; }
    get command() { return "codex"; }
    get supportsMCP() { return false; } // Codex may not support MCP natively
    get promptDelivery() { return "stdin"; }

    buildMCPConfig(mcpServerConfig) {
        // If Codex doesn't support MCP, we bridge via tool descriptions in prompt
        return null;
    }

    buildArgs(config) {
        return [
            "--quiet",          // Reduced output
            "--full-auto",      // No approval prompts
        ];
    }

    buildSpawnOptions(config) {
        return {
            cwd: config.workspacePath,
            stdio: ["pipe", "pipe", "pipe"],
            shell: true,
            env: {
                ...process.env,
                OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            },
        };
    }

    parseOutput(output) {
        const tokenMatch = output.match(/tokens?[\s:]+(\d+)/i);
        const tokens = tokenMatch ? parseInt(tokenMatch[1]) : 0;
        return { tokensUsed: tokens };
    }
}
```

### Runtime Registry

```javascript
// packages/cli/src/runtimes/index.js

import { ClaudeRuntime } from "./claude.js";
import { GeminiRuntime } from "./gemini.js";
import { CodexRuntime } from "./codex.js";

const runtimes = {
    claude: new ClaudeRuntime(),
    gemini: new GeminiRuntime(),
    codex: new CodexRuntime(),
};

export function getRuntime(name) {
    const runtime = runtimes[name];
    if (!runtime) {
        const available = Object.keys(runtimes).join(", ");
        throw new Error(`Unknown runtime '${name}'. Available: ${available}`);
    }
    return runtime;
}

export function listRuntimes() {
    return Object.entries(runtimes).map(([name, rt]) => ({
        name,
        supportsMCP: rt.supportsMCP,
        command: rt.command,
    }));
}
```

---

## Prompt Translation Layer

### Problem: Different Runtimes Understand Different Prompt Formats

Claude Code expects detailed markdown instructions. Gemini might work better with structured JSON. Codex works best with code-focused prompts.

### Solution: Template-Based Prompt Generation

```javascript
// packages/cli/src/runtimes/prompts.js

export function buildPrompt(runtime, context) {
    const { role, isPlanning, isSoloLead, jobInfo, availableRoles } = context;

    // Base context (same for all runtimes)
    const base = {
        role,
        isPlanning,
        isSoloLead,
        agentPromptFile: "AGENT_PROMPT.md",
        taskListFile: "TASK_LIST.md",
        availableRoles,
        tools: [
            "swarmbuild_create_tasks",
            "swarmbuild_get_tasks",
            "swarmbuild_claim_task",
            "swarmbuild_complete_task",
            "swarmbuild_send_message",
            "swarmbuild_read_chat",
        ],
    };

    // Runtime-specific formatting
    switch (runtime.name) {
        case "claude":
            return buildClaudePrompt(base);
        case "gemini":
            return buildGeminiPrompt(base);
        case "codex":
            return buildCodexPrompt(base);
        default:
            return buildGenericPrompt(base);
    }
}

function buildGenericPrompt(ctx) {
    // Fallback: generic markdown prompt that any LLM should understand
    return `# SwarmBuild Agent Instructions

You are a ${ctx.role.toUpperCase()} agent on a collaborative coding team.

## Your Task
1. Read ${ctx.agentPromptFile} for project requirements
2. Use the MCP tool swarmbuild_get_tasks to see available tasks
3. Claim a task with swarmbuild_claim_task
4. Implement it by writing code in this directory
5. Complete it with swarmbuild_complete_task
6. Repeat until all your tasks are done

## Available Tools
${ctx.tools.map(t => `- ${t}`).join("\n")}
`;
}
```

---

## MCP Compatibility Matrix

### Which Runtimes Support MCP Natively?

| Runtime | MCP Support | MCP Config Format | Bridging Needed? |
|---------|-------------|-------------------|------------------|
| Claude Code | ✅ Native | `claude_mcp.json` (JSON) | No |
| Gemini CLI | ✅ Native | `gemini_mcp.json` (JSON) | No |
| Codex CLI | ⚠️ Partial | TBD | Maybe |
| OpenAI Agents SDK | ❌ None | N/A | Yes — full A2A bridge |
| Custom HTTP Agent | ❌ None | N/A | Yes — A2A gateway |

### For Non-MCP Runtimes: The MCP Bridge

When a runtime doesn't support MCP natively, the CLI acts as a **bridge**:

1. The agent sees SwarmBuild tools described in its system prompt (not via MCP protocol)
2. The agent outputs structured function calls (e.g., `{"tool": "swarmbuild_claim_task", "args": {"task_id": "..."}}`)
3. The CLI intercepts, calls the SwarmBuild API directly, and feeds results back to the agent

```
┌─────────────────┐     prompt describes      ┌──────────────┐
│ Non-MCP Agent   │     tools as text          │ SwarmBuild   │
│ (e.g., Codex)   │────────────────────────────│ CLI (Bridge) │
│                  │     agent outputs JSON     │              │
│                  │◄───function call──────────│  Parses call │
│                  │                            │  Calls API   │
│                  │────result text─────────────│  Returns     │
│                  │                            │  result      │
└─────────────────┘                            └──────────────┘
```

This is a Phase 3 feature and may not be needed if most popular runtimes adopt MCP.

---

## CLI Changes

### New `--runtime` Flag

```javascript
// packages/cli/bin/swarmbuild.js

program
    .command("run <job_id>")
    .description("Join a SwarmBuild job and start the MCP server + Agent")
    .requiredOption("--role <role>", "Your agent's role (lead, frontend, backend, etc)")
    .option("--relay <url>", "SwarmBuild API URL", defaultRelay)
    .option("--token <dev_token>", "Your user dev token for registration")
    .option("--runtime <name>", "AI runtime to use (claude, gemini, codex)", "claude")
    .action(async (jobId, options) => {
        try {
            await runLobby(jobId, options);
        } catch (err) {
            const apiError = err.response?.data
                ? JSON.stringify(err.response.data)
                : err.message;
            console.error(`\n❌ Fatal Error: ${apiError}`);
            process.exit(1);
        }
    });

// New command to list available runtimes
program
    .command("runtimes")
    .description("List available AI runtimes")
    .action(() => {
        const runtimes = listRuntimes();
        console.log("\nAvailable runtimes:");
        for (const rt of runtimes) {
            const mcp = rt.supportsMCP ? "✅ MCP" : "⚠️ Bridge";
            console.log(`  ${rt.name.padEnd(12)} ${mcp}   (command: ${rt.command})`);
        }
    });
```

### Orchestrator Integration

```javascript
// packages/cli/src/orchestrator.js — Modified startAgentInteractive()

import { getRuntime } from "./runtimes/index.js";
import { buildPrompt } from "./runtimes/prompts.js";

async function startAgentInteractive(api, role, jobInfo, isPlanning, WORKSPACE, runtimeName = "claude") {
    const runtime = getRuntime(runtimeName);
    console.log(`[swarmbuild] Using runtime: ${runtime.name}`);

    // Build MCP config
    const mcpServerConfig = {
        swarmbuild: {
            command: "node",
            args: [path.join(__dirname, "mcp-runner.js"), api.relayUrl, api.workerToken, WORKSPACE],
        },
    };

    const mcpConfig = runtime.buildMCPConfig(mcpServerConfig);
    const mcpConfigPath = path.join(WORKSPACE, `${runtime.name}_mcp.json`);
    if (mcpConfig) {
        await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    }

    // Build prompt
    const systemPrompt = buildPrompt(runtime, {
        role,
        isPlanning,
        isSoloLead: /* ... same logic ... */,
        jobInfo,
        availableRoles: jobInfo.required_roles,
    });

    // Spawn agent using the runtime adapter
    const spawnConfig = {
        workspacePath: WORKSPACE,
        mcpConfigPath,
        systemPrompt,
        isPlanning,
        role,
        env: process.env,
    };

    console.log(`[swarmbuild] Spawning ${runtime.name} (${isPlanning ? 'planning' : 'execution'}, role: ${role})...`);

    return new Promise((resolve, reject) => {
        const proc = runtime.spawn(spawnConfig);

        proc.stdout?.on("data", (data) => {
            const str = data.toString();
            process.stdout.write(str);
            api.publishLog(str).catch(() => {});
        });

        proc.stderr?.on("data", (data) => {
            const str = data.toString();
            process.stderr.write(str);
            api.publishLog(str).catch(() => {});
        });

        proc.on("close", (code) => {
            console.log(`[swarmbuild] ${runtime.name} exited with code ${code}`);
            api.publishLog(`SYSTEM: Agent exited with code ${code}`).catch(() => {});
            resolve(code);
        });

        proc.on("error", (err) => {
            console.log(`[swarmbuild] Error spawning ${runtime.name}. Is it installed?`);
            reject(err);
        });
    });
}
```

---

## Implementation Details

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/src/runtimes/types.js` | **NEW** | AgentRuntime interface |
| `packages/cli/src/runtimes/claude.js` | **NEW** | Claude Code adapter |
| `packages/cli/src/runtimes/gemini.js` | **NEW** | Gemini CLI adapter |
| `packages/cli/src/runtimes/codex.js` | **NEW** | Codex CLI adapter |
| `packages/cli/src/runtimes/index.js` | **NEW** | Runtime registry |
| `packages/cli/src/runtimes/prompts.js` | **NEW** | Prompt translation layer |
| `packages/cli/src/orchestrator.js` | **MODIFY** | Use runtime adapter instead of hardcoded Claude |
| `packages/cli/bin/swarmbuild.js` | **MODIFY** | Add `--runtime` flag and `runtimes` command |

### Prerequisites

Users must install the runtime's CLI themselves:
- Claude Code: `npm i -g @anthropic-ai/claude-code`
- Gemini CLI: `npm i -g @anthropic-ai/gemini-cli` (TBD)
- Codex: `npm i -g @openai/codex` (TBD)

The SwarmBuild CLI checks for the runtime's command at startup and shows a helpful error message if it's not found.
