"""Fenced runtime leases, private room checkpoints and result idempotency."""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("case_runs", sa.Column("match_id", sa.UUID(as_uuid=True), nullable=True))
    op.create_unique_constraint("uq_case_runs_user_match", "case_runs", ["user_id", "match_id"])
    op.create_table(
        "game_runtime_leases",
        sa.Column("name", sa.String(40), primary_key=True),
        sa.Column("owner_id", sa.UUID(as_uuid=True), nullable=False),
        sa.Column("epoch", sa.BigInteger, nullable=False),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "game_room_checkpoints",
        sa.Column("name", sa.String(32), primary_key=True),
        sa.Column("revision", sa.BigInteger, nullable=False),
        sa.Column("lease_epoch", sa.BigInteger, nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_game_room_checkpoints_expires_at", "game_room_checkpoints", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_game_room_checkpoints_expires_at", table_name="game_room_checkpoints")
    op.drop_table("game_room_checkpoints")
    op.drop_table("game_runtime_leases")
    op.drop_constraint("uq_case_runs_user_match", "case_runs", type_="unique")
    op.drop_column("case_runs", "match_id")
