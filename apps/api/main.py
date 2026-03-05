"""
Swarmbuild API — Main Entrypoint

FastAPI app with all routers mounted.
Run: uvicorn main:app --reload --port 8000
"""

import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from config import get_settings
from routers import auth, jobs, plans, contributors, worker, logs, credits, community, tasks, messages, profiles


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown events."""
    print("[api] Swarmbuild API starting...")
    print("[api] Test console: http://localhost:8000")
    s = get_settings()
    if s.dev_mode:
        print("[api] DEV MODE ENABLED -- auth bypass active")
        print("[api] Dev endpoints: http://localhost:8000/api/dev/whoami")
    yield
    print("[api] Swarmbuild API shutting down...")


app = FastAPI(
    title="Swarmbuild API",
    description="Coordination server for distributed AI agent builds",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow all origins in dev (test console opens from file:// or localhost)
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers
app.include_router(auth.router, prefix="/api/auth", tags=["Auth"])
app.include_router(jobs.router, prefix="/api/jobs", tags=["Jobs"])
app.include_router(plans.router, prefix="/api/jobs", tags=["Plans"])
app.include_router(contributors.router, prefix="/api/jobs", tags=["Contributors"])
app.include_router(worker.router, prefix="/api/worker", tags=["Worker Protocol"])
app.include_router(tasks.router, prefix="/api", tags=["Tasks"])
app.include_router(messages.router, prefix="/api", tags=["Messages"])
app.include_router(logs.router, prefix="/api/logs", tags=["Log Relay"])
app.include_router(credits.router, prefix="/api/credits", tags=["Credits"])
app.include_router(community.router, prefix="/api/jobs", tags=["Community"])
app.include_router(profiles.router, prefix="/api/profiles", tags=["Profiles"])

# Dev router — only when DEV_MODE=true
if get_settings().dev_mode:
    from routers import dev
    app.include_router(dev.router, prefix="/api/dev", tags=["Dev"])


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "service": "swarmbuild-api"}


# Serve test console from apps/web/
WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "web")
if os.path.isdir(WEB_DIR):
    @app.get("/")
    async def serve_console():
        return FileResponse(os.path.join(WEB_DIR, "index.html"))

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

