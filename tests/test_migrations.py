from pathlib import Path

from alembic import command
from sqlalchemy import create_engine, inspect

from tests.conftest import alembic_config


def test_migrations_upgrade_match_models_and_downgrade(tmp_path: Path) -> None:
    db_url = f"sqlite:///{tmp_path / 'migrations.sqlite3'}"
    cfg = alembic_config(db_url)

    command.upgrade(cfg, "head")
    tables = set(inspect(create_engine(db_url)).get_table_names())
    assert {"sessions", "answers", "results", "orders", "reports", "leads", "events"} <= tables

    command.check(cfg)  # падает, если модели разошлись с миграциями

    command.downgrade(cfg, "base")
    assert set(inspect(create_engine(db_url)).get_table_names()) == {"alembic_version"}
