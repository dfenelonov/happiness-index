"""results: удалить screening_flag — скрининг убран из продукта

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-31

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: Union[str, Sequence[str], None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("results") as batch:
        batch.drop_column("screening_flag")


def downgrade() -> None:
    # Значения флага при откате не восстанавливаются: у всех результатов будет false.
    with op.batch_alter_table("results") as batch:
        batch.add_column(
            sa.Column("screening_flag", sa.Boolean(), nullable=False, server_default=sa.false())
        )
