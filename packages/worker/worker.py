"""
Swarmbuild Worker — Runs on contributor's machine inside Docker

The API key never leaves this container.

Usage:
    docker run swarmbuild/worker \\
        --job-id abc123 \\
        --api-key sk-ant-... \\
        --relay https://swarmbuild.io
"""

import os
import sys
import time
import signal
import argparse
import subprocess
import threading
import requests
from pathlib import Path


WORKSPACE = "/workspace"
LOGS_DIR = "/workspace/agent_logs"


def parse_args():
    parser = argparse.ArgumentParser(description="Swarmbuild Worker")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--api-key", required=True)
    parser.add_argument("--relay", default="https://swarmbuild.io")
    parser.add_argument("--agents", type=int, default=None,
                        help="Number of parallel agents (auto-detected if not set)")
    return parser.parse_args()


def detect_agent_count() -> int:
    """Auto-detect based on available RAM."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    kb = int(line.split()[1])
                    gb = kb / (1024 * 1024)
                    return max(1, min(8, int(gb / 3)))
    except Exception:
        pass
    return 2


def fetch_job(relay: str, job_id: str) -> dict:
    """Fetch job details from platform."""
    resp = requests.get(
        f"{relay}/api/worker/job/{job_id}",
        headers={"X-Worker-ID": job_id},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def setup_workspace(job: dict, api_key: str):
    """Clone repo and write generated files into it."""
    print(f"[worker] Cloning {job.get('github_repo', 'repo')}...")

    clone_url = job.get("clone_url")
    if clone_url:
        subprocess.run(["git", "clone", clone_url, WORKSPACE], check=True)
    else:
        # Local mode — init empty repo
        os.makedirs(WORKSPACE, exist_ok=True)
        subprocess.run(["git", "init", WORKSPACE], check=True)

    Path(LOGS_DIR).mkdir(parents=True, exist_ok=True)

    # Write AGENT_PROMPT.md
    if job.get("agent_prompt"):
        Path(f"{WORKSPACE}/AGENT_PROMPT.md").write_text(job["agent_prompt"])

    # Write test harness files
    for filename, content in job.get("test_files", {}).items():
        filepath = Path(f"{WORKSPACE}/{filename}")
        filepath.parent.mkdir(parents=True, exist_ok=True)
        filepath.write_text(content)
        if filename.endswith(".sh"):
            filepath.chmod(0o755)

    # Create current_tasks/
    tasks_dir = Path(f"{WORKSPACE}/current_tasks")
    tasks_dir.mkdir(exist_ok=True)
    for task in job.get("task_list", []):
        (tasks_dir / f"{task}.available").touch()

    # Create PROGRESS.md
    Path(f"{WORKSPACE}/PROGRESS.md").write_text(
        "# Progress\n\nAgents update this file as they work.\n\n"
    )

    # Initial commit
    subprocess.run(["git", "-C", WORKSPACE, "add", "-A"], check=True)
    subprocess.run(
        ["git", "-C", WORKSPACE, "commit", "-m", "swarmbuild: initial agent environment"],
        check=True,
    )
    if clone_url:
        subprocess.run(["git", "-C", WORKSPACE, "push"], check=True)

    print("[worker] Workspace ready.")


def spawn_agents(num_agents: int, api_key: str, relay: str, worker_token: str) -> list:
    """Spawn N agent loop subprocesses in parallel."""
    processes = []
    agent_loop_path = Path(__file__).parent / "agent_loop.sh"

    for i in range(num_agents):
        env = os.environ.copy()
        env["ANTHROPIC_API_KEY"] = api_key
        env["AGENT_ID"] = str(i)
        env["WORKER_TOKEN"] = worker_token
        env["RELAY_URL"] = relay

        proc = subprocess.Popen(
            ["bash", str(agent_loop_path), str(i), worker_token, relay],
            env=env,
            cwd=WORKSPACE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        processes.append(proc)
        print(f"[worker] Agent {i} started (pid {proc.pid})")

    return processes


def heartbeat_loop(relay: str, worker_token: str, processes: list):
    """Background thread: send heartbeat every 30s."""
    while True:
        time.sleep(30)
        try:
            agents_running = sum(1 for p in processes if p.poll() is None)
            requests.post(
                f"{relay}/api/worker/heartbeat/{worker_token}",
                json={"agents_running": agents_running, "tokens_used": _estimate_tokens_used()},
                timeout=10,
            )
        except Exception as e:
            print(f"[worker] Heartbeat failed: {e}")


def monitor(processes: list, relay: str, worker_token: str, token_cap: int):
    """Monitor agents until done, cap reached, or all die."""
    print(f"[worker] Monitoring {len(processes)} agents...")

    while True:
        # Check for completion
        if Path(f"{WORKSPACE}/JOB_COMPLETE").exists():
            print("[worker] ✓ All tests passed. Job complete.")
            _report(relay, worker_token, "complete")
            _kill_all(processes)
            return

        # Check if all agents died
        if all(p.poll() is not None for p in processes):
            print("[worker] All agents exited.")
            _report(relay, worker_token, "stopped", "All agent processes exited")
            return

        # Check token cap
        tokens = _estimate_tokens_used()
        if tokens >= token_cap:
            print(f"[worker] Token cap of {token_cap:,} reached. Stopping.")
            _report(relay, worker_token, "cap_reached",
                    f"Token cap of {token_cap:,} reached.")
            _kill_all(processes)
            return

        time.sleep(30)


def _report(relay: str, token: str, status: str, message: str = ""):
    try:
        requests.post(
            f"{relay}/api/worker/complete/{token}",
            json={"status": status, "message": message},
            timeout=10,
        )
    except Exception as e:
        print(f"[worker] Warning: failed to report status: {e}")


def _kill_all(processes: list):
    for p in processes:
        try:
            p.terminate()
        except Exception:
            pass


def _estimate_tokens_used() -> int:
    """Estimate tokens from agent log files."""
    total = 0
    log_dir = Path(LOGS_DIR)
    if log_dir.exists():
        for log_file in log_dir.glob("*.log"):
            for line in log_file.read_text(errors="replace").splitlines():
                if "input_tokens" in line:
                    try:
                        total += int(line.split("input_tokens=")[1].split()[0])
                    except Exception:
                        pass
    return total


def main():
    args = parse_args()

    print("[worker] Swarmbuild Worker starting")
    print(f"[worker] Job: {args.job_id}")
    print(f"[worker] Relay: {args.relay}")
    print(f"[worker] API key: sk-ant-...{args.api_key[-6:]} (stays local)")

    # Graceful shutdown
    def on_sigterm(sig, frame):
        print("\n[worker] Received SIGTERM, shutting down...")
        sys.exit(0)
    signal.signal(signal.SIGTERM, on_sigterm)

    # Fetch job
    print("[worker] Fetching job details...")
    job = fetch_job(args.relay, args.job_id)
    worker_token = job["worker_token"]
    token_cap = job.get("token_cap", 500_000)

    # Detect agent count
    num_agents = args.agents or detect_agent_count()
    print(f"[worker] Will run {num_agents} parallel agents")

    # Setup workspace
    setup_workspace(job, args.api_key)

    # Spawn agents
    processes = spawn_agents(num_agents, args.api_key, args.relay, worker_token)

    # Start heartbeat thread
    hb = threading.Thread(target=heartbeat_loop, args=(args.relay, worker_token, processes), daemon=True)
    hb.start()

    # Monitor until done
    monitor(processes, args.relay, worker_token, token_cap)

    print("[worker] Done. Check your GitHub repo for output.")


if __name__ == "__main__":
    main()
