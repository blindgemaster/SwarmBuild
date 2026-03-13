/**
 * Runtime Registry — Central lookup for all available AI runtime adapters.
 *
 * Reference: The Engineering/03-MULTI-RUNTIME.md
 */

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
