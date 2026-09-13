"""investigator passport and case archive

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-14 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "investigator_profiles",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            sa.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            unique=True,
            nullable=False,
        ),
        sa.Column("xp", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cases_played", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cases_won", sa.Integer, nullable=False, server_default="0"),
        sa.Column("solo_cases", sa.Integer, nullable=False, server_default="0"),
        sa.Column("party_cases", sa.Integer, nullable=False, server_default="0"),
        sa.Column("best_score", sa.Integer, nullable=False, server_default="0"),
        sa.Column("current_streak", sa.Integer, nullable=False, server_default="0"),
        sa.Column("best_streak", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_play_date", sa.Date, nullable=True),
        sa.Column("daily_play_date", sa.Date, nullable=True),
        sa.Column("daily_cases", sa.Integer, nullable=False, server_default="0"),
        sa.Column("daily_evidence", sa.Integer, nullable=False, server_default="0"),
        sa.Column("daily_social", sa.Integer, nullable=False, server_default="0"),
        sa.Column(
            "unlocked_badges",
            sa.JSON,
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    op.create_table(
        "case_runs",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            sa.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("case_code", sa.String(32), nullable=False),
        sa.Column("case_title", sa.String(160), nullable=False),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("winner", sa.String(16), nullable=False),
        sa.Column("score", sa.Integer, nullable=False, server_default="0"),
        sa.Column("grade", sa.String(2), nullable=False, server_default="C"),
        sa.Column("xp_earned", sa.Integer, nullable=False, server_default="0"),
        sa.Column("timeline_score", sa.Integer, nullable=False, server_default="0"),
        sa.Column("social_actions", sa.Integer, nullable=False, server_default="0"),
        sa.Column(
            "badges", sa.JSON, nullable=False, server_default=sa.text("'[]'"),
        ),
        sa.Column(
            "completed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_case_runs_user_id", "case_runs", ["user_id"])
    op.create_index("ix_case_runs_completed_at", "case_runs", ["completed_at"])


def downgrade() -> None:
    op.drop_index("ix_case_runs_completed_at", table_name="case_runs")
    op.drop_index("ix_case_runs_user_id", table_name="case_runs")
    op.drop_table("case_runs")
    op.drop_table("investigator_profiles")
