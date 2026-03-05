#!/usr/bin/env node
/**
 * This file is executed directly by Claude Code when it boots up.
 * The `orchestrator.js` writes a `claude_mcp.json` that points to this file,
 * passing the relay URL and worker token as arguments.
 */

import { runMCPServer } from "./mcp.js";
import { config as dotenvConfig } from "dotenv";
import path from "path";
import fs from "fs";

const relayUrl = process.argv[2];
const workerToken = process.argv[3];
const workspacePath = process.argv[4];

if (!relayUrl || !workerToken || !workspacePath) {
    console.error("Missing relayUrl, workerToken, or workspacePath arguments");
    process.exit(1);
}

// ── Load GITHUB_TOKEN from project .env files if not already in the environment ──
// The CLI can be run from any directory (npx), so we search common locations.
if (!process.env.GITHUB_TOKEN) {
    const candidates = [
        // Sibling of the workspace directory (monorepo root → apps/api/.env)
        path.join(workspacePath, "..", "apps", "api", ".env"),
        path.join(workspacePath, "..", ".env"),
        // CWD-relative (where the user launched npx from)
        path.join(process.cwd(), "apps", "api", ".env"),
        path.join(process.cwd(), ".env"),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                dotenvConfig({ path: candidate });
                if (process.env.GITHUB_TOKEN) break; // found it
            }
        } catch { /* ignore */ }
    }
}

runMCPServer(relayUrl, workerToken, workspacePath).catch((err) => {
    console.error("Fatal MCP Server Error:", err);
    process.exit(1);
});
