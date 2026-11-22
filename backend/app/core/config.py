from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Provided by the coders.kr platform via coders.yaml substitution.
    database_url: str = "postgresql+asyncpg://app:app@localhost:5432/app"

    # Keep database connections bounded per API process. These are deliberately
    # environment-configurable because the right values depend on the number of
    # API replicas and the managed Postgres connection budget.
    database_pool_size: int = Field(default=10, ge=1, le=200)
    database_max_overflow: int = Field(default=20, ge=0, le=400)
    database_pool_timeout: float = Field(default=10.0, ge=1.0, le=120.0)
    database_pool_recycle: int = Field(default=1800, ge=60, le=86_400)

    # Admission guardrails, not measured capacity. Durable mode currently uses
    # one fenced runtime; adding replicas does not provide room-owner routing.
    max_rooms: int = Field(default=5000, ge=1, le=100_000)
    max_connections: int = Field(default=12_000, ge=1, le=100_000)
    max_spectators_per_room: int = Field(default=12, ge=0, le=64)
    broadcast_timeout: float = Field(default=2.0, ge=0.1, le=10.0)
    leaderboard_cache_ttl: float = Field(default=5.0, ge=0.0, le=300.0)

    # Durable rooms deliberately use one fenced runtime, not replica-local
    # copies. Enable explicitly in deployment; pure local rules need no DB.
    room_persistence_enabled: bool = False
    room_lease_seconds: int = Field(default=15, ge=5, le=120)
    room_checkpoint_ttl_seconds: int = Field(default=86_400, ge=300, le=604_800)
    room_clock_checkpoint_seconds: int = Field(default=5, ge=1, le=60)

    # Local-dev escape hatch: when set, an X-Coders-User-less request is
    # treated as if it came from this UUID. Lets you `curl` the API
    # without the platform gate in front. Never set in production.
    dev_fake_user: str | None = None

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
