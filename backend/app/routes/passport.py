"""Persistent investigator passport endpoints.

The passport is intentionally read-only from the client. Match completion is
recorded by the server when a room closes, so XP, streaks and badges cannot be
edited from a browser.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.core.identity import optional_display_name, require_identity
from app.routes.users import upsert_local_user
from app.services.passport import get_passport

router = APIRouter(prefix="/api", tags=["passport"])


@router.get("/passport")
async def passport(
    coders_id: Annotated[UUID, Depends(require_identity)],
    platform_name: Annotated[str | None, Depends(optional_display_name)],
    session: Annotated[AsyncSession, Depends(get_session)],
    limit: Annotated[int, Query(ge=1, le=50)] = 12,
) -> dict:
    """Return the signed-in investigator's progression and case archive."""
    user = await upsert_local_user(session, coders_id, platform_name)
    return await get_passport(session, user, limit=limit)
