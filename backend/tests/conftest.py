"""Test fixtures.

Wires up:
- a real Postgres (see TEST_DATABASE_URL) — we don't mock the DB because
  the app uses Postgres-specific things (ON CONFLICT, server-side UUIDs).
- an httpx AsyncClient against the FastAPI app via ASGITransport (no
  network round-trip).
- a `signed_in` helper that stamps `X-Coders-User` on a request the
  way the platform gate would.

Each database-backed API test starts with truncated tables. Pure game-flow
and WebSocket tests do not boot PostgreSQL. The fixture connects to whatever
Postgres `TEST_DATABASE_URL` explicitly points at. Database tests are skipped
when it is absent. The target must be disposable: never set this to a live or
shared development database. Application sessions use that same test target.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# Database tests can truncate tables. Never silently point them at the default
# development database, and bind application/persistence sessions to the same
# explicit isolated target before importing the app's settings/engine.
TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
if TEST_DATABASE_URL:
    os.environ["DATABASE_URL"] = TEST_DATABASE_URL

from app.core.database import Base  # noqa: E402
from app.core.database import engine as application_engine  # noqa: E402
from app.main import app  # noqa: E402
from app.routes import leaderboard  # noqa: E402


@pytest_asyncio.fixture(scope="session")
async def _engine():
    if not TEST_DATABASE_URL:
        pytest.skip("Set TEST_DATABASE_URL to an isolated disposable PostgreSQL database")
    engine = create_async_engine(TEST_DATABASE_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()
    await application_engine.dispose()


@pytest_asyncio.fixture
async def _truncate(_engine) -> AsyncIterator[None]:
    """Wipe tables for database-backed API tests only."""
    async with _engine.begin() as conn:
        await conn.execute(text("TRUNCATE TABLE scores, users RESTART IDENTITY CASCADE"))
    leaderboard._leaderboard_cache = None
    yield


@pytest_asyncio.fixture
async def client(_truncate) -> AsyncIterator[AsyncClient]:
    """ASGI client — no real network."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
def fake_user_id() -> UUID:
    """A UUID we use as `X-Coders-User` in signed-in tests."""
    return uuid4()


@pytest.fixture
def signed_in_headers(fake_user_id: UUID) -> dict[str, str]:
    """Stamp X-Coders-User the way the platform gate would."""
    return {"X-Coders-User": str(fake_user_id)}
