"""Leaderboard: the persist path (WS disconnect calls this) + the public GET."""

from __future__ import annotations

from uuid import uuid4

from app.routes.leaderboard import persist_best_score
from httpx import AsyncClient


async def test_leaderboard_empty(client: AsyncClient):
    r = await client.get("/api/leaderboard")
    assert r.status_code == 200
    assert r.json() == []


async def test_persist_keeps_the_best_score(client: AsyncClient):
    cid = uuid4()
    await persist_best_score(cid, "alice", 7)
    await persist_best_score(cid, "alice", 3)  # a worse later session

    r = await client.get("/api/leaderboard")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["name"] == "alice"
    assert rows[0]["best_score"] == 7  # GREATEST() kept the 7


async def test_leaderboard_orders_best_first(client: AsyncClient):
    await persist_best_score(uuid4(), "bronze", 1)
    await persist_best_score(uuid4(), "gold", 9)
    await persist_best_score(uuid4(), "silver", 5)

    r = await client.get("/api/leaderboard")
    assert [e["name"] for e in r.json()] == ["gold", "silver", "bronze"]


async def test_guest_names_fall_back_to_handle(client: AsyncClient):
    cid = uuid4()
    await persist_best_score(cid, None, 2)  # signed in but no display name set

    r = await client.get("/api/leaderboard")
    assert r.json()[0]["name"] == f"user-{str(cid)[:8]}"
