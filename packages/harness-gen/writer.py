"""
harness-gen/writer.py — Write generated plan into a git repo

Called once when the worker first starts.
"""

import os
from .generator import GeneratedPlan


def write_plan_to_repo(plan: GeneratedPlan, repo_path: str) -> None:
    """
    Write the generated plan into the job's git repo.
    Creates: AGENT_PROMPT.md, test_harness/, current_tasks/, PROGRESS.md, .gitignore
    """
    # Write AGENT_PROMPT.md
    with open(f"{repo_path}/AGENT_PROMPT.md", "w") as f:
        f.write(plan.agent_prompt)

    # Write test harness files
    for filename, content in plan.test_files.items():
        filepath = f"{repo_path}/{filename}"
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "w") as f:
            f.write(content)
        if filename.endswith(".sh"):
            os.chmod(filepath, 0o755)

    # Create current_tasks/ with initial tasks
    os.makedirs(f"{repo_path}/current_tasks", exist_ok=True)
    for task in plan.task_list:
        open(f"{repo_path}/current_tasks/{task}.available", "w").close()

    # Create PROGRESS.md
    with open(f"{repo_path}/PROGRESS.md", "w") as f:
        f.write("# Progress\n\nAgents update this file as they work.\n\n")

    # Create .gitignore
    with open(f"{repo_path}/.gitignore", "w") as f:
        f.write("agent_logs/\n__pycache__/\n*.pyc\nnode_modules/\n.env\n")
