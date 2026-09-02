"""Leaderboard: persistent best scores for signed-in players.

GET /api/leaderboard — public; top 20 best scores with display names.

Guests play but are never written here (no stable identity to key on);
that asymmetry is the whole "optional sign-in" pitch the HUD makes:
sign in and your best score survives the session.
"""

from __future__ import annotations

import time
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import func

from app.core.config import settings
from app.core.database import AsyncSessionLocal, get_session
from app.models import Score, User
from app.routes.users import upsert_local_user

router = APIRouter(prefix="/api", tags=["leaderboard"])

_leaderboard_cache: tuple[float, list[LeaderboardEntry]] | None = None


class LeaderboardEntry(BaseModel):
    name: str
    best_score: int
    updated_at: str


@router.get("/leaderboard", response_model=list[LeaderboardEntry])
async def leaderboard(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[LeaderboardEntry]:
    """Top 20, best first. Public — no identity needed."""
    global _leaderboard_cache
    now = time.monotonic()
    if (
        _leaderboard_cache is not None
        and now - _leaderboard_cache[0] < settings.leaderboard_cache_ttl
    ):
        return list(_leaderboard_cache[1])

    res = await session.execute(
        select(Score, User.display_name)
        .join(User, User.id == Score.user_id)
        .order_by(desc(Score.best_score), Score.updated_at)
        .limit(20)
    )
    entries = [
        LeaderboardEntry(
            name=name,
            best_score=score.best_score,
            updated_at=score.updated_at.isoformat(),
        )
        for score, name in res.all()
    ]
    _leaderboard_cache = (now, entries)
    return list(entries)


async def persist_best_score(
    coders_id: UUID, platform_name: str | None, score: int
) -> None:
    """Upsert the player's best score at session end.

    Called from the WebSocket disconnect path (routes/ws.py), which runs
    outside any request-scoped dependency — so this opens its own
    session instead of taking a Depends(get_session) one.

    GREATEST() (not plain assignment) so two concurrent sessions ending
    out of order can only ever raise the stored best, never lower it.
    """
    global _leaderboard_cache
    async with AsyncSessionLocal() as session:
        async with session.begin():
            user = await upsert_local_user(session, coders_id, platform_name)
            await session.execute(
                pg_insert(Score)
                .values(user_id=user.id, best_score=score)
                .on_conflict_do_update(
                    index_elements=["user_id"],
                    set_={
                        "best_score": func.greatest(Score.best_score, score),
                        "updated_at": func.now(),
                    },
                )
            )

    # A finished match should be visible quickly, while reads between matches
    # are served from the short TTL cache instead of opening a DB connection.
    _leaderboard_cache = None
