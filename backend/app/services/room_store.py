"""Private PostgreSQL checkpoints guarded by a single-runtime fencing lease.

There is deliberately no claim of horizontal room routing here. A standby
fails closed until the active runtime's DB-clock lease expires or is released.
"""

from __future__ import annotations

import time
from datetime import timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.core.database import AsyncSessionLocal
from app.models import RoomCheckpoint, RuntimeLease

LEASE_NAME = "black-midnight-runtime"


class RoomRecoveringError(RuntimeError):
    """Retryable storage/ownership failure; never include private state."""


class RoomStore:
    def __init__(self, *, session_factory=None, lease_seconds=15, ttl_seconds=86_400):
        self.session_factory = session_factory or AsyncSessionLocal
        self.lease_seconds = lease_seconds
        self.ttl_seconds = ttl_seconds
        self.owner_id = uuid4()
        self.epoch: int | None = None
        self._safe_until = 0.0
        self.expiries: dict[str, float] = {}

    @property
    def locally_valid(self) -> bool:
        # Stop serving even before DB expiry if heartbeats stall. This is a
        # conservative local gate; the DB fence remains authoritative for writes.
        return self.epoch is not None and time.monotonic() < self._safe_until

    async def acquire(self) -> bool:
        started = time.monotonic()
        statement = pg_insert(RuntimeLease).values(
            name=LEASE_NAME, owner_id=self.owner_id, epoch=1,
            lease_until=func.clock_timestamp() + timedelta(seconds=self.lease_seconds),
        )
        statement = statement.on_conflict_do_update(
            index_elements=[RuntimeLease.name],
            set_={
                "owner_id": self.owner_id, "epoch": RuntimeLease.epoch + 1,
                "lease_until": func.clock_timestamp() + timedelta(seconds=self.lease_seconds),
            },
            where=or_(RuntimeLease.lease_until <= func.clock_timestamp(), RuntimeLease.owner_id == self.owner_id),
        ).returning(RuntimeLease.epoch)
        async with self.session_factory() as session, session.begin():
            epoch = (await session.execute(statement)).scalar_one_or_none()
        self.epoch = epoch
        self._safe_until = started + self.lease_seconds - 1.0 if epoch is not None else 0.0
        return epoch is not None

    async def renew(self) -> bool:
        started = time.monotonic()
        epoch = self.epoch
        if epoch is None:
            return False
        async with self.session_factory() as session, session.begin():
            result = await session.execute(
                update(RuntimeLease).where(
                    RuntimeLease.name == LEASE_NAME, RuntimeLease.owner_id == self.owner_id,
                    RuntimeLease.epoch == epoch, RuntimeLease.lease_until > func.clock_timestamp(),
                ).values(lease_until=func.clock_timestamp() + timedelta(seconds=self.lease_seconds))
                .returning(RuntimeLease.epoch)
            )
            renewed = result.scalar_one_or_none() is not None
        if not renewed:
            self.epoch = None
            self._safe_until = 0.0
        else:
            self._safe_until = started + self.lease_seconds - 1.0
        return renewed

    async def _fence(self, session, epoch: int | None) -> None:
        if epoch is None:
            raise RoomRecoveringError("room_recovering")
        # FOR SHARE allows independent room commits concurrently but blocks a
        # lease transfer until this transaction commits. Each write rechecks
        # the owner+epoch+DB clock; a resumed stale process cannot overwrite it.
        owner = await session.scalar(
            select(RuntimeLease.epoch).where(
                RuntimeLease.name == LEASE_NAME, RuntimeLease.owner_id == self.owner_id,
                RuntimeLease.epoch == epoch, RuntimeLease.lease_until > func.clock_timestamp(),
            ).with_for_update(read=True)
        )
        if owner is None:
            raise RoomRecoveringError("room_recovering")

    async def load_all(self, limit: int) -> list[tuple[dict[str, Any], int]]:
        async with self.session_factory() as session, session.begin():
            await self._fence(session, self.epoch)
            # Expiry is a documented retention limit, not crash recovery loss.
            await session.execute(delete(RoomCheckpoint).where(RoomCheckpoint.expires_at <= func.clock_timestamp()))
            rows = (await session.execute(
                select(RoomCheckpoint.payload, RoomCheckpoint.revision, RoomCheckpoint.expires_at)
                .order_by(RoomCheckpoint.name).limit(limit + 1)
            )).all()
            if len(rows) > limit:
                raise RoomRecoveringError("checkpoint_capacity")
            self.expiries = {payload["room"]["name"]: expiry.timestamp() for payload, _, expiry in rows}
            return [(payload, revision) for payload, revision, _ in rows]

    async def save(self, payload: dict[str, Any], expected_revision: int) -> int:
        epoch = self.epoch
        async with self.session_factory() as session, session.begin():
            await self._fence(session, epoch)
            statement = pg_insert(RoomCheckpoint).values(
                name=payload["room"]["name"], revision=expected_revision + 1,
                lease_epoch=epoch, payload=payload, saved_at=func.clock_timestamp(),
                expires_at=func.clock_timestamp() + timedelta(seconds=self.ttl_seconds),
            )
            statement = statement.on_conflict_do_update(
                index_elements=[RoomCheckpoint.name],
                set_={
                    "revision": RoomCheckpoint.revision + 1, "lease_epoch": epoch,
                    "payload": payload, "saved_at": func.clock_timestamp(),
                    "expires_at": func.clock_timestamp() + timedelta(seconds=self.ttl_seconds),
                },
                where=or_(
                    (RoomCheckpoint.revision == expected_revision) & (RoomCheckpoint.expires_at > func.clock_timestamp()),
                    and_(expected_revision == 0, RoomCheckpoint.expires_at <= func.clock_timestamp()),
                ),
            ).returning(RoomCheckpoint.revision)
            revision = (await session.execute(statement)).scalar_one_or_none()
            if revision is None:
                raise RoomRecoveringError("checkpoint_conflict")
        self.expiries[payload["room"]["name"]] = time.time() + self.ttl_seconds
        return revision

    async def remove(self, name: str, expected_revision: int) -> None:
        async with self.session_factory() as session, session.begin():
            await self._fence(session, self.epoch)
            result = await session.execute(
                delete(RoomCheckpoint).where(
                    RoomCheckpoint.name == name, RoomCheckpoint.revision == expected_revision,
                ).returning(RoomCheckpoint.name)
            )
            if expected_revision and result.scalar_one_or_none() is None:
                raise RoomRecoveringError("checkpoint_conflict")
        self.expiries.pop(name, None)

    async def release(self) -> None:
        epoch, self.epoch = self.epoch, None
        self._safe_until = 0.0
        if epoch is None:
            return
        async with self.session_factory() as session, session.begin():
            await session.execute(
                update(RuntimeLease).where(
                    RuntimeLease.name == LEASE_NAME, RuntimeLease.owner_id == self.owner_id,
                    RuntimeLease.epoch == epoch,
                ).values(lease_until=func.clock_timestamp())
            )
