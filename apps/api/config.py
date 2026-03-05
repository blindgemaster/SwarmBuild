"""
Swarmbuild API — Configuration

Loads environment variables via pydantic-settings.
All config is centralized here.
"""

from pydantic_settings import BaseSettings
from functools import lru_cache
import os


class Settings(BaseSettings):
    # Supabase (hosted)
    supabase_url: str = "https://placeholder.supabase.co"
    supabase_anon_key: str = "placeholder-anon-key"
    supabase_service_key: str = "placeholder-service-key"

    # AI model providers (harness-gen)
    hugging_face_token: str = ""
    gemini_api_key: str = ""

    # GitHub OAuth
    github_client_id: str = ""
    github_client_secret: str = ""
    github_token: str = ""
    github_org: str = "swarmbuild-jobs"

    # Redis
    redis_url: str = "redis://localhost:6379"

    # CORS
    frontend_url: str = "http://localhost:3000"
    api_url: str = "http://localhost:8000"

    # Dev mode — bypasses auth, enables test data endpoints
    dev_mode: bool = True

    model_config = {
        "env_file": os.path.join(os.path.dirname(__file__), ".env"),
        "env_file_encoding": "utf-8",
    }


@lru_cache()
def get_settings() -> Settings:
    return Settings()
