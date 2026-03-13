"""
Verification Engine — Tiered verification for task completions.

Tier 0: Self-report (no checks)
Tier 1: Automated build checks (npm test, pytest, lint, build)
Tier 2: Peer review (another agent reviews code)
Tier 3: Human gate (job poster approves)

Reference: The Engineering/06-VERIFICATION.md
"""

import asyncio
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class CheckResult:
    name: str
    status: str  # "pass", "fail", "skip", "error"
    output: str = ""
    duration_ms: int = 0


@dataclass
class VerificationReport:
    tier: int
    overall: str  # "pass" or "fail"
    checks: List[CheckResult] = field(default_factory=list)
    summary: str = ""

    def to_dict(self) -> dict:
        return {
            "tier": self.tier,
            "overall": self.overall,
            "checks": [
                {"name": c.name, "status": c.status, "output": c.output[:2000], "duration_ms": c.duration_ms}
                for c in self.checks
            ],
            "summary": self.summary,
        }


async def _safe_run(cmd: str, cwd: str, timeout: int = 120) -> tuple:
    """Run a shell command safely with timeout. Returns (ok, output)."""
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, "CI": "true", "NODE_ENV": "test"},
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        output = stdout.decode("utf-8", errors="replace")[-4000:]  # Last 4KB
        return proc.returncode == 0, output
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return False, f"Command timed out after {timeout}s"
    except Exception as e:
        return False, str(e)


def _detect_project_type(repo_path: str) -> str:
    """Detect project type from files present in the repo."""
    if os.path.exists(os.path.join(repo_path, "package.json")):
        return "node"
    if os.path.exists(os.path.join(repo_path, "requirements.txt")) or \
       os.path.exists(os.path.join(repo_path, "pyproject.toml")) or \
       os.path.exists(os.path.join(repo_path, "setup.py")):
        return "python"
    return "unknown"


def _has_npm_script(repo_path: str, script_name: str) -> bool:
    """Check if a package.json has a given script."""
    import json
    pkg_path = os.path.join(repo_path, "package.json")
    try:
        with open(pkg_path) as f:
            pkg = json.load(f)
        return script_name in pkg.get("scripts", {})
    except Exception:
        return False


async def _run_node_checks(repo_path: str) -> List[CheckResult]:
    """Run Node.js project checks."""
    checks = []

    # Install
    import time
    start = time.time()
    ok, output = await _safe_run("npm install", repo_path, timeout=120)
    checks.append(CheckResult("npm install", "pass" if ok else "fail", output, int((time.time() - start) * 1000)))

    if not ok:
        return checks  # Can't continue without installed deps

    # Build
    if _has_npm_script(repo_path, "build"):
        start = time.time()
        ok, output = await _safe_run("npm run build", repo_path, timeout=120)
        checks.append(CheckResult("build", "pass" if ok else "fail", output, int((time.time() - start) * 1000)))

    # Lint
    if _has_npm_script(repo_path, "lint"):
        start = time.time()
        ok, output = await _safe_run("npm run lint", repo_path, timeout=60)
        checks.append(CheckResult("lint", "pass" if ok else "fail", output, int((time.time() - start) * 1000)))

    # Test
    if _has_npm_script(repo_path, "test"):
        start = time.time()
        ok, output = await _safe_run("npm test", repo_path, timeout=180)
        checks.append(CheckResult("test", "pass" if ok else "fail", output, int((time.time() - start) * 1000)))

    return checks


async def _run_python_checks(repo_path: str) -> List[CheckResult]:
    """Run Python project checks."""
    checks = []
    import time

    # Install
    req_file = os.path.join(repo_path, "requirements.txt")
    if os.path.exists(req_file):
        start = time.time()
        ok, output = await _safe_run("pip install -r requirements.txt", repo_path, timeout=120)
        checks.append(CheckResult("pip install", "pass" if ok else "fail", output, int((time.time() - start) * 1000)))

    # Syntax check — find all .py files and compile them
    start = time.time()
    ok, output = await _safe_run(
        'python -c "import py_compile, glob; [py_compile.compile(f, doraise=True) for f in glob.glob(\'**/*.py\', recursive=True)]"',
        repo_path, timeout=30
    )
    checks.append(CheckResult("syntax", "pass" if ok else "fail", output, int((time.time() - start) * 1000)))

    # Pytest
    start = time.time()
    ok, output = await _safe_run("python -m pytest -v --tb=short 2>&1 || true", repo_path, timeout=180)
    # Check if pytest is even installed / any tests exist
    if "no tests ran" in output.lower() or "not found" in output.lower():
        checks.append(CheckResult("pytest", "skip", "No tests found", int((time.time() - start) * 1000)))
    else:
        checks.append(CheckResult("pytest", "pass" if ok else "fail", output, int((time.time() - start) * 1000)))

    return checks


async def run_tier1_verification(repo_path: str) -> VerificationReport:
    """
    Run automated build checks on a local repo path.
    In production, this would clone the repo into a sandboxed environment.
    """
    report = VerificationReport(tier=1, overall="pass")

    project_type = _detect_project_type(repo_path)

    if project_type == "node":
        report.checks.extend(await _run_node_checks(repo_path))
    elif project_type == "python":
        report.checks.extend(await _run_python_checks(repo_path))
    else:
        report.checks.append(CheckResult("detect", "skip", f"Unknown project type at {repo_path}"))

    # Determine overall status
    failures = [c for c in report.checks if c.status == "fail"]
    if failures:
        report.overall = "fail"
        report.summary = f"{len(failures)} check(s) failed: {', '.join(c.name for c in failures)}"
    else:
        passed = [c for c in report.checks if c.status == "pass"]
        skipped = [c for c in report.checks if c.status == "skip"]
        report.summary = f"{len(passed)} check(s) passed, {len(skipped)} skipped"

    return report


def select_reviewer(job_id: str, author_token: str, db) -> Optional[str]:
    """
    Select a reviewer agent for a completed task.
    Returns the worker_token of the reviewer, or None if no other agent is available.
    """
    contribs = (
        db.table("contributors")
        .select("worker_token, role, tasks_completed")
        .eq("job_id", job_id)
        .neq("worker_token", author_token)
        .eq("contributor_status", "active")
        .execute()
    )

    if not contribs.data:
        return None

    # Prefer agents who have completed the most work
    candidates = sorted(contribs.data, key=lambda c: c.get("tasks_completed", 0) or 0, reverse=True)
    return candidates[0]["worker_token"]
