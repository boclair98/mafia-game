"""Test fixtures.

Wires up:
- a real Postgres (see TEST_DATABASE_URL) — we don't mock the DB because
  the app uses Postgres-specific things (ON CONFLICT, server-side UUIDs).
- an httpx AsyncClient against the FastAPI app via ASGITransport (no
  network round-trip).
- a `signed_in` helper that stamps `X-Coders-User` on a request the
  way the platform gate would.

Each test starts with truncated tables. The fixture connects to whatever
Postgres `TEST_DATABASE_URL` points at — by default the same database
the dev `docker compose up` brings up. If you'd rather isolate tests
from your dev data, point TEST_DATABASE_URL at a separate DB before
running pytest.
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

from app.core.database import Base
from app.main import app

TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://app:app@localhost:5432/app",
)


@pytest_asyncio.fixture(scope="session")
async def _engine():
    engine = create_async_engine(TEST_DATABASE_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture(autouse=True)
async def _truncate(_engine) -> AsyncIterator[None]:
    """Wipe tables before every test so order doesn't matter."""
    async with _engine.begin() as conn:
        await conn.execute(text("TRUNCATE TABLE scores, users RESTART IDENTITY CASCADE"))
    yield


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
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
