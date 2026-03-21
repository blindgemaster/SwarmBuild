"""
DAG Engine — Task dependency validation and scheduling.

Provides circular dependency detection using DFS, dependency validation
on task creation, and priority scoring for smart task scheduling.

Reference: The Engineering/05-TASK-DAG.md
"""

from typing import List, Optional


def detect_circular_dependencies(tasks: list) -> list:
    """
    Detect circular dependencies in a task list using DFS cycle detection.
    Returns list of cycles found, or empty list if DAG is valid.
    """
    # Build adjacency list: task depends ON dep, so edge is task -> dep
    graph = {}
    for task in tasks:
        task_id = task.get("id") or task.get("temp_id")
        if task_id:
            graph[task_id] = task.get("depends_on", []) or []

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
                cycles.append(list(path[cycle_start:]))
                return
            if color[neighbor] == WHITE:
                dfs(neighbor, path)

        path.pop()
        color[node] = BLACK

    for node in graph:
        if color[node] == WHITE:
            dfs(node, [])

    return cycles


def validate_task_dependencies(new_tasks: list, existing_tasks: list) -> dict:
    """
    Validate that adding new_tasks doesn't create circular dependencies.
    Returns {"valid": True} or {"valid": False, "error": ..., "cycles": [...]}.
    """
    all_tasks = existing_tasks + new_tasks
    cycles = detect_circular_dependencies(all_tasks)

    if cycles:
        # Build human-readable cycle descriptions
        task_map = {}
        for t in all_tasks:
            tid = t.get("id") or t.get("temp_id")
            if tid:
                task_map[tid] = t.get("title", tid[:8])

        cycle_descriptions = []
        for cycle in cycles:
            task_names = [task_map.get(tid, tid[:8] if tid else "?") for tid in cycle]
            cycle_descriptions.append(" -> ".join(task_names))

        return {
            "valid": False,
            "error": "Circular dependencies detected",
            "cycles": cycle_descriptions,
        }

    return {"valid": True}


def check_dependencies_met(task: dict, all_tasks: list) -> dict:
    """
    Check if all dependencies of a task are completed.
    Returns {"met": True} or {"met": False, "blocking": [...]}.
    """
    depends_on = task.get("depends_on") or []
    if not depends_on:
        return {"met": True, "blocking": []}

    # Build lookup of all tasks by id
    task_map = {t["id"]: t for t in all_tasks if t.get("id")}

    blocking = []
    for dep_id in depends_on:
        dep = task_map.get(dep_id)
        if not dep:
            continue  # Dependency not found — skip (might be deleted)
        if dep.get("status") != "completed":
            blocking.append({
                "id": dep["id"],
                "title": dep.get("title", ""),
                "status": dep.get("status", "unknown"),
            })

    return {
        "met": len(blocking) == 0,
        "blocking": blocking,
    }


def compute_task_priority(task: dict, all_tasks: list) -> int:
    """
    Score a task for scheduling priority. Higher = claim first.

    Scoring:
    - +50 for root tasks (no dependencies)
    - +10 per downstream dependent task
    - +20 if previously attempted (partial work exists)
    - +5 for short tasks (≤30 min estimated)
    """
    score = 0
    task_id = task.get("id")

    # Tasks that unblock the most downstream work get highest priority
    dependents = [
        t for t in all_tasks
        if task_id in (t.get("depends_on") or [])
    ]
    score += len(dependents) * 10

    # Root tasks (no dependencies) should be worked on first
    if not task.get("depends_on"):
        score += 50

    # Previously attempted tasks get priority (partial work exists)
    if task.get("attempt_count", 0) > 0:
        score += 20

    # Shorter estimated tasks get slight priority (quick wins)
    duration = task.get("estimated_duration") or 60
    if duration <= 30:
        score += 5

    return score


def enrich_tasks_with_dag_info(tasks: list) -> list:
    """
    Enrich a list of tasks with DAG-derived info:
    - is_claimable: whether all deps are met and task is available
    - blocking_tasks: list of blocking task titles
    - priority_score: scheduling priority
    """
    enriched = []
    for task in tasks:
        dep_check = check_dependencies_met(task, tasks)
        is_claimable = dep_check["met"] and task.get("status") == "available"
        priority = compute_task_priority(task, tasks) if is_claimable else 0

        enriched.append({
            **task,
            "is_claimable": is_claimable,
            "blocking_tasks": [b["title"] for b in dep_check["blocking"]],
            "priority_score": priority,
        })

    # Sort: claimable first (by priority desc), then blocked, then in-progress, then completed
    status_order = {"available": 0, "locked": 1, "completed": 2, "failed": 3}
    enriched.sort(key=lambda t: (
        0 if t["is_claimable"] else 1,
        -t["priority_score"],
        status_order.get(t.get("status", ""), 9),
    ))

    return enriched
