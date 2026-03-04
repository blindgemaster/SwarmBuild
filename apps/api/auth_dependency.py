"""
Shared authentication dependency for all routes.
Extracts and verifies user ID from Authorization: Bearer <token> header.

In dev mode (DEV_MODE=true), accepts "dev-token-swarmbuild-test" as a valid token
that maps to the fixed dev user ID.
"""

import httpx
from fastapi import HTTPException, Request

from config import get_settings

# Must match routers/dev.py
DEV_USER_ID = "00000000-0000-0000-0000-000000000001"
DEV_TOKEN = "dev-token-swarmbuild-test"


async def get_current_user_id(request: Request) -> str:
    """
    Extract user_id from the Authorization header.

    In dev mode, accepts the dev token for testing without OAuth.
    In production, verifies against Supabase Auth.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing auth token")

    token = auth_header.split(" ", 1)[1]
    settings = get_settings()

    # Dev mode bypass
    if settings.dev_mode and token == DEV_TOKEN:
        return DEV_USER_ID

    # Production: verify with Supabase
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{settings.supabase_url}/auth/v1/user",
            headers={
                "apikey": settings.supabase_anon_key,
                "Authorization": f"Bearer {token}",
            },
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    return resp.json()["id"]
