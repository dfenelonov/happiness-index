import shutil
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import (
    APP_CONFIG_FILE,
    APP_DIR,
    PLACEHOLDER_MARKERS,
    PROJECT_ROOT,
    QUESTIONNAIRE_FILE,
    Settings,
)

REAL_CONFIG_DIR = PROJECT_ROOT / "config"
# Мок LLM в production запрещён, адрес — только https.
PROD_PROVIDER = {"llm_provider": "yandexgpt", "app_base_url": "https://example.ru"}
PINNED_YANDEX_VERSION = "pinned-for-tests"
SAFE_SECRETS = {
    "secret_key": "s3cret-for-tests",
    "admin_password": "admin-pass-for-tests",
    "email_encryption_key": "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC0=",
    "email_hash_key": "hash-key-for-tests",
    "yookassa_shop_id": "123456",
    "yookassa_secret_key": "test_secret_for_tests",
    "smtp_host": "smtp.example.ru",
    "mail_from": "report@example.ru",
    "yandexgpt_api_key": "yandex-key-for-tests",
    "yandexgpt_folder_id": "folder-for-tests",
}


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Переменные окружения разработчика (APP_BASE_URL, LLM_PROVIDER…) не должны влиять на тесты."""
    for name in Settings.model_fields:
        monkeypatch.delenv(name.upper(), raising=False)


def make_settings(tmp_path: Path, **overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "app_env": "development",
        "database_url": f"sqlite:///{tmp_path / 'test.sqlite3'}",
        "config_dir": REAL_CONFIG_DIR,
        "templates_dir": APP_DIR / "templates",
        "cache_dir": tmp_path / "cache",
        "report_jobs_sync": True,
        "llm_provider": "mock",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


@pytest.fixture
def config_dir(tmp_path: Path) -> Path:
    """Копия реальных конфигов, которую тест может менять."""
    target = tmp_path / "config"
    shutil.copytree(REAL_CONFIG_DIR, target)
    return target


def edit_yaml(path: Path, mutate: Callable[[dict[str, Any]], None]) -> None:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    mutate(data)
    path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


def _fill_placeholders(node: Any) -> Any:
    if isinstance(node, dict):
        return {k: _fill_placeholders(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_fill_placeholders(v) for v in node]
    if isinstance(node, str) and any(m in node for m in PLACEHOLDER_MARKERS):
        return "Заполненный текст"
    return node


@pytest.fixture
def filled_config_dir(config_dir: Path) -> Path:
    """Конфиги, где владелец заменил все плейсхолдеры (комментарии с TODO остаются)."""
    for name in (QUESTIONNAIRE_FILE, APP_CONFIG_FILE):
        path = config_dir / name
        raw = path.read_text(encoding="utf-8")
        data = _fill_placeholders(yaml.safe_load(raw))
        if name == APP_CONFIG_FILE:  # владелец закрепил версию модели перед запуском
            data["report"]["models"]["yandexgpt"]["version"] = PINNED_YANDEX_VERSION
        comments = "".join(line + "\n" for line in raw.splitlines() if line.startswith("#"))
        dumped = yaml.safe_dump(data, allow_unicode=True, sort_keys=False)
        path.write_text(comments + dumped, encoding="utf-8")
    return config_dir


def alembic_config(db_url: str) -> Config:
    cfg = Config(str(PROJECT_ROOT / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", db_url)
    cfg.attributes["configure_logger"] = False
    return cfg


def build_app(tmp_path: Path, **overrides: Any) -> FastAPI:
    from app.main import create_app

    settings = make_settings(tmp_path, **overrides)
    command.upgrade(alembic_config(settings.database_url), "head")  # схема — из миграций
    return create_app(settings)


@pytest.fixture
def app(tmp_path: Path) -> FastAPI:
    return build_app(tmp_path)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, follow_redirects=False) as c:
        yield c
