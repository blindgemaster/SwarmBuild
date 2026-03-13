/**
 * AgentRuntime — Interface that every runtime adapter must implement.
 *
 * The orchestrator calls these methods without knowing which AI model is
 * behind them. Each adapter translates SwarmBuild's needs into the
 * runtime's specific CLI flags, config format, and output parsing.
 *
 * Reference: The Engineering/03-MULTI-RUNTIME.md
 */

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

export class AgentRuntime {
    /** Human-readable name shown in logs and UI */
    get name() { throw new Error("Not implemented"); }

    /**
     * Does this runtime support MCP natively?
     * If true, the MCP server is configured via the runtime's built-in config.
     * If false, SwarmBuild runs the MCP server as a sidecar and bridges tool calls.
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
     * @returns {ChildProcess}
     */
    spawn(config) {
        const { spawn } = require("child_process");
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
