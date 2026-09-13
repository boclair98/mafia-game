import uuid
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class User(Base):
    """App-local user, keyed on the platform's coders_id.

    coders.kr already knows who this visitor is (they signed in via
    `mcp.coders.kr/sso/login`); we keep a row in our own DB the first
    time we see them so app-local data (Scores, unlocks, …) can FK
    against a stable local UUID without joining out to the platform.

    Sign-in is OPTIONAL in this template: anonymous visitors play as
    guests and never get a row here — only signed-in players are
    persisted (that's what makes the leaderboard survive reconnects).
    """

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        sa.UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # The X-Coders-User value the gate sent. Unique per visitor.
    coders_id: Mapped[uuid.UUID] = mapped_column(
        sa.UUID(as_uuid=True), unique=True, nullable=False, index=True
    )
    # The visitor's coders.kr display name when they've set one
    # (X-Coders-User-Name), else a generated `user-<id8>` handle.
    display_name: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    first_seen_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()
    )

    score: Mapped["Score | None"] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    profile: Mapped["InvestigatorProfile | None"] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )
    case_runs: Mapped[list["CaseRun"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Score(Base):
    """A signed-in player's best score — one row per user, upserted with
    GREATEST() at session end so a concurrent session can't lower it.

    Live/in-round scores never touch the DB (they live in the in-memory
    Room, see app/game.py); only the end-of-session best is persisted.
    """

    __tablename__ = "scores"

    id: Mapped[uuid.UUID] = mapped_column(
        sa.UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    best_score: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()
    )

    user: Mapped[User] = relationship(back_populates="score")


class InvestigatorProfile(Base):
    """Persistent progression that makes every solved case meaningful.

    XP, streaks, and cosmetic badge IDs are intentionally separate from the
    live game state. This gives us a trustworthy place to attach future
    cosmetic inventory or season entitlements without ever selling gameplay
    power.
    """

    __tablename__ = "investigator_profiles"

    id: Mapped[uuid.UUID] = mapped_column(
        sa.UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    xp: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    cases_played: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    cases_won: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    solo_cases: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    party_cases: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    best_score: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    current_streak: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    best_streak: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    last_play_date: Mapped[date | None] = mapped_column(sa.Date, nullable=True)
    daily_play_date: Mapped[date | None] = mapped_column(sa.Date, nullable=True)
    daily_cases: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    daily_evidence: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    daily_social: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    unlocked_badges: Mapped[list[str]] = mapped_column(
        sa.JSON, nullable=False, default=list
    )
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()
    )

    user: Mapped[User] = relationship(back_populates="profile")


class CaseRun(Base):
    """A compact replay index for a signed-in investigator's case archive."""

    __tablename__ = "case_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        sa.UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    case_code: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    case_title: Mapped[str] = mapped_column(sa.String(160), nullable=False)
    mode: Mapped[str] = mapped_column(sa.String(16), nullable=False)
    winner: Mapped[str] = mapped_column(sa.String(16), nullable=False)
    score: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    grade: Mapped[str] = mapped_column(sa.String(2), nullable=False, default="C")
    xp_earned: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    timeline_score: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    social_actions: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    badges: Mapped[list[str]] = mapped_column(sa.JSON, nullable=False, default=list)
    completed_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), index=True
    )

    user: Mapped[User] = relationship(back_populates="case_runs")
