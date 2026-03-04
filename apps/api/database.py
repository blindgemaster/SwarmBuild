"""
Swarmbuild API — Database (Supabase Client)

Provides a singleton Supabase client for the backend.
Uses the SERVICE_KEY for full access (server-side only).
"""

from supabase import create_client, Client
from config import get_settings

_client: Client | None = None


def get_supabase() -> Client:
    """Get the Supabase client singleton."""
    global _client
    if _client is None:
        settings = get_settings()
        _client = create_client(
            settings.supabase_url,
            settings.supabase_service_key,
        )
    return _client
