"""orders: CHECK на статус, индекс по session_id

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-30

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0002"
down_revision: Union[str, Sequence[str], None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

STATUS_CHECK = "status IN ('pending', 'succeeded', 'canceled', 'refunded')"


def upgrade() -> None:
    with op.batch_alter_table("orders") as batch:  # batch — для SQLite (пересоздание таблицы)
        batch.create_check_constraint(op.f("ck_orders_status"), STATUS_CHECK)
    op.create_index(op.f("ix_orders_session_id"), "orders", ["session_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_orders_session_id"), table_name="orders")
    with op.batch_alter_table("orders") as batch:
        batch.drop_constraint(op.f("ck_orders_status"), type_="check")
