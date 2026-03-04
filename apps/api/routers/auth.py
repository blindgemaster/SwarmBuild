"""
Auth Router — GitHub OAuth + user session management

Uses Supabase Auth under the hood. GitHub OAuth flow:
1. Frontend redirects to /api/auth/github
2. GitHub redirects back to /api/auth/github/callback
3. We exchange code for Supabase session
4. Return session tokens to frontend
"""

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
import httpx

from config import get_settings
from database import get_supabase

router = APIRouter()


@router.get("/github")
async def github_login(request: Request):
    """Redirect user to GitHub OAuth authorization page."""
    settings = get_settings()
    supabase = get_supabase()

    # Use Supabase's built-in GitHub OAuth
    redirect_url = f"{settings.frontend_url}/auth/callback"

    # Build GitHub OAuth URL via Supabase
    auth_url = (
        f"{settings.supabase_url}/auth/v1/authorize"
        f"?provider=github"
        f"&redirect_to={redirect_url}"
    )

    return RedirectResponse(url=auth_url)


@router.get("/github/callback")
async def github_callback(code: str | None = None, error: str | None = None):
    """Handle GitHub OAuth callback — exchange code for session."""
    if error:
        raise HTTPException(status_code=400, detail=f"OAuth error: {error}")
    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    settings = get_settings()

    # Exchange code for session via Supabase
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{settings.supabase_url}/auth/v1/token?grant_type=pkce",
            json={"auth_code": code},
            headers={
                "apikey": settings.supabase_anon_key,
                "Content-Type": "application/json",
            },
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=400, detail="Failed to exchange auth code")

    session = resp.json()

    # Redirect to frontend with tokens in URL fragment (Supabase convention)
    redirect_url = (
        f"{settings.frontend_url}/auth/callback"
        f"#access_token={session.get('access_token', '')}"
        f"&refresh_token={session.get('refresh_token', '')}"
    )
    return RedirectResponse(url=redirect_url)


@router.get("/me")
async def get_current_user(request: Request):
    """
    Get current user info + credit balance.
    Expects Authorization: Bearer <access_token> header.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing auth token")

    token = auth_header.split(" ", 1)[1]
    settings = get_settings()

    # Verify token with Supabase
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

    user = resp.json()
    user_id = user.get("id")

    # Get credit balance
    db = get_supabase()
    credits_resp = (
        db.table("credit_events")
        .select("amount")
        .eq("user_id", user_id)
        .execute()
    )
    credit_balance = sum(row["amount"] for row in credits_resp.data) if credits_resp.data else 0

    # Ensure profile exists
    profile_resp = db.table("profiles").select("*").eq("id", user_id).execute()
    profile = profile_resp.data[0] if profile_resp.data else None

    if not profile:
        # Auto-create profile from auth metadata
        metadata = user.get("user_metadata", {})
        profile = {
            "id": user_id,
            "username": metadata.get("preferred_username") or metadata.get("user_name"),
            "display_name": metadata.get("full_name") or metadata.get("name"),
            "avatar_url": metadata.get("avatar_url"),
            "github_username": metadata.get("preferred_username") or metadata.get("user_name"),
        }
        db.table("profiles").insert(profile).execute()

    return {
        "user": {
            "id": user_id,
            "email": user.get("email"),
            **profile,
        },
        "credit_balance": credit_balance,
    }
