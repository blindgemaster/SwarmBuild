"""
Dev Router — Development-only endpoints for testing

⚠️  These endpoints bypass auth and should NEVER be enabled in production.
    Controlled by DEV_MODE=true in .env

Provides:
- /api/dev/whoami — returns your dev user ID
- /api/dev/seed — creates sample jobs, comments, votes
- /api/dev/token — generates a fake auth token for testing protected endpoints
- /api/dev/reset — wipes test data from DB
"""

import uuid
from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import get_settings
from database import get_supabase

router = APIRouter()

# Fixed dev user ID — consistent across restarts
DEV_USER_ID = "00000000-0000-0000-0000-000000000001"
DEV_USER_NAME = "dev-tester"

# In-memory "token" for dev mode auth bypass
DEV_TOKEN = "dev-token-swarmbuild-test"


@router.get("/whoami")
async def dev_whoami():
    """Returns the dev user info."""
    return {
        "user_id": DEV_USER_ID,
        "username": DEV_USER_NAME,
        "dev_mode": True,
        "auth_header": f"Bearer {DEV_TOKEN}",
        "hint": "Use the auth_header value in your Authorization header for protected endpoints",
    }


@router.post("/seed")
async def dev_seed():
    """Create sample data for testing."""
    db = get_supabase()

    # Create dev profile
    try:
        db.table("profiles").upsert({
            "id": DEV_USER_ID,
            "username": DEV_USER_NAME,
            "display_name": "Dev Tester",
            "avatar_url": "https://api.dicebear.com/7.x/bottts/svg?seed=dev",
        }).execute()
    except Exception:
        pass  # Profile might already exist

    # Create sample jobs
    jobs_data = [
        {
            "title": "TODO REST API",
            "description": "Build a FastAPI backend with PostgreSQL. Full CRUD for todos. JWT auth. OpenAPI docs.",
            "output_type": "rest-api",
            "tech_stack": ["python", "fastapi", "postgresql"],
            "poster_id": DEV_USER_ID,
            "status": "pending",
        },
        {
            "title": "CLI File Organizer",
            "description": "A CLI tool that automatically organizes files into folders based on file type, date, or custom rules. Support for --dry-run, --undo, and config files.",
            "output_type": "cli",
            "tech_stack": ["python", "click"],
            "poster_id": DEV_USER_ID,
            "status": "pending",
        },
        {
            "title": "Markdown to PDF Library",
            "description": "A Python library that converts Markdown files to beautifully styled PDFs. Support themes, code highlighting, and table of contents.",
            "output_type": "library",
            "tech_stack": ["python", "weasyprint"],
            "poster_id": DEV_USER_ID,
            "status": "plan_ready",
            "agent_prompt": "# Build a Markdown to PDF converter\n\nBuild a Python library...",
            "test_harness": {"test_harness/run_tests.sh": "#!/bin/bash\necho PASS"},
            "task_list": ["implement_parser", "add_themes", "add_toc", "write_tests"],
        },
    ]

    created_jobs = []
    for job_data in jobs_data:
        try:
            result = db.table("jobs").insert(job_data).execute()
            created_jobs.append(result.data[0])
        except Exception as e:
            created_jobs.append({"error": str(e), "title": job_data["title"]})

    # Add comments to the first job if it was created
    comments_created = 0
    if created_jobs and "id" in created_jobs[0]:
        job_id = created_jobs[0]["id"]
        try:
            db.table("comments").insert({
                "job_id": job_id,
                "user_id": DEV_USER_ID,
                "content": "This looks great! I'd suggest adding pagination support.",
            }).execute()
            db.table("comments").insert({
                "job_id": job_id,
                "user_id": DEV_USER_ID,
                "content": "Also make sure to add rate limiting.",
            }).execute()
            comments_created = 2
        except Exception:
            pass

        # Add a vote
        try:
            db.table("votes").insert({
                "job_id": job_id,
                "user_id": DEV_USER_ID,
            }).execute()
        except Exception:
            pass

        # Add credit event
        try:
            db.table("credit_events").insert({
                "user_id": DEV_USER_ID,
                "event_type": "signup_bonus",
                "amount": 5,
                "note": "Dev mode signup bonus",
            }).execute()
        except Exception:
            pass

    return {
        "message": "Seed data created",
        "jobs_created": len([j for j in created_jobs if "id" in j]),
        "comments_created": comments_created,
        "jobs": created_jobs,
        "dev_user_id": DEV_USER_ID,
        "dev_token": DEV_TOKEN,
    }


@router.delete("/reset")
async def dev_reset():
    """Wipe all test data."""
    db = get_supabase()

    tables = ["credit_events", "votes", "comments", "contributors", "jobs", "profiles"]
    deleted = {}

    for table in tables:
        try:
            result = db.table(table).delete().neq("id", "impossible-id").execute()
            deleted[table] = len(result.data) if result.data else 0
        except Exception as e:
            deleted[table] = f"error: {str(e)}"

    return {"message": "All data wiped", "deleted": deleted}
