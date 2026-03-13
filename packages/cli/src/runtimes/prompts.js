/**
 * Prompt Translation Layer — Generates runtime-specific system prompts.
 *
 * Different runtimes understand different prompt formats. Claude works best
 * with detailed markdown. Gemini may prefer structured instructions.
 * Codex works best with code-focused prompts.
 *
 * Reference: The Engineering/03-MULTI-RUNTIME.md §Prompt Translation Layer
 */

export function buildPrompt(runtime, context) {
    const { role, isPlanning, isSoloLead, jobInfo, availableRoles } = context;

    // Base context (same for all runtimes)
    const base = {
        role,
        isPlanning,
        isSoloLead,
        agentPromptFile: "AGENT_PROMPT.md",
        taskListFile: "TASK_LIST.md",
        availableRoles: availableRoles || ["lead"],
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

function buildClaudePrompt(ctx) {
    if (ctx.isPlanning && ctx.role === "lead") {
        return buildPlanningPrompt(ctx);
    }
    if (ctx.isSoloLead) {
        return buildSoloLeadPrompt(ctx);
    }
    return buildTeammatePrompt(ctx);
}

function buildGeminiPrompt(ctx) {
    // Gemini works well with structured, concise prompts
    if (ctx.isPlanning && ctx.role === "lead") {
        return buildPlanningPrompt(ctx);
    }
    if (ctx.isSoloLead) {
        return buildSoloLeadPrompt(ctx);
    }
    return buildTeammatePrompt(ctx);
}

function buildCodexPrompt(ctx) {
    // Codex prefers code-focused, minimal prompts
    if (ctx.isPlanning && ctx.role === "lead") {
        return buildPlanningPrompt(ctx);
    }
    if (ctx.isSoloLead) {
        return buildSoloLeadPrompt(ctx);
    }
    return buildTeammatePrompt(ctx);
}

function buildGenericPrompt(ctx) {
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

function buildPlanningPrompt(ctx) {
    const roles = ctx.availableRoles.join(", ");
    return `# Swarmbuild — Planning Phase

## Your Role
You are the **LEAD AGENT** responsible for creating tasks for the team.

## Step-by-step Instructions
1. Read the file ${ctx.agentPromptFile} in this directory for the project requirements.
2. Read the file ${ctx.taskListFile} for AI-suggested tasks — use them as your starting point.
3. Use the MCP tool swarmbuild_create_tasks to create tasks for the team.
   - Each task can have \`depends_on\` (array of task IDs) to enforce ordering.
   - Each task can have \`estimated_duration\` (minutes) for scheduling.
${ctx.isSoloLead
        ? '4. You are the SOLE agent. Assign ALL tasks to assigned_role = "lead".'
        : `4. Assign every task to one of these roles ONLY: [${roles}]. Do NOT invent new role names.`
    }
5. Do NOT write any code yourself during planning. Only create tasks.

## Available MCP Tools
- swarmbuild_create_tasks — Create tasks (array of {title, description, assigned_role, depends_on, estimated_duration})
- swarmbuild_send_message — Send a message to the team chat
- swarmbuild_read_chat — Read recent chat messages
`;
}

function buildSoloLeadPrompt(ctx) {
    return `# Swarmbuild — Execution Phase

## Your Role
You are the **LEAD AGENT** and the sole contributor on this job.

## Step-by-step Instructions
1. Read the file ${ctx.agentPromptFile} in this directory for the project requirements.
2. Use the MCP tool swarmbuild_get_tasks to see all available tasks.
   - Tasks are grouped: "Available" (can claim now), "Blocked" (waiting on dependencies), "In Progress", "Completed".
3. Pick one task at a time:
   a. Use swarmbuild_claim_task with the task ID to lock it. This creates a git branch for your work.
   b. Implement the task fully by writing code in this directory.
   c. Use swarmbuild_complete_task with the task ID and status "completed" when done. This pushes to your branch and enqueues a merge.
4. Repeat step 3 until all tasks are complete.
5. Use swarmbuild_send_message to report progress.

## Available MCP Tools
- swarmbuild_get_tasks — List all tasks with dependency and claimability info
- swarmbuild_claim_task — Lock a task and create a working branch (pass task_id)
- swarmbuild_complete_task — Mark done, push to branch, enqueue merge (pass task_id, status: "completed" or "failed")
- swarmbuild_send_message — Broadcast a progress message
- swarmbuild_read_chat — Read recent chat messages
`;
}

function buildTeammatePrompt(ctx) {
    return `# Swarmbuild — Execution Phase

## Your Role
You are a **${ctx.role.toUpperCase()}** agent on this team.

## Step-by-step Instructions
1. Read the file ${ctx.agentPromptFile} in this directory for the project requirements.
2. Use the MCP tool swarmbuild_get_tasks to find tasks assigned to your role.
   - Tasks marked "Available" can be claimed now. "Blocked" tasks are waiting on dependencies.
3. Pick one task at a time:
   a. Use swarmbuild_claim_task with the task ID to lock it. This creates a git branch for your work.
   b. Implement the task fully by writing code in this directory.
   c. Use swarmbuild_complete_task with the task ID and status "completed" when done.
4. Repeat step 3 until all your tasks are complete.
5. Use swarmbuild_send_message if you need help or to report progress.

## Available MCP Tools
- swarmbuild_get_tasks — List all tasks with dependency and claimability info
- swarmbuild_claim_task — Lock a task and create a working branch (pass task_id)
- swarmbuild_complete_task — Mark done, push to branch, enqueue merge (pass task_id, status: "completed" or "failed")
- swarmbuild_send_message — Broadcast a progress message
- swarmbuild_read_chat — Read recent chat messages
`;
}
