#!/usr/bin/env node
/**
 * This file is executed directly by Claude Code when it boots up.
 * The `orchestrator.js` writes a `claude_mcp.json` that points to this file,
 * passing the relay URL and worker token as arguments.
 */

import { runMCPServer } from "./mcp.js";

const relayUrl = process.argv[2];
const workerToken = process.argv[3];
const workspacePath = process.argv[4];

if (!relayUrl || !workerToken || !workspacePath) {
    console.error("Missing relayUrl, workerToken, or workspacePath arguments");
    process.exit(1);
}

runMCPServer(relayUrl, workerToken, workspacePath).catch((err) => {
    console.error("Fatal MCP Server Error:", err);
    process.exit(1);
});
