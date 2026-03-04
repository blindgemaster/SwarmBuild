"""
Credits Router — Balance and history for the credit system

Credits are append-only events. Balance = SUM(amount) for a user.
"""

from fastapi import APIRouter, HTTPException, Request, Query

from database import get_supabase
from auth_dependency import get_current_user_id as _get_user_id

router = APIRouter()


@router.get("")
async def get_balance(request: Request):
    """Get current user's credit balance."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    result = (
        db.table("credit_events")
        .select("amount")
        .eq("user_id", user_id)
        .execute()
    )

    balance = sum(row["amount"] for row in result.data) if result.data else 0

    return {"balance": balance}


@router.get("/history")
async def get_history(
    request: Request,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
):
    """Get credit event history for the current user."""
    user_id = await _get_user_id(request)
    db = get_supabase()

    offset = (page - 1) * per_page

    result = (
        db.table("credit_events")
        .select("*, jobs(title)", count="exact")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .range(offset, offset + per_page - 1)
        .execute()
    )

    return {
        "events": result.data,
        "total": result.count,
        "page": page,
        "per_page": per_page,
    }
