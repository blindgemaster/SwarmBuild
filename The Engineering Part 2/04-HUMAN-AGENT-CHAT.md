# 04 — Human-Agent Chat Bridge

> **Problem**: Users can send messages in the lobby chat, but agents never read them during execution. The lobby chat is human-to-human only. Users should be able to talk to the lead agent — give instructions, ask for status, request changes — and the agent should respond.

---

## Root Cause Analysis

The current chat flow is one-directional during execution:

```
Human → POST /api/worker/{token}/messages → DB → WebSocket → Browser UI
Agent → POST /api/worker/{token}/messages → DB → WebSocket → Browser UI
```

But agents only read chat when the MCP tool `swarmbuild_read_chat` is called, and agents only call it when their system prompt tells them to. In the execution loop, the agent prompt says "Use swarmbuild_send_message to report progress" but never says "Check for new messages regularly."

### What Overstory Does

Overstory injects messages into the agent's context automatically:
- `UserPromptSubmit` hook runs `ov mail check --inject` on every prompt
- This surfaces new messages FROM other agents/humans INTO the current agent's context
- The agent sees them as part of its prompt, not as a tool it has to remember to call

**Key insight**: Don't rely on agents remembering to check mail. **Inject new messages into the heartbeat response** so the CLI can surface them to the agent.

---

## Design: Bidirectional Chat Bridge

### 1. Server: Include Pending Messages in Heartbeat Response

The heartbeat already returns `pending_notifications`. Add unread chat messages:

```python
# In worker.py heartbeat handler:

# Fetch unread messages since last heartbeat
unread_messages = (
    db.table("messages")
    .select("id, author_name, author_type, content, created_at")
    .eq("job_id", job_id)
    .eq("author_type", "human")
    .gt("created_at", contributor.get("last_seen", "2000-01-01"))
    .order("created_at")
    .limit(5)
    .execute()
)

if unread_messages.data:
    for msg in unread_messages.data:
        pending_notifications.append({
            "type": "human_message",
            "from": msg["author_name"],
            "content": msg["content"],
            "timestamp": msg["created_at"],
        })
```

### 2. CLI: Surface Messages to Agent via File

The orchestrator writes new human messages to a `MESSAGES.md` file in the workspace that the agent can read:

```javascript
// orchestrator.js — in heartbeat response handler:

if (response.pending_notifications) {
    const humanMessages = response.pending_notifications
        .filter(n => n.type === "human_message");
    
    if (humanMessages.length > 0) {
        const content = humanMessages
            .map(m => `**${m.from}** (${m.timestamp}):\n${m.content}`)
            .join("\n\n---\n\n");
        
        const msgPath = path.join(WORKSPACE, "MESSAGES.md");
        await fs.appendFile(msgPath, `\n\n---\n\n${content}\n`);
        console.log(`[swarmbuild] 📨 ${humanMessages.length} new message(s) from humans`);
    }
}
```

### 3. Updated Agent Prompt

Add message-awareness to the execution prompts:

```markdown
## Communication
- Check MESSAGES.md for any messages from humans during your work.
- Use swarmbuild_read_chat periodically to see team discussion.
- Use swarmbuild_send_message to respond to human questions or report progress.
- If a human asks you to change something, prioritize their request.
```

### 4. Web UI: Direct-to-Agent Message

Add a special "Talk to Lead" button in the lobby chat that tags messages with `@lead`:

```
[User types]: @lead can you also add hover effects to the buttons?
→ Stored with metadata: { "mention": "lead", "priority": "high" }
→ Surfaced in lead agent's next heartbeat as a high-priority notification
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/api/routers/worker.py` | **MODIFY** | Include unread human messages in heartbeat response |
| `packages/cli/src/orchestrator.js` | **MODIFY** | Write human messages to MESSAGES.md, log to console |
| `packages/cli/src/runtimes/prompts.js` | **MODIFY** | Add message-awareness to all execution prompts |
| `apps/web/app/components/LobbyChat.tsx` | **MODIFY** | Add @agent mention support |
