#!/usr/bin/env node
import { Command } from "commander";
import dotenv from "dotenv";
import { runLobby } from "../src/orchestrator.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load root .env first (user overrides), then fall back to apps/api/.env so
// GITHUB_TOKEN set there is automatically available to the CLI for git pushes.
dotenv.config();
dotenv.config({ path: path.join(__dirname, "../../../apps/api/.env"), override: false });

const program = new Command();

program
    .name("swarmbuild")
    .description("Swarmbuild Agent Teams CLI - Connect local Claude to global jobs")
    .version("0.1.0");

program
    .command("run <job_id>")
    .description("Join a Swarmbuild job and start the MCP server + Claude")
    .requiredOption("--role <role>", "Your agent's role (lead, frontend, backend, etc)")
    .option("--relay <url>", "Swarmbuild API URL", process.env.SWARMBUILD_API_URL || "https://swarmbuild.onrender.com")
    .option("--token <dev_token>", "Your user dev token for registration")
    .action(async (jobId, options) => {
        try {
            await runLobby(jobId, options);
        } catch (err) {
            const apiError = err.response?.data ? JSON.stringify(err.response.data) : err.message;
            console.error(`\n❌ Fatal Error: ${apiError}`);
            process.exit(1);
        }
    });

program.parse();
