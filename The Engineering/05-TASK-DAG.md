# 05 — Task DAG Engine

> **Problem**: v1 has a flat task list. Agents can claim any task in any order. This means Agent B might start "Build auth API" before Agent A finishes "Set up database schema" — producing code that can't compile because the schema doesn't exist yet.
>
> **Solution**: Tasks can declare dependencies. The server only allows claiming a task when all its dependencies are completed.

---

## Table of Contents

1. [Problem Analysis](#problem-analysis)
2. [DAG Design](#dag-design)
3. [Dependency Resolution](#dependency-resolution)
4. [Smart Task Scheduling](#smart-task-scheduling)
5. [Circular Dependency Detection](#circular-dependency-detection)
6. [UI: Kanban with Dependency Arrows](#ui-kanban-with-dependency-arrows)
7. [Implementation Details](#implementation-details)

---

## Problem Analysis

### What Happens Without Dependencies

```
Flat Task List:
  ├── Task A: "Set up database schema"
  ├── Task B: "Build auth API endpoints"
  ├── Task C: "Build frontend login page"
  └── Task D: "Write integration tests"

Ideal Order: A → B → C → D (sequential) or A → (B, C) → D (parallel)

What Actually Happens:
  Agent 1 claims Task C (frontend login) first
  Agent 2 claims Task D (integration tests) first
  Both fail because there's no schema or API yet
  
  Result: Wasted tokens, broken code, confused agents
```

### What Dependencies Enable

```
Task DAG:
  Task A: "Set up database schema" (no deps)
      │
      └──► Task B: "Build auth API" (depends on: A)
              │
              └──► Task C: "Build frontend login" (depends on: B)
              │
              └──► Task D: "Write integration tests" (depends on: B)
  
  Task E: "Design landing page" (no deps, fully independent)

Claim Rules:
  ✅ Agent can claim Task A or Task E immediately
  ❌ Agent cannot claim Task B until Task A is completed
  ❌ Agent cannot claim Task C or D until Task B is completed
  ✅ After Task B completes, C and D can be claimed in parallel
```

---

## DAG Design

### Schema Changes

```sql
-- Add depends_on column to tasks table
ALTER TABLE tasks ADD COLUMN depends_on UUID[] DEFAULT '{}';

-- Index for efficient dependency queries
CREATE INDEX idx_tasks_depends_on ON tasks USING GIN(depends_on);

-- Add ordering/parallelism hints
ALTER TABLE tasks ADD COLUMN parallel_group TEXT;  -- Tasks in same group can run in parallel
ALTER TABLE tasks ADD COLUMN estimated_duration INT;  -- Minutes, for scheduling hints
```

### Data Model

```typescript
interface Task {
    id: string;           // UUID
    job_id: string;       // Parent job
    title: string;        // e.g., "Set up database schema"
    description: string;  // Detailed task spec
    status: "available" | "locked" | "completed" | "failed";
    role: string;         // Who can do this: "backend", "frontend", "lead"
    
    // v2 additions
    depends_on: string[];       // Array of task UUIDs that must be completed first
    parallel_group: string;     // Group label for tasks that can run in parallel
    estimated_duration: number; // Estimated minutes
    verification_status: string; // New in v2 — see 06-VERIFICATION.md
}
```

### Example DAG

A typical web app project might produce this DAG:

```
┌────────────────┐
│ Setup DB Schema│──────────────────────────────────────────────┐
│     (lead)     │                                              │
└───────┬────────┘                                              │
        │                                                       │
        ▼                                                       ▼
┌────────────────┐     ┌────────────────┐     ┌────────────────────────┐
│ Build Auth API │────►│ Build User API │     │ Setup CI/CD Pipeline   │
│   (backend)    │     │   (backend)    │     │       (devops)         │
└───────┬────────┘     └───────┬────────┘     └────────────────────────┘
        │                      │
        ▼                      ▼
┌────────────────┐     ┌────────────────┐
│ Login Page     │     │ Dashboard Page │
│  (frontend)    │     │  (frontend)    │
└───────┬────────┘     └───────┬────────┘
        │                      │
        └──────────┬───────────┘
                   ▼
          ┌────────────────┐
          │ Integration    │
          │ Tests (lead)   │
          └────────────────┘
```

---

## Dependency Resolution

### Availability Check Query

When an agent calls `swarmbuild_get_tasks`, the server returns tasks with their dependency status:

```sql
-- Get all tasks for a job with dependency resolution
SELECT 
    t.id,
    t.title,
    t.status,
    t.role,
    t.depends_on,
    -- Check if all dependencies are completed
    CASE 
        WHEN t.depends_on = '{}' THEN true
        WHEN t.status != 'available' THEN false  -- Already claimed/completed
        ELSE (
            SELECT COUNT(*) = 0
            FROM unnest(t.depends_on) AS dep_id
            LEFT JOIN tasks dep ON dep.id = dep_id
            WHERE dep.status != 'completed'
        )
    END AS is_claimable,
    -- List which deps are blocking
    (
        SELECT array_agg(dep.title)
        FROM unnest(t.depends_on) AS dep_id
        LEFT JOIN tasks dep ON dep.id = dep_id
        WHERE dep.status != 'completed'
    ) AS blocking_tasks
FROM tasks t
WHERE t.job_id = :job_id
ORDER BY 
    -- Prioritize claimable tasks, then by depth in DAG
    CASE WHEN t.depends_on = '{}' THEN 0 ELSE 1 END,
    array_length(t.depends_on, 1) NULLS FIRST;
```

### Enhanced Claim Endpoint

```python
# apps/api/routers/tasks.py — Modified claim_task

@router.post("/{token}/tasks/{task_id}/claim")
async def claim_task(token: str, task_id: str):
    contributor = _verify_token(token)
    db = get_supabase()

    # Fetch the task
    task_result = db.table("tasks").select("*").eq("id", task_id).single().execute()
    task = task_result.data

    if not task:
        raise HTTPException(404, "Task not found")

    if task["status"] != "available":
        raise HTTPException(409, f"Task is already {task['status']}")

    # ── NEW: Check dependencies ──
    depends_on = task.get("depends_on", [])
    if depends_on:
        # Check if all dependencies are completed
        deps_result = (
            db.table("tasks")
            .select("id, title, status")
            .in_("id", depends_on)
            .execute()
        )
        
        incomplete = [d for d in deps_result.data if d["status"] != "completed"]
        
        if incomplete:
            blocking_titles = [d["title"] for d in incomplete]
            raise HTTPException(
                409,
                {
                    "error": "dependencies_not_met",
                    "message": f"Cannot claim: {len(incomplete)} dependency task(s) not completed",
                    "blocking_tasks": [
                        {"id": d["id"], "title": d["title"], "status": d["status"]}
                        for d in incomplete
                    ]
                }
            )

    # Optimistic locking claim (same as v1)
    result = (
        db.table("tasks")
        .update({
            "status": "locked",
            "locked_by_token": token,
            "updated_at": datetime.utcnow().isoformat()
        })
        .eq("id", task_id)
        .eq("status", "available")
        .execute()
    )

    if not result.data:
        raise HTTPException(409, "Task was claimed by another agent")

    # Record attempt
    db.table("task_attempts").insert({
        "task_id": task_id,
        "worker_token": token,
        "outcome": "in_progress",
    }).execute()

    # Broadcast
    await manager.broadcast(contributor["job_id"], {"type": "task_updated"})

    return {"status": "ok", "task": result.data[0]}
```

### MCP Tool Enhancement

```javascript
// packages/cli/src/mcp.js — Enhanced get_tasks response

if (request.params.name === "swarmbuild_get_tasks") {
    const tasks = await api.getTasks();

    // Group by claimability
    const claimable = tasks.filter(t => t.is_claimable && t.status === "available");
    const blocked = tasks.filter(t => !t.is_claimable && t.status === "available");
    const inProgress = tasks.filter(t => t.status === "locked");
    const completed = tasks.filter(t => t.status === "completed");

    const formatted = `
## Available Tasks (can claim now)
${claimable.map(t => `- [${t.id.slice(0,8)}] ${t.title} (${t.role})`).join("\n") || "None — waiting for dependencies"}

## Blocked Tasks (dependencies incomplete)
${blocked.map(t => `- [${t.id.slice(0,8)}] ${t.title} — waiting on: ${t.blocking_tasks?.join(", ")}`).join("\n") || "None"}

## In Progress
${inProgress.map(t => `- [${t.id.slice(0,8)}] ${t.title} (locked)`).join("\n") || "None"}

## Completed
${completed.map(t => `- [${t.id.slice(0,8)}] ${t.title} ✅`).join("\n") || "None"}
    `.trim();

    return {
        content: [{ type: "text", text: formatted }]
    };
}
```

---

## Smart Task Scheduling

### Role-Based Filtering

Agents only see tasks matching their role. The DAG is filtered per-role:

```
Backend agent sees:     Frontend agent sees:
  ├── Setup DB Schema     ├── Login Page (blocked: Auth API)
  ├── Build Auth API      └── Dashboard Page (blocked: User API)
  └── Build User API
```

### Priority Scoring

When multiple tasks are claimable, the server ranks them by priority:

```python
def compute_task_priority(task, all_tasks):
    """Score a task for scheduling priority. Higher = claim first."""
    score = 0
    
    # Tasks that unblock the most downstream work get highest priority
    dependents = [t for t in all_tasks if task["id"] in t.get("depends_on", [])]
    score += len(dependents) * 10  # Each dependent adds 10 points
    
    # Tasks with no dependencies should be worked on first (root tasks)
    if not task.get("depends_on"):
        score += 50
    
    # Previously attempted tasks get priority (partial work exists)
    if task.get("attempt_count", 0) > 0:
        score += 20
    
    # Shorter estimated tasks get slight priority (quick wins)
    duration = task.get("estimated_duration", 60)
    if duration <= 30:
        score += 5
    
    return score
```

### Scheduling Algorithm

```
1. Get all tasks for this job
2. Filter by agent's role
3. Filter by status = "available"
4. Filter by dependency satisfaction (all deps completed)
5. Sort by priority score (descending)
6. Present top-ranked tasks to the agent
7. Agent claims the first one it wants to work on
```

---

## Circular Dependency Detection

### The Problem

If someone creates tasks with circular dependencies (A → B → C → A), no task can ever be claimed. This must be caught at creation time.

### Detection Algorithm

```python
# apps/api/lib/dag.py

def detect_circular_dependencies(tasks):
    """
    Detect circular dependencies in a task list using topological sort.
    Returns list of cycles found, or empty list if DAG is valid.
    """
    # Build adjacency list
    graph = {}
    for task in tasks:
        graph[task["id"]] = task.get("depends_on", [])
    
    # Kahn's algorithm for topological sort
    in_degree = {node: 0 for node in graph}
    for node in graph:
        for dep in graph[node]:
            if dep in in_degree:
                in_degree[dep] = in_degree.get(dep, 0)  # Already counted
    
    # Count incoming edges
    for node in graph:
        for dep in graph[node]:
            if dep in in_degree:
                pass  # depends_on means node depends ON dep, not the other way
    
    # Actually, let's use DFS-based cycle detection (more robust)
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {node: WHITE for node in graph}
    cycles = []
    
    def dfs(node, path):
        color[node] = GRAY
        path.append(node)
        
        for neighbor in graph.get(node, []):
            if neighbor not in color:
                continue  # References a task not in this set
            if color[neighbor] == GRAY:
                # Found a cycle
                cycle_start = path.index(neighbor)
                cycles.append(path[cycle_start:])
                return
            if color[neighbor] == WHITE:
                dfs(neighbor, path)
        
        path.pop()
        color[node] = BLACK
    
    for node in graph:
        if color[node] == WHITE:
            dfs(node, [])
    
    return cycles


def validate_task_dependencies(new_tasks, existing_tasks):
    """Validate that adding new_tasks doesn't create circular dependencies."""
    all_tasks = existing_tasks + new_tasks
    cycles = detect_circular_dependencies(all_tasks)
    
    if cycles:
        cycle_descriptions = []
        for cycle in cycles:
            task_names = []
            for task_id in cycle:
                task = next((t for t in all_tasks if t["id"] == task_id), None)
                task_names.append(task["title"] if task else task_id[:8])
            cycle_descriptions.append(" → ".join(task_names))
        
        return {
            "valid": False,
            "error": "Circular dependencies detected",
            "cycles": cycle_descriptions,
        }
    
    return {"valid": True}
```

### Validation on Task Creation

```python
# apps/api/routers/tasks.py — Modified create_tasks

@router.post("/{token}/tasks")
async def create_tasks(token: str, req: CreateTasksRequest):
    contributor = _verify_token(token)
    db = get_supabase()
    job_id = contributor["job_id"]

    # Fetch existing tasks
    existing = db.table("tasks").select("id, title, depends_on").eq("job_id", job_id).execute()

    # Validate dependencies
    validation = validate_task_dependencies(req.tasks, existing.data)
    if not validation["valid"]:
        raise HTTPException(400, {
            "error": "circular_dependencies",
            "message": validation["error"],
            "cycles": validation["cycles"],
        })

    # Validate that depends_on references exist
    all_task_ids = set(t["id"] for t in existing.data)
    for task in req.tasks:
        for dep_id in task.get("depends_on", []):
            if dep_id not in all_task_ids and dep_id not in [t.get("temp_id") for t in req.tasks]:
                raise HTTPException(400, f"Dependency {dep_id} references a non-existent task")

    # Insert tasks
    # ... (same as v1 but with depends_on field)
```

---

## UI: Kanban with Dependency Arrows

### Enhanced Kanban Board

The web UI Kanban board draws SVG arrows between dependent tasks:

```
┌─ Available ──────┐  ┌─ In Progress ────┐  ┌─ Completed ──────┐
│                  │  │                  │  │                  │
│  ┌──────────┐    │  │  ┌──────────┐    │  │  ┌──────────┐    │
│  │ Landing  │    │  │  │ Auth API │ ◄──┼──┼──│ DB Schema│    │
│  │ Page     │    │  │  │ (locked) │    │  │  │ ✅        │    │
│  └──────────┘    │  │  └────┬─────┘    │  │  └──────────┘    │
│                  │  │       │          │  │                  │
│  ┌──────────┐    │  │       │          │  │                  │
│  │ Login    │ ◄──┼──┼───────┘          │  │                  │
│  │ Page     │    │  │                  │  │                  │
│  │ (blocked)│    │  │                  │  │                  │
│  └──────────┘    │  │                  │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

Tasks with unmet dependencies show a 🔒 icon and a tooltip listing the blocking tasks.

---

## Implementation Details

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `apps/api/lib/dag.py` | **NEW** | DAG validation + cycle detection |
| `apps/api/routers/tasks.py` | **MODIFY** | Dependency checks on claim + create |
| `apps/api/init.sql` | **MODIFY** | Add `depends_on`, `parallel_group`, `estimated_duration` |
| `packages/cli/src/mcp.js` | **MODIFY** | Enhanced task display with dependency info |
| `apps/web/app/components/TaskBoard.tsx` | **MODIFY** | Kanban with dependency arrows |

### Migration SQL

```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS depends_on UUID[] DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parallel_group TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimated_duration INT;
CREATE INDEX IF NOT EXISTS idx_tasks_depends_on ON tasks USING GIN(depends_on);
```
