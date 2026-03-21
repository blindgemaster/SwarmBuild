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
    groq_api_key: str = ""

    # GitHub OAuth
    github_client_id: str = ""
    github_client_secret: str = ""
    github_token: str = ""
    github_org: str = "swarmbuild-jobs"

    # Redis
    redis_url: str = "redis://localhost:6379"

    # CORS
    frontend_url: str = "https://swarm-build-web.vercel.app"
    api_url: str = "https://swarmbuild.onrender.com"

    # Dev mode — bypasses auth, enables test data endpoints
    # MUST be explicitly set to true in .env for local development
    dev_mode: bool = False

    model_config = {
        "env_file": os.path.join(os.path.dirname(__file__), ".env"),
        "env_file_encoding": "utf-8",
    }


@lru_cache()
def get_settings() -> Settings:
    return Settings()
