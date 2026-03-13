/**
 * Codex CLI Runtime Adapter
 *
 * Translates SwarmBuild's spawn config into OpenAI Codex CLI flags.
 * Reference: The Engineering/03-MULTI-RUNTIME.md
 */

import { AgentRuntime } from "./types.js";
import { spawn } from "child_process";

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

    spawn(config) {
        const args = this.buildArgs(config);
        const options = this.buildSpawnOptions(config);
        const proc = spawn(this.command, args, options);

        // Codex receives prompt via stdin
        proc.stdin.write(config.systemPrompt);
        proc.stdin.end();

        return proc;
    }
}
