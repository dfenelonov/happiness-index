"""sessions.is_internal, reports.regenerated_at, уникальный лид по (email_hash, source)

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-30

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, Sequence[str], None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("sessions") as batch:
        batch.add_column(
            sa.Column("is_internal", sa.Boolean(), nullable=False, server_default=sa.false())
        )
    with op.batch_alter_table("reports") as batch:
        batch.add_column(sa.Column("regenerated_at", sa.DateTime(timezone=True), nullable=True))
    with op.batch_alter_table("leads") as batch:
        batch.create_unique_constraint(op.f("uq_leads_email_hash_source"), ["email_hash", "source"])


def downgrade() -> None:
    with op.batch_alter_table("leads") as batch:
        batch.drop_constraint(op.f("uq_leads_email_hash_source"), type_="unique")
    with op.batch_alter_table("reports") as batch:
        batch.drop_column("regenerated_at")
    with op.batch_alter_table("sessions") as batch:
        batch.drop_column("is_internal")
