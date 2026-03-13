/**
 * Gemini CLI Runtime Adapter
 *
 * Translates SwarmBuild's spawn config into Gemini CLI flags.
 * Reference: The Engineering/03-MULTI-RUNTIME.md
 */

import { AgentRuntime } from "./types.js";
import { spawn } from "child_process";

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
        // Gemini CLI output format — best-effort extraction
        const tokenMatch = output.match(/tokens?[\s:]+(\d+)/i);
        const tokens = tokenMatch ? parseInt(tokenMatch[1]) : 0;
        return { tokensUsed: tokens };
    }

    spawn(config) {
        const args = this.buildArgs(config);
        const options = this.buildSpawnOptions(config);
        // Gemini receives prompt via -p arg, not stdin
        return spawn(this.command, args, options);
    }
}
