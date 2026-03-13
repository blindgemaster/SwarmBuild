/**
 * Claude Code Runtime Adapter
 *
 * Translates SwarmBuild's spawn config into Claude Code CLI flags.
 * Reference: The Engineering/03-MULTI-RUNTIME.md
 */

import { AgentRuntime } from "./types.js";
import { spawn } from "child_process";

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
        // Claude Code prints token usage in format: "Total tokens: X" or similar
        const tokenMatch = output.match(/Total.*?(\d[\d,]+)\s*tokens/i);
        const tokens = tokenMatch ? parseInt(tokenMatch[1].replace(/,/g, '')) : 0;
        return { tokensUsed: tokens };
    }

    spawn(config) {
        const args = this.buildArgs(config);
        const options = this.buildSpawnOptions(config);
        const proc = spawn(this.command, args, options);

        // Claude receives prompt via stdin
        proc.stdin.write(config.systemPrompt);
        proc.stdin.end();

        return proc;
    }
}
