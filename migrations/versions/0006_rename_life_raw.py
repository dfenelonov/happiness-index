"""results: swls_raw → life_raw — индекс считается по блоку life (методика проекта)

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-31

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0006"
down_revision: Union[str, Sequence[str], None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("results") as batch:
        batch.alter_column("swls_raw", new_column_name="life_raw")


def downgrade() -> None:
    with op.batch_alter_table("results") as batch:
        batch.alter_column("life_raw", new_column_name="swls_raw")
