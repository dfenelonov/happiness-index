"""reports: попытки, стоимость, время генерации и отправки письма

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-30

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, Sequence[str], None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ("attempts", sa.Integer()),
    ("cost_rub", sa.Float()),
    ("generated_at", sa.DateTime(timezone=True)),
    ("email_sent_at", sa.DateTime(timezone=True)),
)


def upgrade() -> None:
    with op.batch_alter_table("reports") as batch:
        for name, type_ in COLUMNS:
            batch.add_column(sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("reports") as batch:
        for name, _ in reversed(COLUMNS):
            batch.drop_column(name)
