"""
Swarmbuild API — Main Entrypoint

FastAPI app with all routers mounted.
Run: uvicorn main:app --reload --port 8000
"""

import os
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from config import get_settings
from routers import auth, jobs, plans, contributors, worker, logs, credits, community, tasks, messages, profiles, merge, costs, verification, events, a2a
from lib.watchdog import watchdog_loop
from lib.merge_processor import merge_processor_loop
from middleware.audit import AuditMiddleware
from middleware.rate_limit import RateLimitMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown events."""
    print("[api] Swarmbuild API starting...")
    print("[api] Test console: http://localhost:8000")
    s = get_settings()
    if s.dev_mode:
        print("[api] DEV MODE ENABLED -- auth bypass active")
        print("[api] Dev endpoints: http://localhost:8000/api/dev/whoami")

    # Start watchdog background task
    watchdog_task = asyncio.create_task(watchdog_loop())
    print("[api] Watchdog started (checking every 60s)")

    # Start auto-merge processor
    merge_task = asyncio.create_task(merge_processor_loop())
    print("[api] Merge processor started (checking every 15s)")

    yield

    # Cancel background tasks on shutdown
    watchdog_task.cancel()
    merge_task.cancel()
    try:
        await watchdog_task
    except asyncio.CancelledError:
        pass
    try:
        await merge_task
    except asyncio.CancelledError:
        pass
    print("[api] Swarmbuild API shutting down...")


app = FastAPI(
    title="Swarmbuild API",
    description="Coordination server for distributed AI agent builds",
    version="0.1.0",
    lifespan=lifespan,
)

# Middleware execution order is LIFO — last added runs first on request.
# CORS must be added LAST so it runs FIRST, handling OPTIONS preflight
# before audit/rate-limit can interfere.
settings = get_settings()
_cors_origins = [settings.frontend_url, settings.api_url]
if settings.dev_mode:
    _cors_origins += [
        "http://localhost:3000", "http://localhost:3001",
        "http://localhost:8000", "http://127.0.0.1:3000", "http://127.0.0.1:3001",
    ]

# 1. Audit logging (runs third — innermost)
app.add_middleware(AuditMiddleware)

# 2. Rate limiting (runs second)
app.add_middleware(RateLimitMiddleware)

# 3. CORS (runs first — outermost, handles OPTIONS before anything else)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=r"https://.*\.vercel\.app",  # All Vercel preview deployments
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
app.include_router(merge.router, prefix="/api", tags=["Merge Queue"])
app.include_router(costs.router, prefix="/api", tags=["Cost Tracking"])
app.include_router(verification.router, prefix="/api", tags=["Verification"])
app.include_router(events.router, prefix="/api", tags=["SSE Events"])
app.include_router(a2a.router, prefix="/api/a2a", tags=["A2A Gateway"])

# Dev router — only when DEV_MODE=true
if get_settings().dev_mode:
    from routers import dev
    app.include_router(dev.router, prefix="/api/dev", tags=["Dev"])


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "service": "swarmbuild-api"}


# Serve test console from apps/web/ (only if built index.html exists)
WEB_DIR = os.path.join(os.path.dirname(__file__), "..", "web")
WEB_INDEX = os.path.join(WEB_DIR, "index.html")
if os.path.isdir(WEB_DIR) and os.path.isfile(WEB_INDEX):
    @app.get("/")
    async def serve_console():
        return FileResponse(WEB_INDEX)

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")

