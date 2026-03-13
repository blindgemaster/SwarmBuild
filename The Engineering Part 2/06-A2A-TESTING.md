# 06 — A2A Testing & Demo

> **Problem**: The A2A gateway router exists (`routers/a2a.py`) but there's no way for a user to test it, no demo flow, and no documentation for external agents. The feature is invisible.

---

## What A2A Should Enable

An external agent (not using the SwarmBuild CLI) should be able to:

1. **Discover** SwarmBuild via Agent Card at `/.well-known/agent.json`
2. **List** available jobs
3. **Join** a specific job as a contributor
4. **Claim** and **complete** tasks
5. **Chat** with the team

All via standard A2A JSON-RPC 2.0 over HTTP — no CLI installation needed.

---

## Design: A2A Test CLI Command

Add a `swarmbuild a2a-test <relay_url>` command that simulates an external A2A agent:

```javascript
// packages/cli/src/a2a-test.js

export async function runA2ATest(relayUrl) {
    console.log("=== SwarmBuild A2A Protocol Test ===\n");
    
    // 1. Discovery
    console.log("1. Discovering Agent Card...");
    const card = await fetch(`${relayUrl}/api/a2a/.well-known/agent.json`);
    const cardData = await card.json();
    console.log(`   Name: ${cardData.name}`);
    console.log(`   Skills: ${cardData.skills.map(s => s.id).join(", ")}`);
    console.log(`   ✅ Agent Card discovered\n`);
    
    // 2. List jobs
    console.log("2. Listing available jobs...");
    const listRes = await a2aCall(relayUrl, "tasks/send", {
        message: { role: "user", parts: [{ type: "text", text: "list available jobs" }] }
    });
    console.log(`   Found ${listRes.result?.artifacts?.[0]?.parts?.[0]?.text || "N/A"}`);
    console.log(`   ✅ Jobs listed\n`);
    
    // 3. Get tasks (would need auth for a real flow)
    console.log("3. Getting tasks (requires auth)...");
    const tasksRes = await a2aCall(relayUrl, "tasks/send", {
        message: { role: "user", parts: [{ type: "text", text: "get tasks" }] }
    });
    console.log(`   Response: ${JSON.stringify(tasksRes).slice(0, 200)}`);
    
    console.log("\n=== A2A Test Complete ===");
}

async function a2aCall(relayUrl, method, params, token = null) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    
    const res = await fetch(`${relayUrl}/api/a2a`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: Math.random().toString(36).slice(2),
            method,
            params,
        }),
    });
    return res.json();
}
```

### CLI Command

```javascript
// bin/swarmbuild.js — Add a2a-test command
program
    .command("a2a-test")
    .description("Test the A2A protocol gateway")
    .option("--relay <url>", "API URL", defaultRelay)
    .action(async (options) => {
        await runA2ATest(options.relay);
    });
```

---

## Design: A2A Join Flow Fix

The current A2A router handles `join-job` intent but doesn't actually create a contributor record via the internal API. Fix this:

```python
# In a2a.py _handle_task_send, action == "join_job":

elif action == "join_job":
    job_id = intent.get("job_id")
    role = intent.get("role", "backend")
    if not job_id:
        return to_a2a_error(-32602, "Could not extract job_id.", req.id)
    
    # Create contributor via internal flow
    # Need a user_id for A2A agents — use a synthetic one
    import secrets
    token_hex = secrets.token_urlsafe(32)
    worker_token = f"wt_{token_hex}"
    
    contrib = db.table("contributors").insert({
        "job_id": job_id,
        "user_id": "00000000-0000-0000-0000-000000000000",  # A2A synthetic user
        "worker_token": worker_token,
        "token_expires": (datetime.utcnow() + timedelta(hours=24)).isoformat(),
        "role": role,
        "is_ready": True,
        "contributor_status": "active",
    }).execute()
    
    return to_a2a_response({
        "status": "joined",
        "worker_token": worker_token,
        "role": role,
        "message": f"Joined job {job_id} as {role}. Use this token for authenticated requests.",
    }, req_id=req.id)
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/src/a2a-test.js` | **NEW** | A2A protocol test script |
| `packages/cli/bin/swarmbuild.js` | **MODIFY** | Add `a2a-test` command |
| `apps/api/routers/a2a.py` | **MODIFY** | Fix join_job to create contributor record |
